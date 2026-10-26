/**
 * core/rust-names.js - Rust name resolution by item scopes (fix #422).
 *
 * A Rust name resolves through the scopes that bind it, innermost first:
 * the blocks around the site (their items and `use` declarations, recorded
 * on call records as `scopeBinding` by the parser), then the module the
 * site belongs to. A module binds a name by an item it declares or an
 * explicit `use`, which shadow its glob imports; a module never sees its
 * parent's names except through a `use`. Types, values and macros are
 * separate namespaces: a `mod x` never hides a function `x`.
 *
 * `resolveRustName` answers with the project definitions a name denotes
 * (`{ defs }`; configuration alternatives give several), `{ external }` for a
 * name bound outside the project (a standard-library path, or a value no
 * project scope binds: the prelude), or null when the module tree cannot
 * decide (a module whose item macros or includes may declare names, an
 * unresolvable path, a file the module tree cannot place). Callers keep
 * their other evidence rules for null.
 */

'use strict';

const path = require('path');
const { moduleTree } = require('./rust-modules');
const { rustInlineChainAt, findCargoRoot, workspaceCrateRegistry } = require('./imports');

const FUNCTION_KINDS = new Set(['function', 'method', 'constructor', 'static']);
const TYPE_KINDS = new Set(['struct', 'enum', 'union', 'trait', 'type', 'module']);
const ITEM_KINDS = new Set(['function', 'state', 'struct', 'enum', 'union', 'trait', 'type', 'module']);

const UNKNOWN = Object.freeze({ unknown: true });
const ABSENT = Object.freeze({ absent: true });
const EXTERNAL = Object.freeze({ external: true });

function inNamespace(def, ns) {
    if (def.className || def.receiver) return false;
    if (ns === 'type') return TYPE_KINDS.has(def.type);
    if (def.type === 'function' || def.type === 'state') return true;
    return def.type === 'struct' && (def.valueShape === 'unit' || def.valueShape === 'tuple');
}

function stateOf(index) {
    const memo = index._rustScopeMemo || (index._rustScopeMemo = new Map());
    let state = memo.get('\x01rustNames');
    if (!state) {
        state = { lookups: new Map(), contents: new Map(), inProgress: new Set(), crates: new Map(),
            properRoots: new Map(), standard: null, answers: new Map() };
        memo.set('\x01rustNames', state);
    }
    return state;
}

function moduleObject(tree, root, segs) {
    const key = `${root}\0${segs.join('::')}`;
    const entries = tree.entries.get(key);
    return entries ? { root, segs, key, entries } : null;
}

/** The module a source position belongs to. */
function moduleAt(index, file, line) {
    const tree = moduleTree(index);
    const own = tree.moduleOf(file);
    return moduleObject(tree, own.root, [...own.segs, ...rustInlineChainAt(tree.inlineByFile.get(file) || [], line)]);
}

/**
 * Is `root` a crate root a Cargo target loads (lib.rs/main.rs, a bin, test,
 * example or bench file, build.rs, a manifest path)? A file the module tree
 * leaves unloaded for any other reason (a `mod` inside a macro, an include)
 * is not a crate: its names cannot be resolved.
 */
function isProperCrateRoot(index, root) {
    const state = stateOf(index);
    if (state.properRoots.has(root)) return state.properRoots.get(root);
    let proper = false;
    const cargo = findCargoRoot(path.dirname(root));
    if (cargo) {
        const rel = path.relative(cargo.root, root).split(path.sep);
        const src = path.relative(cargo.srcDir, root).split(path.sep);
        const base = rel[rel.length - 1];
        if (rel.length === 1 && (base === 'build.rs' || base === 'lib.rs' || base === 'main.rs')) proper = true;
        else if (src.length === 1 && (src[0] === 'lib.rs' || src[0] === 'main.rs')) proper = true;
        else if (src[0] === 'bin' && (src.length === 2 || (src.length === 3 && src[2] === 'main.rs'))) proper = true;
        else if (['tests', 'examples', 'benches'].includes(rel[0]) &&
            (rel.length === 2 || (rel.length === 3 && base === 'main.rs'))) proper = true;
        else if ((cargo.targetDirs || []).includes(path.dirname(root))) proper = true;
    }
    state.properRoots.set(root, proper);
    return proper;
}

// Crates every target links without a manifest entry.
const SYSROOT_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

/** The dependency entry a manifest gives `name`, workspace inheritance followed. */
function manifestDependency(cargo, name) {
    let dep = cargo?.dependencies?.[name];
    if (!dep?.workspace || dep.path) return dep || null;
    for (let dir = path.dirname(cargo.root), seen = 0; seen < 16; seen++) {
        const workspace = findCargoRoot(dir);
        if (!workspace) break;
        const inherited = workspace.dependencies?.[dep.package || name];
        if (inherited && !inherited.workspace) return { ...inherited, ...(dep.package && { package: dep.package }) };
        const up = path.dirname(workspace.root);
        if (up === workspace.root) break;
        dir = up;
    }
    return dep;
}

/**
 * What a crate name denotes from `fromFile` (fix #422): `{ module }` (the
 * library crate root of the own package, a path dependency or a workspace
 * member), `{ external }` (a registry dependency or a sysroot crate), or
 * null.
 */
function crateRef(index, tree, fromFile, name) {
    const state = stateOf(index);
    const key = `${path.dirname(fromFile)}\0${name}`;
    if (state.crates.has(key)) return state.crates.get(key);
    let result = null;
    const cargo = findCargoRoot(path.dirname(fromFile));
    let srcDir = null;
    if (cargo?.packageName === name) {
        srcDir = cargo.srcDir;
    } else {
        const dep = manifestDependency(cargo, name);
        if (dep?.path) {
            const target = findCargoRoot(dep.path);
            if (target && path.resolve(target.root) === path.resolve(dep.path)) srcDir = target.srcDir;
        } else if (dep && !dep.workspace) {
            result = EXTERNAL;
        } else if (SYSROOT_CRATES.has(name)) {
            result = EXTERNAL;
        } else if (!dep) {
            const member = workspaceCrateRegistry(index.root).get(name);
            if (member) srcDir = member.srcDir;
        }
    }
    if (srcDir) {
        const lib = path.join(srcDir, 'lib.rs');
        if (index.files.get(lib)?.language === 'rust' && tree.moduleOf(lib).root === lib) {
            result = { module: moduleObject(tree, lib, []) };
        }
    }
    state.crates.set(key, result);
    return result;
}

function sameChain(a, b) {
    return a.length === b.length && a.every((part, i) => part === b[i]);
}

/**
 * The scopes a module's own declarations give: explicit `use` bindings by
 * local name, glob imports, and whether an item macro or include may add
 * names the index does not hold.
 */
function moduleContent(index, tree, mod) {
    const state = stateOf(index);
    let content = state.contents.get(mod.key);
    if (content) return content;
    const uses = new Map();
    const globs = [];
    let opaque = false;
    // Words an item macro of the module is given: names its expansion may
    // declare (a declared name shadows the module's globs).
    const macroWords = new Set();
    for (const entry of mod.entries) {
        const fileEntry = index.files.get(entry.file);
        if (!fileEntry) { opaque = true; continue; }
        const inline = tree.inlineByFile.get(entry.file) || [];
        const inModule = line => sameChain(rustInlineChainAt(inline, line), entry.chain);
        // A parse error may hide items, unless it lies inside a function
        // body (`&raw const x` an older grammar cannot read).
        if ((fileEntry.parseErrorRegions || []).some(([start, end]) => !(fileEntry.symbols || []).some(symbol =>
            FUNCTION_KINDS.has(symbol.type) && symbol.startLine <= start && symbol.endLine >= end))) opaque = true;
        for (const detail of fileEntry.importDetails || []) {
            if (detail.lexicalScopeStartLine != null || detail.line == null) continue;
            if (detail.type !== 'use' && detail.type !== 'use-glob' && detail.type !== 'include') continue;
            if (!inModule(detail.line)) continue;
            if (detail.type === 'include') { opaque = true; continue; }
            const site = { path: detail.module, file: entry.file, line: detail.line,
                visibility: detail.visibility || null, isUse: true };
            if (detail.type === 'use-glob') { globs.push(site); continue; }
            for (const local of detail.names || []) {
                if (!uses.has(local)) uses.set(local, []);
                uses.get(local).push(site);
            }
        }
        for (const macro of fileEntry.itemMacros || []) {
            if (!inModule(macro.line)) continue;
            for (const word of macro.words || []) macroWords.add(word);
        }
    }
    content = { uses, globs, opaque, macroWords };
    state.contents.set(mod.key, content);
    return content;
}

/** Items named `name` declared directly in a module, in namespace `ns`. */
function moduleItems(index, tree, mod, name, ns) {
    const out = [];
    for (const def of index.symbols.get(name) || []) {
        if (!ITEM_KINDS.has(def.type) || !inNamespace(def, ns) || def.lexicalScopeStartLine != null) continue;
        const entry = mod.entries.find(candidate => candidate.file === def.file);
        if (!entry) continue;
        const inline = tree.inlineByFile.get(def.file) || [];
        let chain = rustInlineChainAt(inline, def.startLine);
        // An inline module's own lines lie inside it.
        if (def.type === 'module' && inline.some(mod2 => mod2.name === def.name && mod2.startLine === def.startLine)) {
            chain = chain.slice(0, -1);
        }
        if (!sameChain(chain, entry.chain)) continue;
        const fileEntry = index.files.get(def.file);
        if ((fileEntry?.symbols || []).some(symbol => symbol !== def && FUNCTION_KINDS.has(symbol.type) &&
            encloses(symbol, def))) continue;
        out.push(def);
    }
    return out;
}

/**
 * Does function `outer` enclose item `inner`? By source spans (byte offsets;
 * generated items carry ordered fractional offsets within their expansion),
 * else by lines.
 */
function encloses(outer, inner) {
    const a = outer.sourceSpan;
    const b = inner.sourceSpan;
    if (Number.isFinite(a?.start) && Number.isFinite(a?.end) && Number.isFinite(b?.start) && Number.isFinite(b?.end)) {
        return a.start <= b.start && a.end >= b.end && (a.start !== b.start || a.end !== b.end);
    }
    return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine &&
        !(outer.startLine === inner.startLine && outer.name === inner.name);
}

function childModuleOf(tree, mod, def) {
    return moduleObject(tree, mod.root, [...mod.segs, def.name]);
}

/** Can a glob in `site` (module position) import an item with `modifiers` declared at (file, line)? */
function visibleFrom(index, visibility, file, line, siteFile, siteLine) {
    const { rustItemAccessible } = require('./rust-modules');
    const mods = Array.isArray(visibility) ? visibility : visibility ? [visibility] : [];
    const normalized = mods.map(m => String(m).replace(/\s+/g, ''));
    if (normalized.some(m => m.startsWith('pub(in'))) return null;
    return rustItemAccessible(index, normalized, file, line, siteFile, siteLine);
}

function merge(results) {
    const defs = new Map();
    let external = false;
    let unknown = false;
    let cut = false;
    for (const result of results) {
        if (result.cut) cut = true;
        if (result.unknown) unknown = true;
        else if (result.external) external = true;
        for (const item of result.defs || []) {
            defs.set(`${item.def.file}\0${item.def.startLine}\0${item.def.type}\0${item.def.name}`, item);
        }
    }
    return { defs: [...defs.values()], external, unknown, cut };
}

function finish(state, key, result) {
    if (!result.cut) state.lookups.set(key, result);
    return result;
}

/**
 * What `name` denotes in namespace `ns` inside module `mod` (as a glob or a
 * path of another module reaches it). `site` is the importing position for
 * glob visibility, or null for a path (a compiling path names an item its
 * site may access).
 */
function lookupInModule(index, tree, mod, name, ns, site, depth) {
    const state = stateOf(index);
    if (!isProperCrateRoot(index, mod.root)) return UNKNOWN;
    const key = `${mod.key}\0${name}\0${ns}\0${site ? `${site.file}\0${site.line}` : ''}`;
    const memo = state.lookups.get(key);
    if (memo) return memo;
    if (state.inProgress.has(key)) return { absent: true, cut: true };
    if (depth > 16) return UNKNOWN;
    state.inProgress.add(key);
    try {
        const content = moduleContent(index, tree, mod);
        const explicit = [];
        for (const def of moduleItems(index, tree, mod, name, ns)) {
            if (site) {
                const visible = visibleFrom(index, def.modifiers, def.file, def.startLine, site.file, site.line);
                if (visible === null) { explicit.push(UNKNOWN); continue; }
                if (!visible) continue;
            }
            explicit.push({ defs: [{ def, module: mod }] });
        }
        for (const use of content.uses.get(name) || []) {
            if (site) {
                const visible = visibleFrom(index, use.visibility, use.file, use.line, site.file, site.line);
                if (visible === null) { explicit.push(UNKNOWN); continue; }
                if (!visible) continue;
            }
            explicit.push(resolveUsePath(index, tree, mod, use, ns, depth + 1));
        }
        const found = explicit.filter(result => !result.absent);
        const cutExplicit = explicit.some(result => result.cut);
        if (found.length > 0) {
            const merged = merge(found);
            merged.cut = merged.cut || cutExplicit;
            if (merged.unknown || (merged.external && merged.defs.length > 0)) {
                return finish(state, key, { unknown: true, cut: merged.cut });
            }
            if (merged.defs.length > 0) return finish(state, key, { defs: merged.defs, cut: merged.cut });
            return finish(state, key, { external: true, cut: merged.cut });
        }
        // Globs: an explicit name (an item a macro may still declare)
        // shadows them.
        const fromGlobs = [];
        const opaque = content.opaque || content.macroWords.has(name);
        let globUnknown = opaque;
        let globExternal = false;
        let cut = cutExplicit;
        for (const glob of content.globs) {
            // An outer glob reaches this module's glob imports only where
            // the `use` is visible to it.
            if (site) {
                const visible = visibleFrom(index, glob.visibility, glob.file, glob.line, site.file, site.line);
                if (visible === null) { globUnknown = true; continue; }
                if (!visible) continue;
            }
            const result = resolveGlob(index, tree, mod, glob, name, ns, depth + 1);
            if (result.cut) cut = true;
            if (result.defs?.length > 0) fromGlobs.push(result);
            else if (result.unknown) globUnknown = true;
            else if (result.external) globExternal = true;
        }
        if (fromGlobs.length > 0 && !opaque) {
            const merged = merge(fromGlobs);
            return finish(state, key, { defs: merged.defs, cut: cut || merged.cut });
        }
        if (globUnknown) return finish(state, key, { unknown: true, cut });
        if (globExternal) return finish(state, key, { external: true, cut });
        return finish(state, key, cut ? { absent: true, cut: true } : ABSENT);
    } finally {
        state.inProgress.delete(key);
    }
}

/** A glob import's contribution of `name`. */
function resolveGlob(index, tree, mod, glob, name, ns, depth) {
    const target = resolvePathPrefix(index, tree, mod, glob, String(glob.path || '').split('::'), depth);
    const cut = !!target.cut;
    if (target.unknown) return cut ? { unknown: true, cut } : UNKNOWN;
    if (target.external) return cut ? { external: true, cut } : EXTERNAL;
    const site = { file: glob.file, line: glob.line };
    if (target.module) {
        const result = lookupInModule(index, tree, target.module, name, ns, site, depth);
        return cut && !result.cut ? { ...result, cut } : result;
    }
    if (target.enumDef) {
        const variants = (index.symbols.get(name) || []).filter(def => def.type === 'variant' &&
            def.className === target.enumDef.name && def.file === target.enumDef.file);
        return variants.length > 0 ? { defs: variants.map(def => ({ def, module: null })), cut }
            : { absent: true, cut };
    }
    return { unknown: true, cut };
}

/**
 * Resolve the module (or type) a path prefix names from `mod`. Returns `{
 * module }`, `{ enumDef }`, `{ typeDefs }`, `{ external }` or `{ unknown }`,
 * with `cut` when a lookup on the way met a glob cycle.
 */
function resolvePathPrefix(index, tree, mod, use, segments, depth) {
    if (depth > 16 || segments.length === 0) return UNKNOWN;
    let i = 0;
    let current;
    let cut = false;
    const done = result => (cut ? { ...result, cut } : result);
    const first = segments[0];
    if (first === 'crate' || first === '$crate') {
        current = moduleObject(tree, mod.root, []);
        i = 1;
    } else if (first === 'self' || first === 'super') {
        let segs = mod.segs;
        if (first === 'self') i = 1;
        while (segments[i] === 'super') {
            if (segs.length === 0) return UNKNOWN;
            segs = segs.slice(0, -1);
            i++;
        }
        current = moduleObject(tree, mod.root, segs);
    } else if (first === '') {
        // `::name` is an extern crate.
        const crate = crateRef(index, tree, use.file, segments[1]);
        if (!crate) return UNKNOWN;
        if (crate.external) return EXTERNAL;
        current = crate.module;
        i = 2;
    } else {
        // A name in scope, else an extern crate (a name both would be is
        // an ambiguity error). In the 2015 edition a `use` path starts at
        // the crate root.
        const scope = use.isUse && findCargoRoot(path.dirname(use.file))?.edition === '2015'
            ? moduleObject(tree, mod.root, []) || mod : mod;
        const local = lookupInModule(index, tree, scope, first, 'type', null, depth + 1);
        if (local.cut) cut = true;
        if (local.defs?.length > 0) {
            const step = stepInto(tree, local.defs, segments.length === 1);
            if (!step) return done(UNKNOWN);
            if (!step.module) return done(segments.length === 1 ? step : UNKNOWN);
            current = step.module;
        } else {
            const crate = crateRef(index, tree, use.file, first);
            if (crate?.external) return done(EXTERNAL);
            if (!crate) return done(UNKNOWN);
            current = crate.module;
        }
        i = 1;
    }
    if (!current) return done(UNKNOWN);
    for (; i < segments.length; i++) {
        const result = lookupInModule(index, tree, current, segments[i], 'type', null, depth + 1);
        if (result.cut) cut = true;
        if (result.external) return done(EXTERNAL);
        if (!(result.defs?.length > 0)) return done(UNKNOWN);
        const step = stepInto(tree, result.defs, i === segments.length - 1);
        if (!step) return done(UNKNOWN);
        if (!step.module) return done(i === segments.length - 1 ? step : UNKNOWN);
        current = step.module;
    }
    return done({ module: current });
}

/** The next path segment's scope from the definitions it names. */
function stepInto(tree, items, last) {
    const modules = items.filter(item => item.def.type === 'module');
    if (modules.length === items.length) {
        const targets = modules.map(item => item.crate || (item.module && childModuleOf(tree, item.module, item.def)));
        if (targets.some(target => !target)) return null;
        const keys = new Set(targets.map(target => target.key));
        return keys.size === 1 ? { module: targets[0] } : null;
    }
    if (modules.length > 0 || !last) return null;
    const enums = items.filter(item => item.def.type === 'enum');
    if (enums.length === items.length && enums.length === 1) return { enumDef: enums[0].def };
    return { typeDefs: items.map(item => item.def) };
}

/** What a `use` path binds in `ns`, resolved from the module that declares it. */
function resolveUsePath(index, tree, mod, use, ns, depth) {
    const segments = String(use.path || '').split('::');
    if (segments.length === 0 || segments.slice(1).some(segment => segment === '')) return UNKNOWN;
    const last = segments[segments.length - 1];
    if (segments.length === 1 || (segments.length === 2 && segments[0] === '')) {
        // `use name;` binds a crate (type namespace) or an item in scope.
        if (ns === 'type') {
            const crate = crateRef(index, tree, use.file, last);
            if (crate?.external) return EXTERNAL;
            if (crate?.module) return { defs: [{ def: { type: 'module', name: last, file: crate.module.root, startLine: 0 },
                module: null, crate: crate.module }] };
        }
        return UNKNOWN;
    }
    const target = resolvePathPrefix(index, tree, mod, use, segments.slice(0, -1), depth);
    const cut = !!target.cut;
    if (target.unknown) return cut ? { unknown: true, cut } : UNKNOWN;
    if (target.external) return cut ? { external: true, cut } : EXTERNAL;
    if (target.module) {
        const result = lookupInModule(index, tree, target.module, last, ns, null, depth);
        return cut && !result.cut ? { ...result, cut } : result;
    }
    if (target.enumDef) {
        const variants = (index.symbols.get(last) || []).filter(def => def.type === 'variant' &&
            def.className === target.enumDef.name && def.file === target.enumDef.file);
        return variants.length > 0 ? { defs: variants.map(def => ({ def, module: null })), cut }
            : { unknown: true, cut };
    }
    return { unknown: true, cut };
}

function publicResult(result) {
    if (!result || result.unknown) return null;
    if (result.defs?.length > 0) return { defs: result.defs.map(item => item.def) };
    if (result.external || result.absent) return { external: true, ...(result.absent && { unbound: true }) };
    return null;
}

/**
 * What a bare name written at (file, line) denotes in namespace `ns`
 * ('value' or 'type'). `scopeBinding` is the parser's record of the
 * enclosing blocks' binding of the name (fix #422), if any.
 * @returns {{ defs: object[] } | { external: true, unbound?: true } | null}
 */
function resolveRustName(index, file, line, name, ns, scopeBinding = null) {
    return answer(index, `n\0${file}\0${line}\0${name}\0${ns}\0${bindingKey(scopeBinding)}`,
        () => resolveRustNameUncached(index, file, line, name, ns, scopeBinding));
}

/**
 * One answer per question for the index's lifetime: a public answer is
 * complete (no lookup of it is in progress when it starts), and every
 * engine query asks the same names at the same sites again.
 */
function answer(index, key, compute) {
    const answers = stateOf(index).answers;
    if (answers.has(key)) return answers.get(key);
    const result = compute();
    answers.set(key, result);
    return result;
}

function bindingKey(binding) {
    if (!binding) return '';
    return `${binding.kind}\x02${binding.path || ''}\x02${binding.line ?? ''}\x02` +
        `${(binding.innerGlobs || []).join(',')}\x02${(binding.paths || []).join(',')}`;
}

function resolveRustNameUncached(index, file, line, name, ns, scopeBinding) {
    const entry = index.files.get(file);
    if (entry?.language !== 'rust' || !name) return null;
    const tree = moduleTree(index);
    const mod = moduleAt(index, file, line);
    if (!mod || !isProperCrateRoot(index, mod.root)) return null;
    if (scopeBinding) {
        if (scopeBinding.innerGlobs) return null;
        if (scopeBinding.kind === 'use') {
            const use = { path: scopeBinding.path, file, line: scopeBinding.line, isUse: true };
            const result = resolveUsePath(index, tree, mod, use, ns, 0);
            if (result.absent) return null;
            return publicResult(result);
        }
        if (scopeBinding.kind === 'item') {
            const defs = (index.symbols.get(name) || []).filter(def => def.file === file &&
                def.startLine === scopeBinding.line && inNamespace(def, ns));
            return defs.length > 0 ? { defs } : null;
        }
        if (scopeBinding.kind === 'globs') {
            const results = scopeBinding.paths.map(globPath =>
                resolveGlob(index, tree, mod, { path: globPath, file, line, isUse: true }, name, ns, 0));
            const found = results.filter(result => result.defs?.length > 0);
            if (found.length > 0) return publicResult(merge(found));
            if (results.some(result => result.unknown)) return null;
        }
    }
    const result = lookupInModule(index, tree, mod, name, ns, null, 0);
    if (result.absent) {
        // No scope binds it: a value or a prelude type/trait is the
        // prelude's; any other type name is unbound here.
        const prelude = ns === 'value' ||
            !!require('../languages').langTraits(entry.language)?.implicitPreludeNames?.has(name);
        return prelude ? { external: true, unbound: true } : null;
    }
    return publicResult(result);
}

/**
 * What the qualifier of a path written at (file, line) names in the type
 * namespace: `{ defs }` (a trait, type or module), `{ external: true }`, or
 * null. `receiverScopeBinding` is the parser's block binding of its first
 * segment.
 */
function resolveRustPathQualifier(index, file, line, qualifier, receiverScopeBinding = null) {
    return answer(index, `q\0${file}\0${line}\0${qualifier}\0${bindingKey(receiverScopeBinding)}`,
        () => resolveRustPathQualifierUncached(index, file, line, qualifier, receiverScopeBinding));
}

function resolveRustPathQualifierUncached(index, file, line, qualifier, receiverScopeBinding) {
    const entry = index.files.get(file);
    if (entry?.language !== 'rust' || !qualifier) return null;
    const segments = String(qualifier).split('::');
    if (segments.some(segment => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && segment !== '$crate')) return null;
    const tree = moduleTree(index);
    const mod = moduleAt(index, file, line);
    if (!mod || !isProperCrateRoot(index, mod.root)) return null;
    if (segments.length === 1) {
        if (['Self', 'self', 'super', 'crate'].includes(segments[0])) return null;
        return resolveRustName(index, file, line, segments[0], 'type', receiverScopeBinding);
    }
    if (receiverScopeBinding) return null;
    const use = { path: qualifier, file, line };
    const result = resolveUsePath(index, tree, mod, use, 'type', 0);
    if (result.absent) return null;
    return publicResult(result);
}

/**
 * What a module-level `use` path written in `file` at `line` binds in `ns`
 * (fix #422): `{ defs }`, `{ external: true }`, or null.
 */
function resolveRustUsePath(index, file, line, usePath, ns) {
    return answer(index, `u\0${file}\0${line}\0${usePath}\0${ns}`,
        () => resolveRustUsePathUncached(index, file, line, usePath, ns));
}

function resolveRustUsePathUncached(index, file, line, usePath, ns) {
    if (index.files.get(file)?.language !== 'rust' || !usePath) return null;
    const tree = moduleTree(index);
    const mod = moduleAt(index, file, line);
    if (!mod || !isProperCrateRoot(index, mod.root)) return null;
    const result = resolveUsePath(index, tree, mod, { path: usePath, file, line, isUse: true }, ns, 0);
    if (result.absent) return null;
    return publicResult(result);
}

module.exports = { resolveRustName, resolveRustPathQualifier, resolveRustUsePath };
