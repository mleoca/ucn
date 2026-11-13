'use strict';

/**
 * The class a constructor expression makes an instance of.
 *
 * `Name(...)` where classes are called and `new Name(...)` construct the
 * class the name denotes where it is written. The lookup is the one behind
 * constructor callers (core/provenance-type.js): the scopes around the site,
 * the module's own bindings, then what the module imports, by local name.
 * A receiver made by such an expression has that class, whichever same-named
 * classes the project declares elsewhere.
 *
 * Answers of `constructedClass`:
 *   { definition }    the one class definition the name denotes
 *   { unread: true }  nothing this lookup reads: the file binds the name
 *                     nowhere (a global of another script, a builtin), no
 *                     project class is spelled that way, or the name is a
 *                     function that owns prototype members. The caller's
 *                     own rules decide.
 *   null              the file binds the name and the lookup does not settle
 *                     on one class: a parameter, a function, a rebound or
 *                     conditionally bound name
 */

const { langTraits } = require('../languages');

const CLASS_KINDS = new Set(['class', 'struct', 'record', 'enum']);

const familyOf = (index, def) => {
    const language = index.files.get(def.file)?.language;
    return langTraits(language)?.nameReferenceFamily || language;
};

/** Import bindings whose local name is `name`. */
function localImportBindings(entry, name) {
    return (entry?.importBindings || []).filter(binding =>
        (binding.alias || binding.name) === name && binding.name !== '*');
}

/** The file binds `name` at module scope by some statement of its own. */
function boundInModule(entry, name) {
    if (!entry) return false;
    if (localImportBindings(entry, name).length > 0) return true;
    if ((entry.moduleAssignedNames || []).includes(name)) return true;
    if ((entry.moduleValueAliases || []).some(alias => alias.name === name)) return true;
    if ((entry.configurationItems || []).some(item => item.scope === 0 && item.name === name)) return true;
    return (entry.symbols || []).some(def => def.name === name && !def.className &&
        def.lexicalScopeStartLine == null);
}

/**
 * The construction record a constructor-typed receiver was made by: the
 * call of the receiver's type name inside the span its type was read from
 * (`u = User(..)`, `new User(..).m()`). Null when no single record is there.
 */
function constructionRecordOf(index, file, call) {
    const evidence = call.receiverTypeEvidence;
    if (!evidence || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end)) return null;
    // The name as written: an alias already followed keeps its spelling.
    const spelled = call.receiverTypeAlias || evidence.type || call.receiverType;
    const found = [];
    for (const record of index.getCachedCalls(file) || []) {
        if (record.line < evidence.line) continue;
        const start = record.callSite?.start;
        if (!Number.isInteger(start) || start < evidence.start || start >= evidence.end) continue;
        if (record.name !== spelled) continue;
        found.push(record);
    }
    return found.length === 1 ? found[0] : null;
}

function constructedClass(index, file, record) {
    if (!record || typeof record !== 'object') return null;
    const memo = index._opMemo?.('constructedClass', () => new WeakMap());
    if (memo?.has(record)) return memo.get(record);
    const result = constructedClassUncached(index, file, record);
    memo?.set(record, result);
    return result;
}

/**
 * A function that owns prototype members (`function Gadget() {}` with
 * `Gadget.prototype.render = ..`) is a class in all but syntax. Whether the
 * file's binding of `name` is such a function: declared here, or the one
 * import of the name resolves to the file declaring it.
 */
function bindsConstructorFunction(index, entry, file, name) {
    const declaredIn = (target, declared) => (index.symbols.get(declared) || []).some(def =>
        def.type === 'function' && def.file === target && !def.className &&
        (index.files.get(target)?.symbols || []).some(member => member.className === declared));
    if (declaredIn(file, name)) return true;
    const bindings = localImportBindings(entry, name);
    if (bindings.length !== 1) return false;
    const relative = entry.moduleResolved?.[bindings[0].module];
    return !!relative && declaredIn(require('path').resolve(index.root, relative), bindings[0].name);
}

/**
 * The one import that binds a name for the scope a reference reads it in,
 * where a file imports the name more than once in different scopes (`from
 * a import Name` at module level, `from b import Name` inside a function):
 * the function's own import when the nearest function scope binding the
 * name binds it by that statement alone, the module's one import when the
 * reference resolves at module scope. Null when the scope's binding is not
 * one import statement.
 */
function scopeImportTarget(index, file, entry, record) {
    const start = record.callSite?.start;
    if (!Number.isInteger(start)) return null;
    const scopes = require('../languages/lexical-scope');
    if (scopes.familyOf(entry.language) !== 'python') return null;
    return withTree(index, file, tree => {
        const node = tree.rootNode.descendantForIndex(start);
        if (!node || node.text !== record.name) return null;
        let statement = scopes.localImportStatement(node, entry.language, record.name);
        if (!statement && scopes.referenceScope(node, entry.language, new Map(), record.name,
            { includeClasses: true }) === 'module') {
            const sites = scopes.pythonScopeBindingKinds(tree.rootNode, record.name);
            if (sites.length !== 1 || sites[0].kind !== 'import') return null;
            statement = sites[0].node;
            while (statement && statement.type !== 'import_statement' &&
                statement.type !== 'import_from_statement') statement = statement.parent;
        }
        if (!statement) return null;
        const first = statement.startPosition.row + 1, last = statement.endPosition.row + 1;
        const bindings = localImportBindings(entry, record.name).filter(binding =>
            binding.line >= first && binding.line <= last && binding.kind !== 'import');
        if (bindings.length !== 1) return null;
        const relative = entry.moduleResolved?.[bindings[0].module];
        return relative ? { file: require('path').resolve(index.root, relative), name: bindings[0].name } : null;
    }) || null;
}

function constructedClassUncached(index, file, record) {
    const entry = index.files.get(file);
    const language = entry?.language;
    const traits = langTraits(language);
    if (!traits?.hasConstructors) return null;
    const { isConstruction, constructionTypeCandidates } = require('./constructor-calls');
    if (!isConstruction(record, null, language)) return null;
    // `self.Widget()` and `factory.Widget()` read an attribute of a value;
    // only a module's attribute is a name the module binds.
    if (record.isMethod && !record.receiverIsModule) return null;
    const qualifier = record.isMethod ? record.receiver || null : null;
    // `m.User()` where a parameter or local is named `m`: no module's attribute.
    if (qualifier && record.receiverLocalBinding) return null;
    if (qualifier && qualifiedBindingChanged(index, file, record, qualifier)) return null;
    const name = record.name;
    const family = traits.nameReferenceFamily || language;
    const candidates = constructionTypeCandidates(index, name).filter(def =>
        CLASS_KINDS.has(def.type) && def.file && familyOf(index, def) === family);
    if (candidates.length === 0) return { unread: true };
    const bound = qualifier ? true : !!record.localShadow || boundInModule(entry, name);
    if (!bound) return { unread: true };
    const { occurrenceIdentity } = require('./provenance-facts');
    const { captureTypeLookup } = require('./provenance-type');
    const site = occurrenceIdentity(entry.relativePath, record);
    const query = { file, relativePath: site.file, line: site.line, column: site.column,
        name, qualifier, localShadow: !!record.localShadow, construction: true, functional: false, identity: true };
    const found = [];
    for (const owner of candidates) {
        if (captureTypeLookup(index, query, owner)) found.push(owner);
    }
    // A Python package may expose its classes through a star export. The
    // module-name reader retains that closure as evidence; it still has to
    // select one class and pass the same construction-result proof.
    if (found.length === 0 && qualifier && traits.nameReferenceFamily === 'python') {
        const { pythonModulePath, pythonModuleScope, pythonModuleTypes } = require('./python-modules');
        const modules = pythonModulePath(index, file, qualifier);
        if (modules && !modules.unknown && pythonModuleScope(index, file, qualifier, record.callSite)) {
            for (const module of modules.files) {
                for (const def of pythonModuleTypes(index, module, name, candidates)) {
                    if (!found.includes(def)) found.push(def);
                }
            }
        }
    }
    if (found.length === 1) return constructionKeepsClass(index, found[0]) ? { definition: found[0] } : null;
    // Several imports of the name in different scopes: the one of the scope
    // the reference reads it in decides.
    if (!qualifier && !record.localShadow && localImportBindings(entry, name).length > 1 &&
        !(entry.moduleAssignedNames || []).includes(name)) {
        const imported = scopeImportTarget(index, file, entry, record);
        if (imported) {
            const reached = constructionTypeCandidates(index, imported.name).filter(def =>
                CLASS_KINDS.has(def.type) && def.file && familyOf(index, def) === family &&
                captureTypeLookup(index, { file: imported.file, line: 1, name: imported.name,
                    construction: true, identity: true }, def));
            return reached.length === 1 && constructionKeepsClass(index, reached[0])
                ? { definition: reached[0] } : null;
        }
    }
    if (found.length === 0 && !qualifier && !record.localShadow &&
        bindsConstructorFunction(index, entry, file, name)) return { unread: true };
    return null;
}

// ── What calling the class returns ──────────────────────────────────────

const FUNCTION_NODES = new Set(['function_definition', 'function_declaration', 'function_expression',
    'function', 'arrow_function', 'generator_function', 'generator_function_declaration', 'method_definition',
    'lambda', 'class_definition', 'class_declaration', 'class', 'class_body']);

/** The parsed tree of a file for one read; `done()` frees a tree parsed here. */
function withTree(index, file, read) {
    const entry = index.files.get(file);
    if (!entry) return undefined;
    const { getParser, safeParse } = require('../languages');
    let owned;
    try {
        const content = index._readFile(file);
        const tree = index._getParsedTree?.(file, content, entry.language) ||
            (owned = safeParse(getParser(entry.language), content));
        return tree ? read(tree, content) : undefined;
    } catch {
        return undefined;
    } finally {
        owned?.delete?.();
    }
}

/** Pure syntax facts are shared only within an operation and one actual
 * tree. A fallback parse may be deleted at withTree's exit; a later parse
 * has a different tree key and can never return its nodes. */
function syntaxFact(index, node, kind, read) {
    const memo = node?.tree && index?._opMemo?.('constructedSyntaxFacts', () => new WeakMap());
    if (!memo) return read();
    let facts = memo.get(node.tree);
    if (!facts) { facts = new Map(); memo.set(node.tree, facts); }
    const key = `${node.id}\0${kind}`;
    if (facts.has(key)) return facts.get(key);
    const value = read();
    facts.set(key, value);
    return value;
}

/** `return` statements of a function's own body (not of functions and classes nested in it). */
function ownReturns(body, index = null) {
    return syntaxFact(index, body, 'returns', () => ownReturnsUncached(body));
}

function ownReturnsUncached(body) {
    const out = [];
    const stack = body ? [...body.namedChildren] : [];
    while (stack.length > 0) {
        const node = stack.pop();
        if (FUNCTION_NODES.has(node.type)) continue;
        if (node.type === 'return_statement') { out.push(node); continue; }
        for (const child of node.namedChildren) stack.push(child);
    }
    return out;
}

/** The function node whose declaration starts at a symbol's source span. */
function functionNodeOf(tree, def) {
    const start = def.sourceSpan?.start;
    if (!Number.isInteger(start)) return null;
    let node = tree.rootNode.descendantForIndex(start);
    while (node && !['function_definition', 'function_declaration', 'generator_function_declaration',
        'method_definition', 'decorated_definition'].includes(node.type)) node = node.parent;
    if (node?.type === 'decorated_definition') node = node.childForFieldName('definition');
    if (!node || node.startPosition.row + 1 > def.endLine || node.endPosition.row + 1 < def.startLine) return null;
    return node;
}

function firstParameterName(fn) {
    const parameters = fn.childForFieldName('parameters');
    let first = parameters?.namedChild(0);
    while (first && first.type !== 'identifier') {
        first = first.childForFieldName('pattern') || first.childForFieldName('name') ||
            first.namedChildren.find(child => child.type === 'identifier') || null;
    }
    return first?.text || null;
}

const FUNCTION_DEFINITIONS = new Set(['function_definition', 'function_declaration',
    'generator_function_declaration']);
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'lambda']);

/**
 * The function a name denotes for code in `scope`: declared in its body,
 * else at the top of the file. The last declaration of the name is the one
 * bound when the code runs (typing overload stubs come before the body).
 */
function functionNamed(tree, scope, name) {
    const declaredIn = statements => {
        let found = null;
        for (let statement of statements || []) {
            if (statement.type === 'decorated_definition') statement = statement.childForFieldName('definition');
            if (statement.type === 'export_statement') statement = statement.childForFieldName('declaration') || statement;
            if (FUNCTION_DEFINITIONS.has(statement?.type) && statement.childForFieldName('name')?.text === name) found = statement;
            if (statement?.type === 'lexical_declaration' || statement?.type === 'variable_declaration') {
                for (const declarator of statement.namedChildren) {
                    const value = declarator.childForFieldName?.('value');
                    if (declarator.childForFieldName?.('name')?.text === name && FUNCTION_VALUES.has(value?.type)) found = value;
                }
            }
        }
        return found;
    };
    if (scope?.type === 'function_definition') {
        const bindings = require('../languages/lexical-scope').pythonScopeBindingKinds(scope, name);
        if (bindings.some(binding => binding.kind !== 'def')) return null;
    }
    const local = declaredIn(scope?.childForFieldName('body')?.namedChildren);
    if (local) return local;
    if (tree.rootNode.type === 'module') {
        const bindings = require('../languages/lexical-scope').pythonScopeBindingKinds(tree.rootNode, name);
        if (bindings.some(binding => binding.kind !== 'def')) return null;
    }
    return declaredIn(tree.rootNode.namedChildren);
}

/**
 * Whether a decorator function hands back the class it is given. Every
 * `return` of its own body has to be one of: its first parameter; a call
 * of a keeping function that passes that parameter first, or passes no
 * positional argument at all (a keeping decorator asked for with options);
 * a function that keeps its own first parameter, by name, written in place
 * or wrapped in `partial(..)` (the decorator used with arguments). A
 * function without a `return` keeps the class only where a decorator may
 * return nothing.
 */
function ownNodes(body, index = null) {
    return syntaxFact(index, body, 'nodes', () => ownNodesUncached(body));
}

function ownNodesUncached(body) {
    if (!body) return [];
    // Only these node kinds can affect the identity proofs below. Ask the
    // native tree for them in one traversal rather than materializing every
    // literal, argument list and identifier through namedChildren.
    const kinds = ['assignment', 'assignment_expression', 'variable_declarator', 'augmented_assignment',
        'augmented_assignment_expression', 'named_expression', 'for_in_clause', 'delete_statement',
        'call', 'call_expression', 'attribute', ...FUNCTION_NODES];
    const roots = [], open = [];
    let skippedUntil = -1;
    for (const node of body.descendantsOfType(kinds)) {
        if (node.id === body.id) continue; // the old walk starts at body's children
        const start = node.startIndex, end = node.endIndex;
        if (start < skippedUntil) continue;
        if (FUNCTION_NODES.has(node.type)) { skippedUntil = end; continue; }
        while (open.length && !(start >= open.at(-1).start && end <= open.at(-1).end)) open.pop();
        const item = { node, start, end, children: [] };
        (open.at(-1)?.children || roots).push(item);
        open.push(item);
    }
    // Retain the old reverse-sibling, parent-before-child order, including
    // when irrelevant container nodes lay between two selected nodes.
    const result = [], stack = [...roots];
    while (stack.length) {
        const item = stack.pop();
        result.push(item.node);
        stack.push(...item.children);
    }
    return result;
}

function qualifiedBindingChanged(index, file, record, qualifier) {
    const memo = index._opMemo?.('constructedNamespaceWrites', () => new Map());
    const key = `${file}\0${qualifier}\0${record.name}`;
    if (memo?.has(key)) return memo.get(key);
    const root = qualifier.split('.')[0];
    const entry = index.files.get(file);
    if ((entry.moduleAssignedNames || []).includes(root)) return true;
    const result = withTree(index, file, (tree, content) => {
        const scopes = require('../languages/lexical-scope');
        const scopeMemo = new Map();
        const writtenPath = node => {
            if (node?.type === 'identifier') return { text: node.text, root: node };
            if (!['attribute', 'member_expression', 'subscript', 'subscript_expression'].includes(node?.type)) return null;
            const object = writtenPath(node.childForFieldName('object') || node.childForFieldName('value'));
            const member = node.childForFieldName('attribute') || node.childForFieldName('property');
            const key = member?.text || literalMember(node.childForFieldName('subscript') || node.childForFieldName('index'));
            return object ? { text: key ? `${object.text}.${key}` : object.text, root: object.root } : null;
        };
        const wanted = `${qualifier}.${record.name}`;
        // Only these two Python calls can write a named attribute. Text is
        // a prefilter; the same AST call/name/argument checks still decide.
        const kinds = ['assignment', 'augmented_assignment', 'assignment_expression',
            'augmented_assignment_expression', 'delete_statement', 'unary_expression'];
        if (content.includes('setattr') || content.includes('delattr')) kinds.push('call');
        for (const node of tree.rootNode.descendantsOfType(kinds)) {
            const target = node.childForFieldName('left') || node.childForFieldName('argument') ||
                (node.type === 'delete_statement' ? node.namedChild(0) : null);
            let written = writtenPath(target);
            if (node.type === 'call') {
                const fn = node.childForFieldName('function');
                const args = node.childForFieldName('arguments')?.namedChildren || [];
                if (fn?.type === 'identifier' && ['setattr', 'delattr'].includes(fn.text)) {
                    written = writtenPath(args[0]);
                    const member = literalMember(args[1]);
                    if (written && member) written = { ...written, text: `${written.text}.${member}` };
                }
            }
            if (!written || !(written.text === wanted || wanted.startsWith(`${written.text}.`))) continue;
            const scope = scopes.referenceScope(written.root, entry.language, scopeMemo, root);
            if (scope === 'module' || !(scope && typeof scope === 'object' && scope.local)) return true;
        }
        return false;
    }) !== false;
    memo?.set(key, result);
    return result;
}

function literalMember(node) {
    if (node?.type !== 'string') return null;
    const value = require('../languages/utils').extractStringArg(node);
    return value && !value.interp && !value.value.includes('\\') ? value.value : null;
}

/** The last own method is the method a Python class binds under its name. */
function ownHelper(fn, name) {
    let owner = fn.parent;
    while (owner && owner.type !== 'class_definition') owner = owner.parent;
    return owner?.childForFieldName('body')?.namedChildren.map(node => node.type === 'decorated_definition'
        ? node.childForFieldName('definition') : node).filter(node => node?.childForFieldName('name')?.text === name).at(-1);
}

/** Read only Python's proven builtin property descriptor composition. A
 * custom decorator, rebound property name, or non-adjacent replacement is
 * not a body we can invoke as an ordinary getter or setter. */
function propertyDescriptor(index, file, fn, depth = 0) {
    return syntaxFact(index, fn, `property:${file}:${depth}`, () => propertyDescriptorUncached(index, file, fn, depth));
}

function propertyDescriptorUncached(index, file, fn, depth) {
    if (!fn || depth > 4 || fn.parent?.type !== 'decorated_definition') return null;
    const wrapper = fn.parent;
    const decorators = wrapper.namedChildren.filter(node => node.type === 'decorator');
    if (decorators.length !== 1) return null;
    const head = decorators[0].namedChild(0);
    const entry = index.files.get(file);
    if (head?.type === 'identifier') {
        const bindings = localImportBindings(entry, head.text);
        const builtin = head.text === 'property' && !boundInModule(entry, head.text);
        const imported = bindings.length === 1 && bindings[0].module === 'builtins' &&
            bindings[0].name === 'property' && !entry.moduleResolved?.builtins &&
            !(entry.moduleAssignedNames || []).includes(head.text);
        const scope = require('../languages/lexical-scope').referenceScope(head, entry.language,
            new Map(), head.text, { includeClasses: true });
        return (builtin || imported) && scope === 'module' ? { get: fn } : null;
    }
    if (head?.type !== 'attribute') return null;
    const object = head.childForFieldName('object');
    const slot = head.childForFieldName('attribute')?.text;
    const name = fn.childForFieldName('name')?.text;
    if (object?.type !== 'identifier' || object.text !== name || !['getter', 'setter', 'deleter'].includes(slot)) return null;
    const siblings = wrapper.parent?.namedChildren.filter(node => node.type !== 'comment') || [];
    const { sameNode } = require('../languages/utils');
    const position = siblings.findIndex(node => sameNode(node, wrapper));
    const previous = position > 0 ? siblings[position - 1] : null;
    const priorFunction = previous?.type === 'decorated_definition' ? previous.childForFieldName('definition') : null;
    if (priorFunction?.childForFieldName('name')?.text !== name) return null;
    const prior = propertyDescriptor(index, file, priorFunction, depth + 1);
    return prior ? { ...prior, [slot === 'getter' ? 'get' : slot === 'setter' ? 'set' : 'delete']: fn } : null;
}

/** Resolve every self use from the constructed class, including a base
 * initializer's call of a descendant override. The callback consumes AST
 * nodes before a separately parsed declaring file is released. */
function instanceMember(context, fn, name, read) {
    if (!context?.definition) {
        const helper = fn && ownHelper(fn, name);
        return read(helper && helper.parent?.type !== 'decorated_definition' ? { method: helper } :
            helper ? { unknown: true } : { data: true }, null, context);
    }
    const { index, definition } = context;
    const selected = instanceMemberSelection(index, definition, name);
    if (!selected.member) return read(selected, null, context);
    const { member, instanceShadow } = selected;
    return withTree(index, member.file, tree => {
        const node = functionNodeOf(tree, member);
        const next = { ...context, file: member.file };
        if (!node) return read({ unknown: true }, tree, next);
        const property = propertyDescriptor(index, member.file, node);
        if (property) return read(property, tree, next);
        if (node.parent?.type === 'decorated_definition') {
            return read({ unknown: true }, tree, next);
        }
        return read({ method: node, instanceShadow }, tree, next);
    });
}

/** Symbol-only lookup facts live for this operation. In particular, do not
 * rebuild a filtered definitions array for every self read: member lookup
 * memoizes by that array's identity. No parsed nodes are retained here. */
function instanceMemberSelection(index, definition, name) {
    const memo = index._opMemo?.('constructedInstanceMembers', () => new WeakMap());
    let byName = memo?.get(definition);
    if (byName?.has(name)) return byName.get(name);
    const result = instanceMemberSelectionUncached(index, definition, name);
    if (memo) {
        if (!byName) { byName = new Map(); memo.set(definition, byName); }
        byName.set(name, result);
    }
    return result;
}

function instanceMemberSelectionUncached(index, definition, name) {
    const { classDefsNamed, findDeclaringClass, ownedBy } = require('./class-identity');
    const key = classDefsNamed(index, definition.name).entries.find(entry => entry.def === definition)?.key;
    const candidates = index.symbols.get(name) || [];
    const ancestry = constructionAncestry(index, definition);
    // Instance storage cannot hide a data descriptor inherited from a base.
    // A bare annotation also creates no class binding at runtime.
    // Read syntax only for possible owners; the same identity lookup would
    // discard definite nonowners, including module values of this name.
    const found = findDeclaringClass(index, { name: definition.name, def: definition, key }, candidates.filter(member =>
        !member.instanceAttribute && (!ancestry?.length || ancestry.some(ref => ownedBy(index, member, ref) !== 'no')) &&
        classMemberKind(index, member) !== 'annotation'));
    if (!found?.members.length) return { data: true };
    if (found.uncertain) return { unknown: true };
    const declared = found.members.filter(member => !member.instanceAttribute)
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    const member = declared.at(-1);
    if (!member) return { data: true };
    if (!dispatchMember(member)) return classMemberKind(index, member) === 'data' ? { data: true } : { unknown: true };
    const instanceShadow = (ancestry || []).some(ref => candidates.some(item =>
        item.instanceAttribute && item.file === ref.def.file && item.className === ref.def.name &&
        item.startLine >= ref.def.startLine && item.endLine <= ref.def.endLine));
    return { member, instanceShadow };
}

function classMemberKind(index, member) {
    if (dispatchMember(member)) return 'method';
    const memo = index._opMemo?.('constructedClassFields', () => new WeakMap());
    if (memo?.has(member)) return memo.get(member);
    const kind = withTree(index, member.file, tree => {
        const assignments = tree.rootNode.descendantsOfType('assignment').filter(node =>
            node.startPosition.row + 1 === member.startLine && node.childForFieldName('left')?.text === member.name);
        // Field records do not yet carry a byte span. Several assignments
        // of this name on one line cannot be selected by the line alone.
        if (assignments.length !== 1) return 'unknown';
        const value = assignments[0].childForFieldName('right');
        if (!value) return 'annotation';
        return ['integer', 'float', 'string', 'true', 'false', 'none', 'list', 'dictionary', 'set', 'tuple',
            'list_comprehension', 'dictionary_comprehension', 'set_comprehension'].includes(value.type) ? 'data' : 'unknown';
    }) || 'unknown';
    memo?.set(member, kind);
    return kind;
}

function dispatchMember(member) {
    return !member.instanceAttribute && (member.isMethod || member.params ||
        ['function', 'method', 'constructor', 'property', 'getter', 'setter', 'classmethod', 'staticmethod', 'static'].includes(member.type));
}

function propertyEffect(context, fn, name, operation) {
    return instanceMember(context, fn, name, (descriptor, tree, next) => {
        if (descriptor.unknown) return true;
        if (!descriptor.get && !descriptor.set && !descriptor.delete) return false;
        const body = descriptor[operation];
        if (!body || !next?.index) return true;
        return bodyChangesIdentity(next.index, next.file, tree, body, next.helperSensitive || next.sensitive || new Set(),
            (next.depth || 0) + 1, next.helperSensitive || next.sensitive || new Set(), next.definition, true);
    }) !== false;
}

/** Reading a field or a bound method does not pass the receiver itself.
 * A method result may do so; read its returns before treating it as data.
 * Containers and calls carrying an identity stay escapes when unmodeled. */
function expressionCarriesIdentity(value, aliases, fn, depth = 0, context = null) {
    if (!value) return false;
    if (depth > 4) return true;
    if (value.type === 'identifier') return aliases.has(value.text);
    // A syntax subtree without any alias spelling cannot carry this
    // identity. This only avoids walks; the AST still decides every hit.
    const text = value.text;
    if (![...aliases].some(alias => text.includes(alias))) return false;
    if (value.type === 'keyword_argument') return expressionCarriesIdentity(value.childForFieldName('value'), aliases, fn, depth, context);
    if (['attribute', 'member_expression', 'subscript', 'subscript_expression'].includes(value.type)) {
        const object = value.childForFieldName('object') || value.childForFieldName('value');
        const member = value.childForFieldName('attribute') || value.childForFieldName('property');
        if (!expressionCarriesIdentity(object, aliases, fn, depth, context)) return false;
        if (!member) return true; // an identity's subscription result is unread
        return instanceMember(context, fn, member.text, (descriptor, tree, next) => {
            if (descriptor.unknown) return true;
            if (!descriptor.get) return false;
            if (propertyEffect(next, fn, member.text, 'get')) return true;
            const parameter = firstParameterName(descriptor.get);
            return ownReturns(descriptor.get.childForFieldName('body'), next?.index).some(ret => expressionCarriesIdentity(ret.namedChild(0),
                identityAliases(descriptor.get.childForFieldName('body'), parameter, next?.index), descriptor.get, depth + 1, next));
        }) !== false;
    }
    if (['call', 'call_expression'].includes(value.type)) {
        if ((value.childForFieldName('arguments')?.namedChildren || []).some(arg =>
            expressionCarriesIdentity(arg, aliases, fn, depth, context))) return true;
        const callee = value.childForFieldName('function');
        const object = callee?.childForFieldName('object');
        if (object?.type === 'identifier' && aliases.has(object.text)) {
            const member = callee.childForFieldName('attribute') || callee.childForFieldName('property');
            return instanceMember(context, fn, member?.text, (descriptor, tree, next) => {
                const helper = descriptor.method;
                if (!helper || descriptor.instanceShadow) return true;
                const parameter = firstParameterName(helper);
                return ownReturns(helper.childForFieldName('body'), next?.index).some(ret => expressionCarriesIdentity(ret.namedChild(0),
                    identityAliases(helper.childForFieldName('body'), parameter, next?.index), helper, depth + 1, next));
            }) !== false;
        }
        return false;
    }
    return value.namedChildren.some(child => expressionCarriesIdentity(child, aliases, fn, depth, context));
}

function identityAliases(body, parameter, index = null) {
    return syntaxFact(index, body, `aliases:${parameter}`, () => identityAliasesUncached(body, parameter, index));
}

function identityAliasesUncached(body, parameter, index) {
    const nodes = ownNodes(body, index);
    const aliases = new Set(parameter ? [parameter] : []);
    let grew = true;
    while (grew) {
        grew = false;
        for (const node of nodes) {
            if (!['assignment', 'assignment_expression', 'variable_declarator'].includes(node.type)) continue;
            const left = node.childForFieldName('left') || node.childForFieldName('name');
            let right = node.childForFieldName('right') || node.childForFieldName('value');
            while (right?.type === 'parenthesized_expression') right = right.namedChild(0);
            if (left?.type === 'identifier' && right?.type === 'identifier' && aliases.has(right.text) && !aliases.has(left.text)) {
                aliases.add(left.text); grew = true;
            }
        }
    }
    return aliases;
}

/** Writes to a parameter, or to a lookup/constructor slot on its value,
 * defeat an identity return. Writes to unrelated data attributes do not. */
function identityWrites(body, parameter, sensitive, trackIdentity = true, context = null) {
    const nodes = ownNodes(body, context?.index);
    const aliases = identityAliases(body, parameter, context?.index);
    const fn = body?.parent;
    const writes = new Set();
    let changesValue = false;
    const target = (node, operation = 'set') => {
        if (!node) return;
        if (node.type === 'identifier') { writes.add(node.text); return; }
        const object = node.childForFieldName('object');
        const member = node.childForFieldName('attribute') || node.childForFieldName('property');
        if (object && expressionCarriesIdentity(object, aliases, fn, 0, context) &&
            (!member || sensitive.has(member.text) || propertyEffect(context, fn, member.text, operation))) changesValue = true;
        if (!object) for (const child of node.namedChildren) target(child, operation);
    };
    for (const node of nodes) {
        if (['assignment', 'augmented_assignment', 'assignment_expression', 'augmented_assignment_expression',
            'named_expression', 'for_in_clause'].includes(node.type)) target(node.childForFieldName('left') || node.childForFieldName('name'));
        if (node.type === 'delete_statement') for (const child of node.namedChildren) target(child, 'delete');
        if (['call', 'call_expression'].includes(node.type)) {
            const fn = node.childForFieldName('function');
            const args = node.childForFieldName('arguments')?.namedChildren || [];
            if (fn?.type === 'identifier' && ['setattr', 'delattr'].includes(fn.text) &&
                args[0]?.type === 'identifier' && aliases.has(args[0].text)) {
                const key = literalMember(args[1]);
                if (!key || sensitive.has(key) || propertyEffect(context, body?.parent, key, fn.text === 'delattr' ? 'delete' : 'set')) changesValue = true;
            }
        }
    }
    // A captured identity or one put into a container escapes this proof.
    // Do not make nested-function or container spelling an identity guarantee.
    if (trackIdentity && fn?.type === 'function_definition') {
        const { referenceScopeNode } = require('../languages/lexical-scope');
        const { sameNode } = require('../languages/utils');
        const scopeMemo = new Map();
        for (const nested of body.descendantsOfType([...FUNCTION_NODES])) {
            if (nested.childForFieldName('body')?.descendantsOfType('identifier').some(node => aliases.has(node.text) &&
                sameNode(referenceScopeNode(node, node.text, scopeMemo), fn))) changesValue = true;
        }
    }
    for (const node of nodes) {
        if (!['assignment', 'assignment_expression', 'variable_declarator'].includes(node.type)) continue;
        let value = node.childForFieldName('right') || node.childForFieldName('value');
        while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
        const left = node.childForFieldName('left') || node.childForFieldName('name');
        if (trackIdentity && expressionCarriesIdentity(value, aliases, fn, 0, context) &&
            !(value?.type === 'identifier' && left?.type === 'identifier')) changesValue = true;
    }
    const bindings = fn?.type === 'function_definition' && parameter
        ? require('../languages/lexical-scope').pythonScopeBindingKinds(fn, parameter) : null;
    return { writes, aliases, changesValue: changesValue || writes.has(parameter) || (bindings && bindings.length !== 1) };
}

/** An argument carrying the identity. Wrappers we cannot bind to a helper's
 * parameter are escapes, including splats and containers. */
function identityArgument(call, aliases, fn, context) {
    const args = call.childForFieldName('arguments')?.namedChildren || [];
    const found = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        let value = arg.type === 'keyword_argument' ? arg.childForFieldName('value') : arg;
        while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
        const direct = value?.type === 'identifier' && aliases.has(value.text);
        if (direct || expressionCarriesIdentity(value, aliases, fn, 0, context)) {
            found.push({ index, keyword: arg.type === 'keyword_argument' ? arg.childForFieldName('name')?.text : null,
                unread: !direct });
        }
    }
    return found.length === 0 ? null : found.length === 1 ? found[0] : { unread: true };
}

function argumentNamesFirstParameter(argument, helper) {
    return !argument || (!!helper && !argument.unread && (argument.keyword
        ? argument.keyword === firstParameterName(helper) : argument.index === 0));
}

function builtinReference(context, node) {
    const entry = context?.index?.files.get(context.file);
    return node?.type === 'identifier' && entry && !boundInModule(entry, node.text) &&
        require('../languages/lexical-scope').referenceScope(node, entry.language,
            new Map(), node.text, { includeClasses: true }) === 'module';
}

/** Follow project helpers handed the instance while it is being initialized
 * or entered. Their return value does not matter here; writes to identity do. */
function bodyChangesIdentity(index, file, tree, fn, sensitive, depth = 0, helperSensitive = sensitive, definition = null, provenDescriptor = false) {
    if (!fn || depth > 4 || (!provenDescriptor && fn.parent?.type === 'decorated_definition')) return true;
    const memo = tree && fn.tree && index._opMemo?.('constructedIdentityEffects', () => new WeakMap());
    if (!memo) return bodyChangesIdentityUncached(index, file, tree, fn, sensitive, depth, helperSensitive, definition, provenDescriptor);
    let trees = memo.get(tree);
    if (!trees) { trees = new WeakMap(); memo.set(tree, trees); }
    let definitions = trees.get(fn.tree);
    if (!definitions) { definitions = new Map(); trees.set(fn.tree, definitions); }
    let effects = definitions.get(definition);
    if (!effects) { effects = new Map(); definitions.set(definition, effects); }
    // Both sensitivity sets and the remaining recursion depth affect the
    // answer. Actual subclass identity selects self dispatch in base bodies.
    const key = JSON.stringify([file, fn.id, depth, provenDescriptor,
        [...sensitive].sort(), [...helperSensitive].sort()]);
    if (effects.has(key)) return effects.get(key);
    const value = bodyChangesIdentityUncached(index, file, tree, fn, sensitive, depth, helperSensitive, definition, provenDescriptor);
    effects.set(key, value);
    return value;
}

function bodyChangesIdentityUncached(index, file, tree, fn, sensitive, depth = 0, helperSensitive = sensitive, definition = null, provenDescriptor = false) {
    if (!fn || depth > 4 || (!provenDescriptor && fn.parent?.type === 'decorated_definition')) return true;
    const parameter = firstParameterName(fn);
    const body = fn.childForFieldName('body');
    const context = { index, file, definition, sensitive, helperSensitive, depth };
    const facts = identityWrites(body, parameter, sensitive, true, context);
    if (facts.changesValue) return true;
    for (const call of ownNodes(body, index)) {
        if (call.type === 'attribute' && call.childForFieldName('object')?.type === 'identifier' &&
            facts.aliases.has(call.childForFieldName('object').text)) {
            const { sameNode } = require('../languages/utils');
            const written = ['assignment', 'augmented_assignment'].includes(call.parent?.type) &&
                sameNode(call.parent.childForFieldName('left'), call);
            if (!written && propertyEffect(context, fn, call.childForFieldName('attribute')?.text, 'get')) return true;
        }
        if (!['call', 'call_expression'].includes(call.type)) continue;
        const callee = call.childForFieldName('function');
        const argument = identityArgument(call, facts.aliases, fn, context);
        const object = callee?.childForFieldName('object');
        const member = callee?.childForFieldName('attribute') || callee?.childForFieldName('property');
        const onInstance = object?.type === 'identifier' && facts.aliases.has(object.text);
        if (!argument && !onInstance) continue;
        if (argument?.unread) return true;
        if (['setattr', 'delattr'].includes(callee?.text) && builtinReference(context, callee)) continue;
        const name = member?.text || (callee?.type === 'identifier' ? callee.text : null);
        if (!name) return true;
        // A proven builtin attribute-presence check only invokes that
        // attribute's getter. It does not hand the instance to an unread
        // helper; any project descriptor still has to preserve identity.
        if (!object && name === 'hasattr' && builtinReference(context, callee)) {
            const args = call.childForFieldName('arguments')?.namedChildren || [];
            const attribute = args.length === 2 && literalMember(args[1]);
            if (argument.index !== 0 || !attribute || propertyEffect(context, fn, attribute, 'get')) return true;
            continue;
        }
        if (onInstance) {
            if (argument || instanceMember(context, fn, name, (descriptor, other, next) => !descriptor.method || descriptor.instanceShadow ||
                bodyChangesIdentity(index, next.file, other || tree, descriptor.method, helperSensitive,
                    depth + 1, helperSensitive, definition)) !== false) return true;
            continue;
        }
        const helper = !object ? functionNamed(tree, fn, name) : null;
        if (helper) {
            if (!argumentNamesFirstParameter(argument, helper) ||
                bodyChangesIdentity(index, file, tree, helper, helperSensitive, depth + 1, helperSensitive, definition)) return true;
            continue;
        }
        const entry = index.files.get(file);
        const targets = [];
        if (object) {
            const { pythonModulePath, pythonModuleScope } = require('./python-modules');
            const qualifier = object.text;
            const modules = pythonModulePath(index, file, qualifier);
            const site = { start: call.startIndex, end: call.endIndex };
            if (!modules || modules.unknown || !pythonModuleScope(index, file, qualifier, site) ||
                qualifiedBindingChanged(index, file, { name }, qualifier)) return true;
            for (const targetFile of modules.files) targets.push({ file: targetFile, name });
        } else {
            const sites = require('../languages/lexical-scope').pythonScopeBindingKinds(fn, name);
            if (sites.length) return true;
            const bindings = localImportBindings(entry, name);
            const binding = bindings.length === 1 ? bindings[0] : null;
            const relative = binding && entry.moduleResolved?.[binding.module];
            if (relative) targets.push({ file: require('path').resolve(index.root, relative), name: binding.name });
        }
        if (targets.length !== 1) return true;
        const target = targets[0];
        if (withTree(index, target.file, other => {
            const imported = functionNamed(other, null, target.name);
            return !imported || !argumentNamesFirstParameter(argument, imported) ||
                bodyChangesIdentity(index, target.file, other, imported, helperSensitive, depth + 1, helperSensitive, definition);
        }) !== false) return true;
    }
    return false;
}

/** Select the returns in a decorator's class-or-options branch. Other
 * conditions stay unknown, so every branch must keep the same value. */
function decoratorReturns(body, parameter, parameterNone) {
    const output = [];
    const visit = statements => {
        for (const node of statements || []) {
            if (FUNCTION_NODES.has(node.type)) continue;
            if (node.type === 'return_statement') { output.push(node.namedChild(0) || null); return true; }
            if (node.type === 'if_statement') {
                const condition = node.childForFieldName('condition');
                const parts = condition?.namedChildren || [];
                const isNone = condition?.type === 'comparison_operator' && parts.length === 2 &&
                    parts[0].type === 'identifier' && parts[0].text === parameter && parts[1].type === 'none';
                const operator = isNone ? condition.children.filter(child => !child.isNamed).map(child => child.text).join(' ') : '';
                if (isNone && parameterNone != null && (operator === 'is' || operator === 'is not')) {
                    const selected = parameterNone === (operator === 'is') ? node.childForFieldName('consequence') : node.childForFieldName('alternative');
                    if (selected && visit(selected.type === 'else_clause' ? selected.childForFieldName('body')?.namedChildren : selected.namedChildren)) return true;
                    continue;
                }
            }
            for (const ret of ownReturns(node)) output.push(ret.namedChild(0) || null);
        }
        return false;
    };
    visit(body?.namedChildren);
    return output;
}

function decoratorFunctionKeeps(tree, fn, returnsNothingKeeps, depth = 0, options = {}) {
    if (!fn || depth > 4) return false;
    if (fn.parent?.type === 'decorated_definition') return false;
    const parameter = firstParameterName(fn);
    const body = fn.childForFieldName('body');
    const sensitive = options.sensitive || new Set();
    const changes = identityWrites(body, parameter, sensitive, !options.factory, options.context);
    if (changes.changesValue) return false;
    const values = body && !['block', 'statement_block'].includes(body.type) ? [body]
        : decoratorReturns(body, parameter, options.factory ? options.parameterNone : false);
    if (values.length === 0) return returnsNothingKeeps;
    const stable = name => {
        if (changes.writes.has(name)) return false;
        if (fn.type !== 'function_definition') return true;
        const sites = require('../languages/lexical-scope').pythonScopeBindingKinds(fn, name);
        return sites.length === 0 || (sites.length === 1 && sites[0].kind === 'def');
    };
    const keepsNamed = (name, factory = false) => stable(name) &&
        decoratorFunctionKeeps(tree, functionNamed(tree, fn, name), returnsNothingKeeps, depth + 1,
            { ...options, factory, parameterNone: factory ? true : false });
    // Passing the class to an unread helper before returning it is not an
    // identity proof: that helper may replace one of its dispatch slots.
    for (const call of ownNodes(body, options.context?.index)) {
        if (!['call', 'call_expression'].includes(call.type)) continue;
        const argument = options.factory ? null : identityArgument(call, changes.aliases, fn, options.context);
        if (!argument) continue;
        if (argument.unread) return false;
        const callee = call.childForFieldName('function');
        if (callee?.type !== 'identifier') return false;
        if (['setattr', 'delattr'].includes(callee.text) && builtinReference(options.context, callee)) continue; // slots checked above
        if (!argumentNamesFirstParameter(argument, functionNamed(tree, fn, callee.text)) ||
            !keepsNamed(callee.text)) return false;
    }
    return values.every(found => {
        let value = found;
        while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
        if (!value) return returnsNothingKeeps;
        if (value.type === 'identifier') return value.text === parameter ? !options.factory : keepsNamed(value.text);
        if (FUNCTION_VALUES.has(value.type)) return decoratorFunctionKeeps(tree, value, returnsNothingKeeps, depth + 1,
            { ...options, factory: false });
        if (value.type !== 'call' && value.type !== 'call_expression') return false;
        const callee = value.childForFieldName('function');
        const args = (value.childForFieldName('arguments')?.namedChildren || []).filter(arg => !arg.type.endsWith('comment'));
        if (args.some(arg => ['list_splat', 'dictionary_splat', 'spread_element'].includes(arg.type))) return false;
        const positional = args.filter(arg => arg.type !== 'keyword_argument');
        if (callee?.type === 'identifier' && options.partialNames?.has(callee.text)) {
            return positional.length === 1 && positional[0].type === 'identifier' && keepsNamed(positional[0].text);
        }
        if (callee?.type !== 'identifier') return false;
        if (positional.length === 0) return keepsNamed(callee.text, true);
        return !options.factory && !!parameter && positional[0].type === 'identifier' &&
            positional[0].text === parameter && keepsNamed(callee.text);
    });
}

/**
 * Whether a class decorator can put something else under the class's name.
 * A decorator of the project has to show that it does not (see
 * `decoratorFunctionKeeps`): a module-level function of this file or one
 * the file imports by name, used bare or with arguments. A project
 * decorator that is not read (an attribute of a project module, a class, a
 * computed value) counts as replacing. A decorator from outside the project
 * is taken to return the class it is given.
 */
function decoratorReplacesClass(index, file, decorator, sensitive = new Set(), definition = null) {
    const syntax = withTree(index, file, tree => {
        const node = tree.rootNode.descendantsOfType('decorator').find(item =>
            item.namedChild(0)?.text === decorator);
        const expression = node?.namedChild(0);
        if (!expression) return null;
        const factory = ['call', 'call_expression'].includes(expression.type);
        const head = factory ? expression.childForFieldName('function') : expression;
        let root = head;
        while (['attribute', 'member_expression'].includes(root?.type)) root = root.childForFieldName('object');
        if (root?.type !== 'identifier') return null;
        return { root: root.text, bare: head.type === 'identifier', factory,
            args: factory ? (expression.childForFieldName('arguments')?.namedChildren || []).map(arg => ({
                type: arg.type, name: arg.childForFieldName('name')?.text,
                valueType: arg.childForFieldName('value')?.type,
            })) : [] };
    });
    if (!syntax) return true;
    const { root } = syntax;
    const entry = index.files.get(file);
    const declaredHere = (index.symbols.get(root) || []).some(def => def.file === file && !def.className &&
        def.lexicalScopeStartLine == null) || (entry?.moduleAssignedNames || []).includes(root) ||
        (entry?.moduleValueAliases || []).some(alias => alias.name === root);
    const bindings = localImportBindings(entry, root);
    const projectImports = bindings.filter(binding => entry.moduleResolved?.[binding.module]);
    // Unbound here (a builtin) or imported from outside the project.
    if (!declaredHere && projectImports.length === 0) return false;
    if (!syntax.bare) return true;
    // The one module-level function of a name: typing overload stubs
    // declare no body of their own, and a module alias of a function
    // (`rich_repr = auto`) names it.
    const moduleFunction = (target, name, depth = 0) => {
        const named = (index.symbols.get(name) || []).filter(def => def.file === target && !def.className &&
            def.lexicalScopeStartLine == null);
        const defs = named.filter(def => !(def.decorators || []).some(text => /(^|\.)overload$/.test(String(text))));
        if (defs.length === 1 && defs[0].type === 'function') {
            const targetEntry = index.files.get(target);
            if ((targetEntry?.moduleAssignedNames || []).includes(name) ||
                (targetEntry?.moduleValueAliases || []).some(alias => alias.name === name)) return null;
            return defs[0];
        }
        // Anything but the variable an alias assignment declares is another kind of value.
        if (named.some(def => def.type !== 'state') || depth > 2) return null;
        const aliases = (index.files.get(target)?.moduleValueAliases || []).filter(alias => alias.name === name);
        return aliases.length === 1 && aliases[0].target && !aliases[0].alternatives?.length &&
            /^[A-Za-z_$][\w$]*$/.test(aliases[0].target) ? moduleFunction(target, aliases[0].target, depth + 1) : null;
    };
    let fn = declaredHere ? moduleFunction(file, root) : null;
    if (!fn && !declaredHere && bindings.length === 1 && projectImports.length === 1) {
        fn = moduleFunction(require('path').resolve(index.root, entry.moduleResolved[bindings[0].module]),
            bindings[0].name);
    }
    if (!fn) return true;
    const returnsNothingKeeps = langTraits(index.files.get(fn.file)?.language)?.constructorProtocol == null;
    const { factory, args } = syntax;
    if (args.some(arg => arg.type !== 'keyword_argument' &&
        !['string', 'integer', 'float', 'true', 'false', 'none', 'number'].includes(arg.type))) return true;
    const partialNames = new Set((index.files.get(fn.file)?.importBindings || []).filter(binding =>
        binding.module === 'functools' && binding.name === 'partial').map(binding => binding.alias || binding.name));
    return withTree(index, fn.file, tree => {
        const node = functionNodeOf(tree, fn);
        if (!node) return true;
        const parameter = firstParameterName(node);
        const positional = args.filter(arg => arg.type !== 'keyword_argument');
        const keyword = args.find(arg => arg.type === 'keyword_argument' && arg.name === parameter);
        const supplied = positional[0] || (keyword && { type: keyword.valueType });
        if (keyword && supplied?.type !== 'none') return true;
        const defaultValue = node.childForFieldName('parameters')?.namedChild(0)?.childForFieldName('value');
        const parameterNone = supplied ? supplied.type === 'none' : defaultValue?.type === 'none' ? true : null;
        return !decoratorFunctionKeeps(tree, node, returnsNothingKeeps, 0,
            { factory, parameterNone, sensitive, partialNames, context: { index, file: fn.file, definition } });
    }) !== false;
}

/** A constructor that returns a value other than `this` (JS/TS). */
function constructorReturnsValue(index, constructor) {
    const span = constructor.sourceSpan;
    if (!span) return false;
    return withTree(index, constructor.file, (tree, content) => {
        // Prefilter only: the syntax tree decides.
        if (!content.slice(span.start, span.end).includes('return')) return false;
        const node = functionNodeOf(tree, constructor);
        if (!node) return true;
        return ownReturns(node.childForFieldName('body'), index).some(statement => {
            let value = statement.namedChild(0);
            while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
            return !!value && value.type !== 'this';
        });
    }) !== false;
}

/** The class a `metaclass=` keyword of a class header names, as a class reference; null when none is written. */
function metaclassOf(index, definition, protocol) {
    const read = withTree(index, definition.file, (tree, content) => {
        // Prefilter only: the syntax tree decides.
        if (!content.includes(protocol.metaclass)) return null;
        // Every accepted class ends on this line. Visit the final two rows
        // (including a zero-column end), keeping enclosing/nested matches.
        const nodes = tree.rootNode.descendantsOfType(protocol.classNode,
            { row: Math.max(0, definition.endLine - 2), column: 0 }, { row: definition.endLine, column: 0 }).filter(node =>
            node.childForFieldName('name')?.text === definition.name &&
            node.startPosition.row + 1 >= definition.startLine && node.endPosition.row + 1 === definition.endLine);
        if (nodes.length !== 1) return { unread: true };
        const header = nodes[0].childForFieldName(protocol.headerField);
        const keyword = (header?.namedChildren || []).find(arg => arg.type === protocol.keywordNode &&
            arg.childForFieldName('name')?.text === protocol.metaclass);
        if (!keyword) return null;
        const value = keyword.childForFieldName('value');
        return { name: value?.type === 'identifier' ? value.text : null,
            line: keyword.startPosition.row + 1, written: value?.text || '',
            computed: !['identifier', 'attribute'].includes(value?.type) };
    });
    return read === undefined ? { unread: true } : read;
}

function hasComputedBase(index, definition, protocol) {
    return withTree(index, definition.file, tree => {
        // Every accepted class ends on this line. Visit the final two rows
        // (including a zero-column end), keeping enclosing/nested matches.
        const nodes = tree.rootNode.descendantsOfType(protocol.classNode,
            { row: Math.max(0, definition.endLine - 2), column: 0 }, { row: definition.endLine, column: 0 }).filter(node =>
            node.childForFieldName('name')?.text === definition.name &&
            node.startPosition.row + 1 >= definition.startLine && node.endPosition.row + 1 === definition.endLine);
        if (nodes.length !== 1) return true;
        const header = nodes[0].childForFieldName(protocol.headerField);
        return (header?.namedChildren || []).some(base => {
            if (base.type === protocol.keywordNode) return false;
            if (base.type !== 'subscript') return !['identifier', 'attribute'].includes(base.type);
            // Subscription can run a project __class_getitem__ or metaclass.
            // Only an outside generic base keeps the ordinary alias meaning.
            const value = base.childForFieldName('value');
            if (!['identifier', 'attribute'].includes(value?.type)) return true;
            const name = value.type === 'identifier' ? value.text : value.childForFieldName('attribute')?.text;
            return (index.symbols.get(name) || []).some(def => CLASS_KINDS.has(def.type));
        });
    }) !== false;
}

/**
 * Whether calling the class makes an instance of that very class. What can
 * change it is written in the class or in a project class it inherits from:
 * an allocator (`__new__`), a metaclass that takes the call over
 * (`__call__`), a constructor that returns a value, a decorator that puts
 * something else under the class's name. A base outside the project is
 * taken to construct the class it is called on.
 */
function constructionKeepsClass(index, definition) {
    const memo = index._opMemo?.('constructionKeepsClass', () => new WeakMap());
    if (memo?.has(definition)) return memo.get(definition);
    const result = constructionKeepsClassUncached(index, definition);
    memo?.set(definition, result);
    return result;
}

function constructionAncestry(index, definition) {
    const memo = index._opMemo?.('constructionAncestry', () => new WeakMap());
    if (memo?.has(definition)) return memo.get(definition);
    const result = constructionAncestryUncached(index, definition);
    memo?.set(definition, result);
    return result;
}

function constructionAncestryUncached(index, definition) {
    const { classDefsNamed, parentRefsOf } = require('./class-identity');
    const refOf = def => ({ name: def.name, def,
        key: classDefsNamed(index, def.name).entries.find(entry => entry.def === def)?.key || null });
    const ancestry = [];
    const seen = new Set();
    const queue = [refOf(definition)];
    while (queue.length > 0 && ancestry.length < 64) {
        const ref = queue.shift();
        if (!ref.def || !ref.key || seen.has(ref.key)) continue;
        seen.add(ref.key);
        ancestry.push(ref);
        for (const parent of parentRefsOf(index, ref)) {
            if (parent.external) continue;
            if (!parent.def && parent.key && !parent.importUnresolved && !(index.symbols.get(parent.name) || []).length) continue;
            if (!parent.def || !parent.key || parent.importUnresolved) return null;
            queue.push(parent);
        }
    }
    return queue.length > 0 ? null : ancestry;
}

function constructionKeepsClassUncached(index, definition) {
    const { resolveClassRef, findDeclaringClass } = require('./class-identity');
    const ancestry = constructionAncestry(index, definition);
    if (!ancestry) return false;
    const memberNames = new Set(ancestry.flatMap(ref => (index.files.get(ref.def.file)?.symbols || [])
        .filter(member => dispatchMember(member) && member.className === ref.def.name && member.startLine >= ref.def.startLine &&
            member.endLine <= ref.def.endLine).map(member => member.name)));
    for (const ref of ancestry) {
        const cls = ref.def;
        const entry = index.files.get(cls.file);
        const traits = langTraits(entry?.language);
        const members = (entry?.symbols || []).filter(member => member.className === cls.name &&
            member.startLine >= cls.startLine && member.endLine <= cls.endLine);
        const protocol = traits?.constructorProtocol;
        if (protocol) {
            if (hasComputedBase(index, cls, protocol)) return false;
            if (members.some(member => member.name === protocol.allocator || protocol.identityOverrides.includes(member.name))) return false;
            for (const initializer of members.filter(member => member.name === protocol.initializer)) {
                if (initializer.decorators?.length) return false;
                if (withTree(index, initializer.file, tree => {
                    const node = functionNodeOf(tree, initializer);
                    if (!node) return true;
                    return bodyChangesIdentity(index, initializer.file, tree, node, new Set(protocol.identityMembers), 0,
                        new Set([...protocol.identityMembers, ...memberNames]), definition);
                }) !== false) return false;
            }
            const metaclass = metaclassOf(index, cls, protocol);
            if (metaclass?.unread || metaclass?.computed) return false;
            if (metaclass) {
                // A metaclass outside the project is taken to make the class
                // it is called on; a project one decides by its own `__call__`.
                const named = metaclass.name ? resolveClassRef(index, metaclass.name, cls.file, { line: metaclass.line }) : null;
                if (!named || (!named.def && !named.external)) {
                    if ((index.symbols.get(metaclass.written.split('.').pop()) || []).length > 0) return false;
                } else if (named.external && boundInModule(entry, metaclass.name)) {
                    const bindings = localImportBindings(entry, metaclass.name);
                    if (bindings.length !== 1 || entry.moduleResolved?.[bindings[0].module]) return false;
                } else if (!named.external) {
                    if (!named.key) return false;
                    // No project class in the metaclass's ancestry declares
                    // `__call__`: the call is `type`'s own.
                    for (const name of [...protocol.metaclassMethods, ...protocol.identityOverrides]) {
                        const call = findDeclaringClass(index, named, index.symbols.get(name) || []);
                        if (call && call.members.length > 0) return false;
                    }
                }
            }
        } else if (members.some(member => member.type === 'constructor' && constructorReturnsValue(index, member))) {
            return false;
        }
        for (const decorator of cls.decorators || []) {
            const sensitive = new Set([...memberNames, ...(protocol?.identityMembers || []), ...(protocol?.identityOverrides || []),
                protocol?.allocator, protocol?.initializer]);
            if (decoratorReplacesClass(index, cls.file, String(decorator), sensitive, cls)) return false;
        }
    }
    return true;
}

/**
 * `with Name(..) as v` binds what the manager's enter method returns. It is
 * the constructed instance when the method the class's ancestry declares
 * returns its own receiver on every path; an outside base's enter method is
 * taken to. False when a project enter method returns anything else.
 */
function contextBindingKeepsInstance(index, definition) {
    const memo = index._opMemo?.('constructedContextBinding', () => new WeakMap());
    if (memo?.has(definition)) return memo.get(definition);
    const value = contextBindingKeepsInstanceUncached(index, definition);
    memo?.set(definition, value);
    return value;
}

function contextBindingKeepsInstanceUncached(index, definition) {
    const names = langTraits(index.files.get(definition.file)?.language)?.contextEnterMethods || [];
    if (names.length === 0) return true;
    const { classDefsNamed, findDeclaringClass } = require('./class-identity');
    const ref = { name: definition.name, def: definition,
        key: classDefsNamed(index, definition.name).entries.find(entry => entry.def === definition)?.key || null };
    if (!ref.key) return false;
    for (const name of names) {
        // No project class of the ancestry declares it: an outside base's.
        const declaring = findDeclaringClass(index, ref, index.symbols.get(name) || []);
        if (!declaring || declaring.members.length === 0) continue;
        if (declaring.uncertain) return false;
        for (const member of declaring.members) {
            if (member.decorators?.length) return false;
            const own = withTree(index, member.file, tree => {
                const node = functionNodeOf(tree, member);
                if (!node) return false;
                const receiver = firstParameterName(node);
                const sensitive = new Set([...(langTraits(index.files.get(member.file)?.language)?.constructorProtocol?.identityMembers || []),
                    ...(constructionAncestry(index, definition) || []).flatMap(ref => (index.files.get(ref.def.file)?.symbols || [])
                        .filter(symbol => dispatchMember(symbol) && symbol.className === ref.def.name && symbol.startLine >= ref.def.startLine &&
                            symbol.endLine <= ref.def.endLine).map(symbol => symbol.name))]);
                if (bodyChangesIdentity(index, member.file, tree, node, sensitive, 0, sensitive, definition)) return false;
                const returns = ownReturns(node.childForFieldName('body'), index);
                return !!receiver && returns.length > 0 && returns.every(statement =>
                    statement.namedChild(0)?.type === 'identifier' && statement.namedChild(0).text === receiver);
            });
            if (own !== true) return false;
        }
    }
    return true;
}

module.exports = { constructedClass, constructionRecordOf, constructionKeepsClass, contextBindingKeepsInstance,
    localImportBindings, qualifiedBindingChanged };
