/**
 * core/member-signatures.js - Is a method a deriving class declares the
 * method it inherits under that name, and which class does a written base
 * name denote?
 *
 * Where a language overloads, a method is the inherited one only when its
 * parameters have the same types, and a type is what its name denotes
 * where it is written, never how it is spelled: `int` and `System.Int32`
 * are one type, `int` and `int?` two, `Left.Token` and `Right.Token` two,
 * `Token` whichever of them the file's imports say.
 *
 * The readers give each parameter's type as it is written in the syntax
 * tree (`params`). This module resolves the names by the language's own
 * lookup (`typeNameScoping`): the method's and the classes' type
 * parameters, the member types of the classes around the site (their own
 * and the ones they inherit), then
 *   - 'package-on-demand' (JLS 6.4.1): the file's own types and
 *     single-type imports, the package, on-demand imports with the
 *     implicit one;
 *   - 'namespace-usings' (C# spec, namespace and type names): for each
 *     enclosing namespace from the innermost out, its members, its using
 *     aliases, the types its using directives bring; global usings and
 *     project-file <Using> items at the outermost.
 *
 * The answer has three values. 'same' and 'different' are proofs over
 * what the project's source declares and the file imports. 'unknown' is
 * everything else: a type parameter of a class (its argument is written
 * in a base list this does not substitute), a name only a package outside
 * the project can declare, a name an unread base class may declare inside
 * itself, an alias this does not read. Nothing is decided by spelling
 * except where spelling is proof: two names that are no alias and differ
 * in their last part are two types, and one spelling read in one scope is
 * one type.
 *
 * Assumed, and said in the documentation: the code compiles (a name has
 * one meaning where it is used), and the packages and namespaces the
 * project declares types in, and the namespaces around those, hold the
 * types its source declares.
 */

'use strict';

const { langTraits } = require('../languages');
const { csharpUsings, csharpDeclaredNames, projectNamespaces, siteNamespaceOf } = require('./type-denotation');

const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'delegate']);
const VALUE_KINDS = new Set(['struct', 'enum']);
const REFERENCE_KINDS = new Set(['class', 'interface', 'delegate']);

const SAME = 'same';
const DIFFERENT = 'different';
const UNKNOWN = 'unknown';

/** Several answers that must all hold: one 'different' decides, else one 'unknown'. */
function every(answers) {
    if (answers.includes(DIFFERENT)) return DIFFERENT;
    return answers.includes(UNKNOWN) ? UNKNOWN : SAME;
}

const lastOf = dotted => String(dotted).split('.').pop();

function kindOf(term) {
    if (term.open) return 'open';
    if (term.array) return 'array';
    if (term.nullable) return 'nullable';
    if (term.tuple) return 'tuple';
    if (term.pointer) return 'pointer';
    if (term.generic) return 'generic';
    if (term.variable != null) return 'variable';
    return 'name';
}

/** Is every entry of one list in the other? */
const within = (a, b) => a.every(value => b.includes(value));

/**
 * Do two unresolved names stand in one scope: the same package or
 * namespace, the same bindings for the name, and on-demand imports (using
 * directives) of packages outside the project of which one file's are
 * all among the other's. A name that compiles has one provider among
 * them; the file with more sees the same one. (A package the project
 * declares types in holds none of that name, or the name was resolved.)
 */
function sameScope(a, b) {
    return !!a && !!b && a.base === b.base && (within(a.usings, b.usings) || within(b.usings, a.usings));
}

/** Two resolved names. */
function compareNames(a, b) {
    // A name an unread base class may declare inside itself: what was
    // found past that class holds only if the class declares none, and the
    // same spelling past the same classes is one type either way.
    if (a.unless || b.unless) {
        if (a.last !== b.last) return DIFFERENT;
        return a.unless === b.unless && a.text === b.text && a.fq === b.fq ? SAME : UNKNOWN;
    }
    if (a.fq === b.fq) return SAME;
    // A member type can be written through a class that inherits it: two
    // qualified spellings that are not canonical may be one type.
    if ((a.canonical === false || b.canonical === false) && a.last === b.last) return UNKNOWN;
    return DIFFERENT;
}

/** One side is a name that was not resolved. */
function compareOpen(a, b) {
    if (a.open && b.open) {
        if (a.named && b.named && a.last !== b.last) return DIFFERENT;
        return a.text === b.text && sameScope(a.scope, b.scope) ? SAME : UNKNOWN;
    }
    const [open, other] = a.open ? [a, b] : [b, a];
    // A type parameter of a class, an alias that is not read: any type.
    if (!open.named) return UNKNOWN;
    switch (kindOf(other)) {
        case 'name':
            if (open.last !== other.last) return DIFFERENT;
            // A name the file's on-demand imports (using directives) bring
            // and nothing nearer declares: the type of that name in one of
            // the imported packages is it, for a second provider would
            // leave the name ambiguous. Both files compile together.
            if (open.simple && open.scope && !open.scope.guarded && !other.project && !other.unless &&
                open.scope.unit != null && open.scope.unit === other.unit &&
                open.scope.providers.some(provider => `${provider}.${open.last}` === other.fq)) return SAME;
            return UNKNOWN;
        case 'nullable':
            // `T?` of a type of unknown kind may be T itself.
            if (other.maybe) return compareTypes(open, other.nullable) === DIFFERENT ? DIFFERENT : UNKNOWN;
            return DIFFERENT;
        case 'generic':
            // A name written without type arguments is no type that takes
            // some; one that takes none may be the type inside generic
            // types that this one is.
            return open.last !== other.generic.last ? DIFFERENT : UNKNOWN;
        default:
            // A declared type is no array, tuple, pointer or type parameter.
            return DIFFERENT;
    }
}

/**
 * Two resolved parameter types: 'same', 'different' or 'unknown'.
 */
function compareTypes(a, b) {
    if (!a || !b) return UNKNOWN;
    if (a.open || b.open) return compareOpen(a, b);
    const ka = kindOf(a);
    const kb = kindOf(b);
    if (ka !== kb) {
        // `T?` of a type of unknown kind may be T itself.
        if (ka === 'nullable' && a.maybe) return compareTypes(a.nullable, b) === DIFFERENT ? DIFFERENT : UNKNOWN;
        if (kb === 'nullable' && b.maybe) return compareTypes(a, b.nullable) === DIFFERENT ? DIFFERENT : UNKNOWN;
        // A nullable value or a tuple is a generic type of the platform
        // written another way: a generic type the project does not
        // declare may be it.
        const generic = ka === 'generic' ? a : kb === 'generic' ? b : null;
        const written = generic === a ? kb : ka;
        if (generic && (written === 'nullable' || written === 'tuple') &&
            (generic.generic.open || generic.generic.project !== true)) return UNKNOWN;
        return DIFFERENT;
    }
    switch (ka) {
        case 'name': return compareNames(a, b);
        case 'variable': return a.variable === b.variable ? SAME : DIFFERENT;
        case 'array': return a.rank !== b.rank ? DIFFERENT : compareTypes(a.array, b.array);
        case 'nullable': return compareTypes(a.nullable, b.nullable);
        case 'pointer': return compareTypes(a.pointer, b.pointer);
        case 'tuple':
            if (a.tuple.length !== b.tuple.length) return DIFFERENT;
            return every(a.tuple.map((each, i) => compareTypes(each, b.tuple[i])));
        case 'generic': {
            const head = compareTypes(a.generic, b.generic);
            if (head === DIFFERENT) return DIFFERENT;
            // The type's own arguments, then those of the types around it.
            const ownA = a.args.slice(a.args.length - a.own);
            const ownB = b.args.slice(b.args.length - b.own);
            if (ownA.length !== ownB.length) return DIFFERENT;
            const own = every(ownA.map((each, i) => compareTypes(each, ownB[i])));
            if (own === DIFFERENT) return DIFFERENT;
            const aroundA = a.args.slice(0, a.args.length - a.own);
            const aroundB = b.args.slice(0, b.args.length - b.own);
            // Two names that may be one type through a class that inherits
            // it, or a name that leaves the surrounding arguments unsaid:
            // those arguments cannot be set side by side.
            if (head !== SAME || !a.exact || !b.exact) {
                return a.exact && b.exact && aroundA.length === 0 && aroundB.length === 0 ? every([head, own]) : UNKNOWN;
            }
            if (aroundA.length !== aroundB.length) return UNKNOWN;
            return every([own, ...aroundA.map((each, i) => compareTypes(each, aroundB[i]))]);
        }
        default: return UNKNOWN;
    }
}

/**
 * @param {object} index
 * @param {object} world - what the test model knows of classes:
 *   `classes(filePath)` the reader's class rows of a file,
 *   `parents(filePath, cls)` the class each base of a class row denotes
 *   ({ filePath, cls }) or an opaque entry, `unitOf(filePath)` what
 *   the file is compiled with (two files of one unit see one set of
 *   packages), or null, and `aliasTerm(filePath, line)` the type a using
 *   alias directive on that line writes, as the reader gives it.
 */
function createSignatures(index, world) {
    const memo = new Map();
    const relations = new Map();
    const remember = (key, compute) => {
        if (memo.has(key)) return memo.get(key);
        const value = compute();
        memo.set(key, value);
        return value;
    };
    const languageOf = filePath => index.files.get(filePath)?.language;

    /** The project's type declarations of a simple name, in one language. */
    const typeDefs = (name, language) => remember(`defs\0${language}\0${name}`, () =>
        (index.symbols.get(name) || []).filter(def => def && def.name === name && TYPE_KINDS.has(def.type) &&
            def.file && languageOf(def.file) === language));

    const identity = language => !!langTraits(language)?.genericArityIsIdentity;
    const arityOf = def => def.typeArity || 0;
    /** `Name` or, where arity is part of a type's identity and it takes type arguments, `Name\`2`. */
    const spelled = (name, arity, language) => (identity(language) && arity ? `${name}\`${arity}` : name);
    /** Does one declaration stand inside another (by offsets where both have them: two can share a line)? */
    const inside = (inner, outer) => (inner.sourceSpan && outer.sourceSpan
        ? outer.sourceSpan.start <= inner.sourceSpan.start && outer.sourceSpan.end >= inner.sourceSpan.end
        : outer.startLine <= inner.startLine && (outer.endLine ?? outer.startLine) >= (inner.endLine ?? inner.startLine));
    /** The type declarations a declaration stands in, outermost first (a name alone where one is not read). */
    const ownersOf = def => {
        if (!def.enclosingType) return [];
        return remember(`owners\0${def.file}\0${def.startLine}\0${def.sourceSpan ? def.sourceSpan.start : ''}\0${def.name}`, () => {
            const around = (index.symbols.get(def.enclosingType) || [])
                .filter(other => other !== def && TYPE_KINDS.has(other.type) && other.file === def.file && inside(def, other))
                .sort((a, b) => (b.sourceSpan && a.sourceSpan ? b.sourceSpan.start - a.sourceSpan.start : b.startLine - a.startLine))[0];
            return around ? [...ownersOf(around), around] : [{ name: def.enclosingType }];
        });
    };
    /**
     * A declaration's canonical name: namespace (package), the types around
     * it, its name; each type with its arity where that is part of its
     * identity (`N.Outer\`1.Inner\`1` is not `N.Outer\`2.Inner`).
     */
    const ownerFqOf = def => {
        const language = languageOf(def.file);
        return [def.namespace, ...ownersOf(def).map(owner => spelled(owner.name, arityOf(owner), language))].filter(Boolean).join('.');
    };
    const fqOf = def => [ownerFqOf(def), spelled(def.name, arityOf(def), languageOf(def.file))].filter(Boolean).join('.');
    /** How many type arguments the types around a declaration take together. */
    const outerArityOf = def => ownersOf(def).reduce((sum, owner) => sum + arityOf(owner), 0);
    /** Does a declaration take as many type arguments as were written? Compared only where arity is identity. */
    const arityFits = (def, arity, language) => arity == null || !identity(language) || arityOf(def) === arity;
    const distinct = defs => [...new Map(defs.map(def => [fqOf(def), def])).values()];

    const defOfRow = (filePath, cls) => (index.symbols.get(cls.name) || []).find(def =>
        def.file === filePath && def.startLine === cls.startLine && TYPE_KINDS.has(def.type)) || null;
    const rowOfDef = def => (world.classes(def.file) || []).find(cls =>
        cls.name === def.name && cls.startLine === def.startLine) || null;

    /**
     * The member types of one name a type has: its own (which hide the
     * rest), else the ones it inherits. Java inherits them from the
     * superclass and the superinterfaces; C# from the base class only.
     * `tags` name the bases that are not read: each may declare one.
     */
    const memberTypes = (def, name, trail = new Set()) => {
        const language = languageOf(def.file);
        const key = `members\0${fqOf(def)}\0${name}`;
        if (memo.has(key)) return memo.get(key);
        if (trail.has(key)) return { found: [], tags: [] };
        const mine = fqOf(def);
        const own = typeDefs(name, language).filter(other => other.enclosingType === def.name && ownerFqOf(other) === mine);
        let answer;
        if (own.length > 0) {
            answer = { found: distinct(own), tags: [], own: true };
        } else {
            const found = [];
            const tags = new Set();
            const next = new Set(trail).add(key);
            const interfacesPass = langTraits(language)?.typeNameScoping === 'package-on-demand';
            // Every part of a partial type writes bases of its own.
            const parts = typeDefs(def.name, language).filter(other => fqOf(other) === fqOf(def));
            for (const part of parts) {
                const row = rowOfDef(part);
                if (!row) {
                    // Its bases are not read here.
                    if ([part.extends, part.implements].flat().filter(Boolean).length > 0) tags.add(`${fqOf(part)}>?`);
                    continue;
                }
                world.parents(part.file, row).forEach(({ written, node }, i) => {
                    if (node.opaque) {
                        if (interfacesPass || i === 0) tags.add(`${fqOf(part)}>${written}`);
                        return;
                    }
                    const parent = defOfRow(node.filePath, node.cls);
                    if (!parent) {
                        tags.add(`${fqOf(part)}>${written}`);
                        return;
                    }
                    if (!interfacesPass && (i > 0 || parent.type === 'interface')) return;
                    const above = memberTypes(parent, name, next);
                    // A private member type is not inherited.
                    found.push(...above.found.filter(other => !(other.modifiers || []).includes('private')));
                    for (const tag of above.tags) tags.add(tag);
                });
            }
            answer = { found: distinct(found), tags: [...tags].sort() };
        }
        if (trail.size === 0) memo.set(key, answer);
        return answer;
    };

    /** The project type a canonical name is, or null. */
    const byCanonical = (fq, language) => typeDefs(lastOf(fq), language).find(def => fqOf(def) === fq) || null;

    /** Walk the member types a qualified name goes through after its head. */
    const descend = (def, rest, language, implicit = false) => {
        let current = def;
        let through = implicit;
        const tags = new Set();
        for (const segment of rest) {
            const below = memberTypes(current, segment.name);
            const fits = below.found.filter(other => arityFits(other, segment.arity, language));
            if (fits.length !== 1) {
                for (const tag of below.tags) tags.add(tag);
                return { open: true, tags: [...tags] };
            }
            // Written through a class that inherits it: the type arguments
            // written on that class are not the declaring type's.
            if (!below.own) through = true;
            current = fits[0];
        }
        return { def: current, ...(through && { implicit: true }) };
    };

    /**
     * A dotted name read from the root: the longest package (namespace)
     * the project declares a type of that name in, then the types inside
     * it. Null when the project declares none.
     */
    const fromRoot = (segments, language) => {
        for (let k = segments.length - 1; k >= 0; k--) {
            const namespace = segments.slice(0, k).map(segment => segment.name).join('.');
            const top = typeDefs(segments[k].name, language).filter(def => !def.enclosingType &&
                (def.namespace || '') === namespace && arityFits(def, segments[k].arity, language));
            if (top.length === 0) continue;
            return descend(top[0], segments.slice(k + 1), language);
        }
        return null;
    };

    /** A written name, each part with the number of type arguments written on it where arity is identity. */
    const dotted = (segments, language) => segments.map(segment => spelled(segment.name, segment.arity || 0, language)).join('.');

    /** The roots a qualified name can start at without naming a type: the platform's, the project's packages, the file's imports. */
    const rootsOf = (filePath, language) => remember(`roots\0${filePath}`, () => {
        const roots = new Set(langTraits(language)?.standardPathRoots || []);
        for (const namespace of projectNamespaces(index, language)) roots.add(String(namespace).split('.')[0]);
        for (const detail of index.files.get(filePath)?.importDetails || []) {
            if (detail.module) roots.add(String(detail.module).replace(/^global::/, '').split('.')[0]);
        }
        return roots;
    });

    // ---- JLS 6.4.1 ---------------------------------------------------------

    const javaFileLevel = (site, segments, language) => {
        const [head, ...rest] = segments;
        const name = head.name;
        const entry = index.files.get(site.filePath);
        const details = entry?.importDetails || [];
        const traits = langTraits(language);
        const finish = hit => {
            if (hit.def) return rest.length > 0 ? descend(hit.def, rest, language) : hit;
            if (hit.ext) return rest.length > 0 ? { ext: `${hit.ext}.${dotted(rest, language)}`, canonical: false } : hit;
            return hit;
        };
        // The compilation unit's own types.
        const here = typeDefs(name, language).filter(def => def.file === site.filePath && !def.enclosingType);
        if (here.length > 0) return finish({ def: here[0] });
        // Single-type imports: a canonical name.
        const single = details.find(detail => detail.type === 'import' && detail.module &&
            !/\.\*$/.test(detail.module) && lastOf(detail.module) === name);
        if (single) {
            const def = byCanonical(single.module, language);
            return finish(def ? { def } : { ext: single.module, canonical: true });
        }
        // A static import brings a member type of that name too.
        for (const detail of details) {
            if (detail.type !== 'static' || !detail.module || /\.\*$/.test(detail.module) || lastOf(detail.module) !== name) continue;
            const def = byCanonical(detail.module, language);
            if (def) return finish({ def });
            const owner = byCanonical(detail.module.slice(0, -(name.length + 1)), language);
            if (!owner) return { open: true, named: true };
            const inherited = memberTypes(owner, name);
            if (inherited.found.length === 1) return finish({ def: inherited.found[0] });
            if (inherited.found.length > 1 || inherited.tags.length > 0) return { open: true, named: true };
        }
        const pkg = siteNamespaceOf(entry, site.line);
        if (pkg === undefined) return { open: true, named: true };
        const same = typeDefs(name, language).filter(def => !def.enclosingType && (def.namespace || '') === pkg);
        if (same.length > 0) return finish({ def: same[0] });
        // On-demand imports and the implicit one: a name that compiles has
        // one provider among them.
        const onDemand = details.filter(detail => detail.module && /\.\*$/.test(detail.module))
            .map(detail => ({ module: detail.module.slice(0, -2), fromType: detail.type === 'static' }));
        const candidates = [];
        let unseen = false;
        for (const each of onDemand) {
            if (!each.fromType) {
                candidates.push(...typeDefs(name, language).filter(def => !def.enclosingType && def.namespace === each.module));
            }
            const owner = byCanonical(each.module, language);
            if (owner) {
                const inside = memberTypes(owner, name);
                candidates.push(...inside.found);
                if (inside.tags.length > 0) unseen = true;
            }
        }
        const found = distinct(candidates);
        const implicit = traits?.implicitTypeImport && traits.implicitTypeImport.names.has(name)
            ? `${traits.implicitTypeImport.module}.${name}` : null;
        if (found.length + (implicit ? 1 : 0) === 1 && !unseen) {
            return finish(found.length === 1 ? { def: found[0] } : { ext: implicit, canonical: true });
        }
        if (found.length > 0 || implicit) return { open: true, named: true };
        // No type in scope under that name. A qualified name starts at a package.
        if (rest.length > 0) {
            const absolute = fromRoot(segments, language);
            if (absolute) return absolute;
            if (rootsOf(site.filePath, language).has(name)) return { ext: dotted(segments, language), canonical: false };
        }
        const packages = projectNamespaces(index, language);
        const providers = onDemand.map(each => each.module);
        if (traits?.implicitTypeImport) providers.push(traits.implicitTypeImport.module);
        return {
            open: true, named: true,
            scope: {
                base: `package:${pkg}`, providers,
                usings: providers.filter(module => !packages.has(module) && !byCanonical(module, language)).sort(),
            },
        };
    };

    // ---- C#: namespace and type names --------------------------------------

    /** The using directive that declares an alias in effect at a namespace level: its file and line, or null. */
    const aliasDirective = (filePath, name, level, language) => {
        const declares = detail => detail.type === 'using' && (detail.names || [])[0] === name && detail.module;
        const own = (index.files.get(filePath)?.importDetails || []).filter(detail => declares(detail) &&
            (detail.global ? level === '' : (detail.namespace || '') === level));
        if (own.length === 1) return { filePath, line: own[0].line };
        if (own.length > 1 || level !== '') return null;
        // A `global using` of another file of the project.
        const elsewhere = remember(`global-alias\0${language}\0${name}`, () => {
            const out = [];
            for (const [otherPath, entry] of index.files) {
                if (entry.language !== language) continue;
                for (const detail of entry.importDetails || []) {
                    if (detail.global && declares(detail)) out.push({ filePath: otherPath, line: detail.line });
                }
            }
            return out;
        });
        return elsewhere.length === 1 ? elsewhere[0] : null;
    };

    /**
     * What a using alias stands for: the type its directive writes, read
     * where the directive stands (an alias never sees the aliases of its
     * own namespace body). `Alias.Member` continues a plain name only. An
     * alias a project file declares is a dotted name read from the root.
     */
    const aliasTarget = (site, name, level, rest, language, syntax) => {
        const unread = { open: true, named: false };
        const directive = aliasDirective(site.filePath, name, level, language);
        if (!directive) {
            const text = String(syntax || '').replace(/^global::/, '');
            if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(text)) return unread;
            const segments = [...text.split('.').map(part => ({ name: part })), ...rest];
            return fromRoot(segments, language) || { ext: dotted(segments, language), canonical: false };
        }
        const term = world.aliasTerm ? world.aliasTerm(directive.filePath, directive.line) : null;
        if (!term || (site.aliasDepth || 0) >= 4) return unread;
        const at = {
            filePath: directive.filePath, line: directive.line, chain: [], typeParams: [],
            namespace: level, skipAliasesAt: level, aliasDepth: (site.aliasDepth || 0) + 1,
        };
        const plain = !!term.path && term.path.every(segment => !(segment.args || []).length);
        if (plain) {
            const segments = [...term.path.map(segment => ({ name: segment.name, arity: 0 })), ...rest];
            return lookup(at, segments, term.global === true);
        }
        return rest.length > 0 ? unread : { term: resolve(term, at) };
    };

    const csharpFileLevel = (site, segments, language) => {
        const [head, ...rest] = segments;
        const name = head.name;
        const entry = index.files.get(site.filePath);
        const namespace = site.namespace !== undefined ? site.namespace : siteNamespaceOf(entry, site.line);
        if (namespace === undefined) return { open: true, named: false };
        const scope = csharpUsings(index, site.filePath, namespace);
        const declared = csharpDeclaredNames(index);
        const levels = [];
        for (let parts = namespace ? namespace.split('.') : []; parts.length > 0; parts = parts.slice(0, -1)) levels.push(parts.join('.'));
        levels.push('');
        const finish = hit => (hit.def && rest.length > 0 ? descend(hit.def, rest, language) : hit);
        const declaredAt = (origins, target, level) => (origins.get(target) || new Set()).has(level);
        // An inner namespace's using directive names a namespace this
        // cannot read: a type found further out may be hidden by it.
        let behind = false;
        for (const level of levels) {
            const members = typeDefs(name, language).filter(def => !def.enclosingType &&
                (def.namespace || '') === level && arityFits(def, head.arity, language));
            if (members.length > 0) return behind ? { open: true, named: true } : finish({ def: members[0] });
            // A namespace of that name: the rest is read from it.
            const nested = level ? `${level}.${name}` : name;
            if (rest.length > 0 && declared.namespaces.has(nested)) {
                if (behind) return { open: true, named: true };
                const absolute = [...(level ? level.split('.').map(part => ({ name: part })) : []), ...segments];
                return fromRoot(absolute, language) || { ext: dotted(absolute, language), canonical: false };
            }
            if (site.skipAliasesAt !== level && scope.aliases.has(name) &&
                ((scope.aliasScopes && scope.aliasScopes.get(name)) || '') === level) {
                if (behind || scope.ambiguousAliases.has(name) || head.arity) return { open: true, named: false };
                return aliasTarget(site, name, level, rest, language, scope.aliasSyntax.get(name) || scope.aliases.get(name));
            }
            const usings = [...scope.namespaces].filter(target => declaredAt(scope.namespaceScopes, target, level));
            const statics = [...scope.statics].filter(target => declaredAt(scope.staticScopes, target, level));
            const brought = [];
            let unseen = false;
            brought.push(...typeDefs(name, language).filter(def => !def.enclosingType &&
                usings.includes(def.namespace || '') && arityFits(def, head.arity, language)));
            for (const target of statics) {
                const owner = byCanonical(target, language);
                if (!owner) continue;
                const inside = memberTypes(owner, name);
                brought.push(...inside.found.filter(def => arityFits(def, head.arity, language)));
                if (inside.tags.length > 0) unseen = true;
            }
            const found = distinct(brought);
            if (found.length === 1 && !unseen) return behind ? { open: true, named: true } : finish({ def: found[0] });
            if (found.length > 1 || unseen) return { open: true, named: true };
            if (level !== '' && (usings.some(target => !declared.namespaces.has(target)) ||
                statics.some(target => !declared.types.has(target)))) behind = true;
        }
        // No type of the project in scope under that name. A qualified
        // name that starts at a namespace is read from the root.
        if (rest.length > 0 && !behind && rootsOf(site.filePath, language).has(name)) {
            return { ext: dotted(segments, language), canonical: false };
        }
        return {
            open: true, named: !scope.unreadable,
            scope: {
                base: `namespace:${namespace}`, providers: [...scope.namespaces],
                usings: [...[...scope.namespaces].filter(target => !declared.namespaces.has(target)),
                    ...[...scope.statics].filter(target => !declared.types.has(target))].sort(),
            },
        };
    };

    /**
     * What the head of a written name denotes at a site and, through it,
     * the whole name: { def }, { ext, canonical }, { variable }, { term }
     * (an alias of a type that is no plain name), or { open, named,
     * scope }. `tags`: the unread bases passed on the way.
     */
    const lookup = (site, segments, fromRootOnly) => {
        const language = languageOf(site.filePath);
        const scoping = langTraits(language)?.typeNameScoping;
        if (!scoping) return { open: true, named: false };
        if (fromRootOnly) return fromRoot(segments, language) || { ext: dotted(segments, language), canonical: false };
        const [head, ...rest] = segments;
        const variable = (site.typeParams || []).findIndex(each => each.name === head.name);
        if (variable !== -1 && rest.length === 0 && !head.arity) return { variable, bound: site.typeParams[variable].bound || null };
        const tags = new Set();
        for (let i = site.chain.length - 1; i >= 0; i--) {
            const cls = site.chain[i];
            if ((cls.typeParams || []).includes(head.name) && rest.length === 0) return { open: true, named: false };
            const def = defOfRow(site.filePath, cls);
            if (!def) {
                tags.add(`${site.filePath}:${cls.startLine}>?`);
                continue;
            }
            const inside = memberTypes(def, head.name);
            const fits = inside.found.filter(other => arityFits(other, head.arity, language));
            if (fits.length === 1) {
                // Named from inside the classes around it: the type
                // arguments of those classes are not written.
                const hit = rest.length > 0 ? descend(fits[0], rest, language, true) : { def: fits[0], implicit: true };
                return { ...hit, tags: [...new Set([...tags, ...(hit.tags || [])])].sort() };
            }
            if (fits.length > 1) return { open: true, named: true };
            for (const tag of inside.tags) tags.add(tag);
        }
        const hit = scoping === 'package-on-demand' ? javaFileLevel(site, segments, language) : csharpFileLevel(site, segments, language);
        return { ...hit, tags: [...new Set([...tags, ...(hit.tags || [])])].sort() };
    };

    /** A written type, resolved. */
    const resolve = (term, site) => {
        if (!term) return null;
        const language = languageOf(site.filePath);
        const unit = world.unitOf ? world.unitOf(site.filePath) : null;
        if (term.id) return { fq: term.id, last: lastOf(term.id), value: term.value, canonical: true, unit };
        if (term.unread != null) return { open: true, named: false, last: null, text: String(term.unread), scope: null };
        if (term.array) return { array: resolve(term.array, site), rank: term.rank || 1 };
        if (term.pointer) return { pointer: resolve(term.pointer, site) };
        if (term.tuple) return { tuple: term.tuple.map(each => resolve(each, site)) };
        if (term.nullable) return nullableOf(resolve(term.nullable, site));
        if (!term.path || term.path.length === 0) return { open: true, named: false, last: null, text: '', scope: null };
        const segments = term.path.map(segment => ({ name: segment.name, arity: (segment.args || []).length || 0 }));
        const args = term.path.flatMap(segment => segment.args || []);
        const text = dotted(segments, language);
        const hit = lookup(site, segments, term.global === true);
        // An alias of a type that is no plain name: the type itself.
        if (hit.term) return args.length === 0 ? hit.term : { open: true, named: false, last: null, text, scope: null };
        const unless = hit.tags && hit.tags.length > 0 ? hit.tags.join('\n') : null;
        let head;
        if (hit.variable != null) {
            if (langTraits(language)?.genericArityIsIdentity) return { variable: hit.variable };
            // A method's type parameter is its bound where signatures are
            // compared by erasure (JLS 8.4.2).
            if (hit.bound) return resolve(hit.bound, { ...site, typeParams: site.typeParams.filter((_, i) => i !== hit.variable) });
            const traits = langTraits(language);
            const top = traits?.implicitTypeImport && traits.universalSupertype
                ? `${traits.implicitTypeImport.module}.${traits.universalSupertype}` : null;
            return top ? { fq: top, last: lastOf(top), value: false, canonical: true, unit }
                : { open: true, named: false, last: null, text, scope: null };
        }
        // The type arguments written on the name's last part are the
        // type's own; the ones before it belong to the types around it.
        const ownCount = (term.path[term.path.length - 1].args || []).length;
        const resolved = args.map(each => resolve(each, site));
        const own = resolved.slice(resolved.length - ownCount);
        const around = resolved.slice(0, resolved.length - ownCount);
        if (hit.def) {
            head = {
                fq: fqOf(hit.def), last: spelled(hit.def.name, arityOf(hit.def), language), canonical: true, project: true, text, unit,
                ...(VALUE_KINDS.has(hit.def.type) && { value: true }),
                ...(REFERENCE_KINDS.has(hit.def.type) && { value: false }),
                ...(unless && { unless }),
            };
            if (!identity(language)) return head;
            // The types around a declared type take arguments too. They
            // are compared where each is written on the type that
            // declares it; a name written from inside those types, or
            // through a class that inherits the member, leaves them
            // unsaid (`exact` false).
            const needed = outerArityOf(hit.def);
            if (own.length === 0 && needed === 0) return head;
            const exact = needed === 0 || (!hit.implicit && around.length === needed);
            return { generic: head, args: [...(needed > 0 && exact ? around : []), ...own], own: own.length, exact };
        }
        if (hit.ext) {
            head = { fq: hit.ext, last: lastOf(hit.ext), canonical: hit.canonical !== false, text, unit, ...(unless && { unless }) };
        } else {
            head = {
                open: true, named: hit.named === true,
                last: spelled(segments[segments.length - 1].name, segments[segments.length - 1].arity, language), text,
                simple: segments.length === 1,
                scope: hit.scope ? {
                    base: `${hit.scope.base}\0${unless || ''}`, usings: hit.scope.usings,
                    providers: hit.scope.providers || [], guarded: !!unless, unit,
                } : null,
            };
        }
        if (resolved.length === 0) return head;
        // The platform's generic types a language has a syntax of its own
        // for: `System.Nullable<T>` is `T?`, `System.ValueTuple<A, B>` is `(A, B)`.
        const forms = langTraits(language)?.platformTypeForms;
        if (forms && head.fq && !head.unless && around.length === 0) {
            if (head.fq === spelled(forms.nullable, 1, language) && own.length === 1) return nullableOf(own[0]);
            if (head.fq === spelled(forms.tuple, own.length, language) && own.length >= 2 && own.length <= 7) return { tuple: own };
        }
        // Two spellings of one name in one scope put the same arguments
        // on the same parts.
        return { generic: head, args: resolved, own: own.length, exact: true };
    };

    /** `T?`: another type over a value type, T itself over a reference type (the mark is an annotation there). */
    const nullableOf = inner => {
        const value = valueOf(inner);
        if (value === false) return inner;
        return { nullable: inner, ...(value !== true && { maybe: true }) };
    };

    /** Is a resolved type a value type (true), a reference type (false), or not known? */
    const valueOf = term => {
        switch (kindOf(term)) {
            case 'name': return term.unless ? undefined : term.value;
            case 'array': return false;
            case 'tuple': return true;
            case 'generic': return term.generic.open || term.generic.unless ? undefined : term.generic.value;
            default: return undefined;
        }
    };

    /** The classes around a class row in its file, outermost first, the row last. */
    const chainOf = (filePath, cls) => {
        const suite = cls.suite || [];
        const around = (world.classes(filePath) || []).filter(other => other !== cls &&
            other.startLine <= cls.startLine && other.endLine >= cls.endLine &&
            (other.suite || []).length < suite.length && suite[(other.suite || []).length] === other.name &&
            (other.suite || []).every((name, i) => name === suite[i]));
        return [...around.sort((a, b) => (a.suite || []).length - (b.suite || []).length), cls];
    };

    /**
     * Is the method `b` declares the method `a` declares: the same name
     * and, parameter by parameter, the same type passed the same way.
     * Each side: { filePath, cls, row } with the reader's `params`.
     */
    const relate = (a, b) => {
        if (a.row.name !== b.row.name) return DIFFERENT;
        const pa = a.row.params;
        const pb = b.row.params;
        if (!Array.isArray(pa) || !Array.isArray(pb)) return UNKNOWN;
        if (pa.length !== pb.length) return DIFFERENT;
        const language = languageOf(a.filePath);
        if (langTraits(language)?.genericArityIsIdentity &&
            (a.row.typeParams || []).length !== (b.row.typeParams || []).length) return DIFFERENT;
        if (pa.length === 0) return SAME;
        // Remembered by the two parameter lists themselves: a reader gives
        // each method one, whatever line it stands on.
        if (!relations.has(pa)) relations.set(pa, new Map());
        const known = relations.get(pa);
        if (!known.has(pb)) {
            const siteOf = side => ({
                filePath: side.filePath, line: side.row.line, chain: chainOf(side.filePath, side.cls),
                typeParams: side.row.typeParams || [],
            });
            const sa = siteOf(a);
            const sb = siteOf(b);
            known.set(pb, every(pa.map((term, i) => {
                if ((term.by || '') !== (pb[i].by || '')) return DIFFERENT;
                return compareTypes(resolve(term, sa), resolve(pb[i], sb));
            })));
        }
        return known.get(pb);
    };

    /**
     * The class a base written on a class row denotes, by the language's
     * lookup: { filePath, cls }, null when it is no class of the project
     * that is read (a type from outside, a name that is not resolved, a
     * type declared in several parts), undefined when the language's
     * lookup is not modeled here.
     */
    const baseOf = (filePath, cls, term) => {
        const language = languageOf(filePath);
        if (!langTraits(language)?.typeNameScoping || !term) return undefined;
        if (!term.path || term.path.length === 0) return null;
        const segments = term.path.map(segment => ({ name: segment.name, arity: (segment.args || []).length || 0 }));
        // A base is written outside the class's body, among its type parameters.
        const site = {
            filePath, line: cls.line, chain: chainOf(filePath, cls).slice(0, -1),
            typeParams: [],
        };
        if ((cls.typeParams || []).includes(segments[0].name) && segments.length === 1) return null;
        const hit = lookup(site, segments, term.global === true);
        if (!hit.def || (hit.tags && hit.tags.length > 0)) return null;
        const parts = typeDefs(hit.def.name, language).filter(other => fqOf(other) === fqOf(hit.def));
        if (parts.length !== 1) return null;
        const row = rowOfDef(hit.def);
        return row ? { filePath: hit.def.file, cls: row } : null;
    };

    // The readers run under a guard (a shape that is not read is no
    // answer); so does this. What is not read is not known: an inherited
    // test then runs only sometimes, a base is no class that is read.
    return {
        relate(a, b) {
            try {
                return relate(a, b);
            } catch (e) {
                return UNKNOWN;
            }
        },
        baseOf(filePath, cls, term) {
            try {
                return baseOf(filePath, cls, term);
            } catch (e) {
                return null;
            }
        },
    };
}

module.exports = { createSignatures };
