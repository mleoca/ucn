/**
 * core/cache.js - Index persistence (save/load/staleness detection)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
    expandGlob, detectProjectPattern, parseGitignore, gitTrackedPaths, DEFAULT_IGNORES,
    classifyUnsupportedSourceFile,
} = require('./discovery');
const { codeUnitCompare } = require('./shared');

// Read UCN version for cache invalidation
const UCN_VERSION = require('../package.json').version;

const CACHE_DIRECTORY_NAME = 'ucn';
const CACHE_PROJECTS_DIRECTORY = 'projects';
const LEGACY_CACHE_DIRECTORY = '.ucn-cache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_MAX_PROJECTS = 128;
const CACHE_MAX_BYTES = 1024 * 1024 * 1024;

function discoveryRulesHash(root) {
    return crypto.createHash('md5').update(parseGitignore(root).join('\0')).digest('hex');
}

/**
 * Resolve the per-user cache root without writing anything.
 *
 * UCN_CACHE_DIR is the explicit override. Otherwise follow the host cache
 * convention: XDG_CACHE_HOME on Unix, Library/Caches on macOS, and
 * LOCALAPPDATA on Windows. Every fallback remains below the user's home.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.homeDir]
 * @returns {string}
 */
function getUserCacheRoot({
    env = process.env,
    platform = process.platform,
    homeDir = os.homedir(),
} = {}) {
    const resolveConfiguredPath = (configured) => {
        const value = String(configured || '').trim();
        if (!value) return null;
        if (value === '~') return homeDir;
        if (value.startsWith('~/') || value.startsWith('~\\')) {
            return path.resolve(homeDir, value.slice(2));
        }
        return path.resolve(value);
    };

    const explicit = resolveConfiguredPath(env.UCN_CACHE_DIR);
    if (explicit) return explicit;

    const xdg = resolveConfiguredPath(env.XDG_CACHE_HOME);
    if (xdg) return path.join(xdg, CACHE_DIRECTORY_NAME);

    if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Caches', CACHE_DIRECTORY_NAME);
    }
    if (platform === 'win32') {
        const localAppData = resolveConfiguredPath(env.LOCALAPPDATA);
        return localAppData
            ? path.join(localAppData, CACHE_DIRECTORY_NAME, 'cache')
            : path.join(homeDir, 'AppData', 'Local', CACHE_DIRECTORY_NAME, 'cache');
    }
    return path.join(homeDir, '.cache', CACHE_DIRECTORY_NAME);
}

/**
 * Canonicalize a project root for cache identity. Symlinked paths to the same
 * checkout share one cache, while separate copies remain isolated.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function canonicalProjectRoot(projectRoot) {
    const resolved = path.resolve(projectRoot);
    try {
        const realpath = fs.realpathSync.native || fs.realpathSync;
        return realpath(resolved);
    } catch (_) {
        return resolved;
    }
}

/**
 * Return the default cache directory for one project.
 *
 * The readable basename aids manual inspection; the canonical-path hash
 * prevents collisions between unrelated projects with the same directory
 * name without exposing the full checkout path.
 *
 * @param {string} projectRoot
 * @param {object} [options] - Forwarded to getUserCacheRoot()
 * @returns {string}
 */
function getProjectCacheDir(projectRoot, options) {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    const slug = (path.basename(canonicalRoot) || 'project')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'project';
    const identity = process.platform === 'win32'
        ? canonicalRoot.toLowerCase()
        : canonicalRoot;
    const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
    return path.join(getUserCacheRoot(options), CACHE_PROJECTS_DIRECTORY, `${slug}-${hash}`);
}

/**
 * @param {string} projectRoot
 * @param {object} [options]
 * @returns {string}
 */
function getProjectCachePath(projectRoot, options) {
    return path.join(getProjectCacheDir(projectRoot, options), 'index.json');
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function getLegacyProjectCacheDir(projectRoot) {
    return path.join(path.resolve(projectRoot), LEGACY_CACHE_DIRECTORY);
}

/**
 * Move a legacy project-local cache to the per-user location. Migration is
 * best-effort because cache availability must never block an analysis query.
 * Symlinks are left untouched to avoid following or deleting user-managed
 * paths outside the project.
 *
 * @param {string} projectRoot
 * @param {string} [targetDir]
 * @returns {boolean} True when a legacy directory was removed or migrated.
 */
function migrateLegacyProjectCache(projectRoot, targetDir = getProjectCacheDir(projectRoot)) {
    const legacyDir = getLegacyProjectCacheDir(projectRoot);
    let legacyStat;
    try {
        legacyStat = fs.lstatSync(legacyDir);
    } catch (_) {
        return false;
    }
    if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) return false;

    try {
        if (fs.existsSync(targetDir)) {
            fs.rmSync(legacyDir, { recursive: true, force: true });
            return true;
        }

        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        try {
            fs.renameSync(legacyDir, targetDir);
            return true;
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
        }

        const tempDir = `${targetDir}.migrating-${process.pid}-${Date.now()}`;
        try {
            fs.cpSync(legacyDir, tempDir, { recursive: true, errorOnExist: true });
            fs.renameSync(tempDir, targetDir);
            fs.rmSync(legacyDir, { recursive: true, force: true });
            return true;
        } catch (_) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            return false;
        }
    } catch (_) {
        return false;
    }
}

/**
 * Remove both the current per-user cache and the obsolete project-local cache
 * for one project.
 *
 * @param {string} projectRoot
 * @returns {string[]} Removed directories.
 */
function clearProjectCache(projectRoot) {
    const removed = [];
    for (const cacheDir of [
        getProjectCacheDir(projectRoot),
        getLegacyProjectCacheDir(projectRoot),
    ]) {
        try {
            if (!fs.existsSync(cacheDir)) continue;
            fs.rmSync(cacheDir, { recursive: true, force: true });
            removed.push(cacheDir);
        } catch (_) {
            // Cache cleanup is best-effort; callers can rebuild regardless.
        }
    }
    return removed;
}

function directorySize(root) {
    let total = 0;
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch (_) { continue; }
        for (const entry of entries) {
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) pending.push(target);
            else {
                try { total += fs.statSync(target).size; } catch (_) { /* raced */ }
            }
        }
    }
    return total;
}

/** Bound the shared per-user cache by age, project count, and total bytes. */
function pruneUserCache({ force = false, now = Date.now() } = {}) {
    const cacheRoot = getUserCacheRoot();
    const projectsRoot = path.join(cacheRoot, CACHE_PROJECTS_DIRECTORY);
    const marker = path.join(cacheRoot, '.last-pruned');
    try {
        if (!force && fs.existsSync(marker) &&
            now - fs.statSync(marker).mtimeMs < CACHE_PRUNE_INTERVAL_MS) {
            return { removed: [], skipped: true };
        }
    } catch (_) { /* run maintenance */ }
    if (!fs.existsSync(projectsRoot)) return { removed: [], skipped: false };

    const removed = [];
    const entries = [];
    for (const dirent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
        const dir = path.join(projectsRoot, dirent.name);
        const indexFile = path.join(dir, 'index.json');
        let root = null;
        let touched = 0;
        try {
            const stat = fs.statSync(indexFile);
            touched = stat.mtimeMs;
            const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            root = data.root || null;
            touched = Math.max(touched, Number(data.timestamp) || 0);
        } catch (_) { /* malformed/incomplete cache expires below */ }
        if (!root || !fs.existsSync(root) || now - touched > CACHE_TTL_MS) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                removed.push(dir);
            } catch (_) { /* best effort */ }
            continue;
        }
        entries.push({ dir, touched, bytes: null });
    }

    entries.sort((a, b) => a.touched - b.touched || codeUnitCompare(a.dir, b.dir));
    while (entries.length > CACHE_MAX_PROJECTS) {
        const victim = entries.shift();
        try { fs.rmSync(victim.dir, { recursive: true, force: true }); removed.push(victim.dir); }
        catch (_) { /* best effort */ }
    }

    let totalBytes = 0;
    for (const entry of entries) {
        entry.bytes = directorySize(entry.dir);
        totalBytes += entry.bytes;
    }
    while (entries.length > 1 && totalBytes > CACHE_MAX_BYTES) {
        const victim = entries.shift();
        try {
            fs.rmSync(victim.dir, { recursive: true, force: true });
            removed.push(victim.dir);
            totalBytes -= victim.bytes;
        } catch (_) { /* best effort */ }
    }
    try {
        fs.mkdirSync(cacheRoot, { recursive: true });
        fs.writeFileSync(marker, String(now));
    } catch (_) { /* maintenance must never block analysis */ }
    return { removed, skipped: false, totalBytes, projects: entries.length };
}

function clearAllCaches() {
    const cacheRoot = getUserCacheRoot();
    try {
        if (!fs.existsSync(cacheRoot)) return [];
        fs.rmSync(cacheRoot, { recursive: true, force: true });
        return [cacheRoot];
    } catch (_) {
        return [];
    }
}

// Index/calls cache format version — bump when the persisted call-record or
// symbol shape changes (saveCache writes it; loadCache rejects anything else).
// v14: Go qualified composite literals (pkg.Foo{...}) record the package
// qualifier as `receiver` (fix #206).
// v15: Go/Rust/Java calls record assignedTo (+assignedTuple/assignedUnwrap)
// for nominal return-type flow; Java declared-type locals feed receiverType
// (fix #207).
// v16: Rust/Go type-alias symbols record aliasOf (fix #208 — alias-qualified
// receivers are the aliased type); Go `type A = B` aliases now indexed.
// v17: TS type-alias symbols record aliasOf (fix #208 TS parity — alias-
// annotated receivers validate against the aliased type).
// v18: Go callback references carry localShadow (fix #203 Go parity —
// func-literal params and block locals shadow bare-identifier references).
// v19: Rust trait-impl member symbols carry traitName (fix #210 — external-
// contract attribution: `impl Iterator for X` members name their contract).
// v20: persisted extends/extendedBy graphs split parent lists on TOP-LEVEL
// commas and strip type-argument suffixes (fix #214 — `extends Base<string,
// object>` produced parents ["Base<string", "object>"], so every generically
// extended class had no usable ancestor edges).
// v21: fileEntry.moduleAssignedNames (fix #217)
// v22 (fix #219): JS/TS member fieldType; receiverRoot/receiverField/
// receiverRootType + receiverCall/receiverCallIsMethod/receiverCallAwaited on
// JS/TS/Python calls; build-worker symbol-field parity (paramTypes, isAsync,
// isGenerator, aliasOf, traitName, *WithArgs were silently dropped from
// parallel-built indexes).
// v23 (fix #220): receiverCall/receiverCallIsMethod on Go/Rust/Java calls
// (+receiverCallReceiver for Go package-qualified producers); Go receiverType
// from `var x T` declarations and new(T) allocations; Rust literal-receiver
// types ("...".parse() → str).
// v24 (fix #221): boundCall on JS/TS bind/call/apply call records (family B
// contract field — edges surface as calledAs:'bound').
// v25 (fix #222): turbofish path receivers — `Vec::<T>::new()` records
// receiver 'Vec' in BOTH the macro token-tree branch (was receiver-less) and
// the AST branch (was 'Vec::<T>').
// v26 (fix #223): Go selector-call line attribution moves to the FIELD
// node's line (the #201/RUST-2 name-node convention — multi-line receivers
// like `(&pkg.Name{...}).String()` reported the chain-start line; Go was the
// only parser still keying calls off the call node's start).
// v27 (fix #224): Python from-import submodules — `from . import jobs` binds
// jobs.py as a plain NAME; graph-build resolves the composed submodule
// specifier ('.jobs') into fileEntry.moduleResolved and adds the import edge,
// so submodule receivers behave like `import jobs` module receivers
// (persisted moduleResolved/importGraph shapes gain entries).
// v28 (fix #227): canonical index order — everything persisted is written from
// a canonicalized state (_canonicalizeOrder: files/callsCache by path, defs
// arrays by (relativePath, startLine, type, className), calleeIndex sorted),
// so fresh-build, cache-load, and incremental-rebuild states are
// byte-equivalent and command output no longer depends on cache history.
// v29 (fix #229): Rust impl members and Java class methods carry method-level
// `generics` — generic-param receiver types (t.wipe() on TStore: Wipe) resolve
// against the enclosing declaration instead of excluding as type mismatches.
// v30 (fix #230): TS parameter-property modifiers (protected/readonly/...)
// and parameter decorators are no longer recorded as parameter DEFAULTS in
// paramsStructured.
// v31 (fix #231): Java try-with-resources declarations type receivers —
// `try (Res r = new Res())` records receiverType on r.use() like a plain
// declared-type local (#220(7) typing-sources family).
// v32 (fix #238): super(...)/this(...) constructor-delegation call records
// (JS/TS 'constructor' with receiver 'super'; Java under the target class
// name), Java enum-constant constructor invocations (RED(1)), and Go/Rust
// zero-param signatures record '' instead of the '...' unknown sentinel.
// v33 (fix #240): persisted importGraph/exportGraph/moduleResolved content
// changed — Java wildcard imports link EVERY file directly in the package
// (non-recursively; subpackage false links dropped), Rust flat-layout crates
// (no src/) resolve crate:: paths, and super::/crate:: item imports fall back
// to the parent module FILE (mod.rs / <dir>.rs / lib.rs / main.rs).
// v34 (fix #241): Java/Python zero-param signatures record '' instead of the
// '...' unknown sentinel (completes #238's Go/Rust fix), and Rust struct field
// member symbols carry their own visibility in `modifiers` (pub/pub(crate)/...)
// so export listings judge fields per-symbol.
// v35 (fix #245): persisted exports/exportDetails/imports content changed —
// the JS/TS export scanner records `export abstract class`, `export declare`
// wrappers, and `export namespace` (the namespace is the importable name),
// and TS import-equals (`import x = require('./y')`) produces an import
// record (the dependency edge was invisible to all filedeps commands).
// v36 (fix #246): persisted importGraph/moduleResolved content changed —
// Rust own-package-name imports (`use my_crate::helper` in tests/, benches/,
// examples/) resolve into the package's source tree via the Cargo [package]
// name, so integration-test dependency edges exist.
// v37 (fix #247): JS/TS class members carry `private`/`protected`
// accessibility keywords in `modifiers` (deadcode's exported-member check
// treated every TS member as implicitly public).
// v38 (fix #248): Go generic receivers normalize to the type name
// (`Pair[K, V]` → `Pair` in receiver/className); Rust trait members carry
// the trait's own visibility instead of the non-Rust 'public', and Rust
// impl methods record async/unsafe/const/extern qualifiers in modifiers.
// v39 (fix #249): JS/TS modifiers come from AST tokens, not first-line
// text — cached symbols may carry export/async/default fabricated from
// string literals and comments.
// v40 (fix #251): Java field members carry visibility modifiers, enum
// constants carry their implicit public/static/final, and Python type
// aliases (PEP 695 + TypeAlias annotations) are indexed as 'type' symbols.
// v41 (fix #252): CJS export object maps index their shorthand/pair
// function properties (module.exports = { doThing(x){} }) and list them in
// exports; member-expression assignments record RHS identifier function
// references (window.onload = handler).
// v44 (fix #262): JS/TS literal ASSIGNMENTS type the variable (const lines
// = [] → Array), and untyped reassignment deletes inferred types — call
// records carry receiverType on literal-assigned receivers.
// v45 (fix #265): Python typing @overload-decorated defs carry isSignature
// (TS overload parity — pin identity closes over the overload group, and
// pickBestDefinition prefers the implementation).
// v46 (fix #266): Go call records mark New*-prefix-derived receiver types
// as guesses (receiverTypeGuessed / receiverRootTypeGuessed) — convention,
// not compiler truth; the return-type flow map overrides them and
// exclusions never trust them. (fix #267) String-named TS module
// declarations (`declare module '../x'` augmentations) no longer index as
// namespace symbols — they declare no nameable identifier.
// v47 (fix #269): Python absolute imports resolve through the PEP-517 src
// layout (`import click` → src/click/__init__.py) — persisted
// importGraph/exportGraph/moduleResolved content changed.
// v48 (fix #270): Java interface symbols record their extends clause (the
// grammar's extends_interfaces child carries no `extends` field, so the
// field lookup silently returned nothing) — cached interface symbols lack
// the supertypes the deadcode heritage walk reads.
// v49: JS/TS module-scope object-literal dispatch members carry
// registryMember/registryContainer so reachability does not classify live
// HANDLERS[command](...) implementations as dead code.
// v50: persist the same registry fields from parallel workers; v49 worker-built
// caches silently dropped them and therefore cannot be trusted.
// v51: JS/TS call aliases are lexical/position-aware; old calls caches can
// contain resolvedName values leaked from an unrelated block or later line.
// v55: Rust `Self { ... }` struct expressions persist the concrete enclosing
// impl type as their constructor-call name.
// v56: Java call records preserve typed identifiers/static-factory argument
// kinds and capitalized static-field receiver roots for overload/dispatch
// identity.
// v57: Java capitalized type receivers are no longer also persisted as
// implicit-this fields.
// v58: Java enhanced-for variables persist their declared receiver type.
// v59: Java class-literal argument kinds and capitalized static-field
// receivers are persisted for inherited overload/field ownership.
// v60: argument/comment scans ignore every tree-sitter comment node kind
// (line_comment, block_comment, documentation_comment), not only `comment`.
// v61: file entries persist tree-sitter parse-recovery state so doctor never
// reports a recovered/possibly-partial file as a clean parse.
// v62: Go call records preserve receiverTypeQualifier,
// receiverRootTypeQualifier, and package-owned value receiver shape; symbols
// preserve function-valued variables and returned-function result signatures.
// These fields feed package identity and higher-order return flow.
// v63: Python constructor-derived receiver types preserve the imported module
// qualifier (`threading.Thread()` -> receiverTypeQualifier:'threading').
// This prevents external/unresolved type owners from entering the confirmed
// project-method tier through a bare class-name collision.
// v64: Rust calls whose receiver is rebound by an enclosing if-let/while-let
// pattern preserve receiverPatternShadow. Query-time return flow must not
// smear an outer binding's type onto that inner pattern binding.
// v65: Rust turbofish calls inside macro token trees are persisted as calls
// (`m.get_many::<T>()`); v64 caches misclassified them as references.
// v66: Rust call records preserve receiverFlowInvalidated after a non-call
// lexical rebinding, preventing stale return types from excluding true calls.
// v67: JS/TS constructor calls preserve lexical-shadow evidence, and method
// calls on fresh constructions preserve the exact constructed receiver type.
// Both fields affect caller identity and must not be read from older shards.
// v68: unaliased dotted Python imports persist separate package and submodule
// ownership edges (`import pkg.sub` binds pkg and loads pkg.sub).
// v69: CommonJS simple-require bindings preserve defaultLike so callable
// module.exports values resolve exactly across caller and callee queries.
// v70: Python receiver records preserve exact constructor provenance and
// context-manager result bindings for conservative dispatch tiering.
// v71: structural method records preserve untyped local-receiver ownership;
// single-owner spelling alone cannot confirm a parameter/assigned value.
// v72: Rust type symbols preserve the compiler-declared Deref Target so
// wrapper receiver method lookup reaches the target type without guessing.
// v73: JS/TS call records preserve qualified-constructor provenance and bound
// local receivers; conditional reassignments no longer persist a definite
// inferred constructor type past a branch.
// v74: JS/TS CommonJS object-spread barrels persist `module.exports = {
// ...require('./source') }` as source-bearing re-export-all records. Namespace
// calls can therefore establish exact name ownership through the facade.
// Java nested type symbols preserve their enclosing type for exact constructor
// ownership across same-named top-level and inner classes, and cast receivers
// retain their compiler-declared type. Rust tuple fields are indexed by numeric
// position so `self.0.method()` participates in declared-field resolution.
// v75: v5's shared IR path persists lexical-owner ranges and C/C++/C# symbol
// metadata; JS/TS call records preserve inline CommonJS module ownership,
// explicit builtin-member reassignment, and the richer C-family receiver/flow
// evidence used by caller resolution.
// v76: Java member symbols retain their nested enclosing type so overload and
// owner identity cannot conflate same-named inner classes.
// v77: Java call records retain explicit type-qualified receivers and nested
// type qualifiers for receiver-owner routing before overload selection.
// v78: Java argument kinds retain qualified producer ownership, same-class
// helper calls, and generic collection value types for exact overload routing.
// v79: Java chained-call records retain their full producer type path for
// platform collection/receiver ownership.
// v80: Rust chained-call records retain exact producer byte offsets so
// same-line nested constructors cannot collide in the fold.
// v81: Rust producer identities include the complete byte span, separating
// repeated same-name hops whose nested call expressions share a start offset.
// v82: Rust macro symbols persist conservative transcriber return contracts;
// macro invocations and token-tree calls retain complete producer spans and
// path ownership for exact builder-chain folding.
// v83: Rust callable symbols persist callback parameter type contracts and
// calls inside closures retain their enclosing call/argument identity.
// v84: Rust token-tree call records retain their containing macro identity so
// code-generation templates (`quote!`) can use their own trust policy.
// v85: Rust callable symbols persist declared iterator Item types for exact
// closure and loop receiver inference.
// v86: JS/TS package self-references can resolve a source entry when exported
// build artifacts are absent, changing persisted module ownership graphs.
// v87: JS/TS and Rust call records retain their lexical function-scope chain
// so return-flow assignments remain visible inside nested closures.
// v88: JS/TS callable symbols persist a unanimous concrete constructor return
// for runtime dispatch through interface-typed factory annotations.
// v89: JS/TS call records retain exact producer byte spans for same-line
// return-flow assignments and chained-call identity.
// v90: TypeScript object type aliases persist their declared field/method
// members so structural field-hop resolution can use their type contracts;
// explicit Type.prototype method bindings retain their type owner.
// v91: Python call records retain complete attribute receiver paths and their
// annotated root type for multi-hop declared-field resolution.
// v92: Python calls retain isinstance-refined receiver types.
// v93: Python calls retain receiver types derived from annotated iterable
// tuple destructuring in loops and comprehensions.
// v94: Python variadic parameter receivers retain their container type
// (**kwargs is dict, *args is tuple).
// v95: Python static generic aliases normalize to their runtime identity;
// calls retain receiver types from same-file callable iterable returns and
// collection-protocol conditional normalization.
// v96: Python explicit instance-field type comments type receivers yielded
// by loops and comprehensions over those fields.
// v97: Python receiver records preserve compiler-declared variable types
// through later assignments and unwrap parenthesized chained receivers.
// v98: Python calls retain declared attribute paths that supply loop and
// comprehension receiver values.
// v99: Python context-manager producer calls retain their `as` target so
// Iterator/ContextManager return contracts type the bound receiver.
// v100: builtin open() context bindings retain their IO receiver type.
// v101: Python generator yield assignments retain the declared send type.
// v102: Python subscript receivers retain exact value types from local
// string-keyed dictionary literals.
// v103: Python pickle round-trip receivers retain the serialized value's
// type plus the stdlib provenance needed to validate that contract.
// v104: Python self-referential assignment calls retain the receiver's
// pre-assignment type.
// v105: Python calls persist nested lexical ownership, returned-constructor
// contracts, and runtime instance-field assignments used by exact receiver
// flow.
// v106: Go calls persist package-scope typed receivers and exact wrapper-call
// ownership used by the nominal dispatch path.
// v107: Rust imports persist fully flattened grouped-use leaves; call records
// retain iterator/collection contracts, match-payload provenance, multi-hop
// field paths, tuple/match assignment producers, and primitive slice roots.
// v108: JavaScript/TypeScript call records retain unresolved deep-member
// receiver provenance so name bindings cannot impersonate receiver identity.
// v109: Python call records retain positive receiver-exact hasattr capability
// guards so uncertainty can name the runtime dispatch boundary.
// v110: Rust untyped closure parameters block same-named outer receiver
// annotations instead of persisting a stale, unrelated receiver type.
// v111: Java call IR preserves lexical nested-type owners and uses declared
// field types for overload argument shapes.
// v112: Java argument kinds retain class-qualified field identity so the
// field declaration's static value type participates in overload selection.
// v113: persist common unsupported source files so cached repo/health output
// cannot silently lose the grep handoff discovered during a full scan.
// v114: Rust impl owners normalize nested generics and reference impls to the
// same concrete identity used by receiver-flow analysis.
// v115: C# callable symbols persist extension-method identity and their
// receiver parameter marker; string/char literal receiver typing changes the
// call evidence consumed from cached indexes.
// v116: C# call records persist overload argument kinds and callable-scoped
// receiver types; enum members are indexed as typed fields for exact overload
// selection.
// v117: nullable GetValueOrDefault argument shapes retain their underlying
// value type for C# inherited-overload selection.
// v118: C# declarations nested under preprocessor nodes and recovered
// namespace-level method siblings remain attached to their lexical class.
// v125: C/C++ multiline typedef/class symbols persist the declaration
// identifier's nameLine so compiler-selected handles survive caching.
// v126: C/C++ parser recovery recognizes calling-convention/export macros
// between a builtin return type and a function name.
// v127: ambiguous .h files use the repository translation-unit convention
// when no compilation database or same-directory source sibling is present.
// v128: C++ using-alias symbols are indexed and template-qualified
// out-of-line methods close with their in-class declarations.
// v150: C/C++ call records persist source spans and chained-receiver producer
// links so the nominal return-type fold can resolve call().member() identity.
// v151: inheritance graphs normalize compiler-owned qualified nominal bases
// (for example `detail::buffer<T>`) to their indexed type identity.
// v152: C/C++ callable signatures persist anonymous C-style variadic tails.
// v153: C++ callable symbols persist explicit C-language linkage identity.
// v154: C/C++ calls parsed from preprocessor replacement lists persist their
// macro-body and macro-parameter provenance.
// v155: C# method symbols persist explicit-interface ownership so ordinary
// member overload resolution cannot select an interface-only implementation.
// v156: C# calls persist cast receiver types and multi-hop/null-forgiving
// declared-field paths used for compiler-grade member ownership.
// v157: C# cast receivers distinguish `((IFace)this).M()` from an arbitrary
// interface-typed variable so explicit implementations are never overclaimed.
// v159: importBindings persist source lines so rename plans can edit aliased
// CJS/Python imports without relying on usage-kind heuristics.
// v160: C# file entries persist project-wide `global using` modules.
// v166: C++ nested aliases persist their lexical owner ranges, and `auto`
// return functions persist a unanimously inferred local concrete type. v165
// was used during prerelease development before both fields were complete.
// v173: JS/TS fluent methods persist AST-proven `this` return identity, and
// nested const/arrow callables persist their enclosing lexical owner range.
// v172: immutable JS/TS class-member aliases materialize their local and
// exported callable identities, preserving declared return types through
// factory aliases and chained receivers.
// v171: import bindings persist their syntactic kind (named/default/namespace)
// so an exported ESM namespace object can carry exact member ownership through
// a downstream named or default import.
// v170: statically-owned CommonJS property assignments persist their local
// callable identity, allowing exact module ownership to exclude a different
// same-name export without treating all CJS surfaces as opaque.
// v169: CommonJS export details distinguish the value assigned directly to
// module.exports (`defaultLike`) from property exports; this prevents a
// namespace require from becoming a confirmed call to every exported member.
// v168: JS/TS one-hop member-assignment defs persist assignedReceiver — the
// object they patch (`console.log = fn` → 'console') — so the builtin-global
// exclusion can see cross-file that a project def rebinds the global's
// member (fix #286a); impl-kind symbols leave the bindings table (#286b).
const CACHE_FORMAT_VERSION = 175;

/**
 * Save index to cache file
 * @param {object} index - ProjectIndex instance
 * @param {string} [cachePath] - Optional custom cache path
 * @returns {string} - Path to cache file
 */
function saveCache(index, cachePath) {
    if (!cachePath) {
        migrateLegacyProjectCache(index.root);
    }
    const cacheDir = cachePath
        ? path.dirname(cachePath)
        : getProjectCacheDir(index.root);

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheFile = cachePath || path.join(cacheDir, 'index.json');

    // Prepare callsCache for serialization (exclude content, use relative paths)
    const callsCacheData = [];
    for (const [filePath, entry] of index.callsCache) {
        callsCacheData.push([path.relative(index.root, filePath), {
            mtime: entry.mtime,
            hash: entry.hash,
            calls: entry.calls
            // content is not persisted - will be read on demand
        }]);
    }

    // Hash config to detect when graph rebuild is needed on load
    const configHash = crypto.createHash('md5')
        .update(JSON.stringify(index.config || {})).digest('hex');
    const discoveryHash = discoveryRulesHash(index.root);

    // Strip redundant fields from symbols and file entries to reduce cache size.
    // v6: All paths stored as relative paths (saves ~60% on large codebases).
    // symbol.file = path.join(root, symbol.relativePath) — reconstructable
    // Default symbol.bindingId = relativePath:type:startLine — reconstructable.
    // Preserve non-default IDs: synthetic declarations can share a source line
    // and need their explicit identity to survive a cache round-trip.
    // fileEntry.path = Map key — redundant
    // fileEntry.relativePath = now the Map key — redundant
    const root = index.root;
    const strippedSymbols = [];
    for (const [name, defs] of index.symbols) {
        const stripped = defs.map(s => {
            const { file, bindingId, ...rest } = s;
            const defaultBindingId = s.relativePath && s.type && s.startLine
                ? `${s.relativePath}:${s.type}:${s.startLine}`
                : null;
            if (bindingId && bindingId !== defaultBindingId) {
                rest.bindingId = bindingId;
            }
            return rest;
        });
        strippedSymbols.push([name, stripped]);
    }
    // Files: use relativePath as key, strip path, relativePath, symbols, and bindings from entries.
    // symbols/bindings are already stored in the top-level symbols map — no need to duplicate.
    const strippedFiles = [];
    for (const [, entry] of index.files) {
        const { path: _p, relativePath: rp, symbols: _s, bindings: _b, ...rest } = entry;
        strippedFiles.push([rp, rest]);
    }

    // Convert graph paths from absolute to relative (Sets serialized as arrays)
    const relGraph = (graph) => {
        const result = [];
        for (const [absKey, absValues] of graph) {
            const relKey = path.relative(root, absKey);
            const relValues = [...absValues].map(v => path.relative(root, v));
            result.push([relKey, relValues]);
        }
        return result;
    };

    // calleeIndex is NOT persisted in index.json — it's rebuilt lazily from callsCache
    // on first findCallers/buildCalleeIndex call. Removing it saves ~22MB (14%) on large projects.

    // PERF-1: persist _reachableSymbols if computed. Set keys are
    // "absolutePath:line"; we strip the root prefix on save and re-attach on
    // load so paths stay portable. Sorted for stable output ordering.
    //
    // Also save a fingerprint so we can detect index drift on load: if the
    // saved fingerprint matches the loaded index state, the cached set is
    // still valid. If the index was rebuilt after load (stale cache → build),
    // the fingerprint won't match and computeReachability will recompute.
    let reachableSymbolsRel = undefined;
    let reachableFingerprint = undefined;
    if (index._reachableSymbols && index._reachableSymbols.size > 0) {
        const rels = [];
        for (const k of index._reachableSymbols) {
            const colon = k.lastIndexOf(':');
            if (colon < 0) continue;
            const absFile = k.slice(0, colon);
            const lineStr = k.slice(colon + 1);
            const relFile = path.relative(root, absFile);
            rels.push(`${relFile}:${lineStr}`);
        }
        rels.sort();  // stable ordering — output contract
        reachableSymbolsRel = rels;
        reachableFingerprint = _computeReachabilityFingerprint(index);
    }

    const cacheData = {
        // v10: persist _reachableSymbols set (computed by entrypoints.computeReachability)
        // v11: fix #202 — calls carry receiverRoot/receiverField/receiverRootType,
        //      Java classes emit field members with fieldType (stale shapes would
        //      silently disable declared-field receiver typing)
        // v12: fix #203 — callback references carry localShadow (lexical-scope
        //      shadowing computed parser-side)
        // v13: fix #205 — Python/Go/Rust/Java calls carry argCount (+argSpread
        //      where the language has call-site spread); Java calls carry
        //      argKinds for overload discipline (stale shapes would silently
        //      disable arity pruning)
        version: CACHE_FORMAT_VERSION,
        ucnVersion: UCN_VERSION,  // Invalidate cache when UCN is updated
        configHash,
        discoveryHash,
        root,
        // PERF-2: refresh buildTime on each save so partial rebuilds report
        // accurate stats. Falls back to original on first save.
        buildTime: index.buildTime,
        timestamp: Date.now(),
        files: strippedFiles,
        symbols: strippedSymbols,
        importGraph: relGraph(index.importGraph),
        exportGraph: relGraph(index.exportGraph),
        // extendsGraph/extendedByGraph use class names as keys (not file paths)
        extendsGraph: Array.from(index.extendsGraph.entries()),
        extendedByGraph: Array.from(index.extendedByGraph.entries()),
        failedFiles: index.failedFiles
            ? Array.from(index.failedFiles).map(f => path.relative(root, f))
            : [],
        unsupportedFiles: Array.isArray(index.unsupportedFiles)
            ? index.unsupportedFiles
            : [],
        discoveryIssues: Array.isArray(index.discoveryIssues)
            ? index.discoveryIssues
            : [],
        truncated: index.truncated || null,
        ...(reachableSymbolsRel !== undefined && {
            reachableSymbols: reachableSymbolsRel,
            reachableFingerprint,
        }),
        ...(index._computedDispatchBlindspots instanceof Map && {
            computedDispatchBlindspots: [...index._computedDispatchBlindspots]
                .map(([filePath, sites]) => [path.relative(root, filePath), sites]),
        }),
    };

    // PERF-3: atomic write — tmp file + rename so concurrent readers/writers
    // never see a torn JSON. The calls/ shard write below already does this.
    const tmpFile = cacheFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cacheData));
    fs.renameSync(tmpFile, cacheFile);

    // MED-1 (Round 5): clear the reachabilityDirty flag now that the set is
    // safely persisted. The cli/index.js cache-save guard checks this flag
    // along with needsCacheSave/callsCacheDirty.
    if (index.reachabilityDirty) {
        index.reachabilityDirty = false;
    }
    index.computedDispatchDirty = false;

    // Save callsCache sharded by directory for lazy loading.
    // Write to a temp directory first, then atomic swap to avoid data loss on crash.
    if (callsCacheData.length > 0) {
        const cacheDir = path.dirname(cacheFile);
        const callsDir = path.join(cacheDir, 'calls');
        const callsTmpDir = path.join(cacheDir, 'calls.tmp');

        // Clean up any leftover temp dir from a previous crashed save
        if (fs.existsSync(callsTmpDir)) {
            fs.rmSync(callsTmpDir, { recursive: true, force: true });
        }
        fs.mkdirSync(callsTmpDir, { recursive: true });

        // Group by directory
        const shards = new Map();
        for (const [relPath, entry] of callsCacheData) {
            const dir = path.dirname(relPath) || '.';
            if (!shards.has(dir)) shards.set(dir, []);
            shards.get(dir).push([relPath, entry]);
        }

        // Write all shards to temp directory
        const shardManifest = [];
        for (const [dir, entries] of shards) {
            const hash = crypto.createHash('md5').update(dir).digest('hex').slice(0, 10);
            const shardFile = path.join(callsTmpDir, `${hash}.json`);
            fs.writeFileSync(shardFile, JSON.stringify(entries));
            shardManifest.push([dir, hash, entries.length]);
        }

        // Write manifest to temp directory
        fs.writeFileSync(path.join(callsTmpDir, 'manifest.json'), JSON.stringify(shardManifest));

        // Atomic swap: remove old, rename temp to final
        if (fs.existsSync(callsDir)) {
            fs.rmSync(callsDir, { recursive: true, force: true });
        }
        fs.renameSync(callsTmpDir, callsDir);

        // Clean up legacy monolithic file
        const legacyFile = path.join(cacheDir, 'calls-cache.json');
        if (fs.existsSync(legacyFile)) {
            fs.rmSync(legacyFile, { force: true });
        }
    }

    if (!cachePath) pruneUserCache();
    return cacheFile;
}

/**
 * Load index from cache file
 * @param {object} index - ProjectIndex instance
 * @param {string} [cachePath] - Optional custom cache path
 * @returns {boolean} - True if loaded successfully
 */
function loadCache(index, cachePath) {
    if (!cachePath) {
        migrateLegacyProjectCache(index.root);
    }
    const cacheFile = cachePath || getProjectCachePath(index.root);

    if (!fs.existsSync(cacheFile)) {
        return false;
    }

    try {
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

        // Check version compatibility
        // v7: symbols/bindings stripped from file entries (dedup)
        // v9: addSymbol propagates isAsync/isGenerator/paramTypes (force rebuild for old)
        // v10: persists _reachableSymbols set
        if (cacheData.version !== CACHE_FORMAT_VERSION) {
            return false;
        }

        // Invalidate cache when UCN version changes (logic may have changed)
        if (cacheData.ucnVersion !== UCN_VERSION) {
            return false;
        }

        // Validate cache structure has required fields
        if (!Array.isArray(cacheData.files) ||
            !Array.isArray(cacheData.symbols) ||
            !Array.isArray(cacheData.importGraph) ||
            !Array.isArray(cacheData.exportGraph)) {
            return false;
        }

        // Rehydrate against the CURRENT root, never cacheData.root — the
        // cache stores relative paths precisely so a moved/copied project
        // keeps its cache. Using the recorded root re-attached every path to
        // the ORIGINAL directory: the staleness check then forced a rebuild
        // of files/symbols, but _reachableSymbols survived with old-root
        // keys (the fingerprint is path-blind), poisoning reachability notes
        // and --unreachable-only permanently (fix #249, G9-parity P1 —
        // repro: cp -r projA projB). The calls-shard loader already used
        // index.root.
        const root = index.root;
        // Fast path conversion: string concat is ~70x faster than path.join for
        // cache-stored relative paths (no '..' segments). On Windows, path.relative
        // produces backslash paths, so rootPrefix uses the native separator.
        const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
        const toAbs = path.sep === '/'
            ? (relPath) => rootPrefix + relPath
            : (relPath) => rootPrefix + relPath.replace(/\//g, path.sep);

        // Loading into a previously-used ProjectIndex replaces its indexed
        // contents, so no parsed tree from the old state may survive.
        index._clearParsedTreeCache?.();

        // Reconstruct files Map: relative key → absolute key, restore path and relativePath
        // Initialize symbols/bindings arrays (will be populated from top-level symbols)
        index.files = new Map();
        for (const [relPath, entry] of cacheData.files) {
            const absPath = toAbs(relPath);
            entry.path = absPath;
            entry.relativePath = relPath;
            if (!entry.symbols) entry.symbols = [];
            if (!entry.bindings) entry.bindings = [];
            index.files.set(absPath, entry);
        }

        // Reconstruct symbols: restore file and bindingId from relativePath
        // Also rebuild fileEntry.symbols and fileEntry.bindings from top-level data
        index.symbols = new Map(cacheData.symbols);
        for (const [, defs] of index.symbols) {
            for (const s of defs) {
                if (!s.file && s.relativePath) s.file = toAbs(s.relativePath);
                if (!s.bindingId && s.relativePath && s.type && s.startLine) {
                    s.bindingId = `${s.relativePath}:${s.type}:${s.startLine}`;
                }
                // Rebuild fileEntry.symbols and bindings from top-level symbols
                const fileEntry = index.files.get(s.file);
                if (fileEntry) {
                    fileEntry.symbols.push(s);
                    if (!s.memberAssigned && !s.bodyScopedName && !s.exportedAlias &&
                        s.type !== 'impl') {
                        fileEntry.bindings.push({
                            id: s.bindingId,
                            name: s.name,
                            type: s.type,
                            startLine: s.startLine
                        });
                    }
                }
            }
        }

        // Canonical order (see ProjectIndex._canonicalizeOrder): the loop above
        // rebuilds fileEntry.symbols/bindings in NAME-MAP order, which differs
        // from build's parse order — canonicalize so a loaded index is
        // byte-equivalent to a freshly built one before anything derives from it.
        index._canonicalizeOrder();

        // Reconstruct graphs: relative paths → absolute paths (as Sets)
        // Uses string concat (toAbs) instead of path.join — 70x faster on 464K edges
        const absGraph = (data) => {
            const m = new Map();
            for (const [relKey, relValues] of data) {
                const absValues = new Set();
                for (const v of relValues) absValues.add(toAbs(v));
                m.set(toAbs(relKey), absValues);
            }
            return m;
        };
        index.importGraph = absGraph(cacheData.importGraph);
        index.exportGraph = absGraph(cacheData.exportGraph);
        index.buildTime = cacheData.buildTime;

        // Restore optional graphs if present
        // extendsGraph/extendedByGraph use class names as keys (not file paths)
        if (Array.isArray(cacheData.extendsGraph)) {
            index.extendsGraph = new Map(cacheData.extendsGraph);
        }
        if (Array.isArray(cacheData.extendedByGraph)) {
            index.extendedByGraph = new Map(cacheData.extendedByGraph);
        }

        // Prepare lazy calls cache loading — load manifest but defer shard parsing.
        // Shards are loaded on first getCachedCalls access via ensureCallsCacheLoaded().
        if (index.callsCache.size === 0) {
            _prepareCallsCache(index, cacheFile);
        }

        // Build directory→files index from loaded data
        if (typeof index._buildDirIndex === 'function') {
            index._buildDirIndex();
        }

        // Restore failedFiles if present (convert relative paths back to absolute)
        if (Array.isArray(cacheData.failedFiles)) {
            index.failedFiles = new Set(
                cacheData.failedFiles.map(f => path.isAbsolute(f) ? f : toAbs(f))
            );
        }
        index.unsupportedFiles = Array.isArray(cacheData.unsupportedFiles)
            ? cacheData.unsupportedFiles
            : [];
        index.discoveryIssues = Array.isArray(cacheData.discoveryIssues)
            ? cacheData.discoveryIssues
            : [];
        index.truncated = cacheData.truncated || null;
        index._loadedConfigHash = cacheData.configHash || null;
        index._loadedDiscoveryHash = cacheData.discoveryHash || null;
        if (Array.isArray(cacheData.computedDispatchBlindspots)) {
            index._computedDispatchBlindspots = new Map(
                cacheData.computedDispatchBlindspots.map(([relPath, sites]) => [
                    path.isAbsolute(relPath) ? relPath : toAbs(relPath),
                    Array.isArray(sites) ? sites : [],
                ]),
            );
            index.computedDispatchDirty = false;
        }

        // Restore calleeIndex if persisted (v7 caches only; v8+ rebuilds lazily)
        if (Array.isArray(cacheData.calleeIndex)) {
            index.calleeIndex = new Map();
            for (const [name, files] of cacheData.calleeIndex) {
                if (!Array.isArray(files)) continue;
                index.calleeIndex.set(name, new Set(
                    files.map(f => path.isAbsolute(f) ? f : toAbs(f))
                ));
            }
        }

        // PERF-1: restore _reachableSymbols if persisted (v10+).
        // Saved as relative-path keys; rehydrate to absolute keys here so the
        // in-memory set matches what computeReachability would produce fresh.
        // The fingerprint is checked by computeReachability before reuse — if
        // the index drifts (e.g. a rebuild after stale cache), the cached set
        // is dropped and recomputed.
        if (Array.isArray(cacheData.reachableSymbols)) {
            const reachable = new Set();
            for (const k of cacheData.reachableSymbols) {
                if (typeof k !== 'string') continue;
                const colon = k.lastIndexOf(':');
                if (colon < 0) continue;
                const relFile = k.slice(0, colon);
                const lineStr = k.slice(colon + 1);
                const absFile = path.isAbsolute(relFile) ? relFile : toAbs(relFile);
                reachable.add(`${absFile}:${lineStr}`);
            }
            index._reachableSymbols = reachable;
            if (cacheData.reachableFingerprint) {
                index._reachableFingerprint = cacheData.reachableFingerprint;
            }
        }

        // Only rebuild graphs if config changed (e.g., aliases modified)
        const currentConfigHash = crypto.createHash('md5')
            .update(JSON.stringify(index.config || {})).digest('hex');
        if (currentConfigHash !== cacheData.configHash) {
            index.buildImportGraph();
            index.buildInheritanceGraph();
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Check if cache is stale (any files changed or new files added)
 * @param {object} index - ProjectIndex instance
 * @returns {boolean} - True if cache needs rebuilding
 */
function isCacheStale(index) {
    const currentConfigHash = crypto.createHash('md5')
        .update(JSON.stringify(index.config || {})).digest('hex');
    if (index._loadedConfigHash && currentConfigHash !== index._loadedConfigHash) {
        return true;
    }
    if (index._loadedDiscoveryHash &&
        discoveryRulesHash(index.root) !== index._loadedDiscoveryHash) {
        return true;
    }
    // Modified/deleted detection (stat sweep) runs UNCONDITIONALLY — agents
    // edit a file and re-query through MCP within seconds, and a stale answer
    // presented as fresh is the worst trust failure the tool can produce.
    // The 2s freshness window below shields only the expensive directory
    // walk (new-file detection): a brand-new file queried within 2s of the
    // last full check is a far rarer race than an edit, and the walk is the
    // part that costs real time on large repos.

    // Fast path: check cached files for modifications/deletions first (stat-only).
    // This returns early without the expensive directory walk when any file changed.
    for (const [filePath, fileEntry] of index.files) {
        try {
            const stat = fs.statSync(filePath);

            // If size changed, file changed
            if (fileEntry.size !== undefined && stat.size !== fileEntry.size) {
                return true;
            }

            // If mtime matches, file hasn't changed
            if (fileEntry.mtime && stat.mtimeMs === fileEntry.mtime) {
                continue;
            }

            // mtime changed or not stored - verify with hash
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('md5').update(content).digest('hex');
            if (hash !== fileEntry.hash) {
                return true;
            }
        } catch (e) {
            return true; // File deleted or inaccessible
        }
    }

    // Ultra-fast skip for the SLOW path only: last confirmed-fresh < 2s ago
    // (covers MCP burst calls). Uses _lastFreshAt (set at the end of a
    // successful full check), never the cache save timestamp.
    if (index._lastFreshAt && Date.now() - index._lastFreshAt < 2000) {
        return false;
    }

    // Slow path: glob the project to detect new files added since last build.
    // Only reached when all cached files are unchanged.
    const pattern = detectProjectPattern(index.root);
    const currentUnsupported = [];
    const globOpts = {
        root: index.root,
        onSkippedFile: (filePath) => {
            const kind = classifyUnsupportedSourceFile(filePath);
            if (!kind) return;
            currentUnsupported.push({
                relativePath: path.relative(index.root, filePath),
                ...kind,
            });
        },
    };
    const gitignorePatterns = parseGitignore(index.root);
    globOpts.gitignorePatterns = gitignorePatterns;
    globOpts.trackedPaths = gitTrackedPaths(index.root);
    const configExclude = index.config.exclude || [];
    if (configExclude.length > 0) {
        globOpts.ignores = [...DEFAULT_IGNORES, ...configExclude];
    }
    const currentFiles = expandGlob(pattern, globOpts);
    const cachedPaths = new Set(index.files.keys());
    const currentPaths = new Set(currentFiles);

    // A cached file can still exist on disk while becoming excluded by a new
    // .gitignore/.ucn.json rule. Treat that set contraction as stale too;
    // otherwise ignored code remains queryable until an unrelated edit forces
    // a rebuild.
    for (const file of cachedPaths) {
        if (!currentPaths.has(file)) return true;
    }

    for (const file of currentFiles) {
        if (!cachedPaths.has(file) && !(index.failedFiles && index.failedFiles.has(file))) {
            return true; // New file found
        }
    }
    const cachedUnsupported = (index.unsupportedFiles || [])
        .map(f => `${f.relativePath}\0${f.language}`)
        .sort();
    const discoveredUnsupported = currentUnsupported
        .map(f => `${f.relativePath}\0${f.language}`)
        .sort();
    if (cachedUnsupported.length !== discoveredUnsupported.length ||
        cachedUnsupported.some((value, i) => value !== discoveredUnsupported[i])) {
        return true;
    }

    // Record when we last confirmed the cache is fresh (enables 2s skip on burst calls)
    index._lastFreshAt = Date.now();
    return false;
}

/**
 * Prepare calls cache for lazy loading — reads manifest but defers shard parsing.
 * Called during loadCache() to set up the manifest without the ~1s shard parse cost.
 * Actual shards are loaded on first ensureCallsCacheLoaded() call.
 * @param {object} index - ProjectIndex instance
 */
function _prepareCallsCache(index, cacheFile) {
    if (index._callsCacheLoaded) return;
    // Shards live beside the selected index.json. A custom cachePath must be
    // a complete portable cache, not an index file that silently looks for
    // call shards under the default project cache. The latter caused cache-loaded
    // semantic queries to reparse source (or consume unrelated stale shards).
    const cacheDir = cacheFile
        ? path.dirname(cacheFile)
        : getProjectCacheDir(index.root);
    index._callsCacheDir = cacheDir;
    const manifestFile = path.join(cacheDir, 'calls', 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            index._callsManifest = new Map();
            for (const [dir, hash, count] of manifest) {
                index._callsManifest.set(dir, { hash, count, loaded: false });
            }
            index._callsCachePrepared = true;
            return;
        } catch (e) {
            // Corrupted manifest — fall through
        }
    }
    // Check legacy format
    const legacyFile = path.join(cacheDir, 'calls-cache.json');
    if (fs.existsSync(legacyFile)) {
        index._callsCacheLegacyFile = legacyFile;
        index._callsCachePrepared = true;
    }
}

/**
 * Load callsCache from separate file on demand.
 * Merges under existing entries (first writer wins) — anything already in
 * memory came from a fresh parse of current disk content, so persisted data
 * must never replace it (fix #227).
 * @param {object} index - ProjectIndex instance
 * @returns {boolean} - True if entries are available after the load
 */
function loadCallsCache(index) {
    if (index._callsCacheLoaded) return index.callsCache.size > 0;
    index._callsCacheLoaded = true;

    // If manifest was prepared lazily, load all shards now
    if (index._callsManifest) {
        for (const [, { hash }] of index._callsManifest) {
            _loadCallsShard(index, hash);
        }
        return index.callsCache.size > 0;
    }

    // Legacy format: single calls-cache.json
    const callsCacheFile = index._callsCacheLegacyFile ||
        path.join(index._callsCacheDir || getProjectCacheDir(index.root), 'calls-cache.json');
    if (!fs.existsSync(callsCacheFile)) return index.callsCache.size > 0;

    try {
        const data = JSON.parse(fs.readFileSync(callsCacheFile, 'utf-8'));
        if (Array.isArray(data)) {
            for (const [relPath, entry] of data) {
                if (!relPath || !entry) continue;
                const absPath = path.isAbsolute(relPath) ? relPath : path.join(index.root, relPath);
                if (!index.callsCache.has(absPath)) {
                    index.callsCache.set(absPath, entry);
                }
            }
            return index.callsCache.size > 0;
        }
    } catch (e) {
        // Corrupted file — ignore
    }
    return index.callsCache.size > 0;
}

/**
 * Ensure calls cache is fully loaded (trigger lazy load if prepared but not loaded).
 * Call this before any operation that needs callsCache (findCallers, buildCalleeIndex, etc.)
 * @param {object} index - ProjectIndex instance
 */
function ensureCallsCacheLoaded(index) {
    if (index._callsCachePrepared && !index._callsCacheLoaded) {
        loadCallsCache(index);
    }
}

/**
 * Load a single calls shard by hash.
 * @param {object} index - ProjectIndex instance
 * @param {string} hash - Shard hash from manifest
 */
function _loadCallsShard(index, hash) {
    const shardFile = path.join(
        index._callsCacheDir || getProjectCacheDir(index.root),
        'calls', `${hash}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(shardFile, 'utf-8'));
        if (!Array.isArray(data)) return;
        const rootPrefix = index.root.endsWith(path.sep) ? index.root : index.root + path.sep;
        const toAbsShard = path.sep === '/'
            ? (rp) => rootPrefix + rp
            : (rp) => rootPrefix + rp.replace(/\//g, path.sep);
        for (const [relPath, entry] of data) {
            if (!relPath || !entry) continue;
            const absPath = path.isAbsolute(relPath) ? relPath : toAbsShard(relPath);
            // First writer wins: an entry already in memory came from a fresh
            // parse of current disk content (or an earlier load) — never
            // clobber it with persisted shard data (fix #227).
            if (!index.callsCache.has(absPath)) {
                index.callsCache.set(absPath, entry);
            }
        }
    } catch (e) {
        // Corrupted shard — skip
    }
}

/**
 * Compute a cheap fingerprint of the index used to detect drift since the
 * last reachability computation. Two states with the same fingerprint are
 * indistinguishable for reachability purposes (file count + symbol count are
 * monotonic with structural changes; an extra `entries[0]` byte detects most
 * incremental rebuilds even when counts happen to match).
 *
 * Used by entrypoints.computeReachability to decide whether the persisted
 * `_reachableSymbols` set is still valid.
 *
 * @param {object} index - ProjectIndex instance
 * @returns {string} compact fingerprint
 */
function _computeReachabilityFingerprint(index) {
    const fileCount = index.files ? index.files.size : 0;
    const symbolCount = index.symbols ? index.symbols.size : 0;
    // Sample a tiny prefix of the symbol map for a cheap structural check.
    // Map iteration order is insertion order, which is stable across an
    // unmodified load (built from cacheData.symbols in the same order).
    let sample = '';
    if (index.symbols && index.symbols.size > 0) {
        let count = 0;
        for (const [name, defs] of index.symbols) {
            sample += name + ':' + (Array.isArray(defs) ? defs.length : 0) + '|';
            if (++count >= 8) break;
        }
    }
    return `${fileCount}:${symbolCount}:${sample}`;
}

module.exports = {
    saveCache, loadCache, loadCallsCache, isCacheStale, ensureCallsCacheLoaded,
    getUserCacheRoot, getProjectCacheDir, getProjectCachePath,
    getLegacyProjectCacheDir, migrateLegacyProjectCache, clearProjectCache,
    clearAllCaches, pruneUserCache,
    _computeReachabilityFingerprint, CACHE_FORMAT_VERSION,
};
