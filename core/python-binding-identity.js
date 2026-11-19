'use strict';

// Resolve only identities written in Python syntax. Multiple writes, parameters,
// conditional bindings and unknown expressions have no proven identity.
const { referenceScopeNode, pythonScopeBindingTable } = require('../languages/lexical-scope');
const { sameNode } = require('../languages/utils');
const { indexedContent } = require('./source-memo');
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
const NON_ASCII = /[\u0080-\uffff]/;

// Test doubles install, replace or remove an attribute by its runtime name.
// The attribute must exist unless the call says it may not, so the call is a
// runtime use of the declaration. Each shape says where the name is written:
//   target  a dotted path string (`"pkg.module.name"`) in `targetAt`;
//   object  an owner object in `targetAt` and the member name in `memberAt`.
// `objectWhen` is the argument whose presence selects the object form of an
// API that has both. `optional` is the argument that lets the name be absent.
const argument = (position, keyword) => Object.freeze({ position, keyword });
const TARGET_PATCH = Object.freeze({ targetAt: argument(0, 'target'), target: true,
    optional: Object.freeze({ at: argument(3, 'create'), value: 'true' }) });
const OBJECT_PATCH = Object.freeze({ targetAt: argument(0, 'target'), memberAt: argument(1, 'attribute'), object: true,
    optional: Object.freeze({ at: argument(4, 'create'), value: 'true' }) });
const ATTRIBUTE_SET = Object.freeze({ targetAt: argument(0, 'target'), memberAt: argument(1, 'name'), target: true, object: true,
    objectWhen: argument(2, 'value'), optional: Object.freeze({ at: argument(3, 'raising'), value: 'false' }) });
const ATTRIBUTE_DELETE = Object.freeze({ targetAt: argument(0, 'target'), memberAt: argument(1, 'name'), target: true, object: true,
    objectWhen: argument(1, 'name'), optional: Object.freeze({ at: argument(2, 'raising'), value: 'false' }) });
const MEMBER_SPY = Object.freeze({ targetAt: argument(0, 'obj'), memberAt: argument(1, 'name'), object: true });
const MONKEYPATCH = 'pytest.MonkeyPatch.instance';
const MOCKER = 'pytest_mock.MockerFixture.instance';
const PATCH_APIS = new Map([
    ['unittest.mock.patch', TARGET_PATCH],
    ['unittest.mock.patch.object', OBJECT_PATCH],
    [`${MONKEYPATCH}.setattr`, ATTRIBUTE_SET],
    [`${MONKEYPATCH}.delattr`, ATTRIBUTE_DELETE],
    [`${MOCKER}.patch`, TARGET_PATCH],
    [`${MOCKER}.patch.object`, OBJECT_PATCH],
    [`${MOCKER}.spy`, MEMBER_SPY],
]);
// Other import paths of the same APIs: pytest's implementation module,
// pytest-mock's plugin module and former class name, the `mock` distribution.
const API_ALIASES = [
    ['_pytest.monkeypatch.MonkeyPatch', 'pytest.MonkeyPatch'],
    ['pytest_mock.plugin.MockerFixture', 'pytest_mock.MockerFixture'],
    ['pytest_mock.MockFixture', 'pytest_mock.MockerFixture'],
    ['mock.mock', 'unittest.mock'],
    ['mock', 'unittest.mock'],
];
// What calling one of these yields: the class, or `context()` of the class
// or of an instance.
const INSTANCE_PRODUCERS = new Map([
    ['pytest.MonkeyPatch', MONKEYPATCH],
    ['pytest.MonkeyPatch.context', MONKEYPATCH],
    [`${MONKEYPATCH}.context`, MONKEYPATCH],
    ['pytest_mock.MockerFixture', MOCKER],
]);
const INSTANCE_CLASSES = new Map([['pytest.MonkeyPatch', MONKEYPATCH], ['pytest_mock.MockerFixture', MOCKER]]);
// pytest fills a parameter of these names with the fixture of that name.
const FIXTURE_PARAMETERS = new Map([['monkeypatch', MONKEYPATCH],
    ...['mocker', 'class_mocker', 'module_mocker', 'package_mocker', 'session_mocker'].map(name => [name, MOCKER])]);
// The member a call is written with when its receiver has no identity.
const SPELLED_APIS = new Map([['patch', 'unittest.mock.patch'], ['setattr', `${MONKEYPATCH}.setattr`],
    ['delattr', `${MONKEYPATCH}.delattr`], ['spy', `${MOCKER}.spy`]]);

const POSSIBLE_RUNTIME_APIS = [...BUILTINS].map(name => `builtins.${name}`).concat([
    ...PATCH_APIS.keys(), 'setuptools.setup', 'distutils.core.setup',
]);

function canonicalApi(origin) {
    for (const [from, to] of API_ALIASES) {
        if (origin === from || origin.startsWith(`${from}.`)) return to + origin.slice(from.length);
    }
    return origin;
}

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
        // Recorded when the file was indexed, from the same tree; it answers
        // for the text the file was indexed from.
        let recorded = null;
        if (Array.isArray(entry.normalizedIdentifiers)) {
            try {
                if (indexedContent(index, file, entry, index._readFile(file))) recorded = entry.normalizedIdentifiers;
            } catch { /* unreadable: read below, as for any file */ }
        }
        for (const name of recorded || fileNormalizedNames(() => index._readFile(file),
            source => index._getParsedTree(file, source, entry.language))) names.add(name);
    }
    if (operation) OP_NORMALIZED_NAMES.set(operation, names);
    return names;
}

/**
 * One file's part of the inventory above, sorted: the NFKC form of each
 * identifier written otherwise. `readSource` and `treeOf` supply the file;
 * one that cannot be read or parsed has no part.
 */
function fileNormalizedNames(readSource, treeOf) {
    let source, tree;
    try {
        source = readSource();
        // This is only a parse precheck. Runtime strings are never added.
        // ASCII text is its own NFKC form.
        if (!NON_ASCII.test(source) || source.normalize('NFKC') === source) return [];
        tree = treeOf(source);
    } catch { return []; }
    if (!tree) return [];
    const names = new Set();
    for (const identifier of tree.rootNode.descendantsOfType('identifier')) {
        const normalized = pythonSourceName(identifier.text);
        if (normalized !== identifier.text) names.add(normalized);
    }
    return [...names].sort();
}

/** Explicit project source can mutate otherwise-known standard identities. */
function projectNamespaceEffects(index) {
    const operation = index._opTreeCache;
    if (operation && OP_NAMESPACE_EFFECTS.has(operation)) return OP_NAMESPACE_EFFECTS.get(operation);
    const { langTraits } = require('../languages');
    const python = [...index.files].filter(([, entry]) => langTraits(entry.language)?.reflectionApi?.pythonBindingIdentity);
    const partOf = ([file, entry]) => fileNamespaceEffects(() => index._readFile(file),
        source => index._getParsedTree(file, source, entry.language));
    // The sole consumer treats '*' as affecting every identity: once one
    // file gives it, no other file can change an answer, whichever file it
    // is. So the smaller files, cheaper to walk, are read first; without a
    // '*' every file is read and the order does not matter.
    const bySize = [...python].sort(([fileA, a], [fileB, b]) =>
        (a.size || 0) - (b.size || 0) || (fileA < fileB ? -1 : fileA > fileB ? 1 : 0));
    let affected;
    try {
        affected = collectNamespaceEffects(bySize, partOf);
    } catch {
        // A walk that fails sends the inventory back to the files in index
        // order, which fails where that order reaches the failing file
        // before a '*'. A failing file the smaller-first order never reaches
        // (a '*' came first) fails nothing.
        affected = collectNamespaceEffects(python, partOf);
    }
    if (operation) OP_NAMESPACE_EFFECTS.set(operation, affected);
    return affected;
}

/** The parts of `files` in order, until one gives '*'. */
function collectNamespaceEffects(files, partOf) {
    const affected = new Set();
    for (const file of files) {
        if (affected.has('*')) break;
        for (const effect of partOf(file)) affected.add(effect);
    }
    return affected;
}

/**
 * One file's part of the inventory above, sorted: `*` (any identity) or
 * the standard identities its source can change. A file that cannot be
 * read or parsed can change any.
 */
function fileNamespaceEffects(readSource, treeOf) {
    let source, tree;
    try {
        source = readSource();
        // A text precheck only. Identities/effects come from the AST.
        // ASCII text is its own NFKC form.
        if (!/\b(?:builtins|typing|__builtins__|__dict__|__self__|__globals__|__import__|import_module|getattr|vars|globals)\b/.test(NON_ASCII.test(source) ? source.normalize('NFKC') : source)) return [];
        tree = treeOf(source);
    } catch { return ['*']; }
    if (!tree) return ['*'];
    const affected = new Set();
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
    return [...affected].sort();
}

function pythonProjectIdentityAffected(index, identity) {
    const effects = projectNamespaceEffects(index);
    if (effects.has('*')) return true;
    const namespace = identity.split('.')[0];
    if (effects.has(`${namespace}.*`)) return true;
    if (identity.endsWith('.*')) return [...effects].some(effect => effect.startsWith(identity.slice(0, -1)));
    return effects.has(identity) || [...effects].some(effect => effect.startsWith(`${identity}.`));
}

// One walk of a scope answers for every name it binds; a file's identities
// ask about many names of the same few scopes.
const SCOPE_BINDINGS = new WeakMap();
function scopeBindings(node) {
    let scope = node;
    while (scope && !['module', 'function_definition', 'class_definition'].includes(scope.type)) scope = scope.parent;
    if (!scope) return new Map();
    let tables = SCOPE_BINDINGS.get(scope.tree);
    if (!tables) { tables = new Map(); SCOPE_BINDINGS.set(scope.tree, tables); }
    const key = `${scope.type}:${scope.startIndex}:${scope.endIndex}`;
    let table = tables.get(key);
    if (!table) { table = pythonScopeBindingTable(scope); tables.set(key, table); }
    return table;
}

function bindingSites(scope, name) {
    const found = [];
    const table = scopeBindings(scope);
    for (const spelling of sourceSpellings(scope.tree, name)) {
        for (const binding of table.get(spelling) || []) {
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

/**
 * Iteration retains possible written values; it never proves a binding exact.
 * `containers`: the liveness reader also iterates a literal dictionary (its
 * keys) and `values()` / `keys()` of one, and marks a container whose
 * contents it cannot close as unresolved.
 */
function iterationValues(site, containers = false) {
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
        if (containers && iterable.type === 'call') {
            // `d.values()` / `d.keys()` of a dictionary this reader closes.
            const fn = iterable.childForFieldName('function');
            const member = fn?.type === 'attribute' ? pythonSourceName(fn.childForFieldName('attribute')?.text) : null;
            const read = member === 'values' || member === 'keys'
                ? containerNodes(fn.childForFieldName('object'), memo) : null;
            if (!read || read.open || (iterable.childForFieldName('arguments')?.namedChildCount || 0) > 0 ||
                read.nodes.some(node => node.type !== 'dictionary')) { values.unresolved = true; continue; }
            for (const dictionary of read.nodes) {
                for (const pair of dictionary.namedChildren) {
                    if (pair.type !== 'pair') { values.unresolved = true; continue; }
                    const projected = projectValue(target, pair.childForFieldName(member === 'values' ? 'value' : 'key'), site);
                    if (projected) values.push(projected);
                }
            }
        } else if (containers && iterable.type === 'dictionary') {
            for (const pair of iterable.namedChildren) {
                if (pair.type !== 'pair') { values.unresolved = true; continue; }
                const projected = projectValue(target, pair.childForFieldName('key'), site);
                if (projected) values.push(projected);
            }
        } else if (['list', 'tuple', 'set'].includes(iterable.type)) {
            for (const value of iterable.namedChildren) {
                if (value.type === 'list_splat') pending.push(value.namedChild(0));
                else {
                    const projected = projectValue(target, value, site);
                    if (projected) values.push(projected);
                }
            }
        } else if (containers) {
            // A name iterated here: every container it is written with, and
            // nothing else touches it.
            const read = iterable.type === 'identifier' ? containerNodes(iterable, memo) : null;
            if (!read || read.open) values.unresolved = true;
            else pending.push(...read.nodes);
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

/**
 * Origins a parameter without a default can be given: the fixture pytest
 * injects under that name, and an instance of the patcher class it is
 * annotated with. Null when the site is no such parameter.
 */
function parameterOrigins(site, memo, depth, ignoreEffects) {
    const holder = site.parent;
    const typed = holder?.type === 'typed_parameter';
    if ((typed ? holder.parent : holder)?.type !== 'parameters') return null;
    const origins = [];
    const fixture = FIXTURE_PARAMETERS.get(pythonSourceName(site.text));
    if (fixture) origins.push(fixture);
    if (typed) {
        const annotation = holder.childForFieldName('type')?.namedChild(0);
        for (const origin of resolveIdentity(annotation, memo, depth + 1, ignoreEffects).origins) {
            const instance = INSTANCE_CLASSES.get(canonicalApi(origin));
            if (instance && !origins.includes(instance)) origins.push(instance);
        }
    }
    return origins;
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
            : INSTANCE_PRODUCERS.has(canonicalApi(origin)) ? [INSTANCE_PRODUCERS.get(canonicalApi(origin))] : []), certain: called.certain };
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
                const injected = parameterOrigins(site, memo, depth, ignoreEffects);
                if (injected) {
                    // A caller, a fixture of the project or a plugin may pass
                    // another value: a possible origin, never an exact one.
                    origins.push(...injected);
                    certain = false;
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

/**
 * The origins the file's bindings give an expression, without the stand-in
 * for an origin that could not be followed (pythonPossibleIdentities adds
 * every runtime API for that one).
 */
function pythonResolvedOrigins(expression, memo = new Map()) {
    return resolveIdentity(expression, memo, 0, true).origins.filter(origin => !origin.startsWith(UNKNOWN_ORIGIN));
}

/** The patch shape of a resolved API identity (see PATCH_APIS), or null. */
function pythonPatchApi(identity) {
    return PATCH_APIS.get(canonicalApi(identity)) || null;
}

/**
 * The patch shape a callee is WRITTEN as, for a callee no identity is proven
 * for: a member `patch`, `patch.object`, `setattr`, `delattr` or `spy` of any
 * receiver (a fixture stored on `self`, a helper's parameter, a wrapper
 * object), or a bare `patch` this file does not define. The spelling proves
 * nothing about the receiver; its only use is to keep a declaration the call
 * names out of a deletion claim. A method the receiver's class (one this
 * file defines) declares itself is that class's own (fix #512): it is read
 * as a patch API only when its body makes a call shaped like one, as a
 * wrapper that hands the name on does.
 */
function pythonPatchSpelling(callee, memo = new Map()) {
    return patchSpelling(callee, memo, new Set());
}

function patchSpelling(callee, memo, visiting) {
    let node = callee;
    while (node?.type === 'parenthesized_expression') node = node.namedChild(0);
    if (node?.type === 'attribute') {
        const member = pythonSourceName(node.childForFieldName('attribute')?.text);
        let owner = node.childForFieldName('object');
        while (owner?.type === 'parenthesized_expression') owner = owner.namedChild(0);
        const ownerName = owner?.type === 'attribute' ? owner.childForFieldName('attribute')?.text
            : owner?.type === 'identifier' ? owner.text : null;
        if (member === 'object' && pythonSourceName(ownerName) === 'patch') return OBJECT_PATCH;
        const shape = PATCH_APIS.get(SPELLED_APIS.get(member)) || null;
        if (shape && ownMethodPatchesNothing(owner, member, memo, visiting)) return null;
        return shape;
    }
    if (node?.type !== 'identifier' || pythonSourceName(node.text) !== 'patch') return null;
    // A function or class this file defines under the name is that definition.
    const scope = sourceScope(node, memo);
    if (scope && bindingSites(scope, node.text).some(binding => binding.kind === 'def')) return null;
    return TARGET_PATCH;
}

/** The class_definition a receiver is known to be an instance (or the class) of, in this file. */
function receiverClass(owner, memo) {
    if (owner?.type === 'identifier') {
        // `self` / `cls`: the first parameter of a method of a class body.
        const scope = sourceScope(owner, memo);
        if (scope?.type === 'function_definition') {
            const first = scope.childForFieldName('parameters')?.namedChildren.find(child => child.type !== 'comment');
            const firstName = first?.type === 'identifier' ? first.text : null;
            let holder = scope.parent?.type === 'decorated_definition' ? scope.parent.parent : scope.parent;
            if (firstName === owner.text && holder?.type === 'block' && holder.parent?.type === 'class_definition' &&
                bindingSites(scope, owner.text).length === 1) return holder.parent;
        }
    }
    const found = pythonPatchOwner(owner, memo);
    if (!found?.local || (found.path || []).length > 0) return null;
    return owner.tree.rootNode.descendantsOfType('class_definition').find(node =>
        node.startPosition.row + 1 === found.line && pythonSourceName(node.childForFieldName('name')?.text) === found.local) || null;
}

/**
 * Does the receiver's class, defined in this file, declare `member` itself
 * with a body that makes no call shaped like a patch API?
 */
function ownMethodPatchesNothing(owner, member, memo, visiting) {
    const cls = owner ? receiverClass(owner, memo) : null;
    const method = (cls?.childForFieldName('body')?.namedChildren || [])
        .map(node => (node.type === 'decorated_definition' ? node.namedChildren.find(child => child.type === 'function_definition') : node))
        .find(node => node?.type === 'function_definition' && pythonSourceName(node.childForFieldName('name')?.text) === member);
    if (!method) return false;
    const key = `${method.startIndex}:${method.endIndex}`;
    // A method calling itself is no patch call.
    if (visiting.has(key)) return true;
    visiting.add(key);
    try {
        for (const call of method.childForFieldName('body')?.descendantsOfType('call') || []) {
            const fn = call.childForFieldName('function');
            if (pythonPossibleIdentities(fn, memo).some(identity => pythonPatchApi(identity))) return false;
            if (patchSpelling(fn, memo, visiting)) return false;
        }
    } finally { visiting.delete(key); }
    return true;
}

/**
 * Every value a name is written with in the scope that binds it, or null
 * when one of its bindings has no readable value (a parameter, an import, an
 * unpacking this reader cannot project). Possible values, in no order: a
 * liveness reader asks what the name MAY hold, not what it holds at a line.
 */
function pythonPossibleValues(identifier, memo = new Map()) {
    if (identifier?.type !== 'identifier') return null;
    const scope = sourceScope(identifier, memo);
    if (!scope) return null;
    const sites = bindingSites(scope, identifier.text);
    if (!sites.length) return null;
    const values = [];
    for (const binding of sites) {
        // A parameter pytest fills from a `parametrize` mark holds the
        // values the mark lists; an indirect or unreadable mark leaves it
        // unknown.
        const parametrized = binding.kind === 'binding' ? parametrizeValues(binding.node, memo) : undefined;
        if (parametrized !== undefined) {
            if (!parametrized) return null;
            values.push(...parametrized);
            continue;
        }
        // A parameter holds what its callers pass, whatever its default is.
        if (binding.kind !== 'binding' || parameterOrigins(binding.node, memo, 0, true) ||
            ['default_parameter', 'typed_default_parameter'].includes(binding.node.parent?.type)) return null;
        const value = bindingValue(binding.node, Infinity);
        if (value) { values.push(value); continue; }
        const iterated = iterationValues(binding.node, true);
        if (!iterated.length || iterated.unresolved) return null;
        values.push(...iterated);
    }
    return values;
}

const CONTAINERS = new Set(['dictionary', 'list', 'tuple', 'set']);
// Calls on a container that read it and change nothing.
const CONTAINER_READS = new Set(['get', 'values', 'keys', 'items', 'copy', 'index', 'count', '__getitem__', '__contains__']);
const WRITE_STATEMENTS = new Set(['assignment', 'augmented_assignment', 'delete_statement', 'for_statement',
    'for_in_clause', 'as_pattern', 'named_expression']);

/**
 * The literal containers (dictionary, list, tuple, set) an expression can
 * be: { nodes, open }. A name counts only when every value it is written
 * with is one and the file never hands it on or changes it (`open` true
 * otherwise): its contents are then the literal contents.
 */
function containerNodes(expression, memo = new Map(), depth = 0) {
    let node = expression;
    while (node?.type === 'parenthesized_expression') node = node.namedChild(0);
    const open = { nodes: [], open: true };
    if (!node || depth > 4) return open;
    if (CONTAINERS.has(node.type)) return { nodes: [node], open: false };
    if (node.type !== 'identifier' || !containerUntouched(node, memo)) return open;
    const values = pythonPossibleValues(node, memo);
    if (!values) return open;
    const nodes = [];
    for (const value of values) {
        const read = containerNodes(value, memo, depth + 1);
        if (read.open) return open;
        nodes.push(...read.nodes);
    }
    return { nodes, open: false };
}

/** Is every occurrence of the name in its file a read of the container? */
function containerUntouched(identifier, memo) {
    const name = pythonSourceName(identifier.text);
    const effects = effectsOf(identifier);
    const key = `container-untouched:${name}`;
    if (memo.has(key)) return memo.get(key);
    let untouched = !effects.escaped.has(name) && !effects.wildcard;
    for (const occurrence of untouched ? effects.identifiers : []) {
        if (pythonSourceName(occurrence.text) !== name || containerRead(occurrence)) continue;
        untouched = false;
        break;
    }
    memo.set(key, untouched);
    return untouched;
}

function containerRead(occurrence) {
    let node = occurrence;
    while (node.parent?.type === 'parenthesized_expression') node = node.parent;
    const parent = node.parent;
    if (!parent) return false;
    const field = name => sameNode(parent.childForFieldName(name), node);
    switch (parent.type) {
        // The name written again, or another variable of the name: the
        // binding reader has its values.
        case 'assignment': return field('left');
        case 'function_definition': case 'class_definition': return field('name');
        case 'parameters': case 'typed_parameter': case 'default_parameter': case 'typed_default_parameter':
            return !field('value') && !field('type');
        case 'keyword_argument': return field('name') || readerArgument(parent.parent);
        case 'argument_list': return readerArgument(parent);
        case 'dotted_name': case 'aliased_import': case 'import_statement': case 'import_from_statement':
            return true;
        case 'attribute': {
            if (field('attribute')) return true;
            const member = pythonSourceName(parent.childForFieldName('attribute')?.text);
            return CONTAINER_READS.has(member) && parent.parent?.type === 'call' &&
                sameNode(parent.parent.childForFieldName('function'), parent);
        }
        case 'subscript': {
            if (!field('value')) return true;
            // `d[k] = v`, `del d[k]`, `d[k] += 1` change the container.
            let target = parent;
            while (TARGET_WRAPPERS.has(target.parent?.type)) target = target.parent;
            const holder = target.parent;
            return !(WRITE_STATEMENTS.has(holder?.type) && !sameNode(holder.childForFieldName('right'), target) &&
                !sameNode(holder.childForFieldName('value'), target));
        }
        case 'for_statement': case 'for_in_clause': return field('right');
        case 'comparison_operator': return true;
        default: return false;
    }
}

// Callables that read a container handed to them and keep nothing that
// changes it.
const CONTAINER_READERS = new Set(['pytest.mark.parametrize', ...['len', 'sorted', 'list', 'tuple', 'set',
    'frozenset', 'iter', 'enumerate', 'zip', 'reversed', 'any', 'all', 'min', 'max', 'sum', 'str', 'repr', 'print']
    .map(name => `builtins.${name}`)]);

/** Is `argumentList` the arguments of `sep.join(..)` or of a CONTAINER_READERS call? */
function readerArgument(argumentList) {
    const call = argumentList?.type === 'argument_list' ? argumentList.parent : null;
    if (call?.type !== 'call') return false;
    const fn = call.childForFieldName('function');
    if (fn?.type === 'attribute' && pythonSourceName(fn.childForFieldName('attribute')?.text) === 'join' &&
        ['string', 'concatenated_string'].includes(fn.childForFieldName('object')?.type)) return true;
    const origins = pythonPossibleIdentities(fn);
    return origins.length > 0 && origins.every(origin => CONTAINER_READERS.has(origin));
}

const PARAMETER_HOLDERS = new Set(['typed_parameter', 'default_parameter', 'typed_default_parameter']);

/**
 * The values pytest gives a parameter from a `parametrize` mark of its test
 * (on the function, on an enclosing class, or a `pytestmark` of the class or
 * the module): the value nodes in the order written, null when the mark
 * binds the parameter but its values cannot be read (indirect, built at run
 * time), undefined when no mark binds it.
 */
function parametrizeValues(site, memo) {
    let holder = site.parent;
    if (PARAMETER_HOLDERS.has(holder?.type)) {
        if (!sameNode(holder.childForFieldName('name') || holder.namedChild(0), site)) return undefined;
        holder = holder.parent;
    }
    if (holder?.type !== 'parameters' || holder.parent?.type !== 'function_definition') return undefined;
    const fn = holder.parent;
    const name = pythonSourceName(site.text);
    const decoratorsOf = definition => (definition.parent?.type === 'decorated_definition'
        ? definition.parent.namedChildren.filter(child => child.type === 'decorator').map(child => child.namedChild(0)) : []);
    const marksOf = body => {
        const marks = [];
        for (const statement of body?.namedChildren || []) {
            const assignment = statement.type === 'expression_statement' ? statement.namedChild(0) : null;
            const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
            if (left?.type !== 'identifier' || pythonSourceName(left.text) !== 'pytestmark') continue;
            const right = assignment.childForFieldName('right');
            marks.push(...(['list', 'tuple'].includes(right?.type) ? right.namedChildren : [right]));
        }
        return marks;
    };
    const marks = decoratorsOf(fn);
    for (let parent = fn.parent; parent; parent = parent.parent) {
        // A function nested in another one is not collected by pytest.
        if (parent.type === 'function_definition') break;
        if (parent.type === 'class_definition') marks.push(...decoratorsOf(parent), ...marksOf(parent.childForFieldName('body')));
        if (parent.type === 'module') marks.push(...marksOf(parent));
    }
    for (const mark of marks) {
        const read = parametrizeMark(mark, name, memo);
        if (read !== undefined) return read;
    }
    return undefined;
}

function parametrizeMark(mark, name, memo) {
    if (mark?.type !== 'call' ||
        !pythonPossibleIdentities(mark.childForFieldName('function'), memo).includes('pytest.mark.parametrize')) return undefined;
    const { pythonStringLiteral } = require('./runtime-entrypoints');
    const args = (mark.childForFieldName('arguments')?.namedChildren || []).filter(child => child.type !== 'comment');
    // Arguments spread from elsewhere may bind any name.
    if (args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat')) return null;
    const positional = args.filter(arg => arg.type !== 'keyword_argument');
    const keyword = key => args.find(arg => arg.type === 'keyword_argument' &&
        pythonSourceName(arg.childForFieldName('name')?.text) === key)?.childForFieldName('value');
    const namesNode = positional[0] || keyword('argnames');
    let names = null;
    const text = namesNode ? pythonStringLiteral(namesNode) : null;
    if (text != null) names = text.split(',').map(part => part.trim()).filter(Boolean);
    else if (['list', 'tuple'].includes(namesNode?.type)) {
        names = namesNode.namedChildren.filter(child => child.type !== 'comment').map(child => pythonStringLiteral(child));
        if (names.some(part => part == null)) names = null;
    }
    // A mark whose names cannot be read may bind this parameter.
    if (!names) return null;
    const position = names.map(pythonSourceName).indexOf(name);
    if (position < 0) return undefined;
    // `indirect`: the value goes to a fixture of that name, which returns
    // what it likes.
    const indirect = keyword('indirect');
    if (indirect && indirect.type !== 'false') {
        if (!['list', 'tuple'].includes(indirect.type)) return null;
        if (indirect.namedChildren.some(child => child.type !== 'comment' &&
            [null, name].includes(pythonStringLiteral(child) == null ? null : pythonSourceName(pythonStringLiteral(child))))) return null;
    }
    const read = containerNodes(positional[1] || keyword('argvalues'), memo);
    if (read.open) return null;
    const values = [];
    for (const container of read.nodes) {
        if (!['list', 'tuple'].includes(container.type)) return null;
        for (const element of container.namedChildren) {
            if (element.type === 'comment') continue;
            if (element.type === 'list_splat') return null;
            let row = element;
            while (row.type === 'parenthesized_expression' && (text == null || names.length > 1)) row = row.namedChild(0);
            let cells;
            if (row.type === 'call' &&
                pythonPossibleIdentities(row.childForFieldName('function'), memo).includes('pytest.param')) {
                cells = (row.childForFieldName('arguments')?.namedChildren || [])
                    .filter(child => child.type !== 'comment' && child.type !== 'keyword_argument');
            } else if (text != null && names.length === 1) {
                // One name written as a string: each row is the value. Names
                // written as a sequence make each row a sequence of values.
                values.push(row);
                continue;
            } else if (['tuple', 'list'].includes(row.type)) {
                cells = row.namedChildren.filter(child => child.type !== 'comment');
            } else return null;
            if (cells.some(cell => cell.type === 'list_splat' || cell.type === 'dictionary_splat') ||
                cells.length !== names.length) return null;
            values.push(cells[position]);
        }
    }
    return values;
}

/**
 * The object a patch call names its member on, when the file proves what it
 * is (fix #512):
 *   { import: { module, name }, path }  a name bound only by an import: the
 *       module as written there, the imported member (null: the module
 *       itself), and the attributes read from it;
 *   { module, path }  `importlib.import_module("m")`, `sys.modules["m"]`;
 *   { local, line, path }  a class this file defines;
 * `instance` when the owner is an instance of that class. Null for anything
 * else (a parameter, a call result, a name bound more than once).
 */
function pythonPatchOwner(expression, memo = new Map(), depth = 0) {
    let node = expression;
    while (node?.type === 'parenthesized_expression') node = node.namedChild(0);
    if (!node || depth > 4) return null;
    const path = [];
    while (node?.type === 'attribute') {
        const member = node.childForFieldName('attribute')?.text;
        if (!member) return null;
        path.unshift(pythonSourceName(member));
        node = node.childForFieldName('object');
        while (node?.type === 'parenthesized_expression') node = node.namedChild(0);
    }
    if (!node) return null;
    const extend = owner => (owner ? { ...owner, path: [...(owner.path || []), ...path] } : null);
    const { pythonStringLiteral } = require('./runtime-entrypoints');
    if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        const args = (node.childForFieldName('arguments')?.namedChildren || []).filter(child => child.type !== 'comment');
        const identities = pythonPossibleIdentities(fn, memo);
        if (identities.length === 1 && identities[0] === 'importlib.import_module') {
            const text = args.length === 1 ? pythonStringLiteral(args[0]) : null;
            return text && !text.startsWith('.') ? extend({ module: text }) : null;
        }
        // `Klass()`: an instance has its class's attributes.
        const owner = path.length === 0 ? pythonPatchOwner(fn, memo, depth + 1) : null;
        return owner && (owner.import || owner.local) ? { ...owner, instance: true } : null;
    }
    if (node.type === 'subscript') {
        const identities = pythonPossibleIdentities(node.childForFieldName('value'), memo);
        const keys = node.childrenForFieldName('subscript');
        if (identities.length !== 1 || identities[0] !== 'sys.modules' || keys.length !== 1) return null;
        const text = pythonStringLiteral(keys[0]);
        return text && !text.startsWith('.') ? extend({ module: text }) : null;
    }
    if (node.type !== 'identifier') return null;
    const name = pythonSourceName(node.text);
    const effects = effectsOf(node);
    if (effects.escaped.has(name) || effects.wildcard || effects.unknownWrites) return null;
    const scope = sourceScope(node, memo);
    const sites = scope ? bindingSites(scope, node.text) : [];
    if (sites.length !== 1) return null;
    const site = sites[0].node;
    if (sites[0].kind === 'import') {
        let part = site;
        while (part.parent && !['import_statement', 'import_from_statement'].includes(part.parent.type)) part = part.parent;
        const statement = part.parent;
        if (!statement) return null;
        const written = part.type === 'aliased_import' ? part.childForFieldName('name')?.text : part.text;
        if (!written) return null;
        if (statement.type === 'import_from_statement') {
            const module = statement.childForFieldName('module_name')?.text;
            return module ? { import: { module, name: pythonSourceName(written) }, path } : null;
        }
        // `import a.b as m` binds the module a.b; `import a.b` binds a.
        const module = part.type === 'aliased_import' ? written : written.split('.')[0];
        return { import: { module: pythonSourceName(module), name: null }, path };
    }
    const parent = site.parent;
    if (sites[0].kind === 'def' && parent?.type === 'class_definition') {
        return { local: name, line: parent.startPosition.row + 1, path };
    }
    if (sites[0].kind === 'binding') {
        const value = bindingValue(site, Infinity);
        return value ? extend(pythonPatchOwner(value, memo, depth + 1)) : null;
    }
    return null;
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

// Decorators that hand back the declaration, or a wrapper of it, and record
// it nowhere: nothing can reach the declaration through them. A decorator
// outside this list may register what it decorates (a route, a fixture, a
// signal receiver, a plugin hook).
const INERT_DECORATORS = new Set(['builtins.property', 'builtins.classmethod', 'builtins.staticmethod',
    'dataclasses.dataclass', 'functools.lru_cache', 'functools.cache', 'functools.cached_property',
    'functools.wraps', 'functools.total_ordering', 'contextlib.contextmanager', 'contextlib.asynccontextmanager',
    'typing.final', 'typing.overload', 'typing.override', 'typing.runtime_checkable', 'typing.no_type_check',
    'enum.unique']);
// Every member of these namespaces is one: a pytest mark attaches data to a
// test that is collected by its name whether or not it is marked.
const INERT_DECORATOR_NAMESPACES = ['pytest.mark.'];

/**
 * Is every decorator of a declaration one that registers nothing? Each is
 * resolved through the file's own bindings to the identity it names (the
 * callee, for a decorator written as a call); an identity that is not
 * proven, that a module of the project supplies, or that is not known to
 * be inert answers false.
 *
 * @param {object} index
 * @param {object} symbol - the indexed declaration (a function or a class)
 */
function pythonDecoratorsRegisterNothing(index, symbol) {
    let declaration;
    try {
        const tree = index._getParsedTree(symbol.file, index._readFile(symbol.file), index.files.get(symbol.file)?.language);
        declaration = tree?.rootNode.descendantsOfType(['function_definition', 'class_definition']).find(node =>
            node.childForFieldName('name')?.text === symbol.name &&
            node.startPosition.row + 1 >= symbol.startLine && node.endPosition.row + 1 <= (symbol.endLine || symbol.startLine)) || null;
    } catch { return false; }
    if (!declaration) return false;
    const decorated = declaration.parent;
    if (decorated?.type !== 'decorated_definition') return true;
    return pythonDecoratorsInert(decorated, new Map(), index.files.get(symbol.file)?.moduleResolved || {});
}

/**
 * Is every decorator of a `decorated_definition` one that hands the
 * definition back and records it nowhere (INERT_DECORATORS)? `resolved` is
 * the file's import resolution when known: a module of the project under a
 * standard name is not the standard one.
 */
function pythonDecoratorsInert(decorated, memo = new Map(), resolved = {}) {
    return decorated.namedChildren.filter(node => node.type === 'decorator').every(decorator => {
        let expression = decorator.namedChild(0);
        if (expression?.type === 'call') expression = expression.childForFieldName('function');
        let identity;
        try { identity = pythonIdentity(expression, memo); } catch { identity = null; }
        if (!identity) return false;
        if (Object.keys(resolved).some(module => resolved[module] && (identity === module || identity.startsWith(`${module}.`)))) return false;
        const canonical = identity.replace(/^typing_extensions\./, 'typing.');
        return INERT_DECORATORS.has(canonical) || INERT_DECORATOR_NAMESPACES.some(namespace => canonical.startsWith(namespace));
    });
}

// Names the interpreter supplies beside its callable builtins: exception and
// warning classes, constants, and what a checker or the site module adds.
const AMBIENT_NAMES = new Set(['ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException',
    'BaseExceptionGroup', 'BlockingIOError', 'BrokenPipeError', 'BufferError', 'BytesWarning',
    'ChildProcessError', 'ConnectionAbortedError', 'ConnectionError', 'ConnectionRefusedError',
    'ConnectionResetError', 'DeprecationWarning', 'EOFError', 'Ellipsis', 'EncodingWarning',
    'EnvironmentError', 'Exception', 'ExceptionGroup', 'False', 'FileExistsError', 'FileNotFoundError',
    'FloatingPointError', 'FutureWarning', 'GeneratorExit', 'IOError', 'ImportError', 'ImportWarning',
    'IndentationError', 'IndexError', 'InterruptedError', 'IsADirectoryError', 'KeyError',
    'KeyboardInterrupt', 'LookupError', 'MemoryError', 'ModuleNotFoundError', 'NameError', 'None',
    'NotADirectoryError', 'NotImplemented', 'NotImplementedError', 'OSError', 'OverflowError',
    'PendingDeprecationWarning', 'PermissionError', 'ProcessLookupError', 'PythonFinalizationError',
    'RecursionError', 'ReferenceError', 'ResourceWarning', 'RuntimeError', 'RuntimeWarning',
    'StopAsyncIteration', 'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError', 'SystemExit',
    'TabError', 'TimeoutError', 'True', 'TypeError', 'UnboundLocalError', 'UnicodeDecodeError',
    'UnicodeEncodeError', 'UnicodeError', 'UnicodeTranslateError', 'UnicodeWarning', 'UserWarning',
    'ValueError', 'Warning', 'WindowsError', 'ZeroDivisionError', 'reveal_type', 'reveal_locals']);
// A name a program installs into the builtins by convention (gettext).
const INSTALLED_NAMES = new Set(['_']);

/** Does any Python file of the project name the builtins namespace? */
function projectNamesBuiltins(index) {
    const memo = index._opMemo?.('pythonNamesBuiltins', () => ({}));
    if (memo && memo.value !== undefined) return memo.value;
    const { langTraits } = require('../languages');
    let named = false;
    for (const [file, entry] of index.files) {
        if (!langTraits(entry.language)?.reflectionApi?.pythonBindingIdentity) continue;
        let source;
        try { source = index._readFile(file); } catch { named = true; break; }
        if (/\b(?:builtins|__builtins__|__builtin__)\b/.test(source.normalize('NFKC'))) { named = true; break; }
    }
    if (memo) memo.value = named;
    return named;
}

/**
 * Is a bare name read shown to have no binding? True only when the scope
 * it resolves in is decidable and binds nothing of that name: no local or
 * enclosing binding, no module-level binding or import, no star import
 * that could supply it, no `global` declaration, no write to a namespace,
 * no builtin of that name, and no file of the project that names the
 * builtins namespace (a program can install names into it), and no `exec`
 * or `eval` in the file. A local the function binds only after the read is
 * unbound there too.
 *
 * @param {Set<string>} ambientCallables - trait `ambientCallables`
 */
function pythonNameUnbound(identifier, index = null, ambientCallables = null) {
    if (identifier?.type !== 'identifier') return false;
    const name = pythonSourceName(identifier.text);
    if (!name || /^__\w+__$/.test(name) || AMBIENT_NAMES.has(name) || INSTALLED_NAMES.has(name)) return false;
    // Without the language's callable builtins nothing is shown.
    if (!ambientCallables || ambientCallables.has(name)) return false;
    const memo = new Map();
    let resolved;
    try {
        // Code the file runs from text can bind any name.
        if (effectsOf(identifier).calls.some(call => {
            const callee = call.childForFieldName('function');
            return callee?.type === 'identifier' && ['exec', 'eval'].includes(pythonSourceName(callee.text));
        })) return false;
        // A local of the function that holds the read, bound only by
        // statements written after it: nothing has bound it when the read
        // runs. A loop can run a later statement first, and a deferred body
        // runs after the function did.
        const scope = sourceScope(identifier, memo);
        // A lambda or a comprehension that holds the read binds the name.
        if (!scope || !['function_definition', 'module'].includes(scope.type)) return false;
        if (scope.type === 'function_definition') {
            if (effectsOf(identifier).escaped.has(name) || deferredRead(identifier, scope)) return false;
            const sites = bindingSites(scope, identifier.text);
            if (sites.length === 0 || sites.some(binding => binding.node.startIndex < identifier.endIndex)) return false;
            for (let parent = identifier.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
                if (['for_statement', 'while_statement'].includes(parent.type)) return false;
            }
            return true;
        }
        resolved = resolveIdentity(identifier, memo);
    } catch { return false; }
    if (!resolved.certain || resolved.origins.length > 0) return false;
    return !index || !projectNamesBuiltins(index);
}

module.exports = { pythonIdentity, pythonPossibleIdentities, pythonResolvedOrigins, pythonRuntimeOwners, pythonBoundValue, pythonNameUnbound,
    pythonDecoratorsRegisterNothing, pythonDecoratorsInert,
    pythonSourceName, pythonNormalizedNames, pythonProjectIdentityAffected, registrationUnknown,
    pythonPatchApi, pythonPatchSpelling, pythonPatchOwner, pythonPossibleValues, pythonContainerNodes: containerNodes,
    fileNormalizedNames, fileNamespaceEffects };
