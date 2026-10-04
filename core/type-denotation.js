/**
 * core/type-denotation.js - What a type NAME written at a call site denotes
 * (fix #371).
 *
 * A call site names a type in writing: the class of a constructor call
 * (`new File(..)`, `Path(..)`), the qualifier of a type-qualified call
 * (`File::create(..)`, `std::fs::File::create(..)`, `File.createTempFile(..)`)
 * or the annotated / constructed type of its receiver (`let h: File`,
 * `File f = new File(..)`). The name denotes whatever the FILE's own
 * bindings resolve it to, never whichever project type happens to share
 * the spelling. This module answers one question conservatively: does the
 * written name provably denote an EXTERNAL type?
 *
 *   - a qualifier rooted at the language's standard library
 *     (`standardPathRoots`: Rust std/core/alloc, C++ std) or at an external
 *     package binding (`use tokio_util::..`, Go `bytes.Buffer`, Java
 *     `java.io.File`),
 *   - an unqualified name bound by an import of an external module
 *     (`use std::fs::File`, `import java.io.File`, `from pathlib import
 *     Path`, `import { Server } from 'http'`, `using F = System.IO.File`),
 *     or reached only through globs of external modules (Rust
 *     `use std::sync::atomic::*`).
 *
 * A local definition of the name, a binding that resolves (or may resolve)
 * into the project, or any doubt returns null: the engine's existing
 * resolution decides, and nothing is excluded without positive evidence.
 *
 * `externalTypeGate` turns the answer into a caller/callee verdict. The
 * targets whose owner type carries the written name (the "collision set")
 * cannot be the callee when that owner is a project type: excluded
 * `external-receiver`. When the owner is itself the external type (a
 * project `impl Trait for std::fs::File`, an impl whose file `use`s the
 * external type), the call may reach it: possible dispatch (inherent
 * methods of the external type win over trait methods, so it is never
 * confirmed). An unrelated owner is left to the engine, with a receiver
 * typed by the external name stripped so that name can never pin a
 * project owner.
 *
 * Memoized on the index (`_typeDenotation`), reset at every build/load.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { langTraits } = require('../languages');
const { findCargoRoot, findGoModule } = require('./imports');

const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'record', 'union']);

function memoOf(index) {
    return index._typeDenotation || (index._typeDenotation = new Map());
}

function memoized(index, key, compute) {
    const memo = memoOf(index);
    if (memo.has(key)) return memo.get(key);
    const value = compute();
    memo.set(key, value);
    return value;
}

// ── Package metadata (dependency names) ───────────────────────────────────

/**
 * Dependencies a Cargo manifest declares, as local crate name -> 'path' |
 * 'workspace' | 'registry' (all dependency tables, target-specific and
 * workspace tables included; the table key is the local name, `-`
 * normalized to `_`). A `path` dependency is project source.
 */
function cargoDependencies(manifestDir) {
    const deps = new Map();
    let text;
    try { text = fs.readFileSync(path.join(manifestDir, 'Cargo.toml'), 'utf-8'); } catch { return deps; }
    let section = null;   // 'deps' for a dependency table, a crate name for [dependencies.<name>]
    const kindOf = body => /\bpath\s*=/.test(body) ? 'path'
        : /\bworkspace\s*=\s*true/.test(body) ? 'workspace' : 'registry';
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
        if (header) {
            const table = header[1].match(/(?:^|\.)((?:dev-|build-)?dependencies)(?:\.([A-Za-z0-9_-]+))?$/);
            if (table && table[2]) {
                section = table[2].replace(/-/g, '_');
                if (!deps.has(section)) deps.set(section, 'registry');
            } else {
                section = table ? 'deps' : null;
            }
            continue;
        }
        if (!section) continue;
        if (section !== 'deps') {
            if (/^path\s*=/.test(line)) deps.set(section, 'path');
            else if (/^workspace\s*=\s*true/.test(line) && deps.get(section) !== 'path') deps.set(section, 'workspace');
            continue;
        }
        const entry = line.match(/^([A-Za-z0-9_-]+)\s*(?:\.[A-Za-z0-9_.-]+)?\s*=(.*)$/);
        if (entry) {
            const name = entry[1].replace(/-/g, '_');
            const kind = kindOf(entry[2]);
            if (deps.get(name) !== 'path') deps.set(name, kind);
        }
    }
    return deps;
}

function cargoPackageName(dir) {
    try {
        const text = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf-8');
        const section = text.split(/^\s*\[/m).find(part => part.startsWith('package]'));
        const match = section && section.match(/^\s*name\s*=\s*"([^"]+)"/m);
        return match ? match[1].replace(/-/g, '_') : null;
    } catch { return null; }
}

/**
 * Crates the project itself builds, from the root manifest alone (no tree
 * walk): the root package, `[workspace] members` (simple `dir/*` globs
 * expanded one level), and `[patch.*]` path overrides.
 */
function cargoWorkspaceCrates(root) {
    const names = new Set();
    let text;
    try { text = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf-8'); } catch { return names; }
    const own = cargoPackageName(root);
    if (own) names.add(own);
    const members = text.match(/^\s*members\s*=\s*\[([\s\S]*?)\]/m);
    for (const quoted of (members ? members[1].replace(/#.*$/gm, '').match(/"([^"]+)"/g) || [] : [])) {
        const member = quoted.slice(1, -1);
        const dirs = [];
        if (member.endsWith('/*')) {
            const base = path.join(root, member.slice(0, -2));
            try {
                for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
                    if (entry.isDirectory()) dirs.push(path.join(base, entry.name));
                }
            } catch { /* missing glob base */ }
        } else if (!/[*?[]/.test(member)) {
            dirs.push(path.join(root, member));
        }
        for (const dir of dirs) {
            const name = cargoPackageName(dir);
            if (name) names.add(name);
        }
    }
    let inPatch = false;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
        if (header) { inPatch = header[1].startsWith('patch.'); continue; }
        const entry = inPatch && line.match(/^([A-Za-z0-9_-]+)\s*=.*\bpath\s*=/);
        if (entry) names.add(entry[1].replace(/-/g, '_'));
    }
    return names;
}

/** External crate names visible to a Rust file: its manifest's registry
 * dependencies (workspace-inherited ones resolved against the project
 * root's workspace table); `path` dependencies are project crates. */
function rustExternalCrates(index, filePath) {
    const cargo = findCargoRoot(path.dirname(filePath));
    const manifestDir = cargo?.root || index.root;
    return memoized(index, `\x01crates\x00${manifestDir}`, () => {
        const root = memoized(index, '\x01crates-root', () => cargoDependencies(index.root));
        const names = new Set();
        for (const deps of [cargoDependencies(manifestDir), root]) {
            for (const [name, kind] of deps) {
                const resolved = kind === 'workspace' ? root.get(name) || 'registry' : kind;
                if (resolved === 'registry') names.add(name);
            }
        }
        for (const [name, kind] of cargoDependencies(manifestDir)) {
            if (kind === 'path' || (kind === 'workspace' && root.get(name) === 'path')) names.delete(name);
        }
        for (const name of memoized(index, '\x01crates-workspace', () => cargoWorkspaceCrates(index.root))) {
            names.delete(name);
        }
        return names;
    });
}

/** Package names the nearest package.json (up to the project root)
 * declares, plus Node's builtin modules. */
function jsExternalPackages(index, filePath) {
    let dir = path.dirname(filePath);
    let manifest = null;
    while (dir.startsWith(index.root)) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) { manifest = candidate; break; }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return memoized(index, `\x01npm\x00${manifest || ''}`, () => {
        const names = new Set();
        if (manifest) {
            try {
                const json = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
                for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
                    for (const name of Object.keys(json[field] || {})) names.add(name);
                }
            } catch { /* unreadable manifest: builtins only */ }
        }
        return names;
    });
}

let nodeBuiltins = null;
function isNodeBuiltin(specifier) {
    if (specifier.startsWith('node:')) return true;
    if (!nodeBuiltins) nodeBuiltins = new Set(require('module').builtinModules);
    return nodeBuiltins.has(specifier.split('/')[0]) || nodeBuiltins.has(specifier);
}

function jsPackageName(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Namespaces (C#) / packages (Java) the project itself declares. */
function projectNamespaces(index, language) {
    return memoized(index, `\x01ns\x00${language}`, () => {
        const names = new Set();
        for (const [, fileEntry] of index.files) {
            if (fileEntry.language !== language) continue;
            for (const symbol of fileEntry.symbols || []) {
                if (symbol.namespace) names.add(symbol.namespace);
            }
        }
        return names;
    });
}

/** Is some leading dotted prefix of `qualified` (the full path excluded) a
 * namespace/package the project declares? `org.junit.Assert` is project
 * code when `org.junit` is a project package; nested types keep their
 * package prefix (`a.b.Outer.Inner`). */
function hasProjectNamespacePrefix(index, language, qualified) {
    const names = projectNamespaces(index, language);
    const segments = String(qualified).split('.');
    for (let i = segments.length - 1; i > 0; i--) {
        if (names.has(segments.slice(0, i).join('.'))) return true;
    }
    return false;
}

// ── Module externality ────────────────────────────────────────────────────

function rustRootIsLocal(index, fileEntry, filePath, root, exceptBinding) {
    if ((fileEntry.importBindings || []).some(binding => binding !== exceptBinding &&
        (binding.alias || binding.name) === root)) return true;
    if ((index.symbols.get(root) || []).some(definition =>
        definition.file === filePath && definition.type === 'module')) return true;
    const dir = path.dirname(filePath);
    return fs.existsSync(path.join(dir, `${root}.rs`)) || fs.existsSync(path.join(dir, root, 'mod.rs'));
}

/** Does a Rust path (`std::fs`, `tokio_util::sync`) name an external crate? */
function rustPathIsExternal(index, fileEntry, filePath, pathText, exceptBinding) {
    const root = String(pathText || '').split('::').filter(Boolean)[0];
    if (!root || root === 'crate' || root === 'self' || root === 'super' || root === 'Self') return false;
    if (rustRootIsLocal(index, fileEntry, filePath, root, exceptBinding)) {
        // `use std::sync; sync::Mutex` - the root is itself a binding.
        const binding = (fileEntry.importBindings || []).find(candidate =>
            candidate !== exceptBinding && (candidate.alias || candidate.name) === root &&
            candidate.name !== '*');
        return !!binding && binding.module !== pathText &&
            rustPathIsExternal(index, fileEntry, filePath, binding.module, binding);
    }
    if (langTraits('rust').standardPathRoots.includes(root)) return true;
    return rustExternalCrates(index, filePath).has(root);
}

/**
 * Does an import binding of this file bind its name to an external module?
 * Only positive evidence: resolver gaps, relative paths, project package
 * names and anything unmodelled answer false.
 */
function bindingIsExternal(index, fileEntry, filePath, binding) {
    const module = String(binding?.module || '');
    if (!module || binding.dynamic) return false;
    switch (fileEntry.language) {
        case 'rust':
            return rustPathIsExternal(index, fileEntry, filePath, module, binding);
        case 'java': {
            if (binding.name === '*') return false;
            if (hasProjectNamespacePrefix(index, 'java', module)) return false;
            const suffix = `/${module.split('.').join('/')}.java`;
            for (const file of index.files.keys()) if (file.endsWith(suffix)) return false;
            // A package no project file declares: the standard library is
            // external; anything else may be a resolver gap (generated
            // sources) and is never exclusion evidence (fix #353).
            return standardRooted('java', module) ? true : 'unresolved';
        }
        case 'csharp': {
            // An alias target resolves from the namespace the directive sits
            // in (fix #395), through an alias of an enclosing scope (#401).
            const target = csharpResolveUsingName(index,
                csharpAliasExpandedModule(fileEntry, binding), binding.namespace);
            if (!target.includes('.') || hasProjectNamespacePrefix(index, 'csharp', target)) return false;
            return standardRooted('csharp', target) ? true : 'unresolved';
        }
        case 'go': {
            const goModule = findGoModule(path.dirname(filePath));
            if (!goModule) return false;
            const inside = prefix => module === prefix || module.startsWith(`${prefix}/`);
            if (inside(goModule.modulePath)) return false;
            if ((goModule.replaces || []).some(entry => inside(entry.from))) return false;
            return true;
        }
        case 'javascript': case 'typescript': case 'tsx': {
            if (fileEntry.moduleResolved?.[module]) return false;
            if (/^[./~#]/.test(module) || module.startsWith('@/')) return false;
            if (isNodeBuiltin(module)) return true;
            return jsExternalPackages(index, filePath).has(jsPackageName(module));
        }
        case 'python': {
            if (fileEntry.moduleResolved?.[module] || module.startsWith('.')) return false;
            const { _unresolvedModuleIsGap } = require('./callers');
            return !_unresolvedModuleIsGap(index, module, binding);
        }
        default:
            return false;
    }
}

function standardRooted(language, qualified) {
    const root = String(qualified).split(/::|\./)[0];
    return (langTraits(language)?.standardPathRoots || []).includes(root);
}

/** The name an import binding gives the imported entity at its origin. */
function bindingOriginalName(fileEntry, binding) {
    if (fileEntry.language === 'csharp') return String(binding.module).split('.').pop();
    return binding.name;
}

// ── Denotation ────────────────────────────────────────────────────────────

/**
 * Does the type name `name` (optionally written under `qualifier`) denote an
 * external type in `filePath`? Returns { original, via } (the external
 * type's own name and the evidence) or null (project, unknown, or no
 * evidence - the caller keeps its own resolution).
 */
function externalTypeDenotation(index, filePath, name, qualifier, line, options = {}) {
    if (!name) return null;
    const scoped = rustScopedLine(index, filePath, line);
    // `unscoped`: the site's spelling of the name is unknown (the parser kept
    // only the last segment), so package/namespace scoping cannot apply.
    const unscoped = options.unscoped === true;
    const key = `${filePath}\x00${name}\x00${qualifier || ''}\x00${scoped ?? ''}\x00${unscoped ? 1 : 0}`;
    return memoized(index, key, () => {
        const fileEntry = index.files.get(filePath);
        if (!fileEntry) return null;
        const language = fileEntry.language;
        if (qualifier) return qualifiedDenotation(index, fileEntry, filePath, name, qualifier);
        // A local definition of the name decides (shadows imports). Rust
        // items are visible in their own module only: an inline `mod rand
        // { use std::..::AtomicU32; }` does not see the file's own struct.
        const moduleOf = rustLine => innermostScope((fileEntry.symbols || []).filter(symbol =>
            symbol.type === 'module' && symbol.endLine > symbol.startLine), rustLine);
        const siteModule = language === 'rust' && line != null ? moduleOf(line) : undefined;
        if ((index.symbols.get(name) || []).some(definition => definition.file === filePath &&
            (TYPE_KINDS.has(definition.type) || definition.type === 'type') &&
            (siteModule === undefined || moduleOf(definition.startLine) === siteModule))) return null;
        let bindings = (fileEntry.importBindings || []).filter(binding =>
            binding.name !== '*' && (binding.alias || binding.name) === name && binding.module);
        if (language === 'rust' && (bindings.length > 1 || line != null)) bindings = rustBindingsInScope(fileEntry, bindings, line);
        if (bindings.length > 0) {
            const verdicts = bindings.map(binding => bindingIsExternal(index, fileEntry, filePath, binding));
            if (verdicts.some(verdict => !verdict)) return null;
            const originals = new Set(bindings.map(binding => bindingOriginalName(fileEntry, binding)));
            if (originals.size !== 1) return null;
            const original = [...originals][0];
            // An import names ONE fully qualified type (fix #372): even when
            // its package is unresolvable (a possible generated-source gap),
            // a project type whose package cannot prefix that name is not it.
            const settled = verdict => verdict === true ||
                (langTraits(language)?.typeNameScoping &&
                    bindings.every(binding => !fqnMayName(index, language, original, binding.module)));
            return { original, via: bindings[0].module,
                ...(!verdicts.every(settled) && { certain: false }) };
        }
        // Java/C#: the name reaches the file through its package/namespace
        // and on-demand imports (fix #372).
        const scoping = langTraits(language)?.typeNameScoping;
        if (scoping) return unscoped ? null : scopedTypeDenotation(index, fileEntry, filePath, name, line, scoping);
        // Rust names reach a file only through `use` (named or glob): when
        // every glob is an external module, the name is not a project type.
        if (language === 'rust') {
            const globs = (fileEntry.importDetails || []).filter(detail =>
                detail.type === 'use-glob' && detail.module);
            if (globs.length > 0 && globs.every(glob =>
                rustPathIsExternal(index, fileEntry, filePath, glob.module, null))) {
                return { original: name, via: `${globs[0].module}::*` };
            }
        }
        return null;
    });
}

// ── Java / C# name scoping (fix #372) ─────────────────────────────────────

/**
 * An unqualified type name with no declaration in the file and no
 * single-name import, resolved by the language's scoping rules against the
 * PROJECT types of that name:
 *   Java (JLS 6.4.1, 7.5): member types, the compilation unit, single-type
 *   imports, the same package, then on-demand imports together with the
 *   implicit `java.lang.*` (two on-demand sources of one name are ambiguous).
 *   C# (spec 7.6.5): member types, then for each enclosing namespace from
 *   the innermost outwards its members and its using directives; global
 *   usings (source and project-file <Using> items) apply everywhere. Using
 *   directives are taken file-wide, which can only keep a project type in
 *   scope (never exclude one).
 * Returns { original, via, certain? } when no project type of that name is in
 * scope (the name is external), { certain: false } when a project type and
 * the implicit imports both supply it (ambiguous), and null when a project
 * type is in scope or anything is unmodelled (nested or inherited member
 * types, a field of that name, an unknown enclosing namespace).
 */
function scopedTypeDenotation(index, fileEntry, filePath, name, line, scoping) {
    const language = fileEntry.language;
    const definitions = (index.symbols.get(name) || []).filter(definition =>
        index.files.get(definition.file)?.language === language);
    const projectTypes = definitions.filter(definition => TYPE_KINDS.has(definition.type));
    if (projectTypes.length === 0) return null;
    // Member types (own, inherited, statically imported) precede package
    // scope; a field or property of that name obscures the type.
    if (projectTypes.some(definition => definition.isNested || definition.enclosingType ||
        definition.className)) return null;
    if (definitions.some(definition => definition.type === 'field' || definition.type === 'property')) return null;
    if (projectTypes.some(definition => !definition.namespace)) return null; // unnamed package / global namespace
    // A site outside any recorded package/namespace is unknown, not the
    // global namespace: preprocessor branches can hide a C# namespace
    // declaration from the parse.
    const siteNamespace = siteNamespaceOf(fileEntry, line);
    if (!siteNamespace) return null;
    const onDemand = (fileEntry.importDetails || [])
        .filter(detail => detail.module && (detail.names || []).includes('*'))
        .map(detail => String(detail.module).replace(/\.\*$/, ''));
    const inScope = new Set();
    if (scoping === 'package-on-demand') {
        inScope.add(siteNamespace);
        const onDemandProject = projectTypes.some(definition => onDemand.includes(definition.namespace));
        if (projectTypes.some(definition => definition.namespace === siteNamespace)) return null;
        const implicit = langTraits(language)?.implicitTypeImport;
        const implicitHas = !!implicit?.names?.has(name);
        if (onDemandProject) {
            return implicitHas ? { original: name, via: `${implicit.module}.${name}`, certain: false } : null;
        }
        if (implicitHas) return { original: name, via: `${implicit.module}.${name}` };
        const external = onDemand.filter(module => !hasProjectNamespacePrefix(index, language, `${module}.${name}`) &&
            !projectNamespaces(index, language).has(module));
        if (external.length === 0) return null;
        return { original: name, via: `${external[0]}.*`,
            ...(!external.every(module => standardRooted(language, module)) && { certain: false }) };
    }
    // namespace-usings
    const enclosing = [];
    for (let parts = siteNamespace ? siteNamespace.split('.') : []; parts.length > 0; parts = parts.slice(0, -1)) {
        enclosing.push(parts.join('.'));
    }
    if (projectTypes.some(definition => enclosing.includes(definition.namespace))) return null;
    // Directives resolved the way C# resolves them (fix #395): `using
    // Internal;` inside `namespace Acme.Tests` names Acme.Internal. A using
    // alias spelled like the name, or an unreadable project file, is not
    // modelled.
    const scope = csharpUsings(index, filePath);
    if (scope.unreadable || scope.aliases.has(name)) return null;
    // `using static T` also brings T's nested types (already abstained above).
    const usings = new Set([...scope.namespaces, ...scope.statics]);
    if (projectTypes.some(definition => usings.has(definition.namespace))) return null;
    const external = [...usings].filter(module => !csharpDeclaredNames(index).namespaces.has(module));
    return { original: name, via: external.length > 0 ? `${external.sort()[0]}.${name}` : name };
}

/** Could a project type named `name` be the type `fqn` names? Only a type
 * in a named package/namespace that prefixes it (nested types included). */
function fqnMayName(index, language, name, fqn) {
    return (index.symbols.get(name) || []).some(definition => TYPE_KINDS.has(definition.type) &&
        index.files.get(definition.file)?.language === language &&
        !!definition.namespace && String(fqn).startsWith(`${definition.namespace}.`));
}

/** The package (Java) or innermost enclosing namespace (C#) at `line`:
 * the namespace of the innermost type declared around it, else the one
 * namespace every type of the file shares; undefined when unknown. */
function siteNamespaceOf(fileEntry, line) {
    const types = (fileEntry.symbols || []).filter(symbol => TYPE_KINDS.has(symbol.type));
    if (line != null) {
        const around = innermostScope(types.filter(symbol => symbol.endLine >= symbol.startLine), line);
        if (around) return around.namespace || '';
    }
    const namespaces = new Set(types.map(symbol => symbol.namespace || ''));
    return namespaces.size === 1 ? [...namespaces][0] : undefined;
}

// ── C# using directives (fix #395) ───────────────────────────────────────

/** Namespaces the C# project declares (every leading prefix of a declared
 * namespace is one too) and the fully qualified names of its types. */
function csharpDeclaredNames(index) {
    return memoized(index, '\x01cs-declared', () => {
        const declared = new Set();
        const types = new Set();
        for (const [, fileEntry] of index.files) {
            if (fileEntry.language !== 'csharp') continue;
            for (const symbol of fileEntry.symbols || []) {
                if (!TYPE_KINDS.has(symbol.type) && symbol.type !== 'delegate') continue;
                const namespace = symbol.namespace || '';
                if (namespace) declared.add(namespace);
                const outer = symbol.enclosingType ? `${symbol.enclosingType}.` : '';
                types.add(`${namespace ? `${namespace}.` : ''}${outer}${symbol.name}`);
            }
        }
        const namespaces = new Set();
        for (const namespace of declared) {
            for (let at = namespace.indexOf('.'); at !== -1; at = namespace.indexOf('.', at + 1)) {
                namespaces.add(namespace.slice(0, at));
            }
            namespaces.add(namespace);
        }
        return { namespaces, types };
    });
}

/**
 * The namespace or type a C# using directive names (spec 14.5.2): written
 * inside `namespace A.B`, its first identifier binds in A.B, then A, then the
 * global namespace, the first that declares a namespace or type of that name
 * winning. `global using` directives, project-file <Using> items and
 * `global::` spellings are resolved from the global namespace. A name no
 * enclosing namespace declares keeps its spelling (an external namespace).
 */
function csharpResolveUsingName(index, written, enclosing) {
    const text = String(written || '').replace(/\s+/g, '').replace(/^global::/, '');
    if (!enclosing || !text) return text;
    const first = text.split('.')[0].replace(/<.*$/s, '');
    const { namespaces, types } = csharpDeclaredNames(index);
    for (let parts = String(enclosing).split('.'); parts.length > 0; parts = parts.slice(0, -1)) {
        const candidate = `${parts.join('.')}.${first}`;
        if (namespaces.has(candidate) || types.has(candidate)) return `${parts.join('.')}.${text}`;
    }
    return text;
}

/**
 * A using alias directive's written target with a leading alias declared in
 * an enclosing scope substituted (fix #401): `using W = LC.Widget;` inside
 * `namespace App` after a compilation-unit `using LC = Lib.Core;`.
 */
function csharpAliasExpandedModule(fileEntry, binding) {
    let module = String(binding?.module || '');
    const scope = binding?.namespace || '';
    for (let hop = 0; hop < 4; hop++) {
        const [head, ...rest] = module.split('.');
        const outer = (fileEntry?.importBindings || []).find(other => other !== binding &&
            other.kind === 'using' && other.name === head && other.module &&
            (other.namespace || '') !== scope &&
            ((other.namespace || '') === '' || scope.startsWith(`${other.namespace}.`)));
        if (!outer || rest.length === 0) break;
        module = [outer.module, ...rest].join('.');
    }
    return module;
}

/** A directive record's target with its generic arguments removed. */
function csharpUsingTarget(text) {
    return String(text || '').replace(/<.*$/s, '');
}

function csharpAddDirective(scope, index, { module, names, static: isStatic, namespace }) {
    const target = csharpUsingTarget(csharpResolveUsingName(index, module, namespace));
    if (!target) return;
    const alias = (names || []).find(name => name && name !== '*');
    if (alias) {
        scope.aliases.set(alias, target);
        if (!scope.aliasScopes) scope.aliasScopes = new Map();
        scope.aliasScopes.set(alias, namespace || '');
    }
    else if (isStatic) scope.statics.add(target);
    else scope.namespaces.add(target);
}

/**
 * Using directives in effect in a C# file (fix #395): the file's own
 * directives (resolved from the namespace each is written in), `global
 * using` directives of every source file, and the <Using> items of the
 * project files above it (`csharpProjectFileUsings`).
 * Returns { namespaces: Set, statics: Set (type names), aliases: Map
 * (alias -> target), unreadable } - unreadable when a project file could not
 * be read (its items are unknown).
 */
function csharpUsings(index, filePath) {
    return memoized(index, `\x01cs-usings\x00${filePath}`, () => {
        const scope = { namespaces: new Set(), statics: new Set(), aliases: new Map(), unreadable: false };
        const globals = memoized(index, '\x01cs-global-usings', () => {
            const out = [];
            for (const [, entry] of index.files) {
                if (entry.language !== 'csharp') continue;
                for (const detail of entry.importDetails || []) {
                    if (detail.global && detail.module) out.push(detail);
                }
            }
            return out;
        });
        for (const detail of globals) csharpAddDirective(scope, index, detail);
        const fileEntry = index.files.get(filePath);
        for (const detail of fileEntry?.importDetails || []) {
            if (detail.type === 'using' && detail.module && !detail.global) {
                csharpAddDirective(scope, index, detail);
            }
        }
        for (const item of csharpProjectFileUsings(index, filePath)) {
            if (item === null) { scope.unreadable = true; continue; }
            csharpAddDirective(scope, index, item);
        }
        csharpExpandAliasTargets(scope);
        return scope;
    });
}

/**
 * A using alias's target may begin with an alias declared in an enclosing
 * scope (fix #401: `using LC = Lib.Core;` in the compilation unit, then
 * `namespace App { using W = LC.Widget; }`). Aliases of the same body never
 * see each other (C# spec, using alias directives).
 */
function csharpExpandAliasTargets(scope) {
    const scopes = scope.aliasScopes;
    if (!scopes || scope.aliases.size < 2) return;
    const encloses = (outer, inner) => outer !== inner && (outer === '' || inner.startsWith(`${outer}.`));
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const [alias, target] of scope.aliases) {
            const [head, ...rest] = String(target).split('.');
            if (head === alias || !scope.aliases.has(head)) continue;
            if (!encloses(scopes.get(head) ?? '', scopes.get(alias) ?? '')) continue;
            scope.aliases.set(alias, [scope.aliases.get(head), ...rest].join('.'));
            changed = true;
        }
        if (!changed) break;
    }
}

/** The directory whose `.git` marks the repository holding `dir`, or null. */
function gitTopOf(index, dir) {
    return memoized(index, `\x01git-top\x00${dir}`, () => {
        for (let current = dir; ; current = path.dirname(current)) {
            try { if (fs.existsSync(path.join(current, '.git'))) return current; } catch { /* keep walking */ }
            if (current === path.dirname(current)) return null;
        }
    });
}

/**
 * <Using> items of the MSBuild project files above a C# file: the .csproj
 * and Directory.Build.props/targets of every directory from the file's up
 * to the index root, and on up to the repository root when the index root
 * lies inside one (fix #395: MSBuild imports Directory.Build.props from
 * ancestor directories, so a sub-project indexed on its own still sees the
 * repository's usings). `<Using Include="X"/>` is `global using X;`,
 * `Static="true"` a `global using static`, `Alias="Z"` a `global using Z =`;
 * null marks a file that could not be read.
 */
function csharpProjectFileUsings(index, filePath) {
    const dirs = [];
    const root = path.resolve(index.root);
    let dir = path.dirname(filePath);
    for (; ; dir = path.dirname(dir)) {
        dirs.push(dir);
        if (dir === root || !dir.startsWith(root) || dir === path.dirname(dir)) break;
    }
    if (dir === root) {
        const top = gitTopOf(index, root);
        if (top && top !== root && root.startsWith(top + path.sep)) {
            for (let up = path.dirname(root); ; up = path.dirname(up)) {
                dirs.push(up);
                if (up === top || up === path.dirname(up)) break;
            }
        }
    }
    return dirs.flatMap(current => memoized(index, `\x01cs-proj-usings\x00${current}`, () => {
        let names;
        try { names = fs.readdirSync(current); } catch { return []; }
        const out = [];
        for (const file of names.sort()) {
            if (!/\.csproj$|^Directory\.Build\.(props|targets)$/.test(file)) continue;
            let text;
            try { text = fs.readFileSync(path.join(current, file), 'utf-8'); } catch { out.push(null); continue; }
            for (const match of text.matchAll(/<Using\b([^>]*)>/g)) {
                const include = /\bInclude\s*=\s*"([^"]+)"/.exec(match[1]);
                if (!include) continue;
                const alias = /\bAlias\s*=\s*"([^"]+)"/.exec(match[1]);
                out.push({
                    module: include[1].trim(),
                    names: alias ? [alias[1].trim()] : ['*'],
                    ...(/\bStatic\s*=\s*"true"/i.test(match[1]) && { static: true }),
                });
            }
        }
        return out;
    }));
}

/** Namespaces every C# file sees through `global using` directives and
 * project-file items, plus null when a project file is unreadable. */
function csharpGlobalUsings(index, filePath) {
    const scope = csharpUsings(index, filePath);
    return scope.unreadable ? [...scope.namespaces, null] : [...scope.namespaces];
}

// Rust `use` declarations are scoped to their module or block: an inline
// `mod rand { use std::sync::atomic::AtomicU32; }` binds nothing outside it.
function rustScopes(fileEntry) {
    return (fileEntry.symbols || []).filter(symbol => symbol.endLine > symbol.startLine &&
        (symbol.type === 'module' || symbol.type === 'function' || symbol.type === 'method'));
}

function innermostScope(scopes, line) {
    let best = null;
    for (const scope of scopes) {
        if (scope.startLine <= line && scope.endLine >= line &&
            (!best || scope.endLine - scope.startLine < best.endLine - best.startLine)) best = scope;
    }
    return best;
}

/** The site line, when a Rust file has scoped `use` declarations (memo key). */
function rustScopedLine(index, filePath, line) {
    if (line == null) return null;
    const fileEntry = index.files.get(filePath);
    return fileEntry?.language === 'rust' ? line : null;
}

/** Bindings visible at `line`: those of the innermost enclosing scope that
 * declares any (a scope's `use` shadows its parents'); none when the line is
 * unknown and the bindings disagree in scope. */
function rustBindingsInScope(fileEntry, bindings, line) {
    const scopes = rustScopes(fileEntry);
    const scopeOf = binding => binding.line == null ? null : innermostScope(scopes, binding.line);
    if (line == null) {
        return new Set(bindings.map(scopeOf)).size === 1 ? bindings : [];
    }
    let best = null;
    let visible = [];
    for (const binding of bindings) {
        const scope = scopeOf(binding);
        if (scope && !(scope.startLine <= line && scope.endLine >= line)) continue;
        const span = scope ? scope.endLine - scope.startLine : Infinity;
        if (best === null || span < best) { best = span; visible = [binding]; }
        else if (span === best) visible.push(binding);
    }
    return visible;
}

function qualifiedDenotation(index, fileEntry, filePath, name, qualifier) {
    const language = fileEntry.language;
    switch (language) {
        case 'rust':
            return rustPathIsExternal(index, fileEntry, filePath, qualifier, null)
                ? { original: name, via: `${qualifier}::${name}` } : null;
        case 'cpp': {
            const root = String(qualifier).replace(/^::/, '').split('::')[0];
            if (!langTraits(language)?.standardPathRoots?.includes(root)) return null;
            // A project that declares the namespace itself (`namespace std`
            // specializations) keeps its own resolution.
            const declares = (index.symbols.get(name) || []).some(definition =>
                String(definition.namespace || '').split('::')[0] === root);
            return declares ? null : { original: name, via: `${qualifier}::${name}` };
        }
        case 'java': {
            if (!/^[a-z_]/.test(qualifier)) return null;
            const bindingIsType = (fileEntry.importBindings || []).some(binding =>
                (binding.alias || binding.name) === qualifier.split('.')[0]);
            if (bindingIsType) return null;
            const verdict = bindingIsExternal(index, fileEntry, filePath, { module: `${qualifier}.${name}`, name });
            if (!verdict) return null;
            return { original: name, via: `${qualifier}.${name}`, ...(verdict !== true && { certain: false }) };
        }
        case 'javascript': case 'typescript': case 'tsx': case 'python': {
            const bindings = (fileEntry.importBindings || []).filter(binding =>
                (binding.alias || binding.name) === qualifier && binding.module);
            if (bindings.length === 0) return null;
            if (!bindings.every(binding =>
                ['import', 'namespace', 'require', 'default'].includes(binding.kind))) return null;
            return bindings.every(binding => bindingIsExternal(index, fileEntry, filePath, binding))
                ? { original: name, via: `${bindings[0].module}.${name}` } : null;
        }
        default:
            return null;
    }
}

/**
 * The type a call record names in writing, or null.
 * { name, qualifier, receiverTyped } - receiverTyped marks a receiver whose
 * TYPE (not the callee name) was written: annotation or constructor.
 */
function siteWrittenType(index, fileEntry, call) {
    const written = siteWrittenTypeRaw(index, fileEntry, call);
    if (!written || written.qualifier || !langTraits(fileEntry.language)?.typeNameScoping ||
        !projectTypeNamed(index, written.name)) return written;
    // Java/C# (fix #372): an unqualified name is resolved by package or
    // namespace scope, so the site's own spelling must be unqualified. The
    // parser keeps the last segment of `new b.Thread()` / `b.Thread t`; the
    // written text at the recorded span decides.
    const span = written.receiverTyped
        ? call.receiverTypeEvidence
        : (call.isMethod ? null : call.callSite);
    if (written.receiverTyped || !call.isMethod) {
        const spelled = spelledTypeQualifier(index, fileEntry, span, written.name);
        if (spelled === undefined) return { ...written, unscoped: true };
        if (spelled) return { ...written, qualifier: spelled };
    }
    return written;
}

/** The qualifier a type name is spelled with at a recorded source span
 * (`new b.Thread()` -> 'b', `Thread` -> null); undefined when unknown. */
function spelledTypeQualifier(index, fileEntry, span, name) {
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) return undefined;
    const filePath = path.join(index.root, fileEntry.relativePath);
    let content;
    try { content = index._readFile(filePath); } catch { return undefined; }
    if (typeof content !== 'string') return undefined;
    const text = content.slice(span.start, span.end).replace(/^\s*new\b/, '')
        .replace(/[<([{].*$/s, '').replace(/\s+/g, '');
    if (text === name) return null;
    if (!text.endsWith(`.${name}`)) return undefined;
    return text.slice(0, -name.length - 1).replace(/^global::/, '') || undefined;
}

function siteWrittenTypeRaw(index, fileEntry, call) {
    const language = fileEntry.language;
    if (!call.isMethod) {
        // Constructor-shaped call: the callee name is a type name.
        if (!call.isConstructor && !(index.symbols.get(call.name) || []).some(definition =>
            TYPE_KINDS.has(definition.type))) return null;
        return { name: call.name, qualifier: (call.isConstructor && call.receiver) || null, receiverTyped: false };
    }
    if (language === 'rust' && call.isPathCall && call.receiver && !call.receiverType) {
        const segments = String(call.receiver).split('::').filter(Boolean);
        const last = segments[segments.length - 1];
        if (!last || !/^[A-Z]/.test(last) || last === 'Self') return null;
        return { name: last, qualifier: segments.length > 1 ? segments.slice(0, -1).join('::') : null,
            receiverTyped: false };
    }
    if (call.receiverIsTypeQualified && call.receiver && !call.receiverType &&
        (language === 'java' || language === 'csharp')) {
        return { name: call.receiver, qualifier: call.receiverTypeQualifier || null, receiverTyped: false };
    }
    if (call.receiverType && (call.receiverTypeSource === 'annotation' ||
        call.receiverTypeSource === 'constructor')) {
        // A C++ declaration's written namespace qualifies the declared type
        // itself, not a pointee (`std::unique_ptr<file> p; p->f()`).
        const namespace = call.receiverTypeNamespace &&
            call.receiverTypeEvidence?.type === call.receiverType ? call.receiverTypeNamespace : null;
        return { name: call.receiverType,
            qualifier: call.receiverTypeQualifier || namespace || null, receiverTyped: true,
            source: call.receiverTypeSource };
    }
    return null;
}

function ownerName(definition) {
    if (TYPE_KINDS.has(definition.type)) return definition.name;
    return definition.className || String(definition.receiver || '').replace(/^[*&]\s*/, '') || null;
}

/**
 * What a target definition's owner type denotes: 'project' (a project type
 * definition), 'external' (an impl/extension on the external type), or
 * 'unknown'.
 */
function ownerDenotation(index, definition, original) {
    const key = `\x01owner\x00${definition.file}:${definition.startLine}:${definition.name}:${original}`;
    return memoized(index, key, () => {
        if (TYPE_KINDS.has(definition.type)) return 'project';
        const owner = ownerName(definition);
        if (definition.implSelfQualifier) {
            return externalTypeDenotation(index, definition.file, owner, definition.implSelfQualifier, definition.startLine)
                ? 'external' : 'project';
        }
        // A project type that declares the external type as an ancestor
        // (`class File extends java.io.File`) receives its dispatch.
        const ownerDefs = (index.symbols.get(owner) || []).filter(candidate =>
            TYPE_KINDS.has(candidate.type));
        if (ownerDefs.some(candidate => (index._getInheritanceParents?.(owner, candidate.file) || [])
            .some(parent => String(parent).split(/::|\./).pop() === original))) return 'external';
        if (ownerDefs.some(candidate => candidate.file === definition.file)) return 'project';
        if (externalTypeDenotation(index, definition.file, owner, null, definition.startLine)) return 'external';
        return ownerDefs.length > 0 ? 'project' : 'unknown';
    });
}

function projectTypeNamed(index, name) {
    return (index.symbols.get(name) || []).some(definition => TYPE_KINDS.has(definition.type));
}

/**
 * Verdict for a call site against candidate target definitions (the pinned
 * targets on the caller side, every same-name callable on the callee side).
 * Returns null (the gate does not apply) or one of:
 *   { verdict: 'exclude', reason: 'external-receiver', via }
 *   { verdict: 'dispatch', via }   an impl on the external type may supply it
 *   { verdict: 'strip', via }      receiver typed by the external name: the
 *                                  engine resolves it without that type
 */
function externalTypeGate(index, filePath, fileEntry, call, targetsOrThunk) {
    if (!fileEntry || !targetsOrThunk) return null;
    // Go: a receiver typed by an external package's type may be an interface
    // every project type with the method set satisfies; the existing
    // package-qualified physics routes it (possible dispatch).
    if (fileEntry.language === 'go') return null;
    const written = siteWrittenType(index, fileEntry, call);
    if (!written) return null;
    const denotation = externalTypeDenotation(index, filePath, written.name, written.qualifier, call.line,
        { unscoped: written.unscoped === true });
    if (!denotation) return null;
    const { original, via } = denotation;
    // Only a real collision needs the gate: without a project type of that
    // name the engine's own resolution cannot conflate the two.
    if (!projectTypeNamed(index, original)) return null;
    const targets = typeof targetsOrThunk === 'function' ? targetsOrThunk() : targetsOrThunk;
    if (!targets || targets.length === 0) return null;
    const collision = [];
    const others = [];
    for (const target of targets) (ownerName(target) === original ? collision : others).push(target);
    // An unresolvable non-standard package: the name is not the project
    // type's, but a resolver gap cannot be ruled out - never confirmed,
    // never excluded.
    if (denotation.certain === false) return collision.length > 0 ? { verdict: 'unverified', via } : null;
    // A target the same-name PROJECT type reaches (its ancestor, a trait it
    // implements, a blanket impl) is where the engine could conflate the two
    // types; the external type may reach it too, so it stays visible.
    const related = written.receiverTyped
        ? others.filter(target => reachableThroughNamesake(index, target, original)) : [];
    if (collision.length === 0) return related.length > 0 ? { verdict: 'dispatch', via } : null;
    let external = 0;
    for (const target of collision) {
        const verdict = ownerDenotation(index, target, original);
        if (verdict === 'external') external++;
        else if (verdict !== 'project') return written.receiverTyped ? { verdict: 'strip', via } : null;
    }
    if (external > 0) return { verdict: 'dispatch', via };
    // Structural typing: an annotated external type admits any value of the
    // right shape, so only a constructed receiver is exact.
    if (written.receiverTyped && written.source !== 'constructor' &&
        langTraits(fileEntry.language)?.typeSystem === 'structural') return { verdict: 'dispatch', via };
    return related.length > 0
        ? { verdict: 'strip', via }
        : { verdict: 'exclude', reason: 'external-receiver', via };
}

/**
 * Verdict for a receiver whose declared type (a field, written in its own
 * file) denotes the external type `original`: 'exclude' when no target can
 * be reached by a value of that type, 'dispatch' when an impl on the
 * external type, a blanket impl, an extension method or a trait it may
 * implement could supply one, 'unknown' otherwise. Structural typing admits
 * any value of the right shape: always 'dispatch'.
 */
function externalReceiverVerdict(index, language, targets, original) {
    if (!targets || targets.length === 0) return 'unknown';
    if (langTraits(language)?.typeSystem !== 'nominal' || language === 'go') return 'dispatch';
    let dispatch = false;
    for (const target of targets) {
        const owner = ownerName(target);
        if (!owner) continue;
        if (owner === original) {
            const verdict = ownerDenotation(index, target, original);
            if (verdict === 'external') dispatch = true;
            else if (verdict !== 'project') return 'unknown';
            continue;
        }
        if (target.isExtensionMethod || reachableByExternal(index, target, original)) dispatch = true;
    }
    return dispatch ? 'dispatch' : 'exclude';
}

/**
 * Can a value of the external type `name` reach `target`? A blanket impl
 * member; a trait member that some impl for `name`, or a blanket impl,
 * provides; or a member of a project type that implements / extends the
 * external type itself (`class MyList implements java.util.List`, `impl
 * std::io::Write for MyWriter`) - the value may be such an instance.
 */
function reachableByExternal(index, target, name) {
    const owner = ownerName(target);
    if (target.ownerGenerics && genericParamNames(target.ownerGenerics).has(owner)) return true;
    if (target.traitName === name) return true;
    const key = `\x01extreach\x00${target.file}:${target.startLine}:${target.name}\x00${name}`;
    return memoized(index, key, () => {
        const sameName = index.symbols.get(target.name) || [];
        if (sameName.some(candidate => candidate.traitName === owner && (candidate.className === name ||
            (candidate.ownerGenerics && genericParamNames(candidate.ownerGenerics).has(candidate.className))))) {
            return true;
        }
        const seen = new Set([owner]);
        let level = (index.symbols.get(owner) || []).filter(d => TYPE_KINDS.has(d.type));
        for (let depth = 0; depth < 8 && level.length > 0; depth++) {
            const next = [];
            for (const definition of level) {
                for (const parent of index._getInheritanceParents?.(definition.name, definition.file) || []) {
                    const parentName = String(parent).replace(/<.*$/s, '').split(/::|\./).pop();
                    if (parentName === name) return true;
                    if (seen.has(parentName)) continue;
                    seen.add(parentName);
                    next.push(...(index.symbols.get(parentName) || []).filter(d => TYPE_KINDS.has(d.type)));
                }
            }
            level = next;
        }
        return false;
    });
}

function genericParamNames(text) {
    const inner = String(text || '').trim().replace(/^</, '').replace(/>$/, '');
    const names = new Set();
    let depth = 0;
    let start = 0;
    const parts = [];
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        else if (ch === '>' || ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    for (const part of parts) {
        const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (match && !part.trim().startsWith("'")) names.add(match[1]);
    }
    return names;
}

/**
 * Could a value of the project type named `name` reach `target` other than
 * as its owner: a blanket impl member (generic owner), a trait/interface the
 * type implements, or an ancestor class? Name-level, bounded.
 */
function reachableThroughNamesake(index, target, name) {
    const owner = ownerName(target);
    if (!owner) return false;
    const key = `\x01reach\x00${target.file}:${target.startLine}:${target.name}\x00${name}`;
    return memoized(index, key, () => {
        if (target.ownerGenerics && genericParamNames(target.ownerGenerics).has(owner)) return true;
        if ((index.symbols.get(target.name) || []).some(candidate =>
            candidate.className === name && candidate.traitName === owner)) return true;
        const seen = new Set([name]);
        let level = (index.symbols.get(name) || []).filter(d => TYPE_KINDS.has(d.type));
        for (let depth = 0; depth < 8 && level.length > 0; depth++) {
            const next = [];
            for (const definition of level) {
                for (const parent of index._getInheritanceParents?.(definition.name, definition.file) || []) {
                    const parentName = String(parent).replace(/<.*$/s, '').split(/::|\./).pop();
                    if (parentName === owner) return true;
                    if (seen.has(parentName)) continue;
                    seen.add(parentName);
                    next.push(...(index.symbols.get(parentName) || []).filter(d => TYPE_KINDS.has(d.type)));
                }
            }
            level = next;
        }
        return false;
    });
}

/**
 * A producer call whose written type (type-qualified path / static factory /
 * constructor) denotes an external type that shares its name with a project
 * type: the external evidence string, else null. The value it produces was
 * decided outside the project.
 */
function externalProducerVia(index, filePath, fileEntry, call) {
    if (!fileEntry) return null;
    const written = siteWrittenType(index, fileEntry, call);
    if (!written || written.receiverTyped) return null;
    const denotation = externalTypeDenotation(index, filePath, written.name, written.qualifier, call.line,
        { unscoped: written.unscoped === true });
    if (!denotation || denotation.certain === false || !projectTypeNamed(index, denotation.original)) return null;
    return `${denotation.via}${fileEntry.language === 'rust' || fileEntry.language === 'cpp' ? '::' : '.'}${call.name}`;
}

/** A copy of the call whose external-typed receiver no longer names a type. */
function stripExternalReceiverType(call, via) {
    const stripped = { ...call, receiverExternalFlow: via };
    delete stripped.receiverType;
    delete stripped.receiverTypeSource;
    delete stripped.receiverTypeEvidence;
    delete stripped.receiverTypeQualifier;
    return stripped;
}

module.exports = {
    externalTypeDenotation,
    externalReceiverVerdict,
    externalProducerVia,
    externalTypeGate,
    stripExternalReceiverType,
    siteWrittenType,
    bindingIsExternal,
    cargoDependencies,
    csharpGlobalUsings,
    csharpUsings,
    csharpResolveUsingName,
    csharpDeclaredNames,
    rustBindingsInScope,
    siteNamespaceOf,
    projectNamespaces,
};
