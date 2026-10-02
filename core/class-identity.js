/**
 * core/class-identity.js - Class DEFINITION identity for same-class resolution.
 *
 * `self.x()` / `this.x()` / `Self::x()` / `base.x()` bind through the
 * enclosing class DEFINITION, not its name: two unrelated classes named
 * `Chunks` in different modules, packages, namespaces or crates never share
 * members. Identity is modelled as the owning class definition:
 *
 *   classKey = file | namespace | enclosing lexical scope | name
 *
 * Same-scope redeclarations in one file (TypeScript class + interface
 * merging, Python if/else class variants) share a key, and so do the parts
 * of a C# `partial` type across files; function-local and nested same-name
 * classes do not.
 *
 * A member's owner resolves by lexical containment in its own file first,
 * then (members declared outside the type body: Rust `impl`, C++ out-of-line
 * definitions, JS prototype assignments) through the language's own
 * resolution: same file, same package directory, direct imports, same or
 * enclosing namespace, then a bounded transitive import walk. An owner that
 * cannot be resolved to exactly one definition has `key: null`; consumers
 * must treat it as unknown (route unverified), never as evidence for or
 * against a candidate.
 *
 * When only one class definition carries a name, name identity IS
 * definition identity and the name key `name:<Name>` is used without any
 * resolution work.
 *
 * Every derivation is memoized on the index and reset at every build/load.
 */

const path = require('path');
const { langTraits } = require('../languages');
const { splitParentList } = require('./graph-build');
const { genericArityOf } = require('../languages/utils');

const OWNER_CLASS_KINDS = new Set([
    'class', 'struct', 'interface', 'trait', 'enum', 'record', 'union',
]);
const TRANSITIVE_IMPORT_DEPTH = 4;
const TRANSITIVE_IMPORT_FILE_CAP = 2000;

function _state(index) {
    let state = index._classIdentity;
    if (!state) {
        state = {
            named: new Map(),
            classKeys: new WeakMap(),
            owners: new WeakMap(),
            resolved: new Map(),
            parents: new Map(),
            modules: new Map(),
            // fix #365: target-independent derivations repeated for every
            // same-name definition a caller query pins (stats --hot / repo).
            declaring: new WeakMap(), // definitions array -> Map<refKey|mode, result>
            descendants: new Map(),   // class key -> descendant key Set (default cap)
            // fix #389: certain owner definitions, same-file namesake counts,
            // names with function-local class definitions.
            ownerDefs: new WeakMap(),
            namesakes: new Map(),
            localNames: new Map(),
            // fix #390: class name -> Set of files declaring it without a
            // possible base elsewhere (see fileDeclaresClass).
            declaringFiles: new Map(),
        };
        index._classIdentity = state;
    }
    return state;
}

/** Reset every memoized identity derivation (called at build and cache load). */
function resetClassIdentity(index) {
    index._classIdentity = null;
}

function ownerNameOf(member) {
    if (!member) return null;
    if (member.className) return member.className;
    if (member.receiver) return String(member.receiver).replace(/^\*/, '') || null;
    return null;
}

/**
 * Innermost enclosing lexical scope of a class definition inside its own
 * file (another def whose range strictly contains it), 0 at module level.
 */
function _enclosingScopeStart(index, def) {
    const fileEntry = index.files.get(def.file);
    const symbols = fileEntry?.symbols;
    if (!Array.isArray(symbols)) return 0;
    let best = null;
    for (const s of symbols) {
        if (s === def || s.startLine == null || s.endLine == null) continue;
        if (s.startLine > def.startLine) continue;
        if (s.endLine < def.endLine) continue;
        if (s.startLine === def.startLine && s.endLine === def.endLine) continue;
        if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s;
    }
    return best ? best.startLine : 0;
}

/** Identity key of one class definition. */
function classKeyOf(index, def) {
    const state = _state(index);
    let key = state.classKeys.get(def);
    if (key === undefined) {
        // A `partial` type (C#) is ONE class declared across files: its
        // identity is the namespace + enclosing type + name, never the file.
        // Generic arity is part of the identity (fix #380): only parts with
        // the same type-parameter count merge (`partial class P<T>` never
        // joins `partial class P`).
        const arity = def.typeArity ? `|${def.typeArity}` : '';
        key = Array.isArray(def.modifiers) && def.modifiers.includes('partial')
            ? `partial|${def.namespace || ''}|${def.enclosingType || ''}|${def.name}${arity}`
            : `${def.file}|${def.namespace || ''}|${_enclosingScopeStart(index, def)}|${def.name}${arity}`;
        state.classKeys.set(def, key);
    }
    return key;
}

/**
 * Class definitions carrying `name`: { entries: [{def, key}], unique }.
 * `unique` is true when all of them share one identity (or there are none).
 */
function classDefsNamed(index, name) {
    const state = _state(index);
    let info = state.named.get(name);
    if (info) return info;
    const defs = (index.symbols.get(name) || [])
        .filter(d => d && d.name === name && OWNER_CLASS_KINDS.has(d.type) && d.file);
    // Keys are only needed to tell several same-name definitions apart.
    let entries = defs.length <= 1
        ? defs.map(def => ({ def, key: `name:${name}` }))
        : defs.map(def => ({ def, key: classKeyOf(index, def) }));
    const unique = new Set(entries.map(e => e.key)).size <= 1;
    // One identity (a single def, or the parts of one partial/merged type):
    // every consumer uses the name key, so comparisons stay consistent.
    if (unique) entries = entries.map(e => ({ def: e.def, key: `name:${name}` }));
    const hasScoped = defs.some(_functionLocal);
    info = { entries, unique, hasScoped };
    state.named.set(name, info);
    return info;
}

function _nameRef(name, info) {
    return { name, key: `name:${name}`, def: info.entries[0]?.def || null };
}

function _single(entries) {
    if (entries.length === 0) return null;
    const keys = new Set(entries.map(e => e.key));
    if (keys.size !== 1) return null;
    // Prefer a class-kind def as the representative (TS class + interface).
    const rep = entries.find(e => e.def.type === 'class') || entries[0];
    return rep;
}

function _contextNamespace(index, contextFile, contextNamespace) {
    if (contextNamespace != null) return contextNamespace;
    const symbols = index.files.get(contextFile)?.symbols;
    if (!Array.isArray(symbols)) return null;
    const withNs = symbols.find(s => s.namespace);
    return withNs ? withNs.namespace : null;
}

function _namespaceVisible(candidateNs, contextNs, separator) {
    if (!candidateNs) return false;
    if (candidateNs === contextNs) return true;
    return !!contextNs && contextNs.startsWith(candidateNs + separator);
}

function _transitiveImportMatch(index, contextFile, entries) {
    const candidateFiles = new Set(entries.map(e => e.def.file));
    const reached = [];
    const seen = new Set([contextFile]);
    let frontier = [...(index.importGraph.get(contextFile) || [])];
    for (let depth = 1; depth <= TRANSITIVE_IMPORT_DEPTH && frontier.length > 0; depth++) {
        const next = [];
        for (const file of frontier) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (seen.size > TRANSITIVE_IMPORT_FILE_CAP) return null;
            if (candidateFiles.has(file)) reached.push(file);
            for (const n of index.importGraph.get(file) || []) {
                if (!seen.has(n)) next.push(n);
            }
        }
        // Nearest reach wins: a deeper match never overrides a closer one.
        if (reached.length > 0) break;
        frontier = next;
    }
    if (reached.length === 0) return null;
    const files = new Set(reached);
    return _single(entries.filter(e => files.has(e.def.file)));
}

/**
 * Resolve a class NAME as seen from `contextFile` to one class definition.
 * @param {object} [opts] - { excludeKey, namespace }: excludeKey drops one
 *   definition (a class is never its own parent: `class Foo(base.Foo)`).
 * @returns {{name, key, def}} - key null when the name has several
 *   definitions and the language's resolution cannot pick exactly one.
 */
function resolveClassRef(index, name, contextFile, opts = {}) {
    const info = classDefsNamed(index, name);
    // Function-local classes (fix #381) are visible only inside their
    // declaring function: never from another file, and from their own file
    // only at a line inside that scope (when the caller knows the line).
    if (contextFile && info.hasScoped) {
        return _resolveScopedClassRef(index, name, contextFile, opts, info);
    }
    const excludeKey = opts.excludeKey || null;
    // A written generic arity (fix #380, trait genericArityIsIdentity) names
    // only the same-arity type: `: Outcome<T>` never resolves to `Outcome`.
    const arity = Number.isInteger(opts.arity) && info.entries.some(e =>
        (e.def.typeArity || 0) !== opts.arity) ? opts.arity : null;
    if (info.unique && arity == null && !(excludeKey && info.entries.some(e => e.key === excludeKey))) {
        return _nameRef(name, info);
    }
    const state = _state(index);
    const cacheKey = `${name}\0${contextFile || ''}\0${excludeKey || ''}\0${opts.namespace || ''}\0${arity ?? ''}`;
    if (state.resolved.has(cacheKey)) return state.resolved.get(cacheKey);
    let entries = excludeKey ? info.entries.filter(e => e.key !== excludeKey) : info.entries;
    if (arity != null) entries = entries.filter(e => (e.def.typeArity || 0) === arity);
    // No remaining project definition: the name denotes an external type
    // (never a same-class match); several unresolvable ones: unknown.
    const hit = _resolveAmong(index, entries, contextFile, opts.namespace);
    const ref = hit ? { name, key: hit.key, def: hit.def }
        : { name, key: null, def: null, external: entries.length === 0 };
    state.resolved.set(cacheKey, ref);
    return ref;
}

/**
 * A class declared in a function body (Python, JS/TS, Go): lexically scoped
 * and without an enclosing TYPE (C++ nested types carry their class range as
 * scope but are reachable through the enclosing type's name).
 */
function _functionLocal(def) {
    return def.lexicalScopeStartLine != null && !def.enclosingType;
}

function _resolveScopedClassRef(index, name, contextFile, opts, info) {
    const line = Number.isInteger(opts.line) ? opts.line : null;
    const state = _state(index);
    const cacheKey = `scoped\0${name}\0${contextFile}\0${opts.excludeKey || ''}\0${opts.namespace || ''}\0${opts.arity ?? ''}\0${line ?? ''}`;
    if (state.resolved.has(cacheKey)) return state.resolved.get(cacheKey);
    const inScope = e => line != null &&
        line >= e.def.lexicalScopeStartLine && line <= e.def.lexicalScopeEndLine;
    let entries = info.entries.filter(e => e.key !== opts.excludeKey);
    if (Number.isInteger(opts.arity)) {
        const sameArity = entries.filter(e => (e.def.typeArity || 0) === opts.arity);
        if (sameArity.length > 0) entries = sameArity;
    }
    let ref;
    const enclosing = entries.filter(e => _functionLocal(e.def) &&
        e.def.file === contextFile && inScope(e));
    if (enclosing.length > 0) {
        // The innermost enclosing scope's declaration shadows the rest.
        const width = e => e.def.lexicalScopeEndLine - e.def.lexicalScopeStartLine;
        const narrowest = Math.min(...enclosing.map(width));
        const hit = _single(enclosing.filter(e => width(e) === narrowest));
        ref = hit ? { name, key: hit.key, def: hit.def } : { name, key: null, def: null };
    } else {
        // Without a line, a same-file local class keeps its legacy
        // visibility (the file's own resolution decides); another file's
        // local class is never visible.
        const visible = entries.filter(e => !_functionLocal(e.def) ||
            (line == null && e.def.file === contextFile));
        const hit = _resolveAmong(index, visible, contextFile, opts.namespace);
        ref = hit ? { name, key: hit.key, def: hit.def }
            : { name, key: null, def: null, external: visible.length === 0 };
    }
    state.resolved.set(cacheKey, ref);
    return ref;
}

function _resolveAmong(index, entries, contextFile, namespace) {
    if (entries.length === 0) return null;
    const only = _single(entries);
    if (only) return only;
    if (!contextFile) return null;
    // 1. Same file (the module's own scope; nested/function-local variants
    //    are separate keys and stay ambiguous).
    const sameFile = entries.filter(e => e.def.file === contextFile);
    if (sameFile.length > 0) {
        const hit = _single(sameFile) ||
            _single(sameFile.filter(e => _enclosingScopeStart(index, e.def) === 0));
        return hit || null;
    }
    const language = index.files.get(contextFile)?.language;
    const traits = langTraits(language);
    // 2. Directory package scope (Go): every file of the package sees it.
    if (traits?.packageScope === 'directory') {
        const dir = path.dirname(contextFile);
        const samePkg = entries.filter(e => path.dirname(e.def.file) === dir);
        if (samePkg.length > 0) return _single(samePkg);
    }
    // 3. Direct imports.
    const imports = index.importGraph.get(contextFile);
    if (imports && imports.size > 0) {
        const imported = entries.filter(e => imports.has(e.def.file));
        if (imported.length > 1) {
            // fix #367i: several imported files define the name - keep the
            // one whose namespace the file actually imports (C# `using N1;`,
            // Java `import a.b.Base;`), not a sibling type reached through
            // another directive into the same file set (`using static
            // N2.Util` brings Util's members, never N2.Base).
            const modules = Object.keys(index.files.get(contextFile)?.moduleResolved || {});
            if (modules.length > 0) {
                const named = imported.filter(e => e.def.namespace &&
                    modules.some(mod => mod === e.def.namespace ||
                        mod === `${e.def.namespace}.${e.def.name}`));
                const hit = _single(named);
                if (hit) return hit;
            }
        }
        if (imported.length > 0) return _single(imported);
    }
    // 4. Same or enclosing namespace/package (Java packages, C#/C++
    //    namespaces), nearest first.
    const ns = _contextNamespace(index, contextFile, namespace);
    if (ns) {
        const separator = ns.includes('::') ? '::' : '.';
        const visible = entries.filter(e =>
            _namespaceVisible(e.def.namespace, ns, separator));
        if (visible.length > 0) {
            const longest = Math.max(...visible.map(e => e.def.namespace.length));
            return _single(visible.filter(e => e.def.namespace.length === longest));
        }
    }
    // 5. Re-exports: the nearest transitive import reach, when unique.
    return _transitiveImportMatch(index, contextFile, entries);
}

/**
 * Owning class definition of a member (method/field/constructor def, or a
 * caller symbol with className/receiver).
 * @returns {{name, key, def}|null} - null when the member has no owner.
 */
function ownerRefOf(index, member) {
    const name = ownerNameOf(member);
    if (!name) return null;
    const state = _state(index);
    const cached = state.owners.get(member);
    if (cached !== undefined) return cached;
    const info = classDefsNamed(index, name);
    let ref;
    if (info.unique) {
        ref = _nameRef(name, info);
    } else {
        // A Rust impl is outside the type's body. Its lexical scope still
        // fixes its owner: an impl of a block-local type must not borrow the
        // module-level namesake's member identity.
        const scopedOwner = info.hasScoped && ownerDefinitionOf(index, member);
        const scopedEntry = scopedOwner && info.entries.find(e => e.def === scopedOwner);
        // Lexical containment: the member is declared inside the type body.
        let best = scopedEntry || null;
        for (const e of info.entries) {
            if (scopedEntry) break;
            const d = e.def;
            if (d.file !== member.file) continue;
            if (d.startLine > member.startLine || d.endLine < member.startLine) continue;
            if (!best || (d.endLine - d.startLine) < (best.def.endLine - best.def.startLine)) best = e;
        }
        if (best) {
            ref = { name, key: best.key, def: best.def };
        } else {
            ref = resolveClassRef(index, name, member.file,
                { namespace: member.namespace || null });
        }
    }
    state.owners.set(member, ref);
    return ref;
}

/**
 * The class definition a member is declared in, when the language's own
 * scoping makes that certain (fix #389): the innermost same-name type body
 * in the member's file that contains it; for a member of a Rust `impl`
 * block, the type of that name the impl block itself sees (a block-local
 * struct when the impl sits in its block, else the file's single
 * module-level declaration). null when the owner is declared elsewhere or
 * cannot be decided.
 */
function ownerDefinitionOf(index, member) {
    const name = ownerNameOf(member);
    if (!name || !member?.file || member.startLine == null) return null;
    const state = _state(index);
    if (state.ownerDefs.has(member)) return state.ownerDefs.get(member);
    const defs = (index.symbols.get(name) || []).filter(d => d && d !== member &&
        d.name === name && OWNER_CLASS_KINDS.has(d.type) && d.file === member.file);
    const span = d => d.endLine - d.startLine;
    const containing = (list, line, endLine = line) => list.filter(d =>
        d.startLine <= line && d.endLine >= endLine);
    let result = null;
    const around = containing(defs, member.startLine, member.endLine ?? member.startLine);
    if (around.length > 0) {
        const narrowest = Math.min(...around.map(span));
        const best = around.filter(d => span(d) === narrowest);
        result = best.length === 1 ? best[0] : null;
    } else if (defs.length > 0) {
        const symbols = index.files.get(member.file)?.symbols || [];
        const impls = containing(symbols.filter(d => d.type === 'impl' &&
            String(d.typeName || d.name || '').replace(/<.*$/s, '').trim() === name),
        member.startLine, member.endLine ?? member.startLine);
        if (impls.length === 1) {
            const impl = impls[0];
            const scoped = defs.filter(d => d.lexicalScopeStartLine != null &&
                impl.startLine >= d.lexicalScopeStartLine && impl.startLine <= d.lexicalScopeEndLine);
            if (scoped.length > 0) {
                const narrowest = Math.min(...scoped.map(d => d.lexicalScopeEndLine - d.lexicalScopeStartLine));
                const best = scoped.filter(d => d.lexicalScopeEndLine - d.lexicalScopeStartLine === narrowest);
                result = best.length === 1 ? best[0] : null;
            } else {
                const moduleLevel = defs.filter(d => d.lexicalScopeStartLine == null);
                result = moduleLevel.length === 1 ? moduleLevel[0] : null;
            }
        }
    }
    state.ownerDefs.set(member, result);
    return result;
}

/**
 * Does any class definition of `name` live in a function body (fix #389)?
 * A cheap memoized gate for the function-local scoping rules.
 */
function hasFunctionLocalClass(index, name) {
    const state = _state(index);
    let has = state.localNames.get(name);
    if (has === undefined) {
        has = (index.symbols.get(name) || []).some(d => d && OWNER_CLASS_KINDS.has(d.type) && _functionLocal(d));
        state.localNames.set(name, has);
    }
    return has;
}

/**
 * Does `file` itself declare a class named `name` whose bases can only be
 * written there (fix #390)? Not a C# `partial` part (bases may sit in
 * another part) and not a C/C++ declaration (it may forward-declare a class
 * defined elsewhere). Memoized per build.
 */
function fileDeclaresClass(index, name, file) {
    const state = _state(index);
    let files = state.declaringFiles.get(name);
    if (!files) {
        files = new Set();
        for (const d of index.symbols.get(name) || []) {
            if (!d || d.name !== name || !d.file || !INHERITANCE_DECLARATION_KINDS.has(d.type)) continue;
            if (Array.isArray(d.modifiers) && d.modifiers.includes('partial')) continue;
            if (langTraits(index.files.get(d.file)?.language)?.textualIncludes) continue;
            files.add(d.file);
        }
        state.declaringFiles.set(name, files);
    }
    return files.has(file);
}

const INHERITANCE_DECLARATION_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'record', 'enum']);

/** How many class definitions named `name` one file declares (memoized). */
function _sameFileNamesakeCount(index, name, file) {
    const state = _state(index);
    let byFile = state.namesakes.get(name);
    if (!byFile) {
        byFile = new Map();
        for (const d of index.symbols.get(name) || []) {
            if (!d || d.name !== name || !OWNER_CLASS_KINDS.has(d.type) || !d.file) continue;
            byFile.set(d.file, (byFile.get(d.file) || 0) + 1);
        }
        state.namesakes.set(name, byFile);
    }
    return byFile.get(file) || 0;
}

/**
 * Do two members belong to different class definitions of one file, by
 * their certain owners (fix #389)? With `bIsOwner`, `b` is the class
 * definition itself. false when either owner is unknown or the owners are
 * in different files.
 */
function distinctOwnerDefinitions(index, a, b, bIsOwner = false) {
    // Only a file declaring two same-name types can hold two owners.
    const name = ownerNameOf(a);
    if (!name || !a?.file || _sameFileNamesakeCount(index, name, a.file) < 2) return false;
    const ownerA = ownerDefinitionOf(index, a);
    const ownerB = bIsOwner ? b : ownerDefinitionOf(index, b);
    // Declarations in two files may be one class in two configurations
    // (#385) or two parts of one type; only scopes of one file are decided
    // here.
    if (!ownerA || !ownerB || ownerA.file !== ownerB.file) return false;
    return classKeyOf(index, ownerA) !== classKeyOf(index, ownerB);
}

/**
 * Inheritance parents of a class reference, each resolved to a definition
 * from the child's own file (key null when unresolvable).
 */
function parentRefsOf(index, ref) {
    if (!ref) return [];
    const state = _state(index);
    const cacheKey = ref.key ? `k\0${ref.key}` : null;
    if (cacheKey && state.parents.has(cacheKey)) return state.parents.get(cacheKey);
    // Every declaration carrying this identity contributes its own base
    // clause: a C# partial type may declare its bases in one part only, and
    // TS class + interface merging unions both heritage lists.
    let decls = [];
    if (ref.key) {
        decls = classDefsNamed(index, ref.name).entries
            .filter(e => e.key === ref.key).map(e => e.def);
    }
    if (decls.length === 0 && ref.def) decls = [ref.def];
    const out = [];
    const seen = new Set();
    const push = parent => {
        const k = parent.key || `?${parent.name}${parent.external ? '!' : ''}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(parent);
    };
    if (decls.length === 0) {
        // Unknown or def-less owner (e.g. a JS constructor function):
        // name-level parents are the only information available.
        for (const parentName of index._getInheritanceParents(ref.name, null) || []) {
            if (parentName) push(resolveClassRef(index, parentName, null, {}));
        }
    }
    const anchored = (index.extendsGraph.get(ref.name) || [])
        .some(e => typeof e === 'object' && e.startLine != null);
    for (const decl of decls) {
        const contextFile = decl.file;
        let names = index._getInheritanceParentsAt(ref.name, decl.file, decl.startLine);
        if (names == null && !anchored) {
            // Legacy graph shape without per-def anchors.
            names = index._getInheritanceParents(ref.name, decl.file);
        }
        // The graph strips a qualifier it could resolve (`com.x.b1.Base` ->
        // `Base`); the declaration still spells it, and the qualifier is the
        // language's own disambiguation. Re-read it from the declared clause.
        const rawParents = decl.extends ? splitParentList(decl.extends) : [];
        const declRef = { name: ref.name, key: ref.key, def: decl };
        for (const parentName of names || []) {
            if (!parentName) continue;
            const qualified = parentName.includes('::') || parentName.includes('.');
            if (qualified && classDefsNamed(index, parentName).entries.length === 0) {
                push(_resolveQualifiedParent(index, parentName, contextFile, declRef));
                continue;
            }
            if (!qualified) {
                const spelled = rawParents.filter(raw =>
                    (raw.includes('::') || raw.includes('.')) &&
                    raw.split(raw.includes('::') ? '::' : '.').pop() === parentName);
                if (spelled.length === 1) {
                    const q = _resolveQualifiedParent(index, spelled[0], contextFile, declRef);
                    if (q.key || q.external) { push(q); continue; }
                }
            }
            // The file may bind the name to an out-of-project type that
            // shares it with a project type (fix #390: `import
            // org.hamcrest.TypeSafeMatcher; ... extends TypeSafeMatcher<T>`
            // beside a project TypeSafeMatcher): the language's own name
            // lookup decides, as for every written type (#371/#372).
            const denoted = externalParentDenotation(index, contextFile, parentName, decl.startLine);
            if (denoted) {
                push(denoted);
                continue;
            }
            push(resolveClassRef(index, parentName, contextFile, {
                excludeKey: parentName === ref.name ? ref.key : null,
                namespace: decl.namespace || null,
                ...(langTraits(index.files.get(contextFile)?.language)?.genericArityIsIdentity && {
                    arity: _writtenParentArity(decl, parentName),
                }),
            }));
        }
    }
    if (cacheKey) state.parents.set(cacheKey, out);
    return out;
}

/**
 * An unqualified base name the declaring file binds to an out-of-project
 * type (fix #390): an external reference (or an unresolved one when the
 * denotation is ambiguous), null when the name may denote a project type.
 * Only names a project class also carries need the check.
 */
function externalParentDenotation(index, contextFile, parentName, line) {
    if (!contextFile || classDefsNamed(index, parentName).entries.length === 0) return null;
    const { externalTypeDenotation } = require('./type-denotation');
    const denotation = externalTypeDenotation(index, contextFile, parentName, null, line);
    if (!denotation) return null;
    return denotation.certain === false
        ? { name: parentName, key: null, def: null }
        : { name: parentName, key: null, def: null, external: true };
}

/** Generic arity of the base `parentName` as the declaration spells it
 * (fix #380); undefined when the clause does not spell it exactly once. */
function _splitTopLevel(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    const value = String(text || '');
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        else if (ch === '>' || ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
            out.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(value.slice(start).trim());
    return out.filter(Boolean);
}

function _writtenParentArity(decl, parentName) {
    const raws = [
        ..._splitTopLevel(decl.extends),
        ...(Array.isArray(decl.implements) ? decl.implements : _splitTopLevel(decl.implements)),
    ].filter(raw => String(raw).replace(/<.*$/s, '').trim().split(/::|\./).pop() === parentName);
    if (raws.length !== 1) return undefined;
    const arity = genericArityOf(raws[0]);
    return Number.isInteger(arity) ? arity : undefined;
}

/**
 * A parent spelled with a qualifier the inheritance graph kept verbatim
 * (`base.Chunks`, `pkg::Base`, `Ns.Base`). Structural languages resolve the
 * qualifier through the file's own import bindings (module or from-imported
 * submodule); nominal ones through the declared namespace of the candidates.
 * Returns a reference named by the TERMINAL type name (members record the
 * bare class name), key null when the qualifier does not pin one definition.
 */
function _resolveQualifiedParent(index, parentName, contextFile, childRef) {
    const separator = parentName.includes('::') ? '::' : '.';
    const pieces = parentName.split(separator).filter(Boolean);
    const terminal = pieces.pop();
    const qualifier = pieces.join(separator);
    const info = classDefsNamed(index, terminal);
    let entries = info.entries;
    if (terminal === childRef.name && childRef.key) entries = entries.filter(e => e.key !== childRef.key);
    if (entries.length === 0) return { name: terminal, key: null, def: null, external: true };
    const unknown = { name: terminal, key: null, def: null };
    const fileEntry = contextFile ? index.files.get(contextFile) : null;
    if (!fileEntry) return unknown;
    const traits = langTraits(fileEntry.language);
    let hit = null;
    if (traits?.typeSystem === 'structural') {
        if (fileEntry.language === 'python') {
            const { pythonModulePath, pythonModuleScope, pythonModuleTypes } = require('./python-modules');
            const memo = _state(index).modules;
            if (!pythonModuleScope(index, contextFile, qualifier, childRef.def, memo)) return unknown;
            const modules = pythonModulePath(index, contextFile, qualifier, memo);
            if (!modules || modules.unknown) return unknown;
            if (modules.files.length === 0) return { ...unknown, external: true };
            const visible = entries.filter(e => !_functionLocal(e.def));
            const matches = modules.files.map(file => {
                const definitions = new Set(pythonModuleTypes(index, file, terminal, visible.map(e => e.def)));
                return _single(visible.filter(e => definitions.has(e.def)));
            });
            hit = matches[0];
            if (!hit || matches.some(match => match?.key !== hit.key)) return unknown;
            return { name: terminal, key: hit.key, def: hit.def };
        }
        const binding = (fileEntry.importBindings || []).find(b => (b.alias || b.name) === pieces[0]);
        const specs = [];
        if (binding) {
            specs.push(binding.module);
            if (binding.kind === 'from') specs.push(`${binding.module}.${binding.name}`);
        }
        specs.push(qualifier);
        const moduleFiles = [];
        for (const spec of specs) {
            const rel = spec && fileEntry.moduleResolved?.[spec];
            if (rel) moduleFiles.push(path.join(index.root, rel));
        }
        for (const moduleFile of moduleFiles) {
            const direct = entries.filter(e => e.def.file === moduleFile);
            hit = direct.length > 0 ? _single(direct) : _transitiveImportMatch(index, moduleFile, entries);
            if (hit) break;
        }
        // An import binding of an external module (fix #381): `class
        // Channel(amqp.Channel)` under `import amqp` names amqp's class,
        // never a same-name project class.
        if (!hit && binding && moduleFiles.length === 0) {
            const { _unresolvedModuleIsGap } = require('./callers');
            if (!_unresolvedModuleIsGap(index, binding.module, binding)) {
                return { name: terminal, key: null, def: null, external: true };
            }
        }
    } else {
        // The qualifier names the declaring namespace/package, or the
        // enclosing TYPE of a nested type (`RecyclerPool.ThreadLocalPoolBase`,
        // `Outer::Inner`), optionally itself namespace-qualified (fix #376).
        const qualifierMatches = owner => owner && (owner === qualifier ||
            owner.endsWith(`${separator}${qualifier}`) ||
            qualifier.endsWith(`${separator}${owner}`));
        const matches = entries.filter(e => {
            const namespace = String(e.def.namespace || '');
            const enclosing = String(e.def.enclosingType || '');
            if (qualifierMatches(namespace)) return true;
            if (!enclosing) return false;
            return qualifierMatches(namespace ? `${namespace}${separator}${enclosing}` : enclosing) ||
                qualifier === enclosing;
        });
        hit = _single(matches);
    }
    return hit ? { name: terminal, key: hit.key, def: hit.def } : unknown;
}

/**
 * Every declared supertype of a class reference: the inheritance parents
 * (parentRefsOf) plus, with `implements`, the interfaces its declarations
 * list in a separate implements clause (Java/TypeScript), each resolved from
 * the declaring file with the same qualifier discipline. Used by rename
 * closure (fix #376), which must follow interface slots the dispatch graph
 * leaves out.
 */
function supertypeRefsOf(index, ref, opts = {}) {
    const parents = parentRefsOf(index, ref);
    if (!opts.implements || !ref) return parents;
    let decls = [];
    if (ref.key) {
        decls = classDefsNamed(index, ref.name).entries
            .filter(e => e.key === ref.key).map(e => e.def);
    }
    if (decls.length === 0 && ref.def) decls = [ref.def];
    const out = [...parents];
    const seen = new Set(parents.map(p => p.key || `?${p.name}${p.external ? '!' : ''}`));
    for (const decl of decls) {
        const implemented = Array.isArray(decl.implements) ? decl.implements
            : decl.implements ? splitParentList(decl.implements) : [];
        for (const raw of implemented) {
            const spelled = String(raw).replace(/<.*$/s, '').replace(/\s+/g, '').trim();
            if (!spelled) continue;
            const qualified = spelled.includes('::') || spelled.includes('.');
            const bare = spelled.split(spelled.includes('::') ? '::' : '.').pop();
            let parent;
            if (classDefsNamed(index, bare).entries.length === 0) {
                parent = { name: bare, key: null, def: null, external: true };
            } else if (qualified) {
                parent = _resolveQualifiedParent(index, spelled, decl.file,
                    { name: ref.name, key: ref.key, def: decl });
            } else {
                parent = externalParentDenotation(index, decl.file, bare, decl.startLine) ||
                    resolveClassRef(index, bare, decl.file, {
                        excludeKey: bare === ref.name ? ref.key : null,
                        namespace: decl.namespace || null,
                    });
            }
            const k = parent.key || `?${parent.name}${parent.external ? '!' : ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ ...parent, viaImplements: true });
        }
    }
    return out;
}

function _refVisitKey(ref) {
    return ref.key || `?${ref.name}`;
}

/**
 * Is member `m` owned by class reference `ref`?
 * @returns {'yes'|'no'|'maybe'}
 */
function ownedBy(index, member, ref) {
    const name = ownerNameOf(member);
    if (!name || !ref || name !== ref.name) return 'no';
    const own = ownerRefOf(index, member);
    if (!own?.key || !ref.key) return 'maybe';
    return own.key === ref.key ? 'yes' : 'no';
}

/**
 * Find the class (the caller's own, or the nearest ancestor through resolved
 * parents) that declares a member among `definitions`.
 * @param {object} startRef - caller's owning class reference
 * @param {object[]} definitions - candidate member defs
 * @param {object} [opts] - { parentsOnly }: super/base calls skip startRef
 * @returns {{ref, uncertain, members}|null}
 */
function findDeclaringClass(index, startRef, definitions, opts = {}) {
    if (!startRef) return null;
    // A resolved start class fixes the whole walk: memoize per definitions
    // list (the symbol table's array for the name) and class key.
    if (!startRef.key || !Array.isArray(definitions)) {
        return _findDeclaringClass(index, startRef, definitions, opts);
    }
    const state = _state(index);
    let byRef = state.declaring.get(definitions);
    if (!byRef) { byRef = new Map(); state.declaring.set(definitions, byRef); }
    const memoKey = `${opts.parentsOnly ? 'p' : 'o'}\0${startRef.key}`;
    if (byRef.has(memoKey)) return byRef.get(memoKey);
    const result = _findDeclaringClass(index, startRef, definitions, opts);
    byRef.set(memoKey, result);
    return result;
}

function _findDeclaringClass(index, startRef, definitions, opts) {
    const check = ref => {
        let uncertain = false;
        const members = [];
        for (const d of definitions) {
            const v = ownedBy(index, d, ref);
            if (v === 'no') continue;
            if (v === 'maybe') uncertain = true;
            members.push(d);
        }
        return members.length > 0 ? { ref, uncertain, members } : null;
    };
    const visited = new Set([_refVisitKey(startRef)]);
    if (!opts.parentsOnly) {
        const own = check(startRef);
        if (own) return own;
    }
    const queue = [...parentRefsOf(index, startRef)];
    while (queue.length > 0) {
        const ref = queue.shift();
        if (ref.external) continue;
        const vk = _refVisitKey(ref);
        if (visited.has(vk)) continue;
        visited.add(vk);
        const hit = check(ref);
        if (hit) {
            // An unresolved parent can only yield an uncertain match.
            if (!ref.key) hit.uncertain = true;
            return hit;
        }
        if (ref.key || ref.def) {
            for (const p of parentRefsOf(index, ref)) {
                if (!visited.has(_refVisitKey(p))) queue.push(p);
            }
        } else {
            // Unresolved parent name: follow name-level parents so deeper
            // ancestors still surface (their matches stay uncertain).
            for (const p of index._getInheritanceParents(ref.name, null) || []) {
                const pr = { name: p, key: null, def: null };
                if (!visited.has(_refVisitKey(pr))) queue.push(pr);
            }
        }
    }
    return null;
}

/**
 * Relationship of class reference `ref` to the owners of `targetDefs`:
 * 'same' (identical definition), 'ancestor' (ref is a transitive ancestor of
 * a target owner through resolved parents), 'maybe' (a name-equal owner or
 * ancestor could not be resolved to a definition), or 'unrelated'.
 */
function relationToTargets(index, ref, targetDefs) {
    let maybe = false;
    let ancestor = false;
    for (const td of targetDefs) {
        const tRef = ownerRefOf(index, td);
        if (!tRef) continue;
        if (tRef.name === ref.name) {
            if (tRef.key && ref.key && tRef.key === ref.key) return 'same';
            if (!tRef.key || !ref.key) maybe = true;
        }
        const visited = new Set([_refVisitKey(tRef)]);
        const queue = [...parentRefsOf(index, tRef)];
        while (queue.length > 0 && !ancestor) {
            const p = queue.shift();
            if (p.external) continue;
            const vk = _refVisitKey(p);
            if (visited.has(vk)) continue;
            visited.add(vk);
            if (p.name === ref.name) {
                if (p.key && ref.key && p.key === ref.key) { ancestor = true; break; }
                if (!p.key || !ref.key) maybe = true;
            }
            if (p.key || p.def) {
                queue.push(...parentRefsOf(index, p));
            } else {
                for (const n of index._getInheritanceParents(p.name, null) || []) {
                    queue.push({ name: n, key: null, def: null });
                }
            }
        }
    }
    if (ancestor) return 'ancestor';
    return maybe ? 'maybe' : 'unrelated';
}

/**
 * Is class reference `ref` a target owner or a descendant of one, by
 * definition identity (fix #390)? Walks `ref`'s resolved ancestry upward:
 * 'yes' when it reaches a target owner's definition, 'maybe' when a same-name
 * owner or ancestor on the way cannot be resolved, 'no' otherwise. A class
 * named like a subclass of the target elsewhere (`org.x.MoneyTest` beside
 * `junit.x.MoneyTest extends TestCase`) is 'no'.
 */
function descendsFromTargets(index, ref, targetDefs) {
    if (!ref) return 'maybe';
    const targets = [];
    for (const td of targetDefs || []) {
        const tRef = ownerRefOf(index, td);
        if (tRef) targets.push(tRef);
    }
    if (targets.length === 0) return 'maybe';
    let maybe = false;
    const matches = candidate => {
        for (const t of targets) {
            if (t.name !== candidate.name) continue;
            if (t.key && candidate.key && t.key === candidate.key) return true;
            if (!t.key || !candidate.key) maybe = true;
        }
        return false;
    };
    if (matches(ref)) return 'yes';
    const visited = new Set([_refVisitKey(ref)]);
    const queue = [...parentRefsOf(index, ref)];
    while (queue.length > 0) {
        const parent = queue.shift();
        if (parent.external) continue;
        const vk = _refVisitKey(parent);
        if (visited.has(vk)) continue;
        visited.add(vk);
        if (matches(parent)) return 'yes';
        if (parent.key || parent.def) {
            queue.push(...parentRefsOf(index, parent));
        } else {
            for (const name of index._getInheritanceParents(parent.name, null) || []) {
                queue.push({ name, key: null, def: null });
            }
        }
    }
    return maybe ? 'maybe' : 'no';
}

/**
 * Keys of a class definition and its transitive project descendants
 * (children resolved back through their own parent refs, so a same-name
 * class elsewhere never counts). Null when the reference is unresolved.
 */
function descendantKeys(index, ref, cap = 256) {
    if (!ref?.key) return null;
    if (cap !== 256) return _descendantKeys(index, ref, cap);
    const state = _state(index);
    let keys = state.descendants.get(ref.key);
    if (!keys) {
        keys = _descendantKeys(index, ref, cap);
        state.descendants.set(ref.key, keys);
    }
    return keys;
}

function _descendantKeys(index, ref, cap) {
    const out = new Set([ref.key]);
    const queue = [ref];
    while (queue.length > 0 && out.size < cap) {
        const cur = queue.shift();
        for (const child of index.extendedByGraph?.get(cur.name) || []) {
            const cName = typeof child === 'string' ? child : child.name;
            if (!cName) continue;
            const info = classDefsNamed(index, cName);
            const candidates = info.entries.filter(e =>
                typeof child === 'string' || !child.file || e.def.file === child.file);
            for (const e of candidates) {
                if (out.has(e.key)) continue;
                const childRef = { name: cName, key: e.key, def: e.def };
                const extendsCur = parentRefsOf(index, childRef).some(p =>
                    p.name === cur.name && !p.external &&
                    (!p.key || p.key === cur.key));
                if (!extendsCur) continue;
                out.add(e.key);
                queue.push(childRef);
            }
        }
    }
    return out;
}

/**
 * Python MRO trap (#202b guard) by definition identity: do the matched class
 * and a target owner share a project descendant? A descendant of BOTH sides
 * can route `self.m()` in the matched class to the target through its MRO.
 * Matched BELOW the target is not a trap (the subclass override wins).
 * Unresolved identities answer true (conservative: never licenses exclusion).
 */
function shareDescendant(index, matchedRef, targetDefs) {
    const mine = descendantKeys(index, matchedRef);
    if (!mine) return true;
    for (const td of targetDefs) {
        const tRef = ownerRefOf(index, td);
        if (!tRef) continue;
        const theirs = descendantKeys(index, tRef);
        if (!theirs) return true;
        if (theirs.has(matchedRef.key)) continue;
        for (const k of theirs) if (mine.has(k)) return true;
    }
    return false;
}

module.exports = {
    OWNER_CLASS_KINDS,
    resetClassIdentity,
    ownerNameOf,
    classKeyOf,
    classDefsNamed,
    resolveClassRef,
    resolveQualifiedClassRef: _resolveQualifiedParent,
    ownerRefOf,
    ownerDefinitionOf,
    distinctOwnerDefinitions,
    hasFunctionLocalClass,
    fileDeclaresClass,
    parentRefsOf,
    supertypeRefsOf,
    ownedBy,
    findDeclaringClass,
    relationToTargets,
    descendsFromTargets,
    descendantKeys,
    shareDescendant,
};
