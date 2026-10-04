/**
 * core/pytest-fixtures.js - The parameters a pytest fixture is injected
 * into, by pytest's own name resolution (fix #402).
 *
 * pytest passes a fixture to every test function or fixture that names it
 * as a parameter. Which fixture a parameter `name` receives is decided where
 * the requester is declared: a fixture method of its class, then a fixture
 * of its module (a fixture requesting its own name skips itself), then the
 * conftest.py files from the module's directory up to the project root;
 * plugins come after all of them. Renaming a fixture function renames the
 * fixture, so every parameter that receives it is renamed with it (with the
 * uses that bind that parameter), and no other parameter is.
 *
 * What the model cannot decide becomes a review item, never a silent skip
 * or edit: a parameter in a module pytest does not collect by default, a
 * class or module binding of the name that is not a resolvable fixture
 * definition (assignments, star imports, outside or unresolved imports), a
 * class with bases whose fixtures are not visible, and a parametrized
 * argument of the same name. A fixture defined outside conftest.py and test
 * modules reaches its users through plugin registration: its requesters are
 * listed for review.
 */

'use strict';

const path = require('path');
const { sameNode } = require('../languages/utils');

const PY_COMPOUNDS = new Set(['block', 'if_statement', 'elif_clause', 'else_clause', 'try_statement',
    'except_clause', 'except_group_clause', 'finally_clause', 'with_statement', 'for_statement',
    'while_statement', 'match_statement', 'case_clause']);

const isConftest = file => path.basename(file) === 'conftest.py';
// pytest's default `python_files` patterns.
const isTestModule = file => /^test_.*\.py$|^.*_test\.py$/.test(path.basename(file));
const collected = file => isConftest(file) || isTestModule(file);

function pathOf(node) {
    if (node?.type === 'identifier') return [node.text];
    if (node?.type !== 'attribute') return null;
    const root = pathOf(node.childForFieldName('object'));
    const member = node.childForFieldName('attribute');
    return root && member ? [...root, member.text] : null;
}

/** The qualified name a dotted path denotes through the file's imports of an
 * outside module, or null (a project module, a local binding, no import). */
function outsideQualified(index, file, parts) {
    const entry = index.files.get(file);
    if (!entry || !parts?.length) return null;
    if ((entry.moduleAssignedNames || []).includes(parts[0]) ||
        (index.symbols.get(parts[0]) || []).some(d => d.file === file)) return null;
    const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === parts[0]);
    if (bindings.length !== 1) return null;
    const binding = bindings[0];
    if (!binding.module || entry.moduleResolved?.[binding.module]) return null;
    const fromImport = binding.kind === 'from' || binding.kind === 'from-import';
    return fromImport
        ? [binding.module, binding.name, ...parts.slice(1)].join('.')
        : [binding.module, ...parts.slice(1)].join('.');
}

/** pytest decorator kind of one decorator node: fixture | parametrize | other. */
function decoratorOf(index, file, decorator) {
    const expression = decorator.namedChild(0);
    const callable = expression?.type === 'call' ? expression.childForFieldName('function') : expression;
    const qualified = outsideQualified(index, file, pathOf(callable));
    const args = expression?.type === 'call' ? expression.childForFieldName('arguments') : null;
    if (qualified === 'pytest.fixture') {
        let alias = null;
        let dynamicName = false;
        for (const argument of args?.namedChildren || []) {
            if (argument.type !== 'keyword_argument' || argument.childForFieldName('name')?.text !== 'name') continue;
            const value = argument.childForFieldName('value');
            const content = value?.type === 'string' ? value.namedChildren.find(c => c.type === 'string_content') : null;
            if (content && value.namedChildren.every(c => ['string_start', 'string_content', 'string_end'].includes(c.type))) {
                alias = content.text;
            } else dynamicName = true;
        }
        return { kind: 'fixture', alias, dynamicName };
    }
    if (qualified === 'pytest.mark.parametrize') {
        // argnames: "a, b" / "a,b" / ("a", "b") / ["a", "b"]; anything else
        // is unknown and treated as naming every parameter.
        const first = args?.namedChildren.find(c => c.type !== 'comment' && c.type !== 'keyword_argument') ||
            args?.namedChildren.find(c => c.type === 'keyword_argument' &&
                c.childForFieldName('name')?.text === 'argnames')?.childForFieldName('value');
        const strings = first?.type === 'string' ? [first]
            : ['tuple', 'list'].includes(first?.type) ? first.namedChildren : null;
        if (!strings || strings.some(s => s.type !== 'string')) return { kind: 'parametrize', names: null };
        const names = [];
        for (const s of strings) {
            const content = s.namedChildren.find(c => c.type === 'string_content');
            for (const part of (content?.text || '').split(',')) if (part.trim()) names.push(part.trim());
        }
        return { kind: 'parametrize', names };
    }
    return { kind: qualified ? 'outside' : 'other' };
}

function paramsOf(fn, isMethod) {
    const out = [];
    const params = fn.childForFieldName('parameters');
    let index = 0;
    for (const param of params?.namedChildren || []) {
        const position = index++;
        if (param.type === 'comment') { index--; continue; }
        let nameNode = null;
        let hasDefault = false;
        if (param.type === 'identifier') nameNode = param;
        else if (param.type === 'typed_parameter') nameNode = param.namedChildren.find(c => c.type === 'identifier') || null;
        else if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
            nameNode = param.childForFieldName('name');
            hasDefault = true;
        }
        if (!nameNode || nameNode.type !== 'identifier') continue;
        if (isMethod && position === 0) continue; // self / cls
        out.push({ name: nameNode.text, node: nameNode, hasDefault });
    }
    return out;
}

/**
 * Functions a module declares where pytest looks for tests and fixtures:
 * module scope and class bodies (through compound statements), never
 * nested functions. Memoized per file entry.
 */
const moduleMemo = new WeakMap();
function moduleFunctions(index, file) {
    const entry = index.files.get(file);
    if (!entry || entry.language !== 'python') return null;
    let memo = moduleMemo.get(entry);
    if (memo) return memo;
    let tree;
    try { tree = index._getParsedTree(file, index._readFile(file), 'python'); } catch { tree = null; }
    if (!tree) return null;
    const functions = [];
    const classes = [];
    // Module-scope bindings of each name that are not plain defs.
    const otherBindings = new Map();
    let starImport = false;
    const noteOther = (name, node, kind) => {
        if (!otherBindings.has(name)) otherBindings.set(name, []);
        otherBindings.get(name).push({ node, kind });
    };
    const addTargets = (target, node) => {
        if (!target) return;
        if (target.type === 'identifier') { noteOther(target.text, node, 'assignment'); return; }
        for (const child of target.namedChildren || []) addTargets(child, node);
    };
    const visit = (container, owner) => {
        for (const child of container.namedChildren) {
            const definition = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
            const decorators = child.type === 'decorated_definition'
                ? child.namedChildren.filter(c => c.type === 'decorator') : [];
            if (definition?.type === 'function_definition') {
                const kinds = decorators.map(d => decoratorOf(index, file, d));
                const fixture = kinds.find(k => k.kind === 'fixture');
                functions.push({
                    node: definition, outer: child, name: definition.childForFieldName('name')?.text,
                    owner, kinds, fixture: fixture || null,
                    fixtureName: fixture ? (fixture.dynamicName ? null : fixture.alias || definition.childForFieldName('name')?.text) : null,
                    params: paramsOf(definition, !!owner),
                });
                continue;
            }
            if (definition?.type === 'class_definition') {
                const record = {
                    node: definition, name: definition.childForFieldName('name')?.text, owner,
                    bases: (definition.childForFieldName('superclasses')?.namedChildren || [])
                        .filter(c => c.type !== 'keyword_argument' && c.type !== 'comment'),
                    kinds: decorators.map(d => decoratorOf(index, file, d)),
                };
                classes.push(record);
                if (!owner) noteOther(record.name, definition, 'class');
                const body = definition.childForFieldName('body');
                if (body) visit(body, record);
                continue;
            }
            if (!owner) {
                if (child.type === 'import_from_statement' || child.type === 'import_statement') {
                    if (child.namedChildren.some(c => c.type === 'wildcard_import')) starImport = true;
                    const moduleName = child.childForFieldName('module_name');
                    for (const part of child.namedChildren) {
                        if (moduleName && sameNode(part, moduleName)) continue;
                        const local = part.type === 'aliased_import' ? part.childForFieldName('alias')
                            : part.type === 'dotted_name' ? part.namedChild(child.type === 'import_statement' ? 0 : part.namedChildCount - 1) : null;
                        if (local) noteOther(local.text, child, 'import');
                    }
                    continue;
                }
                if (child.type === 'expression_statement') {
                    for (const expression of child.namedChildren) {
                        if (expression.type === 'assignment' || expression.type === 'augmented_assignment') {
                            addTargets(expression.childForFieldName('left'), child);
                        }
                    }
                    continue;
                }
            } else if (child.type === 'expression_statement') {
                for (const expression of child.namedChildren) {
                    if (expression.type === 'assignment' || expression.type === 'augmented_assignment') {
                        const target = expression.childForFieldName('left');
                        if (target?.type === 'identifier') {
                            (owner.assigned || (owner.assigned = new Set())).add(target.text);
                        }
                    }
                }
                continue;
            }
            if (PY_COMPOUNDS.has(child.type)) visit(child, owner);
        }
    };
    visit(tree.rootNode, null);
    memo = { tree, functions, classes, otherBindings, starImport };
    moduleMemo.set(entry, memo);
    return memo;
}

/** Whether `fn` asks pytest for fixtures: a fixture, or a test pytest collects. */
function requestsFixtures(file, fn) {
    if (fn.fixture) return true;
    if (!isTestModule(file) || !fn.name?.startsWith('test')) return false;
    for (let owner = fn.owner; owner; owner = owner.owner) {
        if (!owner.name?.startsWith('Test')) return false;
    }
    return true;
}

/**
 * Which fixture definition a request for `name` from `fn` (declared in
 * `file`) receives: { def: {file, node} } for a resolved fixture function,
 * { none: true } when no project fixture of that name is in scope (plugins,
 * built-ins), or { unknown: reason }.
 */
function resolveRequest(index, file, fn, name, pinned) {
    const self = fn.fixture && fn.fixtureName === name;
    // Class fixtures: the requester's enclosing classes, innermost first.
    for (let owner = fn.owner; owner; owner = owner.owner) {
        const own = moduleFunctions(index, file).functions.filter(other => other.owner === owner &&
            other.fixtureName === name && !(self && sameNode(other.node, fn.node)));
        if (own.length > 0) return own.length === 1 ? { def: { file, node: own[0].node } } : { unknown: 'class-fixtures' };
        if (owner.assigned?.has(name)) return { unknown: 'class-binding' };
        if (owner.bases.some(base => base.text !== 'object')) return { unknown: 'class-bases' };
    }
    return resolveModuleLevel(index, file, name, self ? fn : null, pinned);
}

function resolveModuleLevel(index, file, name, skipFn, pinned) {
    const root = index.root;
    // The module itself, then conftest.py upward from its directory (from the
    // parent directory for a conftest's own requests).
    const chain = [file];
    let dir = path.dirname(file);
    if (isConftest(file)) dir = dir === root ? null : path.dirname(dir);
    for (; dir && (dir === root || dir.startsWith(root + path.sep)); dir = dir === root ? null : path.dirname(dir)) {
        const conftest = path.join(dir, 'conftest.py');
        if (conftest !== file && index.files.has(conftest)) chain.push(conftest);
    }
    for (const current of chain) {
        const module = moduleFunctions(index, current);
        if (!module) return { unknown: 'unreadable' };
        const defs = module.functions.filter(fn => !fn.owner && fn.fixtureName === name &&
            !(skipFn && current === file && sameNode(fn.node, skipFn.node)));
        const dynamic = module.functions.some(fn => !fn.owner && fn.fixture?.dynamicName);
        const others = module.otherBindings.get(name) || [];
        if (defs.length === 0 && others.length === 0) {
            if (module.starImport || dynamic) return { unknown: 'module-namespace' };
            continue;
        }
        if (defs.length > 1 || others.some(other => other.kind !== 'import')) return { unknown: 'module-binding' };
        if (defs.length === 1 && others.length === 0) return { def: { file: current, node: defs[0].node } };
        // An import of the name: the fixture it binds, when it is the pinned
        // definition itself (renamed with it); anything else is undecided.
        if (defs.length === 0 && others.length === 1 && importReachesPinned(index, current, name, pinned)) {
            return { def: { file: pinned.file, node: null, viaImport: current } };
        }
        return { unknown: 'module-import' };
    }
    return { none: true };
}

/** A `from m import name` binding of a module that resolves to the pinned def. */
function importReachesPinned(index, file, name, pinned) {
    const entry = index.files.get(file);
    const bindings = (entry?.importBindings || []).filter(b => (b.alias || b.name) === name);
    if (bindings.length !== 1 || bindings[0].alias || bindings[0].name !== name) return false;
    const relative = entry.moduleResolved?.[bindings[0].module];
    return !!relative && path.resolve(index.root, relative) === pinned.file;
}

/** Whether an identifier is a parameter name (not a default value). */
function isParameterName(node) {
    let current = node;
    let parent = current.parent;
    if (parent?.type === 'list_splat_pattern' || parent?.type === 'dictionary_splat_pattern') {
        current = parent;
        parent = current.parent;
    }
    if (!parent) return false;
    if (parent.type === 'parameters' || parent.type === 'lambda_parameters') return true;
    if (parent.type === 'typed_parameter') return sameNode(parent.namedChild(0), current);
    if (parent.type === 'default_parameter' || parent.type === 'typed_default_parameter') {
        return sameNode(parent.childForFieldName('name'), current);
    }
    return false;
}

/** Identifier tokens in `fn` that bind its parameter `name` (scope-exact). */
function parameterTokens(fn, param, name) {
    const { referenceScopeNode } = require('../languages/lexical-scope');
    const tokens = [param.node];
    const body = fn.node.childForFieldName('body');
    const stack = body ? [body] : [];
    const memo = new Map();
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === 'identifier' && node.text === name) {
            // A nested function's or lambda's own parameter binds there.
            if (isParameterName(node)) continue;
            const scope = referenceScopeNode(node, name, memo);
            if (scope && sameNode(scope, fn.node)) tokens.push(node);
            continue;
        }
        for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
    }
    return tokens;
}

/**
 * The parameter sites of a fixture rename. `def` is the pinned fixture
 * function. Returns null when `def` is not a pytest fixture named by its
 * function name; otherwise { edits: [{file, line, byteColumns}], reviews:
 * [{file, line, reason}], plugin: bool }.
 */
function fixtureParameterSites(index, def) {
    const entry = index.files.get(def.file);
    if (entry?.language !== 'python') return null;
    const pinnedModule = moduleFunctions(index, def.file);
    const pinnedFn = pinnedModule?.functions.find(fn => fn.name === def.name &&
        fn.node.childForFieldName('name')?.startPosition.row + 1 === (def.nameLine || def.startLine));
    if (!pinnedFn?.fixture) return null;
    if (pinnedFn.fixture.dynamicName) return { dynamic: true, edits: [], reviews: [] };
    // `@pytest.fixture(name="other")`: the function name is not the fixture's.
    if (pinnedFn.fixtureName !== def.name) return { edits: [], reviews: [], aliased: true };
    const name = def.name;
    const pinned = { file: def.file, node: pinnedFn.node };
    const isPinned = resolved => resolved.def && resolved.def.file === pinned.file &&
        (resolved.def.viaImport || (resolved.def.node && sameNode(resolved.def.node, pinned.node)));
    // Files whose requests may reach the fixture: the defining module, every
    // module under a conftest providing it, and modules importing it.
    const scopes = [];
    if (pinnedFn.owner) scopes.push({ files: [def.file] });
    else if (isConftest(def.file)) scopes.push({ dir: path.dirname(def.file) });
    else scopes.push({ files: [def.file] });
    const plugin = !pinnedFn.owner && !collected(def.file);
    for (const [file, other] of index.files) {
        if (other.language !== 'python' || file === def.file) continue;
        if (!importReachesPinned(index, file, name, pinned)) continue;
        scopes.push(isConftest(file) ? { dir: path.dirname(file) } : { files: [file] });
    }
    // A fixture outside conftest.py and test modules is registered as a
    // plugin: any request pytest resolves past every project fixture of the
    // name may receive it.
    if (plugin) scopes.push({ dir: index.root });
    const candidates = new Set();
    for (const scope of scopes) {
        if (scope.files) for (const file of scope.files) candidates.add(file);
        else {
            const prefix = scope.dir === index.root ? '' : scope.dir + path.sep;
            for (const [file, other] of index.files) {
                if (other.language === 'python' && (!prefix || file.startsWith(prefix))) candidates.add(file);
            }
        }
    }
    const edits = [];
    const reviews = [];
    for (const file of [...candidates].sort()) {
        let content;
        try { content = index._readFile(file); } catch { continue; }
        if (!content.includes(name) || !declaresParameter(index.files.get(file), name)) continue;
        const module = moduleFunctions(index, file);
        if (!module) continue;
        for (const fn of module.functions) {
            const param = fn.params.find(p => p.name === name);
            if (!param || param.hasDefault) continue;
            if (!requestsFixtures(file, fn)) {
                // A test-named function or fixture-shaped request pytest does
                // not collect by default may still be collected by
                // configuration or imported into a test module.
                if (!collected(file) && fn.name?.startsWith('test')) {
                    reviews.push({ file, line: param.node.startPosition.row + 1, reason: 'not-collected' });
                }
                continue;
            }
            const parametrized = [fn, ...ownersOf(fn)].some(item => (item.kinds || []).some(k =>
                k.kind === 'parametrize' && (!k.names || k.names.includes(name))));
            const resolved = resolveRequest(index, file, fn, name, pinned);
            if (resolved.none && plugin) {
                reviews.push({ file, line: param.node.startPosition.row + 1, reason: 'plugin-fixture' });
                continue;
            }
            if (resolved.none || (resolved.def && !isPinned(resolved))) continue;
            if (resolved.unknown || parametrized) {
                reviews.push({ file, line: param.node.startPosition.row + 1,
                    reason: parametrized ? 'parametrized' : resolved.unknown });
                continue;
            }
            const byLine = new Map();
            for (const token of parameterTokens(fn, param, name)) {
                const line = token.startPosition.row + 1;
                if (!byLine.has(line)) byLine.set(line, []);
                byLine.get(line).push(token.startPosition.column);
            }
            for (const [line, byteColumns] of byLine) edits.push({ file, line, byteColumns });
        }
    }
    return { edits, reviews, plugin };
}

/** Whether an indexed function of the module may take a parameter `name` (skips the parse). */
function declaresParameter(entry, name) {
    return (entry?.symbols || []).some(symbol => Array.isArray(symbol.paramsStructured)
        ? symbol.paramsStructured.some(param => param.name === name)
        : typeof symbol.params === 'string' && symbol.params.includes(name));
}

function ownersOf(fn) {
    const out = [];
    for (let owner = fn.owner; owner; owner = owner.owner) out.push(owner);
    return out;
}

module.exports = { fixtureParameterSites };
