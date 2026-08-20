/**
 * core/callers.js - Call graph resolution (callers, callees, callbacks)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectLanguage, getParser, getLanguageAdapter, langTraits } = require('../languages');
const { isTestFile } = require('./discovery');
const { NON_CALLABLE_TYPES, isOverrideMarked, codeUnitCompare, isTestPath } = require('./shared');
const { scoreEdge, tierForResolution, TIER } = require('./confidence');
const { findGoModule, resolveRustImport } = require('./imports');

const CONSTRUCTABLE_BINDING_KINDS = new Set([
    'class', 'struct', 'record', 'enum', 'function',
]);
const RESERVED_RECEIVER_NAMES = new Set([
    'self', 'cls', 'this', 'super', 'base', 'Self',
]);

/** Set.some() helper — like Array.some() but for Sets */
function setSome(set, predicate) {
    for (const item of set) {
        if (predicate(item)) return true;
    }
    return false;
}

/**
 * Extract a single line from content without splitting the entire string.
 * @param {string} content - Full file content
 * @param {number} lineNum - 1-indexed line number
 * @returns {string} The line content
 */
function getLine(content, lineNum) {
    let start = 0;
    for (let i = 1; i < lineNum; i++) {
        start = content.indexOf('\n', start) + 1;
        if (start === 0) return ''; // past end
    }
    const end = content.indexOf('\n', start);
    return end === -1 ? content.slice(start) : content.slice(start, end);
}

/**
 * Get cached call sites for a file, with mtime/hash validation
 * Uses mtime for fast cache validation, falls back to hash if mtime matches but content changed
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - Path to the file
 * @param {object} [options] - Options
 * @param {boolean} [options.includeContent] - Also return file content (avoids double read)
 * @returns {Array|null|{calls: Array, content: string}} Array of calls, or object with content if requested
 */
function getCachedCalls(index, filePath, options = {}) {
    try {
        // Trigger lazy calls cache load if prepared but not yet loaded
        if (index._callsCachePrepared && !index._callsCacheLoaded) {
            const { ensureCallsCacheLoaded } = require('./cache');
            ensureCallsCacheLoaded(index);
        }
        const cached = index.callsCache.get(filePath);

        // Fast path: check mtime first (stat is much faster than read+hash)
        const stat = fs.statSync(filePath);
        const mtime = stat.mtimeMs;

        if (cached && cached.mtime === mtime) {
            // mtime matches - cache is likely valid
            if (options.includeContent) {
                // Need content, read if not cached
                const content = cached.content || index._readFile(filePath);
                return { calls: cached.calls, content };
            }
            return cached.calls;
        }

        // mtime changed or no cache - need to read and possibly reparse
        const content = index._readFile(filePath);
        const hash = crypto.createHash('md5').update(content).digest('hex');

        // Check if content actually changed (mtime can change without content change)
        if (cached && cached.hash === hash) {
            // Content unchanged, just update mtime
            cached.mtime = mtime;
            cached.content = options.includeContent ? content : undefined;
            index.callsCacheDirty = true;
            if (options.includeContent) {
                return { calls: cached.calls, content };
            }
            return cached.calls;
        }

        // Content changed - need to reparse
        const language = detectLanguage(filePath);
        if (!language) return null;

        const langModule = getLanguageAdapter(language);
        if (!langModule.findCallsInCode) return null;

        const parser = getParser(language);
        // Pass import alias names to Go parser for package vs method call disambiguation
        // importNames contains resolved alias names (e.g., 'utilversion' for renamed imports)
        const callOpts = {};
        if (langTraits(language)?.hasReceiverPackageCalls) {
            const fileEntry = index.files.get(filePath);
            if (fileEntry?.importNames) {
                callOpts.imports = fileEntry.importNames;
            }
        }
        const calls = langModule.findCallsInCode(content, parser, callOpts);

        // Remove old callee index entries before overwriting cache
        if (cached) index._removeFromCalleeIndex(filePath, cached.calls);
        index.callsCache.set(filePath, {
            mtime,
            hash,
            calls,
            content: options.includeContent ? content : undefined
        });
        index.callsCacheDirty = true;
        // Incrementally update callee index with new calls
        index._addToCalleeIndex(filePath, calls);

        if (options.includeContent) {
            return { calls, content };
        }
        return calls;
    } catch (e) {
        // A missing/unreadable file, corrupt lazy cache, or parser exception
        // is not equivalent to "this file has no calls". Returning null here
        // let every consumer quietly continue with a plausible partial graph.
        // Unsupported languages still return null through the explicit paths
        // above; operational/engine failures abort with file context.
        const rel = path.relative(index.root, filePath);
        e.message = `getCachedCalls failed for ${rel}: ${e.message}`;
        throw e;
    }
}

function _javaPackageKey(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    const marker = '/java/';
    const at = normalized.lastIndexOf(marker);
    const packagePath = at >= 0 ? normalized.slice(at + marker.length) : normalized;
    return path.posix.dirname(packagePath);
}

/**
 * Resolve a capitalized Java receiver NAME through the file's static imports
 * to a static FIELD's declared type (fix #286c, jsoup-measured: `import
 * static ...SimpleBufferedInput.BufferPool` binds `BufferPool.borrow()` to
 * the SoftPool-typed field — javac resolves single-static-imports ahead of
 * the capitalized static-call reading). Returns the declared type HEAD, or
 * null when the name isn't a static-imported field (a static import naming a
 * nested TYPE keeps type-qualified semantics), the field has no usable
 * declared type, or the type head is package-qualified (unpinnable here —
 * the #268(4a) qualified-field discipline).
 */
function _javaStaticImportedFieldType(index, fileEntry, receiverName) {
    if (!receiverName || !fileEntry) return null;
    // Single-static-imports only: the import record cannot distinguish a
    // STATIC wildcard (`import static Owner.*` — imports fields) from a
    // package wildcard (`import com.ex.*` — types only), and typing a
    // receiver from a field javac never binds could exclude a true edge.
    const candidates = [];
    for (const im of (fileEntry.importBindings || [])) {
        const mod = String(im.module || '');
        if (im.name === receiverName && mod.endsWith('.' + receiverName)) {
            const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[mod];
            if (rel) candidates.push(rel);
            break;
        }
    }
    for (const rel of candidates) {
        const entry = index.files.get(path.join(index.root, rel));
        if (!entry) continue;
        // The import binding shape also matches plain class imports
        // (`import com.ex.BufferPool`): any resolved TYPE of the name —
        // top-level or nested — keeps static-call semantics.
        const namedType = (entry.symbols || []).some(s =>
            s.name === receiverName &&
            ['class', 'interface', 'enum', 'record', 'annotation'].includes(s.type));
        if (namedType) return null;
        const field = (entry.symbols || []).find(s =>
            s.name === receiverName && s.className &&
            (s.type === 'field' || s.memberType === 'field') &&
            (s.modifiers || []).includes('static'));
        if (!field) continue;
        const head = String(field.fieldType || '').replace(/<[\s\S]*$/, '').trim();
        if (!head || head.includes('.') || head.endsWith('[]')) return null;
        return head;
    }
    return null;
}

function _javaConstructorDisposition(index, filePath, fileEntry, call, targetDefs) {
    const typeKinds = new Set(['class', 'record', 'enum']);
    const targets = (targetDefs || []).filter(d => typeKinds.has(d.type));
    if (targets.length === 0) return 'target';
    const all = (index.symbols.get(call.name) || []).filter(d => typeKinds.has(d.type));
    const targetKeys = new Set(targets.map(d => `${d.file}:${d.startLine}`));
    const isTarget = d => targetKeys.has(`${d.file}:${d.startLine}`);

    if (call.receiver) {
        const owned = all.filter(d => d.enclosingType === call.receiver);
        if (owned.some(isTarget)) return 'target';
        if (owned.length > 0) return 'other';
        // Lowercase qualifiers are package fragments; the Java parser retains
        // only the terminal qualifier, so identity is not provable here.
        return 'unknown';
    }

    const bindings = (fileEntry.importBindings || []).filter(b =>
        b.name === call.name || b.alias === call.name);
    if (bindings.length > 0) {
        const resolvedFiles = bindings.map(b => fileEntry.moduleResolved?.[b.module])
            .filter(Boolean).map(rel => path.join(index.root, rel));
        if (resolvedFiles.some(fp => targets.some(d => d.file === fp))) return 'target';
        if (resolvedFiles.length > 0) return 'other';
        return 'unknown';
    }

    const caller = index.findEnclosingFunction(filePath, call.line, true);
    if (targets.some(d => d.file === filePath &&
        (!d.enclosingType || d.enclosingType === caller?.className))) return 'target';

    const callerPackage = _javaPackageKey(fileEntry.relativePath);
    const samePackage = all.filter(d => !d.enclosingType &&
        _javaPackageKey(d.relativePath) === callerPackage);
    if (samePackage.some(isTarget)) return 'target';
    if (samePackage.length > 0) return 'other';

    if (all.length > 0 && all.every(isTarget)) return 'target';
    return 'unknown';
}

/**
 * Find all call sites that invoke the named symbol.
 *
 * ReceiverType filtering (nominal vs structural):
 * - Nominal languages (Go/Java/Rust): uses call.receiverType (from parser-inferred
 *   method receivers, constructors, composite literals) to filter false positives.
 * - Structural languages (JS/TS/Python): checks receiver binding evidence from imports
 *   instead of receiverType, since structural typing makes receiver types ambiguous.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name to find callers for
 * @param {object} [options] - Options
 * @param {boolean} [options.includeMethods] - Include method calls (default: false)
 */
function findCallers(index, name, options = {}) {
    index._beginOp();
    try {
    const queryProfile = options.profile && typeof options.profile === 'object'
        ? options.profile : null;
    const profileStarted = queryProfile ? process.hrtime.bigint() : null;
    const elapsedProfileMs = started => Number(
        (Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
    const cacheLoadStarted = queryProfile ? process.hrtime.bigint() : null;
    // Lazy-load callsCache from disk if not already populated
    if (index.loadCallsCache) index.loadCallsCache();
    if (queryProfile) queryProfile.cacheLoadMs = elapsedProfileMs(cacheLoadStarted);
    const candidateScanStarted = queryProfile ? process.hrtime.bigint() : null;

    const callers = [];
    const stats = options.stats;

    // Conservation accounting (tiered caller contract): when collectAccount
    // is set (context/about/impact only — trace/blast/verify paths must stay
    // byte-identical), candidates that the legacy flags would silently drop are
    // RETAINED as unverified-tier entries (rendered in their own output
    // section), and candidates positively excluded (call targets a different
    // symbol) are recorded with a reason for the account arithmetic.
    const collectAccount = !!options.collectAccount;
    const accountRaw = collectAccount ? { unverifiedLines: [], excludedEntries: [] } : null;
    // Cap on how many unverified entries get full enrichment (content + caller
    // lookup); the rest stay as shadow-style records. Display caps are handled
    // by formatters — this only bounds file reads.
    const unverifiedEnrichLimit = options.unverifiedEnrichLimit ?? 10;
    const recordExcluded = (filePath, line, reason) => {
        if (accountRaw) accountRaw.excludedEntries.push({ file: filePath, line, reason });
    };

    const definitions = index.symbols.get(name) || [];

    // Callable identity closure: overload signatures + implementation are one
    // function; a TS class declaration paired with an ES5 constructor body
    // (`function X(this: X, ...)`) is likewise one constructable runtime slot.
    // Pinning any member must accept bindings to the compiler-equivalent one.
    if (options.targetDefinitions && options.targetDefinitions.length > 0 &&
        definitions.length > options.targetDefinitions.length) {
        const closed = _closeCallableIdentityGroup(
            index, options.targetDefinitions, definitions);
        if (closed !== options.targetDefinitions) {
            options = { ...options, targetDefinitions: closed };
        }
    }
    // C# partial type declarations are one compiler type across files.
    // Pinning the declaration in JValue.Async.cs must therefore accept
    // constructions/usages bound to JValue.cs as the same class identity.
    if (options.targetDefinitions?.some(target =>
        index.files.get(target.file)?.language === 'csharp' &&
        target.modifiers?.includes('partial') &&
        ['class', 'struct', 'record', 'interface'].includes(target.type))) {
        const partialTargets = options.targetDefinitions;
        const closed = definitions.filter(definition =>
            partialTargets.some(target =>
                definition.type === target.type &&
                definition.name === target.name &&
                (definition.namespace || null) === (target.namespace || null) &&
                definition.modifiers?.includes('partial')));
        if (closed.length > partialTargets.length) {
            options = { ...options, targetDefinitions: closed };
        }
    }
    const typeQueryTargets = options.targetDefinitions || definitions;
    const targetIsTypeQuery = typeQueryTargets.length > 0 &&
        typeQueryTargets.every(target => IDENTITY_TYPE_KINDS.has(target.type));
    const targetDefinitionFiles = new Set(
        typeQueryTargets.map(definition => definition.file).filter(Boolean));

    // Possible-dispatch tiering inputs (nominal contract surface) — all fixed
    // per query, computed lazily once. targetTypes mirrors the receiver-class
    // disambiguation set (target classes + non-overriding subtypes); owner
    // keys are the distinct types defining a same-name method project-wide.
    let _dispatchTargetTypes = null;
    const dispatchTargetTypes = (targetDefs) => {
        if (!_dispatchTargetTypes) _dispatchTargetTypes = _buildTargetTypeSet(index, targetDefs, definitions);
        return _dispatchTargetTypes;
    };
    let _methodOwnerKeys = null;
    const methodOwnerKey = (definition) => {
        const owner = definition.className ||
            (definition.receiver && definition.receiver.replace(/^\*/, ''));
        const language = definition.file && index.files.get(definition.file)?.language;
        // Structural prototype/object-member assignments are callable member
        // owners even though the parser represents their value as a function:
        // `proto.locale = function (...) {}` can receive `obj.locale()`.
        // Ignoring them manufactured "single method owner" evidence for an
        // unrelated class method with the same spelling (Day.js measured).
        if (!owner && definition.memberAssigned) {
            return `${language || 'unknown'}:${definition.file || ''}:<member-assigned>`;
        }
        if (!owner) return null;
        if (language === 'csharp') {
            return `csharp:${definition.namespace || ''}:${owner}`;
        }
        if (language === 'go') {
            return `go:${definition.file ? path.dirname(definition.file) : ''}:${owner}`;
        }
        // Java types cannot be partial: the compilation unit plus nested-owner
        // chain is exact identity. File-scoping the remaining languages is a
        // conservative guard against unrelated same-named types in other
        // modules; multiple impl/declaration files may over-count, never
        // manufacture unique-owner evidence.
        return `${language || 'unknown'}:${definition.file || ''}:` +
            `${definition.enclosingType || ''}:${owner}`;
    };
    const methodOwnerKeys = () => {
        if (!_methodOwnerKeys) {
            _methodOwnerKeys = new Set();
            for (const d of definitions) {
                if (NON_CALLABLE_TYPES.has(d.type)) {
                    // Function-typed FIELDS are callable owners (fix #219):
                    // `effect.transform(...)` may be ZodType.transform OR the
                    // $ZodTransformDef.transform property — single-method-owner
                    // confirmation is a lie when an interface declares the same
                    // name as a callable property. Structural only: Java/Rust
                    // cannot call a field by name (obj.f() is always a method
                    // there); Go CAN (func fields) but no measured Go board
                    // carries the family — deferred until measured.
                    if (d.type === 'field' && d.className && _callableFieldDef(index, d)) {
                        const key = methodOwnerKey(d);
                        if (key) _methodOwnerKeys.add(key);
                    }
                    continue;
                }
                const key = methodOwnerKey(d);
                if (key) _methodOwnerKeys.add(key);
            }
        }
        return _methodOwnerKeys;
    };
    const _dispatchCountCache = new Map(); // via type -> candidate count
    const countDispatchCandidates = (via) => {
        if (!_dispatchCountCache.has(via)) {
            _dispatchCountCache.set(via, _countDispatchCandidates(index, via, definitions));
        }
        return _dispatchCountCache.get(via);
    };
    // External-contract target (fix #210, gson-measured): the pinned method
    // carries an explicit override marker (@Override / TS `override` / typing
    // @override / Rust `impl Trait for X`) and has a SINGLE project-wide
    // owner — so the overridden definition is not in the project (a visible
    // project supertype defining the method would be a second owner). The
    // method name provably exists on an external contract (java.lang.Number,
    // std Iterator, ...): any external-typed receiver satisfies the same
    // call, and unique project ownership stops being identity evidence.
    // Receiver-evidence-free calls route possible-dispatch instead of
    // confirming. Lazily computed once per query; null = not external.
    let _extContract; // undefined → not yet computed
    const externalContractTarget = () => {
        if (_extContract !== undefined) return _extContract;
        _extContract = null;
        if (methodOwnerKeys().size === 1) {
            const tDefs = (options.targetDefinitions || definitions).filter(d =>
                !NON_CALLABLE_TYPES.has(d.type) && (d.className || d.receiver));
            // `some`, not `every`: one marked overload proves the NAME exists
            // on an external contract — receiver identity is then unprovable
            // for every call shape (external signatures are invisible).
            const marked = tDefs.find(d => isOverrideMarked(d));
            if (marked) _extContract = { via: _externalContractVia(index, marked) };
        }
        return _extContract;
    };

    // ---- Rename-alias surfaces (import/export renames) ----
    // Other surface names that can denote this symbol:
    //   import-side: `import { _gt as gt }` — fileEntry.importAliases, valid
    //   only inside the renaming file;
    //   export-side: `export { _enum as enum }` / Rust `pub use a as b` —
    //   exportDetails entries carrying an alias, valid in files importing the
    //   renaming module (or in that module itself).
    // A renaming file must sit on an import path to the target (or define it)
    // — otherwise it renames an unrelated same-name symbol. Matched call
    // sites are beyond-text claims: the line does not contain the target name
    // (account.js classifies them in the beyondText bucket).
    const aliasTargetFiles = new Set((options.targetDefinitions || definitions)
        .map(d => d.file).filter(Boolean));
    const importAliasLocals = new Map(); // filePath -> Set<localName>
    const exportAliasRenamers = new Map(); // aliasName -> Set<renamingFilePath>
    for (const [fp, fe] of index.files) {
        const hasImportRenames = fe.importAliases &&
            fe.importAliases.some(a => a && a.original === name && a.local && a.local !== name);
        const exportRenames = fe.exportDetails
            ? fe.exportDetails.filter(e => e && e.alias && e.name === name && e.alias !== name)
            : [];
        if (!hasImportRenames && exportRenames.length === 0) continue;
        const fpImports = index.importGraph.get(fp);
        let linksTarget = aliasTargetFiles.has(fp) ||
            (fpImports && setSome(fpImports, imp => aliasTargetFiles.has(imp)));
        // One barrel hop: `export { _gt as gt } from './core/index.js'` where
        // the barrel re-exports the defining file.
        if (!linksTarget && fpImports) {
            for (const imp of fpImports) {
                const trans = index.importGraph.get(imp);
                if (trans && setSome(trans, ti => aliasTargetFiles.has(ti))) {
                    linksTarget = true;
                    break;
                }
            }
        }
        if (!linksTarget) continue;
        if (hasImportRenames) {
            for (const a of fe.importAliases) {
                if (a && a.original === name && a.local && a.local !== name) {
                    if (!importAliasLocals.has(fp)) importAliasLocals.set(fp, new Set());
                    importAliasLocals.get(fp).add(a.local);
                }
            }
        }
        for (const e of exportRenames) {
            // If the renaming file defines the name itself, the rename refers
            // to that local definition (classic/schemas.ts's `export { _enum
            // as enum }` renames ITS _enum wrapper, not core's _enum) — only
            // credit it when the pinned target IS that local definition.
            if (!aliasTargetFiles.has(fp) && definitions.some(d => d.file === fp)) continue;
            if (!exportAliasRenamers.has(e.alias)) exportAliasRenamers.set(e.alias, new Set());
            exportAliasRenamers.get(e.alias).add(fp);
        }
    }
    // CommonJS callable default export: `const express = require('./lib')`
    // followed by `express()` denotes the local function assigned to
    // `module.exports`, even though the call-site spelling differs. This is
    // exact module ownership: require bindings preserve their default-like
    // shape and the resolved module records the assigned local definition.
    for (const [fp, fe] of index.files) {
        for (const b of (fe.importBindings || [])) {
            if (!b.defaultLike) continue;
            const rel = fe.moduleResolved && fe.moduleResolved[b.module];
            if (!rel) continue;
            const moduleFile = path.join(index.root, rel);
            if (!aliasTargetFiles.has(moduleFile)) continue;
            const exported = index.files.get(moduleFile)?.exportDetails || [];
            if (!exported.some(e => e.type === 'module.exports' &&
                e.defaultLike && (e.localName || e.name) === name)) continue;
            if (!importAliasLocals.has(fp)) importAliasLocals.set(fp, new Set());
            importAliasLocals.get(fp).add(b.alias || b.name);
        }
    }
    // Files that can reach each renaming module through imports — re-export
    // chains run deep (test → mini/index → external → schemas), so a fixed
    // hop count misses real surfaces. Bounded reverse-import BFS; matching
    // stays name+path specific, and tiering still demands its own evidence.
    const aliasReachers = new Map(); // aliasName -> Set<filePath> (renamers + transitive importers)
    for (const [aliasName, renamers] of exportAliasRenamers) {
        const reach = new Set(renamers);
        let frontier = [...renamers];
        for (let depth = 0; depth < 4 && frontier.length && reach.size <= 5000; depth++) {
            const next = [];
            for (const f of frontier) {
                const importers = index.exportGraph.get(f);
                if (!importers) continue;
                for (const importer of importers) {
                    if (!reach.has(importer)) {
                        reach.add(importer);
                        next.push(importer);
                    }
                }
            }
            frontier = next;
        }
        aliasReachers.set(aliasName, reach);
    }
    const aliasNames = new Set(exportAliasRenamers.keys());
    for (const locals of importAliasLocals.values()) {
        for (const local of locals) aliasNames.add(local);
    }
    const hasAliasSurfaces = aliasNames.size > 0;
    const shadowCanReachPinnedTarget = (filePath, call) => {
        if (call.resolvedName === name || call.resolvedNames?.includes(name)) return true;
        const scope = call.enclosingFunction;
        return !!scope && (options.targetDefinitions || definitions).some(d =>
            d.file === filePath && d.name === call.name &&
            d.startLine >= scope.startLine && d.endLine <= scope.endLine &&
            d.startLine <= call.line);
    };

    // Phase 1: Find matching calls without reading file content.
    // Collect pending callers keyed by file — content is read only in Phase 2.
    const pendingByFile = new Map(); // filePath -> [{ call, fileEntry, callerSymbol, isMethod, isFunctionReference, receiver }]
    let pendingCount = 0;
    const pinnedCallableTargets = (options.targetDefinitions || definitions)
        .filter(definition => !NON_CALLABLE_TYPES.has(definition.type));
    const cppOverloadDispatchTarget = pinnedCallableTargets.length > 0 &&
        pinnedCallableTargets.every(definition =>
            index.files.get(definition.file)?.language === 'cpp');
    const cppTemplateDispatchTarget = pinnedCallableTargets.length > 0 &&
        pinnedCallableTargets.every(definition =>
            definition.templateDependent &&
            index.files.get(definition.file)?.language === 'cpp');
    // Route a would-be-dropped candidate into the pending pipeline as an
    // unverified-tier entry (tiered caller contract: shown in its own
    // section, never silently hidden). Does NOT count toward pendingCount —
    // totals describe the confirmed answer.
    const routeUnverified = (filePath, fileEntry, call, reason, calledAs, meta) => {
        if (!collectAccount) return; // non-account paths (trace/blast/verify) keep the plain drop
        const compilerSelectsOverload = cppOverloadDispatchTarget &&
            (reason === 'overload-ambiguous' || reason === 'ambiguous-binding' ||
             (reason === 'method-ambiguous' && call.isMethod));
        if (compilerSelectsOverload && !meta?.uncertaintyClass) {
            meta = {
                ...(meta || {}),
                uncertaintyClass: 'compile-time-dispatch',
                dispatchFamily: reason === 'method-ambiguous'
                    ? `${name} C++ method dispatch set`
                    : cppTemplateDispatchTarget
                    ? `${name} template overload set`
                    : `${name} C++ overload set`,
            };
        }
        if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
        pendingByFile.get(filePath).push({
            call, fileEntry, callerSymbol: null,
            isMethod: call.isMethod || false,
            isFunctionReference: !!(call.isFunctionReference || call.isJsxComponent),
            receiver: call.receiver, receiverType: call.receiverType,
            calledAs,
            _tier: TIER.UNVERIFIED, _reason: reason, _meta: meta,
            // Dispatch-tiered routes carry their own resolution so JSON output
            // distinguishes "possible virtual dispatch" from a bare uncertain.
            _evidence: reason === 'possible-dispatch' ? { possibleDispatch: true }
                : reason === 'method-ambiguous' ? { methodAmbiguous: true }
                : { isUncertain: true },
        });
    };
    const maxResults = options.maxResults;
    // BUG-H1: when consumers (like `about`) need an accurate truncation header
    // ("showing N of <total>"), they pass needsTotal:true so Phase 1 runs to
    // completion. Phase 2 still only enriches the first `maxResults` items —
    // file reads stay bounded, but the candidate count reflects the true total.
    const needsTotal = !!options.needsTotal;
    const localTypeCache = new Map(); // `${filePath}:${startLine}` -> localTypes Map or null
    const returnFlowCache = new Map(); // filePath -> return-type-flow map (see _buildReturnTypeFlowMap)
    const foldCtxCache = new Map(); // filePath -> chained-receiver fold context (fix #258)

    // Use inverted callee index to skip files that don't contain calls to this name
    let calleeFiles = index.getCalleeFiles(name);
    if (hasAliasSurfaces) {
        // Alias surfaces are indexed under their own names — union their files in.
        const union = new Set(calleeFiles || []);
        for (const aliasName of aliasNames) {
            const aliasFiles = index.getCalleeFiles(aliasName);
            if (aliasFiles) for (const f of aliasFiles) union.add(f);
        }
        if (union.size > 0) calleeFiles = union;
    }
    const fileIterator = calleeFiles
        ? [...calleeFiles].map(fp => [fp, index.files.get(fp)]).filter(([, fe]) => fe)
        : index.files;

    for (const [filePath, fileEntry] of fileIterator) {
        // Early exit when maxResults is reached (skip when caller needs the true total)
        if (maxResults && !needsTotal && pendingCount >= maxResults) break;
        try {
            const calls = getCachedCalls(index, filePath);
            if (!calls) continue;
            const structuralLanguage =
                langTraits(fileEntry.language)?.typeSystem === 'structural';

            for (let call of calls) {
                // Skip if not matching our target name (also check alias resolution)
                let calledAs = null; // surface name when matched via an import/export rename
                const typeQualifierReference = targetIsTypeQuery &&
                    call.receiverIsTypeQualified &&
                    call.receiver === name;
                if (call.name !== name && call.resolvedName !== name &&
                    !(call.resolvedNames && call.resolvedNames.includes(name)) &&
                    !typeQualifierReference) {
                    if (!hasAliasSurfaces) continue;
                    const locals = importAliasLocals.get(filePath);
                    if (locals && locals.has(call.name)) {
                        calledAs = call.name;
                    } else {
                        const reach = aliasReachers.get(call.name);
                        if (reach && reach.has(filePath)) calledAs = call.name;
                    }
                    if (!calledAs) continue;
                }
                if (!calledAs && call.name !== name &&
                    (call.resolvedName === name ||
                     (call.resolvedNames && call.resolvedNames.includes(name)))) {
                    calledAs = call.name;
                }

                // A direct static call cannot cross an unrelated runtime
                // language boundary. A Python `service.get` is not a possible
                // target of JavaScript `map.get()`, nor can a Java method be
                // invoked by a C# call merely because the spelling matches.
                // Keep interoperable source families together (JS/TS/HTML and
                // C/C++), and account every other text hit as an explicit
                // exclusion rather than inflating the unverified tier.
                const pinnedLanguageTargets = options.targetDefinitions || definitions;
                if (pinnedLanguageTargets.length > 0 &&
                    !pinnedLanguageTargets.some(target =>
                        _calleeLanguageCompatible(index, target, fileEntry.language))) {
                    recordExcluded(filePath, call.line, 'language-boundary');
                    continue;
                }

                // A call-shaped identifier in a C/C++ replacement list can
                // be a macro parameter (`#define APPLY(fn, x) fn(x)`). It is
                // dynamically supplied by each expansion and therefore is
                // not evidence for a same-named project callable.
                if (call.macroParameter) {
                    recordExcluded(filePath, call.line, 'macro-parameter');
                    continue;
                }

                // Static member syntax carries two compiler symbols:
                // `JValue.Compare(...)` calls Compare and references the
                // JValue type. Class/type queries promise usages rather than
                // constructor-only callers, so preserve that second edge as a
                // first-class type reference. The receiver marker is emitted
                // only by the Java/C# parsers after AST type-vs-value
                // classification; package/module receivers never enter here.
                if (typeQualifierReference) {
                    const identity = _resolveReceiverTypeIdentity(
                        index,
                        filePath,
                        name,
                        typeQueryTargets,
                        call.line,
                        call.receiverTypeNamespace);
                    if (identity === 'other') {
                        recordExcluded(
                            filePath, call.line, 'other-definition-import');
                        continue;
                    }
                    const typeReferenceCall = {
                        ...call,
                        name,
                        isMethod: false,
                        isTypeReference: true,
                    };
                    if (identity === 'unknown') {
                        routeUnverified(
                            filePath,
                            fileEntry,
                            typeReferenceCall,
                            'ambiguous-binding',
                            calledAs,
                            { referenceKind: 'type-qualifier' });
                        continue;
                    }
                    const callerSymbol = index.findEnclosingFunction(
                        filePath, call.line, true);
                    if (!pendingByFile.has(filePath)) {
                        pendingByFile.set(filePath, []);
                    }
                    pendingByFile.get(filePath).push({
                        call: typeReferenceCall,
                        fileEntry,
                        callerSymbol,
                        isMethod: false,
                        isFunctionReference: false,
                        isTypeReference: true,
                        receiver: call.receiver,
                        calledAs,
                        _evidence: {
                            hasReceiverType: true,
                            hasImportEvidence: true,
                        },
                    });
                    pendingCount++;
                    continue;
                }

                // A macro_rules! transcriber is a template, not a concrete
                // dispatch site. rust-analyzer attributes calls to expansion
                // sites (when available), never to the template token line.
                // Keep the text occurrence conserved but out of both evidence
                // tiers; invocations whose argument token trees contain real
                // source calls use inMacro without inMacroDefinition and are
                // still analyzed normally.
                if (collectAccount && call.inMacroDefinition) {
                    recordExcluded(filePath, call.line, 'macro-template');
                    continue;
                }

                // C++ unevaluated operands (`decltype(f())`) participate in
                // compilation and overload selection but never execute `f`.
                // Preserve them as a named compile-time family so impact is
                // complete without overstating runtime caller precision.
                if (collectAccount && fileEntry.language === 'cpp' &&
                    call.compileTimeOnly) {
                    routeUnverified(
                        filePath, fileEntry, call, 'compile-time-only', calledAs, {
                            uncertaintyClass: 'compile-time-dispatch',
                            dispatchFamily:
                                `${name} ${call.compileTimeOnly} dependency`,
                        });
                    continue;
                }

                // Java constructor identity is package/import/nesting scoped.
                // A bare `new Tag()` imported from parser.Tag cannot construct
                // either Evaluator.Tag or Token.Tag merely because all three
                // share the terminal name. Keep unresolved ownership visible;
                // only compiler-shaped scope evidence enters the confirmed tier.
                if (call.isConstructor && fileEntry.language === 'java') {
                    const constructorDisposition = _javaConstructorDisposition(
                        index, filePath, fileEntry, call,
                        options.targetDefinitions || definitions);
                    if (constructorDisposition === 'other') {
                        recordExcluded(filePath, call.line, 'other-definition-import');
                        continue;
                    }
                    if (constructorDisposition === 'unknown') {
                        if (collectAccount) {
                            routeUnverified(filePath, fileEntry, call,
                                'ambiguous-binding', calledAs);
                        }
                        continue;
                    }
                }
                if (call.isConstructor && fileEntry.language === 'csharp' &&
                    targetIsTypeQuery) {
                    const constructorIdentity = _resolveReceiverTypeIdentity(
                        index,
                        filePath,
                        name,
                        typeQueryTargets,
                        call.line,
                        call.receiverTypeNamespace);
                    if (constructorIdentity === 'other') {
                        recordExcluded(
                            filePath, call.line, 'other-definition-import');
                        continue;
                    }
                    if (constructorIdentity === 'unknown') {
                        routeUnverified(
                            filePath, fileEntry, call,
                            'ambiguous-binding', calledAs);
                        continue;
                    }
                    call = { ...call, csharpConstructorExact: true };
                }

                // A named function expression's name is visible only inside
                // its own body (ECMA-262). A pinned NFE target can be called
                // only by code within its range (recursion); any other site
                // provably binds a different definition of the name.
                const pinnedForScope = options.targetDefinitions || definitions;
                if (!call.isMethod && options.targetDefinitions &&
                    pinnedForScope.length > 0 &&
                    pinnedForScope.every(d => d.bodyScopedName) &&
                    !pinnedForScope.some(d => d.file === filePath &&
                        call.line >= d.startLine && call.line <= d.endLine)) {
                    recordExcluded(filePath, call.line, 'other-definition');
                    continue;
                }

                // A cast receiver type is a compile-true STATIC type, but a
                // cast naming a type with NO project definition places the
                // value in code UCN cannot see (java.lang.Integer, external
                // interfaces). Name-knowledge is never routing evidence
                // (#222(4)): the invisible type may extend the target's
                // class, so an unresolved cast neither confirms nor excludes
                // — drop to the receiver-evidence-free physics (#210
                // external-contract / #204 owner rules decide, both modes),
                // exactly the pre-cast-capture record shape. Resolved casts
                // keep their honest typed routing.
                if (call.receiverTypeCast && call.receiverType &&
                    !(index.symbols.get(call.receiverType) || [])
                        .some(d => NON_CALLABLE_TYPES.has(d.type) && d.type !== 'field')) {
                    call = { ...call, receiver: undefined, receiverType: undefined,
                        receiverTypeCast: undefined };
                }
                if (call.receiverTypeStdlibModule && call.receiverType &&
                    !_pythonBuiltinContractAllowed(
                        index, fileEntry, call.receiverTypeStdlibModule)) {
                    call = { ...call, receiverType: undefined,
                        receiverTypeStdlibModule: undefined };
                }

                // Return-type flow: an untyped method receiver may be a
                // variable assigned from a call with a known return annotation
                // (response = client.get(...) with Client.get() -> Response).
                // Structural languages get this everywhere (fix #199). Nominal
                // languages get it on the account surface only (fix #207):
                // a flow-typed interface receiver must reroute to visible
                // possible-dispatch on mismatch, and that routing is
                // collectAccount-gated — legacy commands would silently drop
                // the edge instead. Real method calls only — the callback/
                // reference branch keeps its own #206 routing.
                // Copy-on-enrich: cached call objects stay parser-pure — the flow
                // type derives from OTHER files' annotations, so it must never be
                // persisted with this file's calls.
                if (call.isMethod && call.receiver &&
                    !RESERVED_RECEIVER_NAMES.has(call.receiver) &&
                    (!call.receiverType || call.receiverTypeGuessed) &&
                    !call.receiverPatternShadow && !call.receiverFlowInvalidated &&
                    !call.receiverIsChainRoot &&
                    (langTraits(fileEntry.language)?.typeSystem === 'structural' ||
                        (collectAccount && !call.isPotentialCallback && !call.isPathCall &&
                            langTraits(fileEntry.language)?.typeSystem === 'nominal'))) {
                    let flowMap = returnFlowCache.get(filePath);
                    if (flowMap === undefined) {
                        if (queryProfile) {
                            queryProfile.returnFlowBuilds =
                                (queryProfile.returnFlowBuilds || 0) + 1;
                        }
                        flowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                        returnFlowCache.set(filePath, flowMap);
                    }
                    const flowEntry = flowMap && _lookupReturnTypeFlow(flowMap, call);
                    if (flowEntry && flowEntry.externalVia) {
                        // External producer (fix #220) — typed outside the
                        // project; blocks single-owner confirmation, routes
                        // possible-dispatch in the gate. Nominal-only entries.
                        // A parser GUESS for the same variable (fix #266) is
                        // noise next to the flow verdict — dropped with it.
                        call = {
                            ...call,
                            receiverExternalFlow: flowEntry.externalVia,
                            ...(flowEntry.externalConcrete && {
                                receiverExternalConcreteFlow: true,
                            }),
                        };
                        if (call.receiverTypeGuessed) {
                            call = { ...call, receiverType: undefined, receiverTypeGuessed: undefined };
                        }
                    } else if (flowEntry) {
                        // Compiler-checked return annotation outranks the
                        // parser's New*-prefix name guess (fix #266,
                        // viper-measured: registry := NewCodecRegistry()
                        // guessed 'CodecRegistry' — the interface — while the
                        // annotation says *DefaultCodecRegistry; the guess
                        // excluded all three true RegisterCodec callers).
                        call = { ...call, receiverType: flowEntry.type,
                            receiverTypeGuessed: undefined,
                            receiverFlowInvalidated: false,
                            ...(flowEntry.fromFile && { receiverTypeFlowFile: flowEntry.fromFile }) };
                    }
                }
                // Python loop/comprehension bindings can inherit item types
                // from a declared attribute path. The parser records the
                // source path (`request.headers.raw`) and tuple position;
                // query-time resolution walks project field/property
                // contracts, including constructor-assigned intermediate
                // fields, before dispatch is judged.
                if (collectAccount && fileEntry.language === 'python' &&
                    call.isMethod && !call.receiverType &&
                    call.receiverIterationFields?.length) {
                    let rootType = call.receiverIterationRootType;
                    if (!rootType && call.receiverIterationRoot === 'self') {
                        rootType = index.findEnclosingFunction(
                            filePath, call.line, true)?.className;
                    }
                    if (!rootType && call.receiverIterationRoot) {
                        let flowMap = returnFlowCache.get(filePath);
                        if (flowMap === undefined) {
                            flowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                            returnFlowCache.set(filePath, flowMap);
                        }
                        const inferred = flowMap && _lookupReturnTypeFlow(flowMap, {
                            ...call,
                            receiver: call.receiverIterationRoot,
                        });
                        if (inferred?.type) rootType = inferred.type;
                    }
                    if (rootType) {
                        const items = _pythonDeclaredIterablePathItems(
                            index, rootType, call.receiverIterationFields);
                        const item = items?.[call.receiverIterationIndex || 0];
                        if (item) call = { ...call, receiverType: item };
                    }
                }

                if (call.isMethod && call.receiver && !call.receiverType &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const importedType = _structuralImportedReceiverType(
                        index, fileEntry, call.receiver);
                    if (importedType) {
                        call = { ...call, receiverType: importedType.type,
                            receiverTypeFlowFile: importedType.fromFile };
                    }
                }

                // Structural annotations/imported types need the same exact
                // declaration origin as folded return types. Two modules may
                // export disagreeing aliases with the same local name; the
                // receiver's import decides which identity participates in
                // dispatch.
                if (call.isMethod && call.receiverType &&
                    !call.receiverTypeFlowFile && !call.receiverTypeGuessed &&
                    !call.receiverTypePlatform &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const origin = _resolveFlowTypeOrigin(
                        index, filePath, call.receiverType,
                        call.receiverTypeQualifier);
                    if (origin?.fromFile) {
                        call = {
                            ...call,
                            receiverType:
                                _aliasBaseAtOrigin(
                                    index, call.receiverType, origin.fromFile) ||
                                call.receiverType,
                            receiverTypeFlowFile: origin.fromFile,
                        };
                    }
                }

                // Java platform/project-call receiver flow: the parser preserves the
                // full owner/method path for chained expressions such as
                // `element.getAnnotationMirrors().get(0)`. An exact JDK
                // contract types the receiver as List/Map/etc., preventing
                // the terminal name from entering unrelated project method
                // ambiguity bands. Project factories additionally carry the
                // defining file, so same-named nested result types remain
                // distinct (`OuterA.Builder` vs `OuterB.Builder`).
                if (collectAccount && fileEntry.language === 'java' &&
                    call.isMethod && !call.receiverType && call.receiverCallTypePath) {
                    const returnInfo = _javaCallReturnInfo(
                        index, call.receiverCallTypePath);
                    if (returnInfo?.type) {
                        call = {
                            ...call,
                            receiverType: returnInfo.type.replace(/\[\]$/, '').split('.').pop(),
                            ...(returnInfo.fromFile && {
                                receiverTypeFlowFile: returnInfo.fromFile,
                            }),
                            ...(returnInfo.platform && {
                                receiverTypePlatform: true,
                            }),
                        };
                    }
                }

                // Rust annotations are often imported through a crate-root
                // re-export (`use clap::Command`). Preserve that exact origin
                // before receiver identity checks and chain folding; the
                // simple name alone is ambiguous in workspaces with derive
                // fixtures that define their own `Command` types.
                if (collectAccount && fileEntry.language === 'rust' &&
                    call.isMethod && call.receiverType &&
                    !call.receiverTypeFlowFile && !call.receiverTypeGuessed) {
                    const origin = _resolveFlowTypeOrigin(
                        index, filePath, call.receiverType,
                        call.receiverTypeQualifier);
                    if (origin?.fromFile) {
                        call = { ...call, receiverTypeFlowFile: origin.fromFile };
                    }
                }

                // Rust match-arm payloads carry compiler-declared receiver
                // types (`Variant(ref value) => value.method()`). Resolve the
                // exact indexed variant and positional payload before method
                // dispatch; external qualified payloads remain external
                // provenance, never borrowed project identity.
                if (collectAccount && fileEntry.language === 'rust' &&
                    call.isMethod && !call.receiverType &&
                    call.receiverPatternVariant) {
                    const patternType = _rustPatternReceiverType(
                        index, fileEntry, filePath, call);
                    if (patternType?.type) {
                        call = {
                            ...call,
                            receiverType: patternType.type,
                            ...(patternType.fromFile && {
                                receiverTypeFlowFile: patternType.fromFile,
                            }),
                        };
                    } else if (patternType?.externalVia) {
                        call = {
                            ...call,
                            receiverExternalFlow: patternType.externalVia,
                            receiverExternalConcreteFlow: true,
                        };
                    }
                }

                // Python module-qualified constructor provenance (fix #274):
                // `thread = threading.Thread(); thread.join()` is not evidence
                // for a project `URL.join` merely because the parser retained
                // only the terminal type name.  Resolve the qualifier into the
                // project when possible; external or unresolved owners remain
                // visible as possible dispatch and can never enter tier 1.
                if (call.isMethod && call.receiverType && call.receiverTypeQualifier &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const origin = _structuralQualifiedReceiverOrigin(
                        index, fileEntry, call.receiverTypeQualifier, call.receiverType);
                    if (origin?.kind === 'project') {
                        call = { ...call, receiverTypeFlowFile: origin.fromFile };
                    } else if (origin?.kind === 'external') {
                        call = BUILTIN_RECEIVER_TYPES.has(call.receiverType)
                            ? { ...call, receiverTypePlatform: true }
                            : { ...call, receiverType: undefined,
                                receiverExternalFlow: origin.via,
                                receiverExternalConcreteFlow: true };
                    } else if (origin) {
                        call = { ...call, receiverType: undefined,
                            receiverQualifiedFlow: origin.via };
                    }
                }

                // An unqualified constructor name can still have exact import
                // provenance: `from io import StringIO; out = StringIO()`.
                // A resolved project import pins the type to that file; a
                // clearly external import blocks project-local single-owner
                // confirmation. Annotation-only receivers do not take this
                // path because they may hold a project subtype.
                if (call.isMethod && call.receiverConstructed && call.receiverType &&
                    !call.receiverTypeQualifier &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const bindings = (fileEntry.importBindings || []).filter(b =>
                        b.name === call.receiverType || b.alias === call.receiverType);
                    if (bindings.length > 0) {
                        const project = bindings.map(b => ({
                            binding: b,
                            rel: fileEntry.moduleResolved && fileEntry.moduleResolved[b.module],
                        })).find(x => x.rel);
                        if (project) {
                            call = { ...call,
                                receiverType: project.binding.name,
                                receiverTypeFlowFile: path.join(index.root, project.rel),
                            };
                        } else {
                            const projectish = bindings.some(b => {
                                const mod = String(b.module || '');
                                const first = mod.split(/[./]/).filter(Boolean)[0];
                                return mod.startsWith('.') ||
                                    (first && _projectTopLevelNames(index).has(first));
                            });
                            const via = `${bindings[0].module}.${bindings[0].name}`;
                            if (BUILTIN_RECEIVER_TYPES.has(call.receiverType)) {
                                // Stable stdlib runtime classes (StringIO,
                                // BytesIO, etc.) retain their concrete builtin
                                // identity even though their module lies
                                // outside the project index.
                                call = { ...call, receiverTypePlatform: true };
                            } else {
                                call = { ...call, receiverType: undefined,
                                    ...(projectish
                                        ? { receiverQualifiedFlow: `${via} — unresolved module` }
                                        : { receiverExternalFlow: via,
                                            receiverExternalConcreteFlow: true }) };
                            }
                        }
                    }
                }

                // An untyped value produced by a context manager (`with ...
                // as out`) has no receiver identity. A unique project method
                // spelling is not enough to confirm it; keep the edge visible
                // until an annotation/constructor/return flow proves the type.
                if (collectAccount && call.isMethod && call.receiverWithBinding &&
                    !call.receiverType && !call.receiverExternalFlow && !call.receiverQualifiedFlow) {
                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                        dispatchVia: 'context-manager result',
                    });
                    continue;
                }

                // Chained-receiver typing (fix #219): the receiver IS a call —
                // `me._def.args.parseAsync(args, params).catch(...)` — so the
                // producer's DECLARED return annotation types it (Promise →
                // builtin → exclusion-grade under the trust gate; the target's
                // own class validates; anything else attributes dispatch).
                // Method producers must AGREE project-wide (the #207
                // discipline); plain producers follow #199's unique-def rule.
                // Structural only: nominal parsers don't capture receiverCall —
                // their chained calls stay under the #204 dispatch tiering
                // (visible, honest) until a measured family justifies the
                // #207 origin-pinning rails there.
                if (call.isMethod && (!call.receiver || call.receiverIsChainRoot) &&
                    !call.receiverType && call.receiverCall &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    // Fold first (fix #258 — multi-hop builder chains typed
                    // from the producer link), one-hop agreement as fallback.
                    let foldCtx = foldCtxCache.get(filePath);
                    if (!foldCtx) {
                        foldCtx = { memo: new Map(), visiting: new Set(), records: calls,
                            getFlowMap: () => {
                                let fm = returnFlowCache.get(filePath);
                                if (fm === undefined) {
                                    fm = _buildReturnTypeFlowMap(index, filePath, calls);
                                    returnFlowCache.set(filePath, fm);
                                }
                                return fm;
                            } };
                        foldCtxCache.set(filePath, foldCtx);
                    }
                    const folded = _foldChainedReceiverType(index, fileEntry, filePath, call, foldCtx);
                    const builtinChained = _pythonBuiltinChainedReceiverType(
                        index, fileEntry, call, foldCtx);
                    if (builtinChained) {
                        call = { ...call, receiverType: builtinChained,
                            receiverTypePlatform: true };
                    } else if (folded && folded.type) {
                        call = { ...call, receiverType: folded.type,
                            ...(folded.fromFile && { receiverTypeFlowFile: folded.fromFile }) };
                    } else if (folded && folded.externalVia) {
                        call = {
                            ...call,
                            receiverExternalFlow: folded.externalVia,
                            ...(folded.externalConcrete && {
                                receiverExternalConcreteFlow: true,
                            }),
                        };
                    } else if (!folded?.suppressFallback) {
                        const chainedType = _chainedReceiverType(index, call, fileEntry.language);
                        if (chainedType) call = { ...call, receiverType: chainedType.type,
                            ...(chainedType.fromFile && { receiverTypeFlowFile: chainedType.fromFile }) };
                    }
                } else if (call.isMethod && (!call.receiver || call.receiverIsChainRoot) &&
                    !call.receiverType && call.receiverCall &&
                    collectAccount && !call.isPotentialCallback &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    // Nominal chained receivers (fix #220, cobra-measured):
                    // account-gated like the #207 nominal flow — mismatch
                    // reroutes are account-only; legacy would silently drop.
                    // The fold (fix #258) runs first — Command::new("x")
                    // .author(a).arg(b) types hop-by-hop where the one-hop
                    // agreement rule dies on multi-owner `Self` returns.
                    let foldCtx = foldCtxCache.get(filePath);
                    if (!foldCtx) {
                        foldCtx = { memo: new Map(), visiting: new Set(), records: calls,
                            getFlowMap: () => {
                                let fm = returnFlowCache.get(filePath);
                                if (fm === undefined) {
                                    fm = _buildReturnTypeFlowMap(index, filePath, calls);
                                    returnFlowCache.set(filePath, fm);
                                }
                                return fm;
                            } };
                        foldCtxCache.set(filePath, foldCtx);
                    }
                    const flowEntry = _foldChainedReceiverType(
                        index, fileEntry, filePath, call, foldCtx) ||
                        _nominalChainedReceiverType(
                            index, call, fileEntry, filePath);
                    if (flowEntry && flowEntry.externalVia) {
                        call = {
                            ...call,
                            receiverExternalFlow: flowEntry.externalVia,
                            ...(flowEntry.externalConcrete && {
                                receiverExternalConcreteFlow: true,
                            }),
                        };
                    } else if (flowEntry) {
                        call = { ...call, receiverType: flowEntry.type,
                            ...(flowEntry.fromFile && { receiverTypeFlowFile: flowEntry.fromFile }) };
                    }
                }

                // Rust for-loop bindings inherit the exact Item type of their
                // iterator source (`for arg in cmd.get_arguments()`). The
                // parser retains that source call's byte span; query-time
                // analysis resolves the source owner and its declared
                // `Iterator<Item = T>` contract. Item-preserving std adapters
                // such as rev/filter/take recurse to that same declaration.
                if (collectAccount && fileEntry.language === 'rust' &&
                    call.isMethod && call.receiver && !call.receiverType &&
                    (call.receiverIterationCall || call.receiverIterationVariable)) {
                    let foldCtx = foldCtxCache.get(filePath);
                    if (!foldCtx) {
                        foldCtx = { memo: new Map(), visiting: new Set(), records: calls,
                            getFlowMap: () => {
                                let fm = returnFlowCache.get(filePath);
                                if (fm === undefined) {
                                    fm = _buildReturnTypeFlowMap(index, filePath, calls);
                                    returnFlowCache.set(filePath, fm);
                                }
                                return fm;
                            } };
                        foldCtxCache.set(filePath, foldCtx);
                    }
                    let items = [];
                    if (call.receiverIterationVariable) {
                        const flow = _lookupReturnTypeFlow(foldCtx.getFlowMap(), {
                            ...call,
                            receiver: call.receiverIterationVariable,
                        });
                        if (flow?.iteratorItemType) {
                            items = [{
                                type: flow.iteratorItemType,
                                fromFile: flow.iteratorItemFromFile,
                            }];
                        }
                    } else {
                        const sources = _chainedProducerRecords(foldCtx, {
                            receiverCall: call.receiverIterationCall,
                            receiverCallIsMethod: call.receiverIterationCallIsMethod,
                            receiverCallLine: call.receiverIterationCallLine,
                            receiverCallStart: call.receiverIterationCallStart,
                            receiverCallEnd: call.receiverIterationCallEnd,
                        });
                        items = sources.map(source => _rustIteratorOutputItemType(
                            index, fileEntry, filePath, source, foldCtx));
                    }
                    if (items.length > 0 && items.every(Boolean) &&
                        new Set(items.map(item => item.type)).size === 1 &&
                        new Set(items.map(item => item.fromFile)).size === 1 &&
                        items[0].fromFile) {
                        call = {
                            ...call,
                            receiverType: items[0].type,
                            receiverTypeFlowFile: items[0].fromFile,
                        };
                    }
                }

                // Rust closure parameters inherit exact types from callable
                // parameter contracts when the enclosing method receiver is
                // itself pinned. Example: `Command::new().defer(|cmd|
                // cmd.arg(...))` and `defer: fn(Command) -> Command`. Both the
                // outer receiver and callback signature must resolve through
                // indexed declarations; generic/unresolved closures stay
                // visible.
                if (collectAccount && fileEntry.language === 'rust' &&
                    call.isMethod && call.receiver && !call.receiverType &&
                    call.enclosingFunction?.closureSourceCall) {
                    let foldCtx = foldCtxCache.get(filePath);
                    if (!foldCtx) {
                        foldCtx = { memo: new Map(), visiting: new Set(), records: calls,
                            getFlowMap: () => {
                                let fm = returnFlowCache.get(filePath);
                                if (fm === undefined) {
                                    fm = _buildReturnTypeFlowMap(index, filePath, calls);
                                    returnFlowCache.set(filePath, fm);
                                }
                                return fm;
                            } };
                        foldCtxCache.set(filePath, foldCtx);
                    }
                    const closureType = _rustClosureReceiverType(
                        index, fileEntry, filePath, call, foldCtx);
                    if (closureType) {
                        call = {
                            ...call,
                            receiverType: closureType.type,
                            receiverTypeFlowFile: closureType.fromFile,
                        };
                    }
                }

                // Intra-class constructor mechanics are never caller edges
                // (fix #238, jdtls-measured): an enum CONSTANT is part of the
                // enum's own declaration (JsonToken's 10 constants confirmed
                // 10 self-callers), and a `this(...)` delegation names the
                // ENCLOSING class by construction. Both stay in the calls
                // cache for deadcode/--unused reachability; `super(...)`
                // names a DIFFERENT class and keeps its caller edge.
                if (call.enumConstant || call.ctorDelegation === 'this') {
                    continue;
                }

                // For potential callbacks (function passed as arg), validate against symbol table
                // and skip complex binding resolution — just check the name exists
                if (call.isPotentialCallback) {
                    // Go closure-entry marker: a composite-field func literal
                    // records the ENCLOSING function's name at the closure line
                    // (deadcode reachability for RunE-style closures) — it is a
                    // self-line artifact, never a caller edge.
                    if (!call.isFunctionReference && !call.isMethod && call.fieldName &&
                        call.enclosingFunction && call.enclosingFunction.name === call.name) {
                        continue;
                    }
                    const syms = definitions;
                    if (!syms || syms.length === 0) continue;
                    const cbTargetDefs = options.targetDefinitions || definitions;

                    // Go unexported visibility: lowercase functions are package-private.
                    // Only allow callers from the same package directory. Recorded
                    // with reason (not a silent drop) — same disposition as the
                    // plain-call visibility gate below.
                    if (langTraits(fileEntry.language)?.exportVisibility === 'capitalization' && /^[a-z]/.test(name)) {
                        const targetPkgDirs = new Set(
                            cbTargetDefs.filter(d => d.file).map(d => path.dirname(d.file))
                        );
                        if (targetPkgDirs.size > 0 && !targetPkgDirs.has(path.dirname(filePath))) {
                            recordExcluded(filePath, call.line, 'out-of-scope-package');
                            continue;
                        }
                    }

                    // Package-qualified reference (Go): `pkg.Name` passed as a
                    // value denotes a symbol IN package pkg — never the current
                    // package (Go cannot self-import), never an unrelated
                    // same-name target. grpc-go-measured: `balancer.Get(priority.Name)`
                    // references the CONST priority.Name, not a pinned method
                    // `Name` — the target's own same-file/same-package evidence
                    // says nothing about what a qualified name resolves to.
                    if (call.isMethod && call.receiver &&
                        langTraits(fileEntry.language)?.hasReceiverPackageCalls) {
                        const cbPkgRes = _receiverPackageResolution(index, fileEntry, call.receiver, cbTargetDefs);
                        if (cbPkgRes) {
                            if (cbPkgRes.singleSegment) {
                                // Single-segment import — Go stdlib, always external
                                recordExcluded(filePath, call.line, 'external-package');
                                continue;
                            }
                            if (!cbPkgRes.targetInPkg) {
                                recordExcluded(filePath, call.line, 'other-definition');
                                continue;
                            }
                        }
                    }

                    // A member access on a typed receiver whose member of this
                    // name is a provably non-callable FIELD denotes the field,
                    // never a same-name symbol elsewhere (fix #266,
                    // viper-measured: `delete(v.override, alias)` on Viper's
                    // map field scope-confirmed against the test-file function
                    // `override` — the #231(2) callee physics, caller side).
                    // Only certainty excludes: _nonCallableFieldMember demands
                    // every same-type member be a field with a present
                    // non-function type. Guess-grade receiver types (#266)
                    // never carry it.
                    if (call.isMethod && call.receiverType && !call.receiverTypeGuessed &&
                        _nonCallableFieldMember(index, call.receiverType, call.name, fileEntry.language)) {
                        recordExcluded(filePath, call.line, 'member-reference');
                        continue;
                    }

                    // A bare identifier passed as a function value cannot
                    // denote an instance METHOD in any language — method
                    // values carry a receiver (`worker.run`, `Worker::run`,
                    // `this::run`). This also covers structural languages:
                    // `dayjs.locale(locale)` passes the imported standalone
                    // value `locale`; it is not a reference to Dayjs.locale.
                    // For nominal bare calls, retain the broader #220 rule
                    // (Go/Rust names cannot reach methods; Java static imports
                    // remain exempt). Compiler-grade kind evidence — excluded
                    // with reason on every surface.
                    if (!call.localShadow && !call.isMethod && !call.receiver &&
                        (call.isFunctionReference ||
                            (langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                                !langTraits(fileEntry.language)?.bareCallReachesMethods))) {
                        const allMethodTargets = cbTargetDefs.length > 0 && cbTargetDefs.every(d =>
                            !NON_CALLABLE_TYPES.has(d.type) && (d.className || d.receiver));
                        if (allMethodTargets) {
                            recordExcluded(filePath, call.line, 'method-kind-mismatch');
                            continue;
                        }
                    }

                    // A paren-less member access is ALWAYS a field in Rust —
                    // method values are path-only (Type::method), so
                    // `self.paths.has_implicit_path` provably denotes the bool
                    // FIELD, never the method (fix #220, ripgrep-measured).
                    if (call.isMethod && call.isFunctionReference &&
                        langTraits(fileEntry.language)?.memberAccessNeverMethod) {
                        const allMethodTargets = cbTargetDefs.length > 0 && cbTargetDefs.every(d =>
                            !NON_CALLABLE_TYPES.has(d.type) && (d.className || d.receiver));
                        if (allMethodTargets) {
                            recordExcluded(filePath, call.line, 'method-kind-mismatch');
                            continue;
                        }
                    }

                    // Nominal type receiver disambiguation for callbacks (e.g. dc.worker)
                    if (call.isMethod &&
                        langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                        const targetTypes = new Set();
                        for (const td of cbTargetDefs) {
                            if (td.className) targetTypes.add(td.className);
                            if (td.receiver) targetTypes.add(td.receiver.replace(/^\*/, ''));
                        }
                        // Qualified receiver types resolve their package FIRST
                        // (fix #298 — the #273 gate's callback twin):
                        // `netDial = (&net.Dialer{}).DialContext` is net's
                        // Dialer; the bare name must never match a project
                        // `Dialer` pin, and the external contract must carry
                        // its label so consumers can defer the site.
                        if (fileEntry.language === 'go' &&
                            call.receiverType && call.receiverTypeQualifier) {
                            const cbQualified = _goQualifiedReceiverType(
                                index, fileEntry, call.receiverTypeQualifier,
                                call.receiverType);
                            if (cbQualified) {
                                const cbIsContract = cbQualified.kind === 'project' &&
                                    cbQualified.defs.some(d =>
                                        d.type === 'interface' || d.type === 'trait');
                                if (cbQualified.kind !== 'project' || cbIsContract) {
                                    if (collectAccount) {
                                        const cbPlatformConcrete = cbQualified.kind !== 'project' &&
                                            getLanguageAdapter('go')?.isPlatformConcreteType?.(
                                                call.receiverTypeQualifier, call.receiverType);
                                        if (cbPlatformConcrete) {
                                            recordExcluded(filePath, call.line, 'external-package');
                                        } else {
                                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                                dispatchVia: cbQualified.via,
                                                dispatchCandidates: countDispatchCandidates(call.receiverType),
                                                ...(cbQualified.kind !== 'project' && { externalContract: true }),
                                            });
                                        }
                                    }
                                    continue;
                                }
                            } else {
                                // Unresolvable qualifier — the bare type name
                                // must not match a project pin (#206c). Visible,
                                // never validated, never excluded.
                                if (collectAccount) {
                                    routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs,
                                        { dispatchCandidates: countDispatchCandidates(call.receiverType) });
                                }
                                continue;
                            }
                        }
                        if (targetTypes.size > 0 && call.receiverType &&
                            !targetTypes.has(call.receiverType)) {
                            // Raw-set mismatch — check the CLOSED set (aliases +
                            // non-overriding subtypes incl. Go embedding) before
                            // disposing: a reference through a promoting outer
                            // type or a type alias IS the target's method.
                            if (!dispatchTargetTypes(cbTargetDefs).has(call.receiverType)) {
                                // A method VALUE binds at the receiver's static
                                // type: a typed receiver that is neither the
                                // target type nor below it denotes ANOTHER
                                // type's method — excluded with reason, unless
                                // the type can virtually dispatch into the
                                // target (interface receiver), which routes
                                // visible possible-dispatch. Was a silent drop:
                                // the ground line surfaced as call-not-resolved
                                // (grpc-go/cursive-measured).
                                if (collectAccount) {
                                    // Guess-grade types (fix #266) route, never
                                    // exclude — convention is not compiler truth.
                                    if (call.receiverTypeGuessed ||
                                        _dispatchCapableSupertype(index, fileEntry.language, call.receiverType, cbTargetDefs, definitions)) {
                                        routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                            dispatchVia: call.receiverType,
                                            dispatchCandidates: countDispatchCandidates(call.receiverType),
                                        });
                                    } else {
                                        recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                                    }
                                }
                                continue;
                            }
                        }
                        // Under the account contract, a qualified reference
                        // whose receiver is neither an imported package
                        // (resolved above), the target type itself
                        // (type-qualified method reference), nor a validated
                        // type is a name match through an UNKNOWN owner — that
                        // includes receivers the parser could not capture at
                        // all (indexed/chained selectors: `xs[0].Name`).
                        // Mirrors the #204 method-call gate: a unique
                        // project-wide owner still confirms; multiple owners
                        // route to visible 'method-ambiguous' — never confirmed
                        // via the target's bare-identifier scope evidence below.
                        // A pinned TYPE target additionally routes regardless
                        // of owner count: `m.ResourceType` is a member access
                        // on a value — it cannot denote the type itself (only
                        // a package-qualified name can, and that resolved
                        // above; an alias-imported package receiver stays
                        // visible here rather than excluded).
                        if (collectAccount) {
                            const cbTypes = dispatchTargetTypes(cbTargetDefs);
                            const cbTypeQualified = call.receiver && cbTypes.has(call.receiver);
                            const cbTypedMatch = call.receiverType && cbTypes.has(call.receiverType);
                            const cbAllTypeTargets = cbTargetDefs.length > 0 &&
                                cbTargetDefs.every(d => IDENTITY_TYPE_KINDS.has(d.type));
                            if (!cbTypeQualified && !cbTypedMatch &&
                                (methodOwnerKeys().size > 1 || cbAllTypeTargets)) {
                                routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs,
                                    { dispatchCandidates: methodOwnerKeys().size });
                                continue;
                            }
                        }
                    }

                    // Resolution evidence for a bare-identifier function reference:
                    // the name reaches the target via module scope (same file),
                    // same-package scope (nominal languages), or an import edge
                    // (direct or one barrel hop). Argument position alone is a name
                    // match, not evidence — a local variable or an unrelated
                    // same-name symbol shadows it invisibly.
                    const cbTargetFiles = new Set(cbTargetDefs.map(d => d.file).filter(Boolean));
                    const cbSameFile = cbTargetFiles.has(filePath);
                    // A module-local definition owns a bare callback name
                    // before any file-level import graph evidence. Importing
                    // the target's package elsewhere in the file cannot make
                    // `register(group)` refer past a local `def group()`.
                    // Ownership requires a def a BARE name can actually bind
                    // (#218a/#222(3)/#269(2)): class members, property-
                    // assigned functions, and body-scoped function-expression
                    // names never own module scope — a same-file `class X {
                    // validate() {} }` must not exclude the imported
                    // validate passed as a callback.
                    if (!cbSameFile && (index.symbols.get(call.name) || []).some(d =>
                        d.file === filePath && !cbTargetFiles.has(d.file) &&
                        d.startLine <= call.line &&
                        !d.className && !d.memberAssigned && !d.bodyScopedName &&
                        !NON_CALLABLE_TYPES.has(d.type))) {
                        recordExcluded(filePath, call.line, 'other-definition-import');
                        continue;
                    }
                    const cbSamePackage = !cbSameFile &&
                        langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                        cbTargetDefs.some(d => d.file &&
                            _sameNominalPackageDir(path.dirname(d.file), path.dirname(filePath), fileEntry.language));
                    let cbImportLink = false;
                    if (!cbSameFile && !cbSamePackage) {
                        const cbImports = index.importGraph.get(filePath);
                        cbImportLink = !!(cbImports && setSome(cbImports, imp => cbTargetFiles.has(imp)));
                        if (!cbImportLink && cbImports) {
                            for (const imp of cbImports) {
                                const trans = index.importGraph.get(imp);
                                if (trans && setSome(trans, ti => cbTargetFiles.has(ti))) {
                                    cbImportLink = true;
                                    break;
                                }
                            }
                        }
                        if (!cbImportLink) {
                            // Positive mis-link evidence: the name resolves to a
                            // same-name definition in this file (or one this file
                            // imports) that is NOT the target — same disposition
                            // as the import-graph disambiguation for plain calls.
                            // Bare-name bindable defs only (#222(3)): a foreign
                            // class's same-name METHOD is unreachable by a bare
                            // reference and proves no mis-link.
                            const cbOtherDefFiles = new Set((index.symbols.get(call.name) || [])
                                .filter(d => !d.className && !d.memberAssigned &&
                                    !d.bodyScopedName && !NON_CALLABLE_TYPES.has(d.type))
                                .map(d => d.file).filter(f => f && !cbTargetFiles.has(f)));
                            if (cbOtherDefFiles.has(filePath) ||
                                (cbImports && setSome(cbImports, imp => cbOtherDefFiles.has(imp)))) {
                                recordExcluded(filePath, call.line, 'other-definition-import');
                                continue;
                            }
                        }
                    }

                    // Find the enclosing function
                    const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                    // A parameter of the enclosing function with the same name
                    // shadows the target: `disposeEffect(effect)` inside
                    // `function disposeEffect(effect)` references the parameter,
                    // not a same-name module-scope symbol. Same for let/const
                    // locals and inner-arrow params (fix #203 — parser-side
                    // lexical scope walk sets call.localShadow; JS block-accurate,
                    // Python function-wide assignment semantics).
                    if ((call.localShadow && !shadowCanReachPinnedTarget(filePath, call)) ||
                        (callerSymbol && Array.isArray(callerSymbol.paramsStructured) &&
                            callerSymbol.paramsStructured.some(p => p && p.name === call.name))) {
                        recordExcluded(filePath, call.line, 'local-shadow');
                        continue;
                    }
                    if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
                    pendingByFile.get(filePath).push({
                        call, fileEntry, callerSymbol,
                        isMethod: false, isFunctionReference: true, receiver: undefined,
                        calledAs,
                        _evidence: {
                            isFunctionReference: true,
                            hasImportEvidence: cbSameFile || cbImportLink,
                            hasSamePackageEvidence: cbSamePackage,
                        }
                    });
                    pendingCount++;
                    continue;
                }

                // Resolve binding within this file (without mutating cached call objects)
                let bindingId = call.bindingId;
                let isUncertain = call.uncertain;
                // Parser-detected lexical shadow (fix #203, hoisted by #222 —
                // express-measured): a local let/var/param of the same name
                // shadows the target at this reference, whatever record shape
                // carried it. The callback fast path already excluded its own;
                // an isFunctionReference-only argument ref (`router.use(path,
                // f)` inside `use(fn)`'s forEach closure) used to slip past to
                // binding resolution and exact-confirm on the shadowed name.
                if (call.localShadow && !call.isPotentialCallback &&
                    !shadowCanReachPinnedTarget(filePath, call)) {
                    recordExcluded(filePath, call.line, 'local-shadow');
                    continue;
                }

                // Skip binding resolution for calls with non-self/this/cls receivers:
                // e.g., analyzer.analyze_instrument() should NOT resolve to a local
                // standalone function def `analyze_instrument` — they're different symbols.
                // Also skip for Go package-qualified calls (isMethod:false but has receiver like 'cli')
                // `super` skips too (fix #238): a super call targets the PARENT
                // class's member by definition — the local binding of the name
                // is the enclosing class's own member, provably the wrong def
                // (super(config) bound to the subclass's OWN constructor).
                // Super records resolve only through the parent-chain walk.
                const selfReceivers = new Set(['self', 'cls', 'this']);
                const indirectStructuralReceiver = call.isMethod && !call.receiver &&
                    !!(call.receiverRoot || call.receiverField || call.receiverCall ||
                        call.receiverType || call.receiverDeepPath);
                const skipLocalBinding = (call.receiver && !selfReceivers.has(call.receiver)) ||
                    indirectStructuralReceiver;
                if (!bindingId && !skipLocalBinding) {
                    // A bare call cannot bind to a METHOD def where bare names
                    // never reach methods (fix #220, cobra-measured): Go's
                    // func (c *Command) MarkFlagDirname and func MarkFlagDirname
                    // coexist in one package — the bare call denotes the
                    // FUNCTION. Java keeps both (implicit this-calls). Fix
                    // #222 (rich-measured) extends this to structural: the
                    // bindings table lists class members, but Python bare-name
                    // lookup never enters class scope (`cell_len(self.plain)`
                    // inside Text binds the module-level import of
                    // cells.cell_len, not Text.cell_len) and a JS class
                    // member is not a file binding either — the structural
                    // dispatch gates can't own this case because a matched
                    // bindingId bypasses them. Fix #229: the filter applies
                    // per source file — sibling-file bindings from Go's
                    // package-scope concat below carry interface members and
                    // methods too (`type Notifier interface { Notify() }`
                    // next to `func Notify()` stole the bindingId and
                    // excluded the true caller as other-definition).
                    const bareNeverMethod = !call.isMethod &&
                        (!langTraits(fileEntry.language)?.bareCallReachesMethods ||
                         call.globalQualified);
                    const defsOfName = bareNeverMethod ? (index.symbols.get(call.name) || []) : null;
                    const dropMethodBindings = (list, file) => {
                        if (!bareNeverMethod || list.length === 0) return list;
                        return list.filter(b => {
                            const sym = defsOfName.find(s => s.file === file && s.startLine === b.startLine);
                            return !(sym && (sym.className || sym.receiver));
                        });
                    };
                    let bindings = dropMethodBindings(
                        (fileEntry.bindings || []).filter(b => b.name === call.name), filePath);
                    // For Go, also check sibling files in same directory (same package scope)
                    if (bindings.length === 0 && langTraits(fileEntry.language)?.packageScope === 'directory') {
                        const dir = path.dirname(filePath);
                        const siblings = index.dirToFiles?.get(dir) || [];
                        for (const fp of siblings) {
                            if (fp !== filePath) {
                                const fe = index.files.get(fp);
                                if (fe) {
                                    const sibling = dropMethodBindings(
                                        (fe.bindings || []).filter(b => b.name === call.name), fp);
                                    bindings = bindings.concat(sibling);
                                }
                            }
                        }
                    }
                    if (bindings.length === 1) {
                        bindingId = bindings[0].id;
                    } else if (bindings.length > 1 && !call.isMethod &&
                        call.isConstructor &&
                        bindings.filter(candidate =>
                            CONSTRUCTABLE_BINDING_KINDS.has(candidate.type))
                            .length === 1) {
                        // Constructor calls bind to constructable symbols: `new ZodArray()`
                        // must resolve to the class binding, not a same-name field/const
                        // elsewhere in the file (TS declaration merging, bottom-of-file
                        // namespace aliases). All `new`-style languages mark these
                        // (JS/TS/Java/C# `new`, Go/Rust/C/C++ composite/struct
                        // literals). Rust exposed the missing shared rule:
                        // `SearchWorker { ... }` had one `struct` plus several
                        // same-name `impl` bindings and was routed ambiguous.
                        const constructable = bindings.filter(
                            candidate => CONSTRUCTABLE_BINDING_KINDS.has(
                                candidate.type));
                        bindingId = constructable[0].id;
                    } else if (bindings.length > 1 && !call.isMethod) {
                        // Function-local classes/functions with the same name
                        // are distinct lexical bindings. Prefer the one whose
                        // enclosing function is the caller's enclosing
                        // function before module/same-class heuristics (Click
                        // defines TestContext/CustomContext independently in
                        // several tests in one file).
                        const callerSym = index.findEnclosingFunction(filePath, call.line, true);
                        const lexicalMatches = bindings.map(binding => {
                            const symbol = (index.symbols.get(call.name) || []).find(candidate =>
                                candidate.file === filePath &&
                                candidate.startLine === binding.startLine);
                            return { binding, symbol };
                        }).filter(({ symbol }) =>
                            symbol?.lexicalScopeStartLine != null &&
                            call.line >= symbol.lexicalScopeStartLine &&
                            call.line <= symbol.lexicalScopeEndLine)
                            .sort((a, b) =>
                                (a.symbol.lexicalScopeEndLine - a.symbol.lexicalScopeStartLine) -
                                (b.symbol.lexicalScopeEndLine - b.symbol.lexicalScopeStartLine));
                        const sameLexicalOwner = callerSym ? bindings.filter(b => {
                            const owner = index.findEnclosingFunction(filePath, b.startLine, true);
                            return owner && owner.file === callerSym.file &&
                                owner.startLine === callerSym.startLine;
                        }) : [];
                        if (lexicalMatches.length > 0) {
                            bindingId = lexicalMatches[0].binding.id;
                        } else if (sameLexicalOwner.length === 1) {
                            bindingId = sameLexicalOwner[0].id;
                        // For implicit same-class calls (Java: execute() means
                        // this.execute()), try the caller class next.
                        } else if (callerSym?.className) {
                            const callSymbols = index.symbols.get(call.name);
                            const sameClassSym = callSymbols?.find(s => s.className === callerSym.className);
                            if (sameClassSym) {
                                const matchingBinding = bindings.find(b => b.startLine === sameClassSym.startLine);
                                bindingId = matchingBinding?.id || sameClassSym.bindingId;
                            } else {
                                // Nested Java classes retain lexical access
                                // to static members of their enclosing type.
                                // Resolve that owner before admitting a
                                // project-wide ambiguous binding.
                                const callerClass = (index.symbols.get(callerSym.className) || [])
                                    .find(s => IDENTITY_TYPE_KINDS.has(s.type) &&
                                        s.file === filePath);
                                const outerOwner = fileEntry.language === 'java'
                                    ? callerClass?.enclosingType : null;
                                const outerSym = outerOwner && callSymbols?.find(s =>
                                    s.file === filePath && s.className === outerOwner &&
                                    !NON_CALLABLE_TYPES.has(s.type));
                                if (outerSym) {
                                    const matchingBinding = bindings.find(b =>
                                        b.startLine === outerSym.startLine);
                                    bindingId = matchingBinding?.id || outerSym.bindingId;
                                } else {
                                    isUncertain = true;
                                }
                            }
                        } else {
                            // Scope-based disambiguation for shadowed functions:
                            // When multiple bindings exist, use indent level to determine
                            // which binding is in scope at the call site
                            const defs = index.symbols.get(call.name);
                            let resolved = false;
                            if (defs) {
                                // Sort bindings by indent desc (most nested first)
                                const scopedBindings = bindings.map(b => {
                                    const sym = defs.find(s => s.startLine === b.startLine && s.file === filePath);
                                    return { ...b, indent: sym?.indent ?? 0, endLine: sym?.endLine ?? b.startLine };
                                }).sort((a, b) => b.indent - a.indent);

                                for (const sb of scopedBindings) {
                                    if (sb.indent === 0) {
                                        // Module-level binding — always in scope, use as fallback
                                        bindingId = sb.id;
                                        resolved = true;
                                        break;
                                    }
                                    // Nested binding — check if call is inside its enclosing function
                                    const enclosing = index.findEnclosingFunction(filePath, sb.startLine, true);
                                    if (enclosing && call.line >= enclosing.startLine && call.line <= enclosing.endLine) {
                                        // Call is inside the same function as this binding
                                        bindingId = sb.id;
                                        resolved = true;
                                        break;
                                    }
                                }
                            }
                            if (!resolved) isUncertain = true;
                        }
                    } else if (bindings.length > 1 && call.isMethod) {
                        // Multiple method bindings (e.g. Go String() on Reader vs Writer):
                        // Don't mark uncertain — include them even if conflated.
                        // Better to over-report than lose all callers.
                    }
                    // Method call with no binding for the method name (JS/TS/Python only):
                    // Mark uncertain unless receiver has binding evidence in file scope.
                    // Go/Java/Rust excluded: callers are used for impact analysis where
                    // over-reporting is preferred to losing callers. These languages' nominal
                    // type systems also make method links more reliable.
                    if (bindings.length === 0 && call.isMethod &&
                        langTraits(fileEntry.language)?.typeSystem === 'structural') {
                        const hasReceiverEvidence = call.receiver &&
                            (fileEntry.bindings || []).some(b => b.name === call.receiver);
                        if (!hasReceiverEvidence) {
                            isUncertain = true;
                        }
                    }
                }

                // Java's bare `method()` is an implicit `this.method()`.
                // If lexical binding lands on a base/interface declaration
                // while the pinned target is a descendant override, runtime
                // dispatch can reach that override. Keep the site visible as
                // possible-dispatch instead of excluding it as another def.
                if (collectAccount && bindingId && !call.isMethod && !call.receiver &&
                    langTraits(fileEntry.language)?.bareCallReachesMethods) {
                    const bound = (index.symbols.get(call.name) || [])
                        .find(s => s.bindingId === bindingId);
                    const tDefs = options.targetDefinitions || definitions;
                    const boundOwner = bound && (bound.className ||
                        (bound.receiver && bound.receiver.replace(/^\*/, '')));
                    const targetOwners = new Set(tDefs.map(d => d.className ||
                        (d.receiver && d.receiver.replace(/^\*/, ''))).filter(Boolean));
                    if (boundOwner && !targetOwners.has(boundOwner) &&
                        (_isAncestorOfTargetClass(index, boundOwner, tDefs) ||
                         _isDispatchAncestor(index, boundOwner, tDefs))) {
                        routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                            dispatchVia: boundOwner,
                        });
                        continue;
                    }
                }

                // Smart method call handling — do this BEFORE uncertain check so
                // self/this.method() calls can be resolved by same-class matching
                // even when binding is ambiguous (e.g. method exists in multiple classes)
                let resolvedBySameClass = false;
                // Python self.attr.method() resolved from __init__/field type
                // inference. It shares the routing precedence of same-class
                // resolution, but its evidence grade is receiver-hint, not
                // same-class (the receiver is the field's class).
                let resolvedByTypedAttribute = false;
                // Receiver/path type known to mismatch the target: such an edge can
                // never tier as confirmed even when legacy includeUncertain keeps it
                // visible (scoreEdge checks hasReceiverType before isUncertain, so
                // without this flag a known mismatch would score receiver-hint 0.80).
                let typeMismatch = false;
                // Structural languages: receiver-hint requires a VALIDATED match
                // (receiverType ∈ target class + subtypes). Ancestor-kept and
                // trust-gate-passed types fall back to import/scope evidence —
                // an unvalidated annotation must not upgrade the tier.
                let receiverTypeValidated = false;
                // Nominal local-inference match (receiver typed via
                // _buildTypedLocalTypeMap ∈ target types) — receiver evidence
                // for the dispatch tiering below.
                let nominalInferredMatch = false;
                // Identity discipline (fix #206): the receiver's type NAME
                // matches the target's type, but several distinct types share
                // that name and none is resolvable from this file's scope —
                // not confirmation evidence, not exclusion evidence. Routed
                // method-ambiguous under the account contract.
                let receiverTypeUnresolved = false;
                // C# extension invocation (`value.Ext(args)`) is a static
                // method call whose receiver occupies the declaration's
                // first `this` parameter. Receiver type plus namespace scope
                // identifies the extension owner; ordinary instance-method
                // routing would wrongly exclude it because, for example,
                // `string !== StringUtils`.
                let resolvedByExtensionMethod = false;
                if (call.isMethod && fileEntry.language === 'csharp') {
                    resolvedByExtensionMethod = _csharpExtensionCallMatches(
                        index,
                        filePath,
                        fileEntry,
                        call,
                        options.targetDefinitions || definitions);
                    if (resolvedByExtensionMethod) receiverTypeValidated = true;
                }
                // A static-imported FIELD shadows the capitalized static-
                // qualifier reading (fix #286c, jsoup-measured): javac binds
                // `BufferPool.borrow()` to the SoftPool-typed field imported
                // by `import static ...SimpleBufferedInput.BufferPool`, never
                // to a class named BufferPool. The declared type is compiler-
                // true — feed it to the normal nominal receiver physics.
                if (call.isMethod && !call.receiverType && call.receiver &&
                    fileEntry.language === 'java' && /^[A-Z]/.test(call.receiver)) {
                    const staticFieldType = _javaStaticImportedFieldType(
                        index, fileEntry, call.receiver);
                    if (staticFieldType) {
                        call = { ...call, receiverType: staticFieldType,
                            receiverIsTypeQualified: false };
                    }
                }
                if (collectAccount && call.isMethod && !call.receiverType &&
                    fileEntry.language === 'java' && /^[A-Z]/.test(call.receiver || '')) {
                    // Java permits inherited static methods to be invoked
                    // through a subclass qualifier. Resolve the complete
                    // receiver-owned overload family (subclass then parents)
                    // before receiver-name mismatch logic. This distinguishes
                    // TypeVariableName.get(Object.class) → inherited
                    // TypeName.get(Type) from the subclass's inapplicable get
                    // overloads.
                    const callerSymbol = index.findEnclosingFunction(filePath, call.line, true) ||
                        { file: filePath };
                    const qualifiedTargetDefs = options.targetDefinitions || definitions;
                    if (call.receiverIsTypeQualified) {
                        const targetOwners = new Set(qualifiedTargetDefs
                            .map(d => d.className).filter(Boolean));
                        const reachableOwners = new Set([call.receiver]);
                        const ownerQueue = [call.receiver];
                        while (ownerQueue.length > 0 && reachableOwners.size < 64) {
                            const owner = ownerQueue.shift();
                            for (const parent of index._getInheritanceParents?.(owner, filePath) || []) {
                                if (reachableOwners.has(parent)) continue;
                                reachableOwners.add(parent);
                                ownerQueue.push(parent);
                            }
                        }
                        if (![...targetOwners].some(owner => reachableOwners.has(owner))) {
                            // Preserve the caller-account mismatch taxonomy:
                            // if this call shape cannot invoke the pinned
                            // signature at all, arity is the narrower,
                            // surface-independent proof. Otherwise the
                            // explicit static owner is decisive.
                            const noPinnedArityFit = call.argCount != null &&
                                !call.argSpread &&
                                !_callArityCompatible(call, qualifiedTargetDefs,
                                    fileEntry.language);
                            recordExcluded(filePath, call.line,
                                noPinnedArityFit ? 'arity-mismatch' : 'receiver-other-class');
                            continue;
                        }
                    }
                    const qualified = _calleeTypeQualifiedReceiver(
                        index, callerSymbol, fileEntry, call, fileEntry.language);
                    if (qualified?.match) {
                        const targetKeys = new Set(qualifiedTargetDefs.map(d => d.bindingId ||
                            `${d.file}:${d.startLine}`));
                        const matchKey = qualified.match.bindingId ||
                            `${qualified.match.file}:${qualified.match.startLine}`;
                        if (targetKeys.has(matchKey)) {
                            bindingId = qualified.match.bindingId;
                            resolvedBySameClass = true;
                        } else {
                            recordExcluded(filePath, call.line, 'other-definition');
                            continue;
                        }
                    } else if (qualified?.unverified && !qualified.wrongArityOwner) {
                        // The qualifier may own several applicable overloads,
                        // yet the pinned overload can already be impossible by
                        // arity. Target-specific caller queries should exclude
                        // that proven sibling bind instead of inheriting the
                        // owner's broader ambiguity.
                        if (call.argCount != null && !call.argSpread &&
                            !_callArityCompatible(call, qualifiedTargetDefs,
                                fileEntry.language)) {
                            recordExcluded(filePath, call.line, 'overload-mismatch');
                            continue;
                        }
                        routeUnverified(filePath, fileEntry, call, qualified.unverified, calledAs);
                        continue;
                    }
                }
                if (call.isMethod) {
                    if (call.selfAttribute && fileEntry.language === 'python') {
                        // self.attr.method() — resolve via attribute type inference
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) {
                            // Can't resolve — include only if includeMethods requested
                            if (options.collectAccount || !options.includeMethods) {
                                if (call.receiverCapabilityGuard) {
                                    routeUnverified(filePath, fileEntry, call,
                                        'possible-dispatch', calledAs, {
                                            dispatchVia: `dynamic capability "${call.receiverCapabilityGuard}"`,
                                            dynamicCapability: true,
                                        });
                                } else {
                                    routeUnverified(filePath, fileEntry, call,
                                        'method-no-evidence', calledAs);
                                }
                                continue;
                            }
                        } else {
                            const attrTypes = getInstanceAttributeTypes(index, filePath, callerSymbol.className);
                            let targetClass = attrTypes?.get(call.selfAttribute);
                            if (!targetClass) {
                                targetClass = _declaredFieldType(
                                    index, callerSymbol.className,
                                    call.selfAttribute, 'python');
                            }
                            if (targetClass) {
                                targetClass = _pureAliasBase(index, targetClass) || targetClass;
                                const tDefs = options.targetDefinitions || definitions;
                                const compatibleTypes = dispatchTargetTypes(tDefs);
                                if (compatibleTypes.has(targetClass)) {
                                    resolvedBySameClass = true;
                                    resolvedByTypedAttribute = true;
                                } else if (_isAncestorOfTargetClass(index, targetClass, tDefs)) {
                                    // A field declared as a strict ancestor can
                                    // dynamically hold the pinned override.
                                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                        dispatchVia: targetClass,
                                    });
                                    continue;
                                } else if (_receiverTypeTrustedForExclusion(index, targetClass)) {
                                    // A builtin or unrelated concrete project
                                    // type is exact negative evidence. Earlier
                                    // code discarded this field contract and
                                    // emitted method-no-evidence.
                                    recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                                    continue;
                                } else if (options.collectAccount || !options.includeMethods) {
                                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                        dispatchVia: targetClass,
                                    });
                                    continue;
                                }
                            } else if (options.collectAccount || !options.includeMethods) {
                                if (call.receiverCapabilityGuard) {
                                    routeUnverified(filePath, fileEntry, call,
                                        'possible-dispatch', calledAs, {
                                            dispatchVia: `dynamic capability "${call.receiverCapabilityGuard}"`,
                                            dynamicCapability: true,
                                        });
                                } else {
                                    routeUnverified(filePath, fileEntry, call,
                                        'method-no-evidence', calledAs);
                                }
                                continue;
                            }
                        }
                    } else if (['self', 'cls', 'this', 'super', 'base'].includes(call.receiver) ||
                               (call.receiver === 'Self' && fileEntry.language === 'rust')) {
                        // self/this/super.method() — resolve to same-class or parent method.
                        // Rust `Self::method()` (fix #232) is the path-call same-class form:
                        // Self IS the enclosing impl's type, so the #202b pinning check
                        // confirms it for the impl's class and excludes it for a pinned
                        // sibling — it must never reach the uppercase path-receiver
                        // discipline below (which excluded it as path-type-mismatch
                        // whenever the method name had several project-wide owners).
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) {
                            if (options.collectAccount || !options.includeMethods) {
                                routeUnverified(filePath, fileEntry, call, 'method-no-evidence', calledAs);
                                continue;
                            }
                        } else {
                            // For super(), skip same-class — only check parent chain
                            const parentOnlyReceiver =
                                call.receiver === 'super' || call.receiver === 'base';
                            let matchedClass = !parentOnlyReceiver &&
                                definitions.some(d => d.className === callerSymbol.className)
                                ? callerSymbol.className : null;
                            // Walk inheritance chain using BFS if not found in same class
                            if (!matchedClass) {
                                const visited = new Set([callerSymbol.className]);
                                const callerFile = callerSymbol.file || filePath;
                                const startParents = index._getInheritanceParents(callerSymbol.className, callerFile) || [];
                                const queue = startParents.map(p => ({ name: p, contextFile: callerFile }));
                                while (queue.length > 0 && !matchedClass) {
                                    const { name: current, contextFile } = queue.shift();
                                    if (visited.has(current)) continue;
                                    visited.add(current);
                                    if (definitions.some(d => d.className === current)) matchedClass = current;
                                    if (!matchedClass) {
                                        const resolvedFile = index._resolveClassFile(current, contextFile);
                                        const grandparents = index._getInheritanceParents(current, resolvedFile) || [];
                                        for (const gp of grandparents) {
                                            if (!visited.has(gp)) queue.push({ name: gp, contextFile: resolvedFile });
                                        }
                                    }
                                }
                            }
                            if (matchedClass) {
                                // fix #202b: same-class resolution must land on the
                                // TARGET's class (or an ancestor — dynamic dispatch
                                // may run the target override). self.path() inside
                                // StandardImpl resolves to StandardImpl::path — not
                                // a caller of a pinned target Haystack::path.
                                // NOMINAL languages + Python: the exclusion is sound
                                // only when the inheritance graph is complete; TS
                                // hierarchies hide edges UCN can't see (zod's
                                // `declare class` merging — measured: the structural
                                // guard excluded true callers). Python's recorded
                                // bases are reliable, but MRO adds a trap nominal
                                // languages lack: `self.method()` inside Mixin can
                                // dispatch to a CO-PARENT's method through a common
                                // subclass (class C(Target, Mixin) — C's MRO finds
                                // Target.method before Mixin's). Exclusion therefore
                                // also requires that the matched class and the
                                // target's class share no project descendant.
                                const sameClassTraits = langTraits(fileEntry.language);
                                if (sameClassTraits?.typeSystem === 'nominal' ||
                                    fileEntry.language === 'python') {
                                    const tDefs = options.targetDefinitions || definitions;
                                    const targetClasses = new Set(tDefs.map(d => d.className).filter(Boolean));
                                    // `super` dispatches statically UP the chain — the
                                    // ancestor/descendant dynamic-dispatch exemptions
                                    // are inverted for it: a super call can never bind
                                    // a def below the matched parent (fix #238).
                                    const superSkipsExemptions = parentOnlyReceiver;
                                    if (!targetClasses.has(matchedClass) &&
                                        (superSkipsExemptions ||
                                         (!_isAncestorOfTargetClass(index, matchedClass, tDefs) &&
                                          !(fileEntry.language === 'python' &&
                                            _shareProjectDescendant(index, matchedClass, targetClasses))))) {
                                        recordExcluded(filePath, call.line, 'other-definition');
                                        continue;
                                    }
                                    // fix #218 (rich-measured): the match landed on
                                    // a STRICT ancestor of the pinned target's class
                                    // (or a Python co-parent via shared descendant) —
                                    // `self.render()` inside abstract ProgressColumn
                                    // lexically binds the ancestor's def; reaching the
                                    // pinned SUBCLASS override is dynamic dispatch,
                                    // possible but not confirmable (#204 physics).
                                    // Demote-only, account-gated; when the pinned
                                    // target IS the declaring class, matchedClass ∈
                                    // targetClasses and confirmation stands.
                                    if (collectAccount && !targetClasses.has(matchedClass)) {
                                        routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                            dispatchVia: matchedClass,
                                        });
                                        continue;
                                    }
                                } else if (collectAccount) {
                                    // fix #213 (JS/TS, zod seed-B-measured): the same
                                    // pinning check, but ROUTED visible instead of
                                    // excluded — `this.min()` inside ZodString lexically
                                    // binds ZodString.min or a subclass override, never
                                    // a pinned sibling ZodNumber.min (cross-sibling
                                    // spray was ~23 of 38 FP edges). Exclusion stays
                                    // off: TS `declare class` merging hides extends
                                    // edges, so an unrelated-looking class may still be
                                    // an ancestor (the original #202b structural revert).
                                    // Legacy keeps confirming (drop-vs-route asymmetry).
                                    const tDefs = options.targetDefinitions || definitions;
                                    const targetClasses = new Set(tDefs.map(d => d.className).filter(Boolean));
                                    // super: static upward dispatch — no ancestor/
                                    // descendant exemptions (fix #238), routed visible
                                    // like the rest of the #213 branch (TS declare-class
                                    // merging can hide the true parent edge).
                                    if (!targetClasses.has(matchedClass) &&
                                        (parentOnlyReceiver ||
                                         (!_isAncestorOfTargetClass(index, matchedClass, tDefs) &&
                                          !_shareProjectDescendant(index, matchedClass, targetClasses)))) {
                                        routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs);
                                        continue;
                                    }
                                }
                                resolvedBySameClass = true;
                            } else if (options.collectAccount || !options.includeMethods) {
                                routeUnverified(filePath, fileEntry, call, 'method-no-evidence', calledAs);
                                continue;
                            }
                        }
                    } else {
                        // Go doesn't use this/self/cls - always include Go method calls
                        // Java method calls are always obj.method() - include by default
                        // Rust Type::method() calls - include by default (associated functions)
                        // For other languages, skip method calls unless explicitly requested.
                        // Under collectAccount the gate falls through instead: receiver
                        // evidence computed at the push site decides the tier (a require'd
                        // module receiver earns scope-match/confirmed; an unknown receiver
                        // is marked uncertain in the binding block and routes below).
                        if (langTraits(fileEntry.language)?.methodCallInclusion === 'explicit' && !options.includeMethods) {
                            if (!collectAccount) continue;
                        }
                    }
                }

                // Declared-field receiver typing (fix #202, extended to
                // structural by fix #219): one-hop field receivers
                // (self.dent.path() / h.inner.Run() / this._map.has()) resolve
                // through the field's DECLARED type. Computed before binding
                // checks — name-bindings don't model receivers, so a same-file
                // `path` binding must not claim a call whose receiver field is
                // typed elsewhere. JS/TS `this`-rooted hops resolve their root
                // type here (the enclosing class — the parser's walk does not
                // track class context; arrows keep lexical `this`, and nested
                // function declarations are their own symbols WITHOUT
                // className, so dynamic-this shapes resolve to nothing).
                if (!call.receiverType && call.receiverRoot &&
                    call.receiverFields?.length && fileEntry.language === 'python') {
                    const builtinFieldType = _pythonBuiltinFieldPathType(
                        index, fileEntry, call.receiverRoot, call.receiverFields);
                    if (builtinFieldType) {
                        call = { ...call, receiverType: builtinFieldType,
                            receiverTypePlatform: true };
                    }
                }
                let fieldHopType = null;
                let fieldHopRootType = call.receiverRootType;
                if (!fieldHopRootType && call.receiverRoot) {
                    let flowMap = returnFlowCache.get(filePath);
                    if (flowMap === undefined) {
                        flowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                        returnFlowCache.set(filePath, flowMap);
                    }
                    const inferredRoot = flowMap && _lookupReturnTypeFlow(flowMap, {
                        ...call,
                        receiver: call.receiverRoot,
                    });
                    if (inferredRoot?.type) fieldHopRootType = inferredRoot.type;
                }
                // Go's parser preserves the package qualifier on a declared
                // root type (`r *http.Response; r.Body.Close()`). If that
                // qualifier is an unresolved external import, every field on
                // the root is owned outside this project. A unique local
                // method name is not identity evidence for the field value.
                if (fileEntry.language === 'go' && fieldHopRootType &&
                    call.receiverRootTypeQualifier && !call.receiverExternalFlow) {
                    const qualifier = call.receiverRootTypeQualifier;
                    const binding = (fileEntry.importBindings || [])
                        .find(item => item.name === qualifier);
                    const resolved = binding && fileEntry.moduleResolved?.[binding.module];
                    if (binding && !resolved) {
                        call = {
                            ...call,
                            receiverExternalFlow:
                                `${qualifier}.${fieldHopRootType}.${call.receiverField}`,
                            receiverExternalConcreteFlow: true,
                        };
                    }
                }
                if (!fieldHopRootType && call.receiverField && call.receiverRoot === 'this' &&
                    !resolvedBySameClass &&
                    (langTraits(fileEntry.language)?.typeSystem === 'structural' ||
                     fileEntry.language === 'csharp')) {
                    const hopEnclosing = index.findEnclosingFunction(filePath, call.line, true);
                    if (hopEnclosing?.className) fieldHopRootType = hopEnclosing.className;
                }
                if (call.isMethod && !call.receiverType && call.receiverField && fieldHopRootType &&
                    !resolvedBySameClass) {
                    const hopInfo = {};
                    fieldHopType = _declaredFieldPathType(index, fieldHopRootType,
                        call.receiverFields || [call.receiverField],
                        fileEntry.language, hopInfo,
                        call.receiverRootNamespace);
                    if (fieldHopType && hopInfo.fromFile &&
                        !call.receiverTypeFlowFile) {
                        call = {
                            ...call,
                            receiverTypeFlowFile: hopInfo.fromFile,
                            ...(hopInfo.namespace && {
                                receiverTypeNamespace: hopInfo.namespace,
                            }),
                        };
                    }
                    // Provably-external declared field type (fix #268,
                    // chi-measured: `inner http.Handler` on a pin named
                    // Handler elsewhere in the project) — rides the #220(6)
                    // external-flow rail: defeats single-owner confirmation,
                    // routes possible-dispatch, never excludes.
                    if (!fieldHopType && hopInfo.externalVia && !call.receiverExternalFlow) {
                        call = {
                            ...call,
                            receiverExternalFlow: hopInfo.externalVia,
                            ...(hopInfo.externalConcrete && {
                                receiverExternalConcreteFlow: true,
                            }),
                        };
                    }
                }
                if (!resolvedByExtensionMethod && fileEntry.language === 'csharp' &&
                    fieldHopType) {
                    resolvedByExtensionMethod = _csharpExtensionCallMatches(
                        index,
                        filePath,
                        fileEntry,
                        { ...call, receiverType: fieldHopType },
                        options.targetDefinitions || definitions);
                    if (resolvedByExtensionMethod) receiverTypeValidated = true;
                }
                if (fileEntry.language === 'csharp' &&
                    call.receiverIsTypeQualified && !fieldHopType &&
                    !resolvedByExtensionMethod) {
                    const callerSymbol = index.findEnclosingFunction(filePath, call.line, true) ||
                        { file: filePath };
                    const targetDefs = options.targetDefinitions || definitions;
                    const targetOwners = new Set(targetDefs
                        .map(definition => definition.className).filter(Boolean));
                    const receiverHasProjectType = (index.symbols.get(
                        call.receiver) || []).some(definition =>
                        IDENTITY_TYPE_KINDS.has(definition.type));
                    const reachableOwners = new Set([call.receiver]);
                    const ownerQueue = [call.receiver];
                    while (ownerQueue.length > 0 && reachableOwners.size < 64) {
                        const owner = ownerQueue.shift();
                        for (const parent of index._getInheritanceParents?.(
                            owner, filePath) || []) {
                            if (reachableOwners.has(parent)) continue;
                            reachableOwners.add(parent);
                            ownerQueue.push(parent);
                        }
                    }
                    if (receiverHasProjectType && targetOwners.size > 0 &&
                        ![...targetOwners].some(owner =>
                            reachableOwners.has(owner))) {
                        recordExcluded(filePath, call.line, 'receiver-other-class');
                        continue;
                    }
                    const qualified = _calleeTypeQualifiedReceiver(
                        index, callerSymbol, fileEntry, call, fileEntry.language);
                    if (qualified?.match) {
                        const targetKeys = new Set(targetDefs.map(definition =>
                            definition.bindingId ||
                            `${definition.file}:${definition.startLine}`));
                        const matchKey = qualified.match.bindingId ||
                            `${qualified.match.file}:${qualified.match.startLine}`;
                        if (!targetKeys.has(matchKey)) {
                            recordExcluded(filePath, call.line, 'other-definition');
                            continue;
                        }
                        bindingId = qualified.match.bindingId;
                        resolvedBySameClass = true;
                    } else if (qualified?.external) {
                        recordExcluded(filePath, call.line, 'external-package');
                        continue;
                    } else if (qualified?.unverified) {
                        routeUnverified(
                            filePath, fileEntry, call,
                            qualified.unverified, calledAs);
                        continue;
                    }
                }
                // Dispatch attribution (contract surface only): a field DECLARED
                // as a project interface/trait carries no exclusion evidence
                // (_declaredFieldType returns null — any implementor may receive
                // the call), but it IS positive evidence of possible dispatch.
                // Resolved separately so the unverified tier can attribute the
                // edge: "possible-dispatch via <Interface> — 1 of N impls".
                let fieldDispatchType = null;
                if (collectAccount && fieldHopType === null &&
                    call.isMethod && !call.receiverType && call.receiverField && fieldHopRootType &&
                    !resolvedBySameClass) {
                    const fields = call.receiverFields || [call.receiverField];
                    if (fields.length === 1) {
                        fieldDispatchType = _declaredFieldInterfaceType(index, fieldHopRootType,
                            call.receiverField, fileEntry.language, call.receiverRootNamespace);
                    }
                }

                // Resolve this before the generic untyped-field guard below:
                // `api.nested.run()` is syntactically a field receiver, but an
                // exported namespace chain can make both hops compiler-exact.
                const recvExportedNamespace = (!call.receiverIsModule && call.isMethod &&
                    (call.receiver || call.receiverRoot) &&
                    structuralLanguage)
                    ? _importedNamespaceMemberOwnership(
                        index, fileEntry, call, targetDefinitionFiles)
                    : null;

                // Go package-owned value receiver (`io.Discard.Write`). The
                // imported package owns `Discard`; file/package method-name
                // bindings cannot identify its concrete type. Keep the edge
                // visible and defeat every global same-name confirmation.
                if (collectAccount && fileEntry.language === 'go' &&
                    call.receiverRootIsModule) {
                    const qualified = _goQualifiedReceiverType(
                        index, fileEntry, call.receiverRoot, call.receiverField);
                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                        dispatchVia: qualified?.via || `${call.receiverRoot}.${call.receiverField}`,
                        ...(qualified?.kind !== 'project' && { externalContract: true }),
                    });
                    continue;
                }

                // A structural field path with neither a typed root nor a
                // resolvable declared-field contract is not receiver
                // evidence. Keep `client.req.query()` visible instead of
                // allowing a same-file `query` definition to claim it.
                if (collectAccount && call.isMethod && call.receiverField &&
                    !call.receiverType && !fieldHopType && !fieldDispatchType &&
                    !resolvedBySameClass && !recvExportedNamespace &&
                    ['javascript', 'typescript', 'tsx', 'html'].includes(
                        fileEntry.language)) {
                    routeUnverified(
                        filePath, fileEntry, call, 'method-ambiguous', calledAs);
                    continue;
                }

                if (fileEntry.language === 'cpp' &&
                    !call.isMethod && !call.receiver && !call.isPathCall) {
                    const cppTargets = options.targetDefinitions || definitions;
                    if (cppTargets.some(definition => definition.className)) {
                        const enclosing = index.findEnclosingFunction(
                            filePath, call.line, true);
                        const targetOwners = new Set(cppTargets
                            .map(definition => definition.className)
                            .filter(Boolean));
                        const enclosingOwner = enclosing?.className;
                        const ownerCanReachTarget = enclosingOwner &&
                            (targetOwners.has(enclosingOwner) ||
                             _isAncestorOfTargetClass(
                                 index, enclosingOwner, cppTargets));
                        if (!ownerCanReachTarget) {
                            recordExcluded(filePath, call.line,
                                'method-kind-mismatch');
                            continue;
                        }
                    }
                }

                // Skip uncertain calls unless resolved by same-class matching or
                // explicitly requested. A declared-field hop type (fix #219) or
                // interface-field dispatch type IS receiver evidence — those
                // calls flow to the receiver-class disambiguation below, which
                // confirms (receiver-hint), excludes (mismatch), or attributes
                // possible-dispatch. Before fix #229 this gate fired first
                // whenever the method name had no same-file binding, so the
                // tier of `this.logger.info()` depended on file LAYOUT (same
                // file confirmed, cross-file routed method-no-evidence).
                // A parser-typed receiver defers too (fix #232): `b?.ping()`
                // carries the optionality `uncertain` flag AND receiverType 'A'
                // — the ?. is a null guard, not evidence uncertainty, so the
                // record gets plain-call physics (validated match confirms,
                // trusted mismatch excludes). Bare `foo?.()` has no receiver
                // evidence and keeps routing here.
                if (isUncertain && !resolvedBySameClass && !options.includeUncertain &&
                    !fieldHopType && !fieldDispatchType && !call.receiverType) {
                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                    routeUnverified(filePath, fileEntry, call,
                        call.isMethod ? 'method-no-evidence' : 'ambiguous-binding', calledAs);
                    continue;
                }

                // Call records come from call-expression AST nodes, never
                // declaration-name nodes. Do not discard a call merely
                // because its source line also starts a definition:
                // `func Set(k string, v any) { global.Set(k, v) }` is a real
                // wrapper edge on the definition line. The account already
                // classifies the declaration token separately.

                // If we have a binding id on definition, require match when available
                // When targetDefinitions is provided, only those definitions' bindings are valid targets
                const targetDefs = options.targetDefinitions || definitions;
                const targetBindingIds = new Set(targetDefs.map(d => d.bindingId).filter(Boolean));
                if (targetBindingIds.size > 0 && bindingId && !targetBindingIds.has(bindingId)) {
                    // fix #202: a declared-field receiver type that VALIDATES
                    // against the target overrides name-binding evidence —
                    // self.dent.path() name-binds to a same-file `path` def,
                    // but the field's declared type says the call is the
                    // target's (receiver-typed edges fall through to the
                    // receiver-class disambiguation below).
                    const fieldHopMatchesTarget = fieldHopType && targetDefs.some(d =>
                        (d.className || (d.receiver || '').replace(/^\*/, '')) === fieldHopType);
                    // Java arity-overload groups are ONE bindable name (fix
                    // #268, javapoet-measured): the bare delegation
                    // `defaultValue(Code.of(...))` inside Builder name-bound
                    // the same-class FIELD (or the sibling overload) and was
                    // excluded other-definition — a false zero-caller answer.
                    // When the resolved binding's def sits in the pin's
                    // same-class callable overload family, binding identity
                    // proves nothing; the #205 overload discipline below
                    // adjudicates (fits/sibling/ambiguous). Fields never
                    // receive Java calls (separate namespaces), so a
                    // field-binding hit is treated the same way.
                    let overloadGroupBinding = false;
                    const boundDefinition = definitions.find(definition =>
                        definition.bindingId === bindingId);
                    if (collectAccount && fileEntry.language === 'cpp' &&
                        _cppExternalLinkVariant(
                            boundDefinition, targetDefs)) {
                        // One driver/prototype can be linked against several
                        // extern-C implementations in separate executable
                        // targets (libFuzzer's LLVMFuzzerTestOneInput is the
                        // canonical shape). The source binding identifies the
                        // shared external-linkage slot, not which build
                        // variant supplies it. Keep the dependency visible as
                        // compile-time dispatch instead of excluding every
                        // implementation except the prototype record.
                        routeUnverified(
                            filePath, fileEntry, call, 'link-variant', calledAs, {
                                uncertaintyClass: 'compile-time-dispatch',
                                dispatchFamily:
                                    `${name} external-linkage implementations`,
                            });
                        continue;
                    }
                    if (!fieldHopMatchesTarget &&
                        langTraits(fileEntry.language)?.hasArityOverloads &&
                        (!call.receiver ||
                         (fileEntry.language === 'cpp' && call.isPathCall &&
                          targetDefs.every(d => !d.className && !d.receiver)))) {
                        const boundDef = boundDefinition;
                        overloadGroupBinding = !!(boundDef && (
                            (boundDef.className && targetDefs.some(d => {
                                if (d.className === boundDef.className &&
                                    d.file === boundDef.file) {
                                    return true;
                                }
                                const inherited = _isAncestorOfTargetClass(
                                    index, d.className, [boundDef]);
                                // A derived same-name method hides inherited
                                // overloads until it proves inapplicable.
                                // Receiver-blind bindings may therefore be
                                // overruled only when static argument evidence
                                // accepts this inherited target and rejects the
                                // derived declaration.
                                return inherited &&
                                    _overloadApplicable(index, call, d) &&
                                    !_overloadApplicable(index, call, boundDef);
                            })) ||
                            (fileEntry.language === 'cpp' &&
                             !boundDef.className && !boundDef.receiver &&
                             targetDefs.every(d => !d.className && !d.receiver) &&
                             _cppTargetVisibleFrom(index, filePath, targetDefs))));
                    }
                    // A validated self.attr receiver is the Python analogue
                    // of a declared-field hop: the binding table only knows
                    // the terminal name and may bind `self._live.update()` to
                    // the enclosing class's `update`. Receiver type evidence
                    // is stronger and must outrank that receiver-blind name
                    // binding (rich Status._live -> Live, measured).
                    if (!fieldHopMatchesTarget && !resolvedBySameClass && !overloadGroupBinding) {
                        recordExcluded(filePath, call.line, 'other-definition');
                        continue;
                    }
                    // The mismatched binding was explicitly overruled by
                    // stronger receiver/overload evidence. Do not carry it
                    // forward as an "exact-binding" score: it identifies a
                    // different definition. The surviving edge must be scored
                    // from the evidence that actually justified it.
                    bindingId = null;
                    if (overloadGroupBinding) resolvedBySameClass = true;
                }

                // C++ header visibility is compiler-grade negative evidence:
                // a namespace-qualified free-function overload cannot bind a
                // declaration from a header outside the caller's complete
                // resolved include closure. This is the native analogue of
                // module/name ownership (#209/#217) and prevents every
                // `fmt::format` spelling in a repository from becoming a
                // review candidate for every independently included overload.
                // Source-only definitions are exempt (their visible header
                // redeclaration may be a distinct indexed record), and any
                // unresolved project-like include keeps the verdict unknown.
                if (collectAccount && fileEntry.language === 'cpp' &&
                    targetDefs.length > 0 &&
                    targetDefs.every(definition =>
                        !definition.className && !definition.receiver &&
                        _isCppHeader(definition.file)) &&
                    _cppTargetVisibility(index, filePath, targetDefs) === 'no') {
                    recordExcluded(filePath, call.line, 'target-not-visible');
                    continue;
                }

                // Name-level import shadowing (fix #209, httpx-measured): an
                // explicit import binding of the NAME rebinds it for the whole
                // file — `from urllib.parse import unquote` makes every bare
                // `unquote(...)` urllib's, regardless of which project files
                // this file also imports (file-level import edges are not
                // name-level evidence; httpx/_urls.py imports ._utils for
                // OTHER names while unquote comes from urllib). A bare call
                // only reaches the project def when SOME import binding of the
                // name resolves to a target file (directly or one barrel hop),
                // or the target is defined in this file. Mis-resolved project
                // modules must not exclude: a binding to an unresolved module
                // whose first segment matches a project directory routes
                // visible instead.
                if (!bindingId && !call.isMethod &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    (fileEntry.importBindings || []).length > 0) {
                    // Renamed destructures look up by the RESOLVED name (fix
                    // #269, fastify-measured): `const { validate:
                    // validateSchema } = require('./validation')` stores the
                    // binding under 'validate' while the record's name is the
                    // local alias — the empty lookup skipped the whole
                    // ownership chase and the call scope-confirmed against
                    // hooks.js's unrelated validate.
                    const lookupName = call.resolvedName || call.name;
                    // Alias-matched surfaces (calledAs — import/export renames)
                    // spell the call by the LOCAL alias while importBindings
                    // store the ORIGINAL name: `import { _gt as gt }` binds
                    // name '_gt' with alias 'gt'. Match the alias side too so
                    // the #217 chase adjudicates the rename by NAME (borrowed
                    // renames still exclude other-definition-import) instead
                    // of the empty lookup excluding every legitimate renamed
                    // call as name-not-in-scope.
                    let nameBindings = fileEntry.importBindings.filter(b =>
                        b.name === lookupName ||
                        (calledAs && b.alias === lookupName));
                    // Python bindings carry no alias field — the pairing
                    // lives in fileEntry.importAliases ({original, local});
                    // map the alias back to its original's binding so the
                    // chase adjudicates `from lib import transform as t`.
                    if (calledAs && nameBindings.length === 0 &&
                        (fileEntry.importAliases || []).length > 0) {
                        const originals = new Set(fileEntry.importAliases
                            .filter(a => a && a.local === lookupName && a.original)
                            .map(a => a.original));
                        if (originals.size > 0) {
                            nameBindings = fileEntry.importBindings.filter(b =>
                                originals.has(b.name));
                        }
                    }
                    // Exact alias pairing (fix #269): two renames of one
                    // source name from DIFFERENT modules — the record's local
                    // alias (call.name) picks its own binding; source-name
                    // matching alone over-follows into the other module.
                    if (call.resolvedName && nameBindings.some(b => b.alias)) {
                        const paired = nameBindings.filter(b => b.alias === call.name);
                        if (paired.length > 0) nameBindings = paired;
                    }
                    const tFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                    // fix #215 (rich-measured: 225 builtin `print(...)` calls
                    // confirmed against rich's def via file-level import edges):
                    // a bare name in a module file resolves to a local binding,
                    // an import binding of THAT name, or a builtin/global — it
                    // can never reach an unimported project def. No local
                    // binding (bindingId), no import binding of the name, no
                    // star import that could inject it → the call provably
                    // does not denote the target. Same correctness family as
                    // the all-external shadow exclusion below; the
                    // importBindings.length precondition keeps script files
                    // (no module discipline) out.
                    // `resolvedName` means the parser already resolved a local
                    // alias to the original through a real import binding
                    // (`const { parse: csvParse } = require(...)`) — name-level
                    // evidence by construction; importBindings store the
                    // ORIGINAL name, so the local alias must not look unbound.
                    if (nameBindings.length === 0 && !call.resolvedName &&
                        tFiles.size > 0 && !tFiles.has(filePath) &&
                        !(fileEntry.importNames || []).includes('*')) {
                        recordExcluded(filePath, call.line, 'name-not-in-scope');
                        continue;
                    }
                    // A same-file pin does not put a bare name in scope when
                    // every pinned def is class-scoped (fix #222, rich-measured):
                    // the class member is outside the bare-name lookup chain,
                    // so the file's import bindings own the name.
                    const samefilePinsOutOfScope = targetDefs.length > 0 &&
                        targetDefs.every(d => d.className);
                    if (nameBindings.length > 0 && (!tFiles.has(filePath) || samefilePinsOutOfScope)) {
                        // Name-level export-chain ownership (fix #217): each
                        // binding is chased by NAME, not by file — `from
                        // .render import render` pins to tests/render.py's own
                        // def and cannot denote markup.render no matter what
                        // tests/render.py imports (file-level reach said yes
                        // through console.py — 24 rich FP edges). Exclusion
                        // requires EVERY binding to be a definitive dead end:
                        // external pins (#209c) or chains that provably
                        // terminate away from the targets; any un-modelable
                        // surface (CJS, star imports, module assignments,
                        // resolver gaps) routes 'unknown' and blocks exclusion.
                        let reaches = false;
                        let undetermined = false;
                        for (const b of nameBindings) {
                            const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[b.module];
                            if (!rel) {
                                // Unresolved module: external — unless it is
                                // relative (project-internal by construction)
                                // or its first segment names a project path
                                // (resolution gap, not externality evidence)
                                const mod = String(b.module);
                                const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                                if (mod.startsWith('.') ||
                                    (firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                                    undetermined = true;
                                }
                                continue;
                            }
                            const resolvedAbs = path.join(index.root, rel);
                            const verdict = b.defaultLike
                                ? _defaultBindingReaches(index, resolvedAbs, tFiles)
                                : _nameBindingReaches(index, resolvedAbs, b.name, tFiles);
                            if (verdict === 'yes') { reaches = true; break; }
                            if (verdict === 'unknown') undetermined = true;
                        }
                        if (!reaches && !undetermined) {
                            // Every import binding of this name pins away from
                            // the pinned targets (external module, or a project
                            // def the name-chase resolved with certainty) — the
                            // bare name is rebound away from the target
                            // (compiler-checked module semantics).
                            recordExcluded(filePath, call.line, 'other-definition-import');
                            continue;
                        }
                        // Paired-rename records (fix #269, fastify-measured):
                        // `{ validate: validateSchema } = require('./validation')`
                        // pins the alias to ONE module. An un-modelable chain
                        // (CJS export surface) blocks exclusion but is not
                        // confirmation evidence either — the call routes
                        // visible instead of scope-confirming a pin its own
                        // module never provably reaches (hooks.js's unrelated
                        // validate confirmed at scope-match 0.65).
                        if (!reaches && undetermined && collectAccount &&
                            call.resolvedName && nameBindings.length > 0 &&
                            nameBindings.every(b => b.alias === call.name)) {
                            routeUnverified(filePath, fileEntry, call, 'ambiguous-binding', calledAs);
                            continue;
                        }
                    }
                }

                // Import-graph disambiguation for JS/TS/Python: when multiple definitions of
                // the same name exist and this call has no bindingId, check whether the calling
                // file imports from the target definition's file. Skips false positives like
                // user_b importing from b.js being reported as a caller of a.js:process.
                // Go/Java/Rust are excluded — they use package/module scoping, not file imports.
                if (!bindingId && !call.isMethod && options.targetDefinitions && definitions.length > 1 &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const targetFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                    if (targetFiles.size > 0 && !targetFiles.has(filePath)) {
                        const imports = index.importGraph.get(filePath);
                        const importsTarget = imports && setSome(imports, imp => targetFiles.has(imp));
                        if (!importsTarget) {
                            // Check one level of re-exports (barrel files)
                            let foundViaReexport = false;
                            if (imports) for (const imp of imports) {
                                const transImports = index.importGraph.get(imp);
                                if (transImports && setSome(transImports, ti => targetFiles.has(ti))) {
                                    foundViaReexport = true;
                                    break;
                                }
                            }
                            if (!foundViaReexport) {
                                // Disposition depends on what the caller DOES import:
                                //  - imports a DIFFERENT same-name def's file → positive
                                //    mis-link evidence → excluded other-definition-import
                                //  - imports neither def → pure ambiguity, no positive
                                //    evidence → unverified tier (visible), per the contract
                                const otherDefFiles = new Set((index.symbols.get(name) || [])
                                    .map(d => d.file).filter(f => f && !targetFiles.has(f)));
                                const importsOtherDef = imports && setSome(imports, imp => otherDefFiles.has(imp));
                                if (importsOtherDef || otherDefFiles.has(filePath)) {
                                    recordExcluded(filePath, call.line, 'other-definition-import');
                                    continue;
                                }
                                if (collectAccount) {
                                    routeUnverified(filePath, fileEntry, call, 'no-import-link', calledAs);
                                    continue;
                                }
                                continue;
                            }
                        }
                    }
                }

                // Go unexported visibility: lowercase functions are package-private.
                // Only allow callers from the same package directory.
                if (langTraits(fileEntry.language)?.exportVisibility === 'capitalization' && /^[a-z]/.test(name)) {
                    const targetPkgDirs = new Set(
                        targetDefs.filter(d => d.file).map(d => path.dirname(d.file))
                    );
                    if (targetPkgDirs.size > 0 && !targetPkgDirs.has(path.dirname(filePath))) {
                        recordExcluded(filePath, call.line, 'out-of-scope-package');
                        continue;
                    }
                }

                // Go/Java/Rust: method vs non-method cross-matching filter.
                // Prevents t.Errorf() (method call) from matching standalone func Errorf,
                // and cli.Run() (package call, isMethod:false) from matching DeploymentController.Run.
                // Rust path calls (module::func(), Type::new()) bypass this filter — they're
                // scoped_identifier calls that can target both standalone functions and impl methods.
                // The binding guard is per-direction (fix #220): a name binding
                // is receiver-blind, so it cannot make x.f() reach a standalone
                // function in languages whose dot-calls provably never do (Rust
                // needs (s.f)() parens — ripgrep's `.preprocessor_globs(...)`
                // bound the same-file FUNCTION def). Go keeps !bindingId there:
                // func-typed fields ARE name-callable. The bare-call direction
                // keeps !bindingId — the upstream binding filter already
                // re-resolves those to function defs where methods are
                // unreachable.
                const cppTypeQualifiedPath = fileEntry.language === 'cpp' &&
                    call.isPathCall &&
                    _cppPathReceiverNamesType(index, call.receiver);
                const cppTargetHasClass = fileEntry.language === 'cpp' &&
                    targetDefs.some(definition => definition.className);
                if (fileEntry.language === 'cpp' && cppTargetHasClass &&
                    call.isPathCall && !cppTypeQualifiedPath) {
                    // `detail::write(...)` is a namespace free-function call.
                    // A namespace path cannot denote `file::write`, even
                    // though both use C++'s qualified_identifier AST shape.
                    recordExcluded(filePath, call.line,
                        'method-kind-mismatch');
                    continue;
                }
                if (fileEntry.language === 'cpp' && cppTargetHasClass &&
                    !call.isMethod && !call.receiver && !call.isPathCall) {
                    // A bare C++ member call is implicit-this lookup and only
                    // exists inside the target owner (or a derived class).
                    // At namespace scope or in an unrelated class, the same
                    // spelling can only name a free function/macro result.
                    const enclosing = index.findEnclosingFunction(
                        filePath, call.line, true);
                    const targetOwners = new Set(targetDefs
                        .map(definition => definition.className)
                        .filter(Boolean));
                    const enclosingOwner = enclosing?.className;
                    const ownerCanReachTarget = enclosingOwner &&
                        ([...targetOwners].includes(enclosingOwner) ||
                         _isAncestorOfTargetClass(
                             index, enclosingOwner, targetDefs));
                    if (!ownerCanReachTarget) {
                        recordExcluded(filePath, call.line,
                            'method-kind-mismatch');
                        continue;
                    }
                }
                if ((!bindingId || (call.isMethod &&
                        !langTraits(fileEntry.language)?.methodCallReachesFunctions)) &&
                    !resolvedBySameClass &&
                    (!call.isPathCall || cppTypeQualifiedPath) &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    if (call.globalQualified &&
                        targetDefs.length > 0 &&
                        targetDefs.every(d => d.className || d.receiver)) {
                        recordExcluded(filePath, call.line, 'global-qualified');
                        continue;
                    }
                    const targetHasClass = targetDefs.some(d => d.className);
                    if (call.isMethod && !targetHasClass) {
                        // Method call but target is a standalone function — skip
                        recordExcluded(filePath, call.line, 'method-kind-mismatch');
                        continue;
                    }
                    if (!call.isMethod && targetHasClass &&
                        !(!call.receiver && langTraits(fileEntry.language)?.bareCallReachesMethods)) {
                        // Non-method call but target is a class method — skip.
                        // Bare-call direction honors bareCallReachesMethods
                        // (fix #229, same as the callback-path twin): a Java
                        // bare call CAN denote a method — static imports
                        // (`import static app.U.twice; twice(21)`) and
                        // inherited implicit this-calls. Package-qualified
                        // calls (receiver set) keep the exclusion.
                        recordExcluded(filePath, call.line, 'method-kind-mismatch');
                        continue;
                    }
                }

                // From-import submodule receiver (fix #224): `from . import
                // jobs` + `jobs.submit(...)` — the receiver resolves to a
                // project module FILE (graph-build composed the submodule
                // specifier), so it behaves as a module receiver below.
                // Confirm/route-enabling only: the class-method exclusion
                // branch keeps its parser-marked receiverIsModule condition
                // (a rare package attribute/submodule name collision must not
                // become exclusion evidence).
                const recvSubmoduleRel = (!call.receiverIsModule && call.isMethod && call.receiver &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural')
                    ? _submoduleReceiverModule(index, fileEntry, call.receiver) : null;
                // A named/default import can itself be an exported namespace
                // object: `import { z } from './index'; z.string()`, where
                // index does `import * as z from './api'; export { z }`.
                // Preserve that compiler-exact namespace identity without
                // treating arbitrary imported object values as modules.

                // Module receiver: httpx.get() / ns.helper() dispatches to a
                // module export — it can never be a CLASS METHOD call. Applies
                // only when every target is a class method; standalone-function
                // and class (constructor) targets keep flowing on import evidence.
                if ((!bindingId || recvExportedNamespace) && !resolvedBySameClass && call.isMethod &&
                    (call.receiverIsModule || recvExportedNamespace) &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    targetDefs.length > 0 && targetDefs.every(d => d.className)) {
                    isUncertain = true;
                    typeMismatch = true;
                    if (collectAccount) {
                        recordExcluded(filePath, call.line, 'module-receiver');
                        continue;
                    }
                    if (!options.includeUncertain) {
                        if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                        continue;
                    }
                }

                // Module-qualified ownership, structural (fix #209 — the #206
                // Go rule transferred): `httpcore.URL(...)` denotes URL IN the
                // httpcore module — an EXTERNAL module's attribute can never be
                // the project's URL class. Resolve the receiver's own import
                // binding (name-level — the file importing the target for
                // other names proves nothing): binding module external →
                // excluded; resolves to a project file that doesn't reach a
                // target by a definitive name-level `no` → excluded as another
                // definition; an unknown chain stays visible (deep barrels and
                // dynamic CJS surfaces can exceed the modeled ownership);
                // unresolved-but-project-looking → visible (resolver gap).
                if ((!bindingId || recvExportedNamespace) && !resolvedBySameClass && call.isMethod &&
                    (call.receiverIsModule || recvSubmoduleRel || recvExportedNamespace) &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const recvBindings = recvExportedNamespace
                        ? [] : _structuralModuleBindings(fileEntry, call);
                    const tFiles = targetDefinitionFiles;
                    // Same-file targets get NO bypass (fix #294, flask-measured:
                    // `import json as _json; _json.dump(...)` in the file
                    // defining flask's own `dump` confirmed a self-recursive
                    // caller — the module indirection REPLACES file scope, so
                    // ownership adjudicates regardless of where the pin sits;
                    // the Go twin already excludes same-file package-qualified
                    // targets). A self-module import stays confirmable: a
                    // binding resolving into a target file reaches immediately.
                    if (recvBindings.length > 0 || recvExportedNamespace) {
                        let reaches = recvExportedNamespace?.verdict === 'yes';
                        let projectish = !!recvExportedNamespace;
                        let undetermined = recvExportedNamespace?.verdict === 'unknown';
                        let resolvedBindings = recvExportedNamespace ? 1 : 0;
                        let definitiveOtherBindings = recvExportedNamespace?.verdict === 'no' ? 1 : 0;
                        for (const b of recvBindings) {
                            // A #224-proven submodule receiver chases from the
                            // SUBMODULE file, never the from-module (fix #294b,
                            // flask fresh-arm-measured: `from . import cli;
                            // cli.AppGroup()` chased flask/__init__.py — where
                            // 'AppGroup' dead-ends — because moduleResolved['.']
                            // shadowed the composed '.cli' spec, excluding a
                            // compiler-true constructor edge other-definition-
                            // import. Python binds the submodule OBJECT; its
                            // attributes live in the submodule file.
                            const rel = recvSubmoduleRel ||
                                (fileEntry.moduleResolved && fileEntry.moduleResolved[b.module]);
                            if (!rel) {
                                const mod = String(b.module);
                                const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                                if (mod.startsWith('.') ||
                                    (firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                                    projectish = true;
                                    undetermined = true;
                                }
                                continue;
                            }
                            projectish = true;
                            resolvedBindings++;
                            const resolvedAbs = path.join(index.root, rel);
                            // Name-level ownership (fix #217 applied to module
                            // receivers — zod family D): `z._default(...)` asks
                            // for the MODULE's `_default` attribute; with three
                            // project defs of the name, only the one the export
                            // chain actually exposes can be the callee. The
                            // chase is definitive only on fully-modeled ESM/
                            // Python surfaces — 'unknown' (CJS, stars, module
                            // assignments) falls back to file-level reach.
                            const ambiguousCjsMember =
                                _cjsMemberOwnershipAmbiguous(index, resolvedAbs, call.name);
                            const verdict = ambiguousCjsMember
                                ? 'unknown'
                                : _nameBindingReaches(index, resolvedAbs, call.name, tFiles);
                            if (verdict === 'yes' ||
                                (verdict === 'unknown' && !ambiguousCjsMember &&
                                 _importReaches(index, resolvedAbs, tFiles))) {
                                reaches = true; break;
                            }
                            if (verdict === 'no') definitiveOtherBindings++;
                            else undetermined = true;
                        }
                        if (!reaches) {
                            if (!projectish) {
                                recordExcluded(filePath, call.line, 'external-package');
                                continue;
                            }
                            if (!undetermined && resolvedBindings > 0 &&
                                definitiveOtherBindings === resolvedBindings) {
                                recordExcluded(filePath, call.line, 'other-definition-import');
                                continue;
                            }
                            if (collectAccount) {
                                routeUnverified(filePath, fileEntry, call, 'no-import-link', calledAs);
                                continue;
                            }
                        }
                        if (reaches) {
                            // The module's name-level export chain owns this
                            // exact call. Preserve that proof through scoring;
                            // file-level import evidence alone is not enough for
                            // a method-shaped module access.
                            call = { ...call, moduleOwnedPath: true };
                        }
                    }
                }

                // Structural typed-receiver kind filter: a method call on a
                // receiver with a known class type can only target that class's
                // methods — never a standalone function. Module receivers are
                // never typed (localVarTypes only types constructor results,
                // annotations, and literals), so module-qualified calls to
                // standalone functions keep flowing on import evidence. Class
                // targets are exempt: their own type matching runs below.
                // Trust gate: only builtin/project-class types are positive
                // evidence — an alias/interface annotation can wrap the target
                // (`const x: Fetcher = { fetch }`), so it must not exclude.
                if (!bindingId && !resolvedBySameClass && call.isMethod && call.receiverType &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    _receiverTypeTrustedForExclusion(index, call.receiverType) &&
                    !targetDefs.some(d => d.className || d.receiver || NON_CALLABLE_TYPES.has(d.type))) {
                    isUncertain = true;
                    typeMismatch = true;
                    if (collectAccount) {
                        recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                        continue;
                    }
                    if (!options.includeUncertain) {
                        if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                        continue;
                    }
                }

                // Go package-qualified call filter: when a non-method call has a receiver
                // that is an import alias (e.g., fmt.Errorf()), verify the caller imports
                // a project file containing the target. Catches stdlib (single-segment imports
                // like "fmt", "os") and third-party calls (import graph has no edge to target).
                if (!call.isMethod && call.receiver && !bindingId &&
                    langTraits(fileEntry.language)?.hasReceiverPackageCalls) {
                    const pkgRes = _receiverPackageResolution(index, fileEntry, call.receiver, targetDefs);
                    if (pkgRes) {
                        if (pkgRes.singleSegment) {
                            // Single-segment import — Go stdlib, always external
                            recordExcluded(filePath, call.line, 'external-package');
                            continue;
                        }
                        // A package-qualified name can never denote the
                        // caller's own FILE's package (Go cannot self-import):
                        // a pinned target defined only in this very file is
                        // positively a different symbol — measured:
                        // &certprovider.KeyMaterial{...} inside KeyMaterial()
                        // claiming a self-edge through a local binding.
                        if (targetDefs.length > 0 && targetDefs.every(d => d.file === filePath)) {
                            recordExcluded(filePath, call.line, 'other-definition');
                            continue;
                        }
                        // Receiver-package identity (fix #206b): an import edge
                        // to the target's file proves the caller USES the
                        // target's package, not that THIS qualified name
                        // resolves there. The qualified name denotes a symbol
                        // in the RECEIVER's module — the target must live in
                        // that module's package (project-relative module-path
                        // suffix, or conventional package-segment match).
                        // grpc-go measured: `&v3corepb.Locality{...}` (aliased
                        // EXTERNAL envoy proto) and `xdsresource.Locality{...}`
                        // confirmed for clients.Locality because the caller
                        // also imported clients/config.go.
                        if (!pkgRes.targetInPkg) {
                            recordExcluded(filePath, call.line, 'other-definition');
                            continue;
                        }
                        // Multi-segment import — verify via import graph
                        const callerImportedFiles = index.importGraph.get(filePath);
                        const targetFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                        if (!targetFiles.has(filePath)) {
                            const hasImportEdge = callerImportedFiles && setSome(callerImportedFiles, imp => targetFiles.has(imp));
                            if (!hasImportEdge) {
                                // No import edge — allow same-package (same directory) calls
                                const callerDir = path.dirname(filePath);
                                const samePackage = targetDefs.some(d => d.file && path.dirname(d.file) === callerDir);
                                if (!samePackage) {
                                    recordExcluded(filePath, call.line, 'external-package');
                                    continue;
                                }
                            }
                        }
                    }
                }

                // Alias-matched method call on a TYPED receiver: the receiver's
                // class owns the method dispatch — it cannot be a renamed
                // standalone function (`numberSchema.gt()` is ZodNumber.gt, not
                // `export { _gt as gt }`). Namespace receivers (`import * as
                // checks; checks.gt()`) carry no receiverType and keep flowing
                // on import evidence.
                if (calledAs && call.isMethod && call.receiverType &&
                    !targetDefs.some(td => td.className || td.receiver)) {
                    isUncertain = true;
                    typeMismatch = true;
                    if (collectAccount) {
                        recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                        continue;
                    }
                    if (!options.includeUncertain) {
                        if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                        continue;
                    }
                }

                // Receiver-class disambiguation:
                // When the target definition has a class/receiver type, filter callers
                // whose receiverType is known to be a different type.
                // All languages use receiverType when available (constructor/annotation inference).
                // Go/Java/Rust additionally fall back to variable name matching.
                // A declared-field receiver type (fix #202) enters even when a
                // name-binding matched — bindings don't model receivers. Same
                // for a BUILTIN-typed receiver (fix #209): `"".join(...)` in
                // the file that defines URL.join name-binds to the method def,
                // but the receiver IS a str — the literal type outranks the
                // name binding (str/dict/Array are never project classes).
                const normalizedReceiverType = call.receiverType
                    ? (_aliasBaseAtOrigin(
                        index, call.receiverType,
                        call.receiverTypeFlowFile || filePath,
                        !call.receiverTypeFlowFile ||
                            call.receiverTypeFlowFile === filePath
                            ? call.line : undefined) ||
                        _pureAliasBase(index, call.receiverType) ||
                        call.receiverType)
                    : null;
                const builtinReceiverOverride = !!(normalizedReceiverType &&
                    BUILTIN_RECEIVER_TYPES.has(normalizedReceiverType) &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural');
                if (call.isMethod && (call.receiver || call.receiverType || fieldHopType) &&
                    !resolvedBySameClass && !resolvedByExtensionMethod &&
                    // Name bindings model the called member spelling, not
                    // the receiver's runtime owner. A declared receiver type
                    // therefore outranks a same-file/scope name binding just
                    // like a declared-field or builtin receiver does.
                    (!bindingId || call.receiverType || fieldHopType || builtinReceiverOverride) &&
                    (call.receiverType || fieldHopType || langTraits(fileEntry.language)?.typeSystem === 'nominal')) {
                    // Target type set: target classes + non-overriding subtypes
                    // (a Child receiver calling an inherited Base method IS a
                    // caller of Base.method). Memoized — fixed per query.
                    const targetTypes = dispatchTargetTypes(targetDefs);
                    if (targetTypes.size > 0) {
                        // Use inferred receiverType when available (Go/Java/Rust parameter type tracking)
                        // Generic type parameters are not type identity in
                        // EITHER direction (fix #220, made precise by #229):
                        // a receiver typed 'T' or 'TStore' neither validates
                        // against a blanket-impl target nor excludes a
                        // concrete one — T may be instantiated with anything,
                        // including the target class. Declared-in-enclosing-
                        // scope check first (`fn f<TStore: Wipe>(t: &TStore)`
                        // shadows even a same-named project type), 1-2-char
                        // ALL-CAPS convention as fallback.
                        let knownType = call.receiverType || fieldHopType;
                        if (knownType) {
                            knownType = _aliasBaseAtOrigin(
                                index, knownType,
                                call.receiverTypeFlowFile || filePath,
                                !call.receiverTypeFlowFile ||
                                    call.receiverTypeFlowFile === filePath
                                    ? call.line : undefined) ||
                                _pureAliasBase(index, knownType) ||
                                knownType;
                        }
                        if (knownType && !BUILTIN_RECEIVER_TYPES.has(knownType) &&
                            _isGenericParamReceiverType(index, filePath, call.line, knownType)) {
                            knownType = null;
                        }
                        if (knownType) {
                            const explicitInterfaceTarget = fileEntry.language === 'csharp' &&
                                targetDefs.some(definition => definition.explicitInterface &&
                                    _csharpTypeIdentity(definition.explicitInterface) ===
                                        _csharpTypeIdentity(knownType));
                            if (explicitInterfaceTarget && !call.receiverCastThis) {
                                if (collectAccount) {
                                    routeUnverified(filePath, fileEntry, call,
                                        'possible-dispatch', calledAs, {
                                            dispatchVia: knownType,
                                            dispatchCandidates: countDispatchCandidates(knownType),
                                        });
                                }
                                continue;
                            }
                            // Go package-qualified annotation identity (fix
                            // #273): `next http.Handler` is not a project-local
                            // `Handler`. External/opaque packages may expose an
                            // interface (implicit satisfaction), and a project
                            // interface is explicitly a dispatch contract.
                            // Both stay visible; neither can confirm a pinned
                            // concrete implementation.
                            if (collectAccount && fileEntry.language === 'go' &&
                                call.receiverTypeQualifier) {
                                const qualified = _goQualifiedReceiverType(
                                    index, fileEntry, call.receiverTypeQualifier, knownType);
                                const isContract = qualified?.kind === 'project' &&
                                    qualified.defs.some(d => d.type === 'interface' || d.type === 'trait');
                                const platformConcrete = qualified?.kind !== 'project' &&
                                    getLanguageAdapter('go')?.isPlatformConcreteType?.(
                                        call.receiverTypeQualifier, knownType);
                                if (platformConcrete) {
                                    recordExcluded(filePath, call.line, 'external-package');
                                    continue;
                                }
                                if (qualified && (qualified.kind !== 'project' || isContract)) {
                                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                        dispatchVia: qualified.via,
                                        dispatchCandidates: countDispatchCandidates(knownType),
                                        ...(qualified.kind !== 'project' && { externalContract: true }),
                                    });
                                    continue;
                                }
                            }
                            const viaFieldHop = !call.receiverType; // declared-field hop (fix #202)
                            // Exclusion requires an UNRELATED type. A receiver typed
                            // as an ANCESTOR of the target's class may dynamically
                            // dispatch to the target override (x: Base; x.parse()
                            // can run Child.parse) — structural languages only;
                            // Go embedding has no virtual dispatch. Field-hop types
                            // get the ancestor guard too (Java virtual dispatch).
                            const structural = langTraits(fileEntry.language)?.typeSystem === 'structural';
                            if (targetTypes.has(knownType)) {
                                receiverTypeValidated = true;
                                // Identity discipline (fix #206, extended to
                                // structural flow in #272): a
                                // NAME match is only identity when the
                                // unqualified type name resolves (same file →
                                // same package directory → import edge) to the
                                // target's package. grpc-go defines ~20 structs
                                // all named `bb` — leastrequest's `parser :=
                                // bb{}` validating against cdsbalancer's
                                // bb.ParseConfig is name conflation, not
                                // receiver evidence. Only DIRECT target type
                                // names are disciplined — subtype names entered
                                // targetTypes via the inheritance walk, whose
                                // edges already carry package context.
                                if (!structural &&
                                    targetDefs.some(d => (d.className || (d.receiver || '').replace(/^\*/, '')) === knownType)) {
                                    // Flow-typed receivers (fix #207) resolve identity
                                    // from the producing annotation's scope — the name
                                    // was written THERE, not in the consuming file.
                                    const identity = _resolveReceiverTypeIdentity(
                                        index, call.receiverTypeFlowFile || filePath, knownType, targetDefs,
                                        call.receiverTypeFlowFile ? undefined : call.line,
                                        call.receiverTypeNamespace ||
                                            call.receiverRootNamespace ||
                                            call.receiverTypeQualifier);
                                    if (identity === 'other') {
                                        receiverTypeValidated = false;
                                    } else if (identity === 'unknown') {
                                        receiverTypeValidated = false;
                                        receiverTypeUnresolved = true;
                                    }
                                } else if (structural) {
                                    // Multiple project types may share the
                                    // same class name across packages/versions
                                    // (zod v3 + v4 both define ZodArray). A
                                    // folded/module return type carries the
                                    // annotation's origin file; use it before
                                    // accepting the name as target identity.
                                    const sameNameTypeDefs = (index.symbols.get(knownType) || [])
                                        .filter(d => IDENTITY_TYPE_KINDS.has(d.type));
                                    if (sameNameTypeDefs.length > 1 ||
                                        (call.receiverTypeQualifier && call.receiverTypeFlowFile)) {
                                        const identity = _resolveStructuralFlowTypeIdentity(
                                            index, call.receiverTypeFlowFile || filePath, knownType, targetDefs,
                                            call.receiverTypeFlowFile ? undefined : call.receiverTypeQualifier);
                                        if (identity === 'other') {
                                            receiverTypeValidated = false;
                                        } else if (identity === 'unknown') {
                                            receiverTypeValidated = false;
                                            receiverTypeUnresolved = true;
                                        }
                                    }
                                }
                            } else if (structural && !BUILTIN_RECEIVER_TYPES.has(knownType)) {
                                // Name-only subtype sets cannot represent an
                                // imported parent that is exposed under a
                                // different type name. Resolve the receiver's
                                // exact declaration and walk its file-scoped
                                // ancestry before treating it as unrelated.
                                const identity = _resolveStructuralFlowTypeIdentity(
                                    index, call.receiverTypeFlowFile || filePath, knownType, targetDefs,
                                    call.receiverTypeFlowFile ? undefined : call.receiverTypeQualifier);
                                if (identity === 'target') {
                                    receiverTypeValidated = true;
                                } else if (identity === 'unknown') {
                                    receiverTypeUnresolved = true;
                                }
                            }
                            const matchesTarget = receiverTypeValidated ||
                                ((structural || viaFieldHop) && _isAncestorOfTargetClass(index, knownType, targetDefs));
                            // Structural trust gate: a name that is neither a
                            // builtin nor a project class (type alias, interface,
                            // external type) tracks no hierarchy UCN can check —
                            // not positive evidence against the target.
                            // Field-hop exclusion additionally demands the field's
                            // type DEFINE the method itself — otherwise Go
                            // promotion, Rust Deref, or Java inheritance could
                            // still route the call to the target. Exception: an
                            // EXTERNAL field type (no project class/struct def,
                            // e.g. Map/StringBuilder) excludes without that —
                            // external code cannot Deref/promote/inherit INTO
                            // project types, so the only dispatch path back is a
                            // project subtype of the external type, which the
                            // ancestor guard above already keeps.
                            // (1-2 char ALL-CAPS names are generic type params by
                            // convention — T, K, V, T1 — never external evidence:
                            // T may be instantiated WITH the target class. And the
                            // external rule needs the target's ancestor chain to be
                            // FULLY project-resolvable: a chain that dead-ends at an
                            // external ancestor (LinkedTreeMap extends AbstractMap)
                            // may reach knownType through ancestry UCN can't see —
                            // measured on gson: 6 true edges lost without this.)
                            const knownTypeHasProjectIdentity = (index.symbols.get(knownType) || [])
                                .some(d => IDENTITY_TYPE_KINDS.has(d.type));
                            const platformOwnsFieldCall = fileEntry.language === 'csharp' &&
                                !knownTypeHasProjectIdentity &&
                                getLanguageAdapter('csharp')?.isPlatformConcreteCall?.(
                                    knownType, call.name);
                            const fieldHopDefinesMethod = !viaFieldHop || platformOwnsFieldCall ||
                                definitions.some(d =>
                                    (d.className || (d.receiver || '').replace(/^\*/, '')) === knownType) ||
                                (!/^[A-Z][A-Z0-9]?$/.test(knownType) &&
                                    !knownTypeHasProjectIdentity &&
                                    _targetAncestryFullyResolved(index, targetDefs));
                            // A New*-prefix name GUESS (fix #266) is convention,
                            // not compiler truth — never exclusion evidence.
                            // Account mode routes the mismatch visible through
                            // the dispatch gate below; legacy keeps its drop
                            // (drop-vs-route asymmetry, the #213 pattern).
                            const receiverGuessGrade = !!(call.receiverTypeGuessed ||
                                (viaFieldHop && call.receiverRootTypeGuessed));
                            const exclusionTrusted = (!structural ||
                                _receiverTypeTrustedForExclusion(index, knownType)) && fieldHopDefinesMethod &&
                                !receiverTypeUnresolved && // unresolvable identity is not positive evidence either way
                                !(collectAccount && receiverGuessGrade);
                            if (!matchesTarget && exclusionTrusted) {
                                // Known type doesn't match target — positive evidence the
                                // call targets a DIFFERENT symbol. Under the account contract
                                // this is excluded-with-reason, not a revealable uncertain.
                                isUncertain = true;
                                typeMismatch = true;
                                if (collectAccount) {
                                    // ...unless the type can VIRTUALLY dispatch into
                                    // the target: an interface/trait receiver that
                                    // declares the method, or (Java — all instance
                                    // methods virtual) a superclass of the target.
                                    // Not evidence against — visible possible-dispatch.
                                    // Go struct embedding binds statically and stays
                                    // excluded.
                                    if (_dispatchCapableSupertype(index, fileEntry.language, knownType, targetDefs, definitions)) {
                                        const externalContract = externalContractTarget();
                                        routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                            dispatchVia: knownType,
                                            dispatchCandidates: countDispatchCandidates(knownType),
                                            ...(externalContract?.via === knownType && {
                                                externalContract: true,
                                            }),
                                        });
                                        continue;
                                    }
                                    recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                                    continue;
                                }
                                if (!options.includeUncertain) {
                                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                    continue;
                                }
                            }
                            // A guessed type that mismatches ROUTES visible
                            // (fix #266): the pre-guard flow reached the
                            // dispatch-capable reroute INSIDE the exclusion
                            // branch, so denying exclusionTrusted alone let
                            // the call fall through to the arity/scope
                            // machinery below (grpc-go: stream.SendMsg on a
                            // guessed 'Stream' fell to arity-mismatch — a
                            // harsher wrong exclusion). Convention-grade
                            // evidence attributes dispatch; it never excludes
                            // and never confirms a mismatch.
                            if (!matchesTarget && !exclusionTrusted && collectAccount && receiverGuessGrade) {
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: knownType,
                                    dispatchCandidates: countDispatchCandidates(knownType),
                                });
                                continue;
                            }
                            // Unmatched-but-untrusted field-hop type (fix #265,
                            // hono-measured): the hop PROVED the receiver is the
                            // field's declared type — not the enclosing class —
                            // yet the head earns no exclusion trust (external/
                            // unresolvable name). Falling through let the class-
                            // member name binding confirm `this.store.keys()`
                            // as MockCache.keys ('exact-binding'): bindings
                            // don't model receivers (#202). Route visible,
                            // attributed via the field's type; never confirm,
                            // never exclude. Structural only — nominal hops
                            // keep their #202 promotion/embedding fall-through
                            // (no measured family).
                            if (!matchesTarget && !exclusionTrusted && viaFieldHop && structural) {
                                if (collectAccount) {
                                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                        dispatchVia: knownType,
                                        dispatchCandidates: countDispatchCandidates(knownType),
                                    });
                                    continue;
                                }
                                if (!options.includeUncertain) {
                                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                    continue;
                                }
                            }
                        } else {
                            // No parser-inferred type — try local type inference
                            // for Go/Java/Rust (nominal type systems)
                            let inferredMatch = false;
                            let inferredMismatch = false;
                            if (langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                                const callerSym = index.findEnclosingFunction(filePath, call.line, true);
                                if (callerSym && callerSym.startLine != null && callerSym.endLine != null) {
                                    const cacheKey = `${filePath}:${callerSym.startLine}`;
                                    let localTypes = localTypeCache.get(cacheKey);
                                    if (localTypes === undefined) {
                                        const callsForFile = getCachedCalls(index, filePath);
                                        localTypes = callsForFile ? _buildTypedLocalTypeMap(index,
                                            { file: filePath, startLine: callerSym.startLine, endLine: callerSym.endLine },
                                            callsForFile) : null;
                                        localTypeCache.set(cacheKey, localTypes);
                                    }
                                    if (localTypes) {
                                        // The inference map re-derives receiver types
                                        // from the calls cache — the same generic-param
                                        // guard applies (fix #229: `t.wipe()` on
                                        // `t: &T` used to re-infer 'T' here and
                                        // exclude after the typed branch nulled it).
                                        let inferredType = localTypes.get(call.receiver);
                                        if (inferredType && _isGenericParamReceiverType(
                                            index, filePath, call.line, inferredType)) inferredType = null;
                                        // New*-guess entries (fix #266) may confirm
                                        // but never exclude: a mismatch routes as
                                        // unresolved under the account contract
                                        // (legacy keeps the drop — #213 asymmetry).
                                        const inferredGuessed = !!(inferredType &&
                                            localTypes.guessedVars?.has(call.receiver));
                                        if (inferredType) {
                                            if (targetTypes.has(inferredType)) {
                                                // Identity discipline (fix #206) — same as the
                                                // parser-typed branch above: a name match on a
                                                // DIRECT target type must resolve to the
                                                // target's package, not a same-named foreign type.
                                                let identity = 'target';
                                                if (targetDefs.some(d => (d.className || (d.receiver || '').replace(/^\*/, '')) === inferredType)) {
                                                    identity = _resolveReceiverTypeIdentity(index, filePath, inferredType, targetDefs, call.line);
                                                }
                                                if (identity === 'target') {
                                                    inferredMatch = true;
                                                    nominalInferredMatch = true;
                                                } else if (identity === 'other') {
                                                    if (collectAccount && inferredGuessed) receiverTypeUnresolved = true;
                                                    else inferredMismatch = true;
                                                } else {
                                                    receiverTypeUnresolved = true;
                                                }
                                            } else {
                                                if (collectAccount && inferredGuessed) receiverTypeUnresolved = true;
                                                else inferredMismatch = true;
                                            }
                                        }
                                    }
                                }
                            }
                            if (inferredMismatch) {
                                isUncertain = true;
                                typeMismatch = true;
                                if (collectAccount) {
                                    recordExcluded(filePath, call.line, 'receiver-type-mismatch');
                                    continue;
                                }
                                if (!options.includeUncertain) {
                                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                    continue;
                                }
                            }
                            // Java static/type-qualified calls carry compiler-
                            // shaped owner syntax (`ClassName.get(...)`). The
                            // receiver names the dispatch owner, so resolve it
                            // before overload selection; overloads on unrelated
                            // classes must never enter this target's ambiguity
                            // band.
                            if (call.receiverIsTypeQualified && call.receiver &&
                                fileEntry.language === 'java') {
                                const typeReceiver = call.receiver;
                                if (!targetTypes.has(typeReceiver)) {
                                    recordExcluded(filePath, call.line, 'receiver-other-class');
                                    continue;
                                }
                                let identity = 'target';
                                if (targetDefs.some(d => d.className === typeReceiver)) {
                                    identity = _resolveReceiverTypeIdentity(index, filePath,
                                        typeReceiver, targetDefs, call.line);
                                }
                                if (identity === 'other') {
                                    recordExcluded(filePath, call.line, 'receiver-other-class');
                                    continue;
                                }
                                if (identity === 'unknown') {
                                    if (collectAccount) {
                                        routeUnverified(filePath, fileEntry, call,
                                            'method-ambiguous', calledAs, {
                                                dispatchCandidates: methodOwnerKeys().size,
                                            });
                                    }
                                    continue;
                                }
                                inferredMatch = true;
                                nominalInferredMatch = true;
                            }
                            // Still no type — fall back to receiver name matching when
                            // multiple defs exist. A field-declared interface/trait type
                            // (fieldDispatchType, contract surface only) outranks the name
                            // heuristic: `storage.save()` on a field declared `Storage`
                            // is a dispatch edge, not a case-insensitive name accident —
                            // skip the fallback and let the dispatch tiering route it.
                            // call.receiver guard: a generic-param knownType
                            // (fix #220) reaches here receiver-less — there is
                            // no receiver NAME to match against.
                            if (call.receiver && !inferredMatch && !inferredMismatch &&
                                definitions.length > 1 && !fieldDispatchType &&
                                !call.receiverExternalFlow) {
                                const receiverSegment = call.isPathCall
                                    ? String(call.receiver).split('::').pop()
                                    : call.receiver;
                                const receiverLower = receiverSegment.toLowerCase();
                                const matchesTarget = [...targetTypes].some(cn => cn.toLowerCase() === receiverLower);
                                // Type-qualified identity discipline (fix #220,
                                // ripgrep-measured): a path-call receiver that
                                // matches the target type's NAME must also
                                // resolve (same file → same dir → import edge)
                                // to the target's package — every ripgrep crate
                                // defines its own `Config`, and printer's
                                // Config::default() name-matches core's Config
                                // while provably denoting the same-file struct.
                                // Path style only: a Go/Java receiver named
                                // like the type may be a VARIABLE (#206b) —
                                // its type is unknown, identity proves nothing.
                                if (matchesTarget && call.isPathCall &&
                                    langTraits(fileEntry.language)?.typeQualifiedCallStyle === 'path') {
                                    const identity = _resolveReceiverTypeIdentity(index, filePath,
                                        receiverSegment, targetDefs, call.line);
                                    if (identity === 'other') {
                                        isUncertain = true;
                                        typeMismatch = true;
                                        if (collectAccount) {
                                            recordExcluded(filePath, call.line, 'path-type-mismatch');
                                            continue;
                                        }
                                        if (!options.includeUncertain) {
                                            if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                            continue;
                                        }
                                    } else if (identity === 'unknown' && collectAccount) {
                                        // Unresolvable identity never confirms,
                                        // never excludes (#206).
                                        routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                            dispatchCandidates: methodOwnerKeys().size,
                                        });
                                        continue;
                                    }
                                }
                                if (!matchesTarget) {
                                    // Rust/Go path calls (Type::method() / pkg.Method()): receiver IS the type name
                                    // If it doesn't match target, it's definitely a different type — filter it.
                                    // `Self` exempt (fix #232, the #222(2) rule): Self names the
                                    // enclosing impl's type, not a foreign one — same-class
                                    // resolution above owns it.
                                    if (call.isPathCall && /^[A-Z]/.test(receiverSegment) &&
                                        receiverSegment !== 'Self') {
                                        // Generic-param carve-out (fix #296 — the
                                        // #222(2) single-def branch had this, the
                                        // multi-def fallback didn't): `F::as_cast(x)`
                                        // instantiates with ANY bound-satisfying
                                        // type — visible, never excluded.
                                        if (collectAccount &&
                                            /^[A-Z][A-Z0-9]?$/.test(receiverSegment) &&
                                            !(index.symbols.get(receiverSegment) || []).some(d => IDENTITY_TYPE_KINDS.has(d.type))) {
                                            routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                                dispatchCandidates: methodOwnerKeys().size,
                                            });
                                            continue;
                                        }
                                        // Trait-declaration pin (fix #296): a
                                        // concrete non-target receiver can
                                        // implement the pinned trait — route
                                        // visible, never exclude.
                                        const traitVia = collectAccount &&
                                            _traitDeclPinImplementorRoute(index, fileEntry, receiverSegment, targetDefs);
                                        if (traitVia) {
                                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                                dispatchVia: `${receiverSegment} — ${traitVia} implementor`,
                                            });
                                            continue;
                                        }
                                        isUncertain = true;
                                        typeMismatch = true;
                                        if (collectAccount) {
                                            recordExcluded(filePath, call.line, 'path-type-mismatch');
                                            continue;
                                        }
                                        if (!options.includeUncertain) {
                                            if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                            continue;
                                        }
                                    }
                                    const nonTargetClasses = new Set();
                                    for (const d of definitions) {
                                        const t = d.className || (d.receiver && d.receiver.replace(/^\*/, ''));
                                        if (t && !targetTypes.has(t)) nonTargetClasses.add(t);
                                    }
                                    const matchesOther = [...nonTargetClasses].some(cn => cn.toLowerCase() === receiverLower);
                                    if (matchesOther) {
                                        isUncertain = true;
                                        typeMismatch = true;
                                        if (collectAccount) {
                                            // The matched class may be a dispatch-capable
                                            // supertype of the target (a receiver named
                                            // after the interface it is typed as) — that
                                            // is a possible dispatch edge, not evidence
                                            // against the target.
                                            const dispatchSuper = [...nonTargetClasses]
                                                .filter(cn => cn.toLowerCase() === receiverLower)
                                                .find(cn => _dispatchCapableSupertype(index, fileEntry.language, cn, targetDefs, definitions));
                                            if (dispatchSuper) {
                                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                                    dispatchVia: dispatchSuper,
                                                    dispatchCandidates: countDispatchCandidates(dispatchSuper),
                                                });
                                                continue;
                                            }
                                            recordExcluded(filePath, call.line, 'receiver-other-class');
                                            continue;
                                        }
                                        if (!options.includeUncertain) {
                                            if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                            continue;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Arity pruning (nominal contract surface, fix #205): a call
                // whose argument count cannot fit ANY pinned definition's
                // parameter range is positive evidence the call binds a
                // different symbol — excluded-with-reason. Static-arity
                // languages only: their compilers enforce arity, so a mismatch
                // IS evidence. JS pads/ignores extra args legally and Python
                // decorators reshape signatures invisibly — never prune there.
                // Go tuple expansion (f(g()) filling two params) means too-FEW
                // syntactic args is not evidence in Go — only too-many prunes.
                // Binding/same-class evidence normally outranks the count
                // (then a mismatch more likely means our param parse is
                // wrong). C++ is the exception: overload resolution and
                // unqualified lookup make a receiver-blind name binding much
                // weaker than compiler-enforced arity. In particular, the
                // global POSIX write(fd, buf, size) inside file::write(buf,
                // size) must not be reported as recursive just because the
                // member owns the nearest same-name binding.
                let arityNoFit = false;
                const cppArityOverridesBinding =
                    fileEntry.language === 'cpp';
                if (collectAccount &&
                    ((!bindingId && !resolvedBySameClass) ||
                     cppArityOverridesBinding) &&
                    call.argCount != null && !call.argSpread &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                    !_callArityCompatible(call, targetDefs, fileEntry.language)) {
                    // Fits-elsewhere carve-out (fix #229): "binds a different
                    // symbol" needs a different symbol the call COULD bind.
                    // When the argument count also fits no OTHER callable def
                    // of the name project-wide, a wrong-arity call at an
                    // EVIDENCE-BACKED site is a BROKEN CALL SITE (or a parse
                    // gap) — the thing verify/diff-impact exist to surface
                    // after a signature change. Marked and allowed to flow:
                    // receiver/type-qualified evidence confirms it into
                    // verify's arg-check (mismatch band). The exclusion stays
                    // when a sibling overload or another definition fits the
                    // count (jdtls-measured), and the dispatch gate below
                    // re-excludes marked calls that would only confirm via the
                    // single-owner rule — that rule presumes no other
                    // candidate, which the wrong arity disproves toward
                    // EXTERNAL code (Arrays.asList(1,2,3) vs a project 0-param
                    // asList: unique project ownership is not evidence here).
                    const pinnedKeys = new Set(targetDefs.map(d => `${d.file}:${d.startLine}`));
                    const otherDefs = definitions.filter(d =>
                        !NON_CALLABLE_TYPES.has(d.type) && !pinnedKeys.has(`${d.file}:${d.startLine}`));
                    if (otherDefs.length > 0 && _callArityCompatible(call, otherDefs, fileEntry.language)) {
                        recordExcluded(filePath, call.line, 'arity-mismatch');
                        continue;
                    }
                    arityNoFit = true;
                }

                // Overload discipline (fix #205, languages with arity/type
                // overloading — Java): when the pinned target shares its name
                // with sibling overloads in the same class, a call site only
                // CONFIRMS the pinned overload if its static argument shape
                // (count + literal kinds) binds it:
                //   - kinds prove a DIFFERENT overload → excluded 'overload-mismatch'
                //   - kinds prove the pinned one uniquely → flows on (confirmable)
                //   - undecidable (variable args) → visible 'overload-ambiguous'
                // jdtls-measured: class-level receiver evidence said "some add()
                // overload", which is not evidence for THIS add(Number).
                if (collectAccount && options.targetDefinitions &&
                    langTraits(fileEntry.language)?.hasArityOverloads &&
                    call.argCount != null && !call.argSpread && !call.isConstructor) {
                    const overloadVerdict = _overloadDiscipline(
                        index, call, targetDefs, definitions, filePath);
                    if (overloadVerdict === 'other-overload') {
                        recordExcluded(filePath, call.line, 'overload-mismatch');
                        continue;
                    }
                    if (overloadVerdict && overloadVerdict.ambiguous) {
                        routeUnverified(filePath, fileEntry, call, 'overload-ambiguous', calledAs, {
                            dispatchCandidates: overloadVerdict.candidates,
                            ...(overloadVerdict.compileTimeDispatch && {
                                uncertaintyClass: 'compile-time-dispatch',
                                dispatchFamily: overloadVerdict.dispatchFamily,
                            }),
                        });
                        continue;
                    }
                }

                // Find the enclosing function (get full symbol info)
                const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);

                // Method call whose receiver has no binding evidence in this file's
                // scope (structural languages only) — receiver-evidence-free.
                // Hoisted because it also limits what counts as import evidence.
                const uncertainMethodReceiver = skipLocalBinding && call.isMethod && !resolvedBySameClass &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    !(call.receiver && (fileEntry.bindings || []).some(b => b.name === call.receiver));

                // Check import graph evidence: does this file import from the target definition's file?
                const targetDefs2 = options.targetDefinitions || definitions;
                const targetFiles2 = new Set(targetDefs2.map(d => d.file).filter(Boolean));
                const callerImports = index.importGraph.get(filePath);
                // The caller's OWN file never counts as an import-edge hit
                // (fix #294): an import cycle (flask json/__init__ →
                // wrappers → json/__init__) would launder same-file
                // membership into "import edge" evidence, bypassing the
                // same-file clause's receiver guard below. Same-file
                // evidence is governed there, not here.
                let importEdgeLink = !!(callerImports && setSome(callerImports,
                    imp => imp !== filePath && targetFiles2.has(imp)));
                // Check one level of re-exports (barrel files) for import evidence
                if (!importEdgeLink && callerImports) {
                    for (const imp of callerImports) {
                        if (imp === filePath) continue;
                        const transImports = index.importGraph.get(imp);
                        if (transImports && setSome(transImports,
                            ti => ti !== filePath && targetFiles2.has(ti))) {
                            importEdgeLink = true;
                            break;
                        }
                    }
                }
                // Same-file membership is module-scope evidence for plain calls,
                // but says nothing about a method receiver: `foo.map()` sharing a
                // file with `function map()` must not confirm while foo's type is
                // unknown. Real import edges keep counting — importing the
                // defining module is evidence the file uses its API.
                const hasImportLink = importEdgeLink ||
                    (targetFiles2.has(filePath) && !uncertainMethodReceiver);

                // Same-package evidence (nominal type systems): Java/Rust/Go
                // resolve same-package/module names without import statements,
                // so a target defined in the caller's directory is real scope
                // evidence, not a bare name match.
                const hasSamePackageEvidence = !hasImportLink &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                    targetDefs2.some(d => d.file &&
                        _sameNominalPackageDir(path.dirname(d.file), path.dirname(filePath), fileEntry.language));

                // Possible-dispatch tiering (nominal languages, contract surface
                // only): methodCallInclusion='auto' confirms method calls with
                // ZERO receiver evidence — right when the name is unique
                // project-wide (cobra), a lie when dozens of types implement it
                // (gson TypeAdapter.read). The confirmed tier keeps only
                // evidence-backed edges: validated/inferred receiver type,
                // same-class resolution, binding, a type-qualified receiver
                // (Type::method / Type.method), or a name with a single
                // project-wide owner. The rest stay VISIBLE as unverified — a
                // known-but-unvalidated receiver type is 'possible-dispatch'
                // (attributed via the declared supertype), an untyped receiver
                // against multiple owners is 'method-ambiguous'. Nothing is
                // dropped: conservation holds, the entries move tiers.
                // A binding matched from a bare-name lookup is receiver-blind:
                // method calls resolve through their RECEIVER in every supported
                // language, never through file scope — a same-file def or import
                // of the name says nothing about what `parse_hex(v).map(...)` or
                // `self.inner.next()` dispatches to (cursive-measured: 9 of 11
                // method FPs were chained/field-rooted calls confirmed
                // exact-binding against Rgb::map / Iterator-impl next / V::draw).
                // Such calls must earn the confirmed tier through receiver
                // evidence — route them through the dispatch tiering below.
                // Self-receiver calls are not affected (same-class resolution
                // owns them); captured-receiver calls never bound (skipLocalBinding).
                // Local-alias calls (fix #218): `get_style = console.get_style;
                // get_style(x)` is a TRUE edge with compiler-grade evidence,
                // but it reaches the target through a local variable — the
                // line's name resolves to the alias, not the def, so reference
                // oracles place nothing here and grep-parity verification is
                // impossible. Visible unverified, never confirmed (not even by
                // same-class/type-qualified/single-owner evidence); the
                // exclusion-grade checks (typed-receiver mismatch, same-class
                // pinning, arity) already fired above and win.
                if (collectAccount && call.aliasCall) {
                    routeUnverified(filePath, fileEntry, call, 'alias-call', calledAs, {
                        ...(call.receiver && { dispatchVia: call.receiver }),
                    });
                    continue;
                }

                // Python capability guards are runtime dispatch provenance,
                // not proof of one implementation:
                //   if hasattr(stream, "aread"): stream.aread(...)
                // When no stronger receiver identity has already resolved the
                // call, keep the site visible but explain the concrete reason
                // it exists instead of presenting it as opaque no-evidence
                // ambiguity. Raw sites remain conserved and available in JSON.
                if (collectAccount && call.receiverCapabilityGuard &&
                    call.isMethod && !call.receiverIsModule &&
                    !resolvedBySameClass && !receiverTypeValidated &&
                    !nominalInferredMatch) {
                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                        dispatchVia: `dynamic capability "${call.receiverCapabilityGuard}"`,
                        dynamicCapability: true,
                    });
                    continue;
                }

                const receiverBlindBinding = !!bindingId && call.isMethod && !call.receiver;
                if (collectAccount && call.isMethod && (!bindingId || receiverBlindBinding) &&
                    !resolvedBySameClass && !resolvedByExtensionMethod &&
                    !receiverTypeValidated && !nominalInferredMatch &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    const tTypes = dispatchTargetTypes(targetDefs2);
                    // `use X as Y` import rename (fix #222b, ripgrep-measured:
                    // `use ContextSeparator as Separator; Separator::disabled()`
                    // — the alias names the TARGET type locally): judge path
                    // receivers by the ORIGINAL name. Only fires when the
                    // import's last path segment IS a target type — package
                    // aliases and unrelated imports stay untouched.
                    let receiverName = call.receiver;
                    if (call.isPathCall && receiverName) {
                        receiverName = String(receiverName).split('::').pop();
                    }
                    if (receiverName && !tTypes.has(receiverName)) {
                        for (const im of (fileEntry.importBindings || [])) {
                            if (im.name !== receiverName) continue;
                            const orig = String(im.module || '').split('::').pop();
                            if (orig && orig !== receiverName && tTypes.has(orig)) {
                                receiverName = orig;
                                break;
                            }
                        }
                    }
                    // A receiver that shares the target type's NAME is only
                    // type-qualified when the call matches the language's
                    // qualified-call syntax (typeQualifiedCallStyle trait):
                    // Rust requires Type::method (a dot-call receiver matching
                    // a type name is a variable); Go method expressions
                    // T.M(recv, ...) pass the receiver as the first argument,
                    // so a zero-arg call on a type-named receiver is a
                    // variable, not the type (grpc-go's `bb` collision).
                    let typeQualifiedReceiver = !!(receiverName && tTypes.has(receiverName));
                    if (typeQualifiedReceiver) {
                        const qualStyle = langTraits(fileEntry.language)?.typeQualifiedCallStyle;
                        if (qualStyle === 'path') typeQualifiedReceiver = !!call.isPathCall;
                        else if (qualStyle === 'method-expr') typeQualifiedReceiver = call.argCount == null || call.argCount >= 1;
                    }
                    // Identity discipline on the qualified shape itself (fix
                    // #220): a genuinely type-qualified call still only NAMES
                    // the type — the name must resolve to the target's package
                    // (every ripgrep crate defines a `Config`). 'other' is
                    // compiler-grade evidence for a different type; 'unknown'
                    // never confirms and never excludes (#206). The receiver-
                    // name fallback above handles multi-definition names; this
                    // covers single-definition targets that skip it.
                    if (typeQualifiedReceiver) {
                        const identity = _resolveReceiverTypeIdentity(index, filePath, receiverName, targetDefs2, call.line);
                        if (identity === 'other') {
                            recordExcluded(filePath, call.line, 'path-type-mismatch');
                            continue;
                        }
                        if (identity === 'unknown') {
                            routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                dispatchCandidates: methodOwnerKeys().size,
                            });
                            continue;
                        }
                    }
                    if (!typeQualifiedReceiver) {
                        // External-producer receiver (fix #220): the variable
                        // was assigned from a call into an external package
                        // (av := reflect.ValueOf(a)) — its type was decided
                        // outside the project, so unique project ownership is
                        // not identity evidence. Visible, never excluded
                        // (external generic identity functions can return
                        // project values).
                        if (call.receiverExternalFlow) {
                            if (call.receiverExternalConcreteFlow) {
                                recordExcluded(filePath, call.line, 'external-package');
                                continue;
                            }
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: call.receiverExternalFlow,
                                externalContract: true,
                            });
                            continue;
                        }
                        // Unresolvable type-name identity (fix #206): the
                        // receiver is typed with a name several distinct types
                        // share, and none resolves from this file's scope —
                        // visible ambiguous, not confirmable receiver evidence.
                        if (receiverTypeUnresolved) {
                            routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                dispatchCandidates: methodOwnerKeys().size,
                            });
                            continue;
                        }
                        // Type-qualified path calls naming a NON-target type
                        // (fix #222, seed-C-measured — the #220(2) fallback
                        // only ran with multiple same-name definitions, so
                        // single-owner names bypassed the whole discipline):
                        // `Vec::<String>::new()` inside assert_eq! names std's
                        // Vec — same-package scope cannot make it the project
                        // `new`. Generic-param receivers (`T::zero()` — T is
                        // instantiable with ANY type satisfying its bound)
                        // route VISIBLE, never excluded; concrete non-target
                        // type names are compiler-grade evidence for a
                        // different type. `Self` keeps its current scope
                        // resolution (a true same-impl call). Alias-qualified
                        // receivers are in the #208-closed tTypes and never
                        // reach here.
                        const pathReceiverSegment = call.isPathCall && call.receiver
                            ? String(call.receiver).split('::').pop() : null;
                        if (pathReceiverSegment &&
                            /^[A-Z]/.test(pathReceiverSegment) && pathReceiverSegment !== 'Self') {
                            if (/^[A-Z][A-Z0-9]?$/.test(pathReceiverSegment) &&
                                !(index.symbols.get(pathReceiverSegment) || []).some(d => IDENTITY_TYPE_KINDS.has(d.type))) {
                                routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                    dispatchCandidates: methodOwnerKeys().size,
                                });
                                continue;
                            }
                            // Trait-declaration pin (fix #296, serde-as_cast-
                            // measured): `u64::as_cast` / `Limb::as_cast` /
                            // `Self::Unsigned::as_cast` under the trait's own
                            // method pin dispatch through the pinned slot —
                            // macro-generated impls are invisible to the
                            // index, so the receiver not being a target type
                            // proves nothing. Route visible, never exclude.
                            const traitVia2 = _traitDeclPinImplementorRoute(
                                index, fileEntry, pathReceiverSegment, targetDefs2);
                            if (traitVia2) {
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: `${pathReceiverSegment} — ${traitVia2} implementor`,
                                });
                                continue;
                            }
                            recordExcluded(filePath, call.line, 'path-type-mismatch');
                            continue;
                        }
                        // Module-qualified path calls (fix #260, clap-measured):
                        // a LOWERCASE path qualifier names a MODULE, and the
                        // module owns the name (#206 ownership) — clap_mangen's
                        // `render::version(&self.cmd)` is render.rs's function,
                        // never Command::version, yet bare-name scope evidence
                        // confirmed it against the method pin. The qualifier's
                        // last segment resolves through this file's import/mod
                        // edges (basename match, mod.rs-aware): pin inside the
                        // module → normal confirmation; module defines the name
                        // elsewhere → excluded other-definition; resolver gap or
                        // unresolvable qualifier → visible, never scope-confirmed
                        // (#206(4): a qualified call never earns the target's
                        // bare-identifier scope evidence). crate/self/super are
                        // scope keywords, not module names — exempt.
                        if (call.isPathCall && call.receiver) {
                            const _modSeg = String(call.receiver).split('::').pop();
                            if (_modSeg && !/^[A-Z]/.test(_modSeg) &&
                                !['crate', 'self', 'super'].includes(_modSeg)) {
                                if (fileEntry.language === 'cpp' &&
                                    _cppQualifiedPathOwnsTarget(
                                        index, filePath, call, targetDefs2)) {
                                    // C++ namespace macros (fmt-style public
                                    // headers) are opaque to tree-sitter. A
                                    // qualified root that is also a component
                                    // of the included target header path pins
                                    // the portable-AST namespace owner. The
                                    // overload gate above must still prove the
                                    // exact callable slot.
                                    call = { ...call, moduleOwnedPath: true };
                                } else {
                                // Inline module container first (fix #260b —
                                // the #254 machinery): `convert::string(...)`
                                // where `mod convert { pub fn string }` lives
                                // in the SAME file (ripgrep defs.rs).
                                // Containment is identity evidence: the pin
                                // inside the module confirms; a same-name def
                                // inside it that ISN'T the pin excludes.
                                const _nsPin = _namespaceContainedDef(index, fileEntry, filePath,
                                    _modSeg, name, targetDefs2);
                                if (_nsPin) {
                                    call = { ...call, moduleOwnedPath: true };
                                } else if (_namespaceContainedDef(index, fileEntry, filePath,
                                    _modSeg, name, null)) {
                                    recordExcluded(filePath, call.line, 'other-definition');
                                    continue;
                                } else {
                                    const _edges = index.importGraph.get(filePath);
                                    const _modFiles = [];
                                    if (_edges) {
                                        for (const e of _edges) {
                                            const base = path.basename(e).replace(/\.rs$/, '');
                                            if (base === _modSeg ||
                                                (base === 'mod' && path.basename(path.dirname(e)) === _modSeg)) {
                                                _modFiles.push(e);
                                            }
                                        }
                                    }
                                    // Scope-rooted qualifiers (fix #260b,
                                    // ripgrep-measured): crate::messages::
                                    // set_errored() needs no use statement, so
                                    // there is no import edge — resolve the full
                                    // module path with the machinery imports use
                                    // (crate::/super::/self::, own-package names,
                                    // mod siblings, manifest target roots).
                                    if (_modFiles.length === 0) {
                                        try {
                                            const r = resolveRustImport(String(call.receiver), filePath, index.root);
                                            if (r && index.files.has(r)) _modFiles.push(r);
                                        } catch { /* resolver gap — never exclusion evidence */ }
                                    }
                                    const _pinnedIn = _modFiles.length > 0 &&
                                        targetDefs2.some(d => _modFiles.includes(d.file));
                                    if (!_pinnedIn) {
                                        const _ownsName = _modFiles.some(f => {
                                            const fe2 = index.files.get(f);
                                            return fe2 && fe2.symbols && fe2.symbols.some(s =>
                                                s.name === name && !NON_CALLABLE_TYPES.has(s.type));
                                        });
                                        if (_ownsName) {
                                            recordExcluded(filePath, call.line, 'other-definition');
                                            continue;
                                        }
                                        routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                            dispatchCandidates: methodOwnerKeys().size,
                                        });
                                        continue;
                                    }
                                    // Pinned target lives in the qualifier's
                                    // module — ownership is compiler-grade
                                    // name-level evidence (Rust resolves
                                    // crate::util::helper to util.rs's helper,
                                    // period): carry it as import-grade
                                    // evidence so a pure path-only usage
                                    // confirms even with no use-statement edge.
                                    call = { ...call, moduleOwnedPath: true };
                                }
                                }
                            }
                        }
                        const knownDispatchType = call.receiverType || fieldHopType || fieldDispatchType;
                        // Module-owned qualified calls (fix #260b) are resolved
                        // by OWNERSHIP — the dispatch-ambiguity routing below is
                        // receiver physics for method calls and must not demote
                        // them (ripgrep: `convert::string(...)` tripped the
                        // multi-owner check via unrelated `string` methods).
                        if (!call.moduleOwnedPath && knownDispatchType && !tTypes.has(knownDispatchType)) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: knownDispatchType,
                                dispatchCandidates: countDispatchCandidates(knownDispatchType),
                            });
                            continue;
                        }
                        // java.lang.Object universal names are runtime
                        // dispatch questions even when several project
                        // classes override the method. Apply this before the
                        // generic multi-owner branch; otherwise toString on
                        // an untyped value is mislabeled actionable
                        // method-ambiguity rather than one Object dispatch
                        // family.
                        if (!call.moduleOwnedPath && !knownDispatchType &&
                            _universalMethodName(fileEntry.language, call.name)) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia:
                                    `${_universalRootName(fileEntry.language)} — builtin contract`,
                                externalContract: true,
                            });
                            continue;
                        }
                        if (!call.moduleOwnedPath && !knownDispatchType && methodOwnerKeys().size > 1) {
                            routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                dispatchCandidates: methodOwnerKeys().size,
                            });
                            continue;
                        }
                        // Single project-wide owner, but the method provably
                        // implements an EXTERNAL contract (fix #210): the
                        // receiver could be any external subtype
                        // (((Long) obj).intValue() vs LazilyParsedNumber's
                        // @Override intValue) — unique ownership is not
                        // identity evidence here. Visible, never excluded.
                        const extContract = !knownDispatchType && externalContractTarget();
                        if (extContract) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                ...(extContract.via && { dispatchVia: extContract.via }),
                                externalContract: true,
                            });
                            continue;
                        }
                        // Wrong-arity call that fits no project def (fix #229
                        // carve-out marker): the single-owner rule presumes no
                        // other candidate exists, but the arity disproves the
                        // project-side match — the call binds EXTERNAL code
                        // (Arrays.asList(1,2,3)). Only receiver/type-qualified
                        // evidence may carry a wrong-arity call to the
                        // mismatch band; ownership alone re-excludes here.
                        if (arityNoFit) {
                            recordExcluded(filePath, call.line, 'arity-mismatch');
                            continue;
                        }
                    }
                }

                // Bare-call name ownership, Java (fix #229): where
                // bareCallReachesMethods a bare call CAN denote a method —
                // via a static import or an inherited implicit this-call —
                // but file-level scope evidence cannot CONFIRM one: a bare
                // name in Java resolves through the class scope (own +
                // inherited members) or a static import, never through
                // package-mate visibility. Confirmed tier: the enclosing
                // class is a dispatch-capable receiver type for the target
                // (inherited this-call), or a static import of the name /
                // wildcard static import resolves to a target file
                // (compiler-grade name evidence, the #217 rule). A static
                // import resolving to a DIFFERENT project file owns the name
                // (other-definition-import); everything else routes VISIBLE
                // (external static imports and unresolved ancestry are not
                // exclusion evidence — JLS scope nesting also lets inherited
                // members shadow imports, so 'unknown' never excludes).
                if (collectAccount && !call.isMethod && !call.receiver && !bindingId &&
                    !resolvedBySameClass &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                    langTraits(fileEntry.language)?.bareCallReachesMethods &&
                    targetDefs2.length > 0 && targetDefs2.every(d =>
                        !NON_CALLABLE_TYPES.has(d.type) && (d.className || d.receiver))) {
                    if (arityNoFit) {
                        recordExcluded(filePath, call.line, 'arity-mismatch');
                        continue;
                    }
                    const tTypes = dispatchTargetTypes(targetDefs2);
                    const enclosingClass = callerSymbol && callerSymbol.className;
                    const lexicalOwnerTypes = new Set(
                        enclosingClass ? [enclosingClass] : []);
                    if (enclosingClass &&
                        (fileEntry.language === 'java' ||
                         fileEntry.language === 'csharp')) {
                        let current = enclosingClass;
                        const namespace = callerSymbol?.namespace || null;
                        while (current) {
                            const declaration = (index.symbols.get(current) || [])
                                .find(symbol => IDENTITY_TYPE_KINDS.has(symbol.type) &&
                                    symbol.file === filePath &&
                                    (fileEntry.language !== 'csharp' ||
                                     (symbol.namespace || null) === namespace));
                            current = declaration?.enclosingType || null;
                            if (current) lexicalOwnerTypes.add(current);
                        }
                    }
                    // Nested Java/C# types have lexical access to static
                    // members of every enclosing type. C# partial outer
                    // classes may place that member in another file, but the
                    // namespace+outer-type identity remains compiler-exact.
                    if ([...lexicalOwnerTypes].some(owner => tTypes.has(owner))) {
                        resolvedBySameClass = true;
                    } else {
                        // C#/Java bare member lookup starts in the enclosing
                        // class. An applicable same-named member there owns
                        // the call; package-wide spelling cannot redirect it
                        // to an unrelated pinned class.
                        const targetKeys = new Set(targetDefs2.map(definition =>
                            `${definition.file}:${definition.startLine}`));
                        const enclosingNamespace = callerSymbol?.namespace || null;
                        const enclosingOwnsCall = !!enclosingClass && definitions.some(definition =>
                            !NON_CALLABLE_TYPES.has(definition.type) &&
                            definition.className === enclosingClass &&
                            (fileEntry.language !== 'csharp' ||
                                (definition.namespace || null) === enclosingNamespace) &&
                            !targetKeys.has(`${definition.file}:${definition.startLine}`) &&
                            _callArityCompatible(call, [definition], fileEntry.language));
                        if (enclosingOwnsCall) {
                            recordExcluded(filePath, call.line, 'other-definition');
                            continue;
                        }
                        const targetFiles = new Set(targetDefs2.map(d => d.file).filter(Boolean));
                        let verdict = null; // 'target' | 'other' | 'unknown'
                        for (const im of (fileEntry.importBindings || [])) {
                            const mod = String(im.module || '');
                            if (im.name === call.name && mod.endsWith('.' + call.name)) {
                                const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[mod];
                                verdict = rel
                                    ? (targetFiles.has(path.join(index.root, rel)) ? 'target' : 'other')
                                    : 'unknown';
                                break;
                            }
                        }
                        if (verdict === null && fileEntry.moduleResolved) {
                            for (const [mod, rel] of Object.entries(fileEntry.moduleResolved)) {
                                if (mod.endsWith('.*') && targetFiles.has(path.join(index.root, rel))) {
                                    verdict = 'target';
                                    break;
                                }
                            }
                        }
                        if (verdict === 'other') {
                            recordExcluded(filePath, call.line, 'other-definition-import');
                            continue;
                        }
                        if (verdict !== 'target') {
                            routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                dispatchCandidates: methodOwnerKeys().size,
                            });
                            continue;
                        }
                    }
                }

                // Sibling-impl overload ambiguity (fix #220, cursive-measured —
                // the #205 jdtls insight for languages WITHOUT arity-overload
                // discipline): Rust defines same-name methods on the SAME type
                // across impl blocks (`impl From<Color> for ColorStyle` ×4;
                // `impl Rgb<f32>` vs `impl Rgb<u8>` both with as_color).
                // Class-level receiver evidence — type-qualified path calls,
                // name-validated receiver types — proves "some ColorStyle::from",
                // never the pinned one; with an arity-indistinguishable
                // same-class sibling the call routes visible. Alias-qualified
                // receivers are exempt: `StyledString::plain` names ONE
                // instantiation by construction (#208 — the alias carries the
                // type argument even though UCN's closure is name-level).
                // Go cannot compile same-class same-name siblings; Java runs
                // its own #205 argKinds discipline (hasArityOverloads).
                if (collectAccount && call.isMethod && !resolvedBySameClass &&
                    (!bindingId || receiverBlindBinding) &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                    !langTraits(fileEntry.language)?.hasArityOverloads &&
                    options.targetDefinitions && options.targetDefinitions.length > 0 &&
                    !(call.receiver && (index.symbols.get(call.receiver) || []).some(d => d.aliasOf))) {
                    const pinnedCallable = options.targetDefinitions.filter(d => !NON_CALLABLE_TYPES.has(d.type));
                    const pinnedClasses = new Set(pinnedCallable
                        .map(d => d.className || (d.receiver || '').replace(/^\*/, ''))
                        .filter(Boolean));
                    if (pinnedClasses.size > 0) {
                        const pinnedKeys = new Set(pinnedCallable.map(d => `${d.file}:${d.startLine}`));
                        // Same-FILE constraint: a same-name class in another
                        // package is a DIFFERENT type, not a sibling impl
                        // (Go's per-package `bb` structs). The measured Rust
                        // families (From impls, generic instantiations) live
                        // in the type's own file.
                        const pinnedFiles = new Set(pinnedCallable.map(d => d.file).filter(Boolean));
                        const sibling = definitions.find(d =>
                            !NON_CALLABLE_TYPES.has(d.type) &&
                            pinnedClasses.has(d.className || (d.receiver || '').replace(/^\*/, '')) &&
                            pinnedFiles.has(d.file) &&
                            !pinnedKeys.has(`${d.file}:${d.startLine}`) &&
                            _callArityCompatible(call, [d], fileEntry.language));
                        if (sibling) {
                            routeUnverified(filePath, fileEntry, call, 'overload-ambiguous', calledAs, {
                                dispatchCandidates: definitions.filter(d =>
                                    !NON_CALLABLE_TYPES.has(d.type) &&
                                    pinnedClasses.has(d.className || (d.receiver || '').replace(/^\*/, ''))).length,
                            });
                            continue;
                        }
                    }
                }

                // Structural dispatch tiering (fix #209, httpx-measured — the
                // #204 discipline applied to structural languages): file-level
                // import/scope evidence speaks for a bare NAME reaching this
                // file, not for a method call's receiver — `key.decode(enc)`
                // in a file that imports _decoders.py is bytes.decode, not
                // ContentDecoder.decode. An untyped-receiver method call
                // confirms only via binding, same-class, a validated receiver
                // type, a type-qualified receiver (Class.method static style),
                // or a single project-wide owner. Multi-owner name matches
                // route VISIBLE method-ambiguous — never dropped. Same for a
                // bare call against pure method targets (a bare name cannot
                // denote a method in JS/TS/Python — only a rebound alias can,
                // which has no evidence here either).
                if (collectAccount && (!bindingId || receiverBlindBinding) && !resolvedBySameClass &&
                    !receiverTypeValidated &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    // Module-qualified calls (z.string(), ns.helper()) are
                    // exempt: the module IS name-level evidence, and the
                    // module-ownership block above already routed the ones
                    // whose module doesn't reach the target. Submodule
                    // receivers (fix #224) are module receivers too.
                    if (call.isMethod && !call.receiverIsModule &&
                        !recvSubmoduleRel && !call.moduleOwnedPath) {
                        const tTypes = dispatchTargetTypes(targetDefs2);
                        const typeQualifiedReceiver = !!(call.receiver && tTypes.has(call.receiver));
                        const knownDispatchType = call.receiverType ||
                            fieldHopType || fieldDispatchType;
                        // A compiler/parser-known receiver type that is not a
                        // target type defeats the single-owner heuristic even
                        // when this method name has only one project owner.
                        // It may be a structural/external type or a dynamic
                        // supertype of the target, so keep it visible rather
                        // than confirming or excluding by spelling alone.
                        if (!typeQualifiedReceiver && knownDispatchType &&
                            !tTypes.has(knownDispatchType)) {
                            routeUnverified(filePath, fileEntry, call,
                                'possible-dispatch', calledAs, {
                                    dispatchVia: knownDispatchType,
                                    dispatchCandidates:
                                        countDispatchCandidates(knownDispatchType),
                                });
                            continue;
                        }
                        // A local receiver whose nearest assignment the flow
                        // machinery examined and could NOT type holds a value
                        // of unknown provenance (`local = factory()`) — the
                        // #222(4) evidence class with a local producer, so
                        // single-owner spelling must not confirm it. A bare
                        // never-assigned parameter has no such evidence and
                        // keeps the measured #204/#209 single-owner physics
                        // (`run(codec) { codec.decodeFrames(...) }` stays
                        // confirmed when Codec is the one project owner).
                        if (!typeQualifiedReceiver && call.receiverLocalBinding &&
                            !call.receiverType && !fieldHopType && !fieldDispatchType &&
                            !call.receiverExternalFlow && !call.receiverQualifiedFlow) {
                            let demoteFlowMap = returnFlowCache.get(filePath);
                            if (demoteFlowMap === undefined) {
                                demoteFlowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                                returnFlowCache.set(filePath, demoteFlowMap);
                            }
                            if (_receiverAssignedUntyped(demoteFlowMap, call)) {
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: call.receiverRootType || 'local receiver',
                                });
                                continue;
                            }
                        }
                        // External-producer receiver (fix #222, httpx-measured
                        // — the #220 Go rule for structural languages): the
                        // variable was assigned from a call into an external
                        // module (logger = logging.getLogger(...)), so its
                        // type was decided outside the project and unique
                        // project ownership is not identity evidence.
                        // Visible, never excluded.
                        if (!typeQualifiedReceiver && call.receiverExternalFlow) {
                            if (call.receiverExternalConcreteFlow) {
                                recordExcluded(filePath, call.line, 'external-package');
                                continue;
                            }
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: call.receiverExternalFlow,
                                externalContract: true,
                            });
                            continue;
                        }
                        if (!typeQualifiedReceiver && call.receiverQualifiedFlow) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: call.receiverQualifiedFlow,
                            });
                            continue;
                        }
                        // Module-rooted dotted receiver (fix #294, flask-
                        // measured: `flask.json.load(out)` — receiverRoot
                        // resolves to a MODULE import binding, so the call
                        // dispatches through a module attribute the field-hop
                        // machinery cannot type. Single project-wide ownership
                        // of the method name is not evidence about a module
                        // attribute's value: demote-only, visible, attributed
                        // via the dotted path. A root the hop DID type is
                        // handled above (knownDispatchType); a from-import
                        // root counts only when the resolver PROVED it a
                        // submodule (#224 — a from-import name may be a
                        // plain symbol, never assume).
                        if (!typeQualifiedReceiver && !knownDispatchType &&
                            call.receiverRoot && !call.receiverRootType &&
                            langTraits(fileEntry.language)?.typeSystem === 'structural') {
                            const rootBinding = (fileEntry.importBindings || []).find(b =>
                                b && b.name === call.receiverRoot);
                            const rootIsModule = !!rootBinding && (
                                rootBinding.kind === 'import' ||
                                !!_submoduleReceiverModule(index, fileEntry, call.receiverRoot));
                            if (rootIsModule) {
                                const field = call.receiverField ? `.${call.receiverField}` : '';
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: `${call.receiverRoot}${field} — module attribute`,
                                    // Structured marker (outcome-eval-measured,
                                    // 2026-08-19): the site's name binds the
                                    // module's export surface, not the pinned
                                    // def — rename policies defer these like
                                    // external contracts (renaming the line
                                    // edits whatever the module exports under
                                    // the name, which the engine could not pin).
                                    moduleAttribute: true,
                                });
                                continue;
                            }
                        }
                        // Unshadowed builtin-global receiver (fix #232):
                        // JSON.parse/console.log resolve on the host object,
                        // never a same-named project method. A lexical binding
                        // or an AST-visible member assignment restores normal
                        // dispatch physics (`JSON.parse = projectParse`).
                        if (!typeQualifiedReceiver && call.receiver && !call.receiverType &&
                            ['javascript', 'typescript', 'tsx', 'html'].includes(fileEntry.language) &&
                            JS_GLOBAL_RECEIVERS.has(call.receiver) &&
                            (index.symbols.get(call.receiver) || []).length === 0 &&
                            !fileEntry.bindings?.some(b => b.name === call.receiver) &&
                            !call.receiverMemberAssigned) {
                            // A candidate target that IS a member assignment
                            // onto this same global (fix #286a, fastify-
                            // measured: `console.log = () => {}` in a test's
                            // beforeEach) patches the host object process-
                            // wide — the assignment's own file cannot scope
                            // it, so every `console.log(...)` site MAY
                            // dispatch into the project def. Demote-only:
                            // visible possible-dispatch, never confirmed,
                            // never excluded.
                            if (targetDefs2.some(d => d.memberAssigned &&
                                d.assignedReceiver === call.receiver)) {
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: `${call.receiver} — builtin global patched in project`,
                                });
                                continue;
                            }
                            recordExcluded(filePath, call.line, 'external-package');
                            continue;
                        }
                        // A method call cannot denote a standalone function
                        // (fix #218, rich-measured: `console.print(...)`
                        // confirmed scope-match against module-level print):
                        // only an attribute assignment could rebind one onto a
                        // receiver, which is beyond name-level evidence. Typed
                        // receivers are excluded above (#198); untyped ones
                        // route visible. Module receivers stay exempt
                        // (rich.print(...) IS the module function).
                        // EXCEPTION (fix #254, W8 BUG-4 — verify's BUG-BX rule
                        // in the engine, range-based): a receiver naming a
                        // namespace/module block that CONTAINS the pinned def
                        // is a qualified function call — containment is
                        // identity evidence, and the #215 scope check ties
                        // the receiver to the containing file. Falls through
                        // to confirm with its import/scope evidence.
                        if (!typeQualifiedReceiver && targetDefs2.length > 0 &&
                            targetDefs2.every(d => !d.className && !d.receiver)) {
                            const cppQualifiedOwner =
                                fileEntry.language === 'cpp' &&
                                _cppQualifiedPathOwnsTarget(
                                    index, filePath, call, targetDefs2);
                            if (!cppQualifiedOwner &&
                                !_namespaceContainedDef(index, fileEntry, filePath,
                                    call.receiver, call.name, targetDefs2)) {
                                // Candidates here are the standalone defs the call
                                // MIGHT reach through an unmodeled module receiver
                                // (dynamic import) — methodOwnerKeys counts method
                                // owners only and reported a contradictory 0
                                // (fix #230).
                                routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                    dispatchCandidates: methodOwnerKeys().size ||
                                        targetDefs2.filter(d => !NON_CALLABLE_TYPES.has(d.type)).length,
                                });
                                continue;
                            }
                        }
                        // External-contract single owner (fix #210): same
                        // physics as the nominal gate above — an override
                        // marker proves the name exists on a contract UCN
                        // cannot see, so the receiver could be any external
                        // subtype. Checked before the multi-owner branch
                        // only via owner count (===1) being its precondition.
                        const extContract = !typeQualifiedReceiver &&
                            externalContractTarget();
                        if (extContract) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                ...(extContract.via && { dispatchVia: extContract.via }),
                                externalContract: true,
                            });
                            continue;
                        }
                        // Universal-contract names (fix #265): Object.prototype
                        // (JS) / object dunders (Python) — every external value
                        // satisfies the call, so unique project ownership below
                        // is not receiver evidence. Demote-only.
                        if (!typeQualifiedReceiver && _universalMethodName(fileEntry.language, call.name)) {
                            const univVia = call.receiverType || fieldHopType || fieldDispatchType;
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: univVia ||
                                    `${_universalRootName(fileEntry.language)} — builtin contract`,
                                externalContract: true,
                            });
                            continue;
                        }
                        if (!typeQualifiedReceiver && methodOwnerKeys().size > 1) {
                            const knownDispatchType = call.receiverType || fieldHopType || fieldDispatchType;
                            if (knownDispatchType) {
                                // Known-but-unvalidated type (supertype of the
                                // target — dynamic dispatch — or an alias/
                                // interface name UCN can't validate, or a
                                // declared-field hop type, fix #219): a
                                // possible dispatch edge, attributed via the
                                // receiver's declared type (#204 physics).
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: knownDispatchType,
                                    dispatchCandidates: countDispatchCandidates(knownDispatchType),
                                });
                            } else {
                                routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                    dispatchCandidates: methodOwnerKeys().size,
                                });
                            }
                            continue;
                        }
                    } else if (!calledAs && !call.isConstructor &&
                        targetDefs2.length > 0 && targetDefs2.every(d => d.className)) {
                        routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                            dispatchCandidates: methodOwnerKeys().size,
                        });
                        continue;
                    }
                }

                // Receiver-less counterpart of the gate's arityNoFit guard
                // (fix #229): a bare/package-qualified wrong-arity call may
                // reach the mismatch band only on compiler-grade NAME evidence
                // — an import binding of the name resolving to a target file
                // (a `use`/static-import pins the name, so the wrong arity is
                // a broken call site, not another target). Scope-match alone
                // cannot carry it: the arity disproves the project-side match,
                // so the call more likely binds code UCN cannot see.
                if (arityNoFit && !call.isMethod) {
                    let arityNameEvidence = false;
                    const tFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                    for (const im of (fileEntry.importBindings || [])) {
                        if (im.name !== call.name) continue;
                        const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[String(im.module || '')];
                        if (rel && tFiles.has(path.join(index.root, rel))) {
                            arityNameEvidence = true;
                            break;
                        }
                    }
                    // C/C++ bind free-function names through the current
                    // translation unit and included declarations rather than
                    // importBindings. A wrong-arity call to a same-file
                    // definition, or to an included header declaration whose
                    // callable shape agrees with the pinned implementation,
                    // is a compiler error at THIS target — exactly the site
                    // `check` must report. Do not extend this to member targets
                    // or unrelated project files: `write(...)` may still be a
                    // libc function that merely shares a project spelling.
                    if (!arityNameEvidence &&
                        (fileEntry.language === 'c' || fileEntry.language === 'cpp') &&
                        targetDefs.length > 0 && targetDefs.every(definition =>
                            !definition.className && !definition.receiver)) {
                        arityNameEvidence = tFiles.has(filePath);
                        if (!arityNameEvidence) {
                            const contractKey = definition => {
                                const params = definition.paramsStructured;
                                if (!Array.isArray(params)) return null;
                                const types = params.map(param =>
                                    String(param?.type || '?')
                                        .replace(/\s+/g, ' ').trim()).join(',');
                                return `${definition.namespace || ''}\0${params.length}\0${types}`;
                            };
                            const targetContracts = new Set(targetDefs
                                .map(contractKey).filter(Boolean));
                            arityNameEvidence = definitions.some(definition => {
                                if (definition.className || definition.receiver ||
                                    definition.file === filePath) return false;
                                const key = contractKey(definition);
                                return key && targetContracts.has(key) &&
                                    _importReaches(index, filePath,
                                        new Set([definition.file]));
                            });
                        }
                    }
                    if (!arityNameEvidence) {
                        recordExcluded(filePath, call.line, 'arity-mismatch');
                        continue;
                    }
                }

                if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
                pendingByFile.get(filePath).push({
                    call, fileEntry, callerSymbol,
                    isMethod: call.isMethod || !!resolvedBySameClass,
                    // Function references can resolve through the plain binding
                    // path too (e.g. JS `arr.map(helper)` with a local binding) —
                    // surface the parser's marker on the edge (fix #221). JSX
                    // component usage is the same shape (fix #265): `<App />`
                    // compiles to jsx(App, ...) — a reference the runtime
                    // invokes, not direct call syntax.
                    isFunctionReference: !!(call.isFunctionReference || call.isJsxComponent),
                    receiver: call.receiver,
                    receiverType: call.receiverType,
                    calledAs,
                    _evidence: {
                        hasBindingId: !!bindingId,
                        resolvedBySameClass: !!resolvedBySameClass && !resolvedByTypedAttribute,
                        hasSamePackageEvidence,
                        // Method calls where binding resolution was skipped (non-self receiver)
                        // and the receiver has no binding evidence → uncertain (JS/TS/Python only)
                        isUncertain: !!isUncertain || uncertainMethodReceiver,
                        // Only a receiver type that was validated against the
                        // pinned target earns receiver-hint confidence. Raw
                        // nominal annotations may name an interface, external
                        // type, or unresolved same-name owner; declared-field
                        // hops and local inference participate once validated.
                        hasReceiverType: !!(receiverTypeValidated ||
                            resolvedByTypedAttribute || nominalInferredMatch ||
                            resolvedByExtensionMethod ||
                            call.csharpConstructorExact),
                        hasReceiverEvidence: !!(call.receiver &&
                            (fileEntry.bindings || []).some(b => b.name === call.receiver)),
                        hasImportEvidence: !!bindingId || hasImportLink || !!call.moduleOwnedPath,
                        // The dispatch gates above have already rejected
                        // external contracts, universal methods, wrong arity,
                        // unresolved producer flow, and multi-owner names.
                        // What remains with exactly one project owner is
                        // positive project-scope identity evidence.
                        hasSingleOwnerEvidence: !!(collectAccount && call.isMethod &&
                            !call.inMacroDefinition && !call.isMacro &&
                            !call.receiverType && !fieldHopType &&
                            !fieldDispatchType && !call.receiverExternalFlow &&
                            !call.receiverQualifiedFlow &&
                            targetDefs2.some(d => !NON_CALLABLE_TYPES.has(d.type) &&
                                (d.className || d.receiver)) &&
                            methodOwnerKeys().size === 1),
                        ...(typeMismatch && { typeMismatch: true }),
                    }
                });
                pendingCount++;
            }
        } catch (e) {
            // Parsing/read failures are contained by getCachedCalls(). Any
            // exception that reaches this semantic loop is an engine defect;
            // returning a partial caller set would be a high-trust lie.
            const rel = path.relative(index.root, filePath);
            e.message = `findCallers failed while analyzing ${rel}: ${e.message}`;
            throw e;
        }
    }

    if (queryProfile) {
        queryProfile.candidateScanMs = elapsedProfileMs(candidateScanStarted);
    }
    const enrichmentStarted = queryProfile ? process.hrtime.bigint() : null;

    // True total candidate count from Phase 1 (before any Phase 2 truncation).
    // Used by callers that need accurate "showing N of <total>" headers.
    const totalCount = pendingCount;
    // When needsTotal is set with a maxResults cap, only enrich the first
    // `maxResults` candidates in Phase 2 — file reads stay bounded.
    const enrichLimit = (needsTotal && maxResults) ? maxResults : Infinity;
    let enrichedCount = 0;

    // BUG-H1: shadow records for un-enriched candidates so post-call filters
    // (exclude / minConfidence) can produce an accurate total without forcing
    // a Phase-2 file read for every candidate. Each shadow has just enough
    // info to drive the filter predicates: relativePath + confidence.
    const shadowEntries = [];
    // Unverified-tier entries (collectAccount only): retained drops, rendered
    // in their own section. First `unverifiedEnrichLimit` get content + caller
    // lookup; the rest stay shadow-style (file/line/reason only).
    const unverifiedEntries = [];
    let unverifiedEnriched = 0;

    // Phase 2: Read content only for files with matching calls (eliminates ~98% of file reads)
    for (const [filePath, pending] of pendingByFile) {
        let content = null;
        for (const { call, fileEntry, callerSymbol, isMethod, isFunctionReference,
            isTypeReference, receiver, receiverType, calledAs, _evidence, _tier,
            _reason, _meta } of pending) {
            const scored = scoreEdge(_evidence || {});
            // Family B contract field (fix #221): a bind/call/apply site reaches
            // the target through Function.prototype indirection, not direct call
            // syntax — label the edge calledAs:'bound'. Rename aliases keep their
            // surface name (they describe the same slot and are rarer). Label
            // only, computed at edge construction: routing logic never sees it.
            const edgeCalledAs = calledAs || (call.boundCall ? 'bound' : undefined);
            if (_tier) {
                // Routed unverified entry — never competes with the main
                // answer for maxResults/enrichLimit slots.
                const base = {
                    file: filePath,
                    relativePath: fileEntry.relativePath,
                    line: call.line,
                    ...(Number.isInteger(call.column) && { column: call.column }),
                    confidence: scored.confidence,
                    evidenceScore: scored.evidenceScore,
                    scoreKind: scored.scoreKind,
                    resolution: scored.resolution,
                    tier: _tier,
                    reason: _reason,
                    ...(_meta || {}),
                    isMethod: call.isMethod || false,
                    ...(isFunctionReference && { isFunctionReference: true }),
                    ...(isTypeReference && { isTypeReference: true }),
                    ...(receiver !== undefined && { receiver }),
                    ...(receiverType && { receiverType }),
                    ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                };
                if (unverifiedEnriched < unverifiedEnrichLimit) {
                    if (content === null) {
                        try { content = fs.readFileSync(filePath, 'utf-8'); }
                        catch (e) {
                            e.message = `caller enrichment read failed: ${e.message}`;
                            throw e;
                        }
                    }
                    const enclosing = index.findEnclosingFunction(filePath, call.line, true);
                    unverifiedEntries.push({
                        ...base,
                        content: getLine(content, call.line),
                        callerName: enclosing ? enclosing.name : null,
                        callerFile: enclosing ? filePath : null,
                        callerStartLine: enclosing ? enclosing.startLine : null,
                        callerEndLine: enclosing ? enclosing.endLine : null,
                    });
                    unverifiedEnriched++;
                } else {
                    unverifiedEntries.push(base);
                }
                continue;
            }
            // Tier stamped ONLY under collectAccount so trace/blast/verify
            // results stay byte-identical. A known type mismatch can never
            // tier as confirmed, whatever its resolution score says.
            const tier = collectAccount
                ? (_evidence && _evidence.typeMismatch ? TIER.UNVERIFIED : tierForResolution(scored.resolution))
                : undefined;
            if (enrichedCount >= enrichLimit) {
                // Push shadow only — no file read needed.
                shadowEntries.push({
                    file: filePath,
                    relativePath: fileEntry.relativePath,
                    line: call.line,
                    ...(Number.isInteger(call.column) && { column: call.column }),
                    confidence: scored.confidence,
                    evidenceScore: scored.evidenceScore,
                    scoreKind: scored.scoreKind,
                    resolution: scored.resolution,
                    ...(tier && { tier }),
                    isMethod: call.isMethod || false,
                    ...(isFunctionReference && { isFunctionReference: true }),
                    ...(isTypeReference && { isTypeReference: true }),
                    ...(receiver !== undefined && { receiver }),
                    ...(receiverType && { receiverType }),
                    ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                });
                continue;
            }
            // First time we hit this file's enrichment loop — read the file once.
            if (content === null) {
                try { content = fs.readFileSync(filePath, 'utf-8'); }
                catch (e) {
                    e.message = `caller enrichment read failed: ${e.message}`;
                    throw e;
                }
            }
            callers.push({
                file: filePath,
                relativePath: fileEntry.relativePath,
                line: call.line,
                ...(Number.isInteger(call.column) && { column: call.column }),
                content: getLine(content, call.line),
                callerName: callerSymbol ? callerSymbol.name : null,
                callerFile: callerSymbol ? filePath : null,
                callerStartLine: callerSymbol ? callerSymbol.startLine : null,
                callerEndLine: callerSymbol ? callerSymbol.endLine : null,
                isMethod,
                ...(isFunctionReference && { isFunctionReference: true }),
                ...(isTypeReference && { isTypeReference: true }),
                ...(receiver !== undefined && { receiver }),
                ...(receiverType && { receiverType }),
                ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                confidence: scored.confidence,
                evidenceScore: scored.evidenceScore,
                scoreKind: scored.scoreKind,
                resolution: scored.resolution,
                ...(tier && { tier }),
            });
            enrichedCount++;
        }
    }

    // Tag the returned array with the true total candidate count (only meaningful
    // when needsTotal:true was passed). Defined as non-enumerable so JSON.stringify
    // won't surprise consumers; defaults to callers.length when not set.
    Object.defineProperty(callers, 'totalCount', {
        value: needsTotal ? totalCount : callers.length,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    // Attach shadow entries so consumers can compute post-filter totals without
    // re-running findCallers. Empty when needsTotal:false or all candidates fit.
    Object.defineProperty(callers, 'shadowEntries', {
        value: shadowEntries,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    // Conservation raw data (collectAccount only): dropped-candidate lines with
    // reasons, consumed by composeAccount in analysis.js. Non-enumerable so
    // JSON.stringify of results is unaffected.
    if (accountRaw) {
        Object.defineProperty(callers, 'accountRaw', {
            value: accountRaw,
            enumerable: false,
            writable: true,
            configurable: true,
        });
        // Retained unverified-tier entries, sorted (relativePath, line) per the
        // output ordering contract.
        unverifiedEntries.sort((a, b) => {
            if (a.relativePath !== b.relativePath) return codeUnitCompare(a.relativePath, b.relativePath);
            return (a.line || 0) - (b.line || 0);
        });
        Object.defineProperty(callers, 'unverifiedEntries', {
            value: unverifiedEntries,
            enumerable: false,
            writable: true,
            configurable: true,
        });
    }

    if (queryProfile) {
        const countBy = (rows, field) => {
            const counts = {};
            for (const row of rows) {
                const key = row?.[field] || 'unspecified';
                counts[key] = (counts[key] || 0) + 1;
            }
            return counts;
        };
        queryProfile.enrichmentMs = elapsedProfileMs(enrichmentStarted);
        queryProfile.totalMs = elapsedProfileMs(profileStarted);
        queryProfile.filesWithCandidates = pendingByFile.size;
        queryProfile.candidates = pendingCount;
        queryProfile.confirmed = callers.length;
        queryProfile.unverified = unverifiedEntries.length;
        queryProfile.excluded = accountRaw?.excludedEntries?.length || 0;
        queryProfile.confirmedByResolution = countBy(callers, 'resolution');
        queryProfile.unverifiedByReason = countBy(unverifiedEntries, 'reason');
        queryProfile.excludedByReason = countBy(
            accountRaw?.excludedEntries || [], 'reason');
    }

    return callers;
    } finally { index._endOp(); }
}

/**
 * Find all symbols called from within a function definition.
 *
 * Method resolution uses receiverType when available:
 * - Go: receiverType from method receiver params + _buildTypedLocalTypeMap (New*() patterns)
 * - Java: receiverType from `new Foo()` constructors + typed parameter declarations
 * - Rust: receiverType from impl block context + _buildTypedLocalTypeMap
 * - JS/TS: receiverType from constructor calls + import binding evidence
 * - Python: receiverType from __init__ attribute type inference (getInstanceAttributeTypes)
 *
 * @param {object} index - ProjectIndex instance
 * @param {object|string} definition - Symbol definition or resolvable symbol name
 * @param {object} [options] - Options
 * @param {boolean} [options.includeMethods] - Include method calls (default: false)
 */
function findCallees(index, definition, options = {}) {
    index._beginOp();
    try {
    const queryProfile = options.profile && typeof options.profile === 'object'
        ? options.profile : null;
    const profileStarted = queryProfile ? process.hrtime.bigint() : null;
    const elapsedProfileMs = started => Number(
        (Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
    const def = typeof definition === 'string'
        ? index.resolveSymbol(definition, options).def
        : definition;
    if (!def) return [];
    if (!def.file) throw new TypeError('findCallees requires a definition with a file');
    // Lazy-load callsCache from disk if not already populated
    if (index.loadCallsCache) index.loadCallsCache();

    try {
        // Get all calls from the file's cache (now includes enclosingFunction)
        const allCalls = getCachedCalls(index, def.file);
        if (!allCalls) return [];

        // A file can contain hundreds of symbols and thousands of calls.
        // Reachability invokes findCallees once per reachable symbol; scanning
        // the full file for every symbol made that walk O(symbols*calls)
        // (14-16s on clap). Restrict the resolution loop and local-type scan
        // to this definition's source range. Nested closures deliberately
        // remain in the slice and retain the existing inner-symbol rules.
        const calls = _callsInDefinitionRange(index, def.file, allCalls,
            def.startLine, def.endLine);
        // The reachability walk uses the legacy (non-accounting) path and most
        // entry/test symbols contain no calls. Avoid constructing receiver,
        // overload, and flow machinery for an empty source range. Contract
        // callers still run below so they receive the explicit zero-site
        // callee account object.
        if (calls.length === 0 && !options.collectAccount) return [];

        // Get file language for smart method call handling
        const fileEntry = index.files.get(def.file);
        const language = fileEntry?.language;

        // Build list of inner class/struct method ranges to exclude from callee detection.
        // Only class methods are excluded — they are independently addressable symbols.
        // Calls within closures (named functions without className) ARE included as
        // callees of the parent function, since closures are part of the parent's behavior.
        const innerSymbolRanges = fileEntry
            ? _innerClassMethodRanges(index, def, fileEntry)
            : [];

        const callees = new Map();  // key -> { name, bindingId, count }
        let selfAttrCalls = null;   // collected for Python self.attr.method() resolution
        let selfMethodCalls = null; // collected for Python self.method() resolution

        // Callee conservation account (trace-down contract): every call record
        // in the def's scope lands in exactly one bucket — confirmed callee
        // edge, retained unverified entry (visible, with reason), external/
        // builtin, excluded-with-reason, or display-filtered. The unit is the
        // call RECORD (a line may hold several); siteIds (record ordinals)
        // keep the arithmetic exact when one record yields multiple edges
        // (same-name overload fan-out). collectAccount-gated: legacy callers
        // of findCallees (context/about/smart) see byte-identical results.
        const collectAccount = !!options.collectAccount;
        const calleeAccount = collectAccount ? {
            totalSites: 0,
            confirmed: 0,
            unverified: 0,
            external: { count: 0, sample: [] },
            excluded: { total: 0, byReason: {} },
            filtered: { count: 0, byReason: {} },
        } : null;
        const claimedSiteIds = collectAccount ? new Set() : null;
        const unverifiedCallees = collectAccount ? new Map() : null; // name|reason -> entry
        const noteSite = (siteId, bucket, reason, call) => {
            if (!calleeAccount || claimedSiteIds.has(siteId)) return;
            claimedSiteIds.add(siteId);
            if (bucket === 'confirmed') {
                calleeAccount.confirmed++;
            } else if (bucket === 'unverified') {
                calleeAccount.unverified++;
            } else if (bucket === 'external') {
                calleeAccount.external.count++;
                if (call && calleeAccount.external.sample.length < 3) {
                    calleeAccount.external.sample.push({ name: call.name, line: call.line });
                }
            } else if (bucket === 'excluded') {
                const r = reason || 'excluded';
                calleeAccount.excluded.total++;
                if (!calleeAccount.excluded.byReason[r]) calleeAccount.excluded.byReason[r] = 0;
                calleeAccount.excluded.byReason[r]++;
            } else if (bucket === 'filtered') {
                const r = reason || 'filtered';
                calleeAccount.filtered.count++;
                if (!calleeAccount.filtered.byReason[r]) calleeAccount.filtered.byReason[r] = 0;
                calleeAccount.filtered.byReason[r]++;
            }
        };
        // Retain an uncertain/unresolved call as a visible unverified callee
        // entry (aggregated by name+reason) and claim its site.
        const noteUnverified = (siteId, call, reason, meta = {}) => {
            if (!collectAccount || claimedSiteIds.has(siteId)) return;
            noteSite(siteId, 'unverified', reason, call);
            const key = `${call.name}|${reason}|${meta.dispatchVia || ''}`;
            let entry = unverifiedCallees.get(key);
            if (!entry) {
                const defs = index.symbols.get(call.name) || [];
                const owners = defs.filter(s => !NON_CALLABLE_TYPES.has(s.type)).length;
                entry = { name: call.name, reason, callCount: 0, sites: [], ownerCount: owners, ...meta };
                unverifiedCallees.set(key, entry);
            }
            entry.callCount++;
            entry.sites.push(call.line);
        };
        // A statically selected base implementation is not the only runtime
        // target in languages with virtual/structural dispatch. If a project
        // descendant overrides the method, the call site must stay visible as
        // possible-dispatch instead of being presented as an exact callee.
        // This is contract-only so legacy traversal remains byte-compatible.
        const routeVirtualOverride = (siteId, call, receiverType, match) => {
            if (!collectAccount || !match) return false;
            const traits = langTraits(language);
            const matchedOwner = match.className || (match.receiver && match.receiver.replace(/^\*/, ''));
            if (!matchedOwner) return false;

            let dispatchBase = receiverType || matchedOwner;
            const explicitContract = _isDispatchContractType(index, dispatchBase);
            // Go is nominal in UCN's receiver-resolution taxonomy, but its
            // interfaces dispatch structurally and are satisfied implicitly.
            // A project interface is therefore a virtual boundary even though
            // there is no implements edge in the graph.
            if (traits?.typeSystem !== 'structural' && !traits?.allMethodsVirtual &&
                !explicitContract) return false;
            if (explicitContract) {
                const candidates = _countDispatchCandidates(
                    index, dispatchBase, index.symbols.get(call.name) || []);
                noteUnverified(siteId, call, 'possible-dispatch', {
                    dispatchVia: dispatchBase,
                    dispatchCandidates: Math.max(1, candidates),
                });
                return true;
            }
            let owners = _descendantOverrideOwners(index, dispatchBase, call.name);
            // Structural aliases/generic heads (for example ZodTypeAny) may
            // have no inheritance node of their own. When the statically
            // selected declaration lives on an ancestor, use that declaration
            // owner as the conservative virtual-dispatch boundary. Do not do
            // this for a concrete class: an exact Child receiver cannot become
            // an unrelated sibling of Child.
            if (owners.size === 0 && dispatchBase !== matchedOwner) {
                const typeDefs = index.symbols.get(dispatchBase) || [];
                const isConcreteClass = typeDefs.some(d =>
                    d.type === 'class' || d.type === 'struct' || d.type === 'impl');
                if (!isConcreteClass) {
                    dispatchBase = matchedOwner;
                    owners = _descendantOverrideOwners(index, dispatchBase, call.name);
                }
            }
            if (owners.size === 0) return false;
            noteUnverified(siteId, call, 'possible-dispatch', {
                dispatchVia: dispatchBase,
                dispatchCandidates: owners.size + 1,
            });
            return true;
        };

        // Build local variable type map for receiver resolution
        // Scans for patterns like: bt = Backtester(...) → bt maps to Backtester
        let localTypes = null;
        if (langTraits(language)?.typeSystem === 'structural') {
            localTypes = _buildLocalTypeMap(index, def, calls);
        } else if (langTraits(language)?.typeSystem === 'nominal') {
            localTypes = _buildTypedLocalTypeMap(index, def, calls);
        }

        // Return-type flow map (lazy — only built if a single-owner
        // resolution needs the external-producer/typed-receiver defeater).
        let _flowMap;
        const flowMap = () => {
            if (_flowMap === undefined) {
                if (queryProfile) {
                    queryProfile.returnFlowBuilds =
                        (queryProfile.returnFlowBuilds || 0) + 1;
                }
                _flowMap = _buildReturnTypeFlowMap(index, def.file, allCalls);
            }
            return _flowMap;
        };
        // Return flow can type only a value receiver assigned from an earlier
        // producer call. Lexical receivers, module/type paths, and chain roots
        // already carry stronger identity and must not trigger a whole-file
        // flow build merely because their parser record lacks receiverType.
        const mayNeedDirectReceiverFlow = call =>
            call.isMethod && call.receiver && !call.receiverType &&
            !call.receiverPatternShadow &&
            !RESERVED_RECEIVER_NAMES.has(call.receiver) &&
            !call.isPathCall && !call.receiverIsModule &&
            !call.receiverIsChainRoot;
        // Chained-receiver fold context (fix #268 — the #258 rails, callee
        // direction): built lazily, shared across this def's records.
        let calleeFoldCtx = null;
        const foldCtx = () => {
            if (!calleeFoldCtx) {
                calleeFoldCtx = { memo: new Map(), visiting: new Set(), records: calls,
                    getFlowMap: () => flowMap() };
            }
            return calleeFoldCtx;
        };

        let siteOrdinal = -1;
        for (const call of calls) {
            siteOrdinal++;
            const siteId = siteOrdinal;
            // Filter to calls within this function's scope
            // Method 1: Direct match via enclosingFunction (fast path for direct calls)
            const isDirectMatch = call.enclosingFunction &&
                call.enclosingFunction.startLine === def.startLine;
            // Method 2: Line-range containment (catches calls inside nested callbacks/closures)
            // A call is in our scope if it's within our line range AND not inside a named inner symbol
            const isInRange = call.line >= def.startLine && call.line <= def.endLine;
            const isInInnerSymbol = isInRange && innerSymbolRanges.some(
                ([start, end]) => call.line >= start && call.line <= end);
            const isNestedCallback = isInRange && !isInInnerSymbol && !isDirectMatch;

            if (!isDirectMatch && !isNestedCallback) continue;
            if (calleeAccount) calleeAccount.totalSites++;

            if (call.macroParameter) {
                noteSite(siteId, 'excluded', 'macro-parameter', call);
                continue;
            }

            // C# extension methods are statically resolved compiler calls,
            // despite using instance-call syntax. Resolve them before the
            // ordinary receiver-owner path: the receiver type matches the
            // declaration's first `this` parameter, not its static container
            // class (`"x".Wrap()` -> StringExtensions.Wrap).
            if (language === 'csharp' && call.isMethod && call.receiverType) {
                const extensions = (index.symbols.get(call.name) || []).filter(candidate =>
                    _calleeLanguageCompatible(index, candidate, language) &&
                    _csharpExtensionCallMatches(
                        index, def.file, fileEntry, call, [candidate]));
                if (extensions.length > 0) {
                    const selected = _calleeOverloadSelect(
                        index, call, extensions, language);
                    if (selected.match) {
                        const match = selected.match;
                        const key = match.bindingId ||
                            `${match.file}:${match.startLine}:${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) {
                                existing.sites.push(call.line);
                                existing.siteIds.push(siteId);
                            }
                        } else {
                            callees.set(key, {
                                name: call.name,
                                bindingId: match.bindingId,
                                count: 1,
                                ...(collectAccount && {
                                    sites: [call.line],
                                    siteIds: [siteId],
                                }),
                            });
                        }
                    } else {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                    }
                    continue;
                }
            }

            // A deep member receiver whose root type is unknown
            // (`client.req.query()`) cannot bind through the enclosing file's
            // symbol table. Preserve the call as visible uncertainty on the
            // contract surface; legacy/non-account traversal abstains.
            if (call.isMethod && call.receiverDeepPath && !call.receiverType) {
                if (collectAccount) {
                    noteUnverified(siteId, call, 'method-ambiguous');
                }
                continue;
            }

            // Parser-proven lexical shadow: a parameter/local named `option`
            // cannot call an imported/project `option`. A nested local
            // function — or a nested CLASS, whose bare name constructs it
            // (fix #286f, flask-measured: `class Foo` inside test_custom_tag,
            // `Foo("bar")` excluded local-shadow while the oracle pins the
            // nested class) — is the safe exception and remains eligible for
            // exact same-file resolution below.
            if (call.localShadow && !call.resolvedName && !call.resolvedNames) {
                const localTarget = (index.symbols.get(call.name) || []).some(s =>
                    s.file === def.file &&
                    (s.type === 'class' || !NON_CALLABLE_TYPES.has(s.type)) &&
                    s.startLine >= def.startLine && s.endLine <= def.endLine &&
                    s.startLine <= call.line);
                if (!localTarget) {
                    noteSite(siteId, 'excluded', 'local-shadow', call);
                    continue;
                }
            }

            // Query-time return flow for an ordinary receiver assignment:
            // `v := New(); v.ReadConfig()`. The compiler-declared return type
            // is stronger than constructor-name guesses and must participate
            // in callee identity just as it already does for callers.
            const directReceiverFlow = mayNeedDirectReceiverFlow(call)
                ? _lookupReturnTypeFlow(flowMap(), call)
                : undefined;

            // Declared-field receiver hop (fix #231 — callee-side parity
            // with the caller side's #202/#219): `tm.service.Save()` /
            // `this._map.has()` records carry receiverRoot/receiverField —
            // resolve the field's DECLARED type and treat it exactly like a
            // parser-inferred receiverType. this-rooted structural hops
            // resolve the root at query time (the enclosing class — arrows
            // keep lexical `this`; nested function declarations are their
            // own symbols without className, so dynamic-this shapes resolve
            // to nothing). _declaredFieldType's guards apply: interface/
            // trait-typed and generic-param fields return null.
            let fieldHopType = null;
            let fieldHopInfo = null;
            let fieldDispatchType = null;
            if (call.isMethod && !call.receiverType && call.receiverField) {
                let hopRoot = call.receiverRootType;
                if (!hopRoot && call.receiverRoot && localTypes?.has(call.receiverRoot)) {
                    hopRoot = localTypes.get(call.receiverRoot);
                }
                if (!hopRoot && call.receiverRoot &&
                    !RESERVED_RECEIVER_NAMES.has(call.receiverRoot)) {
                    const inferredRoot = _lookupReturnTypeFlow(flowMap(), {
                        ...call,
                        receiver: call.receiverRoot,
                    });
                    if (inferredRoot?.type) hopRoot = inferredRoot.type;
                }
                if (!hopRoot && call.receiverRoot === 'this' &&
                    langTraits(language)?.typeSystem === 'structural') {
                    hopRoot = index.findEnclosingFunction(def.file, call.line, true)?.className;
                }
                if (hopRoot) {
                    fieldHopInfo = {};
                    const fields = call.receiverFields || [call.receiverField];
                    fieldHopType = _declaredFieldPathType(index, hopRoot, fields,
                        language, fieldHopInfo, call.receiverRootNamespace);
                    // Imported Go root types outside this project have no
                    // indexed field table. The attempted field hop is still
                    // owned by that external type and must not fall through
                    // to a same-name project method's single-owner shortcut.
                    if (!fieldHopType && language === 'go') {
                        const qualified = String(hopRoot).replace(/^\*+/, '')
                            .match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
                        const qualifier = call.receiverRootTypeQualifier ||
                            qualified?.[1];
                        const bare = qualified?.[2] ||
                            String(hopRoot).replace(/^\*+/, '');
                        if (qualifier && bare) {
                            const hasProjectType = (index.symbols.get(bare) || [])
                                .some(candidate => IDENTITY_TYPE_KINDS.has(candidate.type));
                            const origin = _resolveFlowTypeOrigin(
                                index, def.file, bare, qualifier);
                            if ((!hasProjectType || !origin?.fromFile) &&
                                _goQualifierNamesImport(index, def.file, qualifier)) {
                                fieldHopInfo.externalVia = `${qualifier}.${bare}`;
                            }
                        }
                    }
                    if (!fieldHopType) {
                        if (fields.length === 1) {
                            fieldDispatchType = _declaredFieldInterfaceType(
                                index, hopRoot, call.receiverField, language,
                                call.receiverRootNamespace);
                        }
                    }
                }
            }

            if (fieldDispatchType) {
                noteUnverified(siteId, call, 'possible-dispatch', {
                    dispatchVia: fieldDispatchType,
                    dispatchCandidates: _countDispatchCandidates(
                        index, fieldDispatchType, index.symbols.get(call.name) || []),
                });
                continue;
            }

            if (language === 'csharp' && call.isMethod && fieldHopType) {
                const extensionCall = { ...call, receiverType: fieldHopType };
                const extensions = (index.symbols.get(call.name) || []).filter(candidate =>
                    _calleeLanguageCompatible(index, candidate, language) &&
                    _csharpExtensionCallMatches(
                        index, def.file, fileEntry, extensionCall, [candidate]));
                if (extensions.length > 0) {
                    const selected = _calleeOverloadSelect(
                        index, extensionCall, extensions, language);
                    if (selected.match) {
                        const match = selected.match;
                        const key = match.bindingId ||
                            `${match.file}:${match.startLine}:${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) {
                                existing.sites.push(call.line);
                                existing.siteIds.push(siteId);
                            }
                        } else {
                            callees.set(key, {
                                name: call.name,
                                bindingId: match.bindingId,
                                count: 1,
                                ...(collectAccount && {
                                    sites: [call.line],
                                    siteIds: [siteId],
                                }),
                            });
                        }
                    } else {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                    }
                    continue;
                }
            }

            if (call.isMethod && call.receiverField && !call.receiverType &&
                !fieldHopType &&
                ['javascript', 'typescript', 'tsx', 'html'].includes(language)) {
                if (collectAccount) {
                    noteUnverified(siteId, call, 'method-ambiguous');
                }
                continue;
            }

            if (collectAccount && call.receiverCapabilityGuard &&
                call.isMethod && !call.receiverType &&
                !fieldHopType && !fieldDispatchType) {
                noteUnverified(siteId, call, 'possible-dispatch', {
                    dispatchVia:
                        `dynamic capability "${call.receiverCapabilityGuard}"`,
                    dynamicCapability: true,
                });
                continue;
            }

            if (collectAccount && language === 'go' && call.receiverRootIsModule) {
                const qualified = _goQualifiedReceiverType(
                    index, fileEntry, call.receiverRoot, call.receiverField);
                if (_calleeZeroCandidateName(index, call)) {
                    noteSite(siteId, 'external', null, call);
                } else {
                    noteUnverified(siteId, call, 'possible-dispatch', {
                        dispatchVia: qualified?.via || `${call.receiverRoot}.${call.receiverField}`,
                        ...(qualified?.kind !== 'project' && { externalContract: true }),
                    });
                }
                continue;
            }

            // Macro invocations occupy their own callable namespace/shape.
            // A same-named method or function is never the macro callee
            // (`arg!(...)` beside `.arg(...)` was resolving to ArgGroup.arg
            // in clap). Resolve a unique project macro exactly; ambiguity is
            // visible under the account contract, and absent macros are
            // external. Never fall through to generic name ranking.
            if (call.isMacro) {
                const macroDefs = (index.symbols.get(call.name) || []).filter(s =>
                    s.type === 'macro' && _calleeLanguageCompatible(index, s, language));
                const uniqueMacro = macroDefs.length === 1 ? macroDefs[0] : null;
                const macroInScope = !!uniqueMacro && (
                    (uniqueMacro.file === def.file && uniqueMacro.startLine <= call.line) ||
                    !!call.receiver ||
                    (fileEntry?.importBindings || []).some(b => b.name === call.name));
                if (uniqueMacro && macroInScope) {
                    const match = uniqueMacro;
                    const key = match.bindingId || `${match.file}:${match.startLine}:${call.name}`;
                    const existing = callees.get(key);
                    if (existing) {
                        existing.count += 1;
                        if (collectAccount) {
                            existing.sites.push(call.line);
                            existing.siteIds.push(siteId);
                        }
                    } else {
                        callees.set(key, {
                            name: call.name,
                            bindingId: match.bindingId,
                            count: 1,
                            ...(collectAccount && { sites: [call.line], siteIds: [siteId] }),
                        });
                    }
                } else if (macroDefs.length > 1) {
                    noteUnverified(siteId, call, 'macro-ambiguous');
                } else if (uniqueMacro) {
                    noteUnverified(siteId, call, 'macro-scope-unknown');
                } else {
                    noteSite(siteId, 'external', null, call);
                }
                continue;
            }

            // Go package-qualified receiver: resolve the import module up
            // front so the dispatch chain can tell package calls apart from
            // type-qualified method expressions (fix #236 — a receiver that
            // is neither stays eligible for type-qualified resolution below).
            let goImportModule = null;
            if (call.receiver && langTraits(language)?.hasReceiverPackageCalls) {
                const goImports = fileEntry?.imports || [];
                const goImportNames = fileEntry?.importNames || [];
                // Handle Go version suffixes: k8s.io/klog/v2 → klog, not v2
                // fix #268 (chi-measured): computed for NON-method records
                // too — the parser marks `context.WithValue(...)` isMethod:
                // false, which used to skip the whole package-ownership
                // dispatch and confirm the bare name against the project's
                // only WithValue def (middleware/value.go).
                if (goImportNames.length === goImports.length) {
                    const importIndex = goImportNames.indexOf(call.receiver);
                    if (importIndex >= 0) goImportModule = goImports[importIndex];
                }
                if (!goImportModule) {
                    goImportModule = goImports.find(mod => {
                        const parts = mod.split('/');
                        const last = parts[parts.length - 1];
                        const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
                        return pkgName === call.receiver;
                    }) || null;
                }
            }

            // Type-qualified receiver resolution (fix #236): the receiver
            // NAMES a type — Foo::new() / Kit.make() / Helper.process().
            // Only consulted when no stronger evidence (local type, parser
            // receiverType, field hop, import package) claims the call.
            let typeQual = null;
            if (call.isMethod && !call.isConstructor && call.receiver &&
                !call.receiverType && !fieldHopType && !goImportModule &&
                !call.receiverIsModule && !call.selfAttribute &&
                !RESERVED_RECEIVER_NAMES.has(call.receiver) &&
                !(localTypes && localTypes.has(call.receiver))) {
                typeQual = _calleeTypeQualifiedReceiver(index, def, fileEntry, call, language);
            }

            // Package-qualified NON-method records (fix #268, chi-measured):
            // the parser marks `context.WithValue(...)` isMethod:false, so it
            // used to skip the package-ownership dispatch entirely and
            // confirm as a bare name (the project's only WithValue def).
            // The qualifier owns the name (#206/#209): resolve into the
            // imported package or route external — never bare-name scope.
            if (!call.isMethod && goImportModule && !call.isFunctionReference) {
                const match = _calleeGoPackageMatch(index, call, goImportModule);
                if (match) {
                    const key = match.bindingId || `${call.receiver}.${call.name}`;
                    const existing = callees.get(key);
                    if (existing) {
                        existing.count += 1;
                        if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                    } else {
                        callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                            ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                    }
                } else {
                    noteSite(siteId, 'external', null, call);
                }
                continue;
            }

            // Smart method call handling:
            // - Go: include all method calls (Go doesn't use this/self/cls)
            // - self/this.method(): resolve to same-class method (handled below)
            // - Python self.attr.method(): resolve via selfAttribute (handled below)
            // - Other languages: skip method calls unless explicitly requested
            if (call.isMethod) {
                if (call.selfAttribute && language === 'python') {
                    // Will be resolved in second pass below
                } else if (['self', 'cls', 'this'].includes(call.receiver) ||
                           (call.receiver === 'Self' && language === 'rust')) {
                    // self.method() / cls.method() / this.method() — resolve to same-class method below
                    // Rust Self::method() resolves same-impl the same way (fix #236, the #232 callee analog)
                } else if (call.receiver === 'super' || call.receiver === 'base') {
                    // super().method() — resolve to parent class method below
                } else if (directReceiverFlow?.externalVia) {
                    if (directReceiverFlow.externalConcrete) {
                        noteSite(siteId, 'external', 'external-package', call);
                    } else {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: directReceiverFlow.externalVia,
                            externalContract: true,
                        });
                    }
                    continue;
                } else if (!call.receiverType && localTypes &&
                    localTypes.has(call.receiver) && !directReceiverFlow?.type) {
                    // Resolve method calls on locally-constructed objects:
                    // bt = Backtester(...); bt.run_backtest() → Backtester.run_backtest
                    // Go: f.Run() where f is *Framework → Framework.Run (receiver match)
                    const typeName = localTypes.get(call.receiver);
                    const symbols = index.symbols.get(call.name);
                    const qualifiedType = language === 'go'
                        ? _goQualifiedReceiverType(index, fileEntry,
                            call.receiverTypeQualifier, typeName)
                        : null;
                    const qualifiedContract = qualifiedType?.kind === 'project' &&
                        qualifiedType.defs.some(d => d.type === 'interface' || d.type === 'trait');
                    if (qualifiedType && (qualifiedType.kind !== 'project' || qualifiedContract)) {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: qualifiedType.via,
                            dispatchCandidates: _countDispatchCandidates(index, typeName, symbols || []),
                            ...(qualifiedType.kind !== 'project' && { externalContract: true }),
                        });
                        continue;
                    }
                    if (!qualifiedType && _isDispatchContractType(index, typeName)) {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: typeName,
                            dispatchCandidates: _countDispatchCandidates(index, typeName, symbols || []),
                        });
                        continue;
                    }
                    const isCallable = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
                        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
                    // Same-class overloads select by static call shape —
                    // arity, then Java argKinds (fix #268); an undecidable
                    // family routes visible instead of binding defs[0].
                    const sel = _calleeSelectReceiverMethod(
                        index, call, symbols || [], typeName, language, def.file,
                        isCallable);
                    if (sel.ambiguous) {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                        continue;
                    }
                    const match = sel.match;
                    if (match) {
                        if (routeVirtualOverride(siteId, call, typeName, match)) continue;
                        const key = match.bindingId || `${typeName}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                        }
                    } else if (_nonCallableFieldMember(index, typeName, call.name, language)) {
                        // The known receiver type declares the name as its own
                        // non-callable FIELD — a member reference, never a
                        // callee (fix #231: `delete(cs.cache, key)` captured
                        // cs.cache as a method-value callee; cache is
                        // CacheService's map-typed field, which shadows any
                        // same-named project function through this receiver).
                        noteSite(siteId, 'excluded', 'member-reference', call);
                    } else if (_calleeZeroCandidateName(index, call)) {
                        // fix #261: the type defines no such method AND the
                        // name has zero project defs anywhere — external.
                        noteSite(siteId, 'external', null, call);
                    } else if (collectAccount) {
                        // Locally-typed receiver, but the type defines no such
                        // method in the index — visible, never silently dropped.
                        noteUnverified(siteId, call, 'uncertain-receiver');
                    }
                    continue;
                } else if (call.receiverType || directReceiverFlow?.type ||
                    fieldHopType || fieldHopInfo?.externalVia) {
                    // Use parser-inferred receiverType for method resolution
                    // Go/Java/Rust: from param/receiver type declarations
                    // JS/TS: from `new Foo()` assignments or TypeScript type annotations
                    // Python: from constructor calls or type annotations
                    // fieldHopType: the declared type of a one-hop field
                    // receiver (fix #231 — tm.service.Save() resolves Save
                    // through the `service *DataService` declaration)
                    if (!call.receiverType && !fieldHopType && fieldHopInfo?.externalVia) {
                        // Provably-external declared field type (fix #268,
                        // chi-measured: `pool *sync.Pool`, `inner
                        // http.Handler`) — never bare-name identity. Visible
                        // when project owners of the name exist (an external
                        // interface may dispatch into a project impl),
                        // external otherwise.
                        if ((index.symbols.get(call.name) || []).some(s => !NON_CALLABLE_TYPES.has(s.type))) {
                            noteUnverified(siteId, call, 'possible-dispatch');
                        } else {
                            noteSite(siteId, 'external', null, call);
                        }
                        continue;
                    }
                    const typeName = call.receiverType || directReceiverFlow?.type || fieldHopType;
                    const symbols = index.symbols.get(call.name);
                    const qualifiedType = language === 'go' && call.receiverType
                        ? _goQualifiedReceiverType(index, fileEntry,
                            call.receiverTypeQualifier, typeName)
                        : null;
                    const qualifiedContract = qualifiedType?.kind === 'project' &&
                        qualifiedType.defs.some(d => d.type === 'interface' || d.type === 'trait');
                    if (qualifiedType && (qualifiedType.kind !== 'project' || qualifiedContract)) {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: qualifiedType.via,
                            dispatchCandidates: _countDispatchCandidates(index, typeName, symbols || []),
                            ...(qualifiedType.kind !== 'project' && { externalContract: true }),
                        });
                        continue;
                    }
                    if (!qualifiedType && _isDispatchContractType(index, typeName)) {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: typeName,
                            dispatchCandidates: _countDispatchCandidates(index, typeName, symbols || []),
                        });
                        continue;
                    }
                    const isCallableRT = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
                        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
                    // Same-class overload selection by static call shape (fix #268)
                    const receiverOriginFile = directReceiverFlow?.fromFile ||
                        fieldHopInfo?.fromFile ||
                        (call.receiverType
                            ? _resolveFlowTypeOrigin(
                                index, def.file, typeName,
                                call.receiverTypeQualifier ||
                                    call.receiverTypeNamespace)?.fromFile
                            : null);
                    const acceptsReceiverDefinition = symbol =>
                        isCallableRT(symbol) &&
                        (!qualifiedType?.dir ||
                         (symbol.file &&
                          path.dirname(symbol.file) === qualifiedType.dir)) &&
                        (!receiverOriginFile || !symbol.file ||
                         ((language === 'java' || language === 'csharp')
                             ? symbol.file === receiverOriginFile
                             : path.dirname(symbol.file) ===
                                path.dirname(receiverOriginFile)));
                    const sel = _calleeSelectReceiverMethod(
                        index, call, symbols || [], typeName, language, def.file,
                        acceptsReceiverDefinition);
                    if (sel.ambiguous) {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                        continue;
                    }
                    const match = sel.match;
                    if (match) {
                        if (routeVirtualOverride(siteId, call, typeName, match)) continue;
                        const key = match.bindingId || `${typeName}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                        }
                        continue;
                    }
                    // No match on the typed receiver. A name the type declares
                    // as its own non-callable FIELD is a member reference,
                    // never a callee (fix #231); a builtin hop type with no
                    // project match is an external call (this._map.has on
                    // `_map: WeakMap<...>` — the #219 caller-side analog).
                    if (_nonCallableFieldMember(index, typeName, call.name, language)) {
                        noteSite(siteId, 'excluded', 'member-reference', call);
                        continue;
                    }
                    if (fieldHopType && BUILTIN_RECEIVER_TYPES.has(typeName)) {
                        noteSite(siteId, 'external', null, call);
                        continue;
                    }
                    // An ATTEMPTED field hop that resolves to a type defining
                    // no such member never falls through to name/binding
                    // resolution (fix #268 — the #265(C) rule, callee
                    // direction: `mx.pool.Get()` hop-missed and the same-file
                    // Mux.Get binding confirmed it). Zero-candidate names are
                    // external (#261); anything else stays visible.
                    if (fieldHopType) {
                        if (_calleeZeroCandidateName(index, call)) {
                            noteSite(siteId, 'external', null, call);
                        } else {
                            noteUnverified(siteId, call, 'uncertain-receiver');
                        }
                        continue;
                    }
                    if (qualifiedType?.kind === 'project') {
                        // The import pins this receiver to a concrete project
                        // package, but no exact member body is indexed there.
                        // Promotion/generation may explain the gap; never fall
                        // through to an unrelated global same-name method.
                        noteUnverified(siteId, call, 'uncertain-receiver', {
                            dispatchVia: qualifiedType.via,
                        });
                        continue;
                    }
                    // An unindexed Go receiver type may be an interface from
                    // another package. Go satisfaction is implicit, so a
                    // same-name project method is a possible runtime target,
                    // never a sound bare-name confirmation or exclusion.
                    if (collectAccount && language === 'go' &&
                        _externalGoDispatchType(index, typeName)) {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: typeName,
                            dispatchCandidates: _countDispatchCandidates(
                                index, typeName, symbols || []),
                        });
                        continue;
                    }
                    // A compiler-typed nominal receiver that does not resolve
                    // to a method on that type must never fall through to the
                    // generic same-name ranking. The receiver may name an
                    // external interface or an unindexed ancestor, so keep
                    // the dispatch visible without inventing one concrete
                    // project callee.
                    if (collectAccount && langTraits(language)?.typeSystem === 'nominal') {
                        noteUnverified(siteId, call, 'possible-dispatch', {
                            dispatchVia: typeName,
                            dispatchCandidates: _countDispatchCandidates(
                                index, typeName, symbols || []),
                        });
                        continue;
                    }
                    // Structural legacy mode retains its historical fallback.
                } else if (call.receiverCall && (!call.receiver || call.receiverIsChainRoot) && !call.isConstructor &&
                    langTraits(language)?.typeSystem === 'nominal') {
                    // Chained receiver, nominal callee direction (fix #268,
                    // chi-measured): `m.NotFound().ServeHTTP(w, r)` /
                    // `r.Context().Value(k)` — the producer's compiler-checked
                    // return annotation types the receiver (#207 rails), and
                    // an untypable chain routes visible — never bare-name or
                    // binding resolution (the same-file Mux.ServeHTTP binding
                    // confirmed a self-edge; a single-def project `Value`
                    // confirmed for context.Context's).
                    let chained = _foldChainedReceiverType(index, fileEntry, def.file, call, foldCtx());
                    if (!chained || (!chained.type && !chained.externalVia)) {
                        chained = _nominalChainedReceiverType(index, call, fileEntry, def.file);
                    }
                    if (chained?.type) {
                        const symbols = index.symbols.get(call.name);
                        const isCallableCh = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
                            (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
                        const acceptsChainedDefinition = symbol =>
                            isCallableCh(symbol) &&
                            (!chained.fromFile || !symbol.file ||
                             ((language === 'java' || language === 'csharp')
                                 ? symbol.file === chained.fromFile
                                 : path.dirname(symbol.file) ===
                                    path.dirname(chained.fromFile)));
                        const sel = _calleeSelectReceiverMethod(
                            index, call, symbols || [], chained.type, language,
                            def.file, acceptsChainedDefinition);
                        if (sel.match) {
                            const match = sel.match;
                            if (routeVirtualOverride(siteId, call, chained.type, match)) continue;
                            const key = match.bindingId || `${chained.type}.${call.name}`;
                            const existing = callees.get(key);
                            if (existing) {
                                existing.count += 1;
                                if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                            } else {
                                callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                                    ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                            }
                            continue;
                        }
                        if (sel.ambiguous) {
                            noteUnverified(siteId, call, 'overload-ambiguous');
                            continue;
                        }
                    }
                    if (_calleeZeroCandidateName(index, call)) {
                        noteSite(siteId, 'external', null, call);
                    } else if (chained?.externalVia) {
                        noteUnverified(siteId, call, 'possible-dispatch');
                    } else {
                        noteUnverified(siteId, call, 'uncertain-receiver');
                    }
                    continue;
                } else if (goImportModule) {
                    // Go package-qualified calls: klog.Infof(), wait.UntilWithContext()
                    // The receiver is an import alias (resolved above) — find
                    // definitions from that package.
                    const match = _calleeGoPackageMatch(index, call, goImportModule);
                    if (match) {
                        const key = match.bindingId || `${call.receiver}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                        }
                        continue;
                    }
                    // Import resolved but no project definition matches — external call, skip
                    noteSite(siteId, 'external', null, call);
                    continue;
                } else if (typeQual) {
                    // Type-qualified receiver (fix #236): the receiver NAMES a
                    // type, so the type owns the call — Foo::new() is Foo's
                    // new; String::new() / Math.max() are external and must
                    // never confirm a project method through a bare name
                    // binding (the caller side excludes the identical edges
                    // as path-type-mismatch — the two directions now agree).
                    if (typeQual.match) {
                        const match = typeQual.match;
                        const key = match.bindingId || `${typeQual.typeName}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                        }
                        continue;
                    }
                    if (typeQual.external) {
                        noteSite(siteId, 'external', null, call);
                        continue;
                    }
                    noteUnverified(siteId, call, typeQual.unverified);
                    continue;
                } else if (langTraits(language)?.methodCallInclusion === 'explicit' && !options.includeMethods) {
                    noteSite(siteId, 'filtered', 'method-calls-excluded', call);
                    continue;
                }

                // Contract surface: an untyped nominal receiver with several
                // project owner types has no exact callee identity. File or
                // package bindings name method declarations, not the runtime
                // type of `h` in `h.ServeHTTP(...)`; letting the generic
                // lexical pass choose one fabricates a concrete edge.
                if (collectAccount && call.receiver && call.receiverExternalFlow) {
                    noteUnverified(siteId, call, 'possible-dispatch', {
                        dispatchVia: call.receiverExternalFlow,
                        externalContract: true,
                    });
                    continue;
                }
                if (collectAccount && call.receiver && !call.receiverIsModule && !call.receiverType &&
                    !call.receiverCall && !call.isPotentialCallback &&
                    !RESERVED_RECEIVER_NAMES.has(call.receiver)) {
                    const owners = new Set((index.symbols.get(call.name) || [])
                        .filter(s => !NON_CALLABLE_TYPES.has(s.type))
                        .map(s => s.className || (s.receiver && s.receiver.replace(/^\*/, '')))
                        .filter(Boolean));
                    if (owners.size > 1) {
                        noteUnverified(siteId, call, 'method-ambiguous', {
                            dispatchCandidates: owners.size,
                        });
                        continue;
                    }
                }
            }

            // Skip keywords and built-ins — EXCEPT self/super-received method
            // calls, which the same-class/super passes below resolve to real
            // definitions (fix #238: `super().__init__(x)` and the JS/TS
            // `super(...)` 'constructor' record were routed external here
            // because __init__/constructor sit in the builtin name sets).
            const selfShaped = call.isMethod &&
                (['self', 'cls', 'this', 'super', 'base'].includes(call.receiver) ||
                 (call.receiver === 'Self' && language === 'rust'));
            // Builtin/global names are shadowable. `Request` is a web global,
            // but `const Request = require('./request')` owns `new Request()`
            // in that module. Resolve explicit lexical/import bindings before
            // classifying a same-named builtin as external.
            const shadowsBuiltin = !call.receiver && (
                fileEntry?.importBindings?.some(b => b.name === call.name) ||
                fileEntry?.bindings?.some(b => b.name === call.name));
            if (!selfShaped && !call.receiverIsModule && !shadowsBuiltin &&
                index.isKeyword(call.name, language)) {
                noteSite(siteId, 'external', null, call);
                continue;
            }

            // A local alias such as `get_style = console.get_style` preserves
            // the callable relationship, but the surface spelling no longer
            // lets a definition oracle verify the target directly. Keep it
            // visible without presenting it as an exact callee.
            if (call.aliasCall) {
                noteUnverified(siteId, call, 'alias-call');
                continue;
            }

            // Use resolved name (from alias tracking) if available
            // For multi-target aliases (ternary), pick the first that exists in symbol table
            let effectiveName = call.resolvedName || call.name;
            if (call.resolvedNames) {
                for (const rn of call.resolvedNames) {
                    if (index.symbols.has(rn)) { effectiveName = rn; break; }
                }
            }

            // For potential callbacks (identifier args to non-HOF calls),
            // only include if name exists as a function in symbol table
            // AND has binding/import evidence or same-file definition.
            // Prevents local variables (request, context) from matching
            // unrelated functions defined elsewhere (especially test files).
            if (call.isPotentialCallback) {
                const syms = index.symbols.get(effectiveName);
                if (!syms || !syms.some(s =>
                    ['function', 'method', 'constructor', 'static', 'public', 'abstract'].includes(s.type))) {
                    // Argument-position name with no function definition — a
                    // local variable or data, positively not a callee edge.
                    noteSite(siteId, 'excluded', 'callback-no-evidence', call);
                    continue;
                }
                const hasBinding = fileEntry?.bindings?.some(b => b.name === call.name);
                const inSameFile = syms.some(s => s.file === def.file);
                const inSamePackage = langTraits(language)?.packageScope === 'directory' &&
                    syms.some(s => path.dirname(s.file) === path.dirname(def.file));
                if (!hasBinding && !inSameFile && !inSamePackage) {
                    noteSite(siteId, 'excluded', 'callback-no-evidence', call);
                    continue;
                }
            }

            // Collect selfAttribute calls for second-pass resolution
            if (call.selfAttribute && language === 'python') {
                if (!selfAttrCalls) selfAttrCalls = [];
                selfAttrCalls.push({ call, siteId });
                continue;
            }

            // Collect self/this.method() calls for same-class resolution
            // (Rust Self::method() resolves the same way — fix #236)
            if (call.isMethod && (['self', 'cls', 'this'].includes(call.receiver) ||
                (call.receiver === 'Self' && language === 'rust'))) {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push({ call, siteId });
                continue;
            }

            // Collect super().method() calls for parent-class resolution
            if (call.isMethod &&
                (call.receiver === 'super' || call.receiver === 'base')) {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push({ call, siteId });
                continue;
            }

            // Structural module ownership in the callee direction (the
            // caller-side #209/#217 rule). `@click.group()` resolves through
            // the imported `click` module; a same-named local decorated
            // function named `group` is receiver-blind and must never steal
            // the callee. Follow the module's name-level re-export chain and
            // add only definitions it actually exposes. Unknown CJS/dynamic
            // surfaces stay visible; external modules are external.
            if (call.isMethod && call.receiverIsModule &&
                langTraits(language)?.typeSystem === 'structural') {
                const moduleRoute = _calleeStructuralModuleRoute(index, fileEntry, call, language);
                if (moduleRoute.matches?.length) {
                    for (const match of moduleRoute.matches) {
                        const key = match.bindingId || `${match.file}:${match.startLine}:${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                        } else {
                            callees.set(key, { name: match.name, bindingId: match.bindingId, count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                        }
                    }
                    continue;
                }
                if (moduleRoute.external) {
                    noteSite(siteId, 'external', null, call);
                } else {
                    noteUnverified(siteId, call, 'no-import-link');
                }
                continue;
            }

            // Bare imported-name ownership: `import { process } from './x';
            // process()` (or Python from-import) denotes the imported export,
            // not a same-named class method in the caller file. Resolve the
            // name through the same #217 export-chain discipline used for
            // module receivers. Only intercept when an explicit binding of
            // this name exists; ordinary locals continue to lexical binding.
            if (!call.isMethod && !call.receiver &&
                langTraits(language)?.typeSystem === 'structural') {
                const importRoute = _calleeStructuralImportedNameRoute(index, fileEntry, call, language);
                if (importRoute) {
                    if (importRoute.matches?.length) {
                        for (const match of importRoute.matches) {
                            const key = match.bindingId || `${match.file}:${match.startLine}:${call.name}`;
                            const existing = callees.get(key);
                            if (existing) {
                                existing.count += 1;
                                if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                            } else {
                                callees.set(key, { name: match.name, bindingId: match.bindingId, count: 1,
                                    ...(collectAccount && { sites: [call.line], siteIds: [siteId] }) });
                            }
                        }
                    } else if (importRoute.external) {
                        noteSite(siteId, 'external', null, call);
                    } else {
                        noteUnverified(siteId, call, 'ambiguous-binding');
                    }
                    continue;
                }
            }

            // Resolve binding within this file (without mutating cached call objects)
            let calleeKey = call.bindingId || effectiveName;
            let bindingResolved = call.bindingId;
            let isUncertain = call.uncertain;
            let uncertainReason = null; // account-mode reason for the unverified bucket
            let compilerResolvedBare = false;
            if (!call.bindingId && language === 'cpp' &&
                !call.isMethod && !call.receiver && !call.isConstructor) {
                // C++ namespace/free-function lookup is declaration-order
                // sensitive. The file binding table is intentionally broad
                // and therefore contains declarations that occur later in a
                // translation unit; using it directly made a later local
                // overload steal earlier calls that actually bind an included
                // header declaration (fmt's open_buffered_file). Restrict the
                // overload set to files visible through includes and, for the
                // current file, declarations preceding the call. If several
                // compiler-visible shapes remain, preserve the ambiguity.
                const visible = _cppVisibleFiles(index, def.file);
                const candidates = (index.symbols.get(call.name) || []).filter(
                    candidate =>
                        !NON_CALLABLE_TYPES.has(candidate.type) &&
                        !candidate.className && !candidate.receiver &&
                        _calleeLanguageCompatible(index, candidate, language) &&
                        visible.has(candidate.file) &&
                        (candidate.file !== def.file ||
                            candidate.startLine <= call.line));
                if (candidates.length > 0) {
                    const selected = _calleeOverloadSelect(
                        index, call, candidates, language);
                    if (selected.ambiguous) {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                        continue;
                    }
                    if (selected.match) {
                        bindingResolved = selected.match.bindingId;
                        calleeKey = bindingResolved ||
                            `${selected.match.file}:${selected.match.startLine}:${call.name}`;
                        compilerResolvedBare = true;
                    } else {
                        noteUnverified(siteId, call, 'binding-ambiguous');
                        continue;
                    }
                }
            }
            if (!call.bindingId && !compilerResolvedBare && fileEntry?.bindings) {
                // A method terminal resolves through its receiver in every
                // supported language, not through a bare file/package binding.
                // This includes deep/chained structural receivers and nominal
                // calls such as Go `v.ReadConfig()` beside a package function
                // also named ReadConfig. Otherwise the bare wrapper steals the
                // exact callee before receiver evidence is considered.
                const receiverBlindMethodBinding = call.isMethod &&
                    !RESERVED_RECEIVER_NAMES.has(call.receiver);
                let bindings = receiverBlindMethodBinding ? [] :
                    fileEntry.bindings.filter(b => b.name === call.name);
                // For Go, also check sibling files in same directory (same
                // package scope). dirToFiles is rebuilt on every build and
                // cache load in canonical path order — the same iteration
                // order as the full index.files scan it replaces (this loop
                // runs per zero-binding call record, so the full scan was
                // quadratic on large repos — 1037-file grpc-go measured).
                if (bindings.length === 0 && !receiverBlindMethodBinding &&
                    langTraits(language)?.packageScope === 'directory') {
                    const dir = path.dirname(def.file);
                    for (const fp of index.dirToFiles?.get(dir) || []) {
                        if (fp === def.file) continue;
                        const fe = index.files.get(fp);
                        const sibling = (fe?.bindings || []).filter(b => b.name === call.name);
                        if (sibling.length > 0) bindings = bindings.concat(sibling);
                    }
                }
                // A constructor/composite-literal record names a type/value
                // constructor. A same-named field is never a legal target.
                // Apply after package-scope expansion so sibling fields cannot
                // re-enter the candidate set.
                if (call.isConstructor) {
                    bindings = bindings.filter(binding => binding.type !== 'field');
                }
                // Method call with no binding for the method name:
                // Different strategies by language family:
                if (bindings.length === 0 && call.isMethod) {
                    if (langTraits(language)?.typeSystem === 'structural') {
                        // A KNOWN receiver type routes before any name heuristic
                        // (fix #257 — the caller side's #198 trust rule brought to
                        // findCallees): `canonicalSymbols.set(...)` on a `new Map()`
                        // local resolved exact-binding into a test fixture's
                        // CacheService.set. Builtin-typed receivers are host calls;
                        // a receiver typed to a project class resolves to that class
                        // (or an ancestor defining the method), never by bare name.
                        const route = _calleeReceiverTypeRoute(index, call, localTypes, language);
                        if (route?.external) {
                            noteSite(siteId, 'external', null, call);
                            continue;
                        } else if (route?.resolve) {
                            const rawType = call.receiverType || localTypes?.get(call.receiver);
                            if (routeVirtualOverride(siteId, call, rawType, route.resolve)) continue;
                            bindingResolved = route.resolve.bindingId;
                            calleeKey = bindingResolved ||
                                `${route.resolve.className}.${effectiveName}`;
                        } else if (route?.uncertain) {
                            isUncertain = true;
                            uncertainReason = 'uncertain-receiver';
                        } else {
                        // JS/TS/Python: lexical existence of `receiver` proves
                        // only that the variable is in scope, not which class
                        // owns its terminal method. Typed/local-constructor
                        // evidence was already handled by the route above;
                        // module ownership was handled before binding lookup.
                        // Everything left is uncertain. The single-owner rule
                        // below may still promote names with exactly one
                        // project owner, but a multi-owner call such as
                        // `catchall._parse()` must never bind defs[0].
                        const defs = index.symbols.get(call.name) || [];
                        const owners = new Set(defs.filter(d => !NON_CALLABLE_TYPES.has(d.type))
                            .map(d => d.className || (d.receiver && d.receiver.replace(/^\*/, '')))
                            .filter(Boolean));
                        if (owners.size > 1) {
                            isUncertain = true;
                            uncertainReason = 'method-ambiguous';
                        } else {
                            isUncertain = true;
                            uncertainReason = 'uncertain-receiver';
                        }
                        }
                    } else {
                        // Go/Java/Rust: nominal type systems make single-def method links
                        // reliable. Only mark uncertain when multiple definitions exist
                        // (cross-type ambiguity, e.g. TypeA.Length vs TypeB.Length).
                        const defs = index.symbols.get(call.name);
                        if (defs && defs.length > 1) {
                            // Go: if receiverType is known, check if it matches exactly one def
                            // This resolves ambiguity like Framework.Run vs Scheduler.Run
                            const rType = call.receiverType || fieldHopType || localTypes?.get(call.receiver);
                            if (rType && langTraits(language)?.typeSystem === 'nominal') {
                                const matchingDef = defs.find(d =>
                                    (d.className === rType ||
                                    (d.receiver && d.receiver.replace(/^\*/, '') === rType)) &&
                                    _calleeLanguageCompatible(index, d, language));
                                if (matchingDef) {
                                    // Resolved to specific type — not uncertain
                                    calleeKey = matchingDef.bindingId || `${rType}.${call.name}`;
                                    bindingResolved = matchingDef.bindingId;
                                } else {
                                    isUncertain = true;
                                    uncertainReason = 'method-ambiguous';
                                }
                            } else {
                                isUncertain = true;
                                uncertainReason = 'method-ambiguous';
                            }
                        }
                    }
                }
                if (!call.isMethod && !call.isConstructor && def.className &&
                    langTraits(language)?.bareCallReachesMethods) {
                    // A Java bare call in an instance method is implicit-this
                    // even when the defining member is inherited and therefore
                    // absent from this file's lexical bindings. Resolve class
                    // then ancestors; if overrides exist, retain the dispatch
                    // set visibly instead of falling through to defs[0].
                    const callSymbols = index.symbols.get(call.name) || [];
                    const selected = _calleeSelectReceiverMethod(
                        index, call, callSymbols, def.className, language,
                        def.file, symbol => !NON_CALLABLE_TYPES.has(symbol.type));
                    if (selected.ambiguous) {
                        noteUnverified(siteId, call, 'overload-ambiguous');
                        continue;
                    }
                    if (selected.match) {
                        if (routeVirtualOverride(siteId, call, def.className, selected.match)) continue;
                        const key = selected.match.bindingId ||
                            `${selected.match.className}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                            if (collectAccount) {
                                existing.sites.push(call.line);
                                existing.siteIds.push(siteId);
                            }
                        } else {
                            callees.set(key, {
                                name: call.name,
                                bindingId: selected.match.bindingId,
                                count: 1,
                                ...(collectAccount && { sites: [call.line], siteIds: [siteId] }),
                            });
                        }
                        continue;
                    }
                    if (collectAccount && bindings.length === 0) {
                        noteUnverified(siteId, call, 'binding-ambiguous');
                        continue;
                    }
                }
                if (bindings.length === 1) {
                    // For method calls with a receiver, verify the receiver plausibly
                    // matches the binding's class. Prevents plt.close() → ReportGenerator.close()
                    // when close is defined in the same file as a class method.
                    if (call.isMethod && call.receiver && bindings[0].type === 'method' &&
                        langTraits(language)?.typeSystem === 'structural') {
                        // The binding is a class method — check if the receiver could be an instance
                        const bindingSym = index.symbols.get(call.name)?.find(
                            s => s.bindingId === bindings[0].id);
                        if (bindingSym?.className) {
                            // Receiver is not a known instance of this class → uncertain
                            const receiverType = localTypes?.get(call.receiver);
                            if (receiverType !== bindingSym.className) {
                                isUncertain = true;
                            }
                        }
                    }
                    bindingResolved = bindings[0].id;
                    calleeKey = bindingResolved;
                } else if (bindings.length > 1) {
                    if (call.name === def.name && !call.isMethod &&
                        langTraits(language)?.typeSystem === 'structural') {
                        // Lexical recursion in JS/TS/Python binds the
                        // enclosing definition, even when a sibling callback
                        // or test case declares another same-named function.
                        // Selecting "all other bindings" inverted the edge:
                        // Fastify's first nested createNestedRoutes called the
                        // later test's copy instead of itself.
                        const selfBinding = bindings.find(b =>
                            b.id === def.bindingId || b.startLine === def.startLine);
                        if (selfBinding) {
                            bindingResolved = selfBinding.id || def.bindingId;
                            calleeKey = bindingResolved || `${def.file}:${def.startLine}:${def.name}`;
                        } else {
                            isUncertain = true;
                            uncertainReason = 'binding-ambiguous';
                        }
                    } else if (call.name === def.name && !call.isMethod &&
                        def.className && langTraits(language)?.bareCallReachesMethods) {
                        // Java bare calls are implicit-this calls. Even when
                        // the terminal name equals the enclosing overload,
                        // argument shape selects one member of the same-class
                        // family; spraying every overload invents edges and
                        // hides the exact dependency an agent needs.
                        const sameClassSyms = (index.symbols.get(call.name) || [])
                            .filter(s => s.className === def.className &&
                                !NON_CALLABLE_TYPES.has(s.type));
                        const selected = _calleeOverloadSelect(
                            index, call, sameClassSyms, language);
                        if (selected.ambiguous) {
                            isUncertain = true;
                            uncertainReason = 'overload-ambiguous';
                        } else if (selected.match) {
                            if (routeVirtualOverride(siteId, call, def.className, selected.match)) continue;
                            if (selected.match.bindingId === def.bindingId ||
                                selected.match.startLine === def.startLine) {
                                if (collectAccount) {
                                    const selfKey = def.bindingId ||
                                        `${def.file}:${def.startLine}:${def.name}`;
                                    const existing = callees.get(selfKey);
                                    if (existing) {
                                        existing.count += 1;
                                        existing.sites.push(call.line);
                                        existing.siteIds.push(siteId);
                                    } else {
                                        callees.set(selfKey, {
                                            name: call.name,
                                            bindingId: def.bindingId,
                                            count: 1,
                                            sites: [call.line],
                                            siteIds: [siteId],
                                        });
                                    }
                                    continue;
                                }
                                noteSite(siteId, 'excluded', 'self-recursion', call);
                                continue;
                            }
                            const matchingBinding = bindings.find(b =>
                                b.id === selected.match.bindingId ||
                                b.startLine === selected.match.startLine);
                            bindingResolved = matchingBinding?.id || selected.match.bindingId;
                            calleeKey = bindingResolved ||
                                `${def.className}.${call.name}:${selected.match.startLine}`;
                        } else {
                            isUncertain = true;
                            uncertainReason = 'binding-ambiguous';
                        }
                    } else if (call.name === def.name) {
                        // Calling same-name function (e.g., Java overloads)
                        // Add ALL other overloads as potential callees.
                        // A RECEIVER-QUALIFIED same-name call names its type
                        // (Rust `Patterns::from_low_args(...)`, Go `T.M(...)`)
                        // — resolve to the matching class's binding instead of
                        // spraying every same-name def (#223, ripgrep-measured
                        // on the callee eval arm: HiArgs::from_low_args calls
                        // three sibling types' from_low_args — every def was
                        // claimed at all three sites). Bare calls (Java
                        // implicit-this overloads) keep fanning out.
                        let otherBindings = bindings.filter(b =>
                            b.startLine !== def.startLine
                        );
                        const fanReceiver = call.receiver || call.receiverType;
                        if (fanReceiver && otherBindings.length > 0) {
                            const symsForName = index.symbols.get(call.name) || [];
                            const classMatched = otherBindings.filter(b => {
                                const bSym = symsForName.find(s => s.bindingId === b.id);
                                const cls = bSym && (bSym.className ||
                                    (bSym.receiver && bSym.receiver.replace(/^\*/, '')));
                                return cls === fanReceiver;
                            });
                            if (classMatched.length > 0) {
                                otherBindings = classMatched;
                            } else if (call.isMethod && call.receiver) {
                                // Untyped-receiver same-name method call:
                                // name-equality with the enclosing def is not
                                // receiver evidence (fix #237 — CacheService
                                // .get's `cache.get(key)` sprayed a confirmed
                                // edge onto ApiClient.get, leaking reachability
                                // credit across classes). Route through the
                                // uncertain machinery: multi-owner names stay
                                // visible method-ambiguous; the single-owner
                                // rule (with its defeaters) may still confirm.
                                isUncertain = true;
                                uncertainReason = 'method-ambiguous';
                                otherBindings = null;
                            }
                        }
                        if (otherBindings) {
                        for (const ob of otherBindings) {
                            const existing = callees.get(ob.id);
                            if (existing) {
                                existing.count += 1;
                                if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                            } else {
                                callees.set(ob.id, {
                                    name: effectiveName,
                                    bindingId: ob.id,
                                    count: 1,
                                    ...(collectAccount && { sites: [call.line], siteIds: [siteId] })
                                });
                            }
                        }
                        if (otherBindings.length === 0) {
                            // The contract surface exposes recursion as a real
                            // callee edge. Legacy graph traversal keeps its
                            // historical cycle-suppression behavior.
                            if (collectAccount) {
                                const selfKey = def.bindingId ||
                                    `${def.file}:${def.startLine}:${def.name}`;
                                const existing = callees.get(selfKey);
                                if (existing) {
                                    existing.count += 1;
                                    existing.sites.push(call.line);
                                    existing.siteIds.push(siteId);
                                } else {
                                    callees.set(selfKey, {
                                        name: effectiveName,
                                        bindingId: def.bindingId,
                                        count: 1,
                                        sites: [call.line],
                                        siteIds: [siteId],
                                    });
                                }
                            } else {
                                noteSite(siteId, 'excluded', 'self-recursion', call);
                            }
                        }
                        continue; // Already added all overloads, skip normal add
                        }
                        // otherBindings === null: fall through to the
                        // single-owner check + uncertain handling below.
                    } else if (def.className && !call.isMethod) {
                        // Implicit same-class call (Java: execute() means this.execute())
                        // Try to resolve to a binding in the same class via symbol lookup
                        const callSymbols = index.symbols.get(call.name);
                        if (callSymbols) {
                            const onClass = (cls) => callSymbols.filter(s => s.className === cls);
                            const selected = langTraits(language)?.bareCallReachesMethods
                                ? _calleeSelectReceiverMethod(
                                    index, call, callSymbols, def.className,
                                    language, def.file,
                                    symbol => !NON_CALLABLE_TYPES.has(symbol.type))
                                : _calleeOverloadSelect(
                                    index, call, onClass(def.className), language);
                            if (selected.ambiguous) {
                                isUncertain = true;
                                uncertainReason = 'overload-ambiguous';
                            } else if (selected.match) {
                                const sameClassSym = selected.match;
                                if (routeVirtualOverride(siteId, call, def.className, sameClassSym)) continue;
                                // Find the binding that matches this symbol's line
                                const matchingBinding = bindings.find(b => b.startLine === sameClassSym.startLine);
                                if (matchingBinding) {
                                    bindingResolved = matchingBinding.id;
                                    calleeKey = bindingResolved;
                                } else {
                                    bindingResolved = sameClassSym.bindingId;
                                    calleeKey = bindingResolved || `${def.className}.${call.name}`;
                                }
                            } else {
                                isUncertain = true;
                                uncertainReason = 'binding-ambiguous';
                            }
                        } else {
                            isUncertain = true;
                            uncertainReason = 'binding-ambiguous';
                        }
                    } else {
                        // Try to resolve to a binding defined within the parent function's
                        // scope (inner closure). E.g., hookRunnerApplication defines next()
                        // internally — prefer that over other next() in the same file.
                        const innerBinding = bindings.find(b =>
                            b.startLine > def.startLine && b.startLine <= def.endLine);
                        if (innerBinding) {
                            bindingResolved = innerBinding.id;
                            calleeKey = bindingResolved;
                        } else {
                            isUncertain = true;
                            uncertainReason = 'binding-ambiguous';
                        }
                    }
                }
            }

            // Bare nominal calls inside a class are implicit-this calls. A
            // lexical binding to a base/interface declaration is not an exact
            // runtime target when overrides/implementations exist.
            if (bindingResolved && !call.isMethod && !call.receiver &&
                langTraits(language)?.bareCallReachesMethods) {
                const bound = (index.symbols.get(effectiveName) || [])
                    .find(s => s.bindingId === bindingResolved);
                if (bound && routeVirtualOverride(siteId, call, def.className, bound)) continue;
            }

            // Single project-wide owner (fix #236 — the caller side's
            // #204/#209 rule on the callee side): an untyped-receiver method
            // call whose name has exactly ONE owner type resolves to that
            // owner's method — `k.run()` where only Kit defines run. Without
            // it, trace trees stopped expanding at statically-resolvable
            // calls the caller direction confirms.
            if (isUncertain && call.isMethod && call.receiver && !bindingResolved) {
                const fm = mayNeedDirectReceiverFlow(call) ? flowMap() : null;
                const flowEntry = fm ? _lookupReturnTypeFlow(fm, call) : undefined;
                const owner = _calleeSingleOwnerMatch(index, def, fileEntry, call, effectiveName, language, flowEntry);
                if (owner) {
                    isUncertain = false;
                    bindingResolved = owner.bindingId;
                    calleeKey = owner.bindingId ||
                        `${owner.className || (owner.receiver || '').replace(/^\*/, '')}.${effectiveName}`;
                }
            }

            if (isUncertain) {
                if (_calleeZeroCandidateName(index, call)) {
                    // fix #261: zero project definitions of the name — the
                    // unverified band exists to keep POSSIBLE project edges
                    // visible, and with no def anywhere no edge is possible.
                    // Same verdict the symbol-table check gives bare names.
                    noteSite(siteId, 'external', null, call);
                    continue;
                }
                if (collectAccount) {
                    // Contract mode: uncertain callee edges are never silently
                    // dropped NOR silently confirmed — visible unverified
                    // entries with a reason. --include-uncertain is an implied
                    // no-op here (the caller-contract precedent).
                    if (options.stats) options.stats.uncertain = (options.stats.uncertain || 0) + 1;
                    noteUnverified(siteId, call, uncertainReason || 'uncertain-receiver');
                    continue;
                }
                if (!options.includeUncertain) {
                    if (options.stats) options.stats.uncertain = (options.stats.uncertain || 0) + 1;
                    continue;
                }
            }

            const existing = callees.get(calleeKey);
            if (existing) {
                existing.count += 1;
                if (collectAccount) {
                    existing.sites.push(call.line);
                    existing.siteIds.push(siteId);
                    if (call.isPotentialCallback || call.isFunctionReference) existing.isFunctionReference = true;
                }
            } else {
                callees.set(calleeKey, {
                    name: effectiveName,
                    bindingId: bindingResolved,
                    count: 1,
                    ...(call.isConstructor && { isConstructor: true }),
                    ...(collectAccount && {
                        sites: [call.line],
                        siteIds: [siteId],
                        ...((call.isPotentialCallback || call.isFunctionReference) && { isFunctionReference: true }),
                    })
                });
            }
        }

        // Second pass: resolve Python self.attr.method() calls
        // Respect includeMethods=false — skip self/this method resolution entirely
        if (selfAttrCalls && def.className && options.includeMethods !== false) {
            const attrTypes = getInstanceAttributeTypes(index, def.file, def.className);
            for (const { call, siteId } of selfAttrCalls) {
                    // fix #261: `self.items.append(x)` — a method name with
                    // zero project defs cannot resolve to project code no
                    // matter what the attribute's type turns out to be.
                    if (_calleeZeroCandidateName(index, call)) {
                        noteSite(siteId, 'external', null, call);
                        continue;
                    }
                    let targetClass = attrTypes ? attrTypes.get(call.selfAttribute) : null;
                    // Unique method heuristic: if attr type unknown but method exists on exactly one class
                    if (!targetClass) {
                        const methodSyms = index.symbols.get(call.name);
                        if (methodSyms) {
                            const classNames = new Set();
                            for (const s of methodSyms) {
                                if (s.className) classNames.add(s.className);
                            }
                            if (classNames.size === 1) {
                                targetClass = classNames.values().next().value;
                            }
                        }
                    }
                    if (!targetClass) { noteUnverified(siteId, call, 'self-attr-unresolved'); continue; }

                    // Find method in symbol table where className matches
                    const symbols = index.symbols.get(call.name);
                    if (!symbols) { noteUnverified(siteId, call, 'self-attr-unresolved'); continue; }

                    const match = symbols.find(s => s.className === targetClass);
                    if (!match) { noteUnverified(siteId, call, 'self-attr-unresolved'); continue; }

                    const key = match.bindingId || `${targetClass}.${call.name}`;
                    const existing = callees.get(key);
                    if (existing) {
                        existing.count += 1;
                        if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                    } else {
                        callees.set(key, {
                            name: call.name,
                            bindingId: match.bindingId,
                            count: 1,
                            ...(collectAccount && { sites: [call.line], siteIds: [siteId] })
                        });
                    }
                }
        } else if (selfAttrCalls && collectAccount) {
            // Pass skipped (no class context, or methods display-filtered):
            // claim the sites so the account stays conserved.
            for (const { call, siteId } of selfAttrCalls) {
                if (options.includeMethods === false) noteSite(siteId, 'filtered', 'method-calls-excluded', call);
                else if (_calleeZeroCandidateName(index, call)) noteSite(siteId, 'external', null, call);
                else noteUnverified(siteId, call, 'self-attr-unresolved');
            }
        }

        // Third pass: resolve self/this/super.method() calls to same-class or parent methods
        // Falls back to walking the inheritance chain if not found in same class
        // Respect includeMethods=false — skip self/this method resolution entirely
        if (selfMethodCalls && def.className && options.includeMethods !== false) {
            for (const { call, siteId } of selfMethodCalls) {
                const symbols = index.symbols.get(call.name);
                if (!symbols || symbols.length === 0) {
                    // fix #261: `this.push(x)` in a class extending a builtin
                    // (or an external base) — zero project defs of the name
                    // means the inherited method is external, not unresolved.
                    noteSite(siteId, 'external', null, call);
                    continue;
                }

                // For super().method(), skip same-class — start from parent
                const parentOnlyReceiver =
                    call.receiver === 'super' || call.receiver === 'base';
                const selectOwner = owner => _calleeOverloadSelect(
                    index,
                    call,
                    symbols.filter(symbol => symbol.className === owner),
                    language);
                let selected = parentOnlyReceiver
                    ? { match: null }
                    : _calleeSelectReceiverMethod(
                        index, call, symbols, def.className, language, def.file,
                        symbol => !NON_CALLABLE_TYPES.has(symbol.type));
                if (selected.ambiguous) {
                    noteUnverified(siteId, call, 'overload-ambiguous');
                    continue;
                }
                let match = selected.match;
                let ambiguityClaimed = false;

                // Walk inheritance chain using BFS if not found in same class
                if (!match) {
                    const visited = new Set([def.className]);
                    const defFile = def.file;
                    const startParents = index._getInheritanceParents(def.className, defFile) || [];
                    const queue = startParents.map(p => ({ name: p, contextFile: defFile }));
                    while (queue.length > 0 && !match) {
                        const { name: current, contextFile } = queue.shift();
                        if (visited.has(current)) continue;
                        visited.add(current);
                        selected = selectOwner(current);
                        if (selected.ambiguous) {
                            noteUnverified(siteId, call, 'overload-ambiguous');
                            ambiguityClaimed = true;
                            match = null;
                            break;
                        }
                        match = selected.match;
                        if (!match) {
                            const resolvedFile = index._resolveClassFile(current, contextFile);
                            const grandparents = index._getInheritanceParents(current, resolvedFile) || [];
                            for (const gp of grandparents) {
                                if (!visited.has(gp)) queue.push({ name: gp, contextFile: resolvedFile });
                            }
                        }
                    }
                }

                if (ambiguityClaimed) continue;
                if (!match) { noteUnverified(siteId, call, 'inherited-unresolved'); continue; }
                // Virtual self/this dispatch (callee-side parity with the
                // caller side's strict-ancestor rule): a call lexically in a
                // base class can execute a descendant override. Confirming
                // only the base declaration is therefore false precision.
                // `super.method()` is statically pinned to the parent and is
                // exempt. In contract mode retain the site as possible
                // dispatch; legacy command behavior remains unchanged.
                const overrideOwners = !parentOnlyReceiver
                    ? _descendantOverrideOwners(index, def.className, call.name)
                    : new Set();
                if (collectAccount && overrideOwners.size > 0) {
                    noteUnverified(siteId, call, 'possible-dispatch', {
                        dispatchVia: def.className,
                        dispatchCandidates: overrideOwners.size + 1,
                    });
                    continue;
                }

                const key = match.bindingId || `${match.className}.${call.name}`;
                const existing = callees.get(key);
                if (existing) {
                    existing.count += 1;
                    if (collectAccount) { existing.sites.push(call.line); existing.siteIds.push(siteId); }
                } else {
                    callees.set(key, {
                        name: call.name,
                        bindingId: match.bindingId,
                        count: 1,
                        ...(collectAccount && { sites: [call.line], siteIds: [siteId] })
                    });
                }
            }
        } else if (selfMethodCalls && collectAccount) {
            for (const { call, siteId } of selfMethodCalls) {
                if (options.includeMethods === false) noteSite(siteId, 'filtered', 'method-calls-excluded', call);
                else if (_calleeZeroCandidateName(index, call)) noteSite(siteId, 'external', null, call);
                else noteUnverified(siteId, call, 'inherited-unresolved');
            }
        }

        // Look up each callee in the symbol table
        // For methods, prefer callees from: 1) same file, 2) same package, 3) same receiver type
        // Also deprioritize test-file definitions when caller is in production code
        const result = [];
        const defDir = path.dirname(def.file);
        const defReceiver = def.receiver;
        const defFileEntry = fileEntry;
        const callerIsTest = defFileEntry && isTestFile(defFileEntry.relativePath, defFileEntry.language);
        // Pre-compute import graph for callee confidence scoring
        const callerImportSet = index.importGraph.get(def.file) || new Set();
        const cFamilyVisibleFiles = ['c', 'cpp'].includes(language)
            ? _cppVisibleFiles(index, def.file) : null;

        for (const { name: calleeName, bindingId, count, isConstructor, sites, siteIds, isFunctionReference } of callees.values()) {
            const claimSites = (bucket, reason) => {
                if (!collectAccount || !siteIds) return;
                for (let i = 0; i < siteIds.length; i++) {
                    noteSite(siteIds[i], bucket, reason, { name: calleeName, line: sites[i] });
                }
            };
            const symbols = index.symbols.get(calleeName);
            if (!symbols || symbols.length === 0) {
                // Name not in the symbol table — external library, builtin, or
                // unindexed code. Visible in the callee account, not an edge.
                claimSites('external', null);
                continue;
            }
            // File-scope `static` C/C++ functions have internal linkage. A
            // call in another source translation unit cannot bind to them,
            // even when a name-only ranking would otherwise prefer that
            // production definition over a test helper. A directly or
            // transitively included file remains eligible: C projects often
            // include a private `.c` file in white-box tests, making that
            // static definition part of the test's translation unit.
            const resolutionSymbols = symbols.filter(candidate => {
                const candidateLanguage = index.files.get(candidate.file)?.language;
                const fileLocalStatic = ['c', 'cpp'].includes(candidateLanguage) &&
                    candidate.modifiers?.includes('static') &&
                    !candidate.className && !candidate.receiver;
                if (!fileLocalStatic || candidate.file === def.file) return true;
                return cFamilyVisibleFiles?.has(candidate.file);
            });
            if (resolutionSymbols.length === 0) {
                claimSites('external', null);
                continue;
            }
            if (resolutionSymbols.length > 0) {
                let callee = resolutionSymbols[0];

                // If we have a binding ID, find the exact matching symbol
                if (bindingId && resolutionSymbols.length > 1) {
                    const exactMatch = resolutionSymbols.find(s => s.bindingId === bindingId);
                    if (exactMatch) {
                        callee = exactMatch;
                    }
                } else if (resolutionSymbols.length > 1) {
                    // Priority 1: Same file, but different definition (for overloads)
                    const sameFileDifferent = resolutionSymbols.find(s => s.file === def.file && s.startLine !== def.startLine);
                    const sameFile = resolutionSymbols.find(s => s.file === def.file);
                    if (sameFileDifferent && calleeName === def.name) {
                        callee = sameFileDifferent;
                    } else if (sameFile) {
                        callee = sameFile;
                    } else {
                        // Priority 2: Same directory (package)
                        const sameDir = resolutionSymbols.find(s => path.dirname(s.file) === defDir);
                        if (sameDir) {
                            callee = sameDir;
                        } else {
                            // Priority 2.5: Imported file — check if the caller's file imports
                            // from any of the candidate callee files (using importGraph)
                            const importedCallee = resolutionSymbols.find(s => callerImportSet.has(s.file));
                            if (importedCallee) {
                                callee = importedCallee;
                            } else if (defReceiver) {
                                // Priority 3: Same receiver type (for methods)
                                const sameReceiver = resolutionSymbols.find(s => s.receiver === defReceiver);
                                if (sameReceiver) {
                                    callee = sameReceiver;
                                }
                            }
                        }
                    }
                    // Priority 4: If default is from a bundled/minified file, prefer non-bundled
                    if (!bindingId) {
                        const calleeFileEntry = index.files.get(callee.file);
                        if (calleeFileEntry && calleeFileEntry.isBundled) {
                            const nonBundled = resolutionSymbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !fe.isBundled;
                            });
                            if (nonBundled) callee = nonBundled;
                        }
                    }
                    // Priority 5: If default is a test file, prefer non-test
                    if (!bindingId && !callerIsTest) {
                        const calleeFileEntry = index.files.get(callee.file);
                        if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                            const nonTest = resolutionSymbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !isTestFile(fe.relativePath, fe.language);
                            });
                            if (nonTest) callee = nonTest;
                        }
                    }
                    // Priority 6: Usage-based tiebreaker for cross-language/cross-directory ambiguity
                    // Matches resolveSymbol() scoring logic in project.js
                    if (!bindingId && callee === resolutionSymbols[0] && resolutionSymbols.length > 1) {
                        const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
                        const scored = resolutionSymbols.map(s => {
                            let score = 0;
                            const fe = index.files.get(s.file);
                            const rp = fe ? fe.relativePath : (s.relativePath || '');
                            if (typeOrder.has(s.type)) score += 1000;
                            if (!callerIsTest &&
                                isTestFile(rp, detectLanguage(s.file))) score -= 500;
                            if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
                            if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
                            return { symbol: s, score };
                        });
                        scored.sort((a, b) => b.score - a.score);
                        if (scored.length > 1 && scored[0].score === scored[1].score) {
                            const tiedScore = scored[0].score;
                            const tiedCandidates = scored.filter(s => s.score === tiedScore);
                            for (const c of tiedCandidates) {
                                c.usageCount = index.countSymbolUsages(c.symbol).total;
                            }
                            tiedCandidates.sort((a, b) => b.usageCount - a.usageCount);
                            callee = tiedCandidates[0].symbol;
                        } else {
                            callee = scored[0].symbol;
                        }
                    }
                }

                // Skip non-callable types (interface, struct, type) as callees.
                // These appear when local variables shadow symbol names
                // (e.g., `for _, handler := range handlers { handler(r) }` —
                // handler is a local var, not the handler interface type).
                // Exception: function-typed fields (e.g., syncHandler func(...))
                // are callable via Go dependency injection patterns.
                if (!bindingId && NON_CALLABLE_TYPES.has(callee.type)) {
                    const isFuncField = callee.type === 'field' && callee.fieldType &&
                        /^func\b/.test(callee.fieldType);
                    const isCallableClass = callee.type === 'class' &&
                        langTraits(language)?.classesCallableWithoutNew;
                    // Constructor calls (new Foo()) are always callable regardless of type
                    if (!isFuncField && !isConstructor && !isCallableClass) {
                        claimSites('excluded', 'non-callable-shadow');
                        continue;
                    }
                }

                // Skip test-file callees when caller is production code and
                // there's no binding (import) evidence linking them
                if (!callerIsTest && !bindingId) {
                    const calleeFileEntry = index.files.get(callee.file);
                    if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                        claimSites('excluded', 'test-file-no-import-link');
                        continue;
                    }
                }

                const calleeScored = scoreEdge({
                    hasBindingId: !!bindingId,
                    hasImportEvidence: !!bindingId || resolutionSymbols.length === 1 ||
                        (callee.file === def.file) || callerImportSet.has(callee.file),
                    isUncertain: false, // uncertain callees already filtered above
                });
                claimSites('confirmed', null);
                result.push({
                    ...callee,
                    callCount: count,
                    weight: index.calculateWeight(count),
                    confidence: calleeScored.confidence,
                    evidenceScore: calleeScored.evidenceScore,
                    scoreKind: calleeScored.scoreKind,
                    resolution: calleeScored.resolution,
                    ...(collectAccount && {
                        tier: TIER.CONFIRMED,
                        sites: [...sites].sort((a, b) => a - b),
                        ...(isFunctionReference && { functionReference: true }),
                    }),
                });
            }
        }

        // Sort by call count (core dependencies first)
        result.sort((a, b) => b.callCount - a.callCount);

        if (calleeAccount) {
            const claimed = calleeAccount.confirmed + calleeAccount.unverified +
                calleeAccount.external.count + calleeAccount.excluded.total +
                calleeAccount.filtered.count;
            calleeAccount.unaccounted = calleeAccount.totalSites - claimed;
            calleeAccount.conserved = calleeAccount.unaccounted === 0;
            // Stable ordering (output contract): by name, then reason.
            const unverifiedList = [...unverifiedCallees.values()]
                .map(e => ({ ...e, sites: [...e.sites].sort((a, b) => a - b) }))
                .sort((a, b) => codeUnitCompare(a.name, b.name) || codeUnitCompare(a.reason, b.reason));
            Object.defineProperty(result, 'calleeAccount', {
                value: calleeAccount, enumerable: false, writable: true, configurable: true,
            });
            Object.defineProperty(result, 'unverifiedCallees', {
                value: unverifiedList, enumerable: false, writable: true, configurable: true,
            });
        }

        if (queryProfile) {
            queryProfile.totalMs = elapsedProfileMs(profileStarted);
            queryProfile.callsInDefinition = calls.length;
            queryProfile.confirmed = result.length;
            queryProfile.unverified = result.unverifiedCallees?.length || 0;
        }
        return result;
    } catch (e) {
        // Empty callees is a semantic assertion, not an error fallback. Any
        // read/cache/parser/engine failure here would otherwise turn a broken
        // trace-down query into a believable false zero.
        const rel = def?.file ? path.relative(index.root, def.file) : '<unknown>';
        e.message = `findCallees failed while analyzing ${rel}: ${e.message}`;
        throw e;
    }
    } finally { index._endOp(); }
}

/**
 * Get instance attribute types for a class in a file.
 * Returns Map<attrName, typeName> for a given className.
 * Caches results per file.
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File path
 * @param {string} className - Class name
 */
function getInstanceAttributeTypes(index, filePath, className) {
    if (!index._attrTypeCache) index._attrTypeCache = new Map();

    let fileCache = index._attrTypeCache.get(filePath);
    if (!fileCache) {
        const fileEntry = index.files.get(filePath);
        if (!fileEntry || fileEntry.language !== 'python') return null;

        const langModule = getLanguageAdapter('python');
        if (!langModule?.findInstanceAttributeTypes) return null;

        try {
            const content = index._readFile(filePath);
            const parser = getParser('python');
            const fileEntry = index.files.get(filePath);
            fileCache = langModule.findInstanceAttributeTypes(content, parser, {
                resolveBuiltinCallType(moduleName, functionName) {
                    if (!_pythonBuiltinContractAllowed(index, fileEntry, moduleName)) {
                        return null;
                    }
                    return langModule.getBuiltinCallReturnType?.(
                        moduleName, functionName) || null;
                },
            });
            index._attrTypeCache.set(filePath, fileCache);
        } catch {
            return null;
        }
    }

    return fileCache.get(className) || null;
}

/**
 * Build a local variable type map for a function body.
 * Scans for constructor-call assignments: var = ClassName(...)
 * Returns Map<varName, className> or null if none found.
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Function definition with file, startLine, endLine
 * @param {Array} calls - Cached call sites for the file
 */
function _buildLocalTypeMap(index, def, calls) {
    let content;
    try {
        content = index._readFile(def.file);
    } catch {
        return null;
    }
    const lines = content.split('\n');
    const localTypes = new Map();
    const regexCache = new Map();

    for (const call of calls) {
        // Only look at calls within this function's scope
        if (call.line < def.startLine || call.line > def.endLine) continue;
        // Only direct calls (not method calls) — these are potential constructors
        if (call.isMethod || call.isPotentialCallback) continue;

        // Check if this call's name corresponds to a class in the symbol table
        const symbols = index.symbols.get(call.name);
        if (!symbols) continue;
        const isClass = symbols.some(s => NON_CALLABLE_TYPES.has(s.type));
        if (!isClass) continue;

        // Check the source line for assignment pattern: var = ClassName(...)
        const sourceLine = lines[call.line - 1];
        if (!sourceLine) continue;

        // Memoize compiled regex per call name (same name → same pattern)
        let patterns = regexCache.get(call.name);
        if (!patterns) {
            const esc = call.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            patterns = {
                assign: new RegExp(`(\\w+)\\s*(?::\\s*\\w+)?\\s*=\\s*${esc}\\s*\\(`),
                with: new RegExp(`with\\s+${esc}\\s*\\([^)]*\\)\\s+as\\s+(\\w+)`)
            };
            regexCache.set(call.name, patterns);
        }
        const assignMatch = sourceLine.match(patterns.assign);
        if (assignMatch) {
            localTypes.set(assignMatch[1], call.name);
        }
        const withMatch = sourceLine.match(patterns.with);
        if (withMatch) {
            localTypes.set(withMatch[1], call.name);
        }
    }

    return localTypes.size > 0 ? localTypes : null;
}

/**
 * Build a local variable type map for typed languages (Go, Java, Rust)
 * using parser-inferred receiverType from call objects.
 * Go also resolves New*() constructor patterns.
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Function definition with file, startLine, endLine
 * @param {Array} calls - Cached call sites for the file
 *
 * Sources: parser-inferred receiverType from method receivers, constructor calls,
 * composite literals. Used by Go, Java, Rust (nominal languages) to infer local
 * variable types for method resolution. Not used by JS/TS/Python -- structural
 * languages use import evidence via _buildLocalTypeMap instead.
 */
/**
 * Single concrete type name from a return-annotation STRING (symbols store
 * returnType as text). Conservative: ambiguous shapes return undefined.
 * Handles: Foo · pkg.Foo · "Foo" · Foo | None · Optional[Foo] · Promise<Foo> ·
 * list[Item] (→ list — the value IS a list) · Foo<T> / Foo[T] (→ Foo).
 */
function _typeNameFromReturnAnnotation(text) {
    if (!text || typeof text !== 'string') return undefined;
    let t = text.trim().replace(/^["']|["']$/g, '').trim();
    // X | None / X | null / X | undefined → X (single real member only)
    if (t.includes('|')) {
        const parts = t.split('|').map(s => s.trim())
            .filter(s => !['None', 'null', 'undefined'].includes(s));
        if (parts.length !== 1) return undefined;
        t = parts[0];
    }
    // unwrap value-transparent wrappers: Optional[X], Promise<X>, Awaitable[X]
    let m;
    while ((m = t.match(/^(?:typing\.)?(Optional|Annotated|Final|Promise|Awaitable)\s*[[<]\s*([^,]+?)\s*[\]>]$/))) {
        t = m[2].trim();
    }
    // generic base: Foo[...] / Foo<...> → Foo (the value is a Foo)
    m = t.match(/^([\w.]+)\s*[[<]/);
    if (m) t = m[1];
    // dotted → last segment; validate a bare identifier remains
    const last = t.split('.').pop();
    return /^[A-Za-z_]\w*$/.test(last) ? last : undefined;
}

/**
 * Per-file return-type-flow map: variables typed by what the assigned call
 * returns. Key `${enclosingFnStartLine||''}:${varName}` → [{ line, type,
 * fromFile? }] (all assignments, so lookups can pick the nearest preceding
 * one). All producer resolutions are conservative.
 *
 * Structural shapes (fix #199 — unchanged):
 *  - typed-receiver method call: receiverType class (or an ancestor walk is
 *    NOT attempted — exact className match only) defines the method with a
 *    return annotation
 *  - self/this/cls method call: the enclosing class (walking up its
 *    inheritance chain for inherited methods) defines the method with a
 *    return annotation
 *  - plain call with exactly ONE project definition carrying a return annotation
 *
 * Nominal shapes (fix #207 — compiler-checked annotations, so resolution
 * confidence carries; same-named owners must AGREE on the return type):
 *  - Go package-qualified producer: bb := balancer.Get(n) — defs resolved
 *    strictly into the imported package (no root-package trust)
 *  - Rust path producer: let c = Config::load()? — last path segment as the
 *    impl type; Result/Option unwrap via assignedUnwrap; Self → the impl type
 *  - Java static producer (typeQualifiedCallStyle 'static'): var c =
 *    Config.parse(...) — receiver as className
 *  - plain producer: Go resolves same-package ONLY (an unqualified Go call
 *    cannot reach another package); Rust/Java add a same-file narrowing on
 *    top of the global-unique rule
 * Nominal entries carry fromFile — the TYPE's defining file resolved from
 * the PRODUCER's scope (_resolveFlowTypeOrigin) — so the #206 identity
 * discipline resolves the name where the annotation lives, not where the
 * consuming call happens to be.
 */
function _buildReturnTypeFlowMap(index, filePath, calls) {
    // File-scoped derivation: the result is independent of the queried
    // definition. A command operation can therefore share it across every
    // findCallers/findCallees request in that file. Cache null explicitly via
    // Map.has() so files without resolvable flow are cheap too.
    const opCache = index._opReturnTypeFlowCache;
    if (opCache?.has(filePath)) return opCache.get(filePath);
    const fileEntry = index.files.get(filePath);
    const language = fileEntry?.language;
    const nominal = langTraits(language)?.typeSystem === 'nominal';
    let map = null;
    const assignedFoldCtx = {
        memo: new Map(),
        visiting: new Set(),
        records: calls,
        getFlowMap: () => map,
    };
    // A flow map is nearest-assignment semantics, not "last assignment whose
    // type UCN happened to understand".  Record an explicit tombstone when a
    // call rebinds a variable but its result type cannot be resolved. Without
    // this, `let m = make_result(); let m = m.unwrap(); m.method()` retained
    // the stale Result-like type and excluded compiler-true calls on the
    // unwrapped value (clap-measured).
    const invalidateAssignment = (call) => {
        const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
        const names = [call.assignedTo, ...(call.assignedTupleRest || [])].filter(Boolean);
        if (names.length === 0) return;
        if (!map) map = new Map();
        for (const name of names) {
            const key = `${scope}:${name}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ line: call.line, start: call.callStart, invalidated: true });
        }
    };
    const routeUnknownAssignment = (call, externalVia, externalConcrete = false) => {
        const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
        const names = [call.assignedTo, ...(call.assignedTupleRest || [])].filter(Boolean);
        if (names.length === 0) return;
        if (!map) map = new Map();
        for (const name of names) {
            const key = `${scope}:${name}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({
                line: call.line,
                start: call.callStart,
                externalVia,
                ...(externalConcrete && { externalConcrete: true }),
            });
        }
    };
    for (const call of calls) {
        if (!call.assignedTo) continue;
        // For-loop iteration provenance (fix #294, flask-measured: `for ep in
        // importlib.metadata.entry_points(...)` — ep.load() confirmed
        // JSONProvider.load via single-owner while ep is an external
        // EntryPoint). The loop variable holds an ELEMENT of the producer's
        // result — the return annotation types the container, never the
        // element, so assignedIter records NEVER type positively. External
        // module-qualified producers stamp external provenance (the
        // #220(6)/#222(4) demote-only rail: blocks single-owner confirmation,
        // never excludes). Bare-call and untyped producers add nothing —
        // sorted()/filter() wrappers routinely yield project values, and
        // demoting those has no measured evidence.
        if (call.assignedIter) {
            const via = _iterExternalProducerVia(index, fileEntry, call);
            if (via) routeUnknownAssignment(call, via);
            continue;
        }
        const delegatedUnwrapAssignment = language === 'rust' &&
            call.receiverCall && calls.some(candidate =>
                candidate !== call &&
                candidate.assignedTo === call.assignedTo &&
                candidate.assignedUnwrap &&
                candidate.callStart === call.receiverCallStart &&
                candidate.callEnd === call.receiverCallEnd);

        // Rust's `collect::<Vec<Item>>()` turbofish fixes the concrete result
        // and its item type at the call site. Preserve the item identity even
        // though the outer collection is a standard-library type with no
        // project declaration.
        if (language === 'rust' && call.explicitResultType &&
            call.explicitResultItemType) {
            const scope = call.enclosingFunction
                ? `${call.enclosingFunction.startLine}` : '';
            const key = `${scope}:${call.assignedTo}`;
            const itemOrigin = _resolveFlowTypeOrigin(
                index, filePath, call.explicitResultItemType);
            if (!map) map = new Map();
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({
                line: call.line,
                start: call.callStart,
                type: call.explicitResultType,
                iteratorItemType: call.explicitResultItemType,
                ...(itemOrigin?.fromFile && {
                    iteratorItemFromFile: itemOrigin.fromFile,
                }),
            });
            continue;
        }

        // Assigned builder chain (chi-measured):
        // `hr := RouteHeaders().Route(...)` stores the OUTERMOST method call
        // as the assignment producer. Fold the chain to its declared result
        // before composing later `hr.Handler(...)` flow.
        if (nominal && (call.receiverCall || call.isMacro)) {
            let folded = _typeOfCallResultFold(
                index, fileEntry, filePath, call, assignedFoldCtx);
            // Rust result aliases are commonly imported under a local name
            // (`use crate::error::Result as ClapResult`). The chain fold
            // correctly resolves the producer owner but its normalized value
            // is the wrapper. For an assignment ending in `?`/unwrap/expect,
            // re-read the exact owner's declared return and unwrap that alias
            // before persisting receiver identity.
            if (folded?.type && language === 'rust' && call.assignedUnwrap) {
                const owner = _rustRecordReceiverType(
                    index, fileEntry, filePath, call, assignedFoldCtx);
                const ownerType = owner?.type;
                const definitions = ownerType
                    ? (index.symbols.get(call.name) || []).filter(definition =>
                        !NON_CALLABLE_TYPES.has(definition.type) &&
                        definition.returnType &&
                        String(definition.className || definition.receiver || '')
                            .replace(/^[*&]\s*/, '').replace(/<.*$/, '').trim() === ownerType)
                    : [];
                const resolved = definitions.map(definition => {
                    const parsed = _returnTypeNameNominal(
                        definition.returnType, 'rust', {
                            unwrapped: true,
                            selfClass: ownerType,
                            index,
                            originFile: definition.file || filePath,
                        });
                    if (!parsed) return null;
                    const origin = _resolveFlowTypeOrigin(
                        index, definition.file || filePath,
                        parsed.name, parsed.qualifier);
                    return origin
                        ? { type: parsed.name, fromFile: origin.fromFile }
                        : null;
                });
                folded = resolved.length > 0 && resolved.every(Boolean) &&
                    new Set(resolved.map(result => result.type)).size === 1 &&
                    new Set(resolved.map(result => result.fromFile)).size === 1
                    ? resolved[0]
                    : null;
            }
            if (folded?.type || folded?.externalVia) {
                const scope = call.enclosingFunction
                    ? `${call.enclosingFunction.startLine}` : '';
                const key = `${scope}:${call.assignedTo}`;
                if (!map) map = new Map();
                if (!map.has(key)) map.set(key, []);
                map.get(key).push({ line: call.line, start: call.callStart,
                    ...(folded.type && { type: folded.type }),
                    ...(folded.fromFile && { fromFile: folded.fromFile }),
                    ...(folded.externalVia && { externalVia: folded.externalVia }),
                    ...(folded.externalConcrete && { externalConcrete: true }) });
                continue;
            }
        }
        let returnType, fromFile, selfClass, returnedFunctionResult, returnDefinition;
        const builtinCallReturn = !nominal && language === 'python'
            ? _pythonBuiltinCallReturnType(index, fileEntry, call) : null;
        if (builtinCallReturn) {
            returnType = builtinCallReturn;
        } else if (!nominal && language === 'python' && !call.isMethod &&
            !call.receiver && call.name === 'open' && !call.localShadow &&
            !(fileEntry.importBindings || []).some(binding =>
                binding.name === 'open' || binding.alias === 'open')) {
            returnType = call.assignedContext ? 'ContextManager[IO]' : 'IO';
        }
        const callableFlow = !call.isMethod && !call.receiver
            ? _lookupReturnTypeFlow(map, { ...call, receiver: call.name })
            : undefined;
        if (returnType) {
            // Exact builtin contract selected above.
        } else if (callableFlow?.returnedFunctionResult) {
            returnType = callableFlow.returnedFunctionResult;
            fromFile = callableFlow.fromFile;
        } else if (call.isMethod && call.receiverType) {
            const defs = index.symbols.get(call.name) || [];
            if (nominal) {
                const matches = defs.filter(d => d.className === call.receiverType && d.returnType);
                if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                    returnType = matches[0].returnType;
                    fromFile = matches[0].file;
                    selfClass = matches[0].className;
                    returnDefinition = matches[0];
                }
            } else {
                // Structural classes inherit methods too. A receiver typed as
                // `Client` may resolve `build_request` on `BaseClient`; the
                // declared return remains exact compiler evidence for the
                // assigned value. Walk breadth-first and accept the nearest
                // owner level only when all visible declarations agree.
                let owners = [call.receiverType];
                const seen = new Set();
                while (owners.length > 0 && seen.size < 64) {
                    const level = owners.filter(owner => owner && !seen.has(owner));
                    if (level.length === 0) break;
                    for (const owner of level) seen.add(owner);
                    const matches = defs.filter(d =>
                        level.includes(d.className) && d.returnType);
                    if (matches.length > 0) {
                        if (new Set(matches.map(d => d.returnType)).size === 1) {
                            returnType = matches[0].returnType;
                            fromFile = matches[0].file;
                            selfClass = call.receiverType;
                            returnDefinition = matches[0];
                        }
                        break;
                    }
                    owners = [...new Set(level.flatMap(owner =>
                        index._getInheritanceParents?.(owner, filePath) || []))];
                }
            }
        } else if (call.isMethod && call.receiver &&
            !['self', 'this', 'cls'].includes(call.receiver) &&
            _lookupReturnTypeFlow(map, call)) {
            // One-hop local flow composition (fix #273, chi-measured):
            // `hr := RouteHeaders(); handler := hr.Handler(...)` first types
            // hr from RouteHeaders' annotation, then resolves Handler on that
            // exact owner to type handler. This stays order/scoped and uses
            // only compiler-declared returns; disagreement remains untyped.
            const receiverFlow = _lookupReturnTypeFlow(map, call);
            if (receiverFlow?.externalVia) {
                const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
                const key = `${scope}:${call.assignedTo}`;
                if (!map) map = new Map();
                if (!map.has(key)) map.set(key, []);
                map.get(key).push({
                    line: call.line,
                    start: call.callStart,
                    externalVia: `${receiverFlow.externalVia}.${call.name}`,
                    ...(receiverFlow.externalConcrete && { externalConcrete: true }),
                });
                continue;
            }
            if (receiverFlow?.type) {
                const matches = (index.symbols.get(call.name) || []).filter(d =>
                    (d.className === receiverFlow.type ||
                     (d.receiver && d.receiver.replace(/^\*/, '') === receiverFlow.type)) &&
                    d.returnType);
                if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                    returnType = matches[0].returnType;
                    fromFile = matches[0].file;
                    selfClass = receiverFlow.type;
                    returnDefinition = matches[0];
                }
            }
        } else if (call.isMethod && ['self', 'this', 'cls'].includes(call.receiver)) {
            const enclosing = index.findEnclosingFunction(filePath, call.line, true);
            let cls = enclosing && enclosing.className;
            let ctxFile = filePath;
            const visited = new Set();
            while (cls && !visited.has(cls)) {
                visited.add(cls);
                const def = (index.symbols.get(call.name) || [])
                    .find(d => d.className === cls && d.returnType);
                if (def) {
                    returnType = def.returnType;
                    fromFile = def.file;
                    selfClass = cls;
                    returnDefinition = def;
                    break;
                }
                const parents = index._getInheritanceParents(cls, ctxFile) || [];
                const next = parents[0]; // single chain; diamond bases stay untyped
                if (next && index._resolveClassFile) {
                    ctxFile = index._resolveClassFile(next, ctxFile) || ctxFile;
                }
                cls = next;
            }
        } else if (nominal && call.isMethod && call.isPathCall && call.receiver) {
            if (language === 'cpp') {
                // C++ value-initialization through a qualified type name:
                // `auto p = fmt::pipe()`. The portable tree-sitter AST uses
                // the same qualified-call shape as a namespace function. A
                // visible indexed type named by the terminal component,
                // owned by the qualified include-root namespace, is
                // compiler-grade constructor evidence. Multiple defining
                // files remain ambiguous.
                const typeDefs = (index.symbols.get(call.name) || [])
                    .filter(definition =>
                        IDENTITY_TYPE_KINDS.has(definition.type) &&
                        definition.file &&
                        _cppQualifiedPathOwnsTarget(
                            index, filePath, call, [definition]));
                const files = new Set(typeDefs.map(definition => definition.file));
                if (typeDefs.length > 0 && files.size === 1) {
                    returnType = call.name;
                    fromFile = typeDefs[0].file;
                    selfClass = call.name;
                    returnDefinition = typeDefs[0];
                }
            }
            if (!returnType) {
                // C++ namespace-qualified free producer: `auto error =
                // fmt::system_error(...)`. The portable AST shares the path
                // shape with static methods, but namespace ownership plus
                // include visibility and overload applicability pin a free
                // function independently. Its return annotation can then
                // preserve external ownership (`std::system_error`) instead
                // of letting a later method name confirm by project scope.
                if (language === 'cpp') {
                    const candidates = (index.symbols.get(call.name) || [])
                        .filter(definition =>
                            !NON_CALLABLE_TYPES.has(definition.type) &&
                            !definition.className && !definition.receiver &&
                            definition.returnType &&
                            _overloadApplicable(index, call, definition));
                    const owned = candidates.filter(definition =>
                        _cppQualifiedPathOwnsTarget(
                            index, filePath, call, [definition]));
                    if (owned.length > 0 &&
                        new Set(owned.map(definition =>
                            definition.returnType)).size === 1) {
                        returnType = owned[0].returnType;
                        if (new Set(owned.map(definition =>
                            definition.file)).size === 1) {
                            fromFile = owned[0].file;
                        }
                        returnDefinition = owned[0];
                    }
                }
            }
            if (!returnType) {
                // Rust: let c = config::Config::load()? — the last path
                // segment names the impl type (module-path producers stay
                // untyped). The same rule also covers C++ static factories.
                const seg = call.receiver.split('::').pop();
                const matches = (index.symbols.get(call.name) || [])
                    .filter(d => d.className === seg && d.returnType);
                if (matches.length > 0 &&
                    new Set(matches.map(d => d.returnType)).size === 1) {
                    returnType = matches[0].returnType;
                    fromFile = matches[0].file;
                    selfClass = seg;
                    returnDefinition = matches[0];
                }
            }
            if (!returnType && language === 'cpp' &&
                String(call.receiver).split('::')[0] === 'std') {
                // `auto text = std::string()` is a qualified functional
                // construction even when the standard-library type is not
                // indexed. Its compiler ownership is still decisive against
                // an unrelated project-local method with the same name.
                routeUnknownAssignment(
                    call, `${call.receiver}::${call.name}`, true);
                continue;
            }
        } else if (nominal && call.isMethod && call.receiver &&
            langTraits(language)?.typeQualifiedCallStyle === 'static') {
            // Java static factory: var c = Config.parse(...) — only sound for
            // the static call style; a Go receiver named like a type is a
            // VARIABLE (fix #206 typeQualifiedCallStyle discipline)
            const matches = (index.symbols.get(call.name) || [])
                .filter(d => d.className === call.receiver && d.returnType);
            if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                returnType = matches[0].returnType;
                fromFile = matches[0].file;
                selfClass = call.receiver;
                returnDefinition = matches[0];
            }
        } else if (nominal && !call.isMethod && call.receiver &&
            langTraits(language)?.hasReceiverPackageCalls) {
            // Go package-qualified producer: bb := balancer.Get(n) — Get
            // resolves IN the imported package (fix #206 name ownership)
            const cands = (index.symbols.get(call.name) || [])
                .filter(d => !NON_CALLABLE_TYPES.has(d.type) && d.returnType);
            const inPkg = fileEntry && _qualifiedProducerDefs(index, fileEntry, call.receiver, cands);
            if (inPkg && inPkg.length > 0 && new Set(inPkg.map(d => d.returnType)).size === 1) {
                returnType = inPkg[0].returnType;
                fromFile = inPkg[0].file;
                returnDefinition = inPkg[0];
            } else {
                // External producer (fix #220, cobra-measured): the parser
                // marked this call package-qualified (receiver ∈ imports),
                // and the package resolves to no project def — the variable's
                // type was decided OUTSIDE the project (av := reflect.ValueOf).
                // Not positive evidence for any type, but compiler-grade
                // evidence AGAINST single-owner confirmation: route visible.
                // EVERY tuple element is external-decided (tmpFile, err := …),
                // unlike typed flow which pairs only element 0 (#207).
                const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
                if (!map) map = new Map();
                for (const lhs of [call.assignedTo, ...(call.assignedTupleRest || [])]) {
                    const key = `${scope}:${lhs}`;
                    if (!map.has(key)) map.set(key, []);
                    map.get(key).push({ line: call.line, start: call.callStart,
                        externalVia: `${call.receiver}.${call.name}`,
                        ...(getLanguageAdapter(language)?.isPlatformConcreteCall?.(
                            call.receiver, call.name) && { externalConcrete: true }),
                    });
                }
                continue;
            }
        } else if (!nominal && call.isMethod && call.receiverIsModule &&
            (call.receiver || call.receiverModuleSpecifier)) {
            // Structural module-qualified producer (fix #209): schema =
            // z.string() — the module alias resolves through the file's
            // import bindings to its file (one re-export hop for barrels),
            // and the producer's return annotation types the variable.
            // Standalone exports only (className-less): a module attr is
            // never a class method.
            const binding = _structuralModuleBindings(fileEntry, call)[0];
            const rel = binding && fileEntry.moduleResolved && fileEntry.moduleResolved[binding.module];
            if (binding && !rel) {
                // External module producer (fix #222, httpx-measured — the
                // #220 Go external-producer rule for structural languages):
                // logger = logging.getLogger(...) / thread = threading.Thread()
                // types the variable OUTSIDE the project, so unique project
                // ownership of a later method name (logger.info vs the only
                // project `info`) is not identity evidence. Same externality
                // test as #209 module ownership: relative or project-ish
                // modules are resolver gaps, never externality evidence.
                const mod = String(binding.module);
                const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                if (!mod.startsWith('.') &&
                    !(firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                    const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
                    if (!map) map = new Map();
                    const key = `${scope}:${call.assignedTo}`;
                    if (!map.has(key)) map.set(key, []);
                    map.get(key).push({ line: call.line, start: call.callStart,
                        externalVia: `${call.receiver}.${call.name}` });
                }
                continue;
            }
            if (rel) {
                const modFile = path.join(index.root, rel);
                const cands = (index.symbols.get(call.name) || [])
                    .filter(d => !NON_CALLABLE_TYPES.has(d.type) && d.returnType && !d.className);
                let matches = cands.filter(d => d.file === modFile);
                if (matches.length === 0) {
                    const hop = index.importGraph.get(modFile);
                    if (hop) matches = cands.filter(d => hop.has(d.file));
                }
                if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                    returnType = matches[0].returnType;
                    if (new Set(matches.map(d => d.file)).size === 1) fromFile = matches[0].file;
                    returnDefinition = matches[0];
                }
            }
        } else if (!call.isMethod && !call.receiver) {
            const defs = (index.symbols.get(call.name) || [])
                .filter(d => !NON_CALLABLE_TYPES.has(d.type));
            let chosen = null;
            const cppCallerNamespace = language === 'cpp'
                ? index.findEnclosingFunction(
                    filePath, call.line, true)?.namespace || null
                : null;
            if (language === 'cpp') {
                // C++ unqualified lookup is both source-order and include
                // sensitive. A later same-file overload is not visible before
                // its declaration, and an arity-incompatible overload cannot
                // determine an `auto` assignment's type. Prefer one applicable
                // callable from the caller's complete include closure.
                //
                // fmt exposed the dangerous inverse: `auto f =
                // open_buffered_file()` was typed from a later local
                // `open_buffered_file(int&) -> file`, overriding the included
                // zero-argument declaration returning `buffered_file`. That
                // converted two buffered_file.descriptor() calls into falsely
                // confirmed file.descriptor() edges.
                const visibleFiles = _cppVisibleFiles(index, filePath);
                const namespaceVisible = definition => {
                    const owner = definition.namespace || null;
                    if (!owner) return true; // global scope is a parent scope
                    if (!cppCallerNamespace) return false;
                    return owner === cppCallerNamespace ||
                        cppCallerNamespace.endsWith(`::${owner}`);
                };
                const visible = defs.filter(definition =>
                    !definition.className && !definition.receiver &&
                    namespaceVisible(definition) &&
                    _overloadApplicable(index, call, definition) &&
                    (definition.file === filePath
                        ? definition.startLine <= call.line
                        : visibleFiles.has(definition.file)));
                if (visible.length === 1) chosen = visible[0];
            } else if (nominal && langTraits(language)?.packageScope === 'directory') {
                // Go: an unqualified call resolves within the package — a
                // globally-unique def in ANOTHER package is unreachable
                const dir = path.dirname(filePath);
                const samePkg = defs.filter(d => d.file && path.dirname(d.file) === dir);
                if (samePkg.length === 1) chosen = samePkg[0];
            } else if (defs.length === 1) {
                chosen = defs[0];
            } else if (nominal && defs.length > 1) {
                const sameFile = defs.filter(d => d.file === filePath);
                if (sameFile.length === 1) chosen = sameFile[0];
            }
            if (chosen) {
                const constructorFlow = !nominal
                    ? _structuralReturnedConstructorFlow(index, chosen)
                    : null;
                if (constructorFlow?.externalVia) {
                    routeUnknownAssignment(
                        call, constructorFlow.externalVia,
                        constructorFlow.externalConcrete);
                    continue;
                }
                const compilerDeducedConcrete = language === 'cpp' &&
                    /^auto\b/.test(String(chosen.returnType || '').trim())
                    ? _cppAutoReturnConcreteType(index, chosen)
                    : null;
                returnType = compilerDeducedConcrete ||
                    (!nominal && chosen.returnedConcreteType
                        ? chosen.returnedConcreteType : chosen.returnType);
                returnedFunctionResult = chosen.returnedFunctionResult;
                fromFile = chosen.file;
                returnDefinition = chosen;
            } else if (language === 'cpp') {
                // Functional-style construction of an indexed C++ type is
                // represented by tree-sitter as an ordinary call (`auto u =
                // utf8_to_utf16(text)`). Constructor symbols share the type's
                // name, so the callable list need not be empty. A unique
                // visible type is compiler identity only when no applicable
                // standalone function competes in the caller's lookup set.
                // This also covers explicit class-template construction such
                // as `to_utf8<Char>()`.
                const visibleFiles = _cppVisibleFiles(index, filePath);
                const standalone = defs.filter(definition =>
                    !definition.className && !definition.receiver &&
                    (!definition.namespace ||
                     definition.namespace === cppCallerNamespace ||
                     (cppCallerNamespace && cppCallerNamespace.endsWith(
                         `::${definition.namespace}`))) &&
                    _overloadApplicable(index, call, definition) &&
                    (definition.file === filePath
                        ? definition.startLine <= call.line
                        : visibleFiles.has(definition.file)));
                const types = (index.symbols.get(call.name) || []).filter(
                    definition =>
                        IDENTITY_TYPE_KINDS.has(definition.type) &&
                        definition.file &&
                        (definition.file === filePath ||
                            visibleFiles.has(definition.file)));
                const typeFiles = new Set(types.map(definition =>
                    definition.file));
                if (standalone.length === 0 && types.length > 0 &&
                    typeFiles.size === 1) {
                    returnType = call.name;
                    fromFile = types[0].file;
                    selfClass = call.name;
                    returnDefinition = types[0];
                }
            } else if (!nominal && defs.length > 1) {
                // Structural overload declarations plus their implementation
                // are one callable. Resolve the callable's owning file from
                // lexical/import scope, then accept its result only when every
                // overload has an annotation whose concrete runtime head
                // agrees (`signal<T>(): Signal<T|undefined>` still produces a
                // Signal). A same-named overload group in another module or
                // an unannotated member keeps the assignment untyped.
                const groupKey = definition =>
                    `${definition.file}\0${definition.className || ''}\0` +
                    `${definition.isNested ? 1 : 0}`;
                const groups = new Map();
                for (const definition of defs) {
                    const key = groupKey(definition);
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push(definition);
                }
                const reachable = [];
                for (const group of groups.values()) {
                    if (!group.some(definition => definition.isSignature) ||
                        group.some(definition => !definition.returnType)) continue;
                    const ownerFile = group[0].file;
                    const local = ownerFile === filePath;
                    const bound = (fileEntry.importBindings || [])
                        .filter(binding =>
                            binding.name === call.name || binding.alias === call.name)
                        .some(binding => {
                            const rel = fileEntry.moduleResolved?.[binding.module];
                            if (!rel) return false;
                            const start = path.join(index.root, rel);
                            return start === ownerFile ||
                                _nameBindingReaches(
                                    index, start, call.name, new Set([ownerFile])) === 'yes';
                        });
                    if (local || bound) reachable.push(group);
                }
                if (reachable.length === 1) {
                    const concrete = reachable[0]
                        .filter(definition => !definition.isSignature)
                        .map(definition => definition.returnedConcreteType)
                        .filter(Boolean);
                    const heads = reachable[0].map(definition =>
                        _structuralTypeHead(definition.returnType, {
                            index,
                            language,
                            originFile: definition.file,
                        }));
                    if (concrete.length > 0 && new Set(concrete).size === 1) {
                        returnType = concrete[0];
                        fromFile = reachable[0][0].file;
                    } else if (heads.every(Boolean) && new Set(heads).size === 1) {
                        returnType = reachable[0][0].returnType;
                        fromFile = reachable[0][0].file;
                    }
                }
            }
        }
        if (!returnType) {
            if (!delegatedUnwrapAssignment) invalidateAssignment(call);
            continue;
        }
        let iteratorItemType, iteratorItemFromFile;
        if (language === 'rust' && returnDefinition?.iteratorItemType) {
            const itemOrigin = _resolveFlowTypeOrigin(
                index, returnDefinition.file || filePath,
                returnDefinition.iteratorItemType);
            if (itemOrigin?.fromFile) {
                iteratorItemType = returnDefinition.iteratorItemType;
                iteratorItemFromFile = itemOrigin.fromFile;
            }
        }
        if (language === 'go' && returnedFunctionResult) {
            const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
            const key = `${scope}:${call.assignedTo}`;
            if (!map) map = new Map();
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({
                line: call.line,
                start: call.callStart,
                returnedFunctionResult,
                ...(fromFile && { fromFile }),
            });
            continue;
        }
        let typeName, entryFromFile;
        if (nominal) {
            const parsed = _returnTypeNameNominal(returnType, language, {
                unwrapped: call.assignedUnwrap,
                tuple: call.assignedTuple,
                selfClass,
                index,
                originFile: fromFile || filePath,
            });
            if (!parsed) {
                if (iteratorItemType) {
                    const scope = call.enclosingFunction
                        ? `${call.enclosingFunction.startLine}` : '';
                    const key = `${scope}:${call.assignedTo}`;
                    if (!map) map = new Map();
                    if (!map.has(key)) map.set(key, []);
                    map.get(key).push({
                        line: call.line,
                        start: call.callStart,
                        iteratorItemType,
                        iteratorItemFromFile,
                    });
                    continue;
                }
                const uncertainVia = _rejectedNominalFlowVia(returnType, language, {
                    tuple: call.assignedTuple,
                });
                if (uncertainVia) routeUnknownAssignment(call, uncertainVia);
                else invalidateAssignment(call);
                continue;
            }
            // Qualifier provenance is meaningful even when no same-named
            // project TYPE symbol exists. `http.Handler` is externally owned
            // regardless of whether the project happens to define a struct,
            // interface, or named function type called Handler.
            if (language === 'go' && parsed.qualifier) {
                const producerEntry = index.files.get(fromFile || filePath) || fileEntry;
                const qualified = _goQualifiedReceiverType(
                    index, producerEntry, parsed.qualifier, parsed.name);
                if (qualified && qualified.kind !== 'project') {
                    const scope = call.enclosingFunction
                        ? `${call.enclosingFunction.startLine}` : '';
                    const key = `${scope}:${call.assignedTo}`;
                    if (!map) map = new Map();
                    if (!map.has(key)) map.set(key, []);
                    map.get(key).push({ line: call.line, start: call.callStart,
                        externalVia: qualified.via });
                    continue;
                }
            }
            const origin = _resolveFlowTypeOrigin(index, fromFile || filePath, parsed.name, parsed.qualifier);
            if (!origin) {
                // A project producer can return a package-qualified external
                // Go type (`DefaultLogger(...) http.Handler`). That still
                // gives compiler-grade provenance: the assigned receiver is
                // externally decided and must defeat project-local bare-name
                // confirmation. Preserve it on the same visible uncertainty
                // rail as an external producer call.
                if (language === 'cpp' && parsed.qualifier &&
                    String(parsed.qualifier).split('::')[0] === 'std') {
                    routeUnknownAssignment(
                        call,
                        `${parsed.qualifier}::${parsed.name}`,
                        true);
                } else {
                    invalidateAssignment(call);
                }
                continue; // identity unpinnable — don't type at all
            }
            typeName = parsed.name;
            entryFromFile = origin.fromFile;
        } else {
            typeName = call.assignedContext
                ? _pythonContextValueType(returnType)
                : _typeNameFromReturnAnnotation(returnType);
            if (typeName) {
                const typeDefs = (index.symbols.get(typeName) || [])
                    .filter(d => IDENTITY_TYPE_KINDS.has(d.type));
                if (typeDefs.length > 0) {
                    const origin = _resolveFlowTypeOrigin(index, fromFile || filePath, typeName);
                    if (!origin) {
                        invalidateAssignment(call);
                        continue;
                    }
                    entryFromFile = origin.fromFile;
                }
            }
        }
        if (!typeName) {
            invalidateAssignment(call);
            continue;
        }
        const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
        const key = `${scope}:${call.assignedTo}`;
        if (!map) map = new Map();
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ line: call.line, start: call.callStart, type: typeName,
            ...(entryFromFile && { fromFile: entryFromFile }),
            ...(iteratorItemType && {
                iteratorItemType,
                iteratorItemFromFile,
            }) });
    }
    if (opCache) opCache.set(filePath, map);
    return map;
}

/**
 * Return call records whose source line falls inside one definition.
 *
 * Parser output is normally source-ordered. We verify/order it once per file
 * per command and then use two binary searches, avoiding a full-file scan for
 * every symbol during reachability traversal.
 */
function _callsInDefinitionRange(index, filePath, calls, startLine, endLine) {
    let ordered = index._opCallsByLineCache?.get(filePath);
    if (!ordered) {
        let sorted = true;
        for (let i = 1; i < calls.length; i++) {
            if ((calls[i - 1].line || 0) > (calls[i].line || 0)) {
                sorted = false;
                break;
            }
        }
        ordered = sorted ? calls : [...calls].sort((a, b) => (a.line || 0) - (b.line || 0));
        index._opCallsByLineCache?.set(filePath, ordered);
    }
    const lowerBound = (needle) => {
        let lo = 0, hi = ordered.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((ordered[mid].line || 0) < needle) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    return ordered.slice(lowerBound(startLine), lowerBound(endLine + 1));
}

/**
 * Return independently-addressable class method ranges nested inside one
 * definition. Reachability calls findCallees for thousands of symbols; a
 * full fileEntry.symbols scan per symbol made this step quadratic in files
 * with many methods. Cache one sorted range list per file, then binary-slice
 * the relevant start-line window for each definition.
 */
function _innerClassMethodRanges(index, def, fileEntry) {
    let ordered = index._opInnerSymbolRangesCache?.get(def.file);
    if (!ordered) {
        ordered = fileEntry.symbols
            .filter(symbol => !NON_CALLABLE_TYPES.has(symbol.type) && symbol.className)
            .map(symbol => [symbol.startLine, symbol.endLine])
            .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        index._opInnerSymbolRangesCache?.set(def.file, ordered);
    }

    const lowerBound = (needle) => {
        let lo = 0, hi = ordered.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (ordered[mid][0] < needle) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const from = lowerBound(def.startLine + 1);
    const to = lowerBound(def.endLine + 1);
    const ranges = [];
    for (let i = from; i < to; i++) {
        if (ordered[i][1] <= def.endLine) ranges.push(ordered[i]);
    }
    return ranges;
}

/** Nearest preceding flow assignment for this call's receiver (fn scope, then module). */
function _lookupReturnTypeFlow(map, call) {
    if (!map) return undefined;
    const fnScope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
    const lexicalScopes = Array.isArray(call.enclosingFunction?.scopeChain)
        ? [...call.enclosingFunction.scopeChain].reverse().map(String)
        : (fnScope === '' ? [] : [fnScope]);
    const precedesCall = entry => entry.line < call.line ||
        (entry.line === call.line &&
            entry.start != null && call.callStart != null &&
            entry.start < call.callStart);
    const laterThan = (entry, best) => !best ||
        entry.line > best.line ||
        (entry.line === best.line &&
            entry.start != null &&
            (best.start == null || entry.start > best.start ||
             (entry.start === best.start && best.invalidated && !entry.invalidated)));
    for (const scope of [...new Set([...lexicalScopes, ''])]) {
        const entries = map.get(`${scope}:${call.receiver}`);
        if (!entries) continue;
        let best = null;
        for (const e of entries) {
            if (precedesCall(e) && laterThan(e, best)) best = e;
        }
        if (best) return best.invalidated ? undefined : best;
    }
    return undefined;
}

// True when the receiver's NEAREST preceding assignment is a flow tombstone —
// the variable provably holds a value the type machinery examined and could
// not type (`local = factory()`). This is the #222(4) unknown-provenance
// evidence class with a local producer: it demotes single-owner confirmation.
// A never-assigned parameter has no entries and keeps the documented
// #204/#209 single-owner physics — parameter-ness alone is not provenance
// evidence against the one project owner.
function _receiverAssignedUntyped(map, call) {
    if (!map || !call.receiver) return false;
    const fnScope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
    const lexicalScopes = Array.isArray(call.enclosingFunction?.scopeChain)
        ? [...call.enclosingFunction.scopeChain].reverse().map(String)
        : (fnScope === '' ? [] : [fnScope]);
    const precedesCall = entry => entry.line < call.line ||
        (entry.line === call.line &&
            entry.start != null && call.callStart != null &&
            entry.start < call.callStart);
    const laterThan = (entry, best) => !best ||
        entry.line > best.line ||
        (entry.line === best.line &&
            entry.start != null &&
            (best.start == null || entry.start > best.start ||
             (entry.start === best.start && best.invalidated && !entry.invalidated)));
    for (const scope of [...new Set([...lexicalScopes, ''])]) {
        const entries = map.get(`${scope}:${call.receiver}`);
        if (!entries) continue;
        let best = null;
        for (const e of entries) {
            if (precedesCall(e) && laterThan(e, best)) best = e;
        }
        if (best) return !!best.invalidated;
    }
    return false;
}

// Return-annotation names that must never type a receiver in nominal flow:
// builtin interfaces/primitives whose project implementors UCN cannot see —
// a receiver typed `error` CAN dispatch into a project type's Error() method,
// so excluding on it would lose true edges. (Rust primitives are safe: project
// extension impls put the primitive name in dispatchTargetTypes.)
const _GO_FLOW_REJECT = new Set([
    'error', 'any', 'string', 'bool', 'byte', 'rune', 'uintptr',
    'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128',
]);
const _JAVA_FLOW_REJECT = new Set([
    'Object', 'void', 'int', 'long', 'short', 'byte', 'char',
    'boolean', 'float', 'double', 'var',
]);
const _CSHARP_FLOW_REJECT = new Set([
    'Object', 'object', 'dynamic', 'void', 'var',
    'string', 'bool', 'byte', 'sbyte', 'char', 'decimal',
    'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double',
]);

/** Split generic-argument text on commas at angle/paren/bracket depth 0. */
function _splitTopLevelGenericArgs(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        else if (ch === '>' || ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

function _splitTopLevelDelimiter(s, delimiter) {
    const out = [];
    let angle = 0, paren = 0, bracket = 0, brace = 0, cur = '';
    for (const ch of s) {
        if (ch === '<') angle++;
        else if (ch === '>') angle = Math.max(0, angle - 1);
        else if (ch === '(') paren++;
        else if (ch === ')') paren = Math.max(0, paren - 1);
        else if (ch === '[') bracket++;
        else if (ch === ']') bracket = Math.max(0, bracket - 1);
        else if (ch === '{') brace++;
        else if (ch === '}') brace = Math.max(0, brace - 1);
        if (ch === delimiter && angle === 0 && paren === 0 &&
            bracket === 0 && brace === 0) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

/**
 * Single concrete type name from a NOMINAL return annotation (fix #207).
 * Returns { name, qualifier } or undefined. Conservative: ambiguous or
 * non-nominal shapes (slices, maps, chans, fn types, dyn/impl traits,
 * generic type params, builtin interfaces) return undefined.
 *  - Go: `*Builder` → Builder; tuple `(T, error)` pairs its FIRST element
 *    with a tuple-unpacking assignment (`v, err := f()`) — tuple/assignment
 *    shapes must agree or the parse is wrong; `pkg.Type` keeps the qualifier
 *  - Rust: Self → the impl type; Result<T,_>/Option<T> unwrap ONLY under
 *    assignedUnwrap (`?` / .unwrap() / .expect()); Box/Rc/Arc auto-deref via
 *    _normalizeFieldTypeName
 *  - Java: plain names and generic bases via _normalizeFieldTypeName
 */
function _returnTypeNameNominal(text, language, opts = {}) {
    if (!text || typeof text !== 'string') return undefined;
    let t = text.trim();
    if (language === 'go') {
        if (t.startsWith('(')) {
            if (!opts.tuple) return undefined;
            const inner = t.slice(1, -1);
            if (inner.includes('func(') || inner.includes('func (')) return undefined;
            const first = inner.split(',')[0].trim();
            const parts = first.split(/\s+/);
            t = parts[parts.length - 1]; // named return `n int` → int
        } else if (opts.tuple) {
            return undefined; // v, err := f() needs a multi-return producer
        }
    } else if (language === 'rust' && opts.tuple) {
        if (!t.startsWith('(') || !t.endsWith(')')) return undefined;
        t = (_splitTopLevelGenericArgs(t.slice(1, -1))[0] || '').trim();
        if (!t) return undefined;
    } else if (opts.tuple) {
        return undefined;
    }
    if (language === 'rust') {
        if (/^&?\s*(mut\s+)?Self$/.test(t)) {
            return opts.selfClass ? { name: opts.selfClass } : undefined;
        }
        if (opts.unwrapped) {
            const m = t.match(
                /^(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*([A-Za-z_][A-Za-z0-9_]*)\s*<(.*)>$/s);
            if (!m) return undefined;
            let wrapper = m[1];
            if (!['Result', 'Option'].includes(wrapper) &&
                opts.index && opts.originFile) {
                const originEntry = opts.index.files.get(opts.originFile);
                const bindings = (originEntry?.importBindings || []).filter(binding =>
                    binding.name === wrapper || binding.alias === wrapper);
                const importedWrappers = new Set(bindings.map(binding =>
                    String(binding.module || '').split('::').filter(Boolean).pop()));
                if (importedWrappers.size === 1 &&
                    ['Result', 'Option'].includes([...importedWrappers][0])) {
                    wrapper = [...importedWrappers][0];
                }
            }
            if (!['Result', 'Option'].includes(wrapper)) {
                return undefined; // unwrap on a non-Result/Option annotation
            }
            t = (_splitTopLevelGenericArgs(m[2])[0] || '').trim();
            if (/^&?\s*(mut\s+)?Self$/.test(t)) {
                return opts.selfClass ? { name: opts.selfClass } : undefined;
            }
        }
    } else if (language === 'csharp' && opts.unwrapped) {
        const match = t.match(/^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)\s*<(.*)>$/s);
        if (!match) return undefined;
        t = (_splitTopLevelGenericArgs(match[1])[0] || '').trim();
    } else if (opts.unwrapped) {
        return undefined;
    }
    // Preserve qualifiers whose language can prove project ownership. C++
    // namespace-qualified annotations (`fmt::buffered_file`) are common in
    // public declarations and must retain `fmt`; discarding it as generically
    // "unresolvable" tombstoned otherwise exact `auto` return flow.
    let qualifier;
    if (language === 'go') {
        const qm = t.replace(/^\*+/, '').match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
        if (qm) qualifier = qm[1];
    } else if (language === 'cpp') {
        const stripped = t
            .replace(/\b(const|volatile|class|struct|typename)\b/g, '')
            .replace(/[*&]+/g, '').trim();
        const genericStart = stripped.indexOf('<');
        const head = genericStart >= 0
            ? stripped.slice(0, genericStart).trim() : stripped;
        const segments = head.split(/\s*::\s*/).filter(Boolean);
        if (segments.length > 1) qualifier = segments.slice(0, -1).join('::');
    } else {
        const stripped = t.replace(/^&+\s*/, '').replace(/^mut\s+/, '');
        if (/^[A-Za-z_$][\w$]*\s*(::|\.)/.test(stripped)) qualifier = '<unresolvable>';
    }
    const norm = _normalizeFieldTypeName(t, language);
    if (!norm) return undefined;
    if (/^[A-Z][A-Z0-9]?$/.test(norm)) return undefined; // generic type param (T, K, V1)
    if (language === 'go' && _GO_FLOW_REJECT.has(norm)) return undefined;
    if (language === 'java' && _JAVA_FLOW_REJECT.has(norm)) return undefined;
    if (language === 'csharp' && _CSHARP_FLOW_REJECT.has(norm)) return undefined;
    return { name: norm, qualifier };
}

/**
 * Some declared nominal return types are deliberately rejected as concrete
 * receiver identity because they are dispatch contracts or type parameters.
 * They are still strong evidence AGAINST the single-owner shortcut: `error`
 * can call any implementation's Error(), Java Object can reach overrides,
 * and Rust T may be instantiated by any implementing type. Preserve that as
 * visible possible-dispatch provenance instead of collapsing to "untyped".
 */
function _rejectedNominalFlowVia(text, language, opts = {}) {
    if (!text || typeof text !== 'string') return null;
    let raw = text.trim();
    if (language === 'go' && raw.startsWith('(')) {
        if (!opts.tuple) return null;
        const first = raw.slice(1, -1).split(',')[0]?.trim();
        raw = first ? first.split(/\s+/).pop() : '';
    }
    const norm = _normalizeFieldTypeName(raw, language);
    if (!norm) return null;
    if (language === 'go' && _GO_FLOW_REJECT.has(norm)) {
        return `${norm} — builtin contract`;
    }
    if (language === 'java' && _JAVA_FLOW_REJECT.has(norm)) {
        return `${norm} — builtin contract`;
    }
    if (language === 'csharp' && _CSHARP_FLOW_REJECT.has(norm)) {
        return `${norm} — builtin contract`;
    }
    if (language === 'rust' && /^[A-Z][A-Z0-9]?$/.test(norm)) {
        return `${norm} — generic type`;
    }
    return null;
}

/**
 * Resolve the indexed module surfaces named by a flattened Rust `use`
 * binding. Rust import records intentionally retain the complete leaf path
 * (`crate::builder::Command`), while filesystem resolution operates on the
 * module surface (`crate::builder`) and the type may be re-exported from that
 * surface. Keep both candidates, ignore resolver guesses for nonexistent
 * case-sensitive files, and let the existing bounded import/name closure pin
 * the declaration.
 */
function _rustBindingResolvedFiles(index, fileEntry, filePath, binding) {
    const resolvedFiles = new Set();
    const modulePath = String(binding?.module || '');
    if (!modulePath) return resolvedFiles;
    const specs = [modulePath];
    const segments = modulePath.split('::').filter(Boolean);
    if (segments.length > 1) {
        specs.push(segments.slice(0, -1).join('::'));
    }
    for (const spec of [...new Set(specs)]) {
        const rel = fileEntry?.moduleResolved?.[spec];
        if (rel) {
            const abs = path.join(index.root, rel);
            if (index.files.has(abs)) resolvedFiles.add(abs);
        }
        const resolved = resolveRustImport(spec, filePath, index.root);
        if (resolved && index.files.has(resolved)) {
            resolvedFiles.add(resolved);
        }
    }
    return resolvedFiles;
}

/**
 * Pin a flow type name to its defining file from the PRODUCER's scope
 * (fix #207 — the #206 identity lesson applied to annotations: `Builder` in
 * balancer/base.go means balancer.Builder; resolving it from the consuming
 * file's scope could hit an unrelated same-name type). Returns { fromFile }
 * or null when identity cannot be pinned:
 *  - Go-qualified (`pkg.Type`): the qualifier must resolve through the
 *    producer's imports to exactly one project package — else null
 *  - Rust/Java-qualified annotations: external paths — only acceptable when
 *    NO project type shares the name (the name then can't conflate)
 *  - unqualified: same file → same dir → import edge; unique-anywhere is NOT
 *    trusted (a use/import of an external type can shadow it invisibly)
 *  - no project type def at all: external name — safe, can't conflate
 */
function _resolveFlowTypeOrigin(index, producerFile, typeName, qualifier = undefined) {
    const opCache = index._opFlowTypeOriginCache;
    const cacheKey = `${producerFile}\x00${typeName}\x00${qualifier || ''}`;
    if (opCache?.has(cacheKey)) return opCache.get(cacheKey);
    const finish = (result) => {
        if (opCache) opCache.set(cacheKey, result);
        return result;
    };
    const typeDefs = (index.symbols.get(typeName) || [])
        .filter(d => (IDENTITY_TYPE_KINDS.has(d.type) ||
            (d.type === 'type' && d.aliasOf)) && d.file);
    if (typeDefs.length === 0) return finish({ fromFile: producerFile });
    if (qualifier === '<unresolvable>') return finish(null);
    if (qualifier) {
        const fe = index.files.get(producerFile);
        if (fe?.language === 'cpp') {
            // Literal namespace declarations carry exact metadata. Macro-
            // opened namespaces (FMT_BEGIN_NAMESPACE) are opaque to
            // tree-sitter, so the conventional include-root component is the
            // conservative fallback. In both cases the type declaration must
            // be visible from the producer and resolve to one defining file.
            const root = qualifier.split('::')[0];
            const candidates = typeDefs.filter(definition => {
                const namespace = String(definition.namespace || '');
                if (namespace === qualifier ||
                    namespace.endsWith(`::${qualifier}`)) return true;
                const relative = path.relative(index.root, definition.file);
                return relative.split(path.sep).includes(root);
            }).filter(definition =>
                _cppTargetVisibleFrom(index, producerFile, [definition]));
            if (candidates.length > 0 &&
                new Set(candidates.map(definition => definition.file)).size === 1) {
                return finish({ fromFile: candidates[0].file });
            }
            return finish(null);
        }
        // Java nested types use a capitalized lexical qualifier
        // (`CodeBlock.Builder`). Resolve that exact owner before package
        // import logic. A duplicate owner/type pair across files remains
        // ambiguous and therefore cannot become exclusion-grade identity.
        if (fe?.language === 'java' && /^[A-Z_$]/.test(qualifier)) {
            const nested = typeDefs.filter(d => d.enclosingType === qualifier);
            if (nested.length > 0 &&
                new Set(nested.map(d => d.file)).size === 1) {
                return finish({ fromFile: nested[0].file });
            }
            return finish(null);
        }
        // Rust fully-qualified workspace paths need no `use` binding:
        // `clap::Command::new()` names the crate directly. Resolve the path
        // through Cargo/workspace metadata, then pin the type only when that
        // module's bounded import closure reaches exactly one declaration.
        if (fe?.language === 'rust') {
            const resolved = resolveRustImport(
                `${qualifier}::${typeName}`, producerFile, index.root);
            if (resolved) {
                const reachable = typeDefs.filter(d =>
                    d.file === resolved ||
                    _importReaches(index, resolved, new Set([d.file])));
                if (new Set(reachable.map(d => d.file)).size === 1) {
                    return finish({ fromFile: reachable[0].file });
                }
            }
        }
        // Structural module qualifier (fix #286e, flask-measured):
        // `app: flask.Flask` names the type through the imported module.
        // Resolve the module binding and pin the unique reachable
        // declaration — name-chase through modeled re-exports first, the
        // bounded file-level closure as fallback (the #277 rails). An
        // unresolvable qualifier is 'unknown', never proximity-guessed.
        if (fe && ['python', 'javascript', 'typescript', 'tsx'].includes(fe.language)) {
            const resolvedRels = new Set();
            const direct = fe.moduleResolved?.[qualifier];
            if (direct) resolvedRels.add(direct);
            for (const b of (fe.importBindings || [])) {
                if (b.name !== qualifier && b.alias !== qualifier) continue;
                const rel = fe.moduleResolved?.[b.module];
                if (rel) resolvedRels.add(rel);
            }
            for (const rel of resolvedRels) {
                const start = path.join(index.root, rel);
                const named = typeDefs.filter(d => d.file === start ||
                    _nameBindingReaches(index, start, typeName, new Set([d.file])) === 'yes');
                if (new Set(named.map(d => d.file)).size === 1) {
                    return finish({ fromFile: named[0].file });
                }
                const reachable = typeDefs.filter(d => d.file === start ||
                    _importReaches(index, start, new Set([d.file])));
                if (new Set(reachable.map(d => d.file)).size === 1) {
                    return finish({ fromFile: reachable[0].file });
                }
            }
            return finish(null);
        }
        const inPkg = fe && _qualifiedProducerDefs(index, fe, qualifier, typeDefs);
        if (inPkg && inPkg.length > 0 && new Set(inPkg.map(d => d.file)).size === 1) {
            return finish({ fromFile: inPkg[0].file });
        }
        return finish(null);
    }
    const sameFile = typeDefs.find(d => d.file === producerFile);
    if (sameFile) return finish({ fromFile: sameFile.file });
    // An explicit imported name outranks directory proximity. Structural
    // modules commonly contain several same-named classes in sibling files;
    // `import { Hono } from './hono'` still pins one declaration exactly.
    const producerEntry = index.files.get(producerFile);
    const namedBindings = (producerEntry?.importBindings || []).filter(b =>
        b.name === typeName || b.alias === typeName);
    if (namedBindings.length > 0) {
        const resolvedFiles = new Set();
        for (const b of namedBindings) {
            const rel = producerEntry.moduleResolved?.[b.module];
            if (rel) {
                resolvedFiles.add(path.join(index.root, rel));
            }
            // Rust grouped/root imports are often flattened as
            // `{ name: "Command", module: "crate" }` while moduleResolved
            // has only the individual `crate::...` entries. Cargo-aware
            // resolution can still anchor the binding at the crate module;
            // the bounded import closure below then pins the declaration.
            if (producerEntry.language === 'rust') {
                for (const resolved of _rustBindingResolvedFiles(
                    index, producerEntry, producerFile, b)) {
                    resolvedFiles.add(resolved);
                }
            }
        }
        const bound = typeDefs.filter(d => resolvedFiles.has(d.file));
        if (new Set(bound.map(d => d.file)).size === 1) {
            return finish({ fromFile: bound[0].file });
        }
        // The binding may land on a barrel. Chase the imported NAME through
        // modeled re-exports, and pin only one reachable declaration.
        const reachable = typeDefs.filter(d => [...resolvedFiles].some(start =>
            _nameBindingReaches(index, start, typeName, new Set([d.file])) === 'yes'));
        if (new Set(reachable.map(d => d.file)).size === 1) {
            return finish({ fromFile: reachable[0].file });
        }
        // An UN-modelable export surface is 'unknown', never negative
        // evidence (#217) — Rust `pub use` chains defeat the name-level
        // chase, and returning null here unpinned every `use clap::Command`
        // fold root (clap confirmed placement 1432 → 10). Fall back to the
        // measured #258 FILE-level unique-reach rail, anchored at the
        // binding's own resolved module files so same-directory declarations
        // stay shadowed (the structural parallel-API protection) and only
        // the declared module's closure can pin.
        if (resolvedFiles.size > 0) {
            const fileReachable = typeDefs.filter(d => [...resolvedFiles].some(start =>
                start === d.file || _importReaches(index, start, new Set([d.file]))));
            if (new Set(fileReachable.map(d => d.file)).size === 1) {
                return finish({ fromFile: fileReachable[0].file });
            }
        }
        // An explicit binding shadows same-directory declarations even when
        // its external or dynamic export surface cannot be resolved.
        return finish(null);
    }
    const dir = path.dirname(producerFile);
    const sameDir = typeDefs.filter(d => path.dirname(d.file) === dir);
    if (sameDir.length === 1) return finish({ fromFile: sameDir[0].file });
    if (sameDir.length > 1) return finish(null);
    const imports = index.importGraph.get(producerFile);
    if (imports) {
        const imported = typeDefs.filter(d => imports.has(d.file));
        if (imported.length === 1) return finish({ fromFile: imported[0].file });
    }
    // Re-export chains (fix #258, the #209 lesson brought to identity
    // resolution): `use clap::Command` lands the import edge on the crate's
    // lib.rs, not the type's defining file — chase bounded re-export hops
    // (depth 4) and pin only when exactly ONE same-name type is reachable.
    const reachable = typeDefs.filter(d =>
        _importReaches(index, producerFile, new Set([d.file])));
    if (reachable.length === 1) return finish({ fromFile: reachable[0].file });
    return finish(null);
}

/**
 * Defs that live in the package an import-qualified receiver names, resolved
 * through the producer file's imports (alias-aware — importNames pairs 1:1
 * with imports for Go). STRICT counterpart of _receiverPackageResolution:
 * used for POSITIVE typing (fix #207). Prefer the import resolver's concrete
 * project package directory; this is what makes a subpackage importing its
 * own module root (`chi.RouteContext`) compiler-grade evidence for root
 * definitions. Returns null when the receiver names no import.
 */
function _qualifiedProducerDefs(index, fileEntry, receiver, defs) {
    const modules = fileEntry.imports || [];
    const names = fileEntry.importNames || [];
    let importModule = null;
    if (names.length === modules.length) {
        const i = names.indexOf(receiver);
        if (i >= 0) importModule = modules[i];
    }
    if (!importModule) {
        importModule = modules.find(mod => {
            const parts = mod.split('/');
            const last = parts[parts.length - 1];
            const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
            return pkgName === receiver;
        }) || null;
    }
    if (!importModule || !importModule.includes('/')) return null;

    // graph-build resolves a Go import to one representative source file in
    // the imported package. Package identity is the containing directory, so
    // every definition in that directory is eligible. This exact resolver
    // evidence must precede path heuristics: module-root packages have a
    // project-relative directory of `.` and were previously (and wrongly)
    // classified as external producers.
    const resolvedRel = fileEntry.moduleResolved && fileEntry.moduleResolved[importModule];
    if (resolvedRel) {
        const resolvedFile = path.isAbsolute(resolvedRel)
            ? resolvedRel
            : path.join(index.root, resolvedRel);
        const resolvedDir = path.dirname(resolvedFile);
        const resolved = defs.filter(d => d.file && path.dirname(d.file) === resolvedDir);
        if (resolved.length > 0) return resolved;
    }

    const parts = importModule.split('/');
    const last = parts[parts.length - 1];
    const pkgSeg = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
    return defs.filter(d => {
        if (!d.file) return false;
        const dir = path.dirname(d.file);
        const relDir = index.root ? path.relative(index.root, dir) : '';
        if (!relDir || relDir === '.' || relDir.startsWith('..')) return false;
        if (importModule === relDir || importModule.endsWith('/' + relDir)) return true;
        const base = path.basename(dir);
        return base === pkgSeg || base === receiver;
    });
}

// Builtin receiver types from literal/annotation inference (Python builtins,
// JS globals, TS predefined types). Definitionally not project classes, so a
// mismatch against a project class target is always positive evidence.
// ECMAScript host/ambient OBJECT globals (fix #232): a method call on one of
// these names — unshadowed by a project/file binding and without an
// AST-visible member assignment — reaches host code, not a project method.
const JS_GLOBAL_RECEIVERS = new Set([
    'console', 'window', 'document', 'globalThis', 'process', 'navigator',
    'Math', 'JSON', 'Reflect', 'Intl', 'localStorage', 'sessionStorage',
    'crypto', 'performance', 'history', 'location', 'screen',
]);

const BUILTIN_RECEIVER_TYPES = new Set([
    'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'bytes', 'frozenset',
    'Mapping', 'MutableMapping', 'Sequence', 'MutableSequence',
    'Collection', 'Iterable', 'Iterator', 'KeysView', 'ValuesView', 'ItemsView',
    'IO', 'TextIO', 'BinaryIO', 'StringIO', 'BytesIO',
    'ZlibCompress', 'ZlibDecompress',
    'AsyncEvent',
    'Generator', 'AsyncGenerator', 'ContextManager', 'AsyncContextManager',
    'Array', 'String', 'Object', 'RegExp', 'Number', 'Boolean', 'Map', 'Set', 'Promise',
    'WeakMap', 'WeakSet',
    'string', 'number', 'boolean', 'bigint', 'symbol',
    'object', 'dynamic', 'decimal', 'byte', 'sbyte', 'char',
    'short', 'ushort', 'uint', 'long', 'ulong', 'double',
    'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
    'Task', 'ValueTask', 'IEnumerable', 'ICollection', 'IList',
]);

// Universal-contract method names (fix #265, hono-measured: 183 untyped
// `x.toString()` calls confirmed against JSXNode.toString via the single-
// owner rule): names EVERY value satisfies through the language's root
// object — Object.prototype (JS/TS), java.lang.Object (Java), object's
// dunders (Python, protocol names by construction). Unique project
// ownership of such a name is not identity evidence for a receiver-
// evidence-free call — the #210 external-contract physics without needing
// an override marker, because overriding these IS overriding the external
// root. Demote-only (possible-dispatch); typed/validated/same-class
// receivers keep normal physics. Go has no universal root; Rust's
// trait-provided universals (to_string via Display) carry #210 markers.
const _UNIVERSAL_METHOD_NAMES_JS = new Set([
    'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable',
]);
const _UNIVERSAL_METHOD_NAMES_JAVA = new Set([
    'toString', 'equals', 'hashCode', 'getClass', 'clone',
    'notify', 'notifyAll', 'wait', 'finalize',
]);
const _UNIVERSAL_METHOD_NAMES_CSHARP = new Set([
    'ToString', 'Equals', 'GetHashCode', 'GetType', 'MemberwiseClone', 'Finalize',
]);
function _universalMethodName(language, name) {
    if (language === 'python') return /^__[A-Za-z0-9_]+__$/.test(name);
    if (language === 'java') return _UNIVERSAL_METHOD_NAMES_JAVA.has(name);
    if (language === 'csharp') return _UNIVERSAL_METHOD_NAMES_CSHARP.has(name);
    if (['javascript', 'typescript', 'tsx', 'html'].includes(language)) {
        return _UNIVERSAL_METHOD_NAMES_JS.has(name);
    }
    return false;
}
function _universalRootName(language) {
    if (language === 'python') return 'object';
    if (language === 'java' || language === 'csharp') return 'Object';
    return 'Object.prototype';
}

/**
 * Can this receiverType justify EXCLUDING a caller (structural languages)?
 * True for builtins and names that resolve to a project class/struct — types
 * whose identity and hierarchy UCN tracks. False for type aliases, interfaces,
 * and external types: those can wrap or alias the target, so a name mismatch
 * is not evidence against it.
 */
function _receiverTypeTrustedForExclusion(index, typeName) {
    if (BUILTIN_RECEIVER_TYPES.has(typeName)) return true;
    const defs = index.symbols.get(typeName);
    return !!defs && defs.some(d => d.type === 'class' || d.type === 'struct');
}

/**
 * Resolve the module that supplied a structural constructor type hint.
 * Exact project resolution pins later type-identity checks to that module;
 * an external module or a project-looking resolver gap is explicit routing
 * evidence, never confirmation evidence.
 */
function _structuralQualifiedReceiverOrigin(index, fileEntry, qualifier, typeName) {
    const qualifierRoot = String(qualifier).split('.')[0];
    const bindings = (fileEntry.importBindings || []).filter(b =>
        b.name === qualifier || b.name === qualifierRoot);
    if (bindings.length === 0) return { kind: 'unknown', via: `${qualifier}.${typeName}` };
    let projectish = false;
    for (const binding of bindings) {
        const moduleName = String(binding.module || '');
        const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[moduleName];
        if (rel) {
            return {
                kind: 'project',
                via: `${qualifier}.${typeName}`,
                fromFile: path.join(index.root, rel),
            };
        }
        const first = moduleName.split(/[./]/).filter(Boolean)[0];
        if (moduleName.startsWith('.') ||
            (first && _projectTopLevelNames(index).has(first))) {
            projectish = true;
        }
    }
    return projectish
        ? { kind: 'unknown', via: `${qualifier}.${typeName} — unresolved module` }
        : { kind: 'external', via: `${qualifier}.${typeName}` };
}

/**
 * Resolve which same-name TYPE an unqualified receiver-type name denotes from
 * a caller file's scope, and compare it against the pinned target's package
 * (fix #206 — cross-package type-name conflation: grpc-go defines ~20 structs
 * all named `bb`; a receiver typed `bb` in package leastrequest is not
 * evidence for cdsbalancer's bb.ParseConfig).
 *
 * Nearest-scope resolution: same file → same directory (Go packages, Java
 * packages, Rust sibling modules) → an import edge to the defining file.
 *
 * Returns:
 *   'target'  — the name resolves to the target's package, or only one type
 *               definition exists project-wide (name IS identity)
 *   'other'   — positive evidence it denotes a DIFFERENT same-name type
 *   'unknown' — several same-name types exist and none is resolvable from
 *               this file's scope (not evidence either way)
 */
/**
 * Resolve a Go package-qualified receiver to its import module and decide
 * whether the pinned targets can live in that module's package (fix #206b).
 * Alias-aware: importNames[i] pairs 1:1 with imports[i] for Go (one package
 * name per import), so `v3corepb "github.com/.../core/v3"` resolves from the
 * alias, not the path segment.
 *
 * targetInPkg accepts a target whose project-relative directory is a SUFFIX
 * of the module path (robust when dir names diverge), or whose directory
 * basename matches the module's package segment / the receiver (conventional
 * fallback — also covers root-package projects, where relative dir is '').
 *
 * Returns null when the receiver names no import (likely a variable).
 */
function _receiverPackageResolution(index, fileEntry, receiver, targetDefs) {
    const modules = fileEntry.imports || [];
    const names = fileEntry.importNames || [];
    let importModule = null;
    if (names.length === modules.length) {
        const i = names.indexOf(receiver);
        if (i >= 0) importModule = modules[i];
    }
    if (!importModule) {
        importModule = modules.find(mod => {
            const parts = mod.split('/');
            const last = parts[parts.length - 1];
            const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
            return pkgName === receiver;
        }) || null;
    }
    if (!importModule) return null;
    if (!importModule.includes('/')) return { importModule, singleSegment: true, targetInPkg: false };
    const parts = importModule.split('/');
    const last = parts[parts.length - 1];
    const pkgSeg = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
    const targetInPkg = targetDefs.some(d => {
        if (!d.file) return false;
        const dir = path.dirname(d.file);
        const relDir = index.root ? path.relative(index.root, dir) : '';
        // Root-package target: its directory is the clone dir — package
        // identity is unverifiable from PATHS, and exclusion requires
        // POSITIVE evidence. go.mod's module line IS that identity (fix
        // #220, cobra-measured): `exec.Command(...)` on import "os/exec"
        // can never denote the root package's Command, while the root
        // self-import `cobra "github.com/spf13/cobra"` matches exactly.
        // Without a go.mod, never exclude (checkout-dir-name luck).
        if (!relDir || relDir === '.') {
            const goMod = findGoModule(index.root);
            if (goMod && goMod.modulePath) {
                // index.root may be a subtree of the go.mod root (grpc-go's
                // internal/xds target): the root package's import path is
                // modulePath + the subtree's relative path.
                let effective = goMod.modulePath;
                const sub = goMod.root && path.relative(goMod.root, index.root);
                if (sub && sub !== '.' && !sub.startsWith('..')) {
                    effective = effective + '/' + sub.split(path.sep).join('/');
                }
                return importModule === effective;
            }
            return true;
        }
        if (!relDir.startsWith('..') &&
            (importModule === relDir || importModule.endsWith('/' + relDir))) return true;
        const base = path.basename(dir);
        return base === pkgSeg || base === receiver;
    });
    return { importModule, singleSegment: false, targetInPkg };
}

/**
 * Name-level export-chain reachability (fix #217, rich-measured: 24 test-file
 * `render(bar)` calls confirmed against markup.render although the binding
 * `from .render import render` pins to tests/render.py's OWN def — file-level
 * _importReaches chased on through console.py's imports).
 *
 * A binding of NAME resolved to a module file can only denote a def in a
 * target file if the NAME itself flows there: through the file being a target
 * file, a re-export of the name (`export {x} from` / `export * from` /
 * Python `from .x import name`), or surfaces the chase cannot model. Verdicts:
 *   'yes'     — some chain reaches a target file (confirmable, as before)
 *   'no'      — every chain terminates away from the targets (exclusion-grade:
 *               the bare name provably denotes a different def)
 *   'unknown' — un-modelable surface on a live path: CJS exports (assignment-
 *               based, attribute re-exports indistinguishable from local
 *               values), star imports, module-scope assignments of the name,
 *               module-level __getattr__ (PEP 562), unresolved project-ish
 *               modules, depth exhaustion. Never exclusion evidence.
 * Pinned targets are defs NAMED `name`, so single renames along the chain
 * cannot fool a 'no' (a rename changes the exposed attribute name; re-renames
 * back to the original route through records this chase follows or flags).
 */
function _nameBindingReaches(index, startAbs, name, targetFiles, maxDepth = 4) {
    let unknown = false;
    const visited = new Set();
    let frontier = [[startAbs, name]];
    for (let d = 0; d <= maxDepth && frontier.length > 0; d++) {
        const next = [];
        for (const [abs, attr] of frontier) {
            if (targetFiles.has(abs)) return 'yes';
            const stateKey = `${abs}\x00${attr}`;
            if (visited.has(stateKey)) continue;
            visited.add(stateKey);
            const fe = index.files.get(abs);
            if (!fe) { unknown = true; continue; }

            // A concrete local export shadows every transitive dependency of
            // the same spelling. `module.exports = { helper }` in widgets.js
            // makes widgets.helper the local helper even if widgets imports a
            // different helper several hops below. Parser-provided localName
            // keeps this proof limited to syntactically-owned CJS exports;
            // dynamic assignments remain unknown — including a COMPETING
            // record for the same name without static ownership
            // (`exports.run = run;` then `if (native) exports.run =
            // require('./native').run;`) and a whole-surface reassignment
            // (`module.exports = require('./impl')`): either one can rebind
            // the member at runtime, so the static record alone never proves
            // a dead end (fix #292).
            const localExports = (fe.exportDetails || []).filter(e =>
                !e.source && (e.alias || e.name) === attr);
            const staticOwner = localExports.some(e => e.localName &&
                (index.symbols.get(e.localName) || [])
                    .some(definition => definition.file === abs &&
                        !NON_CALLABLE_TYPES.has(definition.type)));
            const competingDynamic = localExports.some(e => !e.localName) ||
                (fe.exportDetails || []).some(e => !e.source &&
                    e.defaultLike && e.type === 'module.exports' &&
                    (e.alias || e.name) !== attr);
            if (staticOwner && !competingDynamic) {
                return 'no';
            }

            const enqueue = (module, nextAttr) => {
                const rel = fe.moduleResolved && fe.moduleResolved[module];
                if (!rel) {
                    // Unresolved: relative or project-ish → resolver gap, not
                    // a terminal; clearly external → that path pins outside
                    // the project (dead end, consistent with #209c).
                    const mod = String(module);
                    const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                    if (mod.startsWith('.') ||
                        (firstSeg && _projectTopLevelNames(index).has(firstSeg))) unknown = true;
                    return;
                }
                next.push([path.join(index.root, rel), nextAttr]);
            };

            // CJS export surface is assignment-based (`exports.x = require(..).x`,
            // `module.exports = require(..)`) and recorded indistinguishably from
            // local values — a CJS file can never produce a definitive dead end.
            if ((fe.exportDetails || []).some(e => e.type === 'exports' || e.type === 'module.exports')) {
                unknown = true;
            }
            // JS/TS re-export records: `export {x as y} from './src'` exposes y,
            // chase continues under the SOURCE-side name; `export * from`
            // exposes everything the source does. `export * as ns from`
            // (alias on the re-export-all) exposes ONLY `ns` — a module
            // namespace object, unmodelable when asked for — never the
            // source's flattened names.
            for (const e of (fe.exportDetails || [])) {
                if (!e.source) continue;
                if (e.type === 're-export' && (e.alias || e.name) === attr) enqueue(e.source, e.name);
                else if (e.type === 're-export-all') {
                    if (e.alias) { if (e.alias === attr) unknown = true; }
                    else enqueue(e.source, attr);
                }
            }
            // Import bindings of the attr (Python re-export idiom `from .x import
            // name`, JS import-then-export). importBindings store ORIGINAL names;
            // importAliases is a flat list (pairing to its import lost), so a
            // renamed import is followed under BOTH its original and local names —
            // over-following errs toward 'yes'/'unknown', never toward exclusion.
            const aliases = fe.importAliases || [];
            for (const b of (fe.importBindings || [])) {
                const exposed = [b.name, ...aliases.filter(a => a.original === b.name).map(a => a.local)];
                if (exposed.includes(attr)) enqueue(b.module, b.name);
            }
            // Un-modelable name sources on this file:
            if ((fe.importNames || []).includes('*')) unknown = true;            // star import
            if ((fe.moduleAssignedNames || []).includes(attr)) unknown = true;   // module-scope `attr = ...`
            if ((index.symbols.get('__getattr__') || []).some(s => s.file === abs && !s.className)) {
                unknown = true;                                                  // PEP 562 dynamic attrs
            }
        }
        frontier = next;
    }
    if (frontier.length > 0) unknown = true; // depth exhausted with live paths
    return unknown ? 'unknown' : 'no';
}

/**
 * A CommonJS object export whose requested member has no statically-owned
 * local value cannot prove callable identity. For example,
 * `module.exports = { run: available ? nativeRun : fallback }` exposes the
 * local fallback only on one runtime branch. File-level import reachability
 * must not upgrade that conditional value to a confirmed edge.
 */
function _cjsMemberOwnershipAmbiguous(index, file, memberName) {
    const fe = index.files.get(file);
    // Both CJS assignment families count: `module.exports = { x: cond ? a : b }`
    // records type 'module.exports'; `exports.x = <dynamic>` records type
    // 'exports' (fix #292 — the sequential native/fallback feature-detect idiom).
    return !!fe && (fe.exportDetails || []).some(exp =>
        (exp.type === 'module.exports' || exp.type === 'exports') &&
        !exp.defaultLike && !exp.source &&
        (exp.alias || exp.name) === memberName && !exp.localName);
}

/**
 * Resolve a member reached through an exported ESM namespace object.
 *
 * Supported exact shapes:
 *   import * as api from './impl'; export { api };
 *   import * as api from './impl'; export default api;
 *   export * as api from './impl';
 *   export { api } from './barrel'; // recursively, when api is one above
 *
 * A plain exported object/value is deliberately not recognized. The caller
 * must remain in the ordinary structural receiver tier unless the export path
 * proves that the value is a module namespace exotic object.
 *
 * @returns {{ verdict: 'yes'|'no'|'unknown' }|null}
 */
function _namespaceExportMemberReaches(
    index, startAbs, exportedName, memberName, targetFiles, maxDepth = 4,
    visited = new Set(), memberPath = []
) {
    if (maxDepth < 0) return { verdict: 'unknown' };
    const stateKey = `${startAbs}\x00${exportedName}\x00${memberPath.join('.')}\x00${memberName}`;
    if (visited.has(stateKey)) return { verdict: 'unknown' };
    visited.add(stateKey);
    const fe = index.files.get(startAbs);
    if (!fe) return null;

    let recognized = false;
    let unknown = false;
    let explicitExport = false;
    const followMember = moduleName => {
        const rel = fe.moduleResolved?.[moduleName];
        if (!rel) {
            unknown = true;
            return 'unknown';
        }
        const nextAbs = path.join(index.root, rel);
        if (memberPath.length > 0) {
            const nested = _namespaceExportMemberReaches(
                index, nextAbs, memberPath[0], memberName, targetFiles,
                maxDepth - 1, new Set(visited), memberPath.slice(1));
            // The outer value is proven to be a namespace, but its requested
            // field is an ordinary/unmodeled value rather than another proven
            // namespace. That is uncertainty, never exclusion evidence.
            return nested?.verdict || 'unknown';
        }
        return _nameBindingReaches(index, nextAbs, memberName, targetFiles, maxDepth - 1);
    };
    const absorb = verdict => {
        if (verdict === 'yes') return true;
        if (verdict === 'unknown') unknown = true;
        return false;
    };

    for (const exp of (fe.exportDetails || [])) {
        // `export * as api from './impl'` is direct namespace identity.
        if (exp.type === 're-export-all' && exp.alias === exportedName) {
            explicitExport = true;
            recognized = true;
            if (absorb(followMember(exp.source))) return { verdict: 'yes' };
            continue;
        }

        const exposed = exp.type === 'default' ? 'default' : (exp.alias || exp.name);
        if (exposed !== exportedName) continue;
        explicitExport = true;

        // `export { api } from './barrel'`: the source-side value may itself
        // be a namespace export. Recurse under its source-side name.
        if (exp.type === 're-export' && exp.source) {
            const rel = fe.moduleResolved?.[exp.source];
            if (!rel) {
                unknown = true;
                recognized = true;
                continue;
            }
            const nested = _namespaceExportMemberReaches(
                index, path.join(index.root, rel), exp.name, memberName,
                targetFiles, maxDepth - 1, new Set(visited), memberPath);
            if (nested) {
                recognized = true;
                if (nested.verdict === 'yes') return { verdict: 'yes' };
                if (nested.verdict === 'unknown') unknown = true;
            }
            continue;
        }

        // `import * as api ...; export { api }` / `export default api`.
        if (!exp.source && (exp.type === 'named' || exp.type === 'default')) {
            const localName = exp.name;
            const namespaceBindings = (fe.importBindings || []).filter(binding =>
                (binding.alias || binding.name) === localName && binding.kind === 'namespace');
            for (const binding of namespaceBindings) {
                recognized = true;
                if (absorb(followMember(binding.module))) return { verdict: 'yes' };
            }
        }
    }

    // `export * from './barrel'` forwards named namespace-object exports too.
    // Explicit local/named exports shadow star exports, so only chase stars
    // when this file has no explicit surface for the requested name. Default
    // is never forwarded by export-star.
    if (!explicitExport && exportedName !== 'default') {
        const starExports = (fe.exportDetails || []).filter(exp =>
            exp.type === 're-export-all' && !exp.alias && exp.source);
        const starVerdicts = [];
        for (const exp of starExports) {
            const rel = fe.moduleResolved?.[exp.source];
            if (!rel) {
                unknown = true;
                continue;
            }
            const nested = _namespaceExportMemberReaches(
                index, path.join(index.root, rel), exportedName, memberName,
                targetFiles, maxDepth - 1, new Set(visited), memberPath);
            if (!nested) continue;
            recognized = true;
            starVerdicts.push(nested.verdict);
        }
        if (starVerdicts.length > 0) {
            // With several export-star providers, another star may expose the
            // same name and make the ESM binding ambiguous. We currently do
            // not compute full `ResolveExport` sets, so multi-star barrels are
            // demotion-only even when one path reaches the target.
            if (starExports.length > 1) unknown = true;
            else if (starVerdicts.includes('yes')) return { verdict: 'yes' };
            if (starVerdicts.includes('unknown')) unknown = true;
        }
    }

    if (!recognized) return null;
    return { verdict: unknown ? 'unknown' : 'no' };
}

/**
 * Determine whether a structural receiver imported by name/default is a
 * statically exported namespace object, and if so whether its requested member
 * can reach the pinned target files. Multiple live bindings must agree before
 * a negative becomes exclusion-grade.
 */
function _importedNamespaceMemberOwnership(index, fileEntry, call, targetFiles) {
    const receiver = call.receiver || call.receiverRoot;
    const memberPath = call.receiver
        ? [] : (call.receiverFields || (call.receiverField ? [call.receiverField] : []));
    const bindings = (fileEntry.importBindings || []).filter(binding =>
        (binding.alias || binding.name) === receiver &&
        (binding.kind === 'named' || binding.kind === 'default' || binding.kind === 'namespace'));
    if (bindings.length === 0) return null;

    let recognized = 0;
    let unknown = false;
    for (const binding of bindings) {
        const rel = fileEntry.moduleResolved?.[binding.module];
        if (!rel) continue;
        const startAbs = path.join(index.root, rel);
        let result;
        if (binding.kind === 'namespace') {
            result = memberPath.length > 0
                ? _namespaceExportMemberReaches(
                    index, startAbs, memberPath[0], call.name, targetFiles,
                    4, new Set(), memberPath.slice(1))
                : { verdict: _nameBindingReaches(index, startAbs, call.name, targetFiles) };
        } else {
            const exportedName = binding.kind === 'default' ? 'default' : binding.name;
            result = _namespaceExportMemberReaches(
                index, startAbs, exportedName, call.name, targetFiles,
                4, new Set(), memberPath);
        }
        if (!result) continue;
        recognized++;
        if (result.verdict === 'yes') return { verdict: 'yes' };
        if (result.verdict === 'unknown') unknown = true;
    }
    if (recognized === 0) return null;
    if (recognized !== bindings.length) unknown = true;
    return { verdict: unknown ? 'unknown' : 'no' };
}

/**
 * Ownership chase for a CommonJS default-like require binding:
 * `const local = require('./module')`. The local binding name says nothing
 * about the exporting file's symbol; the direct `module.exports = value`
 * record does. A locally defined callable is a definitive dead end for a
 * target in another file, an imported value is chased, and dynamic values
 * remain unknown. This is exclusion-grade only when every live path is known.
 */
function _defaultBindingReaches(index, startAbs, targetFiles, maxDepth = 4, visited = new Set()) {
    if (targetFiles.has(startAbs)) return 'yes';
    if (maxDepth < 0 || visited.has(startAbs)) return 'unknown';
    visited.add(startAbs);
    const fe = index.files.get(startAbs);
    if (!fe) return 'unknown';

    const defaults = (fe.exportDetails || []).filter(exp =>
        exp.type === 'module.exports' && exp.defaultLike);
    if (defaults.length === 0) return 'unknown';

    let unknown = false;
    for (const exp of defaults) {
        const localName = exp.localName || exp.name;
        if (!localName) { unknown = true; continue; }
        // Without parser-proven syntactic ownership (localName), the record's
        // name falls back to the synthesized 'default' — which a DYNAMIC
        // reassignment (`module.exports = require('./impl')`) shares with an
        // earlier anonymous default. Only a local callable declared AT the
        // record's own line proves that this record is the local value
        // (fix #292 — a name-only match must never dead-end the live import
        // path of the competing dynamic record).
        const localCallable = (index.symbols.get(localName) || []).some(definition =>
            definition.file === startAbs && !NON_CALLABLE_TYPES.has(definition.type) &&
            (exp.localName || definition.startLine === exp.line ||
                (definition.startLine <= exp.line && definition.endLine >= exp.line)));
        if (localCallable) continue;

        const bindings = (fe.importBindings || []).filter(binding =>
            binding.name === localName || binding.alias === localName);
        if (bindings.length === 0) { unknown = true; continue; }
        for (const binding of bindings) {
            const rel = fe.moduleResolved?.[binding.module];
            if (!rel) { unknown = true; continue; }
            const nextAbs = path.join(index.root, rel);
            const verdict = binding.defaultLike
                ? _defaultBindingReaches(
                    index, nextAbs, targetFiles, maxDepth - 1, new Set(visited))
                : _nameBindingReaches(index, nextAbs, binding.name, targetFiles, maxDepth - 1);
            if (verdict === 'yes') return 'yes';
            if (verdict === 'unknown') unknown = true;
        }
    }
    return unknown ? 'unknown' : 'no';
}

/**
 * From-import submodule receivers (fix #224): `from . import jobs` binds
 * jobs.py as a plain NAME — the parser can't mark it a module alias (a
 * from-import name may be a symbol), but the resolver proved it at build
 * time: graph-build records the composed submodule specifier ('.jobs') in
 * fileEntry.moduleResolved when it resolves to a project file. A hit makes
 * the receiver a MODULE receiver at query time. Returns the ROOT-RELATIVE
 * module file or null. Trait-gated (`submoduleImports` — Python only).
 */
function _submoduleReceiverModule(index, fileEntry, receiverName) {
    if (!receiverName || !fileEntry || !fileEntry.moduleResolved) return null;
    if (!langTraits(fileEntry.language)?.submoduleImports) return null;
    for (const b of (fileEntry.importBindings || [])) {
        if (!b || b.name !== receiverName || b.module == null) continue;
        const mod = String(b.module);
        const spec = mod.endsWith('.') ? mod + receiverName : mod + '.' + receiverName;
        const rel = fileEntry.moduleResolved[spec];
        if (rel) return rel;
    }
    return null;
}

/**
 * Bounded-depth reachability over the import graph: can `fromAbs` reach any
 * target file through re-export/import chains? Barrel hierarchies routinely
 * run 2-3 hops (zod: v4/index → classic/index → schemas), so name-level
 * module checks must not use a 1-hop budget (fix #209).
 */
function _importReaches(index, fromAbs, targetFiles, maxDepth = 4) {
    if (targetFiles.has(fromAbs)) return true;
    // Import ownership is queried repeatedly while a reachability walk
    // resolves return types and namespace calls. The graph is immutable for
    // the duration of an operation, so memoize the bounded BFS by source,
    // target set, and depth. This removed hundreds of milliseconds of
    // identical barrel-chain walks on large workspaces.
    const opCache = index._opImportReachCache;
    const targetKey = [...targetFiles].sort(codeUnitCompare).join('\x00');
    const cacheKey = `${maxDepth}\x00${fromAbs}\x00${targetKey}`;
    if (opCache?.has(cacheKey)) return opCache.get(cacheKey);
    const finish = (value) => {
        if (opCache) opCache.set(cacheKey, value);
        return value;
    };
    const visited = new Set([fromAbs]);
    let frontier = [fromAbs];
    for (let d = 0; d < maxDepth; d++) {
        const next = [];
        for (const f of frontier) {
            const edges = index.importGraph.get(f);
            if (!edges) continue;
            for (const e of edges) {
                if (visited.has(e)) continue;
                if (targetFiles.has(e)) return finish(true);
                visited.add(e);
                next.push(e);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return finish(false);
}

/**
 * Top-level path segments of the project (dir names + module names of root
 * files). Used to tell "module failed to resolve because it is EXTERNAL"
 * from "module failed to resolve because our resolver has a gap" — only the
 * former is exclusion evidence (fix #209). Memoized on the index.
 */
function _projectTopLevelNames(index) {
    if (index._projectTopLevelNames) return index._projectTopLevelNames;
    const names = new Set();
    for (const [, fe] of index.files) {
        const segs = (fe.relativePath || '').split(/[\\/]/);
        const seg = segs[0];
        if (!seg) continue;
        names.add(seg);
        const dot = seg.lastIndexOf('.');
        if (dot > 0) names.add(seg.slice(0, dot)); // utils.py → utils
        // PEP-517 src layout (fix #269): packages under a top-level src/
        // are importable by their SECOND segment — `import click` names
        // src/click. Without this, the externality test proved the
        // project's own package external (a resolver gap is not exclusion
        // evidence, #209).
        if (seg === 'src' && segs[1]) {
            names.add(segs[1]);
            const d2 = segs[1].lastIndexOf('.');
            if (d2 > 0) names.add(segs[1].slice(0, d2));
        }
    }
    index._projectTopLevelNames = names;
    return names;
}

const IDENTITY_TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum']);

/**
 * Parse a generics/type-parameter list text (`<T: Wipe, U>`, `<T extends X>`,
 * Go `[T any, U comparable]`) into the set of declared type-parameter NAMES.
 * Rust lifetimes (`'a`) and const params (`const N: usize`) are not receiver
 * types and are skipped.
 */
function _genericParamNames(genericsText) {
    if (!genericsText || typeof genericsText !== 'string') return null;
    const inner = genericsText.trim().replace(/^[<[]/, '').replace(/[>\]]$/, '');
    const names = new Set();
    let depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '<' || ch === '[' || ch === '(') depth++;
        else if (ch === '>' || ch === ']' || ch === ')') depth--;
        else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    for (let p of parts) {
        p = p.trim();
        if (!p || p.startsWith("'") || p.startsWith('const ')) continue;
        const m = p.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) names.add(m[1]);
    }
    return names.size > 0 ? names : null;
}

/**
 * Is typeName a declared GENERIC TYPE PARAMETER in scope at this call site —
 * on the enclosing function itself (`fn f<TStore: Wipe>(t: &TStore)`) or on
 * its class/struct (`impl<T> Processor<T>` methods see the struct's `<T>`)?
 * A generic param is never type identity in either direction (fix #229, the
 * #220(1) convention rule made precise): it may be instantiated with the
 * target class, so it neither validates nor excludes — and the declaration
 * shadows any same-named project type inside the function.
 */
function _isEnclosingGenericParam(index, filePath, line, typeName) {
    const enclosing = index.findEnclosingFunction(filePath, line, true);
    if (!enclosing) return false;
    const own = _genericParamNames(enclosing.generics);
    if (own && own.has(typeName)) return true;
    if (enclosing.className) {
        const classDefs = (index.symbols.get(enclosing.className) || []).filter(d =>
            IDENTITY_TYPE_KINDS.has(d.type) && d.file === filePath);
        for (const cd of classDefs) {
            const cg = _genericParamNames(cd.generics);
            if (cg && cg.has(typeName)) return true;
        }
    }
    return false;
}

/**
 * Receiver-type identity guard shared by the parser-typed branch and the
 * local-inference fallback: a name is NOT usable as type identity when it is
 * a generic type param — declared in the enclosing scope, or matching the
 * 1-2-char ALL-CAPS convention (T, K, V, T1) with no project type def (the
 * declaring scope may be outside what UCN parsed).
 */
function _isGenericParamReceiverType(index, filePath, line, typeName) {
    if (!typeName) return false;
    if (/^[A-Z][A-Z0-9]?$/.test(typeName) &&
        !(index.symbols.get(typeName) || []).some(d => IDENTITY_TYPE_KINDS.has(d.type))) return true;
    return _isEnclosingGenericParam(index, filePath, line, typeName);
}

/**
 * Java same-package check across Maven/Gradle source roots (fix #246):
 * src/main/java/<pkg> and src/test/java/<pkg> hold the SAME package —
 * javac compiles both source sets onto one classpath, so a test file sees
 * the main tree's package members without an import. Two dirs are
 * same-package when equal, or (Java only) when both sit under a
 * `src/<set>/java/` source root with the same module prefix and the same
 * package-relative path. Different modules keep distinct prefixes, so
 * same-named packages across a monorepo stay separate.
 */
function _sameNominalPackageDir(dirA, dirB, language) {
    if (dirA === dirB) return true;
    if (language !== 'java') return false;
    const norm = (d) => {
        const m = d.match(/^(.*?)[/\\]src[/\\][^/\\]+[/\\]java(?:[/\\](.*))?$/);
        return m ? `${m[1]}\0${m[2] || ''}` : null;
    };
    const a = norm(dirA);
    if (a === null) return false;
    return a === norm(dirB);
}

function _resolveReceiverTypeIdentity(index, filePath, knownType, targetDefs, line, namespaceHint) {
    const typeDefs = (index.symbols.get(knownType) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
    const fileEntry = index.files.get(filePath);
    const language = fileEntry?.language;
    if (language === 'java' && namespaceHint && /^[A-Z]/.test(namespaceHint)) {
        const nested = typeDefs.filter(d => d.enclosingType === namespaceHint);
        if (nested.length > 0) {
            const targetFiles = new Set(targetDefs
                .filter(d => d.className === knownType &&
                    d.enclosingType === namespaceHint && d.file)
                .map(d => d.file));
            return nested.some(d => targetFiles.has(d.file)) ? 'target' : 'other';
        }
        // The qualifier is syntactically a nested owner but the project index
        // cannot resolve it. That is not exclusion evidence.
        return 'unknown';
    }
    if (language === 'java' && line == null) {
        // Return-flow annotations are interpreted in the PRODUCER definition's
        // file. That origin is stronger than same-package lookup and is
        // essential for same-named nested builders in one Java package.
        const inOrigin = typeDefs.filter(d => d.file === filePath);
        if (inOrigin.length > 0) {
            const isTargetType = d => targetDefs.some(t =>
                t.file === d.file && t.className === knownType &&
                (t.enclosingType || null) === (d.enclosingType || null));
            return inOrigin.some(isTargetType) ? 'target' : 'other';
        }
    }
    if (language === 'csharp') {
        const targetNamespaces = new Set(targetDefs.map(d => d.namespace || null));
        const enclosing = line != null
            ? index.findEnclosingFunction(filePath, line, true) : null;
        // Calls inside property/event accessors may have no standalone
        // function symbol. The containing field/property/class still carries
        // the exact namespace, so use the narrowest enclosing indexed symbol
        // before falling back to the global namespace.
        const containingSymbol = line != null
            ? (fileEntry?.symbols || [])
                .filter(symbol => symbol.startLine <= line &&
                    symbol.endLine >= line && symbol.namespace != null)
                .sort((left, right) =>
                    (left.endLine - left.startLine) -
                    (right.endLine - right.startLine))[0]
            : null;
        const callerNamespace =
            enclosing?.namespace || containingSymbol?.namespace || null;
        // An explicitly-qualified annotation names one namespace exactly.
        // An unqualified C# type follows lexical namespace lookup from the
        // current namespace through its enclosing namespace prefixes before
        // considering using directives (`Newtonsoft.Json.Converters` can
        // see `Newtonsoft.Json.JsonReader`).
        const namespaceCandidates = [];
        if (namespaceHint) {
            namespaceCandidates.push(namespaceHint);
        } else if (callerNamespace) {
            const segments = callerNamespace.split('.');
            while (segments.length > 0) {
                namespaceCandidates.push(segments.join('.'));
                segments.pop();
            }
        } else {
            namespaceCandidates.push(null);
        }
        for (const candidate of namespaceCandidates) {
            const inNamespace = typeDefs.filter(d =>
                (d.namespace || null) === candidate);
            if (inNamespace.length > 0) {
                return inNamespace.some(d =>
                    targetNamespaces.has(d.namespace || null))
                    ? 'target' : 'other';
            }
        }
        // A namespace-level using can supply the type when the current
        // namespace does not declare it. The import graph is exact for
        // project namespaces; unresolved/external usings stay unknown.
        const imports = index.importGraph.get(filePath);
        if (imports) {
            const imported = typeDefs.filter(d => d.file && imports.has(d.file));
            if (imported.length > 0) {
                return imported.some(d => targetNamespaces.has(d.namespace || null))
                    ? 'target' : 'other';
            }
        }
        return 'unknown';
    }
    if (typeDefs.length <= 1) return 'target';
    const targetDirs = new Set(targetDefs.map(d => d.file && path.dirname(d.file)).filter(Boolean));
    const inTargetPkg = (d) => d.file && [...targetDirs].some(dir =>
        _sameNominalPackageDir(path.dirname(d.file), dir, language));
    // Explicit imports outrank package proximity. This matters in Java files
    // that sit beside `Token.Comment` but import `org.jsoup.nodes.Comment`.
    // A nested type is not a package member and cannot win a bare type lookup.
    const namedBindings = (fileEntry?.importBindings || []).filter(b =>
        b.name === knownType || b.alias === knownType);
    if (namedBindings.length > 0) {
        const resolved = new Set();
        for (const binding of namedBindings) {
            const rel = fileEntry.moduleResolved?.[binding.module];
            if (rel) {
                resolved.add(path.join(index.root, rel));
            }
            if (language === 'rust') {
                for (const origin of _rustBindingResolvedFiles(
                    index, fileEntry, filePath, binding)) {
                    resolved.add(origin);
                }
            }
        }
        const imported = typeDefs.filter(d => resolved.has(d.file));
        if (imported.length > 0) return imported.some(inTargetPkg) ? 'target' : 'other';
        // Barrel/module imports bind declarations exported through that
        // module, not only declarations physically written in its file.
        // Rust's `use crate::builder::Command` normally lands on mod.rs and
        // re-exports the concrete command.rs type. A bounded file-level
        // closure is conservative here: ambiguity stays unknown.
        const reachable = typeDefs.filter(d => [...resolved].some(start =>
            _importReaches(index, start, new Set([d.file]))));
        if (reachable.length > 0) {
            return reachable.some(inTargetPkg) ? 'target' : 'other';
        }
        return 'unknown';
    }
    const callerClass = line != null
        ? index.findEnclosingFunction(filePath, line, true)?.className : null;
    const sameFile = typeDefs.filter(d => d.file === filePath &&
        (!d.enclosingType || d.enclosingType === callerClass));
    if (sameFile.length > 0) return sameFile.some(inTargetPkg) ? 'target' : 'other';
    const callerDir = path.dirname(filePath);
    const sameDir = typeDefs.filter(d => d.file &&
        !d.enclosingType &&
        _sameNominalPackageDir(path.dirname(d.file), callerDir, language));
    if (sameDir.length > 0) return sameDir.some(inTargetPkg) ? 'target' : 'other';
    if (language === 'java') {
        const wildcardPackages = (fileEntry?.imports || [])
            .filter(m => String(m).endsWith('.*'))
            .map(m => String(m).slice(0, -2));
        if (wildcardPackages.length > 0) {
            const imported = typeDefs.filter(d => !d.enclosingType && d.relativePath &&
                wildcardPackages.includes(_javaPackageKey(d.relativePath).replace(/\//g, '.')));
            if (imported.length > 0) return imported.some(inTargetPkg) ? 'target' : 'other';
        }
    }
    const imports = index.importGraph.get(filePath);
    if (imports) {
        const imported = typeDefs.filter(d => d.file && imports.has(d.file));
        if (imported.length > 0) return imported.some(inTargetPkg) ? 'target' : 'other';
    }
    return 'unknown';
}

/**
 * Resolve a structural flow type by declaration origin and walk that exact
 * declaration's inheritance chain toward the pinned target owner. This is
 * stricter than name-only targetTypes and more accurate than comparing the
 * receiver type's directory directly with the target method's directory:
 * legitimate subclasses routinely live elsewhere (Click test-local
 * CustomCommand extends click.Command), while parallel package versions may
 * reuse every class name (zod v3/v4 ZodArray -> ZodType).
 */
function _resolveStructuralFlowTypeIdentity(index, originFile, knownType, targetDefs, qualifier) {
    const origin = _resolveFlowTypeOrigin(index, originFile, knownType, qualifier);
    if (!origin?.fromFile) return 'unknown';
    const targetOwners = new Set(targetDefs
        .map(d => d.className || (d.receiver && d.receiver.replace(/^\*/, '')))
        .filter(Boolean));
    if (targetOwners.size === 0) return 'unknown';
    const targetFiles = new Map();
    for (const owner of targetOwners) {
        const methodFiles = targetDefs.filter(d =>
            (d.className || (d.receiver && d.receiver.replace(/^\*/, ''))) === owner)
            .map(d => d.file).filter(Boolean);
        const typeDefs = (index.symbols.get(owner) || [])
            .filter(d => IDENTITY_TYPE_KINDS.has(d.type) && d.file);
        const files = new Set();
        for (const mf of methodFiles) {
            for (const td of typeDefs) {
                if (td.file === mf) files.add(td.file);
            }
            if (files.size === 0) files.add(mf);
        }
        targetFiles.set(owner, files);
    }
    const ownerIdentity = (name, file) => {
        if (!targetOwners.has(name)) return null;
        if (!file) return 'unknown';
        const files = targetFiles.get(name) || new Set();
        if (files.has(file)) return 'target';
        return 'other';
    };
    const direct = ownerIdentity(knownType, origin.fromFile);
    if (direct === 'target') return direct;

    const targetKeys = new Set(targetDefs
        .filter(d => d.file && d.startLine != null)
        .map(d => `${d.file}:${d.startLine}`));
    const overridesPinnedSlot = (name, file) => {
        if (!file) return false;
        const methodName = targetDefs[0]?.name;
        if (!methodName) return false;
        return (index.symbols.get(methodName) || []).some(d =>
            d.file === file && d.className === name &&
            !targetKeys.has(`${d.file}:${d.startLine}`));
    };

    // Resolve a parent as written in the child file. Import bindings know the
    // module file, while export details recover the source-side type name for
    // `export { Internal as PublicBase }`. Keeping both pieces prevents
    // same-named classes in other files from being conflated.
    const parentOrigin = (parent, childFile) => {
        const fe = index.files.get(childFile);
        if (fe) {
            const alias = (fe.importAliases || []).find(a => a.local === parent);
            const importedName = alias?.original || parent;
            const binding = (fe.importBindings || []).find(b =>
                b.name === importedName || b.alias === parent);
            const rel = binding && fe.moduleResolved?.[binding.module];
            if (rel) {
                const parentFile = path.join(index.root, rel);
                const parentEntry = index.files.get(parentFile);
                const exported = (parentEntry?.exportDetails || []).find(e =>
                    (e.alias || e.name) === importedName);
                const canonical = exported?.name || importedName;
                const ownsCanonical = (index.symbols.get(canonical) || []).some(d =>
                    IDENTITY_TYPE_KINDS.has(d.type) && d.file === parentFile);
                return { name: ownsCanonical ? canonical : importedName, file: parentFile };
            }
        }
        const parentFile = index._resolveClassFile
            ? index._resolveClassFile(parent, childFile) : undefined;
        return { name: parent, file: parentFile };
    };

    const queue = [{ name: knownType, file: origin.fromFile }];
    const visited = new Set();
    let sawUnresolved = direct === 'unknown';
    while (queue.length > 0 && visited.size < 128) {
        const cur = queue.shift();
        const key = `${cur.file || ''}\0${cur.name}`;
        if (visited.has(key)) continue;
        visited.add(key);
        // An override on the concrete receiver intercepts dispatch before the
        // ancestor slot. In that case ancestry is evidence for the other
        // definition, not the pinned one.
        if (overridesPinnedSlot(cur.name, cur.file)) continue;
        const parents = index._getInheritanceParents(cur.name, cur.file) || [];
        for (const parent of parents) {
            const edge = parentOrigin(parent, cur.file);
            const verdict = ownerIdentity(edge.name, edge.file);
            if (verdict === 'target') return 'target';
            if (verdict === 'unknown') sawUnresolved = true;
            if (edge.file) queue.push(edge);
            else sawUnresolved = true;
        }
    }
    return sawUnresolved ? 'unknown' : 'other';
}

/**
 * Trait-declaration pin gate (fix #296, serde-as_cast-measured): when the
 * pinned target is a TRAIT's own method declaration, a path call on a
 * concrete NON-target receiver (`u64::as_cast`, `Limb::as_cast`,
 * `Self::Unsigned::as_cast`) is not evidence against the edge — any type
 * (external primitives, macro-generated impls UCN cannot index, aliases)
 * can implement a project trait, and the call dispatches through the pinned
 * slot. Returns the trait's name when the gate applies: the caller routes
 * possible-dispatch "via <Recv> — trait implementor" instead of excluding
 * path-type-mismatch. Two refusals keep the exclusion sound elsewhere:
 * impl-member pins (a foreign-type path call binds a DIFFERENT slot member
 * — static dispatch, exclusion correct), and receivers resolving to a
 * project type whose only same-name members provably belong to another
 * surface (inherent members / other traits — Rust resolves inherent first).
 */
function _traitDeclPinImplementorRoute(index, fileEntry, receiverSegment, targetDefs) {
    if (langTraits(fileEntry.language)?.typeQualifiedCallStyle !== 'path') return null;
    let traitName = null;
    for (const td of targetDefs || []) {
        if (!td.className || td.traitName) continue;
        const classDefs = index.symbols.get(td.className) || [];
        if (classDefs.some(d => d.type === 'trait' && d.file === td.file)) {
            traitName = td.className;
            break;
        }
    }
    if (!traitName) return null;
    // Receiver resolving to a project type: its indexed same-name members
    // decide. An inherent member or a different trait's impl owns the call
    // (keep the exclusion); a member implementing THIS trait — or no indexed
    // member at all (macro-generated impls are invisible) — routes visible.
    const recvTypeDefs = (index.symbols.get(receiverSegment) || [])
        .filter(d => IDENTITY_TYPE_KINDS.has(d.type));
    if (recvTypeDefs.length > 0) {
        const targetName = targetDefs[0] && targetDefs[0].name;
        const members = (index.symbols.get(targetName) || [])
            .filter(d => d.className === receiverSegment);
        if (members.length > 0 && members.every(m => m.traitName !== traitName)) {
            return null;
        }
    }
    return traitName;
}

/**
 * Is typeName an ancestor (transitively) of any target definition's class?
 * Used by receiver-class disambiguation: a receiver typed as a SUPERTYPE of
 * the target's class is not evidence against the target — dynamic dispatch
 * may run the target override at that site.
 */
function _isAncestorOfTargetClass(index, typeName, targetDefs) {
    const visited = new Set();
    const queue = [];
    for (const td of targetDefs) {
        const cls = td.className || (td.receiver && td.receiver.replace(/^\*/, ''));
        if (cls) queue.push({ name: cls, file: td.file });
    }
    while (queue.length > 0) {
        const { name, file } = queue.shift();
        if (visited.has(name)) continue;
        visited.add(name);
        const parents = index._getInheritanceParents(name, file) || [];
        for (const parent of parents) {
            if (parent === typeName) return true;
            if (!visited.has(parent)) {
                const parentFile = index._resolveClassFile ? index._resolveClassFile(parent, file) : file;
                queue.push({ name: parent, file: parentFile });
            }
        }
    }
    return false;
}

/**
 * Do two classes share a project descendant (Python #202b guard)? With
 * multiple inheritance, `self.method()` inside Mixin dispatches through
 * type(self).__mro__ — a class C(Target, Mixin) looks the method up on
 * Target BEFORE Mixin, so a sibling-class exclusion is only sound when no
 * project class inherits from both sides. Conservative: any common
 * descendant keeps the edge regardless of MRO order.
 */
function _collectDescendants(index, className, cap = 256) {
    const out = new Set([className]);
    const queue = [className];
    while (queue.length > 0 && out.size < cap) {
        const children = index.extendedByGraph?.get(queue.pop());
        if (!children) continue;
        for (const child of children) {
            const cName = typeof child === 'string' ? child : child.name;
            if (!cName || out.has(cName)) continue;
            out.add(cName);
            queue.push(cName);
        }
    }
    return out;
}

function _descendantOverrideOwners(index, className, methodName) {
    const descendants = _collectDescendants(index, className);
    descendants.delete(className);
    const owners = new Set();
    for (const d of (index.symbols.get(methodName) || [])) {
        if (NON_CALLABLE_TYPES.has(d.type)) continue;
        const owner = d.className || (d.receiver && d.receiver.replace(/^\*/, ''));
        if (owner && descendants.has(owner)) owners.add(owner);
    }
    return owners;
}

function _shareProjectDescendant(index, className, targetClasses) {
    if (!targetClasses || targetClasses.size === 0) return false;
    const mine = _collectDescendants(index, className);
    for (const t of targetClasses) {
        const theirs = _collectDescendants(index, t);
        // matchedClass BELOW the target: every descendant's MRO finds the
        // matched override before the target (subclass precedes superclass
        // in C3) — the target def is unreachable from this site, exclusion
        // stands. Not an MRO trap.
        if (theirs.has(className)) continue;
        for (const d of theirs) {
            if (mine.has(d)) return true;
        }
    }
    return false;
}

/**
 * Resolve a one-hop field receiver to the field's DECLARED type (fix #202):
 * rootType.fieldName → the field's declared type from the struct/class body
 * (Rust/Go/Java parsers emit field members with fieldType). Returns null —
 * never a wrong type — when: no such field, the declared type doesn't
 * normalize to a plain nominal name (slices, fn types, wrappers), same-named
 * classes disagree, or the type is a trait/interface (dynamic dispatch —
 * a trait-typed field is not evidence against any implementor).
 */
/**
 * Overload-signature identity (fix #265, zustand-measured): TS overload
 * signatures and their implementation — and Python @overload stubs and their
 * body — declare ONE function: `export function useStore(a): T;` ×2 plus the
 * implementation are the same symbol, so a call binding any member IS a call
 * to the pinned one (the #208 alias-identity principle for callables).
 * Closes the pin over same-file, same-class, same-nesting callable defs when
 * the group contains a signature — the overload idiom's proof. Plain
 * same-name redefinition (JS rebinding, Python last-wins shadowing) has no
 * signature member and never closes. `definitions` is the same-name def list,
 * so the group key needs no name component.
 */
function _closeCallableIdentityGroup(index, targetDefs, definitions) {
    const keyOf = (d) => `${d.file}\0${d.className || ''}\0${d.isNested ? 1 : 0}`;
    const groups = new Map();
    for (const d of definitions) {
        if (NON_CALLABLE_TYPES.has(d.type)) continue;
        const k = keyOf(d);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
    }
    let expanded = null;
    for (const t of targetDefs) {
        const language = index.files.get(t.file)?.language;
        if (!['typescript', 'tsx', 'python'].includes(language)) continue;
        const group = groups.get(keyOf(t));
        if (!group || group.length <= 1 || !group.some(d => d.isSignature)) continue;
        for (const d of group) {
            if (targetDefs.includes(d) || (expanded && expanded.includes(d))) continue;
            if (!expanded) expanded = [...targetDefs];
            expanded.push(d);
        }
    }

    // TypeScript declaration/runtime pairing (preact-signals measured):
    // `class Signal { constructor(...) }` supplies the public type surface,
    // while `function Signal(this: Signal, ...)` is the ES5-size-optimized
    // runtime constructor. `new Signal()` resolves to both in the compiler
    // oracle. The explicit this:Self parameter is the proof; ordinary same-
    // name class/function declarations never close.
    const explicitThisSelf = (d) => {
        if (d.type !== 'function' || !Array.isArray(d.paramsStructured)) return false;
        const first = d.paramsStructured[0];
        if (!first || first.name !== 'this' || !first.type) return false;
        const head = String(first.type).replace(/<.*$/, '').split('.').pop();
        return head === d.name;
    };
    for (const t of targetDefs) {
        const pair = definitions.filter(d => d.file === t.file && d.name === t.name &&
            ((t.type === 'class' && explicitThisSelf(d)) ||
             (explicitThisSelf(t) && d.type === 'class')));
        for (const d of pair) {
            if (targetDefs.includes(d) || (expanded && expanded.includes(d))) continue;
            if (!expanded) expanded = [...targetDefs];
            expanded.push(d);
        }
    }

    // C and C++ prototypes and their out-of-line definitions are one
    // compiler symbol even though they necessarily live at two source
    // locations. Keep unrelated same-name functions separate: external
    // linkage, an exact callable parameter shape, compatible owner identity,
    // and a resolved include edge from the implementation to the declaration
    // are all required. A static header declaration is per-translation-unit
    // identity and therefore never closes across files.
    const cFamilyLanguage = d => index.files.get(d.file)?.language;
    const cFamilyParamKey = d => {
        if (!Array.isArray(d.paramsStructured)) return null;
        return d.paramsStructured.map(param => {
            if (param.variadic) return '...';
            let type = String(param.type || '').replace(/\s+/g, ' ').trim();
            if (!type) return null;
            // Parameter names are not part of a C/C++ function type.
            if (param.name) {
                const escaped = String(param.name)
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                type = type.replace(
                    new RegExp(`\\b${escaped}\\b(?=\\s*(?:\\[[^\\]]*\\])?\\s*$)`),
                    '').replace(/\s+/g, ' ').trim();
            }
            return type.replace(/\s*([*&,[\]()])\s*/g, '$1');
        }).join('\0');
    };
    const normalizedOwner = definition => {
        const owner = definition.className || definition.receiver || '';
        if (cFamilyLanguage(definition) !== 'cpp') return owner;
        return String(owner).replace(/<.*>$/, '');
    };
    const sameOwner = (left, right) =>
        normalizedOwner(left) === normalizedOwner(right) &&
        (left.namespace || '') === (right.namespace || '');
    const includesDeclaration = (implementation, declaration) => {
        if (implementation.file === declaration.file) return true;
        const declarationRel = declaration.relativePath ||
            path.relative(index.root, declaration.file);
        const target = path.join(index.root, declarationRel);
        const queue = [implementation.file];
        const seen = new Set(queue);
        for (let depth = 0; queue.length > 0 && depth < 16; depth++) {
            const file = queue.shift();
            for (const imported of index.importGraph?.get(file) || []) {
                if (imported === target) return true;
                if (!seen.has(imported)) {
                    seen.add(imported);
                    queue.push(imported);
                }
            }
        }
        return false;
    };
    for (const target of targetDefs) {
        const language = cFamilyLanguage(target);
        const targetHasInternalLinkage =
            target.modifiers?.includes('static') &&
            !target.className && !target.receiver;
        if (!['c', 'cpp'].includes(language) ||
            targetHasInternalLinkage) continue;
        const targetParamKey = cFamilyParamKey(target);
        if (targetParamKey === null) continue;
        for (const candidate of definitions) {
            const candidateHasInternalLinkage =
                candidate.modifiers?.includes('static') &&
                !candidate.className && !candidate.receiver;
            if (candidate === target ||
                cFamilyLanguage(candidate) !== language ||
                candidateHasInternalLinkage ||
                cFamilyParamKey(candidate) !== targetParamKey ||
                !sameOwner(target, candidate) ||
                target.isSignature === candidate.isSignature) {
                continue;
            }
            const declaration = target.isSignature ? target : candidate;
            const implementation = target.isSignature ? candidate : target;
            if (!includesDeclaration(implementation, declaration)) continue;
            if (targetDefs.includes(candidate) ||
                (expanded && expanded.includes(candidate))) continue;
            if (!expanded) expanded = [...targetDefs];
            expanded.push(candidate);
        }
    }

    // C++ full specializations (`template <> bool f<bool>(...)`) are the SAME
    // compiler symbol as their primary template: name lookup finds the
    // template, and the specialization is selected by substitution, never by
    // overload resolution (fix #299). Closure requires exactly ONE primary
    // template with the owner identity — with several primaries the compiler
    // matches the specialization by signature substitution, which is not
    // grep-reliability evidence, so the group refuses and sites stay visible.
    for (const target of targetDefs) {
        if (cFamilyLanguage(target) !== 'cpp') continue;
        if (!target.isSpecialization && !target.templateDependent) continue;
        const related = definitions.filter(d =>
            !NON_CALLABLE_TYPES.has(d.type) &&
            cFamilyLanguage(d) === 'cpp' && sameOwner(target, d) &&
            (d.isSpecialization || (d.templateDependent && !d.isSignature)));
        const primaries = related.filter(d => !d.isSpecialization);
        const specializations = related.filter(d => d.isSpecialization);
        if (primaries.length !== 1 || specializations.length === 0) continue;
        if (!related.some(d => d === target ||
            (d.file === target.file && d.startLine === target.startLine))) {
            continue;
        }
        const primary = primaries[0];
        for (const candidate of related) {
            if (candidate !== primary &&
                !includesDeclaration(candidate, primary)) continue;
            if (targetDefs.includes(candidate) ||
                (expanded && expanded.includes(candidate))) continue;
            if (!expanded) expanded = [...targetDefs];
            expanded.push(candidate);
        }
    }
    return expanded || targetDefs;
}

/**
 * Resolve an alias from the declaration selected by the receiver's exact
 * origin. Global alias purity deliberately refuses names whose definitions
 * disagree across modules; once an import pins one module, that module's
 * alias is compiler identity and can safely participate in exclusion.
 */
function _aliasBaseAtOrigin(index, typeName, originFile, originLine = null) {
    if (!typeName || !originFile) return null;
    let current = typeName;
    const seen = new Set([current]);
    for (let hop = 0; hop < 4; hop++) {
        let localDefs = (index.symbols.get(current) || []).filter(d =>
            d.file === originFile &&
            (d.type === 'type' || IDENTITY_TYPE_KINDS.has(d.type)));
        if (originLine != null && localDefs.length > 1) {
            const scoped = localDefs.filter(d =>
                d.lexicalScopeStartLine != null &&
                d.lexicalScopeEndLine != null &&
                d.lexicalScopeStartLine <= originLine &&
                originLine <= d.lexicalScopeEndLine);
            if (scoped.length > 0) {
                const narrowest = Math.min(...scoped.map(d =>
                    d.lexicalScopeEndLine - d.lexicalScopeStartLine));
                localDefs = scoped.filter(d =>
                    d.lexicalScopeEndLine - d.lexicalScopeStartLine === narrowest);
            } else {
                // Aliases declared in sibling classes/scopes are not visible
                // merely because they share a source file and spelling.
                localDefs = localDefs.filter(d =>
                    d.lexicalScopeStartLine == null ||
                    d.lexicalScopeEndLine == null);
            }
        }
        if (localDefs.length === 0) {
            return current === typeName ? null : current;
        }
        if (localDefs.some(d => d.type !== 'type' || !d.aliasOf)) {
            return current === typeName ? null : current;
        }
        const bases = new Set(localDefs.map(d =>
            _normalizedAliasBase(index, d)));
        if (bases.size !== 1) return null;
        const base = [...bases][0];
        if (!base || seen.has(base)) return null;
        seen.add(base);
        current = base;
    }
    return current;
}

function _normalizedAliasBase(index, definition) {
    const raw = definition?.aliasOf;
    if (!raw) return raw;
    const language = index.files.get(definition.file)?.language;
    return _normalizeFieldTypeName(raw, language) || raw;
}

/**
 * Pure-alias base resolution (fix #265 — the #208 identity for declared
 * types): when EVERY type-kind definition of a name is an alias agreeing on
 * one base, the name IS the base type (`type StoreMap = Map<...>` types a
 * `store: StoreMap` field as Map). Chases alias-of-alias chains bounded and
 * cycle-guarded; mixed or disagreeing names never resolve.
 */
function _pureAliasBase(index, typeName) {
    let current = typeName;
    const seen = new Set([current]);
    for (let hop = 0; hop < 4; hop++) {
        const defs = index.symbols.get(current);
        if (!defs || defs.length === 0) return current === typeName ? null : current;
        let base = null;
        for (const d of defs) {
            if (d.type !== 'type' && !IDENTITY_TYPE_KINDS.has(d.type)) continue;
            if (d.type === 'type' && d.aliasOf) {
                const normalized = _normalizedAliasBase(index, d);
                if (base === null) base = normalized;
                else if (base !== normalized) return null; // disagreeing aliases
            } else {
                // a real type of this name exists — the name is not purely an alias
                return current === typeName ? null : current;
            }
        }
        if (!base) return current === typeName ? null : current;
        if (seen.has(base)) return null; // cycle
        seen.add(base);
        current = base;
    }
    return current;
}

/**
 * Validate a parser-observed `auto local = Candidate(); return local;` as a
 * C++ functional construction. The syntax can also call a factory function,
 * so only a uniquely visible project type with no visible standalone
 * callable of that spelling becomes return-type evidence.
 */
function _cppAutoReturnConcreteType(index, definition) {
    const candidate = definition?.returnedConcreteType;
    if (!candidate || !definition.file) return null;
    const visible = _cppVisibleFiles(index, definition.file);
    const symbols = index.symbols.get(candidate) || [];
    const types = symbols.filter(symbol =>
        IDENTITY_TYPE_KINDS.has(symbol.type) &&
        (symbol.file === definition.file || visible.has(symbol.file)));
    if (types.length === 0 ||
        new Set(types.map(symbol => symbol.file)).size !== 1) return null;
    const standalone = symbols.filter(symbol =>
        !NON_CALLABLE_TYPES.has(symbol.type) &&
        !symbol.className && !symbol.receiver &&
        (symbol.file === definition.file || visible.has(symbol.file)));
    return standalone.length === 0 ? candidate : null;
}

// Does the qualifier of a Go pkg.Type field annotation name one of the
// declaring file's imports? (last-segment match, version-suffix aware —
// the goImportModule convention.) Presence + no project resolution above
// makes the field's type provably external (fix #268).
function _goQualifierNamesImport(index, fieldFile, qualifier) {
    const fe = index.files.get(fieldFile);
    if (!fe || !Array.isArray(fe.imports)) return false;
    return fe.imports.some(mod => {
        const parts = String(mod).split('/');
        const last = parts[parts.length - 1];
        const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
        return pkgName === qualifier;
    });
}

// Same-class overload selection, callee direction (fix #268, jsoup-measured:
// all 71 tb.process sites confirmed to the 1-arg overload — the .find()
// pick was defs[0] in canonical order). Arity narrows first; Java argKinds
// refine same-arity families; exactly one survivor binds, anything else is
// statically undecidable and routes visible.
// Resolve a Go package-qualified call to a definition in the imported
// package (dir-path suffix match against the import path; LONGEST suffix
// wins so import "k8s.io/client-go/kubernetes/scheme" prefers a def in
// .../kubernetes/scheme/ over .../kubeadm/scheme/). Extracted for reuse:
// the parser marks some package calls isMethod:false (fix #268).
/**
 * External-producer attribution for a for-loop iterable call (fix #294).
 * Only module-qualified producers count: the module boundary is the
 * externality evidence (`importlib.metadata.entry_points(...)`,
 * `os.walk(...)`). Same externality test as #209/#222 — relative or
 * project-ish modules are resolver gaps, never externality evidence.
 * Returns the attribution string or null.
 */
function _iterExternalProducerVia(index, fileEntry, call) {
    if (!fileEntry || langTraits(fileEntry.language)?.typeSystem === 'nominal') return null;
    const externalModule = (mod) => {
        if (!mod || mod.startsWith('.')) return false;
        if (fileEntry.moduleResolved?.[mod]) return false;
        const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
        return !(firstSeg && _projectTopLevelNames(index).has(firstSeg));
    };
    if (call.isMethod && call.receiverIsModule && call.receiver) {
        const binding = _structuralModuleBindings(fileEntry, call)[0];
        if (binding && externalModule(String(binding.module))) {
            return `${call.receiver}.${call.name}`;
        }
        return null;
    }
    if (call.receiverRoot && !call.receiverRootType) {
        const binding = (fileEntry.importBindings || []).find(b =>
            b && b.name === call.receiverRoot && b.kind === 'import');
        if (binding && externalModule(String(binding.module))) {
            const field = call.receiverField ? `.${call.receiverField}` : '';
            return `${call.receiverRoot}${field}.${call.name}`;
        }
    }
    return null;
}

function _structuralModuleBindings(fileEntry, call) {
    if (call?.receiverModuleSpecifier) {
        return [{
            name: call.receiver || '<inline-require>',
            module: call.receiverModuleSpecifier,
        }];
    }
    return (fileEntry?.importBindings || []).filter(b => b.name === call?.receiver);
}

function _pythonBuiltinContractAllowed(index, fileEntry, moduleName) {
    const module = String(moduleName || '');
    if (!module || module.startsWith('.')) return false;
    if (fileEntry.moduleResolved?.[module]) return false;
    const first = module.split('.')[0];
    return !first || !_projectTopLevelNames(index).has(first);
}

function _structuralImportedReceiverType(index, fileEntry, receiver) {
    const bindings = (fileEntry.importBindings || []).filter(binding =>
        binding.name === receiver || binding.alias === receiver);
    const matches = new Map();
    for (const binding of bindings) {
        const rel = fileEntry.moduleResolved?.[binding.module];
        if (!rel) continue;
        const start = path.isAbsolute(rel) ? rel : path.join(index.root, rel);
        for (const definition of (index.symbols.get(receiver) || [])) {
            if (!definition.file || !IDENTITY_TYPE_KINDS.has(definition.type)) continue;
            if (definition.file === start ||
                _nameBindingReaches(
                    index, start, receiver, new Set([definition.file])) === 'yes') {
                matches.set(`${definition.file}:${definition.startLine}`, definition);
            }
        }
    }
    if (matches.size !== 1) return null;
    const definition = [...matches.values()][0];
    return { type: receiver, fromFile: definition.file };
}

function _pythonBuiltinCallReturnType(index, fileEntry, call) {
    if (fileEntry?.language !== 'python') return null;
    const adapter = getLanguageAdapter('python');
    if (typeof adapter?.getBuiltinCallReturnType !== 'function') return null;
    let bindings;
    if (call.receiverIsModule || call.receiverModuleSpecifier) {
        bindings = _structuralModuleBindings(fileEntry, call);
    } else if (!call.isMethod && !call.receiver) {
        bindings = (fileEntry.importBindings || []).filter(binding =>
            binding.name === call.name || binding.alias === call.name);
    } else {
        return null;
    }
    const types = new Set();
    for (const binding of bindings) {
        if (!_pythonBuiltinContractAllowed(index, fileEntry, binding.module)) continue;
        const type = adapter.getBuiltinCallReturnType(binding.module, call.name);
        if (type) types.add(type);
    }
    return types.size === 1 ? [...types][0] : null;
}

function _pythonBuiltinFieldPathType(index, fileEntry, root, fields) {
    if (fileEntry?.language !== 'python' || fields?.length !== 1) return null;
    const adapter = getLanguageAdapter('python');
    if (typeof adapter?.getBuiltinFieldType !== 'function') return null;
    const bindings = (fileEntry.importBindings || []).filter(binding =>
        binding.name === root || binding.alias === root);
    const types = new Set();
    for (const binding of bindings) {
        if (!_pythonBuiltinContractAllowed(index, fileEntry, binding.module)) continue;
        const type = adapter.getBuiltinFieldType(binding.module, fields[0]);
        if (type) types.add(type);
    }
    return types.size === 1 ? [...types][0] : null;
}

function _pythonBuiltinChainedReceiverType(index, fileEntry, call, foldCtx) {
    if (fileEntry?.language !== 'python') return null;
    const producers = _chainedProducerRecords(foldCtx, call);
    if (producers.length === 0) return null;
    const types = producers.map(producer =>
        _pythonBuiltinCallReturnType(index, fileEntry, producer));
    return types.every(Boolean) && new Set(types).size === 1 ? types[0] : null;
}

/**
 * Preserve exact constructor provenance through a project wrapper function.
 * The parser records only direct constructor returns; this query-time step
 * resolves their qualifiers in the producer's module. Every return must be
 * externally owned before the result can become exclusion-grade.
 */
function _structuralReturnedConstructorFlow(index, definition) {
    const constructors = definition?.returnedConstructors;
    if (!Array.isArray(constructors) || constructors.length === 0 ||
        !definition.file) return null;
    const fileEntry = index.files.get(definition.file);
    if (!fileEntry ||
        langTraits(fileEntry.language)?.typeSystem !== 'structural') return null;
    const origins = constructors.map(item =>
        _structuralQualifiedReceiverOrigin(
            index, fileEntry, item.qualifier || item.type, item.type));
    if (!origins.every(origin => origin?.kind === 'external')) return null;
    return {
        externalVia: [...new Set(origins.map(origin => origin.via))].join('|'),
        externalConcrete: true,
    };
}

function _calleeStructuralModuleRoute(index, fileEntry, call, language) {
    const bindings = _structuralModuleBindings(fileEntry, call);
    if (bindings.length === 0) return { unknown: true };
    return _calleeStructuralBindingRoute(index, fileEntry, call, language, bindings, call.name, false);
}

function _calleeStructuralImportedNameRoute(index, fileEntry, call, language) {
    const lookupName = call.resolvedName || call.name;
    let bindings = (fileEntry?.importBindings || []).filter(b => b.name === lookupName);
    if (call.resolvedName && bindings.some(b => b.alias)) {
        const paired = bindings.filter(b => b.alias === call.name);
        if (paired.length > 0) bindings = paired;
    }
    if (bindings.length === 0) return null;
    return _calleeStructuralBindingRoute(index, fileEntry, call, language, bindings, lookupName, true);
}

function _calleeStructuralBindingRoute(index, fileEntry, call, language, bindings, exportName, allowDefaultExport) {
    const matches = new Map();
    let sawProjectish = false;
    let sawUnknown = false;
    for (const binding of bindings) {
        const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[binding.module];
        if (!rel) {
            const mod = String(binding.module || '');
            const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
            if (mod.startsWith('.') ||
                (firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                sawProjectish = true;
                sawUnknown = true;
            }
            continue;
        }
        sawProjectish = true;
        const moduleFile = path.join(index.root, rel);
        const routed = _calleeExportDefinitions(index, moduleFile, exportName, language, call, {
            allowDefaultExport: allowDefaultExport && !!binding.defaultLike,
        });
        for (const d of routed.matches) {
            matches.set(`${d.file}:${d.startLine}`, d);
        }
        if (routed.unknown) sawUnknown = true;
    }
    if (matches.size > 0) return { matches: [...matches.values()] };
    if (!sawProjectish && !sawUnknown) return { external: true };
    return { unknown: true };
}

// Resolve a module attribute to its implementation definition while
// preserving identity across ESM/TS barrel renames and Python re-export
// imports. Searching only symbols named with the public spelling loses
// `export { _gt as gt }`, because its implementation is named `_gt`.
function _calleeExportDefinitions(index, startAbs, exposedName, language, call, options = {}) {
    const matches = new Map();
    const visited = new Set();
    let unknown = false;
    let frontier = [[startAbs, exposedName]];
    const shapeMatches = d =>
        (!NON_CALLABLE_TYPES.has(d.type) ||
            (call.isConstructor && d.type === 'class') ||
            (langTraits(language)?.classesCallableWithoutNew && d.type === 'class')) &&
        _calleeLanguageCompatible(index, d, language);

    for (let depth = 0; depth <= 4 && frontier.length > 0; depth++) {
        const next = [];
        for (const [abs, attr] of frontier) {
            const stateKey = `${abs}\x00${attr}`;
            if (visited.has(stateKey)) continue;
            visited.add(stateKey);
            const fe = index.files.get(abs);
            if (!fe) { unknown = true; continue; }

            const enqueue = (module, nextAttr) => {
                const rel = fe.moduleResolved && fe.moduleResolved[module];
                if (!rel) {
                    const mod = String(module || '');
                    const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                    if (mod.startsWith('.') ||
                        (firstSeg && _projectTopLevelNames(index).has(firstSeg))) unknown = true;
                    return;
                }
                next.push([path.join(index.root, rel), nextAttr]);
            };

            const details = fe.exportDetails || [];
            const localDetails = details.filter(e =>
                !e.source && (e.alias || e.name) === attr);
            const ambiguousCjsMember = localDetails.some(e =>
                (e.type === 'module.exports' || e.type === 'exports') &&
                !e.defaultLike && !e.localName);
            const localExposed = fe.language === 'python' ||
                (fe.exports || []).includes(attr) || localDetails.length > 0;
            if (ambiguousCjsMember) {
                // `module.exports = { run: condition ? native : fallback }`
                // exposes no single callable identity. The caller direction
                // routes this visible; trace-down must make the same abstention
                // instead of selecting a same-named local fallback.
                unknown = true;
            } else if (localExposed) {
                const localNames = new Set([attr]);
                for (const detail of localDetails) {
                    if (detail.localName) localNames.add(detail.localName);
                }
                for (const localName of localNames) {
                    for (const d of (index.symbols.get(localName) || [])) {
                        if (d.file === abs && shapeMatches(d)) {
                            matches.set(`${d.file}:${d.startLine}`, d);
                        }
                    }
                }
            }

            // A simple CommonJS require binds the value assigned directly to
            // module.exports. This applies to a bare imported-name call only,
            // never to namespace.member() routing.
            if (options.allowDefaultExport && depth === 0) {
                for (const e of details) {
                    if (e.type !== 'module.exports' || !e.defaultLike || !e.name) continue;
                    const localName = e.localName || e.name;
                    for (const d of (index.symbols.get(localName) || [])) {
                        if (d.file === abs && shapeMatches(d)) {
                            matches.set(`${d.file}:${d.startLine}`, d);
                        }
                    }
                }
            }

            for (const e of details) {
                if (!e.source) continue;
                if (e.type === 're-export' && (e.alias || e.name) === attr) enqueue(e.source, e.name);
                else if (e.type === 're-export-all') {
                    if (e.alias) { if (e.alias === attr) unknown = true; }
                    else enqueue(e.source, attr);
                }
            }
            const aliases = fe.importAliases || [];
            for (const b of (fe.importBindings || [])) {
                const exposed = [b.alias || b.name,
                    ...aliases.filter(a => a.original === b.name).map(a => a.local)];
                if (exposed.includes(attr)) enqueue(b.module, b.name);
            }
            if ((fe.importNames || []).includes('*')) unknown = true;
            if ((fe.moduleAssignedNames || []).includes(attr)) unknown = true;
            if ((index.symbols.get('__getattr__') || []).some(s => s.file === abs && !s.className)) unknown = true;
        }
        frontier = next;
    }
    if (frontier.length > 0) unknown = true;
    return { matches: [...matches.values()], unknown };
}

function _calleeGoPackageMatch(index, call, importModule) {
    const allSymbols = index.symbols.get(call.name);
    if (!allSymbols) return null;
    // Package-qualified composite literals (`clients.Locality{}`) name a
    // TYPE, never a same-named struct field. Ordinary package calls name
    // callable symbols. Shape-filter before package ranking so the first
    // declaration in the right directory cannot steal another namespace.
    const symbols = allSymbols.filter(s => call.isConstructor
        ? ['struct', 'class', 'type'].includes(s.type)
        : !NON_CALLABLE_TYPES.has(s.type));
    if (symbols.length === 0) return null;
    // Self-module imports (fix #268, cobra-measured — the #220(8) go.mod
    // identity): `import "github.com/spf13/cobra"` from doc/ names the
    // module's ROOT package, whose relative dir is '.' and can never
    // path-suffix-match the import string. Compose the effective package
    // dir from the module line (nested subpackage paths compose too).
    const goMod = findGoModule(index.root);
    if (goMod && goMod.modulePath &&
        (importModule === goMod.modulePath || importModule.startsWith(goMod.modulePath + '/'))) {
        const sub = importModule === goMod.modulePath ? '.' :
            importModule.slice(goMod.modulePath.length + 1);
        const selfMatch = symbols.find(s => {
            const sDir = path.dirname(s.relativePath || path.relative(index.root, s.file));
            return sDir === sub;
        });
        if (selfMatch) return selfMatch;
    }
    const importParts = importModule.split('/');
    let bestMatch = null;
    let bestMatchLen = 0;
    for (const s of symbols) {
        const sDir = path.dirname(s.relativePath || path.relative(index.root, s.file));
        for (let i = 0; i < importParts.length; i++) {
            const suffix = importParts.slice(i).join('/');
            if (sDir === suffix || sDir.endsWith('/' + suffix)) {
                const matchLen = importParts.length - i;
                if (matchLen > bestMatchLen) {
                    bestMatchLen = matchLen;
                    bestMatch = s;
                }
                break; // this symbol's best suffix found, try next
            }
        }
    }
    return bestMatch;
}

function _calleeOverloadSelect(index, call, matches, language) {
    if (matches.length === 0) return { match: null };
    if (call.argCount == null || call.argSpread) {
        return matches.length === 1 ? { match: matches[0] } : { ambiguous: true };
    }
    const fits = matches.filter(d => _callArityCompatible(call, [d], language));
    if (fits.length === 0) return { match: null }; // fits nothing we model — no claim
    let applicable = language === 'java' || language === 'csharp' ||
        language === 'cpp'
        ? fits.filter(d => _overloadApplicable(index, call, d))
        : fits;
    if (applicable.length === 0) return { match: null };
    // Java overload resolution considers fixed-arity applicability before
    // variable-arity invocation. An inherited fixed method therefore wins
    // over a subclass varargs overload when the call omits the vararg array.
    if (language === 'java' || language === 'csharp') {
        applicable = _preferFixedArityOverloads(
            index, call, applicable, language);
        if (applicable.length > 1) {
            const mostSpecific = _javaMostSpecificOverload(
                index, applicable, call, language);
            if (mostSpecific) return { match: mostSpecific };
        }
    }
    if (applicable.length === 1) return { match: applicable[0] };
    return { ambiguous: true };
}

/**
 * Build the callable member group seen through a statically-known receiver.
 *
 * Java and C# member lookup keep inherited overloads in the group. In both
 * languages the nearest declaration of an identical signature wins, while a
 * differently-shaped base overload remains a candidate.
 *
 * The old callee path selected the first applicable declaration on the
 * receiver type and consulted ancestors only when *nothing* applied. That
 * made `DerivedWriter.WriteValue(object?)` steal a compiler-selected
 * inherited `BaseWriter.WriteValue(Guid?)`.
 */
function _calleeReceiverMethodGroup(index, symbols, typeName, language, contextFile,
    accepts = () => true) {
    if (!typeName) return [];
    const family = [];
    const seenTypes = new Set();
    const seenSignatures = new Set();
    let frontier = [typeName];
    let hops = 0;
    while (frontier.length > 0 && hops++ < 32) {
        const next = [];
        for (const owner of frontier) {
            if (!owner || seenTypes.has(owner)) continue;
            seenTypes.add(owner);
            const declared = (symbols || []).filter(symbol =>
                accepts(symbol) &&
                // Explicit C# interface implementations are absent from the
                // class's ordinary lookup surface. Interface-typed calls are
                // runtime dispatch questions; caller analysis handles the
                // exact `((IFace)this).M()` special case separately.
                !(language === 'csharp' && symbol.explicitInterface) &&
                (symbol.className === owner ||
                 (symbol.receiver && symbol.receiver.replace(/^\*/, '') === owner)));
            for (const definition of declared) {
                const signature = Array.isArray(definition.paramsStructured)
                    ? definition.paramsStructured
                        .filter(param => !param?.extensionReceiver)
                        .map(param => {
                            const type = _overloadTypeIdentity(param?.type || '');
                            return `${type}:${param?.rest ? 'rest' : 'fixed'}`;
                        })
                        .join(',')
                    : `${definition.file}:${definition.startLine}`;
                if (seenSignatures.has(signature)) continue;
                seenSignatures.add(signature);
                family.push(definition);
            }

            const resolvedFile = index._resolveClassFile?.(owner, contextFile) ||
                contextFile;
            const parents = index._getInheritanceParents?.(owner, resolvedFile);
            if (parents) next.push(...parents);
        }
        frontier = next;
    }
    return family;
}

function _calleeSelectReceiverMethod(index, call, symbols, typeName, language,
    contextFile, accepts = () => true) {
    if (language === 'java' || language === 'csharp') {
        return _calleeOverloadSelect(
            index,
            call,
            _calleeReceiverMethodGroup(
                index, symbols, typeName, language, contextFile, accepts),
            language);
    }
    const onOwner = owner => (symbols || []).filter(symbol =>
        accepts(symbol) &&
        (symbol.className === owner ||
         (symbol.receiver && symbol.receiver.replace(/^\*/, '') === owner)));
    let selected = _calleeOverloadSelect(
        index, call, onOwner(typeName), language);
    if (!selected.match && !selected.ambiguous &&
        langTraits(language)?.typeSystem === 'nominal') {
        const visited = new Set([typeName]);
        const queue = [...(index._getInheritanceParents?.(
            typeName, contextFile) || [])];
        while (queue.length > 0 && !selected.match && !selected.ambiguous) {
            const owner = queue.shift();
            if (!owner || visited.has(owner)) continue;
            visited.add(owner);
            selected = _calleeOverloadSelect(
                index, call, onOwner(owner), language);
            if (!selected.match && !selected.ambiguous) {
                const resolvedFile =
                    index._resolveClassFile?.(owner, contextFile) || contextFile;
                queue.push(...(index._getInheritanceParents?.(
                    owner, resolvedFile) || []));
            }
        }
    }
    return selected;
}

function _preferFixedArityOverloads(index, call, applicable, language) {
    const fixed = applicable.filter(definition =>
        !Array.isArray(definition.paramsStructured) ||
        !definition.paramsStructured.some(param => param?.rest) ||
        (language === 'csharp' &&
         _csharpParamsNormalFormApplicable(index, call, definition)));
    return fixed.length > 0 ? fixed : applicable;
}

// C# `params T[]` methods participate in the normal fixed-arity phase when
// the final argument is already a T[] value. Use only an exact static array
// identity here; an unknown expression remains in the expanded phase. This
// distinguishes FormatWith(object) from FormatWith(params object[]) for
// `new object[] { ... }`.
function _csharpParamsNormalFormApplicable(index, call, definition) {
    let ps = definition.paramsStructured;
    if (!Array.isArray(ps) || !ps.some(param => param?.rest) ||
        !Array.isArray(call.argKinds)) {
        return false;
    }
    if (definition.isExtensionMethod && call.isMethod &&
        call.receiver !== definition.className) {
        ps = ps.slice(1);
    }
    if (call.argCount !== ps.length || ps.length === 0) return false;
    const restIndex = ps.findIndex(param => param?.rest);
    if (restIndex !== ps.length - 1) return false;
    const actual = _javaStaticTypeForKind(index, call.argKinds[restIndex]);
    const expected = _overloadTypeIdentity(ps[restIndex]?.type);
    return !!actual && !!expected && actual === expected;
}

function _declaredFieldType(index, rootType, fieldName, language, info, rootNamespace) {
    const defs = index.symbols.get(fieldName) || [];
    if (defs.length === 0 && language !== 'python') return null;
    // 'private field' (JS #-fields, fix #219): equally compiler-true, and
    // safer — nothing outside the class can rebind them. Getters and Python
    // @property members (fix #265, hono-measured: Context.req is `get req():
    // HonoRequest`) type the hop through their declared RETURN annotation —
    // the same compiler-checked evidence in accessor clothing; the annotation
    // is what the member-access expression evaluates to (value position).
    const isAccessor = (d) => d.type === 'get' || d.memberType === 'get' ||
        d.type === 'property' || d.memberType === 'property';
    const fields = defs.filter(d =>
        ((d.type === 'field' || d.memberType === 'field' || d.memberType === 'private field') && d.fieldType) ||
        (isAccessor(d) && d.returnType));
    let onType = fields.filter(d => d.className === rootType &&
        (language !== 'csharp' || !rootNamespace ||
            (d.namespace || null) === rootNamespace));
    // Fields and accessors are inherited. Resolve the nearest declaring
    // ancestor level; sibling bases at the same level must later normalize
    // to one type or the existing agreement guard rejects the hop.
    if (onType.length === 0) {
        let level = [rootType];
        const seen = new Set(level);
        while (level.length > 0 && seen.size < 64) {
            const parents = [...new Set(level.flatMap(owner =>
                index._getInheritanceParents?.(owner) || []))]
                .filter(owner => owner && !seen.has(owner));
            for (const owner of parents) seen.add(owner);
            if (parents.length === 0) break;
            onType = fields.filter(d => parents.includes(d.className) &&
                (language !== 'csharp' || !rootNamespace ||
                    (d.namespace || null) === rootNamespace));
            if (onType.length > 0) break;
            level = parents;
        }
    }
    // Python normally declares instance fields through `self.x = value` in
    // __init__ rather than class-level field syntax. The parser's cached
    // instance-attribute analysis derives exact types from annotations,
    // constructor assignments, and parameter-to-field assignments. Promote
    // those contracts into the same field-hop rail, but only when every
    // project class declaration with this name supplies the field and agrees
    // on its type—same-name classes in different modules must not conflate.
    if (onType.length === 0 && language === 'python') {
        const owners = (index.symbols.get(rootType) || [])
            .filter(d => ['class', 'type'].includes(d.type) && d.file);
        if (owners.length > 0) {
            const inferred = [];
            let complete = true;
            for (const owner of owners) {
                const attrs = getInstanceAttributeTypes(index, owner.file, rootType);
                const fieldType = attrs?.get(fieldName);
                if (!fieldType) {
                    complete = false;
                    break;
                }
                inferred.push({
                    type: 'field',
                    memberType: 'field',
                    className: rootType,
                    fieldType,
                    file: owner.file,
                });
            }
            if (complete && inferred.length > 0) {
                onType = inferred;
            }
        }
    }
    if (onType.length === 0) return null;
    const normalized = new Set();
    for (const f of onType) {
        const rawText = isAccessor(f) ? f.returnType : f.fieldType;
        // Qualified declared types resolve through the FIELD-DECLARING file's
        // imports or not at all (fix #268, chi-measured — the #206 identity
        // discipline): `inner http.Handler` is net/http's Handler, never a
        // project class that happens to share the bare name (an _examples
        // type named Handler confirmed mx.handler.ServeHTTP). Go only —
        // its pkg.Type field shape carries a checkable qualifier; Rust/Java
        // qualified heads keep their current physics (no measured family).
        if (language === 'go' && f.file) {
            const qm = String(rawText).trim().replace(/^\*+/, '')
                .match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
            if (qm) {
                const [, qualifier, bare] = qm;
                const hasProjectType = (index.symbols.get(bare) || [])
                    .some(d => IDENTITY_TYPE_KINDS.has(d.type));
                const origin = hasProjectType &&
                    _resolveFlowTypeOrigin(index, f.file, bare, qualifier);
                if (origin && origin.fromFile) { normalized.add(bare); continue; }
                // The qualifier names an import that resolves to no project
                // type — the field's type is provably external. Surfaced via
                // `info` so the callee side can route external/visible; the
                // head stays null (never bare-name identity, demote-only).
                if (info && _goQualifierNamesImport(index, f.file, qualifier)) {
                    info.externalVia = `${qualifier}.${bare}`;
                    const adapter = getLanguageAdapter('go');
                    if (adapter?.isPlatformConcreteType?.(qualifier, bare)) {
                        info.externalConcrete = true;
                    }
                }
                return null;
            }
        }
        const t = _normalizeFieldTypeName(rawText, language);
        if (t) normalized.add(t);
        else return null; // any un-normalizable declaration → no evidence
    }
    if (normalized.size !== 1) return null; // same-named classes disagree
    let typeName = [...normalized][0];
    // Pure-alias heads resolve to their base (fix #265 — the #208 identity
    // for declared types): `store: StoreMap` where `type StoreMap = Map<...>`
    // types the field as Map, which the trust gate can judge (builtin →
    // exclusion-grade; a project-class base validates normally). Mixed or
    // disagreeing alias names stay as-is and fail the trust gate downstream.
    const aliasBase = _pureAliasBase(index, typeName);
    if (aliasBase) typeName = aliasBase;
    if (info) {
        const origins = new Set();
        const namespaces = new Set();
        let complete = true;
        for (const field of onType) {
            if (!field.file) {
                complete = false;
                break;
            }
            const rawText = isAccessor(field) ? field.returnType : field.fieldType;
            const qualifier = language === 'java'
                ? _javaNestedTypeQualifier(rawText) : undefined;
            if (qualifier) namespaces.add(qualifier);
            const origin = _resolveFlowTypeOrigin(
                index, field.file, typeName, qualifier);
            if (!origin?.fromFile) {
                complete = false;
                break;
            }
            origins.add(origin.fromFile);
        }
        if (complete && origins.size === 1) {
            info.fromFile = [...origins][0];
        }
        if (language === 'java' && namespaces.size === 1) {
            // Preserve nested-type identity (`Code.Builder`) independently
            // from the root object's lexical owner (`Envelope.Builder`).
            // Reusing receiverRootNamespace here attributes the field to the
            // wrong same-named nested class.
            info.namespace = [...namespaces][0];
        }
    }
    // Generic type parameters by convention (T, K, V1 — fix #220,
    // cursive-measured): `view: T` declares the field as WHATEVER the
    // instantiation chose — not a type identity. Without this, the hop
    // "validated" against Rust blanket impls (`impl<T: ViewWrapper> View
    // for T` records className 'T'), confirming self.view.layout() for
    // every wrapper view. A short-caps name with a real project type def
    // (class A in a fixture) is a class, not a generic param.
    if (/^[A-Z][A-Z0-9]?$/.test(typeName) &&
        !(index.symbols.get(typeName) || []).some(d => IDENTITY_TYPE_KINDS.has(d.type))) return null;
    const typeDefs = index.symbols.get(typeName);
    if (typeDefs && typeDefs.some(d => d.type === 'trait' || d.type === 'interface')) return null;
    return typeName;
}

function _declaredFieldPathType(
    index, rootType, fieldNames, language, info, rootNamespace
) {
    let currentType = rootType;
    for (let i = 0; i < fieldNames.length; i++) {
        currentType = _declaredFieldType(
            index, currentType, fieldNames[i], language, info,
            i === 0 ? rootNamespace : undefined);
        if (!currentType) return null;
    }
    return currentType;
}

const _PY_ITERABLE_HEADS = new Set([
    'list', 'List', 'tuple', 'Tuple', 'set', 'Set',
    'Iterable', 'Iterator', 'Sequence', 'Collection', 'Generator',
]);

function _pythonIterableAnnotationItems(text) {
    if (!text) return null;
    const source = String(text).trim().replace(/^["']|["']$/g, '');
    const match = source.match(
        /^(?:typing\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\[(.*)\]$/s);
    if (!match || !_PY_ITERABLE_HEADS.has(match[1])) return null;
    const outerArgs = _splitTopLevelGenericArgs(match[2]);
    if (outerArgs.length === 0) return null;
    const item = outerArgs[0].trim();
    const tuple = item.match(
        /^(?:typing\.)?(?:tuple|Tuple)\s*\[(.*)\]$/s);
    const parts = tuple ? _splitTopLevelGenericArgs(tuple[1]) : [item];
    const types = parts.map(part => _structuralTypeHead(part, {
        language: 'python',
    }));
    if (types.some(type => !type || _STRUCTURAL_FLOW_REJECT.has(type))) return null;
    return types;
}

function _pythonContextValueType(text) {
    if (!text) return null;
    const source = String(text).trim().replace(/^["']|["']$/g, '');
    const match = source.match(
        /^(?:typing\.)?(?:Iterator|Generator|ContextManager|AsyncIterator|AsyncGenerator|AsyncContextManager)\s*\[(.*)\]$/s);
    if (!match) return null;
    const first = _splitTopLevelGenericArgs(match[1])[0];
    const type = first && _structuralTypeHead(first, { language: 'python' });
    return type && !_STRUCTURAL_FLOW_REJECT.has(type) ? type : null;
}

function _nearestPythonFieldDefinitions(index, rootType, fieldName) {
    const candidates = (index.symbols.get(fieldName) || []).filter(definition => {
        const accessor = definition.type === 'property' ||
            definition.memberType === 'property' ||
            definition.type === 'get' || definition.memberType === 'get';
        return definition.className && (accessor ||
            definition.type === 'field' || definition.memberType === 'field');
    });
    let level = [rootType];
    const seen = new Set();
    while (level.length > 0 && seen.size < 64) {
        level = level.filter(owner => owner && !seen.has(owner));
        if (level.length === 0) break;
        for (const owner of level) seen.add(owner);
        const found = candidates.filter(definition =>
            level.includes(definition.className));
        if (found.length > 0) return found;
        level = [...new Set(level.flatMap(owner =>
            index._getInheritanceParents?.(owner) || []))];
    }
    return [];
}

function _pythonDeclaredIterablePathItems(index, rootType, fieldNames) {
    let owner = rootType;
    for (let i = 0; i < fieldNames.length; i++) {
        const field = fieldNames[i];
        if (i < fieldNames.length - 1) {
            owner = _declaredFieldType(index, owner, field, 'python');
            if (!owner) return null;
            continue;
        }
        const declarations = _nearestPythonFieldDefinitions(index, owner, field);
        if (declarations.length === 0) return null;
        const itemSets = declarations.map(definition => _pythonIterableAnnotationItems(
            (definition.type === 'property' || definition.memberType === 'property' ||
             definition.type === 'get' || definition.memberType === 'get')
                ? definition.returnType : definition.fieldType));
        if (itemSets.some(items => !items)) return null;
        const signatures = new Set(itemSets.map(items => items.join('\0')));
        return signatures.size === 1 ? itemSets[0] : null;
    }
    return null;
}

/**
 * Is a member reference `<recv>.name` on a KNOWN receiver type provably a
 * non-callable FIELD — never an edge to any project callable? (fix #231:
 * `delete(cs.cache, key)` captures cs.cache as a potential method-value
 * callee, but `cache` is CacheService's own map-typed field.) The member
 * access resolves to the MEMBER — a same-named function elsewhere in the
 * project is unreachable through this receiver (Go field names shadow
 * promoted methods; Java field/method namespaces are separate but a
 * paren-less member access is always the field). Only certainty excludes:
 * every same-type member of the name must be a field whose declared type is
 * present, not a function type (Go `func(...)`, Rust fn/Fn*, structural
 * arrow/Callable/Function — the #219 callable-owner shapes), and — for
 * structural languages — trusted for exclusion (#198: builtin or project
 * class; `any`/alias/interface heads prove nothing, and an untyped JS field
 * could hold a same-named function via `this.cb = cb`, the #218c
 * member-alias family).
 */
function _nonCallableFieldMember(index, typeName, name, language) {
    const defs = index.symbols.get(name);
    if (!defs || defs.length === 0) return false;
    const onType = defs.filter(d => d.className === typeName ||
        (d.receiver && d.receiver.replace(/^\*/, '') === typeName));
    if (onType.length === 0) return false;
    for (const d of onType) {
        if (d.type !== 'field' && d.memberType !== 'field' && d.memberType !== 'private field') return false;
        if (!d.fieldType) return false;
        if (_callableFieldDef(index, d)) return false;
        const raw = String(d.fieldType).trim();
        if (/^func\b/.test(raw)) return false;
        if (/\bfn\s*\(|\b(?:Fn|FnMut|FnOnce)\s*[(<]/.test(raw)) return false;
        if (langTraits(language)?.typeSystem === 'structural') {
            const head = _normalizeFieldTypeName(raw, language);
            if (!head || _STRUCTURAL_FLOW_REJECT.has(head) ||
                !_receiverTypeTrustedForExclusion(index, head)) return false;
        }
    }
    return true;
}

/**
 * Callee-side type-qualified receiver resolution (fix #236 — the caller
 * side's #206/#208/#220/#222 identity discipline brought to findCallees).
 * A receiver that NAMES a type owns the call: `Foo::new()` is Foo's new and
 * nothing else's, `String::new()` can never be a project method, `Kit.make()`
 * through an imported class binding is Kit's make. Returns:
 *   { match, typeName }    — confirm this definition
 *   { external: true }     — type-qualified call on a builtin/external type
 *   { unverified: reason } — visible, never confirmed through a name binding
 *   null                   — receiver is not provably a type; no opinion
 * Shape gates follow typeQualifiedCallStyle (#206): Rust requires the path
 * form (a dot-call receiver matching a type name is a variable); Go method
 * expressions pass the receiver instance as the first argument, so zero-arg
 * calls on type-named receivers are variables. `use X as Y` aliases are
 * judged by the original name (#222b); pure type-alias sets close over their
 * base (#208). Structural class receivers additionally need scope evidence
 * (#215): the class defined in this file or a file binding of the name —
 * an unbound capitalized receiver may be a parameter or local.
 */
/**
 * Namespace/module-container resolution (fix #254, W8 BUG-4 — verify's
 * BUG-BX rule brought into the engine, range-based): `Utils.slug()` where a
 * `namespace Utils` block CONTAINS a definition of `slug` is a qualified
 * FUNCTION call, not a method call — containment is identity evidence, not
 * a naming heuristic. Requires #215 scope evidence tying the receiver to
 * the containing file: the call site sits in that file, or an import
 * binding of the receiver name resolves toward it (_importReaches — barrel
 * chains). Structural languages only; Rust `mod` paths keep the path
 * machinery.
 * @param {object} index - ProjectIndex instance
 * @param {object} fileEntry - The CALL SITE's file entry
 * @param {string} callFileAbs - The call site's absolute file path
 * @param {string} receiverName - The call's receiver text
 * @param {string} calleeName - The called name
 * @param {Array|null} restrictDefs - Candidate defs to test containment on
 *        (the pinned targets on the caller side); null = all callable defs
 * @returns {object|null} The contained definition, or null
 */
function _namespaceContainedDef(index, fileEntry, callFileAbs, receiverName, calleeName, restrictDefs) {
    if (!receiverName || receiverName.includes('.') || receiverName.includes('::')) return null;
    const nsDefs = (index.symbols.get(receiverName) || []).filter(s =>
        s.type === 'namespace' || s.type === 'module');
    if (nsDefs.length === 0) return null;
    const candidates = restrictDefs ||
        (index.symbols.get(calleeName) || []).filter(s => !NON_CALLABLE_TYPES.has(s.type));
    const contained = candidates.filter(d => nsDefs.some(ns =>
        ns.file === d.file && ns.startLine <= d.startLine &&
        (ns.endLine ?? Infinity) >= (d.endLine ?? d.startLine)));
    if (contained.length === 0) return null;
    const targetAbs = new Set(contained.map(d => d.file));
    if (targetAbs.has(callFileAbs)) return contained[0];
    for (const im of (fileEntry?.importBindings || [])) {
        if (im.name !== receiverName) continue;
        const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[String(im.module || '')];
        if (!rel) continue;
        const abs = path.join(index.root, rel);
        if (targetAbs.has(abs) || _importReaches(index, abs, targetAbs)) {
            return contained.find(d => d.file === abs) || contained[0];
        }
    }
    return null;
}

function _calleeTypeQualifiedReceiver(index, def, fileEntry, call, language) {
    let receiver = call.receiver;
    if (!receiver) return null;
    const traits = langTraits(language);
    const style = traits?.typeQualifiedCallStyle;
    if (style === 'path' && !call.isPathCall) return null;
    if (style === 'method-expr' && call.argCount != null && call.argCount < 1) return null;

    // Namespace/module container (fix #254): checked before the
    // capitalization gate — namespaces resolve by symbol lookup, not case
    // convention. A hit is a qualified function call, exempt from the
    // method filter downstream.
    if (traits?.typeSystem === 'structural') {
        const nsDef = _namespaceContainedDef(index, fileEntry, def.file, receiver, call.name, null);
        if (nsDef) return { match: nsDef, typeName: receiver };
    }

    const typeKindsOf = (name) => (index.symbols.get(name) || [])
        .filter(d => IDENTITY_TYPE_KINDS.has(d.type) || (d.type === 'type' && d.aliasOf));
    const structuralTypeInScope = (name, defs) => {
        if (defs.some(d => d.file === def.file)) return true;
        if ((fileEntry?.bindings || []).some(b => b.name === name)) return true;
        for (const im of (fileEntry?.importBindings || [])) {
            if (im.name !== name) continue;
            const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[String(im.module || '')];
            if (!rel) continue;
            const abs = path.join(index.root, rel);
            if (defs.some(d => d.file === abs)) return true;
        }
        return false;
    };

    // Multi-segment path receivers (std::sync::Arc::new): the LAST segment
    // is the type; the qualifier owns it (#206). A crate-internal qualifier
    // (crate/self/super) resolves by name below; std/core/alloc paths are
    // provably external even when a project type shares the name; any other
    // qualified name is unpinnable without a module resolver — visible when
    // a project type shares the name, external when none does.
    if (style === 'path' && receiver.includes('::')) {
        const segs = receiver.split('::');
        const lastSeg = segs[segs.length - 1];
        if (!/^[A-Z]/.test(lastSeg)) return null; // module-path function call
        if (['crate', 'self', 'super'].includes(segs[0])) {
            receiver = lastSeg;
        } else if (typeKindsOf(lastSeg).length === 0) {
            return { external: true };
        } else if (['std', 'core', 'alloc'].includes(segs[0])) {
            return { external: true };
        } else {
            return { unverified: 'method-ambiguous' };
        }
    }
    let typeDefs = typeKindsOf(receiver);
    // Python permits lowercase class names. Capitalization is only a naming
    // convention there; an imported/same-scope class binding is stronger AST
    // evidence that `codes.is_informational()` is type-qualified dispatch.
    if (!/^[A-Z]/.test(receiver) &&
        !(traits?.typeSystem === 'structural' && typeDefs.length > 0 &&
            structuralTypeInScope(receiver, typeDefs))) return null;
    if (typeDefs.length === 0) {
        for (const im of (fileEntry?.importBindings || [])) {
            if (im.name !== receiver) continue;
            const orig = String(im.module || '').split('::').pop();
            if (orig && orig !== receiver && typeKindsOf(orig).length > 0) {
                receiver = orig;
                typeDefs = typeKindsOf(orig);
                break;
            }
        }
    }
    if (typeDefs.length === 0) {
        // No project type of this name. Rust path receivers are provably
        // types (modules are lowercase, variables cannot be path-qualified):
        // a generic-param name stays visible — its instantiation could be
        // any project type — everything else (String::new, Arc::new) is
        // external. Java CamelCase receivers are classes (Math.max) —
        // external; ALL_CAPS receivers are constants (variables) and keep
        // normal resolution. Go capitalizes exported package-level VARIABLES
        // too, and a structural capitalized receiver may be a parameter or
        // local — neither acts without a project type def.
        if (style === 'path') {
            if (_isGenericParamReceiverType(index, def.file, call.line, receiver)) {
                return { unverified: 'method-ambiguous' };
            }
            return { external: true };
        }
        if ((language === 'java' || language === 'csharp') &&
            /[a-z]/.test(receiver) &&
            !_isGenericParamReceiverType(index, def.file, call.line, receiver)) {
            return { external: true };
        }
        return null;
    }
    if (traits?.typeSystem === 'structural') {
        if (!structuralTypeInScope(receiver, typeDefs)) return null;
    }
    // Alias closure (#208): a pure alias set agreeing on one base is the
    // SAME type — the method may live on the base's inherent impl.
    const candidateTypes = [receiver];
    if (typeDefs.every(d => d.type === 'type' && d.aliasOf)) {
        const bases = new Set(typeDefs.map(d =>
            _normalizedAliasBase(index, d)));
        if (bases.size === 1) candidateTypes.push(bases.values().next().value);
    }
    const symbols = index.symbols.get(call.name) || [];
    const isCallable = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
    if (language === 'java' || language === 'csharp') {
        // Class-qualified Java/C# calls see the compiler member group on the
        // qualifier. The helper handles inherited slots and C# name hiding.
        const family = candidateTypes.flatMap(typeName =>
            _calleeReceiverMethodGroup(
                index, symbols, typeName, language, def.file,
                symbol => isCallable(symbol) && symbol.type === 'static'));
        const selected = _calleeOverloadSelect(index, call, family, language);
        if (selected.ambiguous) return { unverified: 'overload-ambiguous' };
        if (selected.match) {
            return { match: selected.match, typeName: selected.match.className || receiver };
        }
        // The qualifier still proves ownership when no overload accepts the
        // argument count. Caller-side verify must see this broken call site as
        // a mismatch; callee dependency analysis keeps it unverified.
        if (family.length > 0 && call.argCount != null && !call.argSpread &&
            family.every(d => !_callArityCompatible(call, [d], language))) {
            return {
                unverified: 'arity-mismatch',
                wrongArityOwner: true,
                typeName: receiver,
            };
        }
    }
    const selectOn = (tn) => _calleeOverloadSelect(index, call, symbols.filter(s => isCallable(s) &&
        (s.className === tn || (s.receiver && s.receiver.replace(/^\*/, '') === tn))), language);
    let match = null;
    let matchedType = null;
    for (const tn of candidateTypes) {
        const selected = selectOn(tn);
        if (selected.ambiguous) return { unverified: 'overload-ambiguous' };
        match = selected.match;
        if (match) { matchedType = tn; break; }
    }
    if (!match && traits?.typeSystem === 'nominal') {
        for (const tn of candidateTypes) {
            const parentNames = index._getInheritanceParents?.(tn, def.file);
            if (!parentNames) continue;
            for (const pName of parentNames) {
                const selected = selectOn(pName);
                if (selected.ambiguous) return { unverified: 'overload-ambiguous' };
                match = selected.match;
                if (match) { matchedType = pName; break; }
            }
            if (match) break;
        }
    }
    if (match) return { match, typeName: matchedType };
    // A project type that does not define the method: a trait/interface
    // receiver dispatches across N impls; otherwise the method comes from a
    // derive/trait impl/external contract the index cannot pin. Visible —
    // never confirmed through an unrelated name binding.
    const dispatchy = typeDefs.some(d => d.type === 'trait' || d.type === 'interface');
    return { unverified: dispatchy ? 'method-ambiguous' : 'uncertain-receiver' };
}

/**
 * Single project-wide owner resolution for an untyped-receiver method call
 * (fix #236 — the caller side's #204/#209 rule on the callee side): when
 * every callable definition of the name lives on ONE owner type, `k.run()`
 * can only be that owner's method. Defeaters mirror the caller contract:
 * builtin-global receivers (#232 — name knowledge, not evidence), module
 * receivers (#209/#224 — module attribute lookup, not instance dispatch),
 * a standalone function sharing the name (rebinding can route the call
 * there, #218b), callable fields as second owners (#219), external-contract
 * override markers (#210 — the overridden definition lives OUTSIDE the
 * project), receivers typed by the flow map to something other than the
 * owner (#199/#207/#222(4)), nominal arity mismatch (#205), and a test-file
 * owner for a production caller. Returns the owner's definition or null.
 */
// Languages whose symbols are mutually callable — a JS/TS call site can bind
// a symbol defined in any of these; every other language only binds its own
// (fix #257: java/python/rust fixture defs of CacheService.set counted as ONE
// owner for a JavaScript call — cross-language edges are never callable).
const _JS_CALLABLE_FAMILY = new Set(['javascript', 'typescript', 'tsx', 'html']);
const _NATIVE_CALLABLE_FAMILY = new Set(['c', 'cpp']);

function _calleeLanguageCompatible(index, def, callerLanguage) {
    if (!callerLanguage) return true;
    const defLang = index.files.get(def.file)?.language;
    if (!defLang || defLang === callerLanguage) return true;
    return (_JS_CALLABLE_FAMILY.has(defLang) && _JS_CALLABLE_FAMILY.has(callerLanguage)) ||
        (_NATIVE_CALLABLE_FAMILY.has(defLang) && _NATIVE_CALLABLE_FAMILY.has(callerLanguage));
}

/**
 * Ancestor-name closure of a type via the extends graph (bounded BFS) — a
 * receiver typed Child legitimately reaches methods defined on Base (the
 * #198 ancestor rule, callee direction). Includes the type itself.
 */
function _receiverTypeAncestors(index, typeName, maxHops = 6) {
    const seen = new Set([typeName]);
    let frontier = [typeName];
    for (let hop = 0; hop < maxHops && frontier.length; hop++) {
        const next = [];
        for (const cls of frontier) {
            const parents = index._getInheritanceParents?.(cls) || [];
            for (const p of parents) {
                const pName = typeof p === 'string' ? p : p?.name;
                if (pName && !seen.has(pName)) { seen.add(pName); next.push(pName); }
            }
        }
        frontier = next;
    }
    return seen;
}

/**
 * Route a structural method call by its KNOWN receiver type (fix #257).
 * Returns:
 *   { resolve: def } — exactly one language-compatible project class (the
 *                      type itself or an ancestor) defines the method
 *   { external }     — builtin receiver type with no project match
 *                      (Map.set is host code)
 *   { uncertain }    — known type matching nothing or ambiguously: visible,
 *                      never confirmed by bare-name resolution
 *   null             — receiver type unknown; existing heuristics decide
 */
function _calleeReceiverTypeRoute(index, call, localTypes, language) {
    const raw = call.receiverType || localTypes?.get(call.receiver);
    if (!raw || typeof raw !== 'string') return null;
    const head = _structuralTypeHead(raw, { index, language }) || raw;
    const norm = head;
    const defs = (index.symbols.get(call.name) || []).filter(d =>
        !NON_CALLABLE_TYPES.has(d.type) && d.className &&
        _calleeLanguageCompatible(index, d, language));
    let matches = defs.filter(d => d.className === head || d.className === norm);
    if (matches.length === 0 && defs.length > 0) {
        const ancestors = _receiverTypeAncestors(index, head);
        matches = defs.filter(d => ancestors.has(d.className));
    }
    if (matches.length === 1) return { resolve: matches[0] };
    if (matches.length > 1) return { uncertain: true }; // same-name classes — identity unresolvable (#206)
    if (BUILTIN_RECEIVER_TYPES.has(norm)) return { external: true };
    return { uncertain: true }; // known non-builtin type with no project method
}

/**
 * Zero-candidate call names (fix #261): a call whose name has ZERO
 * definitions anywhere in the index cannot be a project call — there is no
 * def an edge could land on. The confirmed path already gives bare names
 * this exact verdict (the symbol-table check routes them external); method
 * calls were diverted to the unverified band by receiver uncertainty FIRST,
 * so `parts.push(...)` / `names.join(...)` sat as [unverified]
 * uncertain-receiver noise in every trace. Dynamic property assignment does
 * not defeat this: `obj.push = function() {...}` indexes a def named `push`
 * (property-assignment naming, all shapes — probed), so any project that
 * dynamically defines the method keeps its calls visible; a monkey-patched
 * alias of an EXISTING function (`Foo.push = helper`) surfaces its edge at
 * the assignment site as a function reference of `helper` (fix #221/#252),
 * never at the invocation. Checks every name the call could resolve to
 * (parser alias resolution).
 */
function _calleeZeroCandidateName(index, call) {
    const names = [call.name];
    if (call.resolvedName) names.push(call.resolvedName);
    if (call.resolvedNames) names.push(...call.resolvedNames);
    for (const n of names) {
        if (!n) continue;
        const defs = index.symbols.get(n);
        if (defs && defs.length > 0) return false;
    }
    return true;
}

function _calleeSingleOwnerMatch(index, def, fileEntry, call, name, language, flowEntry) {
    if (JS_GLOBAL_RECEIVERS.has(call.receiver)) return null;
    if (call.receiverIsModule) return null;
    if (_universalMethodName(language, name)) return null;
    const traits = langTraits(language);
    if (traits?.typeSystem === 'structural' &&
        _submoduleReceiverModule(index, fileEntry, call.receiver)) return null;
    const defs = index.symbols.get(name) || [];
    const ownerKeys = new Set();
    const ownerDefs = [];
    for (const d of defs) {
        if (!_calleeLanguageCompatible(index, d, language)) continue; // fix #257
        if (NON_CALLABLE_TYPES.has(d.type)) {
            if (d.type === 'field' && d.className && _callableFieldDef(index, d)) {
                ownerKeys.add(d.className);
            }
            continue;
        }
        const o = d.className || (d.receiver && d.receiver.replace(/^\*/, ''));
        if (!o) return null;
        ownerKeys.add(o);
        ownerDefs.push(d);
    }
    if (ownerKeys.size !== 1 || ownerDefs.length === 0) return null;
    if (ownerDefs.length > 1 && traits?.hasArityOverloads) return null;
    if (ownerDefs.some(d => isOverrideMarked(d))) return null;
    if (flowEntry) {
        const owner = ownerKeys.values().next().value;
        if (flowEntry.externalVia || (flowEntry.type && flowEntry.type !== owner)) return null;
    }
    // Parser-typed receiver disagreeing with the owner defeats the match
    // unless the owner is an ancestor of the receiver's type (fix #257 —
    // the flow-map defeater above, extended to #198 parser-typed receivers:
    // a `new Map()` local can never single-owner-confirm a project method).
    if (call.receiverType && typeof call.receiverType === 'string') {
        const owner = ownerKeys.values().next().value;
        const head = _structuralTypeHead(call.receiverType, { index, language }) || call.receiverType;
        const norm = head;
        if (head !== owner && norm !== owner &&
            !_receiverTypeAncestors(index, head).has(owner)) return null;
    }
    if (traits?.typeSystem === 'nominal' && call.argCount != null &&
        !_callArityCompatible(call, ownerDefs, language)) return null;
    const match = ownerDefs[0];
    // The owner's def IS the querying def: an untyped-receiver call cannot
    // prove self-recursion (a true one resolves via self/this/Self) — the
    // receiver is more likely an external value (fix #237).
    if (match.file === def.file && match.startLine === def.startLine) return null;
    const callerFe = index.files.get(def.file);
    const matchFe = index.files.get(match.file);
    if (matchFe && callerFe &&
        (isTestFile(matchFe.relativePath, matchFe.language) || isTestPath(matchFe.relativePath)) &&
        !(isTestFile(callerFe.relativePath, callerFe.language) || isTestPath(callerFe.relativePath))) return null;
    return match;
}

const _CSHARP_TYPE_ALIASES = new Map([
    ['String', 'string'],
    ['System.String', 'string'],
    ['Boolean', 'bool'],
    ['System.Boolean', 'bool'],
    ['Char', 'char'],
    ['System.Char', 'char'],
    ['Object', 'object'],
    ['System.Object', 'object'],
    ['Int32', 'int'],
    ['System.Int32', 'int'],
    ['Int64', 'long'],
    ['System.Int64', 'long'],
]);

// Compiler-known BCL inheritance used by extension-method binding. Keep the
// table at the generic type head: `_csharpTypeIdentity` deliberately strips
// type arguments, while assignability of List<T> to IEnumerable<T> is stable.
const _CSHARP_PLATFORM_BASES = new Map([
    ['List', new Set(['IEnumerable', 'ICollection', 'IList', 'IReadOnlyCollection', 'IReadOnlyList'])],
    ['HashSet', new Set(['IEnumerable', 'ICollection', 'IReadOnlyCollection', 'ISet'])],
    ['Dictionary', new Set(['IEnumerable', 'ICollection', 'IDictionary', 'IReadOnlyCollection', 'IReadOnlyDictionary'])],
    ['Collection', new Set(['IEnumerable', 'ICollection', 'IList', 'IReadOnlyCollection', 'IReadOnlyList'])],
    ['IList', new Set(['IEnumerable', 'ICollection'])],
    ['ICollection', new Set(['IEnumerable'])],
    ['IReadOnlyList', new Set(['IEnumerable', 'IReadOnlyCollection'])],
    ['IReadOnlyCollection', new Set(['IEnumerable'])],
]);

function _csharpTypeAssignable(index, actualType, expectedType) {
    if (!actualType || !expectedType) return false;
    const seen = new Set();
    const queue = [actualType];
    while (queue.length > 0 && seen.size < 128) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (current === expectedType ||
            _CSHARP_PLATFORM_BASES.get(current)?.has(expectedType)) return true;
        for (const parent of index._getInheritanceParents?.(current) || []) {
            const name = typeof parent === 'string' ? parent : parent?.name;
            if (name && !seen.has(name)) queue.push(name);
        }
        // C# class `implements` records are deliberately kept outside the
        // dispatch inheritance graph, but they are compiler-grade
        // assignability evidence for extension receiver parameters.
        for (const definition of index.symbols.get(current) || []) {
            for (const implemented of definition.implements || []) {
                const name = _csharpTypeIdentity(implemented);
                if (name && !seen.has(name)) queue.push(name);
            }
        }
    }
    return false;
}

function _csharpTypeIdentity(raw) {
    if (!raw) return null;
    let value = String(raw).trim()
        .replace(/^global::/, '')
        .replace(/\?$/, '');
    if (value.includes('|') || value.includes('&')) return null;
    value = value.replace(/<.*$/s, '').trim();
    return _CSHARP_TYPE_ALIASES.get(value) || value.split('.').pop() || null;
}

/**
 * Exact C# extension-method evidence for the bound `receiver.Ext(args)` form.
 * The first `this` parameter must match the parser-known receiver type, and
 * the declaring namespace/type must be in lexical scope. Unknown receiver
 * types and global-using gaps abstain.
 */
function _csharpExtensionCallMatches(index, filePath, fileEntry, call, targetDefs) {
    if (!call.receiverType || !Array.isArray(targetDefs) ||
        targetDefs.length === 0) return false;
    const actualType = _csharpTypeIdentity(call.receiverType);
    if (!actualType) return false;
    const enclosing = index.findEnclosingFunction(filePath, call.line, true);
    const callerNamespace = enclosing?.namespace || null;
    const imports = new Set(fileEntry.imports || []);
    return targetDefs.some(def => {
        if (!def.isExtensionMethod || !Array.isArray(def.paramsStructured)) {
            return false;
        }
        const receiver = def.paramsStructured[0];
        const expectedType = receiver?.extensionReceiver
            ? _csharpTypeIdentity(receiver.type) : null;
        const assignable = !!expectedType &&
            _csharpTypeAssignable(index, actualType, expectedType);
        if (!assignable) {
            return false;
        }
        const namespace = def.namespace || null;
        const inScope = def.file === filePath ||
            namespace === callerNamespace ||
            (namespace && imports.has(namespace)) ||
            (namespace && def.className &&
                imports.has(`${namespace}.${def.className}`));
        return !!inScope &&
            _callArityCompatible(call, [def], 'csharp');
    });
}

/**
 * Can this call's argument count fit any target definition's parameter
 * range? (Nominal languages only — their compilers enforce arity, so a
 * mismatch is positive evidence the call binds a different symbol.)
 * Accepts both the bound form (obj.m(a)) and the unbound/UFCS form
 * (Type::m(&obj, a) / Class.m(obj, a)) for method targets. Returns true
 * whenever the signature is unknown, variadic, or the target is not a
 * plain callable — unknown never excludes.
 */
function _callArityCompatible(call, targetDefs, language) {
    if (call?.argCount == null) return true;
    const traits = langTraits(language);
    const selfNames = new Set((traits?.selfParam || [])
        .map(s => String(s).replace(/&|mut\s*/g, '').trim()));
    let sawComparable = false;
    for (const def of targetDefs) {
        if (NON_CALLABLE_TYPES.has(def.type)) return true;
        const ps = def.paramsStructured;
        if (!Array.isArray(ps)) return true;
        const hasExplicitSelf = !!(ps[0] && selfNames.has(
            String(ps[0].name || '').replace(/&|mut\s*/g, '').trim()));
        const boundExtension = !!(def.isExtensionMethod && call.isMethod &&
            call.receiver !== def.className);
        const params = ps.filter((p, i) =>
            !(i === 0 && p && (hasExplicitSelf || boundExtension)));
        const isMethodDef = !!(def.className || def.receiver);
        // The receiver-as-first-arg shift applies only to call shapes that
        // can actually be unbound: Rust UFCS (Type::method(&x)) and Go
        // method expressions (Type.Method(recv)) — the receiver text IS the
        // type. Java has no unbound instance-call form.
        const defType = def.className || (def.receiver || '').replace(/^\*/, '');
        const qualifiedStyle = traits?.typeQualifiedCallStyle;
        const unboundForm =
            (qualifiedStyle === 'path' && hasExplicitSelf && call.isPathCall) ||
            (qualifiedStyle === 'method-expr' &&
                !!call.receiver && call.receiver === defType &&
                !call.receiverType);
        const variadic = params.some(p => p && p.rest);
        const max = variadic ? Infinity :
            params.length + (isMethodDef && unboundForm ? 1 : 0);
        // A variadic tail accepts zero or more EXTRA arguments, but Java/C#
        // still require every fixed prefix parameter. Preserve Go's existing
        // too-many-only discipline below because tuple expansion can fill
        // several parameters from one syntactic argument.
        const min = params.filter(p => p && !p.rest &&
            !p.optional && p.default === undefined).length;
        sawComparable = true;
        if (langTraits(language)?.packageScope === 'directory') {
            // Go: f(g()) tuple expansion can fill several params with one
            // syntactic arg — too-few never excludes, only too-many.
            if (call.argCount <= max) return true;
        } else if (call.argCount >= min && call.argCount <= max) {
            return true;
        }
    }
    return sawComparable ? false : true;
}

const JAVA_PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean']);
const CSHARP_OVERLOAD_ALIASES = new Map([
    ['string', 'String'], ['string?', 'String'],
    ['bool', 'boolean'], ['object', 'Object'], ['object?', 'Object'],
    ['sbyte', 'byte'], ['nint', 'long'],
]);
const CSHARP_CLOSED_TYPES = new Set([
    'String', 'boolean', 'sbyte', 'byte', 'short', 'ushort', 'int', 'uint',
    'long', 'ulong', 'char', 'float', 'double', 'decimal',
    'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Uri', 'BigInteger',
]);
const CSHARP_NUMERIC_WIDENING = new Map([
    ['sbyte', new Set(['short', 'int', 'long', 'float', 'double', 'decimal'])],
    ['byte', new Set(['short', 'ushort', 'int', 'uint', 'long', 'ulong',
        'float', 'double', 'decimal'])],
    ['short', new Set(['int', 'long', 'float', 'double', 'decimal'])],
    ['ushort', new Set(['int', 'uint', 'long', 'ulong', 'float', 'double',
        'decimal'])],
    ['int', new Set(['long', 'float', 'double', 'decimal'])],
    ['uint', new Set(['long', 'ulong', 'float', 'double', 'decimal'])],
    ['long', new Set(['float', 'double', 'decimal'])],
    ['ulong', new Set(['float', 'double', 'decimal'])],
    ['char', new Set(['ushort', 'int', 'uint', 'long', 'ulong', 'float',
        'double', 'decimal'])],
    ['float', new Set(['double'])],
]);
const CSHARP_PLATFORM_MEMBER_TYPES = new Map([
    ['Type.FullName', 'String'],
    ['Type.AssemblyQualifiedName', 'String'],
    ['String.Empty', 'String'],
    ['string.Empty', 'String'],
]);
const JAVA_FINAL_REFERENCE_TYPES = new Set([
    'String', 'Class', 'Boolean', 'Byte', 'Character', 'Short',
    'Integer', 'Long', 'Float', 'Double', 'Void',
]);

// Complete reference-supertype sets for JDK value types (fix #299D): these
// types are final (or effectively closed) with a fixed, fully-known
// ancestry, so an argument statically typed as one of them can bind ONLY a
// parameter type in this list (plus Object/generics, handled earlier). A
// project class shadowing one of these simple names disables the denial —
// the guard is tDefs.length === 0 at the use site. Modern-JDK marker
// interfaces (Constable, ConstantDesc) are included so their params never
// get falsely denied.
const JAVA_PLATFORM_VALUE_ANCESTRY = new Map([
    ['Integer', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Long', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Short', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Byte', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Float', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Double', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Character', ['Comparable', 'Serializable', 'Constable']],
    ['Boolean', ['Comparable', 'Serializable', 'Constable']],
    ['String', ['CharSequence', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['BigInteger', ['Number', 'Comparable', 'Serializable']],
    ['BigDecimal', ['Number', 'Comparable', 'Serializable']],
]);

// Which parameter types a call-site literal kind can bind (Java overload
// resolution: identity, widening, boxing — plus the boxed types' interfaces).
// Anything not provably incompatible MATCHES: only certainty excludes.
const JAVA_KIND_TYPES = {
    string: ['String', 'CharSequence', 'Comparable', 'Serializable'],
    char: ['char', 'Character', 'int', 'long', 'float', 'double', 'Comparable', 'Serializable'],
    int: ['int', 'long', 'float', 'double', 'Integer', 'Number', 'Comparable', 'Serializable'],
    long: ['long', 'float', 'double', 'Long', 'Number', 'Comparable', 'Serializable'],
    float: ['float', 'double', 'Float', 'Number', 'Comparable', 'Serializable'],
    double: ['double', 'Double', 'Number', 'Comparable', 'Serializable'],
    boolean: ['boolean', 'Boolean', 'Comparable', 'Serializable'],
    // Not literal kinds (no short/byte literals in Java) — these entries
    // serve the value-typed conversion checks (fix #299D).
    short: ['short', 'int', 'long', 'float', 'double', 'Short', 'Number', 'Comparable', 'Serializable'],
    byte: ['byte', 'short', 'int', 'long', 'float', 'double', 'Byte', 'Number', 'Comparable', 'Serializable'],
};

// Unboxing is defined for exactly these wrapper types (JLS 5.1.8).
const JAVA_WRAPPER_PRIMITIVES = new Map([
    ['Integer', 'int'], ['Long', 'long'], ['Short', 'short'], ['Byte', 'byte'],
    ['Character', 'char'], ['Boolean', 'boolean'],
    ['Float', 'float'], ['Double', 'double'],
]);

// Declared types of the JDK numeric-constant fields (fix #299D): exact
// compiler contracts, consulted only when no project field shadows the
// owner/field pair.
const JAVA_PLATFORM_FIELD_TYPES = new Map([
    ['Float.NaN', 'float'], ['Float.POSITIVE_INFINITY', 'float'],
    ['Float.NEGATIVE_INFINITY', 'float'], ['Float.MIN_VALUE', 'float'],
    ['Float.MAX_VALUE', 'float'], ['Float.MIN_NORMAL', 'float'],
    ['Double.NaN', 'double'], ['Double.POSITIVE_INFINITY', 'double'],
    ['Double.NEGATIVE_INFINITY', 'double'], ['Double.MIN_VALUE', 'double'],
    ['Double.MAX_VALUE', 'double'], ['Double.MIN_NORMAL', 'double'],
    ['Integer.MAX_VALUE', 'int'], ['Integer.MIN_VALUE', 'int'],
    ['Long.MAX_VALUE', 'long'], ['Long.MIN_VALUE', 'long'],
    ['Short.MAX_VALUE', 'short'], ['Short.MIN_VALUE', 'short'],
    ['Byte.MAX_VALUE', 'byte'], ['Byte.MIN_VALUE', 'byte'],
    ['Character.MAX_VALUE', 'char'], ['Character.MIN_VALUE', 'char'],
    ['Boolean.TRUE', 'Boolean'], ['Boolean.FALSE', 'Boolean'],
]);

// Exact subset of C# implicit conversions for compiler-owned closed types.
// Returns null when user-defined conversions or external ancestry could
// matter. A false verdict is therefore exclusion-grade evidence.
function _csharpKnownTypeAssignable(actualRaw, expectedRaw) {
    const actualText = String(actualRaw || '').trim().replace(/^global::/, '');
    const expectedText = String(expectedRaw || '').trim().replace(/^global::/, '')
        .replace(/\.\.\.$/, '');
    if (!actualText || !expectedText) return null;
    const actualNullable = actualText.endsWith('?');
    const expectedNullable = expectedText.endsWith('?');
    const normalize = value => _overloadTypeIdentity(
        value.replace(/\?/g, ''));
    const actual = normalize(actualText);
    const expected = normalize(expectedText);
    if (!actual || !expected) return null;
    if (expected === 'Object') return true;
    if (actual === expected) {
        return !actualNullable || expectedNullable;
    }
    // `object` is the top of C#'s reference-type lattice. A statically typed
    // object value cannot implicitly downcast to a narrower class/interface;
    // treating that compiler-owned type as unknown made Add(JToken) steal
    // calls whose argument was known to be object.
    if (actual === 'Object') return false;

    const actualArray = actual.endsWith('[]');
    const expectedArray = expected.endsWith('[]');
    if (actualArray || expectedArray) {
        if (actualArray && !expectedArray) return expected === 'Object';
        if (!actualArray) return false;
        const actualElement = actual.slice(0, -2);
        const expectedElement = expected.slice(0, -2);
        if (actualElement === expectedElement) return true;
        // Reference-array covariance is exact for String[] → Object[].
        if (actualElement === 'String' && expectedElement === 'Object') return true;
        if (CSHARP_CLOSED_TYPES.has(actualElement) &&
            CSHARP_CLOSED_TYPES.has(expectedElement)) {
            return false;
        }
        return null;
    }

    if (actualNullable && !expectedNullable) return false;
    const actualKnown = CSHARP_CLOSED_TYPES.has(actual);
    const expectedKnown = CSHARP_CLOSED_TYPES.has(expected);
    if (!actualKnown || !expectedKnown) return null;
    if (CSHARP_NUMERIC_WIDENING.get(actual)?.has(expected)) {
        return !actualNullable || expectedNullable;
    }
    return false;
}

// Small, authoritative platform surface used only when the parser preserved
// the imported owner. These are JDK interface/method declarations, not
// name-based guesses. They close the common portable-AST gap where overload
// resolution depends on the return type of a library call.
const JAVA_PLATFORM_METHOD_RETURNS = new Map([
    // Exact JDK factory contracts (fix #299D): valueOf on the boxed and
    // arbitrary-precision types returns the owner type itself.
    ['java.math.BigInteger#valueOf', 'java.math.BigInteger'],
    ['java.math.BigDecimal#valueOf', 'java.math.BigDecimal'],
    ['java.lang.Integer#valueOf', 'java.lang.Integer'],
    ['java.lang.Long#valueOf', 'java.lang.Long'],
    ['java.lang.Short#valueOf', 'java.lang.Short'],
    ['java.lang.Byte#valueOf', 'java.lang.Byte'],
    ['java.lang.Float#valueOf', 'java.lang.Float'],
    ['java.lang.Double#valueOf', 'java.lang.Double'],
    ['java.lang.Boolean#valueOf', 'java.lang.Boolean'],
    ['java.lang.Character#valueOf', 'java.lang.Character'],
    ['java.lang.String#valueOf', 'java.lang.String'],
    ['java.lang.Object#getClass', 'java.lang.Class'],
    ['java.lang.Class#getEnclosingClass', 'java.lang.Class'],
    ['java.lang.Class#getDeclaringClass', 'java.lang.Class'],
    ['java.lang.Class#getDeclaredMethod', 'java.lang.reflect.Method'],
    ['java.lang.Enum#getDeclaringClass', 'java.lang.Class'],
    ['java.lang.reflect.Method#getReturnType', 'java.lang.Class'],
    ['java.lang.reflect.Method#getGenericReturnType', 'java.lang.reflect.Type'],
    ['java.lang.reflect.Method#getParameterTypes', 'java.lang.Class[]'],
    ['java.lang.reflect.Method#getGenericParameterTypes', 'java.lang.reflect.Type[]'],
    ['javax.lang.model.element.Element#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.TypeElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.TypeParameterElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.VariableElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.ExecutableElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.ExecutableElement#getReturnType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.AnnotationMirror#getElementValues', 'java.util.Map'],
    ['javax.lang.model.element.Element#getAnnotationMirrors', 'java.util.List'],
    ['javax.lang.model.element.TypeElement#getAnnotationMirrors', 'java.util.List'],
    ['javax.lang.model.element.TypeElement#getEnclosedElements', 'java.util.List'],
    ['javax.lang.model.element.ExecutableElement#getParameters', 'java.util.List'],
    ['javax.lang.model.util.ElementFilter#methodsIn', 'java.util.List'],
    ['javax.lang.model.util.Types#getPrimitiveType', 'javax.lang.model.type.PrimitiveType'],
    ['javax.lang.model.util.Types#getArrayType', 'javax.lang.model.type.ArrayType'],
    ['javax.lang.model.util.Types#getDeclaredType', 'javax.lang.model.type.DeclaredType'],
    ['javax.lang.model.util.Types#getWildcardType', 'javax.lang.model.type.WildcardType'],
    ['javax.lang.model.util.Types#getNoType', 'javax.lang.model.type.NoType'],
    ['javax.lang.model.util.Types#getNullType', 'javax.lang.model.type.NullType'],
]);

const JAVA_PLATFORM_SUPERTYPES = new Map([
    ['java.lang.Class', ['java.lang.reflect.Type', 'java.io.Serializable',
        'java.lang.reflect.GenericDeclaration', 'java.lang.reflect.AnnotatedElement']],
    ['javax.lang.model.type.ArrayType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.DeclaredType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.ErrorType', ['javax.lang.model.type.DeclaredType',
        'javax.lang.model.type.ReferenceType', 'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.ExecutableType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.IntersectionType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.NoType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.NullType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.PrimitiveType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.TypeVariable', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.UnionType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.WildcardType', ['javax.lang.model.type.TypeMirror']],
]);

function _javaPlatformAssignable(actualType, expectedSimple) {
    if (!actualType?.includes('.')) return null;
    const actualSimple = actualType.split('.').pop();
    if (actualSimple === expectedSimple) return true;
    const known = JAVA_PLATFORM_SUPERTYPES.get(actualType);
    if (known) return known.some(type => type.split('.').pop() === expectedSimple);
    if (actualType === 'java.lang.Class') {
        return ['Type', 'Serializable', 'GenericDeclaration', 'AnnotatedElement',
            'Object'].includes(expectedSimple);
    }
    // When both sides are in the small modeled platform universe, absence is
    // a proof of incompatibility. Otherwise portable AST remains undecided.
    const modeledExpected = new Set([
        'Type', 'Serializable', 'GenericDeclaration', 'AnnotatedElement',
        'TypeMirror', 'ReferenceType', 'ArrayType', 'DeclaredType', 'ErrorType',
        'ExecutableType', 'IntersectionType', 'NoType', 'NullType',
        'PrimitiveType', 'TypeVariable', 'UnionType', 'WildcardType',
    ]);
    return modeledExpected.has(expectedSimple) ? false : null;
}

function _javaCallReturnType(index, kind) {
    return _javaCallReturnInfo(index, kind)?.type || null;
}

function _javaCallReturnInfo(index, kind) {
    if (kind?.startsWith('chain:')) {
        const parts = kind.slice('chain:'.length).split('#');
        let owner = parts.shift();
        if (!owner || parts.length === 0) return null;
        let ownerFile;
        let info;
        for (const method of parts) {
            info = _javaOwnerMethodReturnInfo(index, owner, method, ownerFile);
            if (!info) return null;
            owner = info.type;
            ownerFile = info.fromFile;
        }
        return info;
    }
    if (kind?.startsWith('callshape:')) {
        const [ownerEncoded, methodEncoded, kindsEncoded = ''] =
            kind.slice('callshape:'.length).split('|');
        const owner = decodeURIComponent(ownerEncoded || '');
        const method = decodeURIComponent(methodEncoded || '');
        if (!owner || !method) return null;
        const ownerSimple = owner.replace(/\?$/, '')
            .replace(/<.*$/s, '').split('.').pop();
        const definitions = (index.symbols.get(method) || []).filter(definition =>
            definition.className === ownerSimple && definition.returnType);
        if (definitions.length === 0) {
            return _javaOwnerMethodReturnInfo(index, owner, method);
        }
        const argKinds = kindsEncoded
            ? kindsEncoded.split(',').map(value => decodeURIComponent(value))
            : [];
        const language = definitions[0]?.file
            ? index.files.get(definitions[0].file)?.language : null;
        const selected = _calleeOverloadSelect(index, {
            argCount: argKinds.length,
            argKinds,
        }, definitions, language);
        return selected.match
            ? _javaDefinitionReturnInfo(index, selected.match)
            : null;
    }
    if (!kind?.startsWith('call:')) return null;
    const parts = kind.split(':');
    const owner = parts[1];
    const method = parts.slice(2).join(':');
    return _javaOwnerMethodReturnInfo(index, owner, method);
}

function _javaDefinitionReturnInfo(index, definition) {
    if (!definition?.returnType) return null;
    let type = String(definition.returnType).replace(/<.*$/s, '').trim();
    const suffix = type.endsWith('[]') ? '[]' : '';
    if (suffix) type = type.slice(0, -2);
    if (!type.includes('.')) {
        const imports = (index.files.get(definition.file)?.importBindings || [])
            .filter(binding => binding.name === type)
            .map(binding => binding.module)
            .filter(Boolean);
        if (imports.length === 1) type = imports[0];
    }
    return type
        ? { type: `${type}${suffix}`, ...(definition.file && {
            fromFile: definition.file,
        }) }
        : null;
}

function _javaOwnerMethodReturnInfo(index, owner, method, ownerFile) {
    const ownerSimple = owner.split('.').pop();
    const platformReturn = JAVA_PLATFORM_METHOD_RETURNS.get(`${owner}#${method}`);
    if (platformReturn) return { type: platformReturn, platform: true };
    // getClass() is inherited from java.lang.Object by every reference type;
    // its platform return is exact even when the syntactic receiver is a
    // project class.
    if (method === 'getClass') return { type: 'java.lang.Class', platform: true };
    let definitions = (index.symbols.get(method) || [])
        .filter(d => d.className === ownerSimple && d.returnType);
    if (ownerFile) {
        const pinned = definitions.filter(d => d.file === ownerFile);
        if (pinned.length > 0) definitions = pinned;
    }
    const returns = new Map();
    for (const d of definitions) {
            let type = String(d.returnType).replace(/<.*$/s, '').trim();
            const suffix = type.endsWith('[]') ? '[]' : '';
            if (suffix) type = type.slice(0, -2);
            if (!type.includes('.')) {
                const imports = (index.files.get(d.file)?.importBindings || [])
                    .filter(binding => binding.name === type)
                    .map(binding => binding.module)
                    .filter(Boolean);
                if (imports.length === 1) type = imports[0];
            }
            if (type) {
                const key = `${type}${suffix}`;
                if (!returns.has(key)) returns.set(key, new Set());
                if (d.file) returns.get(key).add(d.file);
            }
    }
    // Project source is the primary authority. Only an agreeing owner-scoped
    // signature is usable; ambiguity remains visible.
    if (returns.size === 1) {
        const [type, files] = [...returns.entries()][0];
        const fromFile = files.size === 1 ? [...files][0] : undefined;
        return { type, ...(fromFile && { fromFile }) };
    }
    if (returns.size > 1) return null;
    return null;
}

function _javaStaticTypeForKind(index, kind) {
    if (!kind || kind === 'expr' || kind === 'lambda' || kind === 'null') return null;
    if (kind.startsWith('element:')) {
        const container = _javaStaticTypeForKind(index, kind.slice('element:'.length));
        return container?.endsWith('[]') ? container.slice(0, -2) : null;
    }
    if (kind.startsWith('field:')) {
        const parts = kind.slice('field:'.length).split(':');
        const fieldName = parts.pop();
        return _javaOwnerFieldType(index, parts.join(':'), fieldName);
    }
    if (kind.startsWith('fieldpath:')) {
        const parts = kind.slice('fieldpath:'.length)
            .split('|')
            .map(part => decodeURIComponent(part));
        let type = parts.shift() || null;
        for (const member of parts) {
            if (!type) return null;
            type = member === '[]'
                ? _csharpCollectionElementType(type)
                : _javaOwnerFieldType(index, type, member);
        }
        return type ? _overloadTypeIdentity(type) : null;
    }
    if (kind.startsWith('class:')) return 'Class';
    if (kind.startsWith('call:') || kind.startsWith('callshape:') ||
        kind.startsWith('chain:')) {
        return _javaCallReturnType(index, kind);
    }
    if (kind.startsWith('new:') || kind.startsWith('cast:') || kind.startsWith('type:')) {
        return _overloadTypeIdentity(kind.slice(kind.indexOf(':') + 1));
    }
    return null;
}

function _overloadTypeIdentity(raw) {
    let type = String(raw || '').trim().replace(/^global::/, '');
    const arrays = type.match(/(?:\[\])+$/)?.[0] || '';
    if (arrays) type = type.slice(0, -arrays.length);
    const parts = type.split('.');
    const simple = parts.pop();
    const normalized = CSHARP_OVERLOAD_ALIASES.get(simple) || simple;
    return [...parts, `${normalized}${arrays}`].filter(Boolean).join('.');
}

/**
 * Resolve the declared value type of a Java class-qualified field argument.
 * All same-owner declarations must agree; duplicate simple owner names with
 * conflicting fields remain unknown. Imported field types are qualified from
 * the declaring file so overload selection can compare exact platform types.
 */
function _javaOwnerFieldType(index, owner, fieldName) {
    if (!owner || !fieldName) return null;
    const ownerSimple = owner.replace(/\?$/, '')
        .replace(/<.*$/s, '').split('.').pop();
    const genericMember = _csharpGenericMemberType(owner, fieldName);
    if (genericMember) return genericMember;
    const platformType = CSHARP_PLATFORM_MEMBER_TYPES.get(
        `${ownerSimple}.${fieldName}`);
    if (platformType) return platformType;
    const fields = (index.symbols.get(fieldName) || []).filter(definition =>
        definition.className === ownerSimple &&
        (definition.type === 'field' || definition.memberType === 'field') &&
        definition.fieldType);
    if (fields.length === 0) {
        // JDK constant-field contracts (fix #299D): Float.NaN is a float,
        // Boolean.TRUE a Boolean. Project fields, checked above, always
        // outrank the platform table.
        return JAVA_PLATFORM_FIELD_TYPES.get(`${ownerSimple}.${fieldName}`) ||
            null;
    }

    const types = new Set();
    for (const field of fields) {
        let type = String(field.fieldType).trim();
        const suffix = type.endsWith('[]') ? '[]' : '';
        if (suffix) type = type.slice(0, -2);
        if (!type || /[|&]/.test(type)) return null;
        const genericAt = type.indexOf('<');
        const base = (genericAt >= 0 ? type.slice(0, genericAt) : type)
            .replace(/\?$/, '');
        if (!base.includes('.')) {
            const imports = (index.files.get(field.file)?.importBindings || [])
                .filter(binding => binding.name === base)
                .map(binding => binding.module)
                .filter(Boolean);
            if (new Set(imports).size === 1) {
                type = imports[0] + type.slice(base.length);
            }
        }
        types.add(`${type}${suffix}`);
    }
    return types.size === 1 ? [...types][0] : null;
}

function _csharpCollectionElementType(raw) {
    const type = String(raw || '').trim().replace(/\?$/, '');
    if (type.endsWith('[]')) return type.slice(0, -2);
    const open = type.indexOf('<');
    if (open < 0 || !type.endsWith('>')) return null;
    const owner = type.slice(0, open).split('.').pop();
    if (!new Set([
        'List', 'IList', 'IReadOnlyList', 'ICollection',
        'IEnumerable', 'IEnumerator', 'HashSet',
    ]).has(owner)) return null;
    const inner = type.slice(open + 1, -1);
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '<') depth++;
        else if (inner[i] === '>') depth--;
        else if (inner[i] === ',' && depth === 0) {
            return inner.slice(0, i).trim() || null;
        }
    }
    return inner.trim() || null;
}

function _csharpGenericMemberType(owner, fieldName) {
    if (fieldName !== 'Current') return null;
    const type = String(owner || '').trim().replace(/\?$/, '');
    const open = type.indexOf('<');
    if (open < 0 || !type.endsWith('>')) return null;
    const ownerName = type.slice(0, open).split('.').pop();
    if (!['IEnumerator', 'IEnumerable'].includes(ownerName)) return null;
    return _csharpCollectionElementType(type);
}

/**
 * Can an argument of static kind `kind` (from the Java parser's argKinds)
 * bind a parameter declared as `paramType`? Unknown kinds ('expr',
 * 'lambda'), unknown/generic param types, and unresolvable hierarchies all
 * match — a mismatch must be provable to count.
 */
function _javaArgKindMatches(index, kind, paramType, language) {
    if (!kind || kind === 'expr' || kind === 'lambda') return true;
    if (!paramType) return true;
    const rawBare = String(paramType).replace(/<.*$/s, '').trim()
        .replace(/\.\.\.$/, '').replace(/\[\]$/, '').split('.').pop();
    const bare = CSHARP_OVERLOAD_ALIASES.get(rawBare) || rawBare;
    if (!bare || bare === 'Object') return true;
    if (/^[A-Z][0-9]?$/.test(bare)) return true; // generic type variable (T, E, K1...)
    if (kind === 'null') return !JAVA_PRIMITIVES.has(bare);
    if (kind.startsWith('class:')) {
        return ['Class', 'Type', 'Serializable', 'GenericDeclaration',
            'AnnotatedElement'].includes(bare);
    }
    if (kind.startsWith('call:') || kind.startsWith('callshape:') ||
        kind.startsWith('chain:') || kind.startsWith('element:') ||
        kind.startsWith('field:') || kind.startsWith('fieldpath:')) {
        const staticType = _javaStaticTypeForKind(index, kind);
        // Only an owner-scoped, agreeing project annotation or an exact JDK
        // contract is type evidence.
        if (!staticType) return true;
        return _javaArgKindMatches(
            index, `type:${staticType}`, paramType, language);
    }
    if (kind.startsWith('new:') || kind.startsWith('cast:') || kind.startsWith('type:')) {
        const t = kind.slice(kind.indexOf(':') + 1);
        if (language === 'csharp') {
            const csharp = _csharpKnownTypeAssignable(t, paramType);
            if (csharp !== null) return csharp;
        }
        const actualNullable = t.trim().endsWith('?');
        const expectedText = String(paramType).replace(/<.*$/s, '').trim()
            .replace(/\.\.\.$/, '');
        const expectedNullable = expectedText.endsWith('?');
        const actualNullableBase = t.trim().replace(/\?$/, '').split('.').pop();
        const expectedNullableBase = expectedText.replace(/\?$/, '')
            .replace(/\[\]$/, '').split('.').pop();
        // C# Nullable<T> has no implicit conversion to T. This is complete
        // compiler evidence for value-type overloads such as Guid? vs Guid;
        // the reverse conversion is valid.
        if (actualNullable && !expectedNullable &&
            actualNullableBase === expectedNullableBase) {
            return false;
        }
        if (!actualNullable && expectedNullable &&
            actualNullableBase === expectedNullableBase) {
            return true;
        }
        const rawSimple = t.split('.').pop();
        const tSimple = CSHARP_OVERLOAD_ALIASES.get(rawSimple) || rawSimple;
        if (tSimple === bare) return true;
        const platformAssignable = _javaPlatformAssignable(t, bare);
        if (platformAssignable !== null) return platformAssignable;
        // A primitive argument type has closed conversion targets (fix
        // #299D): identity, widening, its own box, and the box's interfaces
        // — exactly the literal-kind table. This must precede the
        // final-reference denial below, which is boxing-blind (char DOES
        // bind a Character parameter). No project class can shadow a
        // primitive name, so no tDefs guard is needed.
        if (language === 'java' && JAVA_PRIMITIVES.has(tSimple) &&
            JAVA_KIND_TYPES[tSimple]) {
            return JAVA_KIND_TYPES[tSimple].includes(bare);
        }
        // A reference-typed argument reaches a primitive parameter only
        // through unboxing, defined for exactly the eight wrapper types
        // (then widening). Any other reference type — project, JDK, or
        // unknown — provably cannot bind a primitive parameter (fix #299D).
        if (language === 'java' && JAVA_PRIMITIVES.has(bare) &&
            !JAVA_PRIMITIVES.has(tSimple) && !/^[A-Z][0-9]?$/.test(tSimple)) {
            const unboxed = JAVA_WRAPPER_PRIMITIVES.get(tSimple);
            return unboxed != null &&
                (unboxed === bare ||
                 JAVA_KIND_TYPES[unboxed]?.includes(bare) === true);
        }
        // These java.lang types are final. A statically known different type
        // can never bind their overload, even when the argument type's own
        // ancestry ends in external Object and is therefore incomplete.
        if (JAVA_FINAL_REFERENCE_TYPES.has(bare)) return false;
        const tDefs = (index.symbols.get(tSimple) || [])
            .filter(d => ['class', 'interface', 'enum', 'struct', 'record']
                .includes(d.type));
        const expectedDefs = (index.symbols.get(bare) || [])
            .filter(d => ['class', 'interface', 'enum', 'struct', 'record']
                .includes(d.type));
        if (tDefs.length > 0 && tDefs.every(d =>
            d.type === 'enum' || d.type === 'struct')) {
            // Java/C# enums and C# value-type structs cannot derive from an
            // unrelated project class. Their complete identity is visible
            // without needing an external ancestry tail.
            return false;
        }
        if (expectedDefs.length > 0 && expectedDefs.every(d =>
            d.type === 'enum' || d.type === 'struct' ||
            d.modifiers?.includes('sealed'))) {
            return false;
        }
        if (language === 'java' && tDefs.length === 0) {
            // JDK value types have a complete, closed ancestry (fix #299D):
            // an Integer-typed argument can never bind add(JsonElement).
            // The no-project-def guard keeps a project class shadowing the
            // simple name in normal resolution.
            const valueAncestry = JAVA_PLATFORM_VALUE_ANCESTRY.get(tSimple);
            if (valueAncestry) return valueAncestry.includes(bare);
        }
        if (tDefs.length === 0) return true; // external arg type — unknowable
        const asTarget = [{ className: tSimple, file: tDefs[0].file }];
        if (_isDispatchAncestor(index, bare, asTarget)) return true;
        // Deny only when t's ancestry is fully project-visible — a chain
        // that dead-ends external may still reach paramType.
        return !_targetAncestryFullyResolved(index, asTarget);
    }
    const allowed = JAVA_KIND_TYPES[kind];
    if (!allowed) return true;
    return allowed.includes(bare);
}

function _cppTypeCategory(type) {
    if (!type) return { kind: 'unknown', head: null };
    const original = String(type).trim();
    const compact = original.replace(/\s+/g, '');
    const unqualified = original
        .replace(/\b(const|volatile|constexpr|typename|struct|class)\b/g, ' ')
        .replace(/&&|\.\.\.|[&*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const headText = unqualified.split('<')[0].trim();
    const head = headText.split('::').pop() || null;
    if (!head) return { kind: 'unknown', head: null };
    if (/^[A-Z][0-9]?$/.test(head)) return { kind: 'generic', head };

    const encodingIn = (value) => {
        if (value.includes('wchar_t') || /\bw(?:format_)?string(?:_view)?\b/.test(value)) {
            return 'wchar_t';
        }
        if (value.includes('char8_t') || value.includes('u8string')) return 'char8_t';
        if (value.includes('char16_t') || value.includes('u16string')) return 'char16_t';
        if (value.includes('char32_t') || value.includes('u32string')) return 'char32_t';
        if (value.includes('char')) return 'char';
        return null;
    };
    if (head === 'wformat_string') {
        return { kind: 'format-string', encoding: 'wchar_t', head };
    }
    if (head === 'format_string') {
        return { kind: 'format-string', encoding: 'char', head };
    }
    if (head === 'basic_format_string') {
        return {
            kind: 'format-string',
            encoding: encodingIn(compact) || null,
            head,
        };
    }
    if (head === 'wstring' || head === 'wstring_view') {
        return { kind: 'string', encoding: 'wchar_t', head };
    }
    if (head === 'string' || head === 'string_view') {
        return { kind: 'string', encoding: 'char', head };
    }
    if (head === 'basic_string' || head === 'basic_string_view') {
        return {
            kind: 'string',
            encoding: encodingIn(compact) || null,
            head,
        };
    }
    if (head === 'locale_ref' || head === 'locale') {
        return { kind: 'locale', head };
    }
    if (head === 'text_style') return { kind: 'style', head };
    if (['char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t'].includes(head)) {
        return {
            kind: compact.includes('*') || compact.includes('[')
                ? 'string' : 'character',
            encoding: head,
            head,
        };
    }
    if (['bool'].includes(head)) return { kind: 'bool', head };
    if ([
        'short', 'int', 'long', 'float', 'double', 'size_t', 'ptrdiff_t',
        'int8_t', 'int16_t', 'int32_t', 'int64_t',
        'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    ].includes(head) || /\b(?:unsigned|signed)\b/.test(original)) {
        return { kind: 'number', head };
    }
    if (compact.includes('*')) return { kind: 'pointer', head };
    return { kind: 'named', head };
}

/**
 * Conservative C++ static-shape test. A negative verdict is returned only
 * for language-level incompatible literal/platform categories. User-defined
 * converting constructors and unknown template constraints keep the
 * candidate alive.
 */
function _cppArgKindMatches(kind, paramType) {
    if (!kind || kind === 'expr' || !paramType) return true;
    const expected = _cppTypeCategory(paramType);
    if (expected.kind === 'unknown' || expected.kind === 'generic') return true;

    if (kind.startsWith('string:')) {
        const encoding = kind.slice('string:'.length);
        if (expected.kind === 'format-string' || expected.kind === 'string') {
            return !expected.encoding || expected.encoding === encoding;
        }
        if (['locale', 'style', 'number', 'bool', 'character', 'pointer']
            .includes(expected.kind)) {
            return false;
        }
        return true;
    }
    if (kind.startsWith('char:')) {
        const encoding = kind.slice('char:'.length);
        if (expected.kind === 'character') {
            return !expected.encoding || expected.encoding === encoding;
        }
        if (['format-string', 'string', 'locale', 'style', 'pointer']
            .includes(expected.kind)) {
            return false;
        }
        return true;
    }
    if (kind === 'number:integer' || kind === 'number:floating') {
        if (expected.kind === 'number') return true;
        if (['format-string', 'string', 'locale', 'style', 'pointer']
            .includes(expected.kind)) {
            return false;
        }
        return true;
    }
    if (kind === 'bool') {
        if (expected.kind === 'bool' || expected.kind === 'number') return true;
        if (['format-string', 'string', 'locale', 'style', 'pointer']
            .includes(expected.kind)) {
            return false;
        }
        return true;
    }
    if (kind === 'null') {
        return !['number', 'bool', 'character'].includes(expected.kind);
    }
    if (kind.startsWith('type:') || kind.startsWith('call:') ||
        kind.startsWith('bcall:')) {
        const actualType = kind.slice(kind.indexOf(':') + 1);
        const actual = _cppTypeCategory(actualType);
        if (actual.head && expected.head && actual.head === expected.head) return true;
        const closed = new Set([
            'format-string', 'string', 'locale', 'style',
            'number', 'bool', 'character',
        ]);
        if (closed.has(actual.kind) && closed.has(expected.kind)) {
            if (actual.kind !== expected.kind) {
                // std::locale converts to fmt::locale_ref by contract.
                if (actual.kind === 'locale' && expected.kind === 'locale') return true;
                return false;
            }
            if ((actual.kind === 'format-string' || actual.kind === 'string' ||
                actual.kind === 'character') &&
                actual.encoding && expected.encoding) {
                return actual.encoding === expected.encoding;
            }
        }
    }
    return true;
}

/** Is overload `def` applicable to this call's static argument shape? */
function _overloadApplicable(index, call, def) {
    const rawParams = def.paramsStructured;
    const boundExtension = !!(def.isExtensionMethod && call.isMethod &&
        call.receiver !== def.className);
    const ps = boundExtension && Array.isArray(rawParams)
        ? rawParams.slice(1)
        : rawParams;
    if (!Array.isArray(ps)) return true;
    const hasRest = ps.some(p => p && p.rest);
    const min = ps.filter(p => p && !p.optional && p.default === undefined && !p.rest).length;
    if (call.argCount < min) return false;
    if (!hasRest && call.argCount > ps.length) return false;
    const kinds = call.argKinds;
    if (!Array.isArray(kinds)) return true;
    const language = def.file && index.files.get(def.file)?.language;
    for (let i = 0; i < kinds.length && i < ps.length; i++) {
        const p = ps[i];
        if (!p || p.rest) break;
        const matches = language === 'cpp'
            ? _cppArgKindMatches(kinds[i], p.type)
            : _javaArgKindMatches(index, kinds[i], p.type, language);
        if (!matches) return false;
    }
    return true;
}

function _javaBareParamType(param) {
    if (!param?.type) return null;
    return String(param.type).replace(/<.*$/s, '').trim()
        .replace(/\.\.\.$/, '').replace(/\[\]$/, '').split('.').pop() || null;
}

function _javaParamAt(def, position, call = null) {
    let ps = def.paramsStructured;
    if (!Array.isArray(ps) || ps.length === 0) return null;
    if (call && def.isExtensionMethod && call.isMethod &&
        call.receiver !== def.className) {
        ps = ps.slice(1);
    }
    if (position < ps.length) return ps[position];
    const last = ps[ps.length - 1];
    return last?.rest ? last : null;
}

function _javaParamTypeIdentity(index, def, position, call = null) {
    const param = _javaParamAt(def, position, call);
    if (!param?.type) return null;
    let type = String(param.type).replace(/<.*$/s, '').trim()
        .replace(/\.\.\.$/, '');
    if (!type || type.includes('.')) return type || null;
    const fileEntry = def?.file && index.files.get(def.file);
    const imported = (fileEntry?.importBindings || [])
        .filter(binding => binding.name === type)
        .map(binding => binding.module)
        .filter(Boolean);
    if (imported.length === 1) return imported[0];
    if (JAVA_FINAL_REFERENCE_TYPES.has(type) || type === 'Object' ||
        type === 'Enum' || type === 'Throwable') {
        return `java.lang.${type}`;
    }
    return _overloadTypeIdentity(type);
}

function _javaTypeAtLeastAsSpecific(index, subType, superType, subDef) {
    if (!subType || !superType) return false;
    const subSimple = subType.split('.').pop();
    const superSimple = superType.split('.').pop();
    if (subType === superType || subSimple === superSimple) return true;
    const platformAssignable = _javaPlatformAssignable(subType, superSimple);
    if (platformAssignable !== null) return platformAssignable;
    if (superSimple === 'Object' && !JAVA_PRIMITIVES.has(subSimple)) return true;
    if (subSimple === 'String' &&
        ['CharSequence', 'Comparable', 'Serializable'].includes(superSimple)) {
        return true;
    }
    if (['Byte', 'Short', 'Integer', 'Long', 'Float', 'Double'].includes(subSimple) &&
        superSimple === 'Number') return true;
    const subDefs = (index.symbols.get(subSimple) || [])
        .filter(d => d.type === 'class' || d.type === 'interface');
    if (subDefs.length === 0) return false;
    return _isDispatchAncestor(index, superSimple, [{
        className: subSimple,
        file: subDef?.file || subDefs[0].file,
    }]);
}

// Conservative subset of Java's "most specific" rule. A candidate wins only
// when every argument position is at least as specific as every competing
// candidate and at least one position is strictly more specific. Unknown
// relationships stay ambiguous.
function _javaMostSpecificOverload(index, applicable, call, language) {
    const argCount = call.argCount;
    if (!Number.isInteger(argCount) || applicable.length < 2) return null;
    // Compiler-visible exact static types outrank candidates whose external
    // ancestry UCN cannot disprove. Example: an argument declared TypeElement
    // selects get(TypeElement), not the unrelated get(TypeMirror)/get(Type)
    // overloads merely because all three JDK interfaces are outside the
    // project inheritance graph.
    if (Array.isArray(call.argKinds)) {
        const exactCount = (definition) => {
            let count = 0;
            for (let i = 0; i < Math.min(call.argKinds.length, argCount); i++) {
                const kind = call.argKinds[i];
                const bare = _javaBareParamType(_javaParamAt(definition, i, call));
                if (!kind || !bare) continue;
                const staticType = _javaStaticTypeForKind(index, kind);
                const paramType = _javaParamTypeIdentity(index, definition, i, call);
                if (staticType && paramType &&
                    (staticType === paramType ||
                     (!staticType.includes('.') && !paramType.includes('.') &&
                      staticType === paramType))) {
                    count++;
                }
            }
            return count;
        };
        const ranked = applicable.map(definition => ({
            definition,
            exact: exactCount(definition),
        }));
        const best = Math.max(...ranked.map(item => item.exact));
        if (best > 0) {
            const winners = ranked.filter(item => item.exact === best);
            if (winners.length === 1) return winners[0].definition;
        }
    }
    // JLS 15.12.2 phase discipline (fix #299D): when EVERY argument's static
    // type is a known primitive, strict-invocation candidates (identity or
    // primitive widening, fixed arity — phase 1) exclude boxing candidates
    // (phase 2) from the race entirely; among widening targets the narrowest
    // is most specific (an int literal binds value(long), not value(float)/
    // value(double)/value(Number)). Varargs params are phase 3 and never
    // count as strict. Any non-primitive or unknown position refuses — phase
    // membership must be provable for every argument.
    if (language === 'java' && Array.isArray(call.argKinds) &&
        call.argKinds.length >= argCount && argCount > 0) {
        const primOf = (kind) => {
            if (!kind || typeof kind !== 'string') return null;
            if (JAVA_PRIMITIVES.has(kind)) return kind; // literal kinds
            const staticType = _javaStaticTypeForKind(index, kind);
            const simple = staticType ? staticType.split('.').pop() : null;
            return simple && JAVA_PRIMITIVES.has(simple) ? simple : null;
        };
        const prims = [];
        for (let i = 0; i < argCount; i++) prims.push(primOf(call.argKinds[i]));
        if (prims.every(Boolean)) {
            const strictAt = (prim, definition, i) => {
                const param = _javaParamAt(definition, i, call);
                if (!param || param.rest) return false;
                const bare = _javaBareParamType(param);
                return bare !== null && JAVA_PRIMITIVES.has(bare) &&
                    (prim === bare ||
                     JAVA_KIND_TYPES[prim]?.includes(bare) === true);
            };
            const strict = applicable.filter(definition => {
                for (let i = 0; i < argCount; i++) {
                    if (!strictAt(prims[i], definition, i)) return false;
                }
                return true;
            });
            if (strict.length === 1) return strict[0];
            if (strict.length > 1) {
                const dominatesPrim = (a, b) => {
                    let strictly = false;
                    for (let i = 0; i < argCount; i++) {
                        const at = _javaBareParamType(_javaParamAt(a, i, call));
                        const bt = _javaBareParamType(_javaParamAt(b, i, call));
                        if (at === bt) continue;
                        if (!JAVA_PRIMITIVES.has(bt) ||
                            JAVA_KIND_TYPES[at]?.includes(bt) !== true) {
                            return false;
                        }
                        strictly = true;
                    }
                    return strictly;
                };
                const winners = strict.filter(a =>
                    strict.every(b => a === b || dominatesPrim(a, b)));
                if (winners.length === 1) return winners[0];
                return null; // strict phase engaged but unranked — visible
            }
            // no strict candidate: boxing phase — general ranking decides
        }
    }
    const dominates = (a, b) => {
        let strict = false;
        for (let i = 0; i < argCount; i++) {
            const at = _javaParamTypeIdentity(index, a, i, call);
            const bt = _javaParamTypeIdentity(index, b, i, call);
            if (!at || !bt || !_javaTypeAtLeastAsSpecific(index, at, bt, a)) return false;
            if (at !== bt) strict = true;
        }
        return strict;
    };
    const winners = applicable.filter(a => applicable.every(b => a === b || dominates(a, b)));
    return winners.length === 1 ? winners[0] : null;
}

/**
 * Overload discipline: when the pinned target has a bindable sibling
 * overload, decide what the call site's static argument shape proves.
 * Java/C# use class ownership plus static argument kinds. C++ additionally
 * handles free-function overload sets visible through the caller's include
 * closure; without compiler-grade argument types, same-arity candidates stay
 * visibly ambiguous rather than being assigned to an arbitrary name binding.
 * Returns 'other-overload' (binds a sibling — exclusion evidence),
 * {ambiguous, candidates} (cannot tell — visible unverified), or null
 * (no siblings / uniquely the pinned one / model has no opinion).
 */
function _cppVisibleFiles(index, callerFile) {
    if (!index._cppVisibleFilesCache) {
        Object.defineProperty(index, '_cppVisibleFilesCache', {
            value: new Map(),
            configurable: true,
        });
    }
    const cached = index._cppVisibleFilesCache.get(callerFile);
    if (cached) return cached;
    const visible = new Set([callerFile]);
    const queue = [{ file: callerFile, depth: 0 }];
    while (queue.length > 0) {
        const { file, depth } = queue.shift();
        if (depth >= 32) continue;
        for (const imported of index.importGraph?.get(file) || []) {
            if (visible.has(imported)) continue;
            visible.add(imported);
            queue.push({ file: imported, depth: depth + 1 });
        }
    }
    index._cppVisibleFilesCache.set(callerFile, visible);
    return visible;
}

function _cppTargetVisibleFrom(index, callerFile, targetDefs) {
    return _cppTargetVisibility(index, callerFile, targetDefs) === 'yes';
}

function _isCppHeader(file) {
    return /\.(?:h|hh|hpp|hxx|h\+\+|inc)$/i.test(file || '');
}

function _cppExternalLinkVariant(boundDefinition, targetDefinitions) {
    if (!boundDefinition || boundDefinition.linkage !== 'c' ||
        !Array.isArray(targetDefinitions) || targetDefinitions.length === 0 ||
        targetDefinitions.some(definition => definition.linkage !== 'c')) {
        return false;
    }
    const signature = definition => {
        if (!Array.isArray(definition.paramsStructured)) return null;
        const params = definition.paramsStructured.map(param =>
            param?.rest ? '...' : String(param?.type || param?.name || '')
                .replace(/\s+/g, ''));
        return `${String(definition.returnType || '').replace(/\s+/g, '')}` +
            `(${params.join(',')})`;
    };
    const boundSignature = signature(boundDefinition);
    return !!boundSignature && targetDefinitions.every(definition =>
        signature(definition) === boundSignature);
}

function _cppTargetVisibility(index, callerFile, targetDefs) {
    if (!index._cppTargetVisibilityCache) {
        Object.defineProperty(index, '_cppTargetVisibilityCache', {
            value: new Map(),
            configurable: true,
        });
    }
    const targetKey = targetDefs.map(definition => definition.file || '')
        .sort(codeUnitCompare).join('\0');
    const cacheKey = `${callerFile}\0${targetKey}`;
    if (index._cppTargetVisibilityCache.has(cacheKey)) {
        return index._cppTargetVisibilityCache.get(cacheKey);
    }
    const finish = verdict => {
        index._cppTargetVisibilityCache.set(cacheKey, verdict);
        return verdict;
    };
    const visible = _cppVisibleFiles(index, callerFile);
    if (targetDefs.some(definition =>
        definition.file && visible.has(definition.file))) {
        return finish('yes');
    }
    // A missing relative/project header means the include graph is not a
    // closed compiler universe. Never turn that resolver gap into exclusion
    // evidence. External standard/library headers do not affect project
    // target visibility.
    const projectFiles = [...index.files.values()].map(entry =>
        String(entry.relativePath || '').replaceAll(path.sep, '/'));
    for (const file of visible) {
        const entry = index.files.get(file);
        if (!entry) continue;
        const resolved = entry.moduleResolved || {};
        for (const rawImport of entry.imports || []) {
            const specifier = String(rawImport || '').replaceAll('\\', '/');
            if (!specifier || Object.hasOwn(resolved, rawImport)) continue;
            const normalized = specifier.replace(/^\.\//, '').replace(/^\/+/, '');
            const projectLike = projectFiles.some(relative =>
                    relative === normalized ||
                    relative.endsWith(`/${normalized}`)) ||
                // A missing sibling generated header (`config.h`) can still
                // include the target. Namespaced unresolved paths
                // (`absl/types/any.h`) with no indexed suffix are external
                // package surfaces, like unresolved package imports in the
                // other language adapters.
                (specifier.startsWith('.') && !normalized.includes('/'));
            if (projectLike) return finish('unknown');
        }
    }
    return finish('no');
}

function _cppPathReceiverNamesType(index, receiver) {
    if (!receiver) return false;
    // Remove template arguments before selecting the terminal path segment;
    // nested qualifiers inside `<...>` must not be mistaken for the owner.
    let plain = '';
    let depth = 0;
    for (const character of String(receiver)) {
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
    const name = plain.split('::').filter(Boolean).pop();
    return !!(name && (index.symbols.get(name) || []).some(definition =>
        IDENTITY_TYPE_KINDS.has(definition.type) ||
        (definition.type === 'type' && definition.aliasOf)));
}

function _cppQualifiedPathOwnsTarget(index, callerFile, call, targetDefs) {
    if (!call?.isPathCall || !call.receiver || !callerFile ||
        !_cppTargetVisibleFrom(index, callerFile, targetDefs)) {
        return false;
    }
    const namespaceRoot = String(call.receiver)
        .split('::').filter(Boolean)[0];
    if (!namespaceRoot || namespaceRoot === 'std') return false;
    return targetDefs.some(definition => {
        if (!definition.file) return false;
        const namespace = String(definition.namespace || '');
        if (namespace === call.receiver ||
            namespace.startsWith(`${call.receiver}::`) ||
            namespace.endsWith(`::${call.receiver}`)) {
            return true;
        }
        const relative = path.relative(index.root, definition.file);
        return relative.split(path.sep).includes(namespaceRoot);
    });
}

function _overloadDiscipline(index, call, targetDefs, definitions, callerFile) {
    const targetOwners = new Set(targetDefs.map(d => d.className).filter(Boolean));
    const targetLanguage = targetDefs[0]?.file && index.files.get(targetDefs[0].file)?.language;
    const sameOwnerIdentity = (d) => {
        if (targetLanguage === 'java') {
            return targetDefs.some(t =>
                t.className === d.className && t.file && d.file &&
                t.file === d.file &&
                (t.enclosingType || null) === (d.enclosingType || null));
        }
        if (targetLanguage === 'csharp') {
            return targetDefs.some(t =>
                t.className === d.className &&
                (t.namespace || null) === (d.namespace || null) &&
                (t.explicitInterface || null) ===
                    (d.explicitInterface || null));
        }
        return true;
    };
    const pinnedKeys = new Set(targetDefs.map(d =>
        `${d.file}:${d.startLine}`));
    let family;
    if (targetOwners.size === 0 && targetLanguage === 'cpp' && callerFile &&
        targetDefs.every(d => !d.className && !d.receiver) &&
        _cppTargetVisibleFrom(index, callerFile, targetDefs)) {
        const visible = _cppVisibleFiles(index, callerFile);
        const callerHostsPin = targetDefs.some(d => d.file === callerFile);
        family = definitions.filter(d =>
            !NON_CALLABLE_TYPES.has(d.type) &&
            !d.className && !d.receiver &&
            (!call.isPathCall || d.file !== callerFile || callerHostsPin ||
             pinnedKeys.has(`${d.file}:${d.startLine}`)) &&
            (visible.has(d.file) ||
             pinnedKeys.has(`${d.file}:${d.startLine}`)));
    } else {
        if (targetOwners.size === 0) return null;
        family = definitions.filter(d => !NON_CALLABLE_TYPES.has(d.type) &&
            d.className && targetOwners.has(d.className) &&
            sameOwnerIdentity(d));
    }
    if (targetLanguage === 'cpp' && call.explicitTemplateCall) {
        // `f<T>(...)` cannot select a non-template overload. The tree-sitter
        // call record carries this compiler-visible distinction so explicit
        // template calls neither confirm nor stay ambiguous against ordinary
        // same-name functions.
        if (!targetDefs.some(definition => definition.templateDependent)) {
            return 'other-overload';
        }
        family = family.filter(definition => definition.templateDependent);
    }

    // Inherited sibling overloads (fix #268, javapoet-measured): the pin's
    // dispatch surface includes ancestor same-name methods — ClassName's
    // annotated(List) coexists with TypeName's FINAL annotated(Spec...), and
    // a 1-arg call may bind either; receiver-hint evidence said "some
    // annotated overload", not the pinned one (the #205 jdtls lesson).
    // Identical type signatures in an ancestor are the OVERRIDE SLOT the pin
    // occupies — the same virtual method, never a sibling.
    const typeSig = (d) => Array.isArray(d.paramsStructured)
        ? d.paramsStructured.map(p => String(p?.type ?? '').replace(/\s+/g, '')).join(',')
        : null;
    // C/C++ declarations and implementations are already closed into
    // `targetDefs` by _closeCallableIdentityGroup using opposite signature
    // roles plus include reachability. Parameter types alone are not enough:
    // constrained templates can share an identical function signature while
    // remaining distinct compiler overloads.
    const pinSigs = new Set(targetDefs.map(typeSig).filter(s => s !== null));
    // Occupied dispatch slots (fix #299D): an ancestor def whose signature
    // matches ANY family member of the descendant class is that member's
    // override/hiding slot — the same bindable method, never an extra
    // sibling. Without this, JsonTreeWriter's fully-overridden value(...)
    // family double-counted every JsonWriter overload and the exact-type
    // winner was never unique (two value(String) "candidates").
    const familySigs = new Set(pinSigs);
    for (const d of family) {
        const sig = typeSig(d);
        if (sig !== null) familySigs.add(sig);
    }
    const pinFile = targetDefs.find(d => d.file)?.file;
    const seenCls = new Set(targetOwners);
    const queue = [...targetOwners];
    let hops = 0;
    while (queue.length > 0 && hops++ < 32) {
        const cls = queue.pop();
        const parents = index._getInheritanceParents?.(cls, pinFile);
        if (!parents) continue;
        for (const p of parents) {
            const pName = typeof p === 'string' ? p : p?.name;
            if (!pName || seenCls.has(pName)) continue;
            seenCls.add(pName);
            queue.push(pName);
            for (const d of definitions) {
                if (NON_CALLABLE_TYPES.has(d.type) || d.className !== pName) continue;
                const sig = typeSig(d);
                if (sig !== null && familySigs.has(sig)) continue; // occupied slot
                if (sig !== null) familySigs.add(sig);
                family.push(d);
            }
        }
    }
    if (family.length <= 1) return null;
    if (family.every(d => pinnedKeys.has(`${d.file}:${d.startLine}`))) return null;
    // Producer-return argument typing (fix #299B): a bare-identifier
    // producer (`paint(tint(3))`) types its argument position from the
    // project's declared return type — the #199/#207 return-type-flow rail
    // at the argument site. Resolution demands a unique project identity
    // with full return-text agreement; anything less keeps the opaque
    // `bcall:` kind (matches everything, no decision either way).
    if (targetLanguage === 'cpp' && Array.isArray(call.argKinds) &&
        call.argKinds.some(kind => typeof kind === 'string' &&
            kind.startsWith('bcall:'))) {
        const resolvedKinds = call.argKinds.map(kind => {
            if (typeof kind !== 'string' || !kind.startsWith('bcall:')) return kind;
            const producerReturn = _cppBareProducerReturnType(
                index, kind.slice('bcall:'.length));
            return producerReturn ? `type:${producerReturn}` : kind;
        });
        if (resolvedKinds.some((kind, i) => kind !== call.argKinds[i])) {
            call = { ...call, argKinds: resolvedKinds };
        }
    }
    let applicable = family.filter(d => _overloadApplicable(index, call, d));
    if (applicable.length === 0) return null; // shape fits nothing we model — no claim
    if (targetLanguage === 'java' || targetLanguage === 'csharp') {
        applicable = _preferFixedArityOverloads(
            index, call, applicable, targetLanguage);
    }
    const mostSpecific = (targetLanguage === 'java' ||
        targetLanguage === 'csharp')
        ? _javaMostSpecificOverload(index, applicable, call, targetLanguage)
        : null;
    if (mostSpecific) {
        return pinnedKeys.has(`${mostSpecific.file}:${mostSpecific.startLine}`)
            ? null : 'other-overload';
    }
    const pinnedApplicable = applicable.some(d => pinnedKeys.has(`${d.file}:${d.startLine}`));
    if (!pinnedApplicable) return 'other-overload';
    if (applicable.every(d =>
        pinnedKeys.has(`${d.file}:${d.startLine}`))) {
        return null;
    }
    if (applicable.length === 1) return null; // uniquely the pinned overload
    if (targetLanguage === 'cpp') {
        const winner = _cppExactOverloadWinner(call, applicable);
        if (winner) {
            return pinnedKeys.has(`${winner.file}:${winner.startLine}`)
                ? null : 'other-overload';
        }
    }
    const compileTimeDispatch = targetLanguage === 'cpp';
    const templateOnly = compileTimeDispatch &&
        applicable.every(definition => definition.templateDependent);
    return {
        ambiguous: true,
        candidates: applicable.length,
        ...(compileTimeDispatch && {
            compileTimeDispatch: true,
            dispatchFamily: templateOnly
                ? `${call.name} template overload set`
                : `${call.name} C++ overload set`,
        }),
    };
}

// C++ exact-static-type overload selection (fix #299C): when every argument
// position carries a concrete static type (`type:X` from declared locals or
// casts) and exactly one NON-template candidate matches every position at
// Exact Match rank, the compiler selects it — identity conversion outranks
// every other conversion sequence, and non-template beats template on the
// tie-break. Template winners are refused (their param text can name their
// own template parameters, and SFINAE can disable them invisibly); literal
// and `expr` kinds refuse the whole selection (integer literals rank equally
// against sibling integer widths). Exactness is deliberately narrower than
// the compiler's Exact Match class: by-value top-level const is ignored and
// `const X&` binding accepted, but non-const refs (cast rvalues can't bind),
// rvalue refs, and pointer-pointee qualification changes all refuse — a
// missed exact match keeps the site visible, a wrong one would exclude a
// true caller.
function _cppNormalizeTypeText(text) {
    if (!text) return null;
    return String(text).replace(/\s+/g, ' ')
        .replace(/\s*([*&])\s*/g, ' $1').trim() || null;
}

function _cppStripTopLevelConst(text) {
    if (!text || /[*&]$/.test(text)) return text;
    return text.replace(/^const /, '').replace(/^volatile /, '');
}

function _cppExactParamMatch(paramType, argType) {
    const param = _cppNormalizeTypeText(paramType);
    const arg = _cppStripTopLevelConst(_cppNormalizeTypeText(argType));
    if (!param || !arg) return false;
    return param === arg ||
        _cppStripTopLevelConst(param) === arg ||
        param === `const ${arg} &`;
}

// Resolve a bare-identifier producer name to its declared return type
// (fix #299B). Discipline mirrors the #199/#207 return-type-flow rails:
// every callable def of the name project-wide must live in a C-family file
// and agree on ONE full normalized return text. Type defs sharing the name
// refuse (the bare call may be a constructor), template producers refuse
// (their substituted return is instantiation-dependent), `auto` without a
// recorded trailing type refuses, and return-less defs are ignored only
// when they are declarations whose parameter shape matches a return-bearing
// def — a C++ declaration's return type must match its definition, so a
// ret-less signature there is a parse gap on the SAME entity, never a
// hidden disagreeing overload.
function _cppBareProducerReturnType(index, producerName) {
    if (!producerName) return null;
    const defs = (index.symbols.get(producerName) || []);
    if (defs.length === 0) return null;
    const paramKey = (def) => Array.isArray(def.paramsStructured)
        ? def.paramsStructured.map(param =>
            _cppNormalizeTypeText(param?.type) || '?').join('\0')
        : null;
    const returnBearing = [];
    const returnLess = [];
    for (const def of defs) {
        const language = index.files.get(def.file)?.language;
        if (language !== 'c' && language !== 'cpp') return null;
        if (NON_CALLABLE_TYPES.has(def.type)) return null; // constructor risk
        if (def.isSpecialization) continue; // same entity as its primary
        if (def.returnType) returnBearing.push(def);
        else returnLess.push(def);
    }
    if (returnBearing.length === 0) return null;
    for (const def of returnLess) {
        if (!def.isSignature) return null;
        const key = paramKey(def);
        if (key === null ||
            !returnBearing.some(other => paramKey(other) === key)) {
            return null;
        }
    }
    let agreed = null;
    for (const def of returnBearing) {
        if (def.templateDependent) return null;
        const returnText = _cppNormalizeTypeText(def.returnType);
        if (!returnText || /^auto\b/.test(returnText)) return null;
        if (agreed === null) agreed = returnText;
        else if (agreed !== returnText) return null;
    }
    return agreed;
}

function _cppExactOverloadWinner(call, applicable) {
    const kinds = call.argKinds;
    if (!Array.isArray(kinds) || !Number.isInteger(call.argCount) ||
        call.argCount === 0 || kinds.length < call.argCount) return null;
    const argTypes = [];
    for (let i = 0; i < call.argCount; i++) {
        const kind = kinds[i];
        if (typeof kind !== 'string' || !kind.startsWith('type:')) return null;
        const argType = kind.slice('type:'.length);
        if (!argType) return null;
        argTypes.push(argType);
    }
    let winner = null;
    for (const def of applicable) {
        if (def.templateDependent || def.isSpecialization) continue;
        const ps = def.paramsStructured;
        if (!Array.isArray(ps) || ps.length < call.argCount) continue;
        if (ps.some(param => param && (param.rest || param.variadic))) continue;
        let exact = true;
        for (let i = 0; i < call.argCount; i++) {
            if (!_cppExactParamMatch(ps[i]?.type, argTypes[i])) {
                exact = false;
                break;
            }
        }
        if (!exact) continue;
        if (winner) return null; // two exact candidates — refuse
        winner = def;
    }
    return winner;
}

/**
 * Build the target type set for receiver-class disambiguation: target
 * classes/receivers + their non-overriding subtypes (transitively). A Child
 * receiver calling an inherited Base method IS a caller of Base.method;
 * children that define the method themselves dispatch to the override.
 */
function _buildTargetTypeSet(index, targetDefs, definitions) {
    const targetTypes = new Set();
    for (const td of targetDefs) {
        if (td.explicitInterface) {
            const interfaceType = _csharpTypeIdentity(td.explicitInterface);
            if (interfaceType) targetTypes.add(interfaceType);
        } else {
            if (td.className) targetTypes.add(td.className);
            if (td.receiver) targetTypes.add(td.receiver.replace(/^\*/, ''));
        }
    }
    if (targetTypes.size > 0) {
        const targetLanguage = targetDefs.find(definition => definition.file)?.file;
        const language = targetLanguage
            ? index.files.get(targetLanguage)?.language
            : null;
        const signature = definition => Array.isArray(definition.paramsStructured)
            ? definition.paramsStructured
                .filter(param => !param?.extensionReceiver)
                .map(param => String(param?.type || '').replace(/\s+/g, ''))
                .join(',')
            : null;
        const overloadedSlots = !!langTraits(language)?.hasArityOverloads;
        const targetSignatures = new Set(targetDefs.map(signature)
            .filter(value => value !== null));
        const queue = [...targetTypes];
        while (queue.length > 0) {
            const children = index.extendedByGraph?.get(queue.pop());
            if (!children) continue;
            for (const child of children) {
                const cName = typeof child === 'string' ? child : child.name;
                if (!cName || targetTypes.has(cName)) continue;
                // In overload-capable languages, another same-named overload
                // on the child does not override the pinned virtual slot.
                // JsonTextWriter.WriteValue(Guid) must not hide inherited
                // JsonWriter.WriteValue(Guid?). Only an agreeing parameter
                // signature blocks the subtype closure.
                const childDefinitions = definitions.filter(definition =>
                    definition.className === cName);
                const overrides = childDefinitions.some(definition =>
                        !overloadedSlots ||
                        targetSignatures.has(signature(definition)));
                if (overrides) continue;
                targetTypes.add(cName);
                queue.push(cName);
            }
        }
    }
    // Rust Deref changes method lookup identity: methods on Target are
    // callable through the wrapper value. Close only over wrappers whose
    // indexed type definitions all agree on one Deref target.
    if (targetTypes.size > 0) {
        const derefPairs = [];
        for (const [wrapper, defs] of index.symbols) {
            const typeDefs = defs.filter(d => IDENTITY_TYPE_KINDS.has(d.type));
            if (typeDefs.length === 0 || !typeDefs.every(d => d.derefTarget)) continue;
            const targets = new Set(typeDefs.map(d => d.derefTarget));
            if (targets.size === 1) derefPairs.push([wrapper, [...targets][0]]);
        }
        let changed = derefPairs.length > 0;
        while (changed) {
            changed = false;
            for (const [wrapper, target] of derefPairs) {
                if (targetTypes.has(target) && !targetTypes.has(wrapper)) {
                    targetTypes.add(wrapper);
                    changed = true;
                }
            }
        }
    }
    // Type aliases are the SAME type (Rust `pub type StyledString =
    // SpannedString<Style>`, Go `type A = B`) — compiler-checked identity,
    // not a subtype edge. Close over them in BOTH directions: a method on
    // the base must accept alias-qualified receivers (cursive-measured: 24
    // StyledString::plain edges wrongly excluded as path-type-mismatch),
    // and a method on an inherent alias impl must accept base receivers.
    // Sound only when EVERY type-kind def of the name is an alias agreeing
    // on one base — a same-name alias to a different type in another
    // package must not confirm foreign receivers (#206 discipline). The
    // parser records aliasOf for Rust/Go; names without it never close.
    if (targetTypes.size > 0) {
        const aliasPairs = [];
        for (const [aliasName, defs] of index.symbols) {
            let base = null;
            let pure = true;
            for (const d of defs) {
                if (d.type !== 'type' && !IDENTITY_TYPE_KINDS.has(d.type)) continue;
                if (d.type === 'type' && d.aliasOf) {
                    const normalized = _normalizedAliasBase(index, d);
                    if (base === null) base = normalized;
                    else if (base !== normalized) { pure = false; break; }
                } else { pure = false; break; }
            }
            if (pure && base) aliasPairs.push([aliasName, base]);
        }
        let changed = aliasPairs.length > 0;
        while (changed) {
            changed = false;
            for (const [a, b] of aliasPairs) {
                if (targetTypes.has(b) && !targetTypes.has(a)) { targetTypes.add(a); changed = true; }
                if (targetTypes.has(a) && !targetTypes.has(b)) { targetTypes.add(b); changed = true; }
            }
        }
    }
    return targetTypes;
}

/**
 * Can a receiver typed as `typeName` VIRTUALLY dispatch into the target
 * definition? True when typeName is a project interface/trait that declares
 * the method or sits above the target's class, or — in languages where every
 * instance method is virtual (Java) — any supertype of the target. Go struct
 * embedding binds statically and never qualifies; Go interfaces qualify via
 * the declares-the-method check (satisfaction is implicit — there is no
 * recorded edge to walk). Used only to decide possible-dispatch ROUTING
 * (visible unverified), never to exclude.
 */
function _dispatchCapableSupertype(index, language, typeName, targetDefs, definitions) {
    const traits = langTraits(language);
    if (traits?.typeSystem !== 'nominal') return false;
    // The implicit root supertype (Java `Object`) sits above EVERY class
    // without a declared extends edge — `void show(Object o) { o.size() }`
    // can dispatch into any project override, but the ancestry walk below
    // cannot see the implicit edge (fix #212). Bare-name compare on the last
    // segment covers `java.lang.Object` annotations; a project class that
    // shadows the root name only ever gains routing (demote-only), never
    // loses an exclusion it was entitled to.
    if (traits.universalSupertype &&
        String(typeName).split('.').pop() === traits.universalSupertype) {
        return true;
    }
    const typeDefs = index.symbols.get(typeName) || [];
    const isIface = typeDefs.some(d => d.type === 'interface' || d.type === 'trait');
    if (isIface) {
        // The interface/trait declares this method → any implementor
        // (recorded or implicit) may receive the call.
        if (definitions.some(d => d.className === typeName)) return true;
        return _isDispatchAncestor(index, typeName, targetDefs);
    }
    // A Go type declared in an external package may be an interface. Since
    // interface satisfaction is implicit, UCN has no implements edge that
    // could disprove dispatch into a project method. Route it visibly; never
    // use this uncertainty to confirm an edge.
    if (language === 'go' && _externalGoDispatchType(index, typeName) &&
        targetDefs.some(d => d.className || d.receiver)) return true;
    // C# calls can dispatch through an external base/interface when the
    // indexed target explicitly declares that ancestry. Unlike Java, not
    // every C# member is virtual, so require the recorded relationship.
    if (language === 'csharp' && _isDispatchAncestor(index, typeName, targetDefs)) {
        return true;
    }
    if (traits.explicitVirtualDispatch &&
        _isDispatchAncestor(index, typeName, targetDefs)) {
        const virtual = new Set(['virtual', 'override']);
        const targetName = targetDefs[0]?.name;
        const ownerNames = new Set();
        const queue = targetDefs.map(definition => ({
            name: definition.className ||
                (definition.receiver || '').replace(/^\*/, ''),
            file: definition.file,
        })).filter(item => item.name);
        while (queue.length > 0) {
            const current = queue.shift();
            if (ownerNames.has(current.name)) continue;
            ownerNames.add(current.name);
            for (const parent of index._getInheritanceParents(
                current.name, current.file) || []) {
                queue.push({
                    name: parent,
                    file: index._resolveClassFile
                        ? index._resolveClassFile(parent, current.file)
                        : current.file,
                });
            }
        }
        return (definitions || index.symbols.get(targetName) || []).some(definition =>
            ownerNames.has(definition.className ||
                (definition.receiver || '').replace(/^\*/, '')) &&
            (definition.modifiers || []).some(modifier => virtual.has(modifier)));
    }
    if (traits.allMethodsVirtual) {
        return _isDispatchAncestor(index, typeName, targetDefs);
    }
    return false;
}

function _externalGoDispatchType(index, typeName) {
    if (!typeName || BUILTIN_RECEIVER_TYPES.has(typeName)) return false;
    // `error` and `any` are builtin interfaces and therefore dispatch
    // contracts; other lowercase builtins are concrete and excluded above.
    if (typeName === 'error' || typeName === 'any') return true;
    const defs = index.symbols.get(typeName) || [];
    return !defs.some(d => d.type === 'class' || d.type === 'struct' ||
        d.type === 'interface' || d.type === 'trait' || d.type === 'type');
}

/**
 * Resolve the package provenance retained on a Go receiver annotation.
 * `http.Handler` must never collapse into an unrelated project-local
 * `Handler`. A resolved project import returns the exact package directory
 * and its same-named type declarations; an unresolved imported package is
 * external/opaque and therefore dispatch-capable but never confirmable.
 */
function _goQualifiedReceiverType(index, fileEntry, qualifier, typeName) {
    if (!fileEntry || !qualifier || !typeName) return null;
    const modules = fileEntry.imports || [];
    const names = fileEntry.importNames || [];
    let importModule = null;
    if (names.length === modules.length) {
        const i = names.indexOf(qualifier);
        if (i >= 0) importModule = modules[i];
    }
    if (!importModule) {
        importModule = modules.find(mod => {
            const parts = String(mod).split('/');
            const last = parts[parts.length - 1];
            const packageName = /^v\d+$/.test(last) && parts.length > 1
                ? parts[parts.length - 2] : last;
            return packageName === qualifier;
        }) || null;
    }
    if (!importModule) return null;

    const resolvedRel = fileEntry.moduleResolved && fileEntry.moduleResolved[importModule];
    if (!resolvedRel) {
        return { kind: 'opaque', via: `${qualifier}.${typeName}`, importModule };
    }
    const resolvedFile = path.isAbsolute(resolvedRel)
        ? resolvedRel : path.join(index.root, resolvedRel);
    const dir = path.dirname(resolvedFile);
    const defs = (index.symbols.get(typeName) || []).filter(d =>
        d.file && path.dirname(d.file) === dir && IDENTITY_TYPE_KINDS.has(d.type));
    return { kind: 'project', via: `${qualifier}.${typeName}`, importModule, dir, defs };
}

/** A declared interface/trait receiver names a dispatch contract, not one executable body. */
function _isDispatchContractType(index, typeName) {
    if (!typeName) return false;
    return (index.symbols.get(typeName) || [])
        .some(d => d.type === 'interface' || d.type === 'trait');
}

/**
 * Like _isAncestorOfTargetClass, but walks `implements` records (Java
 * implements clauses, Rust `impl Trait for Type` surfaced as implements)
 * in addition to extends edges — the inheritance graph only stores extends,
 * yet virtual dispatch flows through interface/trait edges too. Routing
 * decision only (possible-dispatch vs excluded), never exclusion evidence.
 */
function _isDispatchAncestor(index, typeName, targetDefs) {
    const visited = new Set();
    const queue = [];
    for (const td of targetDefs) {
        const cls = td.className || (td.receiver && td.receiver.replace(/^\*/, ''));
        if (cls) queue.push({ name: cls, file: td.file });
    }
    while (queue.length > 0) {
        const { name, file } = queue.shift();
        if (visited.has(name)) continue;
        visited.add(name);
        const parents = [
            ...(index._getInheritanceParents(name, file) || []),
            ..._implementsParents(index, name),
        ];
        for (const parent of parents) {
            if (parent === typeName) return true;
            if (!visited.has(parent)) {
                const parentFile = index._resolveClassFile ? index._resolveClassFile(parent, file) : file;
                queue.push({ name: parent, file: parentFile });
            }
        }
    }
    return false;
}

/** Interface/trait names a class declares it implements (generics stripped). */
function _implementsParents(index, className) {
    const defs = index.symbols.get(className);
    if (!defs) return [];
    const out = [];
    for (const d of defs) {
        if (!Array.isArray(d.implements)) continue;
        for (const p of d.implements) {
            const bare = String(p).replace(/<.*$/s, '').trim().split(/[.:]+/).pop();
            if (bare) out.push(bare);
        }
    }
    return out;
}

/**
 * How many same-name method definitions could a call through `via` dispatch
 * to? Counts distinct owner types among the definitions that sit at or below
 * `via` (extends edges + implements records). Languages with implicit
 * interface satisfaction (Go) record no edges at all — fall back to the full
 * owner count. Display/routing enrichment only ("1 of N implementations").
 */
function _countDispatchCandidates(index, via, definitions) {
    const ownerFiles = new Map(); // owner type -> defining file
    for (const d of definitions) {
        if (NON_CALLABLE_TYPES.has(d.type)) continue;
        const o = d.className || (d.receiver && d.receiver.replace(/^\*/, ''));
        if (o && !ownerFiles.has(o)) ownerFiles.set(o, d.file);
    }
    if (ownerFiles.size === 0) return 0;
    // Interface/trait owners hold the abstract declaration, not a landing
    // site — "implementations" counts the concrete methods dispatch can run.
    const isIface = (o) => (index.symbols.get(o) || [])
        .some(d => d.type === 'interface' || d.type === 'trait');
    let count = 0;
    let concrete = 0;
    for (const [owner, file] of ownerFiles) {
        if (isIface(owner)) continue;
        concrete++;
        if (owner === via || _isDispatchAncestor(index, via, [{ className: owner, file }])) count++;
    }
    // No recorded edges below `via` (Go interfaces are satisfied implicitly)
    // → any concrete owner is a candidate.
    return count > 0 ? count : (concrete > 0 ? concrete : ownerFiles.size);
}

/**
 * Resolve a one-hop field receiver to a declared project INTERFACE/TRAIT
 * type — exactly the case _declaredFieldType refuses (a trait-typed field is
 * not exclusion evidence against any implementor). Dispatch attribution
 * only: lets the unverified tier say "possible-dispatch via <Interface>".
 * Rust `dyn Trait` / `Box<dyn Trait>` / `&dyn Trait` resolve to Trait here.
 */
function _declaredFieldInterfaceType(index, rootType, fieldName, language, rootNamespace) {
    const defs = index.symbols.get(fieldName);
    if (!defs) return null;
    const fields = defs.filter(d =>
        (d.type === 'field' || d.memberType === 'field') &&
        d.className === rootType && d.fieldType &&
        (language !== 'csharp' || !rootNamespace ||
            (d.namespace || null) === rootNamespace));
    if (fields.length === 0) return null;
    const normalized = new Set();
    for (const f of fields) {
        const t = _normalizeFieldTypeName(f.fieldType, language) ||
            (language === 'rust' ? _normalizeRustDynTypeName(f.fieldType) : null);
        if (t) normalized.add(t);
        else return null; // un-normalizable declaration → no attribution
    }
    if (normalized.size !== 1) return null; // same-named classes disagree
    const typeName = [...normalized][0];
    const typeDefs = index.symbols.get(typeName);
    if (!typeDefs || !typeDefs.some(d => d.type === 'trait' || d.type === 'interface')) return null;
    return typeName;
}

/** Rust dyn-trait declarations: `dyn Flag`, `&dyn Flag`, `Box<dyn Flag>` → Flag. */
function _normalizeRustDynTypeName(raw) {
    let t = String(raw).trim();
    let prev;
    do {
        prev = t;
        t = t.replace(/^&+\s*/, '').replace(/^'[A-Za-z_][A-Za-z0-9_]*\s*/, '').replace(/^mut\s+/, '');
        const wrap = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*<(.*)>$/s);
        if (wrap && _RUST_DEREF_WRAPPERS.has(wrap[1])) t = wrap[2].trim();
    } while (t !== prev);
    const m = t.match(/^dyn\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)$/s);
    if (!m) return null;
    return m[1].split('::').pop().trim();
}

/**
 * Is every ancestor in the targets' inheritance closure a project-resolvable
 * class? A chain that dead-ends at an EXTERNAL ancestor may continue into
 * supertypes UCN can't see, so absence-of-knownType in the visible chain is
 * not evidence (fix #202: external-type exclusion gate).
 */
function _targetAncestryFullyResolved(index, targetDefs) {
    const visited = new Set();
    const queue = [];
    for (const td of targetDefs) {
        const cls = td.className || (td.receiver && td.receiver.replace(/^\*/, ''));
        if (cls) queue.push({ name: cls, file: td.file });
    }
    while (queue.length > 0) {
        const { name, file } = queue.shift();
        if (visited.has(name)) continue;
        visited.add(name);
        const parents = index._getInheritanceParents(name, file) || [];
        for (const parent of parents) {
            const defs = index.symbols.get(parent);
            const isProject = !!defs && defs.some(d =>
                d.type === 'class' || d.type === 'struct' || d.type === 'interface' || d.type === 'trait');
            if (!isProject) return false; // external ancestor — chain invisible beyond here
            if (!visited.has(parent)) {
                const parentFile = index._resolveClassFile ? index._resolveClassFile(parent, file) : file;
                queue.push({ name: parent, file: parentFile });
            }
        }
    }
    return true;
}

// _externalContractMarker moved to core/shared.js as isOverrideMarked (shared
// with deadcode's out-of-tree override suppression — one source of truth).

/**
 * Name of the external contract a marked method implements, for dispatch
 * attribution ("possible-dispatch via Number — external contract"). Rust
 * impls name the trait directly; Java/TS/Python derive it from the class's
 * own extends/implements entries that do NOT resolve to project types.
 * Returns null when the contract type is not uniquely attributable —
 * the demotion still applies, only the label loses its `via`.
 */
function _externalContractVia(index, def) {
    if (def.traitName) {
        // rust `impl fmt::Display for X` → Display (strip path + generics)
        const bare = String(def.traitName).replace(/<.*$/, '').split('::').pop().trim();
        return bare || null;
    }
    const cls = def.className;
    if (!cls) return null;
    const classDefs = (index.symbols.get(cls) || []).filter(d =>
        d.file === def.file &&
        (d.type === 'class' || d.type === 'struct' || d.type === 'interface' || d.type === 'trait'));
    const supers = [];
    for (const cd of classDefs) {
        if (cd.extends) supers.push(...(Array.isArray(cd.extends) ? cd.extends : [cd.extends]));
        if (cd.implements) supers.push(...cd.implements);
    }
    const externals = [];
    for (const raw of supers) {
        const bare = String(raw).replace(/<.*$/, '').split('.').pop().trim();
        if (!bare) continue;
        const defs = index.symbols.get(bare);
        const isProject = !!defs && defs.some(d =>
            d.type === 'class' || d.type === 'struct' || d.type === 'interface' || d.type === 'trait');
        if (!isProject && !externals.includes(bare)) externals.push(bare);
    }
    if (externals.length === 1) return externals[0];
    if (externals.length === 0 && supers.length === 0 &&
        def.modifiers && def.modifiers.includes('override')) {
        // java: @Override with no explicit supertypes can only override
        // java.lang.Object (toString/equals/hashCode) — in compiling code.
        return 'Object';
    }
    return null; // several external candidates — attribution unknowable
}

/** Rust deref-transparent wrappers: Box<X>/Rc<X>/Arc<X> auto-deref to X for method calls. */
const _RUST_DEREF_WRAPPERS = new Set(['Box', 'Rc', 'Arc']);

function _javaNestedTypeQualifier(raw) {
    const base = String(raw || '').trim().replace(/<.*$/s, '');
    const parts = base.split('.');
    if (parts.length < 2) return undefined;
    const qualifier = parts[parts.length - 2];
    return /^[A-Z_$]/.test(qualifier) ? qualifier : undefined;
}

/**
 * Normalize a declared field type to a bare nominal type name, or null when
 * the declaration carries no usable single-type evidence.
 *   rust: `&'a mut ignore::DirEntry` → DirEntry; `Box<DirEntry>` → DirEntry;
 *         `Box<dyn Flag>`/`dyn Flag`/`impl Trait` → null; tuples/fns → null
 *   go:   `*ignore.Ig` → Ig; slices/maps/chans/funcs → null
 *   java: `java.util.List<Foo>` → List; arrays → null
 */
function _normalizeFieldTypeName(raw, language) {
    let t = String(raw).trim();
    if (language === 'rust') {
        let prev;
        do {
            prev = t;
            t = t.replace(/^&+\s*/, '').replace(/^'[A-Za-z_][A-Za-z0-9_]*\s*/, '').replace(/^mut\s+/, '');
        } while (t !== prev);
        if (/^(dyn|impl)\b/.test(t)) return null;
        const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:<(.*)>)?$/s);
        if (!m) return null;
        const base = m[1].split('::').pop().trim();
        if (m[2] !== undefined && _RUST_DEREF_WRAPPERS.has(base)) {
            return _normalizeFieldTypeName(m[2], 'rust');
        }
        return base;
    }
    if (language === 'go') {
        t = t.replace(/^\*+/, '');
        const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (!m) return null;
        return m[2] || m[1];
    }
    if (language === 'cpp') {
        t = t.replace(/\b(const|volatile|class|struct|typename)\b/g, '').trim();
        t = t.replace(/[*&]+/g, '').trim();
        const match = t.match(/^([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*(?:<.*>)?$/s);
        if (!match) return null;
        return match[1].split('::').pop().trim();
    }
    if (language === 'java' || language === 'csharp') {
        if (language === 'csharp') t = t.replace(/\?$/, '');
        const m = t.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:<.*>)?$/s);
        if (!m) return null;
        return m[1].split('.').pop();
    }
    if (langTraits(language)?.typeSystem === 'structural') {
        // JS/TS/Python (fix #219): compiler-true annotation heads, value-
        // position semantics — a field declared Promise<X> HOLDS a Promise.
        return _structuralTypeHead(t, { language });
    }
    return null;
}

// typing-module aliases for builtin containers — normalized to the runtime
// type so BUILTIN_RECEIVER_TYPES and the trust gate see one name.
const _PY_TYPING_BUILTINS = {
    Dict: 'dict', List: 'list', Set: 'set', Tuple: 'tuple',
    FrozenSet: 'frozenset', Text: 'str',
};

/**
 * Single concrete type name from a STRUCTURAL annotation in value position
 * (fix #219): field declarations and chained-receiver producer returns.
 * Unlike _typeNameFromReturnAnnotation, Promise/Awaitable are NOT unwrapped
 * by default — the value IS the promise (`parseAsync(...).catch` dispatches
 * on Promise). opts.unwrapAsync handles `(await f()).m()`: TS annotations
 * unwrap their Promise/Awaitable head; a Python async producer's annotation
 * already names the awaited value, so it passes through unchanged.
 * Conservative: unions of two real types, function types, object literals,
 * and tuples return null — a wrong head would exclude true callers.
 */
function _structuralTypeHead(text, opts = {}) {
    if (!text || typeof text !== 'string') return null;
    let t = text.trim().replace(/^readonly\s+/, '').replace(/^["']|["']$/g, '').trim();
    const explicitlyTypingQualified = /^(?:typing\.)/.test(t);
    if (t.includes('|')) {
        const parts = _splitTopLevelDelimiter(t, '|').map(s => s.trim())
            .filter(s => s && !['None', 'null', 'undefined'].includes(s));
        if (parts.length !== 1) return null;
        t = parts[0];
    }
    let m;
    // type-transparent wrappers (the value's runtime type is the argument)
    while ((m = t.match(/^(?:typing\.)?(Optional|Annotated|Final)\s*[[<]\s*(.+)\s*[\]>]$/s))) {
        t = (_splitTopLevelGenericArgs(m[2])[0] || '').trim(); // Annotated[X, meta] → X
    }
    if (opts.unwrapAsync) {
        m = t.match(/^(?:typing\.)?(Promise|Awaitable|Coroutine)\s*[[<]\s*(.*)\s*[\]>]$/s);
        if (m) {
            const args = _splitTopLevelGenericArgs(m[2]).map(s => s.trim());
            // Coroutine[Y, S, R] resolves to its RETURN (last) argument
            t = (m[1] === 'Coroutine' ? args[args.length - 1] : args[0]) || '';
        }
    }
    if (/\[\]$/.test(t)) return 'Array'; // TS Foo[] — the value is an array
    m = t.match(/^([\w$.]+)\s*[[<]/s);   // generic head: Foo<...> / dict[...]
    if (m) t = m[1];
    const last = t.split('.').pop();
    if (!/^[A-Za-z_$][\w$]*$/.test(last)) return null; // fn types, object literals, tuples
    // Python's typing aliases share ordinary identifier names with perfectly
    // valid project classes (`class Text` in rich; user-defined List/Set are
    // also legal). A global Text -> str rewrite is therefore exclusion-grade
    // misinformation. Explicit `typing.Text` is unambiguous; an unqualified
    // alias is normalized only when no project type with that name is
    // reachable from the annotation's defining file. TypeScript must never
    // receive Python alias normalization at all.
    const builtinAlias = _PY_TYPING_BUILTINS[last];
    if (!builtinAlias || (opts.language && opts.language !== 'python')) return last;
    if (explicitlyTypingQualified) return builtinAlias;
    if (opts.index) {
        const projectTypeDefs = (opts.index.symbols.get(last) || []).filter(d =>
            ['class', 'interface', 'type', 'trait', 'struct', 'record'].includes(d.type));
        if (projectTypeDefs.length > 0) {
            if (!opts.originFile) {
                if (projectTypeDefs.length === 1) return last;
            } else if (_resolveFlowTypeOrigin(opts.index, opts.originFile, last)) {
                return last;
            }
        }
    }
    return builtinAlias;
}

// Structural annotation heads that carry no receiver identity: TS escape
// hatches, the receiver-polymorphic `this`/`Self`, and Python's object root.
const _STRUCTURAL_FLOW_REJECT = new Set([
    'any', 'unknown', 'object', 'void', 'never', 'undefined', 'null',
    'this', 'Self', 'Object', 'None',
]);

// Small, stable stdlib contracts used only to type the value of a chained
// receiver. These are runtime identity facts, not guesses about user code.
function _builtinMethodReturnType(language, receiverType, methodName) {
    const owner = String(receiverType || '').split('.').pop();
    if (language === 'rust') {
        // std::ffi::OsStr/std::path::Path expose their textual view as
        // Cow<str>. Method lookup on that result dereferences to `str`, so a
        // chained `.find()`/`.split()` is definitively a platform call. The
        // project-shadow check at the call site runs before this contract.
        if (['OsStr', 'Path'].includes(owner) &&
            methodName === 'to_string_lossy') {
            return 'str';
        }
        return null;
    }
    if (language !== 'python') return null;
    if (methodName === 'getvalue') {
        if (owner === 'BytesIO') return 'bytes';
        if (owner === 'StringIO') return 'str';
    }
    if (owner === 'bytes' && methodName === 'decode') return 'str';
    if (owner === 'str' && methodName === 'encode') return 'bytes';
    if (['bytes', 'str'].includes(owner) &&
        ['capitalize', 'casefold', 'center', 'expandtabs', 'join',
            'ljust', 'lower', 'lstrip', 'removeprefix', 'removesuffix',
            'replace', 'rjust', 'rstrip', 'strip', 'swapcase', 'title',
            'translate', 'upper', 'zfill'].includes(methodName)) return owner;
    if (['list', 'dict', 'set'].includes(owner) && methodName === 'copy') return owner;
    return null;
}

/**
 * Type a chained receiver from its producer's declared return annotation
 * (fix #219): `parseAsync(args).catch(...)` — the receiver of .catch IS the
 * parseAsync(...) call, so its return annotation is compiler-true receiver
 * evidence. Method producers follow the #207 agreement discipline: EVERY
 * same-name method def project-wide must carry a return annotation and all
 * heads must agree (whichever class the producer dispatches to, the type is
 * the same). Plain producers follow #199's unique-project-def rule. Python
 * async producers type only AWAITED chains — the bare value is a coroutine,
 * not the annotation's type (TS annotations already SAY Promise, so they
 * type either way).
 */
/**
 * Nominal chained-receiver typing (fix #220, cobra-measured — #219's part 2
 * extended past the structural gate now that a family is measured):
 * `rootCmd.Flags().String(...)` — the producer's compiler-checked return
 * annotation types the receiver. Reuses the #207 rails verbatim: method
 * producers must AGREE project-wide, plain producers are same-package-only
 * for Go (an unqualified call cannot cross packages), package-qualified
 * producers resolve strictly through the file's imports
 * (_qualifiedProducerDefs), and the type NAME pins to its defining file from
 * the PRODUCER's scope (_resolveFlowTypeOrigin). External producer packages
 * and reject-set returns stay untyped — no evidence either way.
 */
function _nominalChainedReceiverType(index, call, fileEntry, filePath) {
    const language = fileEntry.language;
    const defs = (index.symbols.get(call.receiverCall) || [])
        .filter(d => !NON_CALLABLE_TYPES.has(d.type));
    let producer;
    if (call.receiverCallReceiver) {
        // Package-qualified producer: os.CreateTemp().Name(). A package that
        // resolves to no project def decided the type OUTSIDE the project —
        // external-flow marker (blocks single-owner confirmation, routes
        // possible-dispatch; never excludes).
        const cands = defs.filter(d => d.returnType);
        const inPkg = _qualifiedProducerDefs(index, fileEntry, call.receiverCallReceiver, cands);
        if (!inPkg || inPkg.length === 0 ||
            new Set(inPkg.map(d => d.returnType)).size !== 1) {
            return { externalVia: `${call.receiverCallReceiver}.${call.receiverCall}` };
        }
        producer = inPkg[0];
    } else if (call.receiverCallIsMethod) {
        // An untyped method receiver cannot borrow a return annotation by
        // terminal name alone. External owners are invisible to the project
        // index (`Map.Entry.getValue()` vs a unique project getValue()), so
        // project-wide agreement is not a closed world and is unsafe for
        // exclusion-grade receiver typing. The recursive fold handles method
        // producers when their own receiver is typed; otherwise stay unknown.
        return null;
    } else {
        // Plain producer: Go resolves within the package; others same-file
        // narrowing, then global-unique (#199/#207 rules). Where bare calls
        // reach methods (Java), a bare producer is this.getConfig() — the
        // enclosing class's own method wins.
        if (langTraits(language)?.bareCallReachesMethods) {
            const enclosing = index.findEnclosingFunction(filePath, call.line, true);
            if (enclosing?.className) {
                const sameClass = defs.find(d => d.className === enclosing.className && d.returnType);
                if (sameClass) {
                    const parsedSC = _returnTypeNameNominal(sameClass.returnType, language, {
                        selfClass: enclosing.className,
                    });
                    if (!parsedSC) return null;
                    const originSC = _resolveFlowTypeOrigin(index, sameClass.file || filePath, parsedSC.name, parsedSC.qualifier);
                    if (!originSC) return null;
                    return { type: parsedSC.name, ...(originSC.fromFile && { fromFile: originSC.fromFile }) };
                }
            }
        }
        const cands = defs.filter(d => !(d.className || d.receiver));
        let chosen = null;
        if (langTraits(language)?.packageScope === 'directory') {
            const dir = path.dirname(filePath);
            const samePkg = cands.filter(d => d.file && path.dirname(d.file) === dir);
            if (samePkg.length === 1) chosen = samePkg[0];
        } else if (cands.length === 1) {
            chosen = cands[0];
        } else {
            const sameFile = cands.filter(d => d.file === filePath);
            if (sameFile.length === 1) chosen = sameFile[0];
        }
        if (!chosen || !chosen.returnType) return null;
        producer = chosen;
    }
    const selfClass = producer.className || (producer.receiver || '').replace(/^\*/, '') || undefined;
    if (language === 'cpp') {
        const concrete = _cppAutoReturnConcreteType(index, producer);
        if (concrete) {
            const origin = _resolveFlowTypeOrigin(
                index, producer.file || filePath, concrete);
            if (origin) {
                return {
                    type: concrete,
                    ...(origin.fromFile && { fromFile: origin.fromFile }),
                };
            }
        }
    }
    const parsed = _returnTypeNameNominal(producer.returnType, language, { selfClass });
    if (!parsed) return null;
    const origin = _resolveFlowTypeOrigin(index, producer.file || filePath, parsed.name, parsed.qualifier);
    if (!origin) return null;
    return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
}

function _chainedReceiverType(index, call, language) {
    const defs = (index.symbols.get(call.receiverCall) || [])
        .filter(d => !NON_CALLABLE_TYPES.has(d.type));
    let producers;
    if (call.receiverCallIsMethod) {
        producers = defs.filter(d => d.className);
        if (producers.length === 0) return null;
        if (!producers.every(d => d.returnType)) return null;
    } else {
        if (defs.length !== 1 || !defs[0].returnType) return null;
        producers = defs;
    }
    if (language === 'python' && !call.receiverCallAwaited &&
        producers.some(d => d.isAsync)) return null;
    const heads = new Set();
    const origins = new Set();
    for (const d of producers) {
        const h = _structuralTypeHead(d.returnType, {
            unwrapAsync: call.receiverCallAwaited, index, language, originFile: d.file,
        });
        if (!h) return null;
        heads.add(h);
        if (heads.size > 1) return null;
        const typeDefs = (index.symbols.get(h) || []).filter(td => IDENTITY_TYPE_KINDS.has(td.type));
        if (typeDefs.length > 0) {
            const origin = _resolveFlowTypeOrigin(index, d.file, h);
            if (!origin) return null;
            origins.add(origin.fromFile);
            if (origins.size > 1) return null;
        }
    }
    const head = [...heads][0];
    if (/^[A-Z][A-Z0-9]?$/.test(head)) return null; // generic type param (T, K, V1)
    if (_STRUCTURAL_FLOW_REJECT.has(head)) return null;
    const fromFile = origins.size === 1 ? [...origins][0] : undefined;
    return { type: head, ...(fromFile && { fromFile }) };
}

// ── Chained-receiver fold (fix #258, clap-measured) ─────────────────────────
// Builder chains (`Command::new("x").author(a).arg(b).arg(c)`) defeat the
// one-hop agreement rules: `arg` has two owners (Command and ArgGroup), both
// returning `Self` — which resolves to DIFFERENT types, so project-wide
// agreement fails and 1600+ oracle-true clap edges sat method-ambiguous.
// The fold types the chain hop by hop from a typed root instead: the parser
// links each chained call to its producer's OWN record (receiverCallLine),
// the root types via the existing #207 producer rails (path/static/package-
// qualified producers, annotated variables, module-qualified roots), and each
// hop resolves the producer method ON THE CURRENT TYPE — `Self`/`this` map to
// that type, a hop returning a different type re-roots the chain there, and
// any unresolvable hop (missing annotation, foreign same-name type, sibling
// disagreement) stops the fold: untyped, visible, honest. Per-hop identity
// keeps the #206/#207 discipline (owner defs co-located with the pinned type
// when the type name is ambiguous project-wide; origins re-pinned from the
// defining file). Results feed the existing receiverType machinery — the
// fold adds evidence, never new routing.

const _FOLD_TYPE_KINDS = new Set(['class', 'struct', 'enum', 'trait', 'interface', 'record', 'type', 'namespace']);

/**
 * Resolve method `methodName` on type `typeName` (identity-pinned to
 * `fromFile` when known) and return its resolved return-type head as
 * { type, fromFile } — or null when the resolution is not compiler-grade.
 * Walks declared ancestors (bounded) when the type itself doesn't define the
 * method; `Self`/`this` return annotations resolve to the RECEIVER's type
 * (dynamic-Self semantics — sound because the chain's static type is T).
 */
function _methodReturnOnType(index, typeName, fromFile, methodName, language, opts = {}) {
    const nominal = langTraits(language)?.typeSystem === 'nominal';
    const norm = s => (s || '').replace(/^\*/, '').replace(/\[.*$/, '').replace(/<.*$/, '');
    const depth = opts.depth || 0;
    if (depth > 8) return null;
    const all = (index.symbols.get(methodName) || [])
        .filter(d => !NON_CALLABLE_TYPES.has(d.type));
    let owned = all.filter(d =>
        (d.className && norm(d.className) === typeName) ||
        (!d.className && d.receiver && norm(d.receiver) === typeName));
    // Identity discipline (#206c): with several same-name TYPES in the
    // project, an owner-name match is only THE type when co-located with the
    // pinned defining file; with no pin, refuse.
    const typeDefs = (index.symbols.get(typeName) || []).filter(d => _FOLD_TYPE_KINDS.has(d.type));
    if (typeDefs.length > 1 && owned.length > 0) {
        if (!fromFile) return null;
        const dir = path.dirname(fromFile);
        owned = owned.filter(d => d.file === fromFile || (d.file && path.dirname(d.file) === dir));
    }
    if (owned.length === 0) {
        // Inheritance walk: resolve on a declared ancestor; Self/this still
        // resolve to the RECEIVER's type (passed through selfType).
        const ctxFile = fromFile || opts.filePath;
        const parents = index._getInheritanceParents
            ? (index._getInheritanceParents(typeName, ctxFile) || []) : [];
        for (const parent of parents) {
            const pFile = index._resolveClassFile
                ? (index._resolveClassFile(parent, ctxFile) || undefined) : undefined;
            const up = _methodReturnOnType(index, norm(parent), pFile, methodName, language, {
                ...opts, depth: depth + 1, selfType: opts.selfType || typeName,
            });
            if (up) return up;
        }
        return null;
    }
    const selfType = opts.selfType || typeName;
    if (nominal) {
        if (!owned.every(d => d.returnType)) return null;
        if (new Set(owned.map(d => d.returnType)).size !== 1) return null;
        const def = owned[0];
        const parsed = _returnTypeNameNominal(def.returnType, language, { selfClass: selfType });
        if (!parsed) return null;
        const origin = _resolveFlowTypeOrigin(index, def.file || opts.filePath, parsed.name, parsed.qualifier);
        if (!origin) return null;
        return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
    }
    // Structural: heads must agree; `this`/`Self` are the receiver's type
    // (checked BEFORE the reject set — with a known owner they ARE identity);
    // un-awaited async producers stay untyped (the value is a coroutine).
    if (language === 'python' && !opts.consumerAwaited && owned.some(d => d.isAsync)) return null;
    const heads = new Set();
    for (const d of owned) {
        if (!d.returnType) return null;
        let h = _structuralTypeHead(d.returnType, {
            unwrapAsync: opts.consumerAwaited, index, language, originFile: d.file,
        });
        if (h === 'this' || h === 'Self') h = selfType;
        if (!h) return null;
        heads.add(h);
        if (heads.size > 1) return null;
    }
    const head = [...heads][0];
    if (/^[A-Z][A-Z0-9]?$/.test(head)) return null; // generic type param
    if (_STRUCTURAL_FLOW_REJECT.has(head)) return null;
    const returnTypeDefs = (index.symbols.get(head) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
    if (returnTypeDefs.length > 0) {
        const origins = new Set();
        for (const d of owned) {
            const origin = _resolveFlowTypeOrigin(index, d.file || opts.filePath, head);
            if (!origin) return null;
            origins.add(origin.fromFile);
            if (origins.size > 1) return null;
        }
        const fromFile = [...origins][0];
        return { type: head, ...(fromFile && { fromFile }) };
    }
    return { type: head };
}

function _rustMacroDefinitions(index, fileEntry, filePath, record) {
    const definitions = (index.symbols.get(record.name) || [])
        .filter(definition => definition.type === 'macro');
    if (definitions.length === 0) return [];

    // A local macro_rules! declaration shadows imported/exported macros with
    // the same spelling. Keep every same-file definition so cfg alternatives
    // must still agree below.
    const local = definitions.filter(definition => definition.file === filePath);
    if (local.length > 0) return local;

    const starts = new Set();
    if (record.receiver) {
        const receiver = String(record.receiver).replace(/^\$crate$/, 'crate');
        const resolved = resolveRustImport(
            `${receiver}::${record.name}`, filePath, index.root);
        if (resolved) starts.add(resolved);
    } else {
        for (const binding of (fileEntry.importBindings || [])) {
            if (binding.name !== record.name && binding.alias !== record.name) continue;
            const rel = fileEntry.moduleResolved?.[binding.module];
            if (rel) {
                starts.add(path.isAbsolute(rel) ? rel : path.join(index.root, rel));
                continue;
            }
            const resolved = resolveRustImport(
                String(binding.module), filePath, index.root);
            if (resolved) starts.add(resolved);
        }
    }
    if (starts.size === 0) return [];
    return definitions.filter(definition => [...starts].some(start =>
        start === definition.file ||
        _importReaches(index, start, new Set([definition.file]))));
}

/**
 * Type a Rust macro invocation from its indexed transcriber contract. Parser
 * inference only annotates macros whose final expression is a uniquely typed
 * constructor/builder value. Every reachable non-diverging definition must
 * agree; cfg alternatives ending in compile_error! cannot produce a value.
 */
function _rustMacroCallResultType(index, fileEntry, filePath, record) {
    if (fileEntry.language !== 'rust') return null;
    const definitions = _rustMacroDefinitions(index, fileEntry, filePath, record);
    if (definitions.length === 0) return null;
    if (definitions.some(definition =>
        !definition.returnType && !definition.macroNeverReturns)) {
        return null;
    }
    const productive = definitions.filter(definition => definition.returnType);
    if (productive.length === 0 ||
        new Set(productive.map(definition => definition.returnType)).size !== 1) {
        return null;
    }
    const origins = [];
    for (const definition of productive) {
        const origin = _resolveFlowTypeOrigin(
            index,
            definition.file || filePath,
            definition.returnType,
            definition.returnTypeQualifier);
        if (!origin?.fromFile) return null;
        origins.push(origin.fromFile);
    }
    if (new Set(origins).size !== 1) return null;
    return { type: productive[0].returnType, fromFile: origins[0] };
}

function _rustPathIsKnownExternal(index, fileEntry, filePath, receiver, name) {
    const segments = String(receiver || '').split('::').filter(Boolean);
    if (!['std', 'core', 'alloc'].includes(segments[0])) return false;
    const root = segments[0];
    const localModule = (index.symbols.get(root) || []).some(definition =>
        definition.file === filePath && definition.type === 'module');
    const rebound = (fileEntry.importBindings || []).some(binding =>
        binding.alias === root && fileEntry.moduleResolved?.[binding.module]);
    if (localModule || rebound) return false;
    return !resolveRustImport(
        `${segments.join('::')}::${name}`, filePath, index.root);
}

function _rustPatternReceiverType(index, fileEntry, filePath, record) {
    let variants = (index.symbols.get(record.receiverPatternVariant) || [])
        .filter(definition => definition.type === 'variant');
    if (record.receiverPatternOwner) {
        const owner = String(record.receiverPatternOwner).split('::').pop();
        variants = variants.filter(definition => definition.className === owner);
    }
    if (variants.length > 1) {
        const sameFile = variants.filter(definition => definition.file === filePath);
        if (sameFile.length > 0) variants = sameFile;
    }
    if (variants.length > 1) {
        const sameDir = variants.filter(definition =>
            definition.file && path.dirname(definition.file) === path.dirname(filePath));
        if (sameDir.length > 0) variants = sameDir;
    }
    if (variants.length > 1) {
        const imports = index.importGraph.get(filePath) || new Set();
        const imported = variants.filter(definition =>
            definition.file && (imports.has(definition.file) ||
                _importReaches(index, filePath, new Set([definition.file]))));
        if (imported.length > 0) variants = imported;
    }
    let raw;
    let originFile = filePath;
    if (variants.length === 1 && variants[0].params) {
        const payloads = _splitTopLevelGenericArgs(variants[0].params);
        raw = payloads[record.receiverPatternIndex || 0]?.trim();
        originFile = variants[0].file || filePath;
    } else if (record.receiverPatternSourceType &&
        ['Ok', 'Err', 'Some'].includes(record.receiverPatternVariant)) {
        const source = String(record.receiverPatternSourceType).trim();
        const match = source.match(
            /^(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*(Option|Result)\s*<(.*)>$/s);
        if (match) {
            const args = _splitTopLevelGenericArgs(match[2]);
            const indexForVariant = record.receiverPatternVariant === 'Err' ? 1 : 0;
            raw = args[indexForVariant]?.trim();
        }
    }
    if (!raw) return null;
    const type = _normalizeFieldTypeName(raw, 'rust');
    if (!type || /^[A-Z][A-Z0-9]?$/.test(type)) return null;

    const stripped = raw.replace(/^&(?:\s*'\w+)?\s*/, '')
        .replace(/^mut\s+/, '').trim();
    const scoped = stripped.match(
        /^(.*)::([A-Za-z_][A-Za-z0-9_]*)(?:\s*<.*>)?$/s);
    const qualifier = scoped && scoped[2] === type ? scoped[1] : undefined;
    const origin = _resolveFlowTypeOrigin(
        index, originFile, type, qualifier);
    if (origin?.fromFile) return { type, fromFile: origin.fromFile };

    if (qualifier) {
        const resolved = resolveRustImport(
            `${qualifier}::${type}`, originFile, index.root);
        const first = qualifier.split('::')[0];
        const qualifierBinding = (fileEntry.importBindings || []).find(binding =>
            binding.name === first || binding.alias === first);
        const bindingModule = String(qualifierBinding?.module || '');
        const projectish = ['crate', 'self', 'super'].includes(first) ||
            _projectTopLevelNames(index).has(first) ||
            !!fileEntry.moduleResolved?.[qualifierBinding?.module];
        const platformBinding = /^(?:std|core|alloc)(?:::|$)/.test(bindingModule);
        if (!resolved && !projectish) {
            if (platformBinding || !qualifierBinding ||
                !bindingModule.startsWith('crate::')) {
                return {
                    externalVia: `${qualifier}::${type}`,
                    // A non-generic external payload cannot return a
                    // downstream project type from one of its inherent
                    // methods. Preserve that dependency-direction proof
                    // through chained receivers; generic payloads abstain
                    // because their type arguments may be project-owned.
                    ...(!stripped.includes('<') && {
                        externalConcrete: true,
                    }),
                };
            }
        }
    }
    return null;
}

const _RUST_ITERATOR_ITEM_CALLBACKS = new Set([
    'all', 'any', 'filter', 'filter_map', 'find', 'find_map', 'for_each',
    'inspect', 'map', 'map_while', 'position', 'skip_while', 'take_while',
]);

function _rustRecordReceiverType(index, fileEntry, filePath, record, ctx) {
    if (record.receiverType && !record.receiverIsChainRoot) {
        const origin = _resolveFlowTypeOrigin(
            index, filePath, record.receiverType, record.receiverTypeQualifier);
        if (origin?.fromFile) {
            return { type: record.receiverType, fromFile: origin.fromFile };
        }
    }
    if (record.receiverField) {
        let rootType = record.receiverRootType;
        if (!rootType && record.receiverRoot) {
            rootType = _lookupReturnTypeFlow(ctx.getFlowMap(), {
                ...record,
                receiver: record.receiverRoot,
            })?.type;
        }
        const fieldType = rootType && _declaredFieldType(
            index, rootType, record.receiverField, 'rust');
        if (fieldType) return { type: fieldType };
    }
    if (record.receiverCall) {
        const folded = _foldChainedReceiverType(
            index, fileEntry, filePath, record, ctx);
        if (folded?.type) return folded;
        if (folded?.externalVia) return folded;
    }
    if (record.receiverPatternVariant) {
        const pattern = _rustPatternReceiverType(
            index, fileEntry, filePath, record);
        if (pattern) return pattern;
    }
    if (record.receiver && !record.receiverIsChainRoot &&
        !record.receiverPatternShadow) {
        const flow = _lookupReturnTypeFlow(ctx.getFlowMap(), record);
        if (flow?.type) return {
            type: flow.type,
            ...(flow.fromFile && { fromFile: flow.fromFile }),
        };
    }
    if (record.isPathCall && record.receiver) {
        const segments = String(record.receiver).split('::').filter(Boolean);
        let type = segments.pop();
        if (type === 'Self') {
            type = index.findEnclosingFunction(filePath, record.line, true)?.className;
        }
        if (type) {
            const qualifier = segments.length > 0 ? segments.join('::') : undefined;
            const origin = _resolveFlowTypeOrigin(index, filePath, type, qualifier);
            if (origin?.fromFile) return { type, fromFile: origin.fromFile };
        }
    }
    return null;
}

function _rustDeclaredIteratorItemType(index, fileEntry, filePath, producer, ctx) {
    if (producer.receiverIteratorItemType) {
        const origin = _resolveFlowTypeOrigin(
            index, filePath, producer.receiverIteratorItemType);
        if (origin?.fromFile) {
            return {
                type: producer.receiverIteratorItemType,
                fromFile: origin.fromFile,
            };
        }
    }
    const owner = _rustRecordReceiverType(
        index, fileEntry, filePath, producer, ctx);
    if (!owner?.type) return null;
    let definitions = (index.symbols.get(producer.name) || []).filter(definition =>
        !NON_CALLABLE_TYPES.has(definition.type) &&
        String(definition.className || definition.receiver || '')
            .replace(/^[*&]\s*/, '').replace(/<.*$/, '').trim() === owner.type);
    if (owner.fromFile) {
        const typeDefinitions = (index.symbols.get(owner.type) || [])
            .filter(definition => _FOLD_TYPE_KINDS.has(definition.type));
        if (typeDefinitions.length > 1) {
            const dir = path.dirname(owner.fromFile);
            definitions = definitions.filter(definition =>
                definition.file === owner.fromFile ||
                path.dirname(definition.file) === dir);
        }
    }
    if (definitions.length === 0 ||
        definitions.some(definition => !definition.iteratorItemType)) return null;
    const items = [];
    for (const definition of definitions) {
        const type = definition.iteratorItemType;
        const origin = _resolveFlowTypeOrigin(
            index, definition.file || filePath, type);
        if (!origin?.fromFile) return null;
        items.push({ type, fromFile: origin.fromFile });
    }
    if (new Set(items.map(item => item.type)).size !== 1 ||
        new Set(items.map(item => item.fromFile)).size !== 1) return null;
    return items[0];
}

/**
 * Standard Iterator adapters derive their closure parameter from the
 * producer's compiler-declared associated `Item` type. This is not a
 * name-based guess: the exact chained producer and owner are resolved first,
 * every applicable declaration must agree, and the item identity is pinned
 * from the declaring file.
 */
function _rustIteratorClosureParameterType(index, fileEntry, filePath, source, closure, ctx) {
    if (!_RUST_ITERATOR_ITEM_CALLBACKS.has(source.name) ||
        closure.closureArgumentIndex !== 0) return null;
    let producers = _chainedProducerRecords(ctx, source);
    if (producers.length === 0 && source.receiverIteratorItemType) {
        producers = [source];
    }
    if (producers.length === 0) return null;
    const items = [];
    for (const producer of producers) {
        const item = _rustDeclaredIteratorItemType(
            index, fileEntry, filePath, producer, ctx);
        if (!item) return null;
        items.push(item);
    }
    if (items.length === 0 ||
        new Set(items.map(item => item.type)).size !== 1 ||
        new Set(items.map(item => item.fromFile)).size !== 1) return null;
    return items[0];
}

const _RUST_ITERATOR_ITEM_PRESERVING = new Set([
    'by_ref', 'cycle', 'filter', 'fuse', 'inspect', 'peekable', 'rev',
    'skip', 'skip_while', 'step_by', 'take', 'take_while',
]);

function _rustIteratorOutputItemType(index, fileEntry, filePath, source, ctx, visiting = new Set()) {
    if (!source || visiting.has(source)) return null;
    visiting.add(source);
    const direct = _rustDeclaredIteratorItemType(
        index, fileEntry, filePath, source, ctx);
    if (direct) {
        visiting.delete(source);
        return direct;
    }
    if (!_RUST_ITERATOR_ITEM_PRESERVING.has(source.name) || !source.receiverCall) {
        visiting.delete(source);
        return null;
    }
    const producers = _chainedProducerRecords(ctx, source);
    const items = producers.map(producer =>
        _rustIteratorOutputItemType(
            index, fileEntry, filePath, producer, ctx, visiting));
    visiting.delete(source);
    if (items.length === 0 || items.some(item => !item) ||
        new Set(items.map(item => item.type)).size !== 1 ||
        new Set(items.map(item => item.fromFile)).size !== 1) return null;
    return items[0];
}

function _rustClosureReceiverType(index, fileEntry, filePath, call, ctx) {
    if (fileEntry.language !== 'rust' || !call.receiver) return null;
    const closure = call.enclosingFunction;
    const parameterIndex = closure?.closureParameterNames?.indexOf(call.receiver);
    if (parameterIndex == null || parameterIndex < 0 ||
        !closure.closureSourceCall ||
        closure.closureSourceCallStart == null ||
        closure.closureSourceCallEnd == null) {
        return null;
    }
    const sourceRecords = ctx.records.filter(record =>
        record.name === closure.closureSourceCall &&
        record.callStart === closure.closureSourceCallStart &&
        record.callEnd === closure.closureSourceCallEnd &&
        !!record.isMethod === !!closure.closureSourceCallIsMethod);
    if (sourceRecords.length !== 1) return null;
    const source = sourceRecords[0];
    const iteratorParameter = _rustIteratorClosureParameterType(
        index, fileEntry, filePath, source, closure, ctx);
    if (iteratorParameter) return iteratorParameter;

    // Standard collection callbacks derive their parameter type from the
    // concrete collection item selected by `collect::<Collection<Item>>()`.
    // `sort_by` receives two references to that same Item. The turbofish and
    // assignment are compiler-checked; an absent/ambiguous item stays visible.
    if (source.name === 'sort_by' && parameterIndex < 2 && source.receiver) {
        const flow = _lookupReturnTypeFlow(ctx.getFlowMap(), source);
        let itemType = flow?.iteratorItemType;
        let itemFromFile = flow?.iteratorItemFromFile;
        if (!itemType) {
            const sameScope = record =>
                record.enclosingFunction?.startLine ===
                source.enclosingFunction?.startLine;
            const preceding = ctx.records.filter(record =>
                record.assignedTo === source.receiver &&
                record.explicitResultItemType &&
                sameScope(record) &&
                (record.line < source.line ||
                 (record.line === source.line &&
                  record.callStart < source.callStart)))
                .sort((a, b) => b.line - a.line ||
                    (b.callStart || 0) - (a.callStart || 0));
            if (preceding.length > 0) {
                itemType = preceding[0].explicitResultItemType;
                itemFromFile = _resolveFlowTypeOrigin(
                    index, filePath, itemType)?.fromFile;
            }
        }
        if (itemType && itemFromFile) {
            return {
                type: itemType,
                fromFile: itemFromFile,
            };
        }
    }

    let receiver = null;
    const sourceFlow = source.receiver
        ? _lookupReturnTypeFlow(ctx.getFlowMap(), source)
        : null;
    if (sourceFlow?.type) {
        receiver = {
            type: sourceFlow.type,
            ...(sourceFlow.fromFile && { fromFile: sourceFlow.fromFile }),
        };
    }
    if (!receiver && source.receiverType && !source.receiverIsChainRoot) {
        const origin = _resolveFlowTypeOrigin(
            index, filePath, source.receiverType, source.receiverTypeQualifier);
        if (origin?.fromFile) {
            receiver = { type: source.receiverType, fromFile: origin.fromFile };
        }
    }
    if (!receiver && source.receiverCall) {
        receiver = _foldChainedReceiverType(
            index, fileEntry, filePath, source, ctx);
    }
    if ((!receiver || !receiver.type) && source.receiver &&
        !source.receiverIsChainRoot && !source.receiverPatternShadow) {
        const flow = _lookupReturnTypeFlow(ctx.getFlowMap(), source);
        if (flow?.type) receiver = {
            type: flow.type,
            ...(flow.fromFile && { fromFile: flow.fromFile }),
        };
    }
    if (!receiver?.type) return null;

    const norm = value => String(value || '')
        .replace(/^[*&]\s*/, '').replace(/<.*$/, '').trim();
    let definitions = (index.symbols.get(source.name) || []).filter(definition =>
        !NON_CALLABLE_TYPES.has(definition.type) &&
        norm(definition.className || definition.receiver) === receiver.type &&
        definition.callbackParamTypes);
    const typeDefinitions = (index.symbols.get(receiver.type) || [])
        .filter(definition => _FOLD_TYPE_KINDS.has(definition.type));
    if (typeDefinitions.length > 1) {
        if (!receiver.fromFile) return null;
        const dir = path.dirname(receiver.fromFile);
        definitions = definitions.filter(definition =>
            definition.file === receiver.fromFile ||
            path.dirname(definition.file) === dir);
    }
    if (definitions.length === 0) return null;

    const callbackTypes = [];
    for (const definition of definitions) {
        const list = definition.callbackParamTypes[
            closure.closureArgumentIndex];
        const type = list && list[parameterIndex];
        if (!type) return null;
        callbackTypes.push({ definition, type: type === 'Self' ? receiver.type : type });
    }
    if (new Set(callbackTypes.map(item => item.type)).size !== 1) return null;
    const origins = [];
    for (const item of callbackTypes) {
        const origin = _resolveFlowTypeOrigin(
            index, item.definition.file || filePath, item.type);
        if (!origin?.fromFile) return null;
        origins.push(origin.fromFile);
    }
    if (new Set(origins).size !== 1) return null;
    return { type: callbackTypes[0].type, fromFile: origins[0] };
}

/**
 * Type of the VALUE a call record produces — { type, fromFile },
 * { externalVia } (compiler-grade evidence the value was typed outside the
 * project), or null. Mirrors the #207 flow-map producer rails per shape, and
 * recurses through the producer link for chained producers (memoized,
 * cycle-guarded).
 */
function _typeOfCallResultFold(index, fileEntry, filePath, record, ctx, consumerAwaited) {
    if (ctx.memo.has(record)) return ctx.memo.get(record);
    // Real builder APIs routinely exceed 64 hops (clap's benchmark command
    // has ~160). Keep a generous hard safety bound. A cycle/depth refusal is
    // CONTEXTUAL (it depends on the visiting path), so any null whose subtree
    // tripped the bound must not be cached — caching it poisoned shorter
    // suffix queries later in the same operation. A null with NO trip in its
    // subtree is universal (the producer shape is untypeable regardless of
    // path) and IS cached: without that, an untypeable chain re-walks its
    // whole producer prefix per consumer (clap `unwrap`: 76s -> linear).
    if (ctx.visiting.has(record) || ctx.visiting.size > 256) {
        ctx.foldTrips = (ctx.foldTrips || 0) + 1;
        return null;
    }
    ctx.visiting.add(record);
    const tripsBefore = ctx.foldTrips || 0;
    let out;
    try {
        out = _typeOfCallResultFoldInner(index, fileEntry, filePath, record, ctx, consumerAwaited);
    } finally {
        ctx.visiting.delete(record);
    }
    if (out || (ctx.foldTrips || 0) === tripsBefore) ctx.memo.set(record, out ?? null);
    return out;
}

function _typeOfCallResultFoldInner(index, fileEntry, filePath, record, ctx, consumerAwaited) {
    const language = fileEntry.language;
    const traits = langTraits(language);
    const nominal = traits?.typeSystem === 'nominal';
    const name = record.name;

    if (record.isMacro) {
        return _rustMacroCallResultType(index, fileEntry, filePath, record);
    }

    // Path producer (Rust): Command::new(...) — the last path segment names
    // the impl type (flow-map rails: module-path producers stay untyped);
    // Self::new() resolves through the enclosing impl. The type's identity
    // is pinned from THIS file's scope (#206 discipline — clap's derive
    // tests define dozens of local `struct Command` fixtures; the pin keeps
    // the fold on the imported one).
    if (nominal && record.isPathCall && record.receiver) {
        if (language === 'rust' &&
            _rustPathIsKnownExternal(index, fileEntry, filePath, record.receiver, name)) {
            return {
                externalVia: `${record.receiver}::${name}`,
                externalConcrete: true,
            };
        }
        const segs = String(record.receiver).split('::');
        let seg = segs.pop();
        if (seg === 'Self') {
            const enclosing = index.findEnclosingFunction(filePath, record.line, true);
            seg = enclosing && enclosing.className;
            if (!seg) return null;
        }
        if (!seg || !/^[A-Z]/.test(seg)) return null;
        if (/^[A-Z][A-Z0-9]?$/.test(seg)) return null; // generic-param convention (#220)
        const qual = segs.length > 0 ? segs.join('::') : undefined;
        const origin = _resolveFlowTypeOrigin(index, filePath, seg, qual);
        if (!origin) return null;
        return _methodReturnOnType(index, seg, origin.fromFile, name, language,
            { filePath, consumerAwaited });
    }
    // Java static factory: Config.parse(...) — static call style only (#206:
    // a Go receiver named like a type is a VARIABLE).
    if (nominal && record.isMethod && record.receiver && !record.receiverIsChainRoot &&
        traits?.typeQualifiedCallStyle === 'static' && /^[A-Z]/.test(record.receiver) &&
        !/^[A-Z][A-Z0-9]?$/.test(record.receiver)) {
        const r = _methodReturnOnType(index, record.receiver, undefined, name, language,
            { filePath, consumerAwaited });
        if (r) return r;
        // fall through: a capitalized Java receiver may still be a variable
    }
    // Go package-qualified plain producer: pkg.Get(...) — strict import
    // resolution; unresolved packages typed the value OUTSIDE the project.
    if (nominal && !record.isMethod && record.receiver && traits?.hasReceiverPackageCalls) {
        const cands = (index.symbols.get(name) || [])
            .filter(d => !NON_CALLABLE_TYPES.has(d.type) && d.returnType);
        const inPkg = _qualifiedProducerDefs(index, fileEntry, record.receiver, cands);
        if (!inPkg || inPkg.length === 0 || new Set(inPkg.map(d => d.returnType)).size !== 1) {
            return {
                externalVia: `${record.receiver}.${name}`,
                ...(getLanguageAdapter(language)?.isPlatformConcreteCall?.(
                    record.receiver, name) && { externalConcrete: true }),
            };
        }
        const def = inPkg[0];
        const parsed = _returnTypeNameNominal(def.returnType, language, {});
        if (!parsed) return null;
        const origin = _resolveFlowTypeOrigin(index, def.file || filePath, parsed.name, parsed.qualifier);
        if (!origin) return null;
        return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
    }
    // Structural module-qualified producer: z.string() — resolve through the
    // file's import bindings (flow-map rails, incl. the #222 externality test).
    if (!nominal && record.isMethod &&
        (record.receiver || record.receiverModuleSpecifier) &&
        (record.receiverIsModule || _isStructuralImportReceiver(fileEntry, record))) {
        const binding = _structuralModuleBindings(fileEntry, record)[0];
        const rel = binding && fileEntry.moduleResolved && fileEntry.moduleResolved[binding.module];
        if (binding && !rel) {
            const mod = String(binding.module);
            const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
            if (!mod.startsWith('.') &&
                !(firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                return {
                    externalVia: `${record.receiver}.${name}`,
                    ...(/^[A-Z]/.test(name) && { externalConcrete: true }),
                };
            }
            return null;
        }
        if (!rel) return null;
        const modFile = path.join(index.root, rel);
        const cands = (index.symbols.get(name) || [])
            .filter(d => !NON_CALLABLE_TYPES.has(d.type) && d.returnType && !d.className);
        let matches = cands.filter(d => d.file === modFile);
        // A named/default import may itself be an exported namespace object
        // (`import { z } from 'zod/v3'; z.string()`). Resolve the producer
        // name through that exact namespace identity before the older
        // one-hop barrel fallback. Exported callable-alias symbols then carry
        // the captured class member's declared return type into the chain.
        if (matches.length === 0) {
            matches = cands.filter(definition =>
                _importedNamespaceMemberOwnership(
                    index, fileEntry, record, new Set([definition.file]))?.verdict === 'yes');
        }
        if (matches.length === 0) {
            const hop = index.importGraph.get(modFile);
            if (hop) matches = cands.filter(d => hop.has(d.file));
        }
        if (matches.length === 0) return null;
        if (language === 'python' && !consumerAwaited && matches.some(d => d.isAsync)) return null;
        const heads = new Set();
        for (const d of matches) {
            const h = _structuralTypeHead(d.returnType, {
                unwrapAsync: consumerAwaited, index, language, originFile: d.file,
            });
            if (!h) return null;
            heads.add(h);
        }
        if (heads.size !== 1) return null;
        const head = [...heads][0];
        if (/^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
        const origins = new Set();
        const typeDefs = (index.symbols.get(head) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
        if (typeDefs.length > 0) {
            for (const d of matches) {
                const origin = _resolveFlowTypeOrigin(index, d.file || filePath, head);
                if (!origin) return null;
                origins.add(origin.fromFile);
                if (origins.size > 1) return null;
            }
        }
        const fromFile = origins.size === 1 ? [...origins][0] : undefined;
        return { type: head, ...(fromFile && { fromFile }) };
    }
    // self/this/cls receiver: resolve through the enclosing class (+ walk).
    if (record.isMethod && ['self', 'this', 'cls'].includes(record.receiver)) {
        const enclosing = index.findEnclosingFunction(filePath, record.line, true);
        let cls = enclosing && enclosing.className;
        let ctxFile = filePath;
        const visited = new Set();
        while (cls && !visited.has(cls)) {
            visited.add(cls);
            const r = _methodReturnOnType(index, cls, ctxFile, name, language,
                { filePath, consumerAwaited, selfType: enclosing.className });
            if (r) return r;
            const parents = index._getInheritanceParents(cls, ctxFile) || [];
            const next = parents[0];
            if (next && index._resolveClassFile) {
                ctxFile = index._resolveClassFile(next, ctxFile) || ctxFile;
            }
            cls = next;
        }
        return null;
    }
    // Method producer: type its OWN receiver (parser annotation → chain
    // recursion → flow map), then resolve the method on that type. Falls back
    // to the one-hop project-wide agreement rule when the receiver stays
    // untyped.
    if (record.isMethod) {
        let rt = null;
        if (record.receiverType && !record.receiverIsChainRoot) {
            const origin = nominal
                ? _resolveFlowTypeOrigin(index, filePath, record.receiverType,
                    record.receiverTypeQualifier)
                : null;
            rt = {
                type: record.receiverType,
                ...(origin?.fromFile && { fromFile: origin.fromFile }),
            };
        }
        if (!rt && record.receiverField && record.receiverRoot) {
            let rootType = record.receiverRootType;
            let rootFromFile;
            if (!rootType) {
                const flowMap = ctx.getFlowMap();
                const rootFlow = flowMap && _lookupReturnTypeFlow(flowMap, {
                    ...record,
                    receiver: record.receiverRoot,
                });
                if (rootFlow?.externalVia) {
                    return { externalVia: rootFlow.externalVia };
                }
                rootType = rootFlow?.type;
                rootFromFile = rootFlow?.fromFile;
            }
            if (rootType) {
                const fieldInfo = {};
                const fieldType = _declaredFieldPathType(
                    index, rootType,
                    record.receiverFields || [record.receiverField],
                    language, fieldInfo, record.receiverRootNamespace);
                if (fieldType) {
                    rt = {
                        type: fieldType,
                        ...(fieldInfo.fromFile && {
                            fromFile: fieldInfo.fromFile,
                        }),
                        ...(!fieldInfo.fromFile && rootFromFile && {
                            fromFile: rootFromFile,
                        }),
                    };
                } else if (fieldInfo.externalVia) {
                    return {
                        externalVia: fieldInfo.externalVia,
                        ...(fieldInfo.externalConcrete && {
                            externalConcrete: true,
                        }),
                    };
                }
            }
        }
        if (!rt && record.receiverCall && (!record.receiver || record.receiverIsChainRoot)) {
            rt = _foldChainedReceiverType(index, fileEntry, filePath, record, ctx);
        }
        if (!rt && language === 'rust') {
            rt = _rustRecordReceiverType(
                index, fileEntry, filePath, record, ctx);
        }
        if (!rt && record.receiver && !record.receiverIsChainRoot &&
            !record.receiverPatternShadow) {
            const flowMap = ctx.getFlowMap();
            const fe = flowMap && _lookupReturnTypeFlow(flowMap, record);
            if (fe && fe.externalVia) return { externalVia: fe.externalVia };
            if (fe && fe.type) rt = { type: fe.type, ...(fe.fromFile && { fromFile: fe.fromFile }) };
        }
        if (rt && rt.externalVia) return rt;
        if (rt && rt.type) {
            // Stdlib return contracts apply only when no project type shadows
            // the name (#232 shadowing rule): a project class named StringIO
            // keeps its own annotations authoritative.
            const projectShadow = (index.symbols.get(
                String(rt.type).split('.').pop()) || [])
                .some(d => NON_CALLABLE_TYPES.has(d.type) && d.type !== 'field');
            if (!projectShadow) {
                const builtinReturn = _builtinMethodReturnType(language, rt.type, name);
                if (builtinReturn) return { type: builtinReturn };
            }
            return _methodReturnOnType(index, rt.type, rt.fromFile, name, language,
                { filePath, consumerAwaited });
        }
        if (nominal) return null;
        // One-hop agreement (the #207/#219 discipline, one level deeper):
        // every method owner project-wide annotated and agreeing.
        const methodDefs = (index.symbols.get(name) || [])
            .filter(d => !NON_CALLABLE_TYPES.has(d.type) && (d.className || d.receiver));
        if (methodDefs.length === 0) return null;
        if (!methodDefs.every(d => d.returnType)) return null;
        if (nominal) {
            if (new Set(methodDefs.map(d => d.returnType)).size !== 1) return null;
            const classes = new Set(methodDefs.map(d =>
                d.className || (d.receiver || '').replace(/^\*/, '')));
            const selfClass = classes.size === 1 ? [...classes][0] : undefined;
            const parsed = _returnTypeNameNominal(methodDefs[0].returnType, language, { selfClass });
            if (!parsed) return null;
            const origin = _resolveFlowTypeOrigin(index, methodDefs[0].file || filePath, parsed.name, parsed.qualifier);
            if (!origin) return null;
            return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
        }
        if (language === 'python' && !consumerAwaited && methodDefs.some(d => d.isAsync)) return null;
        const heads = new Set();
        for (const d of methodDefs) {
            const h = _structuralTypeHead(d.returnType, {
                unwrapAsync: consumerAwaited, index, language, originFile: d.file,
            });
            if (!h) return null;
            heads.add(h);
            if (heads.size > 1) return null;
        }
        const head = [...heads][0];
        if (/^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
        const origins = new Set();
        const typeDefs = (index.symbols.get(head) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
        if (typeDefs.length > 0) {
            for (const d of methodDefs) {
                const origin = _resolveFlowTypeOrigin(index, d.file || filePath, head);
                if (!origin) return null;
                origins.add(origin.fromFile);
                if (origins.size > 1) return null;
            }
        }
        const fromFile = origins.size === 1 ? [...origins][0] : undefined;
        return { type: head, ...(fromFile && { fromFile }) };
    }
    // Plain producer: Go same-package only; others unique-project-def with
    // same-file narrowing; Java bare calls reach the enclosing class first.
    if (traits?.bareCallReachesMethods) {
        const enclosing = index.findEnclosingFunction(filePath, record.line, true);
        if (enclosing?.className) {
            const r = _methodReturnOnType(index, enclosing.className, filePath, name, language,
                { filePath, consumerAwaited });
            if (r) return r;
        }
    }
    const defs = (index.symbols.get(name) || [])
        .filter(d => !NON_CALLABLE_TYPES.has(d.type) && !(d.className || d.receiver));
    let chosen = null;
    if (traits?.packageScope === 'directory') {
        const dir = path.dirname(filePath);
        const samePkg = defs.filter(d => d.file && path.dirname(d.file) === dir);
        if (samePkg.length === 1) chosen = samePkg[0];
    } else if (defs.length === 1) {
        chosen = defs[0];
    } else {
        const sameFile = defs.filter(d => d.file === filePath);
        if (sameFile.length === 1) chosen = sameFile[0];
    }
    if (!chosen || !chosen.returnType) return null;
    if (nominal) {
        if (language === 'cpp') {
            const concrete = _cppAutoReturnConcreteType(index, chosen);
            if (concrete) {
                const origin = _resolveFlowTypeOrigin(
                    index, chosen.file || filePath, concrete);
                if (origin) {
                    return {
                        type: concrete,
                        ...(origin.fromFile && { fromFile: origin.fromFile }),
                    };
                }
            }
        }
        const parsed = _returnTypeNameNominal(chosen.returnType, language, {});
        if (!parsed) return null;
        const origin = _resolveFlowTypeOrigin(index, chosen.file || filePath, parsed.name, parsed.qualifier);
        if (!origin) return null;
        return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
    }
    if (language === 'python' && !consumerAwaited && chosen.isAsync) return null;
    let head = _structuralTypeHead(chosen.returnType, {
        unwrapAsync: consumerAwaited, index, language, originFile: chosen.file,
    });
    if (!head || /^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
    const typeDefs = (index.symbols.get(head) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
    if (typeDefs.length > 0) {
        const origin = _resolveFlowTypeOrigin(index, chosen.file || filePath, head);
        if (!origin) return null;
        return { type: head, ...(origin.fromFile && { fromFile: origin.fromFile }) };
    }
    return { type: head };
}

/**
 * Resolve the exact producer record(s) referenced by a chained-call record.
 * Complete byte spans make same-line nested/repeated calls independently
 * addressable; old span-less records retain the conservative line fallback.
 */
function _chainedProducerRecords(ctx, call) {
    if (!call.receiverCall || !call.receiverCallLine || !ctx.records) return [];
    if (!ctx.producerIndex) {
        ctx.producerIndex = new Map();
        for (const record of ctx.records) {
            // Token-tree records used to lack stable identities and were
            // excluded wholesale. Rust now emits complete spans for real
            // macro invocations and for calls written inside token trees, so
            // exact path/builder chains can participate. Legacy span-less
            // records remain ineligible.
            if ((record.isMacro || record.inMacro) &&
                (record.callStart == null || record.callEnd == null)) continue;
            const keys = [
                `line:${record.line}\x00${record.name}\x00${record.isMethod ? 1 : 0}`,
            ];
            if (record.callStart != null && record.callEnd != null) {
                keys.push(`span:${record.callStart}:${record.callEnd}\x00${record.name}\x00${record.isMethod ? 1 : 0}`);
            }
            for (const key of keys) {
                let group = ctx.producerIndex.get(key);
                if (!group) {
                    group = [];
                    ctx.producerIndex.set(key, group);
                }
                group.push(record);
            }
        }
    }
    // Kind match: the consumer knows whether its producer was a method-shaped
    // call. `.arg(arg("x"))` has both a chained method `arg` and a plain
    // closure call `arg` on one line; only the right kind folds.
    const producerKey = call.receiverCallStart != null && call.receiverCallEnd != null
        ? `span:${call.receiverCallStart}:${call.receiverCallEnd}\x00${call.receiverCall}\x00${call.receiverCallIsMethod ? 1 : 0}`
        : `line:${call.receiverCallLine}\x00${call.receiverCall}\x00${call.receiverCallIsMethod ? 1 : 0}`;
    return (ctx.producerIndex.get(producerKey) || []).filter(record => record !== call);
}

/**
 * Type the RECEIVER of a chained call from its producer's own record
 * (fix #258). Producer records are matched by exact span when available;
 * when several legacy line matches remain, ALL must fold to the same type or
 * the receiver stays untyped. Returns { type, fromFile }, { externalVia }, or
 * null (fall back to the legacy one-hop helpers).
 */
function _foldChainedReceiverType(index, fileEntry, filePath, call, ctx) {
    const prods = _chainedProducerRecords(ctx, call);
    if (prods.length === 0) return null;
    const results = prods.map(r =>
        _typeOfCallResultFold(index, fileEntry, filePath, r, ctx, call.receiverCallAwaited));
    if (!results.every(Boolean)) {
        // A module owns its exported name. If module-qualified producer
        // resolution cannot type `z.number()`, the global same-name method
        // fallback is not allowed to borrow Mocker.number (or another
        // module/version) as its return type. Keep the consumer untyped and
        // visible instead of manufacturing exclusion-grade evidence.
        if (prods.some(r => r.receiverIsModule || _isStructuralImportReceiver(fileEntry, r))) {
            return { suppressFallback: true };
        }
        return null;
    }
    if (results.every(r => r.externalVia)) {
        return {
            externalVia: results[0].externalVia,
            ...(results.every(r => r.externalConcrete) && { externalConcrete: true }),
        };
    }
    if (results.some(r => r.externalVia)) return null;
    if (new Set(results.map(r => r.type)).size !== 1) return null;
    const fromFiles = new Set(results.map(r => r.fromFile));
    let result = {
        type: results[0].type,
        ...(fromFiles.size === 1 && results[0].fromFile && {
            fromFile: results[0].fromFile,
        }),
    };
    if (call.receiverFields?.length) {
        const fieldInfo = {};
        const fieldType = _declaredFieldPathType(
            index, result.type, call.receiverFields,
            fileEntry.language, fieldInfo);
        if (fieldType) {
            result = {
                type: fieldType,
                ...(fieldInfo.fromFile && { fromFile: fieldInfo.fromFile }),
            };
        } else if (fieldInfo.externalVia) {
            return {
                externalVia: fieldInfo.externalVia,
                ...(fieldInfo.externalConcrete && { externalConcrete: true }),
            };
        } else {
            return null;
        }
    }
    return result;
}

// A lower-case named import can be a namespace-like API object (`z.string()`)
// even when the parser cannot label it receiverIsModule. Its terminal member
// is still owned by that import; it must never borrow a same-named method's
// return annotation from an unrelated class. Capitalized named imports remain
// eligible for class/static-method resolution.
function _isStructuralImportReceiver(fileEntry, record) {
    if (!record?.receiver || !/^[a-z_$]/.test(record.receiver)) return false;
    return (fileEntry?.importBindings || []).some(b => b.name === record.receiver);
}

/**
 * Is this field symbol callable by its own name (obj.f(...) reaches the
 * field's function value)? Arrow-function class fields are callable by
 * construction; annotation-typed fields qualify via a function-type shape.
 * Structural languages only — Java needs .apply()/.run() on a functional
 * field and Rust needs (s.f)(…) parens, so their fields never own a
 * method-call name; Go func fields DO but stay under the existing owner
 * rules until a measured family justifies the churn.
 */
function _callableFieldDef(index, d) {
    const lang = index.files.get(d.file)?.language;
    if (langTraits(lang)?.typeSystem !== 'structural') return false;
    if (d.isMethod) return true; // arrow-function class fields
    if (!d.fieldType) return false;
    return /=>/.test(d.fieldType) ||
        /^(?:typing\.)?Callable\b/.test(d.fieldType.trim()) ||
        /^Function\b/.test(d.fieldType.trim());
}

function _buildTypedLocalTypeMap(index, def, calls) {
    const localTypes = new Map();
    // Vars whose entry is a New*-prefix name GUESS (fix #266) — consumers may
    // confirm through them but never exclude (convention, not compiler truth).
    const guessedVars = new Set();
    let _cachedLines = null;

    for (const call of calls) {
        if (call.line < def.startLine || call.line > def.endLine) continue;

        // Parser receiverType evidence belongs to that exact call record and
        // is consumed directly by findCallers/findCallees. Do not smear it
        // across the whole function: block shadowing (`if let Some(v) = ...`)
        // and reassignment can reuse the same variable name with a different
        // type. This map is reserved for explicit constructor-result inference
        // below, where the producer assignment is the evidence source.

        // Collect types from constructor calls: x := NewFoo() → x maps to Foo
        // Handles: x := NewFoo(), x, err := NewFoo(), x := pkg.NewFoo(), x, err := pkg.NewFoo()
        const newName = call.isMethod ? call.name : call.name;
        if (/^New[A-Z]/.test(newName) && !call.isPotentialCallback) {
            if (_cachedLines === false) continue; // File unreadable, skip all
            if (!_cachedLines) {
                try {
                    _cachedLines = index._readFile(def.file).split('\n');
                } catch { _cachedLines = false; continue; }
            }
            const sourceLine = _cachedLines[call.line - 1];
            if (!sourceLine) continue;
            // Match: x := [pkg.]NewFoo( or x, err := [pkg.]NewFoo( or x, _ := [pkg.]NewFoo(
            const assignMatch = sourceLine.match(
                /(\w+)(?:\s*,\s*\w+)?\s*:=\s*(?:\w+\.)?(\w+)\s*\(/
            );
            if (assignMatch && /^New[A-Z]/.test(assignMatch[2])) {
                // NewFoo → Foo, NewFooBar → FooBar
                const typeName = assignMatch[2].slice(3);
                if (typeName && /^[A-Z]/.test(typeName)) {
                    localTypes.set(assignMatch[1], typeName);
                    guessedVars.add(assignMatch[1]); // name convention, not compiler truth (fix #266)
                }
            }
        }
    }

    if (localTypes.size === 0) return null;
    localTypes.guessedVars = guessedVars;
    return localTypes;
}

/**
 * Find higher-order function usages where `name` is passed as a callback argument.
 * Handles patterns like .map(fn), setTimeout(fn), promise.then(handler).
 * Delegates to per-language findCallbackUsages implementations.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @returns {Array} Callback usages
 */
function findCallbackUsages(index, name) {
    const usages = [];

    for (const [filePath, fileEntry] of index.files) {
        try {
            const content = index._readFile(filePath);
            const language = detectLanguage(filePath);
            if (!language) continue;

            const langModule = getLanguageAdapter(language);
            if (!langModule.findCallbackUsages) continue;

            const parser = getParser(language);
            const callbacks = langModule.findCallbackUsages(content, name, parser);

            for (const cb of callbacks) {
                usages.push({
                    file: filePath,
                    relativePath: fileEntry.relativePath,
                    ...cb
                });
            }
        } catch (e) {
            // Skip files that can't be processed
        }
    }

    return usages;
}

module.exports = { getCachedCalls, findCallers, findCallees, getInstanceAttributeTypes, findCallbackUsages, _nameBindingReaches, _declaredFieldType, _projectTopLevelNames, _callArityCompatible, _closeCallableIdentityGroup, _overloadDiscipline, _overloadApplicable };
