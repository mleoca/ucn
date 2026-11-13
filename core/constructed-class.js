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

/** `return` statements of a function's own body (not of functions and classes nested in it). */
function ownReturns(body) {
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
    return declaredIn(scope?.childForFieldName('body')?.namedChildren) || declaredIn(tree.rootNode.namedChildren);
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
function decoratorFunctionKeeps(tree, fn, returnsNothingKeeps, depth = 0) {
    if (!fn || depth > 4) return false;
    const parameter = firstParameterName(fn);
    const body = fn.childForFieldName('body');
    // An expression-bodied arrow or lambda returns its body.
    const values = body && !['block', 'statement_block'].includes(body.type) ? [body]
        : ownReturns(body).map(statement => statement.namedChild(0) || null);
    if (values.length === 0) return returnsNothingKeeps;
    const keepsNamed = name => decoratorFunctionKeeps(tree, functionNamed(tree, fn, name), returnsNothingKeeps, depth + 1);
    return values.every(found => {
        let value = found;
        while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
        if (!value) return returnsNothingKeeps;
        if (value.type === 'identifier') return value.text === parameter || keepsNamed(value.text);
        if (FUNCTION_VALUES.has(value.type)) return decoratorFunctionKeeps(tree, value, returnsNothingKeeps, depth + 1);
        if (value.type !== 'call' && value.type !== 'call_expression') return false;
        const callee = value.childForFieldName('function');
        const args = (value.childForFieldName('arguments')?.namedChildren || []).filter(arg => !arg.type.endsWith('comment'));
        const calleeName = callee?.type === 'identifier' ? callee.text
            : (callee?.childForFieldName('attribute') || callee?.childForFieldName('property'))?.text;
        if (args.some(arg => ['list_splat', 'dictionary_splat', 'spread_element'].includes(arg.type))) return false;
        const positional = args.filter(arg => arg.type !== 'keyword_argument');
        if (calleeName === 'partial') return positional[0]?.type === 'identifier' && keepsNamed(positional[0].text);
        if (callee?.type !== 'identifier' || !keepsNamed(callee.text)) return false;
        return positional.length === 0 ||
            (!!parameter && positional[0].type === 'identifier' && positional[0].text === parameter);
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
function decoratorReplacesClass(index, file, decorator) {
    const head = String(decorator).split('(')[0].trim();
    const root = /^[A-Za-z_$][\w$]*/.exec(head)?.[0];
    if (!root) return true;
    const entry = index.files.get(file);
    const declaredHere = (index.symbols.get(root) || []).some(def => def.file === file && !def.className &&
        def.lexicalScopeStartLine == null) || (entry?.moduleAssignedNames || []).includes(root) ||
        (entry?.moduleValueAliases || []).some(alias => alias.name === root);
    const bindings = localImportBindings(entry, root);
    const projectImports = bindings.filter(binding => entry.moduleResolved?.[binding.module]);
    // Unbound here (a builtin) or imported from outside the project.
    if (!declaredHere && projectImports.length === 0) return false;
    if (head !== root) return true;
    // The one module-level function of a name: typing overload stubs
    // declare no body of their own, and a module alias of a function
    // (`rich_repr = auto`) names it.
    const moduleFunction = (target, name, depth = 0) => {
        const named = (index.symbols.get(name) || []).filter(def => def.file === target && !def.className &&
            def.lexicalScopeStartLine == null);
        const defs = named.filter(def => !(def.decorators || []).some(text => /(^|\.)overload$/.test(String(text))));
        if (defs.length === 1 && defs[0].type === 'function') return defs[0];
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
    return withTree(index, fn.file, tree =>
        !decoratorFunctionKeeps(tree, functionNodeOf(tree, fn), returnsNothingKeeps)) !== false;
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
        return ownReturns(node.childForFieldName('body')).some(statement => {
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
        const nodes = tree.rootNode.descendantsOfType(protocol.classNode).filter(node =>
            node.childForFieldName('name')?.text === definition.name &&
            node.startPosition.row + 1 >= definition.startLine && node.endPosition.row + 1 === definition.endLine);
        if (nodes.length !== 1) return { unread: true };
        const header = nodes[0].childForFieldName(protocol.headerField);
        const keyword = (header?.namedChildren || []).find(arg => arg.type === protocol.keywordNode &&
            arg.childForFieldName('name')?.text === protocol.metaclass);
        if (!keyword) return null;
        const value = keyword.childForFieldName('value');
        return { name: value?.type === 'identifier' ? value.text : null,
            line: keyword.startPosition.row + 1, written: value?.text || '' };
    });
    return read === undefined ? { unread: true } : read;
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

function constructionKeepsClassUncached(index, definition) {
    const { classDefsNamed, parentRefsOf, resolveClassRef, findDeclaringClass } = require('./class-identity');
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
        for (const parent of parentRefsOf(index, ref)) if (!parent.external && parent.def) queue.push(parent);
    }
    for (const ref of ancestry) {
        const cls = ref.def;
        const entry = index.files.get(cls.file);
        const traits = langTraits(entry?.language);
        const members = (entry?.symbols || []).filter(member => member.className === cls.name &&
            member.startLine >= cls.startLine && member.endLine <= cls.endLine);
        const protocol = traits?.constructorProtocol;
        if (protocol) {
            if (members.some(member => member.name === protocol.allocator)) return false;
            const metaclass = metaclassOf(index, cls, protocol);
            if (metaclass?.unread) return false;
            if (metaclass) {
                // A metaclass outside the project is taken to make the class
                // it is called on; a project one decides by its own `__call__`.
                const named = metaclass.name ? resolveClassRef(index, metaclass.name, cls.file, { line: metaclass.line }) : null;
                if (!named) {
                    if (classDefsNamed(index, metaclass.written.split('.').pop()).entries.length > 0) return false;
                } else if (!named.external) {
                    if (!named.key) return false;
                    // No project class in the metaclass's ancestry declares
                    // `__call__`: the call is `type`'s own.
                    const call = findDeclaringClass(index, named, index.symbols.get('__call__') || []);
                    if (call && call.members.length > 0) return false;
                }
            }
        } else if (members.some(member => member.type === 'constructor' && constructorReturnsValue(index, member))) {
            return false;
        }
        for (const decorator of cls.decorators || []) {
            if (decoratorReplacesClass(index, cls.file, String(decorator))) return false;
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
            const own = withTree(index, member.file, tree => {
                const node = functionNodeOf(tree, member);
                if (!node) return false;
                const receiver = firstParameterName(node);
                const returns = ownReturns(node.childForFieldName('body'));
                return !!receiver && returns.length > 0 && returns.every(statement =>
                    statement.namedChild(0)?.type === 'identifier' && statement.namedChild(0).text === receiver);
            });
            if (own !== true) return false;
        }
    }
    return true;
}

module.exports = { constructedClass, constructionRecordOf, constructionKeepsClass, contextBindingKeepsInstance,
    localImportBindings };
