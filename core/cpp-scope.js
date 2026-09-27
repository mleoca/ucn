/**
 * core/cpp-scope.js - C++ qualified-name resolution for call qualifiers.
 *
 * A path call `Q::f(...)` names a member of a class when Q denotes a type and
 * a namespace-scope function when Q denotes a namespace. The two AST shapes
 * are identical (qualified_identifier), so the caller contract must decide
 * what Q denotes before it may confirm or exclude anything:
 *
 *   - `type`:      Q resolves (through `using`/`typedef` aliases, template
 *                  arguments stripped) to project class definitions
 *   - `namespace`: Q names a namespace the project declares and no visible
 *                  type of that spelling exists
 *   - `unknown`:   anything else (template parameters, external types,
 *                  unresolved aliases); callers route such sites UNVERIFIED
 *
 * Namespaces come from the AST (`namespace a { ... }`) plus namespaces opened
 * by object-like macros whose replacement list is a namespace opener
 * (`#define LIB_BEGIN namespace lib { inline namespace v1 {`): the parser
 * records each macro's namespace effect from its replacement tokens and each
 * standalone macro line at namespace scope; this module replays those
 * markers per file to give every definition its effective namespace.
 *
 * Everything is memoized on the index (`_cppScope`) and reset at build/load.
 */

const { codeUnitCompare } = require('./shared');

const TYPE_KINDS = new Set(['class', 'struct', 'union', 'enum', 'interface']);
const MAX_ALIAS_HOPS = 8;

function _state(index) {
    let state = index._cppScope;
    if (!state) {
        state = {
            macroEffects: new Map(),
            filePrefixes: new Map(),
            inventory: null,
            resolved: new Map(),
        };
        index._cppScope = state;
    }
    return state;
}

function resetCppScope(index) {
    index._cppScope = null;
}

function _isCppFile(index, file) {
    return index.files.get(file)?.language === 'cpp';
}

/** Files a translation unit rooted at `file` sees through its includes. */
function includeClosure(index, file) {
    const state = _state(index);
    if (!state.closures) state.closures = new Map();
    const cached = state.closures.get(file);
    if (cached) return cached;
    const visible = new Set([file]);
    const queue = [file];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const imported of index.importGraph?.get(current) || []) {
            if (visible.has(imported)) continue;
            visible.add(imported);
            queue.push(imported);
        }
    }
    state.closures.set(file, visible);
    return visible;
}

/**
 * Namespace effect of macro NAME as seen from `file`: the definitions in the
 * file or its include closure must agree on one effect (a project may
 * redefine the macro for another configuration elsewhere). Disagreeing or
 * unmodeled definitions are never scope evidence.
 */
function _macroEffect(index, name, file) {
    const state = _state(index);
    const cacheKey = `${name}\0${file}`;
    if (state.macroEffects.has(cacheKey)) return state.macroEffects.get(cacheKey);
    const visible = includeClosure(index, file);
    let effect = null;
    let key = null;
    for (const definition of index.symbols.get(name) || []) {
        if (definition.type !== 'macro' || !visible.has(definition.file)) continue;
        const scope = definition.namespaceScope;
        const scopeKey = scope ? JSON.stringify(scope) : '';
        if (key === null) {
            key = scopeKey;
            effect = scope || null;
        } else if (key !== scopeKey) {
            effect = null;
            break;
        }
    }
    if (effect && (effect.opens || []).length > 0) {
        effect = { ...effect, opens: effect.opens.map(group =>
            group.flatMap(name => _expandedNamespaceName(index, name, visible))) };
    }
    state.macroEffects.set(cacheKey, effect);
    return effect;
}

/**
 * A namespace name an opener spells with an object-like macro (`namespace
 * LIB_NAMESPACE {` beside `#define LIB_NAMESPACE lib`) names the namespace the
 * macro expands to (fix #396): the segments of its replacement list when every
 * definition the file sees agrees on a (qualified) identifier. Otherwise the
 * spelling itself.
 */
function _expandedNamespaceName(index, name, visible, depth = 0) {
    if (depth > 4) return [name];
    let body = null;
    for (const definition of index.symbols.get(name) || []) {
        if (definition.type !== 'macro' || !visible.has(definition.file)) continue;
        if (Array.isArray(definition.ppParams) || typeof definition.ppBody !== 'string') return [name];
        const text = definition.ppBody.replace(/\s+/g, '');
        if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(text)) return [name];
        if (body === null) body = text;
        else if (body !== text) return [name];
    }
    if (body === null || body === name) return [name];
    return body.split('::').flatMap(segment => _expandedNamespaceName(index, segment, visible, depth + 1));
}

/**
 * Line-ordered namespace prefixes opened by macro markers in `file`:
 * `[{ line, prefix }]` where `prefix` applies to lines after `line`. Null
 * when the markers do not balance (a close with nothing open): the file's
 * macro scopes are then unknown and contribute nothing.
 */
function _filePrefixes(index, file) {
    const state = _state(index);
    if (state.filePrefixes.has(file)) return state.filePrefixes.get(file);
    const entry = index.files.get(file);
    const markers = entry?.macroScopeMarkers || [];
    let transitions = [];
    const stack = [];
    for (const marker of markers) {
        const effect = _macroEffect(index, marker.name, file);
        if (!effect) continue;
        if (effect.closes > 0) {
            if (effect.closes > stack.length) {
                transitions = null;
                break;
            }
            stack.length -= effect.closes;
        }
        for (const group of effect.opens || []) stack.push(group);
        transitions.push({ line: marker.line, prefix: stack.flat().join('::') });
    }
    state.filePrefixes.set(file, transitions);
    return transitions;
}

function _macroPrefixAt(index, file, line) {
    const transitions = _filePrefixes(index, file);
    if (!transitions) return '';
    let prefix = '';
    for (const transition of transitions) {
        if (transition.line >= line) break;
        prefix = transition.prefix;
    }
    return prefix;
}

/** Effective namespace of a definition: macro-opened prefix + AST namespace. */
function effectiveNamespace(index, definition) {
    if (!definition?.file) return definition?.namespace || '';
    const prefix = _macroPrefixAt(index, definition.file, definition.startLine);
    const own = definition.namespace || '';
    return prefix && own ? `${prefix}::${own}` : prefix || own;
}

/** Effective namespace enclosing an arbitrary source position. */
function namespaceAt(index, file, line) {
    const prefix = _macroPrefixAt(index, file, line);
    const entry = index.files.get(file);
    let own = '';
    let ownSpan = Infinity;
    // The innermost definition containing the line carries the AST
    // namespace of that position.
    for (const symbol of entry?.symbols || []) {
        if (symbol.startLine > line || symbol.endLine < line) continue;
        const span = symbol.endLine - symbol.startLine;
        if (span < ownSpan) {
            ownSpan = span;
            own = symbol.namespace || '';
        }
    }
    return prefix && own ? `${prefix}::${own}` : prefix || own;
}

function _inventory(index) {
    const state = _state(index);
    if (state.inventory) return state.inventory;
    const namespaces = new Set();
    for (const entry of index.files.values()) {
        if (entry.language !== 'cpp') continue;
        for (const symbol of entry.symbols || []) {
            const namespace = effectiveNamespace(index, symbol);
            if (!namespace) continue;
            const parts = namespace.split('::');
            for (let i = 1; i <= parts.length; i++) {
                namespaces.add(parts.slice(0, i).join('::'));
            }
        }
    }
    state.inventory = namespaces;
    return namespaces;
}

/** Remove template argument lists (depth-aware) and whitespace. */
function stripTemplateArguments(text) {
    let plain = '';
    let depth = 0;
    for (const character of String(text || '')) {
        if (character === '<') {
            depth++;
            continue;
        }
        if (character === '>') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth === 0) plain += character;
    }
    // A leading keyword is a separate token (`typename T::x`, `struct S`);
    // a name that merely starts with its letters (`classify_object`,
    // `constant`) is not (fix #386).
    return plain.replace(/^\s*(?:typename|class|struct|const)\s+/, '').replace(/\s+/g, '');
}

/** `A<x::y>::B` -> ['A<x::y>', 'B']: `::` outside template arguments. */
function _splitScope(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    const value = String(text || '');
    for (let i = 0; i < value.length; i++) {
        const character = value[i];
        if (character === '<') depth++;
        else if (character === '>') depth = Math.max(0, depth - 1);
        if (depth === 0 && character === ':' && value[i + 1] === ':') {
            if (current) parts.push(current.trim());
            current = '';
            i++;
            continue;
        }
        current += character;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function _enclosingPrefixes(namespace) {
    const parts = namespace ? namespace.split('::') : [];
    const prefixes = [];
    for (let i = parts.length; i >= 0; i--) prefixes.push(parts.slice(0, i).join('::'));
    return prefixes;
}

function _join(left, right) {
    return left && right ? `${left}::${right}` : left || right;
}

function _scopeOf(index, definition) {
    return _join(effectiveNamespace(index, definition), definition.enclosingType || '');
}

function _typeCandidates(index, name) {
    return (index.symbols.get(name) || []).filter(definition =>
        _isCppFile(index, definition.file) &&
        (TYPE_KINDS.has(definition.type) ||
         (definition.type === 'type' && definition.aliasOf)));
}

/**
 * Using-declarations, using-directives and namespace aliases in scope at a
 * source position: the position's own file (earlier lines, block scope
 * respected) plus namespace-scope facts of every header it includes.
 */
function _usingsInScope(index, context, visibleFiles) {
    const out = [];
    const take = (file, fact) => {
        if (file === context.file) {
            if (fact.line > context.line) return;
            if (fact.scopeStartLine != null &&
                (context.line < fact.scopeStartLine || context.line > fact.scopeEndLine)) return;
        } else if (fact.scopeStartLine != null) {
            return;
        }
        const state = _state(index);
        if (!state.expandedFacts) state.expandedFacts = new WeakMap();
        let expanded = state.expandedFacts.get(fact);
        if (!expanded) {
            expanded = _withExpandedTarget(index, { ...fact, file });
            state.expandedFacts.set(fact, expanded);
        }
        out.push(expanded);
    };
    for (const fact of index.files.get(context.file)?.cppUsings || []) take(context.file, fact);
    for (const file of visibleFiles || []) {
        if (file === context.file) continue;
        for (const fact of index.files.get(file)?.cppUsings || []) take(file, fact);
    }
    return out;
}

/**
 * A using fact whose target spells a namespace through an object-like macro
 * (`using namespace LIB_NAMESPACE;`, `using LIB_NAMESPACE::f;`) names what
 * the macro expands to where the directive is written (fix #396). The last
 * segment of a using-declaration is the declared name, never expanded.
 */
function _withExpandedTarget(index, fact) {
    const target = typeof fact.target === 'string' ? fact.target : null;
    if (!target || !/[A-Za-z_]/.test(target)) return fact;
    const global = target.startsWith('::');
    const segments = target.replace(/^::/, '').split('::').filter(Boolean);
    if (segments.some(part => !/^[A-Za-z_]\w*$/.test(part))) return fact;
    const keepLast = fact.kind === 'declaration' && segments.length > 1;
    const head = keepLast ? segments.slice(0, -1) : segments;
    if (!head.some(part => (index.symbols.get(part) || []).some(definition => definition.type === 'macro'))) {
        return fact;
    }
    const visible = includeClosure(index, fact.file);
    const expanded = [...head.flatMap(part => _expandedNamespaceName(index, part, visible)),
        ...(keepLast ? [segments[segments.length - 1]] : [])];
    if (expanded.join('::') === segments.join('::')) return fact;
    return { ...fact, target: `${global ? '::' : ''}${expanded.join('::')}` };
}

/**
 * Can `::name` (qualified lookup in the global namespace) reach a
 * declaration in namespace `targetNamespace` (fix #393)? Only through a
 * using-directive or using-declaration at global namespace scope visible at
 * the site: 'no' when none can nominate it, 'maybe' when one may.
 */
function globalQualifiedReaches(index, context, targetNamespace, name, visibleFiles) {
    if (!targetNamespace) return 'yes';
    const target = targetNamespace.split('::');
    for (const fact of _usingsInScope(index, context, visibleFiles)) {
        if (fact.scopeStartLine != null) continue;
        const where = _join(_macroPrefixAt(index, fact.file, fact.line), fact.namespace || '');
        if (where) continue;
        const spelled = String(fact.target || '').replace(/^::/, '').split('::').filter(Boolean);
        if (fact.kind === 'directive') {
            // `using namespace a::b;` nominates the namespace its (possibly
            // partial) spelling resolves to: any suffix of the target.
            const tail = target.slice(-spelled.length);
            if (spelled.length > 0 && tail.join('::') === spelled.join('::')) return 'maybe';
        } else if (fact.kind === 'declaration' && fact.name === name) {
            return 'maybe';
        }
    }
    return 'no';
}

function _factContext(index, fact, origin) {
    return {
        file: fact.file,
        line: fact.line,
        namespace: _join(_macroPrefixAt(index, fact.file, fact.line), fact.namespace || ''),
        className: null,
        origin,
    };
}

/**
 * Resolve a (possibly qualified) type spelling from a source context to the
 * class definitions it denotes.
 * @returns {{kind:'type', classes:object[], visible:boolean}|{kind:'namespace', namespace:string}|{kind:'unknown', why:string}}
 */
function resolveQualifier(index, context, spelling, visibleFiles, depth = 0, options = {}) {
    // `declarations` (fix #386): report the declarations name lookup finds
    // for the last segment (a class, or a typedef/alias of that spelling)
    // instead of the classes an alias denotes.
    const declarationsOnly = options.declarations === true;
    const plain = stripTemplateArguments(spelling);
    const global = plain.startsWith('::');
    let segments = plain.replace(/^::/, '').split('::').filter(Boolean);
    if (segments.length === 0 || segments.some(part => !/^[A-Za-z_]\w*$/.test(part))) {
        return { kind: 'unknown', why: 'unparsed-qualifier' };
    }
    // A qualifier segment spelled by an object-like macro
    // (`LIB_NAMESPACE::detail::X`) is the name the macro expands to, as in
    // macro-opened namespaces (fix #396).
    if (segments.length > 1 && visibleFiles && segments.slice(0, -1).some(part =>
        (index.symbols.get(part) || []).some(definition => definition.type === 'macro'))) {
        segments = [...segments.slice(0, -1).flatMap(part => _expandedNamespaceName(index, part, visibleFiles)),
            segments[segments.length - 1]];
    }
    if (depth > MAX_ALIAS_HOPS) return { kind: 'unknown', why: 'alias-depth' };
    const origin = context.origin || context.file;
    const cacheKey = `${origin}\0${context.file}\0${context.line}\0${context.className || ''}\0${plain}` +
        `${declarationsOnly ? '\0d' : ''}${context.namespace != null ? `\0ns:${context.namespace}` : ''}`;
    const state = _state(index);
    if (state.resolved.has(cacheKey)) return state.resolved.get(cacheKey);
    const finish = result => {
        state.resolved.set(cacheKey, result);
        return result;
    };
    const name = segments[segments.length - 1];
    const qualifier = segments.slice(0, -1).join('::');
    const contextNamespace = context.namespace ??
        namespaceAt(index, context.file, context.line);
    const usings = global ? [] : _usingsInScope(index, context, visibleFiles);

    // A using-declaration or namespace alias that introduces the first
    // segment rewrites it to the introduced entity, resolved where the
    // declaration sits.
    const introducers = usings.filter(fact =>
        (fact.kind === 'declaration' || fact.kind === 'namespace-alias') &&
        fact.name === segments[0]);
    if (introducers.length > 0) {
        const targets = new Set(introducers.map(fact => fact.target));
        if (targets.size !== 1) return finish({ kind: 'unknown', why: 'ambiguous-using' });
        const fact = introducers[0];
        const rewritten = [fact.target, ...segments.slice(1)].join('::');
        return finish(resolveQualifier(index, _factContext(index, fact, origin),
            rewritten, visibleFiles, depth + 1, options));
    }

    const scopes = global ? [''] : _enclosingPrefixes(contextNamespace);
    if (!global && context.className) {
        // Member types of the enclosing class are found before namespace
        // scope, then those of each lexically enclosing class, innermost
        // first (fix #396: a nested class body or an out-of-line member of
        // `SkipList<K, C>::Node` sees Node's and SkipList's member types). A
        // declaration's scope names its immediate class; out-of-line template
        // members spell that class with arguments.
        const classScopes = [_join(contextNamespace, context.className)];
        const chain = _splitScope(context.className);
        for (let i = chain.length - 1; i >= 0; i--) {
            classScopes.push(_join(contextNamespace, chain[i]));
            const plainClass = stripTemplateArguments(chain[i]);
            if (plainClass) classScopes.push(_join(contextNamespace, plainClass));
        }
        scopes.unshift(...new Set(classScopes));
    }
    // using-directives make a namespace's members visible to unqualified
    // lookup of the first segment.
    for (const fact of usings) {
        if (fact.kind !== 'directive') continue;
        const target = fact.target.replace(/^::/, '');
        const factNamespace = _factContext(index, fact, origin).namespace;
        for (const prefix of _enclosingPrefixes(factNamespace)) {
            const full = _join(prefix, target);
            if (!scopes.includes(full)) scopes.push(full);
        }
    }
    const candidates = _typeCandidates(index, name);
    let matched = [];
    // Innermost scope wins (C++ unqualified and qualified lookup both stop
    // at the first scope that declares the name).
    for (const scope of scopes) {
        const want = _join(scope, qualifier);
        matched = candidates.filter(definition => {
            if (_scopeOf(index, definition) !== want) return false;
            // Block-scope aliases are visible only inside their own block.
            if (definition.lexicalScopeStartLine != null &&
                definition.lexicalScopeEndLine != null &&
                !(definition.type === 'type' && definition.enclosingType)) {
                return definition.file === context.file &&
                    definition.lexicalScopeStartLine <= context.line &&
                    context.line <= definition.lexicalScopeEndLine;
            }
            return true;
        });
        if (matched.length > 0) break;
    }
    if (matched.length === 0) {
        const full = segments.join('::');
        const scope = scopes.find(candidate => _inventory(index).has(_join(candidate, full)));
        if (scope !== undefined) {
            // `resolvedNamespace` (fix #393): the namespace the spelling
            // names from this scope (innermost first).
            return finish({ kind: 'namespace', namespace: full, resolvedNamespace: _join(scope, full) });
        }
        return finish({ kind: 'unknown', why: 'no-declaration' });
    }
    // Only declarations the translation unit can see are in scope. A
    // qualified spelling may still name a declaration behind an include
    // the resolver could not follow; that match is reported as not visible.
    const visible = matched.filter(definition =>
        definition.file === context.file || definition.file === origin ||
        visibleFiles?.has(definition.file));
    if (visible.length === 0 && !qualifier) {
        return finish({ kind: 'unknown', why: 'not-visible' });
    }
    const chosen = visible.length > 0 ? visible : matched;
    if (declarationsOnly) {
        return finish({ kind: 'type', declarations: chosen, visible: visible.length > 0 });
    }
    const classes = [];
    for (const definition of chosen) {
        if (definition.type !== 'type') {
            classes.push(definition);
            continue;
        }
        const target = resolveQualifier(index, {
            file: definition.file,
            line: definition.startLine,
            namespace: effectiveNamespace(index, definition),
            className: definition.enclosingType || null,
            origin,
        }, definition.aliasOf, visibleFiles, depth + 1);
        if (target.kind !== 'type') {
            return finish({ kind: 'unknown', why: `alias-${target.why || target.kind}` });
        }
        classes.push(...target.classes);
    }
    const unique = [...new Map(classes.map(definition =>
        [`${definition.file}\0${definition.startLine}\0${definition.name}`, definition])).values()]
        .sort((a, b) => codeUnitCompare(a.file, b.file) || a.startLine - b.startLine);
    return finish({ kind: 'type', classes: unique, visible: visible.length > 0 });
}

module.exports = {
    macroPrefixAt: _macroPrefixAt,
    globalQualifiedReaches,
    resetCppScope,
    includeClosure,
    macroNamespacePrefixAt: _macroPrefixAt,
    effectiveNamespace,
    namespaceAt,
    resolveQualifier,
    stripTemplateArguments,
};
