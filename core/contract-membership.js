/**
 * core/contract-membership.js - Contract membership of a member definition
 * (fix #360).
 *
 * A method is rarely just a symbol: it can fill a SLOT of a contract - an
 * interface/trait/base-class member it implements or overrides, or a method
 * set a type must keep to satisfy an interface. Renaming it is then a change
 * to that contract, and the rename is only complete when every member of the
 * contract that the project owns changes together. When part of the
 * contract lives outside the project (std traits, JDK/BCL interfaces,
 * framework base classes, Go interfaces from other modules), the rename
 * cannot be completed by editing project code at all.
 *
 * This module answers, per definition:
 *   - hierarchySlotClosure(): the project classes a member's dispatch slot
 *     spans (transitive ancestors that declare it, through intermediate
 *     classes and declared `implements` clauses, and every descendant
 *     override), by class definition identity;
 *   - rustTraitResolution(): what a Rust trait spelling binds in its scope,
 *     including configuration alternatives with an external member;
 *   - externalContractOf(): whether the member provably or possibly fills a
 *     slot of an OUT-OF-PROJECT contract, with the contract names and the
 *     source sites a compiler would report;
 *   - goContractClosure(): Go's structural (implicit) satisfaction, computed
 *     from complete method sets and interface requirement sets, closed over
 *     interface embedding and promoted methods, plus the compiler evidence
 *     (interface conversions) that a type is used as an interface whose
 *     method set UCN cannot see.
 *
 * Everything is computed from indexed AST facts, memoized on the index and
 * reset at every build/load (index._contractIndex). Unknown never counts as
 * proof in either direction: an open method set or unresolved contract is
 * reported for review, never silently joined or silently dropped.
 */

const path = require('path');
const { langTraits } = require('../languages');
const { NON_CALLABLE_TYPES, isOverrideMarked } = require('./shared');
const { splitParentList } = require('./graph-build');

const CLASS_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'record', 'enum']);

function _state(index) {
    if (!index._contractIndex) {
        index._contractIndex = {
            go: null,
            implementedBy: null,
            goQualifier: new Map(),
        };
    }
    return index._contractIndex;
}

function resetContractIndex(index) {
    index._contractIndex = null;
    index._languageFeatureMemo = null;
}

function _rel(index, file) {
    return index.files.get(file)?.relativePath || file;
}

function _bareTypeName(raw) {
    return String(raw || '').trim()
        .replace(/[<[(].*$/s, '')
        .split('::').pop()
        .split('.').pop()
        .trim();
}

function _projectTypeDefs(index, bare, fromDef = null) {
    return (index.symbols.get(bare) || []).filter(d => CLASS_KINDS.has(d.type) &&
        // A class never resolves its own qualified external base to itself
        // (`class EnvironBuilder(werkzeug.test.EnvironBuilder)`).
        !(fromDef && d.file === fromDef.file && d.startLine === fromDef.startLine &&
            d.type === fromDef.type));
}

// ---------------------------------------------------------------------------
// Declared heritage: extends + implements, per class definition.
// ---------------------------------------------------------------------------

/** Class definitions owning a member (same file, containing range first). */
function ownerClassDefs(index, def) {
    if (!def?.className) return [];
    const defs = (index.symbols.get(def.className) || []).filter(d =>
        CLASS_KINDS.has(d.type) && d.file === def.file);
    const containing = defs.filter(d => d.startLine <= def.startLine &&
        (d.endLine || d.startLine) >= (def.endLine || def.startLine));
    return containing.length > 0 ? containing : defs;
}

/** Is the member declared lexically inside its owning class body? */
function memberInClassBody(index, def) {
    if (!def?.className) return false;
    return ownerClassDefs(index, def).some(cd => cd.startLine <= def.startLine &&
        (cd.endLine || cd.startLine) >= def.startLine &&
        !(cd.startLine === def.startLine && cd.name === def.name));
}

/** Raw supertype spellings of one class definition (extends + implements). */
function declaredSupertypes(def) {
    const out = [];
    if (def.extends) {
        out.push(...(Array.isArray(def.extends) ? def.extends : splitParentList(def.extends)));
    }
    if (Array.isArray(def.implements)) out.push(...def.implements);
    else if (def.implements) out.push(...splitParentList(def.implements));
    return out.map(item => String(item).trim()).filter(Boolean);
}

/** Reverse `implements` index: interface name -> implementing class identities. */
function implementedBy(index, interfaceName) {
    const state = _state(index);
    if (!state.implementedBy) {
        const map = new Map();
        for (const [, fileEntry] of index.files) {
            for (const def of fileEntry.symbols || []) {
                if (!CLASS_KINDS.has(def.type) || !def.implements) continue;
                const implemented = Array.isArray(def.implements) ? def.implements
                    : splitParentList(def.implements);
                for (const raw of implemented) {
                    const bare = _bareTypeName(raw);
                    if (!bare) continue;
                    if (!map.has(bare)) map.set(bare, []);
                    map.get(bare).push({ name: def.name, file: def.file });
                }
            }
        }
        state.implementedBy = map;
    }
    return state.implementedBy.get(interfaceName) || [];
}

/**
 * Walk a class's declared heritage (extends through project types, plus
 * implements) and collect the supertypes that are NOT project types, with
 * whether any project ancestor declares `memberName`.
 */
function heritageOf(index, classDefs, memberName) {
    const external = [];
    let projectDefiner = null;
    const seen = new Set();
    let frontier = classDefs.map(d => ({ def: d }));
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
        const next = [];
        for (const { def } of frontier) {
            for (const raw of declaredSupertypes(def)) {
                const bare = _bareTypeName(raw);
                if (!bare) continue;
                const key = `${bare}\0${def.file}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const parents = _projectTypeDefs(index, bare, def);
                if (parents.length === 0) {
                    const spelled = String(raw).replace(/\s+/g, ' ').trim();
                    if (!external.includes(spelled)) external.push(spelled);
                    continue;
                }
                const parentFile = index._resolveClassFile(bare, def.file);
                const resolved = parents.filter(p => p.file === parentFile);
                for (const parent of (resolved.length > 0 ? resolved : parents)) {
                    if (!projectDefiner && memberName) {
                        const member = (index.symbols.get(memberName) || []).find(m =>
                            m.className === parent.name && m.file === parent.file &&
                            !NON_CALLABLE_TYPES.has(m.type));
                        if (member) projectDefiner = member;
                    }
                    next.push({ def: parent });
                }
            }
        }
        frontier = next;
    }
    return { external, projectDefiner };
}

// ---------------------------------------------------------------------------
// Rust traits
// ---------------------------------------------------------------------------

const RUST_EXTERNAL_ROOTS = new Set(['std', 'core', 'alloc']);

/**
 * What a Rust trait spelling denotes from `fromFile`, by the file's own
 * scope (fix #376): project trait definitions it can bind, and whether some
 * binding of it is an out-of-project trait. `use` declarations of the name
 * are followed into the project module they resolve to (`crate::StdError`
 * -> the crate root's own `use std::error::Error as StdError` and its
 * `trait StdError` under another cfg), so configuration alternatives with
 * one external member are visible. `null` when the file neither declares
 * nor imports the name by a resolvable `use` (glob imports, prelude):
 * callers fall back to name-level resolution.
 */
function _rustModuleScope(index, file, line) {
    if (line == null) return 0;
    let best = null;
    for (const d of index.files.get(file)?.symbols || []) {
        if (d.type !== 'module' || d.startLine >= line || (d.endLine || d.startLine) < line) continue;
        if (!best || d.startLine > best.startLine) best = d;
    }
    return best ? best.startLine : 0;
}

function rustTraitResolution(index, traitName, fromFile, depth = 0, fromLine = null) {
    const spelled = String(traitName || '').replace(/<.*$/s, '').replace(/\s+/g, '').trim();
    const segments = spelled.split('::').filter(Boolean);
    const bare = segments[segments.length - 1];
    if (!bare) return null;
    if (segments.length > 1 && RUST_EXTERNAL_ROOTS.has(segments[0])) {
        return { project: [], external: true };
    }
    const fileEntry = index.files.get(fromFile);
    if (!fileEntry || depth > 6) return null;
    const resolveModuleFile = spec => {
        const rel = fileEntry.moduleResolved?.[spec];
        return rel ? (path.isAbsolute(rel) ? rel : path.join(index.root, rel)) : null;
    };
    if (segments.length > 1) {
        const target = resolveModuleFile(spelled);
        if (!target) return null;
        if (target === fromFile) return null;
        return rustTraitResolution(index, bare, target, depth + 1);
    }
    // Only declarations in the SAME module scope as the naming site: an
    // inline `mod ext { pub trait StdError }` is not the file's StdError.
    const scope = _rustModuleScope(index, fromFile, fromLine);
    const project = (index.symbols.get(bare) || []).filter(d =>
        d.type === 'trait' && d.file === fromFile &&
        _rustModuleScope(index, fromFile, d.startLine) === scope);
    let external = false;
    let bound = project.length > 0;
    for (const binding of fileEntry.importBindings || []) {
        if (binding.kind !== 'use' || (binding.alias || binding.name) !== bare) continue;
        if (binding.line != null && _rustModuleScope(index, fromFile, binding.line) !== scope) continue;
        const module = String(binding.module || '');
        const root = module.split('::')[0];
        bound = true;
        if (RUST_EXTERNAL_ROOTS.has(root)) { external = true; continue; }
        const target = resolveModuleFile(module);
        if (!target) {
            // A crate-relative path that resolves nowhere stays unknown; any
            // other root names another crate.
            if (!['crate', 'self', 'super'].includes(root)) external = true;
            continue;
        }
        if (target === fromFile) continue;
        const inner = rustTraitResolution(index, binding.name, target, depth + 1);
        if (!inner) {
            project.push(...(index.symbols.get(binding.name) || []).filter(d =>
                d.type === 'trait' && d.file === target));
            continue;
        }
        project.push(...inner.project);
        if (inner.external) external = true;
    }
    if (!bound) return null;
    return { project: [...new Set(project)], external };
}

/** Resolve a Rust impl's trait spelling to project trait definitions. */
function rustProjectTraits(index, traitName, fromFile, fromLine = null) {
    const spelled = String(traitName || '').replace(/<.*$/s, '').trim();
    const segments = spelled.split('::').map(s => s.trim()).filter(Boolean);
    if (segments.length > 1 && RUST_EXTERNAL_ROOTS.has(segments[0])) return [];
    const bare = segments[segments.length - 1];
    if (!bare) return [];
    const scoped = fromFile ? rustTraitResolution(index, spelled, fromFile, 0, fromLine) : null;
    if (scoped && (scoped.project.length > 0 || scoped.external)) return scoped.project;
    const traits = (index.symbols.get(bare) || []).filter(d => d.type === 'trait');
    if (traits.length <= 1) return traits;
    const file = index._resolveClassFile(bare, fromFile);
    const pinned = traits.filter(d => d.file === file);
    return pinned.length > 0 ? pinned : traits;
}

// ---------------------------------------------------------------------------
// External contract membership (all languages except Go, which is structural
// and handled by goContractClosure)
// ---------------------------------------------------------------------------

function _arity(def) {
    if (Array.isArray(def.paramsStructured)) {
        return def.paramsStructured.filter(p => !['self', '&self', '&mut self',
            'mut self', 'this', 'cls'].includes(String(p.name || '').trim())).length;
    }
    return null;
}

/**
 * Is `def` a member the language runtime or compiler invokes by name
 * (trait `languageProtocolMember`, fix #360/#363)? Owner-gated rules (Python
 * Enum hooks, Java serialization callbacks) require the owning class's
 * heritage closure to reach one of the named out-of-project types.
 */
function protocolMemberOf(index, def) {
    return !!protocolMemberCertainty(index, def);
}

/**
 * 'definite' when the owner's heritage reaches the protocol's named types,
 * 'possible' when it leaves the project through another out-of-project
 * supertype that may reach them (fix #389), else null.
 */
function protocolMemberCertainty(index, def) {
    if (!def || !def.name) return null;
    const lang = index.files.get(def.file)?.language;
    const predicate = langTraits(lang)?.languageProtocolMember;
    if (typeof predicate !== 'function') return null;
    const isMember = !!def.className;
    const verdict = predicate(def.name, {
        isMember,
        isField: def.type === 'field' || def.type === 'property' || def.type === 'constant',
        modifiers: def.modifiers || [],
        paramTypes: Array.isArray(def.paramsStructured)
            ? def.paramsStructured.map(param => _bareTypeName(_paramTypeText(param)) || null) : null,
        derivesFrom: owners => ownerDerivesFromExternal(index, def, owners),
        externalSupertypes: () => ownerExternalSupertypes(index, def),
        ownerKinds: () => ownerClassDefs(index, def).map(owner => owner.type),
    });
    if (verdict === true) return 'definite';
    return verdict || null;
}

/**
 * The out-of-project supertypes the owner's heritage reaches: the bare name
 * when written unqualified and not imported (the language's implicit
 * scope), else the qualified spelling (fix #389).
 */
function ownerExternalSupertypes(index, def) {
    if (!def?.className) return [];
    const owners = ownerClassDefs(index, def);
    const { external } = heritageOf(index, owners, null);
    const bindings = owners.flatMap(owner => index.files.get(owner.file)?.importBindings || []);
    return external.map(spelled => {
        const bare = _bareTypeName(spelled);
        if (!bare) return null;
        const head = String(spelled).replace(/<.*$/s, '').trim();
        if (head !== bare) return head;
        const imported = bindings.find(binding => (binding.alias || binding.name) === bare);
        if (!imported) return bare;
        const module = String(imported.module || '');
        return module === bare || module.endsWith(`.${bare}`) ? module : `${module}.${bare}`;
    }).filter(Boolean);
}

/**
 * fix #380: is `def` a compiler-required type the project declares for a
 * language feature it uses (trait languageProtocolType; C# IsExternalInit
 * with `init` accessors or positional records), or a member of one? The
 * compiler references it by full name, so no call or reference names it.
 */
function protocolTypeOf(index, def) {
    if (!def || !def.name) return false;
    const lang = index.files.get(def.file)?.language;
    const predicate = langTraits(lang)?.languageProtocolType;
    if (typeof predicate !== 'function') return false;
    let typeDef = def;
    if (def.className) {
        typeDef = ownerClassDefs(index, def)[0];
        if (!typeDef) return false;
    }
    let features = index._languageFeatureMemo;
    if (!features || features.language !== lang) {
        const set = new Set();
        for (const [, entry] of index.files) {
            if (entry.language !== lang) continue;
            for (const feature of entry.languageFeatures || []) set.add(feature);
        }
        features = { language: lang, set };
        index._languageFeatureMemo = features;
    }
    return predicate(typeDef.name, {
        namespace: typeDef.namespace || '',
        hasFeature: feature => features.set.has(feature),
    });
}

/**
 * Does the class owning member `def` reach, through its heritage closure
 * (extends + implements, transitively through project types), an
 * out-of-project supertype whose bare name is one of `names`?
 */
function ownerDerivesFromExternal(index, def, names) {
    if (!def?.className) return false;
    const wanted = new Set(names);
    const { external } = heritageOf(index, ownerClassDefs(index, def), null);
    return external.some(spelled => wanted.has(_bareTypeName(spelled)));
}

/** The standard-library namespace a declaration is written in (its
 * language's `standardPathRoots`: C# `System`, C++ `std`), or null. */
function standardNamespaceOf(index, def) {
    const namespace = String(def.namespace || '');
    if (!namespace) return null;
    const roots = langTraits(index.files.get(def.file)?.language)?.standardPathRoots || [];
    for (const root of roots) {
        if (namespace === root || namespace.startsWith(`${root}.`) || namespace.startsWith(`${root}::`)) {
            return namespace;
        }
    }
    return null;
}

/**
 * Does `def` fill a slot of a contract that lives outside the project?
 * Returns null, or { certainty: 'definite'|'possible', via: string[],
 * reason, sites: [{file, relativePath, line}] }.
 *   definite - the name is fixed by an out-of-project contract: a Rust impl
 *     of an external trait, an explicit override marker with no project
 *     ancestor declaring the member, a language protocol member (Python
 *     dunders), a universal-supertype member (Java toString/equals/...).
 *   possible - the owning class declares out-of-project supertypes and the
 *     member is public by shape, so it may implement or override one of
 *     their (invisible) members.
 */
function externalContractOf(index, def) {
    // A declaration inside a standard-library namespace (fix #390: a C#
    // polyfill `namespace System.Diagnostics.CodeAnalysis { enum
    // DynamicallyAccessedMemberTypes }`, a C++ `namespace std { template<>
    // struct hash<X> }`) stands in for, or specializes, the platform's
    // declaration of that full name: where the platform provides it, every
    // reference binds the platform's, so the name cannot change.
    const standardNamespace = def && standardNamespaceOf(index, def);
    if (standardNamespace) {
        return {
            certainty: 'definite',
            via: [`${standardNamespace}`],
            reason: 'standard-namespace-declaration',
            sites: [{ file: def.file, relativePath: def.relativePath || _rel(index, def.file),
                line: def.nameLine || def.startLine }],
        };
    }
    // A callable a macro invocation defines around its body (fix #391:
    // `TEST(Suite, Name) { ... }`): its name comes from the expansion and is
    // not written in the source, so there is no declaration token to edit.
    // A member a member-list invocation declares under a name no argument
    // spells (`Get##name##String`, fix #396) has no token to edit either.
    if (def && def.generatedByMacro && !NON_CALLABLE_TYPES.has(def.type) &&
        (!def.className || def.generatedByMacro.unspelled)) {
        return {
            certainty: 'definite',
            via: [String(def.generatedByMacro.name || 'macro')],
            reason: 'macro-generated-name',
            sites: [{ file: def.file, relativePath: def.relativePath || _rel(index, def.file),
                line: def.nameLine || def.startLine }],
        };
    }
    // A compiler-required type (fix #380): its full name is fixed by the
    // language, so renaming it withdraws the feature's lowering target.
    if (def && !def.className && CLASS_KINDS.has(def.type) && protocolTypeOf(index, def)) {
        return {
            certainty: 'definite',
            via: [`${def.namespace ? `${def.namespace}.` : ''}${def.name}`],
            reason: 'compiler-protocol-type',
            sites: [{ file: def.file, relativePath: def.relativePath || _rel(index, def.file),
                line: def.nameLine || def.startLine }],
        };
    }
    if (!def || !def.className) return null;
    const defSite = {
        file: def.file,
        relativePath: def.relativePath || _rel(index, def.file),
        line: def.nameLine || def.startLine,
    };
    // A field the runtime reads by name (Java `serialVersionUID`, fix #389).
    if (NON_CALLABLE_TYPES.has(def.type)) {
        const certainty = protocolMemberCertainty(index, def);
        if (!certainty) return null;
        const lang = index.files.get(def.file)?.language;
        return {
            certainty,
            via: certainty === 'definite' ? [`${lang} data model`] : ownerExternalSupertypes(index, def),
            reason: certainty === 'definite' ? 'language-protocol-member' : 'possible-protocol-member',
            sites: [defSite],
        };
    }
    const lang = index.files.get(def.file)?.language;
    const traits = langTraits(lang) || {};
    if (lang === 'go') return null;

    // Rust: `impl Trait for X` members carry traitName.
    if (def.traitName) {
        // A trait name bound to a project trait under one configuration and
        // to an external trait under another (`#[cfg(feature = "std")] use
        // std::error::Error as StdError;` beside a cfg'd `trait StdError`)
        // is fixed by the external contract in that configuration (fix #376).
        const scoped = rustTraitResolution(index, def.traitName, def.file, 0, def.startLine);
        if (scoped?.external && scoped.project.length > 0) {
            return {
                certainty: 'definite',
                via: [String(def.traitName).replace(/\s+/g, ' ').trim()],
                reason: 'implements-cfg-external-trait',
                sites: [defSite, ...scoped.project.map(t => ({
                    file: t.file,
                    relativePath: t.relativePath || _rel(index, t.file),
                    line: t.startLine,
                }))],
            };
        }
        if (rustProjectTraits(index, def.traitName, def.file, def.startLine).length > 0) return null;
        return {
            certainty: 'definite',
            via: [String(def.traitName).replace(/\s+/g, ' ').trim()],
            reason: 'implements-external-trait',
            sites: [defSite],
        };
    }
    const protocolCertainty = protocolMemberCertainty(index, def);
    if (protocolCertainty === 'definite') {
        return {
            certainty: 'definite',
            via: [`${lang} data model`],
            reason: 'language-protocol-member',
            sites: [defSite],
        };
    }
    if (protocolCertainty === 'possible') {
        // The owner leaves the project through a supertype that may carry
        // the protocol (fix #389): edits stay, the definition is reviewed.
        return {
            certainty: 'possible',
            via: ownerExternalSupertypes(index, def),
            reason: 'possible-protocol-member',
            sites: [defSite],
        };
    }
    const classDefs = ownerClassDefs(index, def);
    const classSites = classDefs.map(cd => ({
        file: cd.file,
        relativePath: cd.relativePath || _rel(index, cd.file),
        line: cd.startLine,
    }));
    const { external, projectDefiner } = heritageOf(index, classDefs, def.name);
    if (projectDefiner) return null; // a project contract: plan's slot closure owns it
    const rootMembers = traits.universalSupertypeMembers;
    const arity = _arity(def);
    if (rootMembers && Object.prototype.hasOwnProperty.call(rootMembers, def.name) &&
        (arity == null || arity === rootMembers[def.name])) {
        return {
            certainty: 'definite',
            via: [traits.universalSupertype || 'Object'],
            reason: 'overrides-universal-supertype',
            sites: [defSite],
        };
    }
    if (isOverrideMarked(def)) {
        return {
            certainty: 'definite',
            via: external.length > 0 ? external : [traits.universalSupertype || 'supertype'],
            reason: 'overrides-external-member',
            sites: [defSite, ...classSites],
        };
    }
    // TS typed object-literal members: `const h: Handler = { handle() {} }`.
    if (def.registryContainerType && !def.className) return null;
    if (external.length === 0) return null;
    // Only a member declared INSIDE the class body is constrained by the
    // class's supertypes: Rust inherent methods live in separate `impl X`
    // blocks and never implement a trait the struct also implements.
    if (!memberInClassBody(index, def)) return null;
    // Contract-satisfiable shape: private and static members never
    // implement or override an instance contract member. Explicit-visibility
    // languages additionally reject non-public interface implementations
    // (the #270 compiler rule); members without a recorded access modifier
    // stay candidates.
    const mods = def.modifiers || [];
    const hidden = mods.includes('private') || mods.includes('static') ||
        String(def.name).startsWith('#') ||
        (typeof traits.privateMemberName === 'function'
            ? traits.privateMemberName(def.name)
            : traits.implicitlyPublicMembers && String(def.name).startsWith('_'));
    if (hidden) return null;
    return {
        certainty: 'possible',
        via: external,
        reason: 'may-implement-external-member',
        sites: [defSite, ...classSites],
    };
}

/**
 * External contract membership of a TS/JS typed object-literal member
 * (`const h: ext.Handler = { handle() {} }`), or the project interface the
 * literal is declared against. Returns { external } | { projectInterface }.
 */
function typedLiteralContract(index, def) {
    if (!def?.registryContainerType || def.className) return null;
    const bare = _bareTypeName(def.registryContainerType);
    if (!bare || /^(any|unknown|object|Record|Partial|Readonly)$/.test(bare)) return null;
    const projectDefs = _projectTypeDefs(index, bare);
    if (projectDefs.length > 0) {
        const file = index._resolveClassFile(bare, def.file);
        return { projectInterface: { name: bare, file } };
    }
    return {
        external: {
            certainty: 'possible',
            via: [def.registryContainerType],
            reason: 'typed-literal-external-member',
            sites: [{
                file: def.file,
                relativePath: def.relativePath || _rel(index, def.file),
                line: def.nameLine || def.startLine,
            }],
        },
    };
}

/** Typed object-literal members declared against a project interface. */
function typedLiteralMembers(index, name, interfaceName, interfaceFile) {
    return (index.symbols.get(name) || []).filter(member =>
        member.registryContainerType && !member.className &&
        _bareTypeName(member.registryContainerType) === interfaceName &&
        index._resolveClassFile(interfaceName, member.file) === interfaceFile);
}

// ---------------------------------------------------------------------------
// Hierarchy slot closure (fix #376)
// ---------------------------------------------------------------------------

const SLOT_SELF_PARAMS = new Set(['self', '&self', '&mut self', 'mut self', 'this', 'cls']);

/** A parameter's written type; an unnamed parameter's name is its type (fix #393). */
function _paramTypeText(param) {
    return param?.type || (param?.unnamed ? param.name : '') || '';
}

/** Parameter-type spelling of a member, receiver params excluded. */
function _slotSignature(def) {
    if (!Array.isArray(def.paramsStructured)) return null;
    return def.paramsStructured
        .filter(p => !p?.extensionReceiver &&
            !SLOT_SELF_PARAMS.has(String(p?.name || '').trim()))
        .map(p => String(_paramTypeText(p))
            .replace(/@[\w.]+(?:\([^)]*\))?/g, '')
            .replace(/\b(?:final|const|in|ref|out|params|readonly)\b/g, '')
            .replace(/\s+/g, ''))
        .join(',');
}

function _slotTypeName(raw) {
    return String(raw || '').replace(/<.*$/s, '').replace(/\s+/g, '')
        .split('::').pop().split('.').pop();
}

/** Type parameter names a definition (or its owner) declares (`<T, K extends X>`). */
function _typeParams(...defs) {
    const out = new Set();
    for (const d of defs) {
        const generics = String(d?.generics || '').replace(/^<|>$/g, '');
        for (const part of splitParentList(generics)) {
            const name = part.trim().split(/[\s:]/)[0];
            if (name) out.add(name);
        }
    }
    return out;
}

/**
 * Could `member` override (occupy the same slot as) `pin` by parameter
 * types? Types compare by their terminal name; a type parameter of either
 * side's method or class matches anything (`m(T)` overridden as
 * `m(String)`).
 */
function _slotParamsCompatible(index, member, pin) {
    const params = d => (d.paramsStructured || []).filter(p => !p?.extensionReceiver &&
        !SLOT_SELF_PARAMS.has(String(p?.name || '').trim()));
    const a = params(member);
    const b = params(pin);
    if (a.length !== b.length) return false;
    const owners = d => (d.className ? (index.symbols.get(d.className) || [])
        .filter(c => c.file === d.file && CLASS_KINDS.has(c.type)) : []);
    const variables = _typeParams(member, pin, ...owners(member), ...owners(pin));
    for (let i = 0; i < a.length; i++) {
        const ta = _slotTypeName(_paramTypeText(a[i]));
        const tb = _slotTypeName(_paramTypeText(b[i]));
        if (!ta || !tb || ta === tb) continue;
        if (variables.has(ta) || variables.has(tb)) continue;
        if (/^[A-Z]$/.test(ta) || /^[A-Z]$/.test(tb)) continue;
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Generic base clauses as type-argument substitutions (fix #390)
// ---------------------------------------------------------------------------

/** Split on commas outside `<>`, `()` and `[]`. */
function _splitTypeArgs(text) {
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

const TYPE_PARAM_PREFIXES = new Set(['in', 'out', 'const', 'typename', 'class', 'struct']);

/**
 * Ordered type parameter names of a declaration (`<S, R>`, `<T extends X>`,
 * `<in T>`), [] when it declares none, null when its record cannot say (a
 * C# generic type without recorded names).
 */
function _orderedTypeParams(def) {
    const raw = String(def?.generics || '').trim().replace(/^<|>$/g, '');
    if (!raw) return def?.typeArity ? null : [];
    return _splitTypeArgs(raw).map(part => {
        const tokens = part.replace(/@[\w.]+(?:\([^)]*\))?/g, ' ')
            .split(/[\s:=]+/).filter(Boolean);
        const name = tokens.find(token => !TYPE_PARAM_PREFIXES.has(token)) || '_';
        return name.replace(/\.\.\.$/, '');
    });
}

/**
 * Every distinct argument list `child` writes for `parentName` (a C# class
 * implementing `I<A>` and `I<B>` writes two), [] for a raw base, null when
 * none is recorded.
 */
function _writtenBaseArgLists(index, childRef, parentName) {
    const { classDefsNamed } = require('./class-identity');
    let decls = childRef.key ? classDefsNamed(index, childRef.name).entries
        .filter(e => e.key === childRef.key).map(e => e.def) : [];
    if (decls.length === 0 && childRef.def) decls = [childRef.def];
    const spelled = new Set();
    for (const decl of decls) {
        const raws = [
            ..._splitTypeArgs(decl.extends),
            ...(Array.isArray(decl.implements) ? decl.implements : _splitTypeArgs(decl.implements)),
        ];
        for (const raw of raws) {
            const text = String(raw).replace(/^(?:(?:public|protected|private|virtual)\s+)+/, '').trim();
            const head = text.replace(/<.*$/s, '').trim();
            if (head.split(/::|\./).pop().trim() !== parentName) continue;
            spelled.add(text.replace(/\s+/g, ' '));
        }
    }
    if (spelled.size === 0) return null;
    const lists = [];
    for (const text of [...spelled].sort()) {
        const open = text.indexOf('<');
        if (open < 0) { lists.push([]); continue; }
        const close = text.lastIndexOf('>');
        if (close <= open) return null;
        lists.push(_splitTypeArgs(text.slice(open + 1, close)));
    }
    return lists;
}

/** Replace unqualified identifiers named in `map` inside a type spelling. */
function _substituteType(text, map) {
    if (!map || map.size === 0) return String(text || '');
    return String(text || '').replace(/(^|[^\w$.:])([A-Za-z_$][\w$]*)/g,
        (match, before, id) => (map.has(id) ? before + map.get(id) : match));
}

/**
 * The substitution a base clause performs: `parent`'s type parameters to
 * the arguments `child` writes for it (in child's terms), null when either
 * side is unknown or the counts disagree (a raw base).
 */
function _baseSubstitution(index, childRef, parentRef) {
    const all = _baseSubstitutions(index, childRef, parentRef);
    return all && all.length === 1 ? all[0] : null;
}

/** One substitution per instantiation the child writes (fix #400: a class
 * implementing a generic interface twice fills the slot of each); null
 * when any cannot be read. */
function _baseSubstitutions(index, childRef, parentRef) {
    const params = _orderedTypeParams(parentRef.def);
    if (!params) return null;
    const lists = _writtenBaseArgLists(index, childRef, parentRef.name);
    if (!lists || lists.length === 0) return null;
    const maps = [];
    for (const args of lists) {
        if (args.length !== params.length) return null;
        const map = new Map();
        params.forEach((param, i) => map.set(param, args[i]));
        maps.push(map);
    }
    return maps;
}

/** A parameter type as dispatch compares it: generic arguments, qualifiers
 * and non-type modifiers removed (`const std::string&` -> `string&`). */
function _slotTypeKey(raw) {
    let text = String(raw || '')
        .replace(/@[\w.]+(?:\([^)]*\))?/g, '')
        .replace(/\b(?:final|const|volatile|in|ref|out|params|readonly|scoped|typename|struct|class|enum)\b/g, '');
    for (let guard = 0; guard < 8 && /<[^<>]*>/.test(text); guard++) {
        text = text.replace(/<[^<>]*>/g, '');
    }
    return text.replace(/(?:[A-Za-z_$][\w$]*\s*(?:::|\.)\s*)+(?=[A-Za-z_$])/g, '')
        .replace(/\s+/g, '');
}

function _slotParams(def) {
    return (def.paramsStructured || []).filter(p => !p?.extensionReceiver &&
        !SLOT_SELF_PARAMS.has(String(p?.name || '').trim()));
}

/**
 * Does `member` take the slot whose parameter types, in the member's own
 * class terms, are `slotTypes`? Method-level type parameters of either
 * side match any type (`<U> m(U)` overrides `<V> m(V)`).
 */
function _slotTypesMatch(member, slotTypes, slotMethodParams) {
    const params = _slotParams(member);
    if (params.length !== slotTypes.length) return false;
    const wild = new Set([...(_orderedTypeParams({ generics: member.generics }) || []),
        ...slotMethodParams]);
    for (let i = 0; i < params.length; i++) {
        const a = _slotTypeKey(params[i]?.type);
        const b = _slotTypeKey(slotTypes[i]);
        if (!a || !b || a === b) continue;
        const baseA = a.replace(/[^\w$].*$/s, '');
        const baseB = b.replace(/[^\w$].*$/s, '');
        if (wild.has(baseA) || wild.has(baseB)) continue;
        return false;
    }
    return true;
}

/**
 * Members named `name` that class reference `ref` declares and that occupy
 * the same dispatch slot as `pin`. Languages with overloads by parameter
 * list (hasArityOverloads) require the same arity and the same parameter
 * types. With a `frame` (fix #390) the types compare through the generic
 * base clauses between the two classes: `frame.slotTypes` are the slot's
 * parameter types in `ref`'s terms, or `frame.memberSubst` maps `ref`'s type
 * parameters into the pin's terms. Without one (a base clause that cannot
 * be read), type parameters of either side match anything.
 */
/** A member declared `private`, `protected` or `internal` (never an
 * interface member's implementation). */
function _nonPublicMember(member) {
    return (member?.modifiers || []).some(modifier =>
        modifier === 'private' || modifier === 'protected' || modifier === 'internal');
}

/** The interface a C# explicit implementation implements, by name. */
function _explicitInterfaceName(member) {
    return member?.explicitInterface
        ? String(member.explicitInterface).replace(/<.*$/s, '').split('.').pop().trim() : null;
}

function _slotMembersOf(index, name, ref, pin, overloads, frame = null, slotInterfaces = null) {
    const { ownedBy } = require('./class-identity');
    const refFile = ref.def?.file || null;
    let defs = (index.symbols.get(name) || []).filter(member => {
        if (NON_CALLABLE_TYPES.has(member.type) || member.className !== ref.name) return false;
        const owned = ownedBy(index, member, ref);
        return owned === 'yes' || (owned === 'maybe' && refFile && member.file === refFile);
    });
    // C# explicit interface implementations (fix #395) fill only their
    // interface's slot: `string IValidator.M()` never shares a slot with a
    // `protected virtual M()` of the same class, and where a class
    // implements the pin's interface member explicitly, its other same-name
    // members are not that slot.
    if (defs.some(member => member.explicitInterface)) {
        const interfaces = new Set(slotInterfaces || []);
        if (_explicitInterfaceName(pin)) interfaces.add(_explicitInterfaceName(pin));
        const explicit = defs.filter(member => interfaces.has(_explicitInterfaceName(member)));
        defs = explicit.length > 0 ? explicit : defs.filter(member => !member.explicitInterface);
    }
    if (!overloads || defs.length === 0) return defs;
    const arity = _arity(pin);
    let same = defs.filter(member => arity == null || _arity(member) == null ||
        _arity(member) === arity);
    // Where generic arity is identity (C#), a method overrides or implements
    // only a method with as many type parameters (fix #391: `Write<T>(.., T)`
    // is not the slot of `Write(.., params object[])`).
    if (langTraits(index.files.get(pin.file)?.language)?.genericArityIsIdentity) {
        const methodArity = def => (_orderedTypeParams({ generics: def.generics }) || []).length;
        const pinMethodArity = methodArity(pin);
        same = same.filter(member => methodArity(member) === pinMethodArity);
    }
    if (frame && arity != null) {
        const pinMethodParams = _orderedTypeParams({ generics: pin.generics }) || [];
        if (frame.slotTypes) {
            return same.filter(member => _arity(member) == null ||
                _slotTypesMatch(member, frame.slotTypes, pinMethodParams));
        }
        if (frame.memberSubst) {
            const pinTypes = _slotParams(pin).map(p => p?.type);
            return same.filter(member => {
                if (_arity(member) == null) return true;
                const inPinTerms = { ...member, paramsStructured: _slotParams(member)
                    .map(p => ({ ...p, type: _substituteType(p?.type, frame.memberSubst) })) };
                return _slotTypesMatch(inPinTerms, pinTypes, pinMethodParams);
            });
        }
    }
    const signature = _slotSignature(pin);
    const exact = same.filter(member => _slotSignature(member) === signature);
    if (exact.length > 0) return exact;
    same = same.filter(member => _arity(member) == null || arity == null ||
        _slotParamsCompatible(index, member, pin));
    return same;
}

/**
 * The project classes a renamed member's dispatch slot spans: every
 * transitive ancestor (through intermediate classes that do not redeclare
 * the member, declared implements clauses included for body members) that
 * declares the slot, and every transitive descendant of the slot's owners
 * that overrides it. Classes resolve by definition identity (class-identity
 * refs), with the name-level file resolution as the fallback for an
 * ambiguous parent spelling. Ancestor names that cannot be resolved at all
 * are returned in `unresolved` for review.
 *
 * @param {object} index
 * @param {object} def - the pinned member definition
 * @param {object} [startRef] - class reference to start from (typed object
 *   literal members start at their declared interface)
 * @returns {{pinRef, ancestors: {ref, members}[], descendants: {ref, members,
 *   viaImplements}[], unresolved: string[], external: string[]}|null}
 */
function hierarchySlotClosure(index, def, startRef = null) {
    const { ownerRefOf, supertypeRefsOf, classDefsNamed } = require('./class-identity');
    const pinRef = startRef || ownerRefOf(index, def);
    if (!pinRef || (!pinRef.key && !pinRef.def)) return null;
    const lang = index.files.get(def.file)?.language;
    const overloads = !!langTraits(lang)?.hasArityOverloads;
    const name = def.name;
    // Only a member declared inside the class body is constrained by the
    // class's implements clause (a Rust inherent method never fills the
    // struct's trait slots); typed literal members start at the interface.
    const followImplements = !!startRef || memberInClassBody(index, def);
    const refKey = ref => ref.key || `?${ref.name}`;
    const resolveLoose = (parent, contextFile) => {
        if (parent.key || parent.def) return parent;
        // Name-level fallback for a spelling identity cannot pin: the class
        // is followed, but the plan reviews it (unresolved).
        if (!unresolved.includes(parent.name)) unresolved.push(parent.name);
        const file = index._resolveClassFile(parent.name, contextFile);
        const entry = file && classDefsNamed(index, parent.name).entries
            .find(e => e.def.file === file);
        return entry ? { name: parent.name, key: entry.key, def: entry.def } : null;
    };

    const ancestors = [];
    const unresolved = [];
    const external = [];
    const ancestorSeen = new Set([refKey(pinRef)]);
    // Each class carries the substitution of its type parameters into the
    // pin's terms, composed over the generic base clauses walked (fix #390):
    // `Mid<T> : Base<T, bool>` maps Base's S to the pin class's T. null when
    // a base clause on the way cannot be read.
    // Interfaces whose member of this name a class on the upward path
    // implements explicitly (C#).
    const explicitViaOf = (ref, inherited) => {
        const own = (index.symbols.get(name) || []).filter(member => member.className === ref.name &&
            member.explicitInterface).map(_explicitInterfaceName);
        if (own.length === 0) return inherited || null;
        return new Set([...(inherited || []), ...own]);
    };
    const upQueue = [{ ref: pinRef, contextFile: pinRef.def?.file || def.file,
        subst: overloads ? new Map() : null, explicitVia: explicitViaOf(pinRef, null) }];
    while (upQueue.length > 0 && ancestorSeen.size < 256) {
        const current = upQueue.shift();
        for (const parent of supertypeRefsOf(index, current.ref,
            { implements: followImplements })) {
            if (parent.external) {
                if (!external.includes(parent.name)) external.push(parent.name);
                continue;
            }
            const resolved = resolveLoose(parent, current.contextFile);
            if (!resolved) continue;
            const key = refKey(resolved);
            if (ancestorSeen.has(key)) continue;
            ancestorSeen.add(key);
            let subst = null;
            if (current.subst && resolved.def) {
                const step = _baseSubstitution(index, current.ref, resolved);
                if (step) {
                    subst = new Map();
                    for (const [param, arg] of step) subst.set(param, _substituteType(arg, current.subst));
                }
            }
            // A class on the way that implements this interface's member
            // explicitly keeps the pin's slot out of the interface (fix
            // #395, C#): `string IValidator.M()` beside `protected virtual
            // M()` are two slots.
            if (!_explicitInterfaceName(def) && current.explicitVia?.has(resolved.name)) continue;
            // An interface member is implemented by public members only (C#,
            // Java, TS): a `protected`/`private`/`internal` member is never
            // its slot (fix #395).
            if (resolved.def?.type === 'interface' && !_explicitInterfaceName(def) && _nonPublicMember(def)) continue;
            const members = _slotMembersOf(index, name, resolved, def, overloads,
                subst ? { memberSubst: subst } : null);
            if (members.length > 0) ancestors.push({ ref: resolved, members });
            upQueue.push({ ref: resolved, contextFile: resolved.def?.file || current.contextFile, subst,
                explicitVia: explicitViaOf(resolved, current.explicitVia) });
        }
    }

    // Children spelled their parent with a qualifier the inheritance graph
    // kept (`extends Outer.Inner<T>`): look those buckets up too.
    let qualifiedKeys = null;
    const qualifiedChildKeys = parentName => {
        if (!qualifiedKeys) {
            qualifiedKeys = new Map();
            for (const key of index.extendedByGraph.keys()) {
                const terminal = String(key).split('::').pop().split('.').pop();
                if (terminal === key) continue;
                if (!qualifiedKeys.has(terminal)) qualifiedKeys.set(terminal, []);
                qualifiedKeys.get(terminal).push(key);
            }
        }
        return [parentName, ...(qualifiedKeys.get(parentName) || [])];
    };
    // Descendants of every slot owner: the pin's class and each declaring
    // ancestor (siblings of the pin override the same slot).
    const descendants = [];
    const roots = [pinRef, ...ancestors.map(a => a.ref)];
    const downSeen = new Set(roots.map(refKey));
    // Each class carries the slot's parameter types in its own terms, read
    // through the generic base clauses from the root that declares the slot
    // (fix #390): below `Fmt : Visitor<TextWriter, bool>` the slot
    // `Visit(TState, int)` is `Visit(TextWriter, int)`.
    const slotTypesOf = member => _slotParams(member).map(p => p?.type);
    // A class whose slot member is an explicit interface implementation
    // (C#) has no subclass override of it: explicit implementations are not
    // virtual (fix #395); a subclass re-implementing the interface is found
    // through the interface.
    const onlyExplicit = members => members.length > 0 && members.every(m => m.explicitInterface);
    const interfaceSlot = pinRef.def?.type === 'interface' || !!def.explicitInterface ||
        ancestors.some(a => a.ref.def?.type === 'interface' && a.members.length > 0);
    // The interfaces whose member is this slot: their explicit
    // implementations below are slot members.
    const slotInterfaces = new Set([
        ...(pinRef.def?.type === 'interface' ? [pinRef.name] : []),
        ...ancestors.filter(a => a.ref.def?.type === 'interface' && a.members.length > 0).map(a => a.ref.name),
        ...(_explicitInterfaceName(def) ? [_explicitInterfaceName(def)] : []),
    ]);
    const downQueue = [
        { ref: pinRef, slotTypes: overloads ? slotTypesOf(def) : null, explicitOnly: !!def.explicitInterface },
        ...ancestors.map(a => ({ ref: a.ref,
            slotTypes: overloads && a.members.length === 1 ? slotTypesOf(a.members[0]) : null,
            explicitOnly: onlyExplicit(a.members) })),
    ];
    // The slot's parameter types in each class's own terms (null: unknown).
    const slotTypesByKey = new Map(downQueue.map(entry => [refKey(entry.ref), entry.slotTypes]));
    while (downQueue.length > 0 && descendants.length < 5000) {
        const currentEntry = downQueue.shift();
        const current = currentEntry.ref;
        const children = [
            ...(currentEntry.explicitOnly ? [] : qualifiedChildKeys(current.name).flatMap(key =>
                index.extendedByGraph.get(key) || []).map(child =>
                typeof child === 'string' ? { name: child, file: null }
                    : { name: child.name, file: child.file || null })),
            ...implementedBy(index, current.name),
        ];
        for (const child of children) {
            if (!child.name) continue;
            const entries = classDefsNamed(index, child.name).entries
                .filter(e => !child.file || e.def.file === child.file);
            for (const entry of entries) {
                if (downSeen.has(entry.key)) continue;
                const childRef = { name: child.name, key: entry.key, def: entry.def };
                const link = supertypeRefsOf(index, childRef, { implements: true }).find(p => {
                    if (p.external || _slotTypeName(p.name) !== current.name) return false;
                    if (p.key) return p.key === current.key;
                    return !!current.def?.file &&
                        index._resolveClassFile(current.name, entry.def.file) === current.def.file;
                });
                if (!link) continue;
                downSeen.add(entry.key);
                let slotTypes = null;
                let instantiations = null;
                if (currentEntry.slotTypes && current.def) {
                    const steps = _baseSubstitutions(index, childRef, current);
                    if (steps?.length === 1) {
                        slotTypes = currentEntry.slotTypes.map(type => _substituteType(type, steps[0]));
                    } else if (steps?.length > 1) {
                        instantiations = steps.map(step => currentEntry.slotTypes.map(type => _substituteType(type, step)));
                    }
                }
                // A class implementing the generic base more than once fills
                // the slot once per instantiation (fix #400).
                let members = instantiations
                    ? [...new Set(instantiations.flatMap(types => _slotMembersOf(index, name, childRef, def,
                        overloads, { slotTypes: types }, slotInterfaces)))]
                    : _slotMembersOf(index, name, childRef, def, overloads,
                        slotTypes ? { slotTypes } : null, slotInterfaces);
                if (link.viaImplements) members = members.filter(m => memberInClassBody(index, m));
                // In an interface member's slot a class takes part with a
                // public member or an explicit implementation only (fix
                // #395): a protected override below it overrides another
                // slot.
                if (interfaceSlot && childRef.def?.type !== 'interface') {
                    members = members.filter(m => !!m.explicitInterface || !_nonPublicMember(m));
                }
                descendants.push({ ref: childRef, members, viaImplements: !!link.viaImplements });
                downQueue.push({ ref: childRef, slotTypes, explicitOnly: onlyExplicit(members) });
                slotTypesByKey.set(entry.key, slotTypes);
            }
        }
    }
    if (startRef) {
        const own = _slotMembersOf(index, name, startRef, def, overloads);
        if (own.length > 0) ancestors.unshift({ ref: startRef, members: own });
    }
    return { pinRef, ancestors, descendants, unresolved, external, slotTypesByKey };
}

/**
 * Members of anonymous class bodies that fill the slot (fix #390): a Java
 * `new Listener<T>(..) { void run(..) {} }` or a JS/TS class expression
 * `class extends Base { m() {} }` subclasses the created or extended type
 * without being an indexed class, so its override of a renamed slot member
 * would be left behind (javac: "does not override"). Scans only the files
 * and lines where the name occurs. Returns [{ file, line, column, verdict:
 * 'edit' | 'review', reason }] with parser columns of the member's name.
 */
function anonymousSlotMembers(index, name, perFile, closure, pin) {
    const { resolveClassRef } = require('./class-identity');
    if (!closure || !perFile) return [];
    const slotKeys = new Set([closure.pinRef, ...closure.ancestors.map(a => a.ref),
        ...closure.descendants.map(d => d.ref)].filter(ref => ref?.key).map(ref => ref.key));
    if (slotKeys.size === 0) return [];
    const overloads = !!langTraits(index.files.get(pin.file)?.language)?.hasArityOverloads;
    const pinMethodParams = _orderedTypeParams({ generics: pin.generics }) || [];
    const out = [];
    for (const [file, lineNos] of perFile) {
        const fileEntry = index.files.get(file);
        if (!fileEntry || !lineNos || lineNos.size === 0) continue;
        const language = fileEntry.language;
        const javaLike = language === 'java';
        const classExpressionLanguage = ['javascript', 'typescript', 'tsx'].includes(language);
        if (!javaLike && !classExpressionLanguage) continue;
        let content;
        try { content = index._readFile(file); } catch { continue; }
        const tree = index._getParsedTree?.(file, content, language);
        if (!tree) continue;
        const namespace = (fileEntry.symbols || []).find(s => s.namespace)?.namespace || null;
        const lines = [...lineNos].sort((a, b) => a - b);
        const fileLines = index._getFileLines(file);
        const seen = new Set();
        for (const line of lines) {
            const text = fileLines[line - 1] || '';
            for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
                const node = tree.rootNode.descendantForPosition({ row: line - 1, column: at });
                if (!node || node.text !== name) continue;
                const method = node.parent;
                const methodType = javaLike ? 'method_declaration' : 'method_definition';
                if (!method || method.type !== methodType) continue;
                const nameNode = method.childForFieldName('name');
                if (!nameNode || nameNode.startIndex !== node.startIndex) continue;
                const body = method.parent;
                const owner = body?.parent;
                if (body?.type !== 'class_body' || !owner) continue;
                let typeText;
                if (javaLike && owner.type === 'object_creation_expression') {
                    typeText = owner.childForFieldName('type')?.text || null;
                } else if (javaLike && owner.type === 'enum_constant') {
                    // An enum constant's body subclasses its enum (fix #392).
                    typeText = owner.parent?.parent?.type === 'enum_declaration'
                        ? owner.parent.parent.childForFieldName('name')?.text || null : null;
                } else if (classExpressionLanguage && owner.type === 'class') {
                    const heritage = owner.namedChildren.find(child => child.type === 'class_heritage');
                    const extendsClause = heritage?.namedChildren.find(child => child.type === 'extends_clause') || heritage;
                    const value = extendsClause?.childForFieldName?.('value') || extendsClause?.namedChildren?.[0];
                    typeText = value ? `${value.text}${extendsClause.namedChildren.find(child => child.type === 'type_arguments')?.text || ''}` : null;
                } else continue;
                if (!typeText) continue;
                const key = `${file}:${nameNode.startIndex}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const head = typeText.replace(/<.*$/s, '').trim();
                const terminal = head.split(/::|\./).pop().trim();
                const ref = resolveClassRef(index, terminal, file, { namespace, line });
                const site = { file, line: nameNode.startPosition.row + 1, column: nameNode.startPosition.column };
                if (ref.external) continue;
                if (!ref.key) {
                    if (classDefsIncludeSlotName(index, terminal, slotKeys)) {
                        out.push({ ...site, verdict: 'review', reason: 'anonymous-class-type-unresolved' });
                    }
                    continue;
                }
                if (!slotKeys.has(ref.key)) continue;
                if (overloads) {
                    const params = (method.childForFieldName('parameters')?.namedChildren || [])
                        .filter(p => p.type === 'formal_parameter' || p.type === 'spread_parameter')
                        .map(p => ({ name: p.childForFieldName('name')?.text || '',
                            type: `${p.childForFieldName('type')?.text || p.namedChildren[0]?.text || ''}${p.type === 'spread_parameter' ? '...' : ''}` }));
                    const ownerTypes = closure.slotTypesByKey?.get(ref.key);
                    let slotTypes = null;
                    if (ownerTypes) {
                        const typeParams = _orderedTypeParams(ref.def);
                        const open = typeText.indexOf('<');
                        const args = open >= 0 ? _splitTypeArgs(typeText.slice(open + 1, typeText.lastIndexOf('>'))) : [];
                        if (!(typeParams && typeParams.length > 0) && args.length === 0) {
                            slotTypes = ownerTypes; // a non-generic type: nothing to substitute
                        } else if (typeParams && typeParams.length === args.length) {
                            const map = new Map();
                            typeParams.forEach((param, i) => map.set(param, args[i]));
                            slotTypes = ownerTypes.map(type => _substituteType(type, map));
                        } else if (typeParams && typeParams.length > 0 && args.length === 0 && open >= 0) {
                            slotTypes = null; // diamond `new X<>() {..}`: arguments inferred
                        }
                    }
                    const member = { paramsStructured: params, generics: null };
                    const fits = slotTypes
                        ? _slotTypesMatch(member, slotTypes, pinMethodParams)
                        : params.length === _slotParams(pin).length;
                    if (!fits) continue;
                    if (!slotTypes) {
                        out.push({ ...site, verdict: 'review', reason: 'anonymous-class-signature-unresolved' });
                        continue;
                    }
                }
                out.push({ ...site, verdict: 'edit' });
            }
        }
    }
    return out;
}

function classDefsIncludeSlotName(index, name, slotKeys) {
    const { classDefsNamed } = require('./class-identity');
    return classDefsNamed(index, name).entries.some(entry => slotKeys.has(entry.key));
}

// ---------------------------------------------------------------------------
// Go structural satisfaction
// ---------------------------------------------------------------------------

const GO_BUILTIN_TYPES = new Set([
    'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64',
    'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint',
    'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable',
]);

/** Split a Go signature list on commas outside nested type syntax. */
function splitGoSignatureList(raw) {
    const text = String(raw || '').trim().replace(/^\((.*)\)$/s, '$1');
    if (!text) return [];
    const out = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            out.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
}

const GO_UNNAMED_TYPE_PREFIX = /^(?:\*|\[|map\[|chan(?:<-)?\s|<-chan\s|func\s*\(|interface\s*\{|struct\s*\{|\.\.\.)/;

/** One raw Go parameter/result declaration -> its type spelling. */
function goDeclarationType(raw) {
    let value = String(raw || '').trim();
    if (!value) return null;
    if (!GO_UNNAMED_TYPE_PREFIX.test(value)) {
        const named = value.match(/^[A-Za-z_][A-Za-z0-9_]*\s+(.+)$/s);
        if (named) value = named[1].trim();
    }
    return value.replace(/\s+/g, '');
}

function _goKey(dir, name) { return `${dir}\0${name}`; }

function _goState(index) {
    const state = _state(index);
    if (state.go) return state.go;
    const go = {
        // key -> declarations (several when build-constrained files in one
        // package declare alternative variants of the same type: one
        // identity, every variant renamed together)
        types: new Map(),
        ifaces: new Map(),
        ambiguous: new Set(),  // keys declared both as interface and as named type
        methods: new Map(),    // owner key -> concrete method defs
        members: new Map(),    // iface key -> method element defs
        fields: new Map(),     // owner key -> field defs
        methodSets: new Map(),
        requirements: new Map(),
        fingerprints: new WeakMap(),
        typesByMethod: null,
        ifacesByMethod: null,
        conversions: null,
    };
    const push = (map, key, value) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
    };
    for (const defs of index.symbols.values()) {
        for (const def of defs) {
            if (!def.file || index.files.get(def.file)?.language !== 'go') continue;
            const dir = path.dirname(def.file);
            if (def.type === 'interface' || def.type === 'struct' || def.type === 'type') {
                const key = _goKey(dir, def.name);
                const own = def.type === 'interface' ? go.ifaces : go.types;
                const other = def.type === 'interface' ? go.types : go.ifaces;
                if (other.has(key)) go.ambiguous.add(key);
                push(own, key, def);
            } else if (def.className && def.type === 'method') {
                push(go.members, _goKey(dir, def.className), def);
            } else if (def.className && def.type === 'field') {
                push(go.fields, _goKey(dir, def.className), def);
            } else if (def.className && !NON_CALLABLE_TYPES.has(def.type)) {
                push(go.methods, _goKey(dir, def.className), def);
            }
        }
    }
    state.go = go;
    return go;
}

/** Package directory a Go qualifier names in `file`: dir, `ext:<path>`, or null. */
function _goQualifierDir(index, file, qualifier) {
    const state = _state(index);
    const memoKey = `${file}\0${qualifier}`;
    if (state.goQualifier.has(memoKey)) return state.goQualifier.get(memoKey);
    const entry = index.files.get(file);
    let result = null;
    const binding = (entry?.importBindings || []).find(b =>
        (b.alias || b.name) === qualifier);
    if (binding?.module) {
        // One resolution per importing directory and import path: every
        // file of a Go package resolves an import path the same way.
        if (!state.goImportDir) state.goImportDir = new Map();
        const dirKey = `${path.dirname(file)}\0${binding.module}`;
        if (state.goImportDir.has(dirKey)) {
            result = state.goImportDir.get(dirKey);
        } else {
            const { resolveImport } = require('./imports');
            let resolved;
            try {
                resolved = resolveImport(binding.module, file, { language: 'go', root: index.root });
            } catch { resolved = null; }
            result = resolved ? path.dirname(resolved) : `ext:${binding.module}`;
            state.goImportDir.set(dirKey, result);
        }
    }
    state.goQualifier.set(memoKey, result);
    return result;
}

/**
 * Resolve a Go type spelling (`T`, `*T`, `pkg.T`) seen in `file` to
 *   { kind: 'iface'|'type', key } | { kind: 'external', name } |
 *   { kind: 'builtin', name } | { kind: 'other' } | null (unknown).
 */
function _goResolveType(index, file, spelled) {
    const go = _goState(index);
    let text = String(spelled || '').replace(/\s+/g, '');
    const pointer = text.startsWith('*');
    text = text.replace(/^\*+/, '').replace(/\[.*\]$/s, '');
    if (text === 'interface{}' || text === 'any') return { kind: 'builtin', name: 'any', pointer };
    const match = text.match(/^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)$/);
    if (!match) return { kind: 'other' };
    const [, qualifier, name] = match;
    let dir;
    if (qualifier) {
        dir = _goQualifierDir(index, file, qualifier);
        if (!dir) return null;
        if (dir.startsWith('ext:')) return { kind: 'external', name: `${qualifier}.${name}`, pointer };
    } else {
        if (GO_BUILTIN_TYPES.has(name)) return { kind: 'builtin', name, pointer };
        dir = path.dirname(file);
    }
    const key = _goKey(dir, name);
    if (go.ambiguous.has(key)) return null;
    if (go.ifaces.has(key)) return { kind: 'iface', key, pointer };
    if (go.types.has(key)) return { kind: 'type', key, pointer };
    return qualifier ? { kind: 'external', name: `${qualifier}.${name}`, pointer } : null;
}

/** Package-canonical type text: project types become `<dir>::Name`. */
function _goCanonicalType(index, file, text) {
    const go = _goState(index);
    const dir = path.dirname(file);
    return String(text || '').replace(/\s+/g, '').replace(
        /([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g, (whole, first, second) => {
            if (second) {
                const qdir = _goQualifierDir(index, file, first);
                if (!qdir) return whole;
                return qdir.startsWith('ext:') ? `${qdir.slice(4)}.${second}` : `${qdir}::${second}`;
            }
            if (GO_BUILTIN_TYPES.has(first)) return first;
            const key = _goKey(dir, first);
            return (go.types.has(key) || go.ifaces.has(key)) ? `${dir}::${first}` : first;
        });
}

/** Compiler-shaped method fingerprint: canonical parameter + result types. */
function goMethodFingerprint(index, def) {
    const go = _goState(index);
    if (go.fingerprints.has(def)) return go.fingerprints.get(def);
    let fingerprint = null;
    let params;
    if (Array.isArray(def.paramsStructured) && def.paramsStructured.length > 0) {
        params = def.paramsStructured.map(param =>
            goDeclarationType(param.type || (param.unnamed ? param.name : null)));
    } else if (def.params === '' || def.params == null) {
        params = [];
    } else {
        params = splitGoSignatureList(def.params).map(goDeclarationType);
    }
    const results = def.returnType
        ? splitGoSignatureList(def.returnType).map(goDeclarationType) : [];
    if (!params.some(type => !type) && !results.some(type => !type)) {
        fingerprint = `${params.map(t => _goCanonicalType(index, def.file, t)).join(',')}->` +
            `${results.map(t => _goCanonicalType(index, def.file, t)).join(',')}`;
    }
    go.fingerprints.set(def, fingerprint);
    return fingerprint;
}

/** Record one method under `name`, merging build-constrained variants. */
function _goAddMethod(methods, name, fingerprint, defs) {
    const previous = methods.get(name);
    if (!previous) {
        methods.set(name, { fingerprint, def: defs[0], defs: [...defs] });
        return;
    }
    for (const d of defs) if (!previous.defs.includes(d)) previous.defs.push(d);
    if (previous.fingerprint !== fingerprint) previous.fingerprint = null;
}

function _goInRange(member, typeDef) {
    return member.file === typeDef.file && member.startLine >= typeDef.startLine &&
        member.startLine <= typeDef.endLine;
}

/**
 * Requirement set of a project interface: name -> {fingerprint, def}. `open`
 * when an embedded interface is external/unresolved (its requirements are
 * invisible); `openVia` names them.
 */
function _goRequirements(index, key, visiting = new Set()) {
    const go = _goState(index);
    if (go.requirements.has(key)) return go.requirements.get(key);
    const variants = go.ifaces.get(key);
    if (!variants || visiting.has(key)) return null;
    visiting.add(key);
    const result = { methods: new Map(), open: false, openVia: [], conflicts: new Set() };
    if (variants.some(iface => iface.generics)) {
        result.open = true; result.openVia.push('type parameters');
    }
    for (const member of go.members.get(key) || []) {
        if (!variants.some(iface => _goInRange(member, iface))) continue;
        _goAddMethod(result.methods, member.name, goMethodFingerprint(index, member), [member]);
    }
    for (const field of go.fields.get(key) || []) {
        const iface = variants.find(variant => _goInRange(field, variant));
        if (!field.embedded || !iface) continue;
        const target = _goResolveType(index, iface.file, field.fieldType || field.name);
        const inherited = target?.kind === 'iface'
            ? _goRequirements(index, target.key, visiting) : null;
        if (!inherited) {
            result.open = true;
            result.openVia.push(String(field.fieldType || field.name));
            continue;
        }
        if (inherited.open) {
            result.open = true;
            result.openVia.push(...inherited.openVia);
        }
        for (const [name, requirement] of inherited.methods) {
            if (!result.methods.has(name)) result.methods.set(name, requirement);
            else if (result.methods.get(name).def !== requirement.def) {
                _goAddMethod(result.methods, name, requirement.fingerprint, requirement.defs);
            }
        }
    }
    visiting.delete(key);
    go.requirements.set(key, result);
    return result;
}

/**
 * Method set of a project named type, including methods promoted through
 * embedded fields (structs and interfaces). Pointer and value receivers are
 * unioned: every consumer here reasons about compiling code, where a
 * conversion already proved the needed receiver form. Promotions of the same
 * name from two embeddings are ambiguous selectors (not in the set).
 */
function _goMethodSet(index, key, visiting = new Set()) {
    const go = _goState(index);
    if (go.methodSets.has(key)) return go.methodSets.get(key);
    if (go.ifaces.has(key)) {
        const requirements = _goRequirements(index, key);
        go.methodSets.set(key, requirements);
        return requirements;
    }
    const variants = go.types.get(key);
    if (!variants || visiting.has(key)) return null;
    visiting.add(key);
    const result = { methods: new Map(), open: false, openVia: [], conflicts: new Set() };
    if (variants.some(typeDef => typeDef.generics)) {
        result.open = true; result.openVia.push('type parameters');
    }
    for (const method of go.methods.get(key) || []) {
        _goAddMethod(result.methods, method.name, goMethodFingerprint(index, method), [method]);
    }
    const promoted = new Map();
    for (const field of go.fields.get(key) || []) {
        const typeDef = variants.find(variant => _goInRange(field, variant));
        if (!field.embedded || !typeDef) continue;
        const spelled = String(field.fieldType || field.name);
        const target = _goResolveType(index, typeDef.file, spelled);
        const inner = target && (target.kind === 'iface' || target.kind === 'type')
            ? _goMethodSet(index, target.key, visiting) : null;
        if (!inner) {
            result.open = true;
            result.openVia.push(spelled.replace(/^\*/, ''));
            continue;
        }
        if (inner.open) {
            result.open = true;
            result.openVia.push(...inner.openVia);
        }
        for (const [name, method] of inner.methods) {
            if (result.methods.has(name)) continue; // direct method shadows
            const previous = promoted.get(name);
            if (previous && previous.def !== method.def) result.conflicts.add(name);
            else promoted.set(name, method);
        }
        for (const name of inner.conflicts) {
            if (!result.methods.has(name)) result.conflicts.add(name);
        }
    }
    for (const [name, method] of promoted) {
        if (!result.conflicts.has(name)) result.methods.set(name, method);
    }
    visiting.delete(key);
    go.methodSets.set(key, result);
    return result;
}

function _goMethodIndexes(index) {
    const go = _goState(index);
    if (go.typesByMethod) return go;
    go.typesByMethod = new Map();
    go.ifacesByMethod = new Map();
    const push = (map, name, key) => {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(key);
    };
    for (const key of go.types.keys()) {
        if (go.ambiguous.has(key)) continue;
        const set = _goMethodSet(index, key);
        for (const name of set?.methods.keys() || []) push(go.typesByMethod, name, key);
    }
    for (const key of go.ifaces.keys()) {
        if (go.ambiguous.has(key)) continue;
        const requirements = _goRequirements(index, key);
        for (const name of requirements?.methods.keys() || []) push(go.ifacesByMethod, name, key);
    }
    return go;
}

/** Declared type of a project field `owner.field`, as {file, spelled}. */
function _goFieldType(index, ownerKey, fieldName) {
    const go = _goState(index);
    const variants = go.types.get(ownerKey);
    if (!variants) return null;
    const field = (go.fields.get(ownerKey) || []).find(f =>
        f.name === fieldName && !f.embedded && variants.some(owner => _goInRange(f, owner)));
    return field?.fieldType ? { file: field.file, spelled: field.fieldType } : null;
}

/**
 * Project callee definitions a call record names: a receiver-typed method
 * (direct or promoted), a package-qualified function, or a same-package
 * function. Receivers without a known type resolve nothing.
 */
function _goCalleeDefs(index, file, slot) {
    let candidates = (index.symbols.get(slot.callee) || []).filter(d =>
        d.file && index.files.get(d.file)?.language === 'go' &&
        !NON_CALLABLE_TYPES.has(d.type));
    if (slot.receiverType) {
        const owner = _goResolveType(index, file, slot.receiverType);
        if (!owner?.key) return [];
        candidates = candidates.filter(d => d.className &&
            _goKey(path.dirname(d.file), d.className) === owner.key);
        if (candidates.length === 0) {
            const promoted = _goMethodSet(index, owner.key)?.methods.get(slot.callee);
            if (promoted?.def) candidates = [promoted.def];
        }
        return candidates;
    }
    if (slot.receiver) {
        const dir = _goQualifierDir(index, file, slot.receiver);
        if (!dir || dir.startsWith('ext:')) return [];
        return candidates.filter(d => !d.className && path.dirname(d.file) === dir);
    }
    return candidates.filter(d => !d.className && path.dirname(d.file) === path.dirname(file));
}

/**
 * The declared result type (at `call.index`, default 0) of the callee a call
 * names: { file, spelled } for a project callee, { external } when the
 * callee or its receiver type lives outside the project, else null.
 */
function _goCallResultType(index, file, call) {
    if (call.receiver && !call.receiverType) {
        const dir = _goQualifierDir(index, file, call.receiver);
        if (dir && dir.startsWith('ext:')) return { external: `${call.receiver}.${call.callee}` };
    }
    if (call.receiverType) {
        const owner = _goResolveType(index, file, call.receiverType);
        if (owner?.kind === 'external') return { external: `${owner.name}.${call.callee}` };
    }
    const results = new Set();
    let found = null;
    const position = Number.isInteger(call.index) ? call.index : 0;
    for (const def of _goCalleeDefs(index, file, call)) {
        const list = def.returnType ? splitGoSignatureList(def.returnType) : [];
        // A call used directly as one value must have exactly one result.
        if (!Number.isInteger(call.index) && list.length !== 1) return null;
        if (!list[position]) return null;
        const spelled = goDeclarationType(list[position]);
        if (!spelled) return null;
        results.add(_goCanonicalType(index, def.file, spelled));
        found = { file: def.file, spelled };
    }
    return results.size === 1 ? found : null;
}

/** Parameter type at argIndex of the project callee an argument record names. */
function _goArgumentSlot(index, file, slot) {
    const candidates = _goCalleeDefs(index, file, slot)
        .filter(d => Array.isArray(d.paramsStructured));
    const slots = new Set();
    let owner = null;
    for (const def of candidates) {
        const params = def.paramsStructured;
        let param = params[slot.argIndex];
        if (!param) {
            const last = params[params.length - 1];
            if (last && String(last.type || '').startsWith('...')) param = last;
        }
        if (!param || !param.type) return null;
        const spelled = String(param.type).replace(/^\.\.\./, '');
        slots.add(_goCanonicalType(index, def.file, spelled));
        owner = { file: def.file, spelled };
    }
    return slots.size === 1 ? owner : null;
}

/**
 * The out-of-project callee an argument record names (`sort.Sort`, a method
 * of an out-of-project type), or null (fix #384).
 */
function _goExternalCallee(index, file, slot) {
    if (slot.receiverType) {
        const owner = _goResolveType(index, file, slot.receiverType);
        return owner?.kind === 'external' ? `${owner.name}.${slot.callee}` : null;
    }
    if (slot.receiver) {
        const dir = _goQualifierDir(index, file, slot.receiver);
        return dir && dir.startsWith('ext:') ? `${slot.receiver}.${slot.callee}` : null;
    }
    return null;
}

/**
 * Interface-conversion evidence resolved against the project: concrete type
 * key -> [{ target, site }], built once per index from the parser's
 * typeConversions records.
 */
function _goConversions(index) {
    const go = _goState(index);
    if (go.conversions) return go.conversions;
    const byConcrete = new Map();
    const externalByIface = new Map();
    for (const [file, entry] of index.files) {
        if (entry.language !== 'go' || !Array.isArray(entry.typeConversions)) continue;
        for (const record of entry.typeConversions) {
            let concrete = null;
            if (record.concrete) {
                concrete = _goResolveType(index, file, record.concrete);
            } else if (record.concreteCall) {
                const result = _goCallResultType(index, file, record.concreteCall);
                concrete = result?.external ? { kind: 'external-value', name: result.external }
                    : result ? _goResolveType(index, result.file, result.spelled) : null;
            } else if (record.concreteField) {
                const owner = _goResolveType(index, file, record.concreteField.owner);
                const fieldType = owner?.key
                    ? _goFieldType(index, owner.key, record.concreteField.field) : null;
                concrete = fieldType ? _goResolveType(index, fieldType.file, fieldType.spelled) : null;
            }
            if (!concrete) continue;
            if (concrete.kind === 'external') {
                concrete = { kind: 'external-value', name: concrete.name };
            }
            if (concrete.kind !== 'type' && concrete.kind !== 'external-value') continue;
            let slot = null;
            // A position whose declared type lives outside the project (an
            // out-of-project function's parameter, an out-of-project
            // struct's field): its type may be an interface UCN cannot see
            // (fix #384, `sort.Sort(x.(*T))`).
            let externalPosition = null;
            if (record.slot) slot = { file, spelled: record.slot };
            else if (record.fieldSlot) {
                const owner = _goResolveType(index, file, record.fieldSlot.owner);
                slot = owner?.key ? _goFieldType(index, owner.key, record.fieldSlot.field) : null;
                if (owner?.kind === 'external' && concrete.kind === 'type') {
                    externalPosition = { kind: 'external-position', position: 'field',
                        name: `${owner.name}.${record.fieldSlot.field}` };
                }
            } else if (record.argSlot) {
                slot = _goArgumentSlot(index, file, record.argSlot);
                // Only a project type's value can lose a method it renames.
                const callee = slot || concrete.kind !== 'type' ? null
                    : _goExternalCallee(index, file, record.argSlot);
                if (callee) {
                    externalPosition = { kind: 'external-position', position: 'argument',
                        name: callee, argIndex: record.argSlot.argIndex };
                }
            }
            if (!slot && !externalPosition) continue;
            const target = externalPosition || _goResolveType(index, slot.file, slot.spelled);
            if (!target || target.kind === 'other' || target.kind === 'type' ||
                (target.kind === 'builtin' && target.name !== 'error')) continue;
            if (target.pointer) continue; // pointer-to-named slots are not interfaces
            if (externalPosition && concrete.kind !== 'type') continue;
            const site = {
                file,
                relativePath: entry.relativePath || file,
                line: record.line,
                kind: record.kind,
            };
            if (concrete.kind === 'external-value') {
                // A value of an out-of-project type used as a project
                // interface: its methods cannot be renamed with the slot.
                if (target.kind !== 'iface') continue;
                if (!externalByIface.has(target.key)) externalByIface.set(target.key, []);
                externalByIface.get(target.key).push({ origin: concrete.name, site });
                continue;
            }
            if (!byConcrete.has(concrete.key)) byConcrete.set(concrete.key, []);
            byConcrete.get(concrete.key).push({ target, site });
        }
    }
    const bySite = (a, b) => (a.site.relativePath < b.site.relativePath ? -1
        : a.site.relativePath > b.site.relativePath ? 1 : a.site.line - b.site.line);
    for (const list of byConcrete.values()) list.sort(bySite);
    for (const list of externalByIface.values()) list.sort(bySite);
    go.conversions = byConcrete;
    go.externalValues = externalByIface;
    return byConcrete;
}

function _goTypeLabel(index, key) {
    const go = _goState(index);
    const defs = go.types.get(key) || go.ifaces.get(key);
    return defs ? defs[0].name : key.split('\0').pop();
}

/**
 * Satisfaction of an interface by a named type from their method sets:
 * 'yes' (every requirement present with the same canonical fingerprint and
 * the requirement set is closed), 'no' (a requirement provably missing or
 * mismatched), 'maybe' (open method set or open requirement set).
 */
function _goSatisfies(index, typeKey, ifaceKey) {
    const methods = _goMethodSet(index, typeKey);
    const requirements = _goRequirements(index, ifaceKey);
    if (!methods || !requirements) return 'maybe';
    let unknown = requirements.open;
    for (const [name, requirement] of requirements.methods) {
        const method = methods.methods.get(name);
        if (!method) {
            if (methods.open || methods.conflicts.has(name)) { unknown = true; continue; }
            return 'no';
        }
        if (method.defs.some(d => requirement.defs.includes(d))) continue;
        if (!method.fingerprint || !requirement.fingerprint) { unknown = true; continue; }
        if (method.fingerprint !== requirement.fingerprint) return 'no';
    }
    return unknown ? 'maybe' : 'yes';
}

function _defIdentity(def) {
    return `${path.resolve(def.file)}\0${def.startLine}`;
}

/**
 * Go rename closure for a method or interface-method definition: the
 * bipartite fixed point between interfaces requiring the name and named
 * types whose method sets carry it. A type joins a joined interface when it
 * structurally satisfies it (complete method sets) or when the project
 * converts it to that interface (compiler evidence that also covers
 * spelling-level gaps); an interface joins when a joined type satisfies it;
 * interfaces sharing a joined requirement by embedding and types sharing a
 * joined method by promotion join too. Implementer-side and interface-side
 * pins reach the same fixed point.
 *
 * Returns null when the name has no interface participation, else
 *   { memberDefs, memberIdentity, interfaceNames, reviews }
 * where reviews name every place the closure cannot be completed by
 * editing project declarations: types converted to external or open
 * interfaces, types that may satisfy a joined interface but have open
 * method sets, and types that get the method from an external embedding.
 */
function goContractClosure(index, def) {
    if (!def?.className || index.files.get(def.file)?.language !== 'go') return null;
    const go = _goMethodIndexes(index);
    const name = def.name;
    const dir = path.dirname(def.file);
    const ownerKey = _goKey(dir, def.className);
    const typeNodes = go.typesByMethod.get(name) || [];
    const ifaceNodes = go.ifacesByMethod.get(name) || [];
    const conversions = _goConversions(index);
    const convertedTo = (typeKey, ifaceKey) => (conversions.get(typeKey) || [])
        .some(item => item.target.kind === 'iface' && item.target.key === ifaceKey);

    const joinedTypes = new Set();
    const joinedIfaces = new Set();
    if (def.type === 'method' && go.ifaces.has(ownerKey)) {
        joinedIfaces.add(ownerKey);
    } else {
        for (const key of typeNodes) {
            if (_goMethodSet(index, key)?.methods.get(name)?.defs.includes(def)) joinedTypes.add(key);
        }
        if (joinedTypes.size === 0 && go.types.has(ownerKey)) joinedTypes.add(ownerKey);
    }
    if (joinedTypes.size === 0 && joinedIfaces.size === 0) return null;

    const joinedDefs = new Set();
    const noteDefs = () => {
        for (const key of joinedTypes) {
            const method = _goMethodSet(index, key)?.methods.get(name);
            for (const d of method?.defs || []) joinedDefs.add(d);
        }
        for (const key of joinedIfaces) {
            const requirement = _goRequirements(index, key)?.methods.get(name);
            for (const d of requirement?.defs || []) joinedDefs.add(d);
        }
    };
    noteDefs();
    let changed = true;
    let rounds = 0;
    while (changed && rounds++ < 64) {
        changed = false;
        for (const ifaceKey of ifaceNodes) {
            for (const typeKey of typeNodes) {
                if (joinedIfaces.has(ifaceKey) === joinedTypes.has(typeKey)) continue;
                const proven = _goSatisfies(index, typeKey, ifaceKey) === 'yes' ||
                    convertedTo(typeKey, ifaceKey);
                if (!proven) continue;
                if (joinedIfaces.has(ifaceKey)) joinedTypes.add(typeKey);
                else joinedIfaces.add(ifaceKey);
                changed = true;
            }
        }
        noteDefs();
        for (const ifaceKey of ifaceNodes) {
            if (joinedIfaces.has(ifaceKey)) continue;
            const requirement = _goRequirements(index, ifaceKey)?.methods.get(name);
            if (requirement?.defs.some(d => joinedDefs.has(d))) {
                joinedIfaces.add(ifaceKey); changed = true;
            }
        }
        for (const typeKey of typeNodes) {
            if (joinedTypes.has(typeKey)) continue;
            const method = _goMethodSet(index, typeKey)?.methods.get(name);
            if (method?.defs.some(d => joinedDefs.has(d))) {
                joinedTypes.add(typeKey); changed = true;
            }
        }
        noteDefs();
    }

    const reviews = [];
    const reviewKeys = new Set();
    const addReview = (site, reason, message) => {
        const key = `${site.relativePath}:${site.line}:${reason}`;
        if (reviewKeys.has(key)) return;
        reviewKeys.add(key);
        reviews.push({ ...site, reason, message });
    };
    const ifaceLabel = key => _goTypeLabel(index, key);
    const joinedIfaceNames = [...joinedIfaces].map(ifaceLabel);
    // (1) Types that may satisfy a joined interface but whose method set (or
    // the interface's requirement set) is open, with no conversion evidence.
    for (const typeKey of typeNodes) {
        if (joinedTypes.has(typeKey)) continue;
        for (const ifaceKey of joinedIfaces) {
            if (_goSatisfies(index, typeKey, ifaceKey) !== 'maybe') continue;
            const method = _goMethodSet(index, typeKey)?.methods.get(name);
            if (!method?.def || method.defs.some(d => joinedDefs.has(d))) continue;
            const openVia = [...new Set([
                ...(_goMethodSet(index, typeKey)?.openVia || []),
                ...(_goRequirements(index, ifaceKey)?.openVia || []),
            ])];
            addReview({
                file: method.def.file,
                relativePath: method.def.relativePath || _rel(index, method.def.file),
                line: method.def.nameLine || method.def.startLine,
            }, 'go-possible-satisfier',
            `${_goTypeLabel(index, typeKey)}.${name} may satisfy ${ifaceLabel(ifaceKey)}` +
                (openVia.length > 0 ? ` (method set open through ${openVia.join(', ')})` : '') +
                '; rename it too if the type is used as that interface');
            break;
        }
    }
    // (1b) Symmetric: interfaces a joined type may satisfy, but whose
    // satisfaction cannot be proven from complete method sets and has no
    // conversion evidence.
    for (const ifaceKey of ifaceNodes) {
        if (joinedIfaces.has(ifaceKey)) continue;
        const requirement = _goRequirements(index, ifaceKey)?.methods.get(name);
        if (!requirement?.def || requirement.defs.some(d => joinedDefs.has(d))) continue;
        const typeKey = [...joinedTypes].find(key => _goSatisfies(index, key, ifaceKey) === 'maybe');
        if (!typeKey) continue;
        const openVia = [...new Set([
            ...(_goMethodSet(index, typeKey)?.openVia || []),
            ...(_goRequirements(index, ifaceKey)?.openVia || []),
        ])];
        addReview({
            file: requirement.def.file,
            relativePath: requirement.def.relativePath || _rel(index, requirement.def.file),
            line: requirement.def.nameLine || requirement.def.startLine,
        }, 'go-possible-interface',
        `${_goTypeLabel(index, typeKey)} may satisfy ${ifaceLabel(ifaceKey)}` +
            (openVia.length > 0 ? ` (method set open through ${openVia.join(', ')})` : '') +
            `; rename ${ifaceLabel(ifaceKey)}.${name} too if the type is used as that interface`);
    }
    // (2) Joined types used as interfaces outside the closure.
    const exported = /^[A-Z]/.test(name);
    for (const typeKey of joinedTypes) {
        for (const { target, site } of conversions.get(typeKey) || []) {
            const typeLabel = _goTypeLabel(index, typeKey);
            if (target.kind === 'iface') {
                if (joinedIfaces.has(target.key)) continue;
                const requirements = _goRequirements(index, target.key);
                if (!requirements) continue;
                if (requirements.methods.has(name)) {
                    addReview(site, 'go-interface-outside-closure',
                        `${typeLabel} is used as ${ifaceLabel(target.key)}, which requires ` +
                        `${name} but could not be joined to the rename; rename it together`);
                } else if (requirements.open) {
                    addReview(site, 'go-open-interface',
                        `${typeLabel} is used as ${ifaceLabel(target.key)}, whose method set embeds ` +
                        `${[...new Set(requirements.openVia)].join(', ')} (outside the project); ` +
                        `if that requires ${name}, renaming breaks ${typeLabel}'s satisfaction`);
                }
            } else if (target.kind === 'external' ||
                (target.kind === 'builtin' && target.name === 'error' && name === 'Error')) {
                // An unexported method never satisfies an interface
                // declared in another package.
                if (!exported) continue;
                addReview(site, 'go-external-interface',
                    `${typeLabel} is used as external interface ${target.name}; if ${target.name} ` +
                    `requires ${name}, renaming breaks ${typeLabel}'s satisfaction`);
            } else if (target.kind === 'external-position' && exported) {
                const position = target.position === 'argument'
                    ? `passed to ${target.name} (argument ${target.argIndex + 1})`
                    : `assigned to field ${target.name}`;
                addReview(site, 'go-external-position',
                    `${typeLabel} is ${position}, whose type is declared outside the project; ` +
                    `if it is an interface requiring ${name}, renaming breaks ${typeLabel}'s satisfaction`);
            }
        }
    }
    // (3) Types converted to a joined interface that get the method from an
    // external embedding: their slot cannot be renamed in project code.
    for (const [typeKey, list] of conversions) {
        if (joinedTypes.has(typeKey)) continue;
        const methods = _goMethodSet(index, typeKey);
        if (!methods || methods.methods.has(name)) continue;
        for (const { target, site } of list) {
            if (target.kind !== 'iface' || !joinedIfaces.has(target.key)) continue;
            addReview(site, 'go-external-satisfier',
                `${_goTypeLabel(index, typeKey)} is used as ${ifaceLabel(target.key)} but gets ` +
                `${name} from ${methods.openVia.join(', ') || 'an embedding'} outside the project`);
        }
    }
    // (4) Values of out-of-project types used as a joined interface
    // (`f, err := os.Create(p); return f, err` as afero.File): their method
    // is fixed outside the project, so renaming the slot breaks them.
    for (const ifaceKey of joinedIfaces) {
        const requirement = _goRequirements(index, ifaceKey)?.methods.get(name);
        if (!requirement) continue;
        for (const { origin, site } of go.externalValues.get(ifaceKey) || []) {
            addReview(site, 'go-external-satisfier',
                `a value from ${origin} (outside the project) is used as ${ifaceLabel(ifaceKey)}; ` +
                `its ${name} cannot be renamed with the interface`);
        }
    }
    reviews.sort((a, b) => (a.relativePath < b.relativePath ? -1
        : a.relativePath > b.relativePath ? 1 : a.line - b.line));

    if (joinedIfaces.size === 0 && reviews.length === 0) return null;
    const memberDefs = [...joinedDefs].sort((a, b) =>
        (a.relativePath || a.file) < (b.relativePath || b.file) ? -1
            : (a.relativePath || a.file) > (b.relativePath || b.file) ? 1
                : a.startLine - b.startLine);
    return {
        memberDefs,
        memberIdentity: new Set(memberDefs.map(_defIdentity)),
        interfaceNames: new Set(joinedIfaceNames),
        reviews,
    };
}

// ---------------------------------------------------------------------------
// Rust macro_rules! templates
// ---------------------------------------------------------------------------

function _children(node) {
    const out = [];
    for (let i = 0; i < node.childCount; i++) out.push(node.child(i));
    return out;
}

/**
 * The item header a token tree is the body of, read backwards from its
 * siblings: `fn NAME (...) -> T { <tree> }` -> { kind: 'fn', name };
 * `impl [<..>] [Trait] for Type { <tree> }` -> { kind: 'impl', trait } (trait
 * null for inherent impls). null when the tree is not an item body.
 */
function _tokenTreeHeader(tree) {
    const parent = tree.parent;
    if (!parent) return null;
    const siblings = _children(parent);
    const at = siblings.findIndex(sibling => sibling.id === tree.id);
    if (at <= 0) return null;
    const tokens = [];
    for (let i = at - 1; i >= 0; i--) {
        const token = siblings[i];
        if (token.type === ';' || token.type === '=>' ||
            (token.type === 'token_tree' && token.text.startsWith('{'))) break;
        tokens.unshift(token);
        if (token.type === 'fn' || token.type === 'impl') break;
    }
    if (tokens.length === 0) return null;
    if (tokens[0].type === 'fn') {
        const nameToken = tokens[1];
        return nameToken?.type === 'identifier' ? { kind: 'fn', name: nameToken.text } : null;
    }
    if (tokens[0].type === 'impl') {
        const forAt = tokens.findIndex(token => token.type === 'for');
        if (forAt < 0) return { kind: 'impl', trait: null };
        const path = tokens.slice(1, forAt)
            .filter(token => token.type === 'identifier').map(token => token.text);
        return { kind: 'impl', trait: path.length > 0 ? path[path.length - 1] : null };
    }
    return null;
}

/**
 * Identifier tokens spelling `name` inside macro_rules! transcribers of the
 * given Rust files, classified by their token shape:
 *   definition  `fn NAME` (with the impl header or invocation contexts that
 *               give it a trait/inherent/module owner)
 *   method-call `.NAME(`   path-call `X::NAME(`   call `NAME(`   other
 * Each site carries the enclosing template fn (`fn get_i8 { (**self).get_i8() }`
 * forwards to the same slot) and the macro name. Token level only: what a
 * template token binds to is decided by the caller from the pin's identity.
 */
function rustMacroTemplateSites(index, name, files) {
    const { getParser, safeParse } = require('../languages');
    const parser = getParser('rust');
    if (!parser) return [];
    const sites = [];
    for (const file of files) {
        const entry = index.files.get(file);
        if (!entry || entry.language !== 'rust') continue;
        let content;
        try { content = index._readFile(file); } catch { continue; }
        // Only files that define a macro can hold template tokens; the
        // AST below decides everything, this only skips needless parses.
        if (!content.includes('macro_rules!')) continue;
        const tree = index._getParsedTree?.(file, content, 'rust') || safeParse(parser, content);
        if (!tree) continue;
        const macros = [];
        const invocations = [];
        const stack = [tree.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.type === 'macro_definition') { macros.push(node); continue; }
            if (node.type === 'macro_invocation') invocations.push(node);
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
        if (macros.length === 0) continue;
        const invocationContexts = (macroName) => {
            const contexts = [];
            for (const invocation of invocations) {
                const macroNode = invocation.childForFieldName('macro');
                if (!macroNode || macroNode.text.split('::').pop() !== macroName) continue;
                let owner = { kind: 'module' };
                for (let p = invocation.parent; p; p = p.parent) {
                    if (p.type === 'impl_item') {
                        const traitNode = p.childForFieldName('trait');
                        owner = {
                            kind: 'impl',
                            trait: traitNode ? traitNode.text.replace(/<.*$/s, '').split('::').pop() : null,
                            line: p.startPosition.row + 1,
                        };
                        break;
                    }
                    if (p.type === 'function_item') { owner = { kind: 'fn-body' }; break; }
                }
                contexts.push({ ...owner, invocationLine: invocation.startPosition.row + 1 });
            }
            return contexts;
        };
        for (const macro of macros) {
            const macroName = macro.childForFieldName('name')?.text ||
                macro.namedChildren.find(child => child.type === 'identifier')?.text || null;
            let contexts = null;
            const walk = (node, inTranscriber) => {
                for (const child of _children(node)) {
                    if (child.type === 'token_tree_pattern') continue;
                    if (child.type === 'macro_rule') { walk(child, false); continue; }
                    if (child.type === 'token_tree') {
                        walk(child, inTranscriber || node.type === 'macro_rule');
                        continue;
                    }
                    if (!inTranscriber || child.type !== 'identifier' || child.text !== name) continue;
                    const siblings = _children(node);
                    const at = siblings.findIndex(sibling => sibling.id === child.id);
                    const prev = siblings[at - 1];
                    const next = siblings[at + 1];
                    const callArgs = next?.type === 'token_tree' && next.text.startsWith('(');
                    let shape = 'other';
                    if (prev?.type === '$') continue; // metavariable, not the name
                    if (prev?.type === 'fn') shape = 'definition';
                    else if (prev?.type === '.' && callArgs) shape = 'method-call';
                    else if (prev?.type === '::' && callArgs) shape = 'path-call';
                    else if (callArgs) shape = 'call';
                    // Enclosing template item headers, innermost first.
                    let enclosingFn = null;
                    let innerImpl = null;
                    for (let t = node; t && t.type === 'token_tree'; t = t.parent) {
                        const header = _tokenTreeHeader(t);
                        if (!header) continue;
                        if (header.kind === 'fn' && !enclosingFn && shape !== 'definition') {
                            enclosingFn = header.name;
                        }
                        if (header.kind === 'impl' && !innerImpl) innerImpl = header;
                    }
                    if (!contexts) contexts = macroName ? invocationContexts(macroName) : [];
                    sites.push({
                        file,
                        relativePath: entry.relativePath || file,
                        line: child.startPosition.row + 1,
                        column: child.startPosition.column,
                        shape,
                        macroName,
                        enclosingFn,
                        owners: innerImpl
                            ? [{ kind: 'impl', trait: innerImpl.trait }]
                            : contexts,
                        ...(prev?.type === '::' && {
                            pathQualifier: siblings[at - 2]?.text || null,
                        }),
                    });
                }
            };
            walk(macro, false);
        }
    }
    sites.sort((a, b) => (a.relativePath < b.relativePath ? -1
        : a.relativePath > b.relativePath ? 1 : a.line - b.line || a.column - b.column));
    return sites;
}

/**
 * Project Go types and interfaces whose selector `T.<memberName>` resolves to
 * a project declaration (fix #383): methods (own and promoted through
 * embedding, ambiguous promotions excluded), interface requirements, and
 * directly declared fields. Returns [{ dir, typeName, defs }] sorted by key;
 * `defs` are the declarations the selector reaches (build variants joined).
 */
function goMemberProviders(index, memberName) {
    const go = _goMethodIndexes(index);
    const out = [];
    const typeNameOf = key => key.slice(key.indexOf('\0') + 1);
    const dirOf = key => key.slice(0, key.indexOf('\0'));
    for (const key of go.typesByMethod.get(memberName) || []) {
        const entry = _goMethodSet(index, key)?.methods.get(memberName);
        if (entry) out.push({ key, dir: dirOf(key), typeName: typeNameOf(key), defs: entry.defs });
    }
    for (const key of go.ifacesByMethod.get(memberName) || []) {
        const entry = _goRequirements(index, key)?.methods.get(memberName);
        if (entry) out.push({ key, dir: dirOf(key), typeName: typeNameOf(key), defs: entry.defs });
    }
    for (const [key, fields] of go.fields) {
        const variants = go.types.get(key) || go.ifaces.get(key) || [];
        const own = fields.filter(field => field.name === memberName && !field.embedded &&
            variants.some(owner => _goInRange(field, owner)));
        if (own.length > 0 && !out.some(item => item.key === key)) {
            out.push({ key, dir: dirOf(key), typeName: typeNameOf(key), defs: own });
        }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

module.exports = {
    protocolMemberOf,
    protocolMemberCertainty,
    protocolTypeOf,
    ownerDerivesFromExternal,
    rustMacroTemplateSites,
    resetContractIndex,
    ownerClassDefs,
    memberInClassBody,
    implementedBy,
    rustProjectTraits,
    rustTraitResolution,
    externalContractOf,
    hierarchySlotClosure,
    anonymousSlotMembers,
    typedLiteralContract,
    typedLiteralMembers,
    goContractClosure,
    goMethodFingerprint,
    splitGoSignatureList,
    goDeclarationType,
    goMemberProviders,
};
