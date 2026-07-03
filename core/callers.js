/**
 * core/callers.js - Call graph resolution (callers, callees, callbacks)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectLanguage, getParser, getLanguageModule, langTraits } = require('../languages');
const { isTestFile } = require('./discovery');
const { NON_CALLABLE_TYPES, isOverrideMarked, codeUnitCompare, isTestPath } = require('./shared');
const { scoreEdge, tierForResolution, TIER } = require('./confidence');
const { findGoModule } = require('./imports');

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

        const langModule = getLanguageModule(language);
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
        return null;
    }
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
    // Lazy-load callsCache from disk if not already populated
    if (index.loadCallsCache) index.loadCallsCache();

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

    // Get definition lines to exclude them
    const definitions = index.symbols.get(name) || [];
    const definitionLines = new Set();
    for (const def of definitions) {
        definitionLines.add(`${def.file}:${def.startLine}`);
    }

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
                        _methodOwnerKeys.add(d.className);
                    }
                    continue;
                }
                const o = d.className || (d.receiver && d.receiver.replace(/^\*/, ''));
                if (o) _methodOwnerKeys.add(o);
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

    // Phase 1: Find matching calls without reading file content.
    // Collect pending callers keyed by file — content is read only in Phase 2.
    const pendingByFile = new Map(); // filePath -> [{ call, fileEntry, callerSymbol, isMethod, isFunctionReference, receiver }]
    let pendingCount = 0;
    // Route a would-be-dropped candidate into the pending pipeline as an
    // unverified-tier entry (tiered caller contract: shown in its own
    // section, never silently hidden). Does NOT count toward pendingCount —
    // totals describe the confirmed answer.
    const routeUnverified = (filePath, fileEntry, call, reason, calledAs, meta) => {
        if (!collectAccount) return; // non-account paths (trace/blast/verify) keep the plain drop
        if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
        pendingByFile.get(filePath).push({
            call, fileEntry, callerSymbol: null,
            isMethod: call.isMethod || false,
            isFunctionReference: !!call.isFunctionReference,
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

            for (let call of calls) {
                // Skip if not matching our target name (also check alias resolution)
                let calledAs = null; // surface name when matched via an import/export rename
                if (call.name !== name && call.resolvedName !== name &&
                    !(call.resolvedNames && call.resolvedNames.includes(name))) {
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
                if (call.isMethod && call.receiver && !call.receiverType &&
                    !call.receiverIsChainRoot &&
                    (langTraits(fileEntry.language)?.typeSystem === 'structural' ||
                        (collectAccount && !call.isPotentialCallback && !call.isPathCall &&
                            langTraits(fileEntry.language)?.typeSystem === 'nominal'))) {
                    let flowMap = returnFlowCache.get(filePath);
                    if (flowMap === undefined) {
                        flowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                        returnFlowCache.set(filePath, flowMap);
                    }
                    const flowEntry = flowMap && _lookupReturnTypeFlow(flowMap, call);
                    if (flowEntry && flowEntry.externalVia) {
                        // External producer (fix #220) — typed outside the
                        // project; blocks single-owner confirmation, routes
                        // possible-dispatch in the gate. Nominal-only entries.
                        call = { ...call, receiverExternalFlow: flowEntry.externalVia };
                    } else if (flowEntry) {
                        call = { ...call, receiverType: flowEntry.type,
                            ...(flowEntry.fromFile && { receiverTypeFlowFile: flowEntry.fromFile }) };
                    }
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
                    if (folded && folded.type) {
                        call = { ...call, receiverType: folded.type };
                    } else if (folded && folded.externalVia) {
                        call = { ...call, receiverExternalFlow: folded.externalVia };
                    } else {
                        const chainedType = _chainedReceiverType(index, call, fileEntry.language);
                        if (chainedType) call = { ...call, receiverType: chainedType };
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
                    const flowEntry = _foldChainedReceiverType(index, fileEntry, filePath, call, foldCtx)
                        || _nominalChainedReceiverType(index, call, fileEntry, filePath);
                    if (flowEntry && flowEntry.externalVia) {
                        call = { ...call, receiverExternalFlow: flowEntry.externalVia };
                    } else if (flowEntry) {
                        call = { ...call, receiverType: flowEntry.type,
                            ...(flowEntry.fromFile && { receiverTypeFlowFile: flowEntry.fromFile }) };
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

                    // A bare identifier can never denote a METHOD where bare
                    // names don't reach methods (fix #220, grpc-go-measured:
                    // `balancer.Get(Name)` references each package's const
                    // Name, never the pinned method Name() — Go method values
                    // require receivers, Rust `use` cannot import associated
                    // functions). Java exempt (static imports). Compiler-grade
                    // kind evidence — excluded with reason, all surfaces.
                    if (!call.isMethod && !call.receiver &&
                        langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                        !langTraits(fileEntry.language)?.bareCallReachesMethods) {
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
                        if (targetTypes.size > 0 && call.receiver && call.receiverType &&
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
                                    if (_dispatchCapableSupertype(index, fileEntry.language, call.receiverType, cbTargetDefs, definitions)) {
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
                            const cbOtherDefFiles = new Set(definitions
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
                    if (call.localShadow ||
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
                if (call.localShadow && !call.isPotentialCallback) {
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
                const skipLocalBinding = call.receiver && !selfReceivers.has(call.receiver);
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
                        !langTraits(fileEntry.language)?.bareCallReachesMethods;
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
                        bindings.filter(b => b.type === 'class' || b.type === 'function').length === 1) {
                        // Constructor calls bind to constructable symbols: `new ZodArray()`
                        // must resolve to the class binding, not a same-name field/const
                        // elsewhere in the file (TS declaration merging, bottom-of-file
                        // namespace aliases). All `new`-style languages mark these
                        // (JS/TS `new`, Java `new`, Go/Rust composite/struct literals).
                        bindingId = bindings.find(b => b.type === 'class' || b.type === 'function').id;
                    } else if (bindings.length > 1 && !call.isMethod) {
                        // For implicit same-class calls (Java: execute() means this.execute()),
                        // try to resolve via caller's className before marking uncertain
                        const callerSym = index.findEnclosingFunction(filePath, call.line, true);
                        if (callerSym?.className) {
                            const callSymbols = index.symbols.get(call.name);
                            const sameClassSym = callSymbols?.find(s => s.className === callerSym.className);
                            if (sameClassSym) {
                                const matchingBinding = bindings.find(b => b.startLine === sameClassSym.startLine);
                                bindingId = matchingBinding?.id || sameClassSym.bindingId;
                            } else {
                                isUncertain = true;
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

                // Smart method call handling — do this BEFORE uncertain check so
                // self/this.method() calls can be resolved by same-class matching
                // even when binding is ambiguous (e.g. method exists in multiple classes)
                let resolvedBySameClass = false;
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
                if (call.isMethod) {
                    if (call.selfAttribute && fileEntry.language === 'python') {
                        // self.attr.method() — resolve via attribute type inference
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) {
                            // Can't resolve — include only if includeMethods requested
                            if (options.collectAccount || !options.includeMethods) {
                                routeUnverified(filePath, fileEntry, call, 'method-no-evidence', calledAs);
                                continue;
                            }
                        } else {
                            const attrTypes = getInstanceAttributeTypes(index, filePath, callerSymbol.className);
                            const targetClass = attrTypes?.get(call.selfAttribute);
                            if (targetClass && definitions.some(d => d.className === targetClass)) {
                                // fix #202b: the resolved class must be the
                                // TARGET's class (or an ancestor — dynamic
                                // dispatch). self.attr.m() resolving to class X
                                // is not a caller of a pinned target Y.m.
                                const tDefs = options.targetDefinitions || definitions;
                                const targetClasses = new Set(tDefs.map(d => d.className).filter(Boolean));
                                if (!targetClasses.has(targetClass) &&
                                    !_isAncestorOfTargetClass(index, targetClass, tDefs)) {
                                    recordExcluded(filePath, call.line, 'other-definition');
                                    continue;
                                }
                                // fix #218: attribute typed as a STRICT ancestor
                                // of the pinned target's class — reaching the
                                // subclass override is dynamic dispatch (#204
                                // physics). Demote-only, account-gated.
                                if (collectAccount && !targetClasses.has(targetClass)) {
                                    routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                        dispatchVia: targetClass,
                                    });
                                    continue;
                                }
                                resolvedBySameClass = true;
                            } else if (options.collectAccount || !options.includeMethods) {
                                routeUnverified(filePath, fileEntry, call, 'method-no-evidence', calledAs);
                                continue;
                            }
                        }
                    } else if (['self', 'cls', 'this', 'super'].includes(call.receiver) ||
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
                            let matchedClass = call.receiver !== 'super' &&
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
                                    const superSkipsExemptions = call.receiver === 'super';
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
                                        (call.receiver === 'super' ||
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
                let fieldHopType = null;
                let fieldHopRootType = call.receiverRootType;
                if (!fieldHopRootType && call.receiverField && call.receiverRoot === 'this' &&
                    !resolvedBySameClass &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural') {
                    const hopEnclosing = index.findEnclosingFunction(filePath, call.line, true);
                    if (hopEnclosing?.className) fieldHopRootType = hopEnclosing.className;
                }
                if (call.isMethod && !call.receiverType && call.receiverField && fieldHopRootType &&
                    !resolvedBySameClass) {
                    fieldHopType = _declaredFieldType(index, fieldHopRootType, call.receiverField, fileEntry.language);
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
                    fieldDispatchType = _declaredFieldInterfaceType(index, fieldHopRootType, call.receiverField, fileEntry.language);
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

                // Skip definition lines
                if (definitionLines.has(`${filePath}:${call.line}`)) continue;

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
                    if (!fieldHopMatchesTarget) {
                        recordExcluded(filePath, call.line, 'other-definition');
                        continue;
                    }
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
                if (!bindingId && !call.isMethod && !calledAs &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    (fileEntry.importBindings || []).length > 0) {
                    const nameBindings = fileEntry.importBindings.filter(b => b.name === call.name);
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
                            const verdict = _nameBindingReaches(index, resolvedAbs, b.name, tFiles);
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
                    }
                }

                // Import-graph disambiguation for JS/TS/Python: when multiple definitions of
                // the same name exist and this call has no bindingId, check whether the calling
                // file imports from the target definition's file. Skips false positives like
                // user_b importing from b.js being reported as a caller of a.js:process.
                // Go/Java/Rust are excluded — they use package/module scoping, not file imports.
                if (!bindingId && options.targetDefinitions && definitions.length > 1 &&
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
                if ((!bindingId || (call.isMethod &&
                        !langTraits(fileEntry.language)?.methodCallReachesFunctions)) &&
                    !resolvedBySameClass && !call.isPathCall &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
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

                // Module receiver: httpx.get() / ns.helper() dispatches to a
                // module export — it can never be a CLASS METHOD call. Applies
                // only when every target is a class method; standalone-function
                // and class (constructor) targets keep flowing on import evidence.
                if (!bindingId && !resolvedBySameClass && call.isMethod && call.receiverIsModule &&
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
                // target (directly or one re-export hop) → visible, not
                // excluded (deep barrel chains exceed the hop budget);
                // unresolved-but-project-looking → visible (resolver gap).
                if (!bindingId && !resolvedBySameClass && call.isMethod &&
                    (call.receiverIsModule || recvSubmoduleRel) &&
                    call.receiver && langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    (fileEntry.importBindings || []).length > 0) {
                    const recvBindings = fileEntry.importBindings.filter(b => b.name === call.receiver);
                    const tFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                    if (recvBindings.length > 0 && !tFiles.has(filePath)) {
                        let reaches = false;
                        let projectish = false;
                        for (const b of recvBindings) {
                            const rel = (fileEntry.moduleResolved && fileEntry.moduleResolved[b.module]) ||
                                recvSubmoduleRel;
                            if (!rel) {
                                const mod = String(b.module);
                                const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                                if (mod.startsWith('.') ||
                                    (firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                                    projectish = true;
                                }
                                continue;
                            }
                            projectish = true;
                            const resolvedAbs = path.join(index.root, rel);
                            // Name-level ownership (fix #217 applied to module
                            // receivers — zod family D): `z._default(...)` asks
                            // for the MODULE's `_default` attribute; with three
                            // project defs of the name, only the one the export
                            // chain actually exposes can be the callee. The
                            // chase is definitive only on fully-modeled ESM/
                            // Python surfaces — 'unknown' (CJS, stars, module
                            // assignments) falls back to file-level reach.
                            const verdict = _nameBindingReaches(index, resolvedAbs, call.name, tFiles);
                            if (verdict === 'yes' ||
                                (verdict === 'unknown' && _importReaches(index, resolvedAbs, tFiles))) {
                                reaches = true; break;
                            }
                        }
                        if (!reaches) {
                            if (!projectish) {
                                recordExcluded(filePath, call.line, 'external-package');
                                continue;
                            }
                            if (collectAccount) {
                                routeUnverified(filePath, fileEntry, call, 'no-import-link', calledAs);
                                continue;
                            }
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
                const builtinReceiverOverride = !!(call.receiverType &&
                    BUILTIN_RECEIVER_TYPES.has(call.receiverType) &&
                    langTraits(fileEntry.language)?.typeSystem === 'structural');
                if (call.isMethod && (call.receiver || call.receiverType || fieldHopType) && !resolvedBySameClass &&
                    (!bindingId || fieldHopType || builtinReceiverOverride) &&
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
                        if (knownType && _isGenericParamReceiverType(index, filePath, call.line, knownType)) knownType = null;
                        if (knownType) {
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
                                // Identity discipline (nominal, fix #206): a
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
                                        index, call.receiverTypeFlowFile || filePath, knownType, targetDefs);
                                    if (identity === 'other') {
                                        receiverTypeValidated = false;
                                    } else if (identity === 'unknown') {
                                        receiverTypeValidated = false;
                                        receiverTypeUnresolved = true;
                                    }
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
                            const fieldHopDefinesMethod = !viaFieldHop || definitions.some(d =>
                                (d.className || (d.receiver || '').replace(/^\*/, '')) === knownType) ||
                                (!/^[A-Z][A-Z0-9]?$/.test(knownType) &&
                                    !(index.symbols.get(knownType) || []).some(d =>
                                        d.type === 'class' || d.type === 'struct' || d.type === 'interface' || d.type === 'trait') &&
                                    _targetAncestryFullyResolved(index, targetDefs));
                            const exclusionTrusted = (!structural ||
                                _receiverTypeTrustedForExclusion(index, knownType)) && fieldHopDefinesMethod &&
                                !receiverTypeUnresolved; // unresolvable identity is not positive evidence either way
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
                                        routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                            dispatchVia: knownType,
                                            dispatchCandidates: countDispatchCandidates(knownType),
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
                                        if (inferredType) {
                                            if (targetTypes.has(inferredType)) {
                                                // Identity discipline (fix #206) — same as the
                                                // parser-typed branch above: a name match on a
                                                // DIRECT target type must resolve to the
                                                // target's package, not a same-named foreign type.
                                                let identity = 'target';
                                                if (targetDefs.some(d => (d.className || (d.receiver || '').replace(/^\*/, '')) === inferredType)) {
                                                    identity = _resolveReceiverTypeIdentity(index, filePath, inferredType, targetDefs);
                                                }
                                                if (identity === 'target') {
                                                    inferredMatch = true;
                                                    nominalInferredMatch = true;
                                                } else if (identity === 'other') {
                                                    inferredMismatch = true;
                                                } else {
                                                    receiverTypeUnresolved = true;
                                                }
                                            } else {
                                                inferredMismatch = true;
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
                            // Still no type — fall back to receiver name matching when
                            // multiple defs exist. A field-declared interface/trait type
                            // (fieldDispatchType, contract surface only) outranks the name
                            // heuristic: `storage.save()` on a field declared `Storage`
                            // is a dispatch edge, not a case-insensitive name accident —
                            // skip the fallback and let the dispatch tiering route it.
                            // call.receiver guard: a generic-param knownType
                            // (fix #220) reaches here receiver-less — there is
                            // no receiver NAME to match against.
                            if (call.receiver && !inferredMatch && !inferredMismatch && definitions.length > 1 && !fieldDispatchType) {
                                const receiverLower = call.receiver.toLowerCase();
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
                                    const identity = _resolveReceiverTypeIdentity(index, filePath, call.receiver, targetDefs);
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
                                    if (call.isPathCall && /^[A-Z]/.test(call.receiver) && call.receiver !== 'Self') {
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
                // Binding/same-class evidence outranks the count (then a
                // mismatch more likely means our param parse is wrong).
                let arityNoFit = false;
                if (collectAccount && !bindingId && !resolvedBySameClass &&
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
                    const overloadVerdict = _overloadDiscipline(index, call, targetDefs, definitions);
                    if (overloadVerdict === 'other-overload') {
                        recordExcluded(filePath, call.line, 'overload-mismatch');
                        continue;
                    }
                    if (overloadVerdict && overloadVerdict.ambiguous) {
                        routeUnverified(filePath, fileEntry, call, 'overload-ambiguous', calledAs, {
                            dispatchCandidates: overloadVerdict.candidates,
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
                let importEdgeLink = !!(callerImports && setSome(callerImports, imp => targetFiles2.has(imp)));
                // Check one level of re-exports (barrel files) for import evidence
                if (!importEdgeLink && callerImports) {
                    for (const imp of callerImports) {
                        const transImports = index.importGraph.get(imp);
                        if (transImports && setSome(transImports, ti => targetFiles2.has(ti))) {
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

                const receiverBlindBinding = !!bindingId && call.isMethod && !call.receiver;
                if (collectAccount && call.isMethod && (!bindingId || receiverBlindBinding) && !resolvedBySameClass &&
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
                        const identity = _resolveReceiverTypeIdentity(index, filePath, receiverName, targetDefs2);
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
                        if (call.isPathCall && call.receiver &&
                            /^[A-Z]/.test(call.receiver) && call.receiver !== 'Self') {
                            if (/^[A-Z][A-Z0-9]?$/.test(call.receiver) &&
                                !(index.symbols.get(call.receiver) || []).some(d => IDENTITY_TYPE_KINDS.has(d.type))) {
                                routeUnverified(filePath, fileEntry, call, 'method-ambiguous', calledAs, {
                                    dispatchCandidates: methodOwnerKeys().size,
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
                                // pinned target lives in the qualifier's module —
                                // ownership consistent, normal confirmation proceeds
                            }
                        }
                        const knownDispatchType = call.receiverType || fieldHopType || fieldDispatchType;
                        if (knownDispatchType && !tTypes.has(knownDispatchType)) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: knownDispatchType,
                                dispatchCandidates: countDispatchCandidates(knownDispatchType),
                            });
                            continue;
                        }
                        if (!knownDispatchType && methodOwnerKeys().size > 1) {
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
                    const tTypes = dispatchTargetTypes(targetDefs2);
                    const enclosingClass = callerSymbol && callerSymbol.className;
                    if (!(enclosingClass && tTypes.has(enclosingClass))) {
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
                    if (call.isMethod && !call.receiverIsModule && !recvSubmoduleRel) {
                        const tTypes = dispatchTargetTypes(targetDefs2);
                        const typeQualifiedReceiver = !!(call.receiver && tTypes.has(call.receiver));
                        // External-producer receiver (fix #222, httpx-measured
                        // — the #220 Go rule for structural languages): the
                        // variable was assigned from a call into an external
                        // module (logger = logging.getLogger(...)), so its
                        // type was decided outside the project and unique
                        // project ownership is not identity evidence.
                        // Visible, never excluded.
                        if (!typeQualifiedReceiver && call.receiverExternalFlow) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: call.receiverExternalFlow,
                                externalContract: true,
                            });
                            continue;
                        }
                        // Builtin-global receiver (fix #232, campaign-measured:
                        // console.log() confirmed scope-match against a private
                        // Logger.log — its single project-wide owner). console/
                        // window/process/... name HOST objects, so unique
                        // project ownership is not identity evidence for the
                        // receiver. Shadowing keeps normal physics: a project
                        // def, file binding, or parser-typed receiver of the
                        // name wins. Demote-only (`window.fn = projectFn`
                        // attachment is a real pattern — #222(4) name-knowledge
                        // rule): visible possible-dispatch, never excluded.
                        if (!typeQualifiedReceiver && call.receiver && !call.receiverType &&
                            ['javascript', 'typescript', 'tsx', 'html'].includes(fileEntry.language) &&
                            JS_GLOBAL_RECEIVERS.has(call.receiver) &&
                            (index.symbols.get(call.receiver) || []).length === 0 &&
                            !fileEntry.bindings?.some(b => b.name === call.receiver)) {
                            routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                dispatchVia: `${call.receiver} — builtin global`,
                                externalContract: true,
                            });
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
                            if (!_namespaceContainedDef(index, fileEntry, filePath,
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
                    if (!arityNameEvidence) {
                        recordExcluded(filePath, call.line, 'arity-mismatch');
                        continue;
                    }
                }

                if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
                pendingByFile.get(filePath).push({
                    call, fileEntry, callerSymbol,
                    isMethod: call.isMethod || false,
                    // Function references can resolve through the plain binding
                    // path too (e.g. JS `arr.map(helper)` with a local binding) —
                    // surface the parser's marker on the edge (fix #221).
                    isFunctionReference: !!call.isFunctionReference,
                    receiver: call.receiver,
                    receiverType: call.receiverType,
                    calledAs,
                    _evidence: {
                        hasBindingId: !!bindingId,
                        resolvedBySameClass: !!resolvedBySameClass,
                        hasSamePackageEvidence,
                        // Method calls where binding resolution was skipped (non-self receiver)
                        // and the receiver has no binding evidence → uncertain (JS/TS/Python only)
                        isUncertain: !!isUncertain || uncertainMethodReceiver,
                        hasReceiverType: langTraits(fileEntry.language)?.typeSystem === 'structural'
                            ? receiverTypeValidated
                            : !!call.receiverType,
                        hasReceiverEvidence: !!(call.receiver &&
                            (fileEntry.bindings || []).some(b => b.name === call.receiver)),
                        hasImportEvidence: !!bindingId || hasImportLink,
                        ...(typeMismatch && { typeMismatch: true }),
                    }
                });
                pendingCount++;
            }
        } catch (e) {
            // Expected: minified files exceed tree-sitter buffer, binary files fail to parse.
            // These are not actionable errors — silently skip.
        }
    }

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
    outer: for (const [filePath, pending] of pendingByFile) {
        let content = null;
        for (const { call, fileEntry, callerSymbol, isMethod, isFunctionReference, receiver, receiverType, calledAs, _evidence, _tier, _reason, _meta } of pending) {
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
                    confidence: scored.confidence,
                    resolution: scored.resolution,
                    tier: _tier,
                    reason: _reason,
                    ...(_meta || {}),
                    isMethod: call.isMethod || false,
                    ...(isFunctionReference && { isFunctionReference: true }),
                    ...(receiver !== undefined && { receiver }),
                    ...(receiverType && { receiverType }),
                    ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                };
                if (unverifiedEnriched < unverifiedEnrichLimit) {
                    if (content === null) {
                        try { content = fs.readFileSync(filePath, 'utf-8'); }
                        catch (e) { content = ''; }
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
                    confidence: scored.confidence,
                    resolution: scored.resolution,
                    ...(tier && { tier }),
                    isMethod: call.isMethod || false,
                    ...(isFunctionReference && { isFunctionReference: true }),
                    ...(receiver !== undefined && { receiver }),
                    ...(receiverType && { receiverType }),
                    ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                });
                continue;
            }
            // First time we hit this file's enrichment loop — read the file once.
            if (content === null) {
                try { content = fs.readFileSync(filePath, 'utf-8'); }
                catch (e) { content = ''; /* deleted/unreadable; skip enrichment for rest */ break; }
            }
            callers.push({
                file: filePath,
                relativePath: fileEntry.relativePath,
                line: call.line,
                content: getLine(content, call.line),
                callerName: callerSymbol ? callerSymbol.name : null,
                callerFile: callerSymbol ? filePath : null,
                callerStartLine: callerSymbol ? callerSymbol.startLine : null,
                callerEndLine: callerSymbol ? callerSymbol.endLine : null,
                isMethod,
                ...(isFunctionReference && { isFunctionReference: true }),
                ...(receiver !== undefined && { receiver }),
                ...(receiverType && { receiverType }),
                ...(edgeCalledAs && { calledAs: edgeCalledAs }),
                confidence: scored.confidence,
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
 * @param {object} def - Symbol definition with file, name, startLine, endLine
 * @param {object} [options] - Options
 * @param {boolean} [options.includeMethods] - Include method calls (default: false)
 */
function findCallees(index, def, options = {}) {
    index._beginOp();
    try {
    // Lazy-load callsCache from disk if not already populated
    if (index.loadCallsCache) index.loadCallsCache();

    try {
        // Get all calls from the file's cache (now includes enclosingFunction)
        const calls = getCachedCalls(index, def.file);
        if (!calls) return [];

        // Get file language for smart method call handling
        const fileEntry = index.files.get(def.file);
        const language = fileEntry?.language;

        // Build list of inner class/struct method ranges to exclude from callee detection.
        // Only class methods are excluded — they are independently addressable symbols.
        // Calls within closures (named functions without className) ARE included as
        // callees of the parent function, since closures are part of the parent's behavior.
        const innerSymbolRanges = fileEntry ? fileEntry.symbols
            .filter(s => !NON_CALLABLE_TYPES.has(s.type) &&
                    s.className &&  // Only exclude class methods, not closures
                    s.startLine > def.startLine && s.endLine <= def.endLine &&
                    s.startLine !== def.startLine)
            .map(s => [s.startLine, s.endLine]) : [];

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
        const noteUnverified = (siteId, call, reason) => {
            if (!collectAccount || claimedSiteIds.has(siteId)) return;
            noteSite(siteId, 'unverified', reason, call);
            const key = `${call.name}|${reason}`;
            let entry = unverifiedCallees.get(key);
            if (!entry) {
                const defs = index.symbols.get(call.name) || [];
                const owners = defs.filter(s => !NON_CALLABLE_TYPES.has(s.type)).length;
                entry = { name: call.name, reason, callCount: 0, sites: [], ownerCount: owners };
                unverifiedCallees.set(key, entry);
            }
            entry.callCount++;
            entry.sites.push(call.line);
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
            if (_flowMap === undefined) _flowMap = _buildReturnTypeFlowMap(index, def.file, calls);
            return _flowMap;
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
            if (call.isMethod && !call.receiverType && call.receiverField) {
                let hopRoot = call.receiverRootType;
                if (!hopRoot && call.receiverRoot === 'this' &&
                    langTraits(language)?.typeSystem === 'structural') {
                    hopRoot = index.findEnclosingFunction(def.file, call.line, true)?.className;
                }
                if (hopRoot) fieldHopType = _declaredFieldType(index, hopRoot, call.receiverField, language);
            }

            // Go package-qualified receiver: resolve the import module up
            // front so the dispatch chain can tell package calls apart from
            // type-qualified method expressions (fix #236 — a receiver that
            // is neither stays eligible for type-qualified resolution below).
            let goImportModule = null;
            if (call.isMethod && call.receiver && langTraits(language)?.hasReceiverPackageCalls) {
                const goImports = fileEntry?.imports || [];
                // Handle Go version suffixes: k8s.io/klog/v2 → klog, not v2
                goImportModule = goImports.find(mod => {
                    const parts = mod.split('/');
                    const last = parts[parts.length - 1];
                    const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
                    return pkgName === call.receiver;
                }) || null;
            }

            // Type-qualified receiver resolution (fix #236): the receiver
            // NAMES a type — Foo::new() / Kit.make() / Helper.process().
            // Only consulted when no stronger evidence (local type, parser
            // receiverType, field hop, import package) claims the call.
            let typeQual = null;
            if (call.isMethod && !call.isConstructor && call.receiver &&
                !call.receiverType && !fieldHopType && !goImportModule &&
                !call.receiverIsModule && !call.selfAttribute &&
                !['self', 'cls', 'this', 'super', 'Self'].includes(call.receiver) &&
                !(localTypes && localTypes.has(call.receiver))) {
                typeQual = _calleeTypeQualifiedReceiver(index, def, fileEntry, call, language);
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
                } else if (call.receiver === 'super') {
                    // super().method() — resolve to parent class method below
                } else if (localTypes && localTypes.has(call.receiver)) {
                    // Resolve method calls on locally-constructed objects:
                    // bt = Backtester(...); bt.run_backtest() → Backtester.run_backtest
                    // Go: f.Run() where f is *Framework → Framework.Run (receiver match)
                    const typeName = localTypes.get(call.receiver);
                    const symbols = index.symbols.get(call.name);
                    const isCallable = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
                        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
                    let match = symbols?.find(s =>
                        isCallable(s) && (
                        s.className === typeName ||
                        (s.receiver && s.receiver.replace(/^\*/, '') === typeName)));
                    // Walk embedding/inheritance chain if no direct match (nominal type systems)
                    if (!match && langTraits(language)?.typeSystem === 'nominal') {
                        const parentNames = index._getInheritanceParents?.(typeName, def.file);
                        if (parentNames) {
                            for (const pName of parentNames) {
                                match = symbols?.find(s =>
                                    isCallable(s) && (
                                    s.className === pName ||
                                    (s.receiver && s.receiver.replace(/^\*/, '') === pName)));
                                if (match) break;
                            }
                        }
                    }
                    if (match) {
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
                    } else if (collectAccount) {
                        // Locally-typed receiver, but the type defines no such
                        // method in the index — visible, never silently dropped.
                        noteUnverified(siteId, call, 'uncertain-receiver');
                    }
                    continue;
                } else if (call.receiverType || fieldHopType) {
                    // Use parser-inferred receiverType for method resolution
                    // Go/Java/Rust: from param/receiver type declarations
                    // JS/TS: from `new Foo()` assignments or TypeScript type annotations
                    // Python: from constructor calls or type annotations
                    // fieldHopType: the declared type of a one-hop field
                    // receiver (fix #231 — tm.service.Save() resolves Save
                    // through the `service *DataService` declaration)
                    const typeName = call.receiverType || fieldHopType;
                    const symbols = index.symbols.get(call.name);
                    const isCallableRT = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
                        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
                    let match = symbols?.find(s =>
                        isCallableRT(s) && (
                        (s.receiver && s.receiver.replace(/^\*/, '') === typeName) ||
                        s.className === typeName));
                    // Walk embedding/inheritance chain if no direct match (nominal type systems)
                    if (!match && langTraits(language)?.typeSystem === 'nominal') {
                        const parentNames = index._getInheritanceParents?.(typeName, def.file);
                        if (parentNames) {
                            for (const pName of parentNames) {
                                match = symbols?.find(s =>
                                    isCallableRT(s) && (
                                    (s.receiver && s.receiver.replace(/^\*/, '') === pName) ||
                                    s.className === pName));
                                if (match) break;
                            }
                        }
                    }
                    if (match) {
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
                    // No match found with inferred type — fall through to include as unresolved
                } else if (goImportModule) {
                    // Go package-qualified calls: klog.Infof(), wait.UntilWithContext()
                    // The receiver is an import alias (resolved above) — find
                    // definitions from that package.
                    const importModule = goImportModule;
                    {
                        // Receiver is an import alias — resolve to definitions from that package
                        const symbols = index.symbols.get(call.name);
                        if (symbols) {
                            // Match by checking if the definition's directory path matches the import path suffix.
                            // Pick the symbol with the LONGEST suffix match to avoid false positives
                            // (e.g., import "k8s.io/client-go/kubernetes/scheme" should prefer a definition
                            // in .../client-go/kubernetes/scheme/ over one in .../kubeadm/scheme/).
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
                            const match = bestMatch;
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
                        }
                        // Import resolved but no project definition matches — external call, skip
                        noteSite(siteId, 'external', null, call);
                        continue;
                    }
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
            }

            // Skip keywords and built-ins — EXCEPT self/super-received method
            // calls, which the same-class/super passes below resolve to real
            // definitions (fix #238: `super().__init__(x)` and the JS/TS
            // `super(...)` 'constructor' record were routed external here
            // because __init__/constructor sit in the builtin name sets).
            const selfShaped = call.isMethod &&
                (['self', 'cls', 'this', 'super'].includes(call.receiver) ||
                 (call.receiver === 'Self' && language === 'rust'));
            if (!selfShaped && index.isKeyword(call.name, language)) {
                noteSite(siteId, 'external', null, call);
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
                if (!hasBinding && !inSameFile) {
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
            if (call.isMethod && call.receiver === 'super') {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push({ call, siteId });
                continue;
            }

            // Resolve binding within this file (without mutating cached call objects)
            let calleeKey = call.bindingId || effectiveName;
            let bindingResolved = call.bindingId;
            let isUncertain = call.uncertain;
            let uncertainReason = null; // account-mode reason for the unverified bucket
            if (!call.bindingId && fileEntry?.bindings) {
                let bindings = fileEntry.bindings.filter(b => b.name === call.name);
                // For Go, also check sibling files in same directory (same package scope)
                if (bindings.length === 0 && langTraits(language)?.packageScope === 'directory') {
                    const dir = path.dirname(def.file);
                    for (const [fp, fe] of index.files) {
                        if (fp !== def.file && path.dirname(fp) === dir) {
                            const sibling = (fe.bindings || []).filter(b => b.name === call.name);
                            bindings = bindings.concat(sibling);
                        }
                    }
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
                            bindingResolved = route.resolve.bindingId;
                            calleeKey = bindingResolved ||
                                `${route.resolve.className}.${effectiveName}`;
                        } else if (route?.uncertain) {
                            isUncertain = true;
                            uncertainReason = 'uncertain-receiver';
                        } else {
                        // JS/TS/Python: mark uncertain unless receiver has import/binding
                        // evidence in file scope AND that binding can plausibly have this method.
                        // Prevents false positives like m.get() → repository.get() when m is
                        // just a parameter, AND dict.get() → api.get() when dict is a state object.
                        const receiverBinding = call.receiver &&
                            fileEntry?.bindings?.find(b => b.name === call.receiver);
                        if (!receiverBinding) {
                            isUncertain = true;
                        } else if (receiverBinding.type === 'state') {
                            // State objects (module-level dicts/lists) don't have user-defined methods
                            isUncertain = true;
                        } else if (receiverBinding.type === 'function') {
                            // Functions don't have user-defined methods (return value is unknown)
                            isUncertain = true;
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
                    if (call.name === def.name) {
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
                            // All same-name bindings are the def itself — a
                            // recursive self-call, never a callee edge.
                            noteSite(siteId, 'excluded', 'self-recursion', call);
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
                            const sameClassSym = callSymbols.find(s => s.className === def.className);
                            if (sameClassSym) {
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

            // Single project-wide owner (fix #236 — the caller side's
            // #204/#209 rule on the callee side): an untyped-receiver method
            // call whose name has exactly ONE owner type resolves to that
            // owner's method — `k.run()` where only Kit defines run. Without
            // it, trace trees stopped expanding at statically-resolvable
            // calls the caller direction confirms.
            if (isUncertain && call.isMethod && call.receiver && !bindingResolved) {
                const fm = flowMap();
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
                else noteUnverified(siteId, call, 'self-attr-unresolved');
            }
        }

        // Third pass: resolve self/this/super.method() calls to same-class or parent methods
        // Falls back to walking the inheritance chain if not found in same class
        // Respect includeMethods=false — skip self/this method resolution entirely
        if (selfMethodCalls && def.className && options.includeMethods !== false) {
            for (const { call, siteId } of selfMethodCalls) {
                const symbols = index.symbols.get(call.name);
                if (!symbols) { noteUnverified(siteId, call, 'inherited-unresolved'); continue; }

                // For super().method(), skip same-class — start from parent
                let match = call.receiver === 'super'
                    ? null
                    : symbols.find(s => s.className === def.className);

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
                        match = symbols.find(s => s.className === current);
                        if (!match) {
                            const resolvedFile = index._resolveClassFile(current, contextFile);
                            const grandparents = index._getInheritanceParents(current, resolvedFile) || [];
                            for (const gp of grandparents) {
                                if (!visited.has(gp)) queue.push({ name: gp, contextFile: resolvedFile });
                            }
                        }
                    }
                }

                if (!match) { noteUnverified(siteId, call, 'inherited-unresolved'); continue; }

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
            if (symbols.length > 0) {
                let callee = symbols[0];

                // If we have a binding ID, find the exact matching symbol
                if (bindingId && symbols.length > 1) {
                    const exactMatch = symbols.find(s => s.bindingId === bindingId);
                    if (exactMatch) {
                        callee = exactMatch;
                    }
                } else if (symbols.length > 1) {
                    // Priority 1: Same file, but different definition (for overloads)
                    const sameFileDifferent = symbols.find(s => s.file === def.file && s.startLine !== def.startLine);
                    const sameFile = symbols.find(s => s.file === def.file);
                    if (sameFileDifferent && calleeName === def.name) {
                        callee = sameFileDifferent;
                    } else if (sameFile) {
                        callee = sameFile;
                    } else {
                        // Priority 2: Same directory (package)
                        const sameDir = symbols.find(s => path.dirname(s.file) === defDir);
                        if (sameDir) {
                            callee = sameDir;
                        } else {
                            // Priority 2.5: Imported file — check if the caller's file imports
                            // from any of the candidate callee files (using importGraph)
                            const importedCallee = symbols.find(s => callerImportSet.has(s.file));
                            if (importedCallee) {
                                callee = importedCallee;
                            } else if (defReceiver) {
                                // Priority 3: Same receiver type (for methods)
                                const sameReceiver = symbols.find(s => s.receiver === defReceiver);
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
                            const nonBundled = symbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !fe.isBundled;
                            });
                            if (nonBundled) callee = nonBundled;
                        }
                    }
                    // Priority 5: If default is a test file, prefer non-test
                    if (!bindingId) {
                        const calleeFileEntry = index.files.get(callee.file);
                        if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                            const nonTest = symbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !isTestFile(fe.relativePath, fe.language);
                            });
                            if (nonTest) callee = nonTest;
                        }
                    }
                    // Priority 6: Usage-based tiebreaker for cross-language/cross-directory ambiguity
                    // Matches resolveSymbol() scoring logic in project.js
                    if (!bindingId && callee === symbols[0] && symbols.length > 1) {
                        const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
                        const scored = symbols.map(s => {
                            let score = 0;
                            const fe = index.files.get(s.file);
                            const rp = fe ? fe.relativePath : (s.relativePath || '');
                            if (typeOrder.has(s.type)) score += 1000;
                            if (isTestFile(rp, detectLanguage(s.file))) score -= 500;
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
                    // Constructor calls (new Foo()) are always callable regardless of type
                    if (!isFuncField && !isConstructor) {
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
                    hasImportEvidence: !!bindingId || (symbols && symbols.length === 1) ||
                        (callee.file === def.file) || callerImportSet.has(callee.file),
                    isUncertain: false, // uncertain callees already filtered above
                });
                claimSites('confirmed', null);
                result.push({
                    ...callee,
                    callCount: count,
                    weight: index.calculateWeight(count),
                    confidence: calleeScored.confidence,
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

        return result;
    } catch (e) {
        // Expected: file read/parse failures (minified, binary, buffer exceeded).
        // Return empty callees rather than crashing the entire query.
        return [];
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

        const langModule = getLanguageModule('python');
        if (!langModule?.findInstanceAttributeTypes) return null;

        try {
            const content = index._readFile(filePath);
            const parser = getParser('python');
            fileCache = langModule.findInstanceAttributeTypes(content, parser);
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
    const fileEntry = index.files.get(filePath);
    const language = fileEntry?.language;
    const nominal = langTraits(language)?.typeSystem === 'nominal';
    let map = null;
    for (const call of calls) {
        if (!call.assignedTo) continue;
        let returnType, fromFile, selfClass;
        if (call.isMethod && call.receiverType) {
            const defs = index.symbols.get(call.name) || [];
            if (nominal) {
                const matches = defs.filter(d => d.className === call.receiverType && d.returnType);
                if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                    returnType = matches[0].returnType;
                    fromFile = matches[0].file;
                    selfClass = matches[0].className;
                }
            } else {
                const def = defs.find(d => d.className === call.receiverType && d.returnType);
                returnType = def && def.returnType;
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
                if (def) { returnType = def.returnType; fromFile = def.file; selfClass = cls; break; }
                const parents = index._getInheritanceParents(cls, ctxFile) || [];
                const next = parents[0]; // single chain; diamond bases stay untyped
                if (next && index._resolveClassFile) {
                    ctxFile = index._resolveClassFile(next, ctxFile) || ctxFile;
                }
                cls = next;
            }
        } else if (nominal && call.isMethod && call.isPathCall && call.receiver) {
            // Rust: let c = config::Config::load()? — the last path segment
            // names the impl type (module-path producers stay untyped)
            const seg = call.receiver.split('::').pop();
            const matches = (index.symbols.get(call.name) || [])
                .filter(d => d.className === seg && d.returnType);
            if (matches.length > 0 && new Set(matches.map(d => d.returnType)).size === 1) {
                returnType = matches[0].returnType;
                fromFile = matches[0].file;
                selfClass = seg;
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
                    map.get(key).push({ line: call.line, externalVia: `${call.receiver}.${call.name}` });
                }
                continue;
            }
        } else if (!nominal && call.isMethod && call.receiver && call.receiverIsModule) {
            // Structural module-qualified producer (fix #209): schema =
            // z.string() — the module alias resolves through the file's
            // import bindings to its file (one re-export hop for barrels),
            // and the producer's return annotation types the variable.
            // Standalone exports only (className-less): a module attr is
            // never a class method.
            const binding = (fileEntry?.importBindings || []).find(b => b.name === call.receiver);
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
                    map.get(key).push({ line: call.line, externalVia: `${call.receiver}.${call.name}` });
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
                }
            }
        } else if (!call.isMethod && !call.receiver) {
            const defs = (index.symbols.get(call.name) || [])
                .filter(d => !NON_CALLABLE_TYPES.has(d.type));
            let chosen = null;
            if (nominal && langTraits(language)?.packageScope === 'directory') {
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
            if (chosen) { returnType = chosen.returnType; fromFile = chosen.file; }
        }
        if (!returnType) continue;
        let typeName, entryFromFile;
        if (nominal) {
            const parsed = _returnTypeNameNominal(returnType, language, {
                unwrapped: call.assignedUnwrap, tuple: call.assignedTuple, selfClass,
            });
            if (!parsed) continue;
            const origin = _resolveFlowTypeOrigin(index, fromFile || filePath, parsed.name, parsed.qualifier);
            if (!origin) continue; // identity unpinnable — don't type at all
            typeName = parsed.name;
            entryFromFile = origin.fromFile;
        } else {
            typeName = _typeNameFromReturnAnnotation(returnType);
        }
        if (!typeName) continue;
        const scope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
        const key = `${scope}:${call.assignedTo}`;
        if (!map) map = new Map();
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ line: call.line, type: typeName,
            ...(entryFromFile && { fromFile: entryFromFile }) });
    }
    return map;
}

/** Nearest preceding flow assignment for this call's receiver (fn scope, then module). */
function _lookupReturnTypeFlow(map, call) {
    const fnScope = call.enclosingFunction ? `${call.enclosingFunction.startLine}` : '';
    for (const scope of fnScope === '' ? [''] : [fnScope, '']) {
        const entries = map.get(`${scope}:${call.receiver}`);
        if (!entries) continue;
        let best = null;
        for (const e of entries) {
            if (e.line < call.line && (!best || e.line > best.line)) best = e;
        }
        if (best) return best;
    }
    return undefined;
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
    } else if (opts.tuple) {
        return undefined;
    }
    if (language === 'rust') {
        if (/^&?\s*(mut\s+)?Self$/.test(t)) {
            return opts.selfClass ? { name: opts.selfClass } : undefined;
        }
        if (opts.unwrapped) {
            const m = t.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*(Result|Option)\s*<(.*)>$/s);
            if (!m) return undefined; // unwrap on a non-Result/Option annotation — alias or parse gap
            t = (_splitTopLevelGenericArgs(m[2])[0] || '').trim();
            if (/^&?\s*(mut\s+)?Self$/.test(t)) {
                return opts.selfClass ? { name: opts.selfClass } : undefined;
            }
        }
    } else if (opts.unwrapped) {
        return undefined;
    }
    // Qualifier survives only the Go shape (`pkg.Type`); Rust paths and Java
    // dotted names lose theirs in normalization — capture it first.
    let qualifier;
    if (language === 'go') {
        const qm = t.replace(/^\*+/, '').match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
        if (qm) qualifier = qm[1];
    } else {
        const stripped = t.replace(/^&+\s*/, '').replace(/^mut\s+/, '');
        if (/^[A-Za-z_$][\w$]*\s*(::|\.)/.test(stripped)) qualifier = '<unresolvable>';
    }
    const norm = _normalizeFieldTypeName(t, language);
    if (!norm) return undefined;
    if (/^[A-Z][A-Z0-9]?$/.test(norm)) return undefined; // generic type param (T, K, V1)
    if (language === 'go' && _GO_FLOW_REJECT.has(norm)) return undefined;
    if (language === 'java' && _JAVA_FLOW_REJECT.has(norm)) return undefined;
    return { name: norm, qualifier };
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
function _resolveFlowTypeOrigin(index, producerFile, typeName, qualifier) {
    const typeDefs = (index.symbols.get(typeName) || [])
        .filter(d => IDENTITY_TYPE_KINDS.has(d.type) && d.file);
    if (typeDefs.length === 0) return { fromFile: producerFile };
    if (qualifier === '<unresolvable>') return null;
    if (qualifier) {
        const fe = index.files.get(producerFile);
        const inPkg = fe && _qualifiedProducerDefs(index, fe, qualifier, typeDefs);
        if (inPkg && inPkg.length > 0 && new Set(inPkg.map(d => d.file)).size === 1) {
            return { fromFile: inPkg[0].file };
        }
        return null;
    }
    const sameFile = typeDefs.find(d => d.file === producerFile);
    if (sameFile) return { fromFile: sameFile.file };
    const dir = path.dirname(producerFile);
    const sameDir = typeDefs.filter(d => path.dirname(d.file) === dir);
    if (sameDir.length === 1) return { fromFile: sameDir[0].file };
    if (sameDir.length > 1) return null;
    const imports = index.importGraph.get(producerFile);
    if (imports) {
        const imported = typeDefs.filter(d => imports.has(d.file));
        if (imported.length === 1) return { fromFile: imported[0].file };
    }
    // Re-export chains (fix #258, the #209 lesson brought to identity
    // resolution): `use clap::Command` lands the import edge on the crate's
    // lib.rs, not the type's defining file — chase bounded re-export hops
    // (depth 4) and pin only when exactly ONE same-name type is reachable.
    const reachable = typeDefs.filter(d =>
        _importReaches(index, producerFile, new Set([d.file])));
    if (reachable.length === 1) return { fromFile: reachable[0].file };
    return null;
}

/**
 * Defs that live in the package an import-qualified receiver names, resolved
 * through the producer file's imports (alias-aware — importNames pairs 1:1
 * with imports for Go). STRICT counterpart of _receiverPackageResolution:
 * used for POSITIVE typing (fix #207), so root-package defs ("." — package
 * identity unverifiable from paths) never match here, while over there they
 * must never be excluded. Returns null when the receiver names no import.
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
// these names — unshadowed by any project def or file binding — reaches host
// code, not a project method. Name-knowledge only, so demote-only: routes
// possible-dispatch, never excludes (window.fn = projectFn is a real pattern).
const JS_GLOBAL_RECEIVERS = new Set([
    'console', 'window', 'document', 'globalThis', 'process', 'navigator',
    'Math', 'JSON', 'Reflect', 'Intl', 'localStorage', 'sessionStorage',
    'crypto', 'performance', 'history', 'location', 'screen',
]);

const BUILTIN_RECEIVER_TYPES = new Set([
    'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'bytes', 'frozenset',
    'Array', 'String', 'Object', 'RegExp', 'Number', 'Boolean', 'Map', 'Set', 'Promise',
    'WeakMap', 'WeakSet',
    'string', 'number', 'boolean', 'bigint', 'symbol',
]);

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
    const visited = new Set([fromAbs]);
    let frontier = [fromAbs];
    for (let d = 0; d < maxDepth; d++) {
        const next = [];
        for (const f of frontier) {
            const edges = index.importGraph.get(f);
            if (!edges) continue;
            for (const e of edges) {
                if (visited.has(e)) continue;
                if (targetFiles.has(e)) return true;
                visited.add(e);
                next.push(e);
            }
        }
        if (next.length === 0) break;
        frontier = next;
    }
    return false;
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
        const seg = (fe.relativePath || '').split(/[\\/]/)[0];
        if (!seg) continue;
        names.add(seg);
        const dot = seg.lastIndexOf('.');
        if (dot > 0) names.add(seg.slice(0, dot)); // utils.py → utils
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
        const m = d.match(/^(.*?)[\/\\]src[\/\\][^\/\\]+[\/\\]java(?:[\/\\](.*))?$/);
        return m ? `${m[1]} ${m[2] || ''}` : null;
    };
    const a = norm(dirA);
    if (a === null) return false;
    return a === norm(dirB);
}

function _resolveReceiverTypeIdentity(index, filePath, knownType, targetDefs) {
    const typeDefs = (index.symbols.get(knownType) || []).filter(d => IDENTITY_TYPE_KINDS.has(d.type));
    if (typeDefs.length <= 1) return 'target';
    const targetDirs = new Set(targetDefs.map(d => d.file && path.dirname(d.file)).filter(Boolean));
    const inTargetPkg = (d) => d.file && targetDirs.has(path.dirname(d.file));
    const sameFile = typeDefs.filter(d => d.file === filePath);
    if (sameFile.length > 0) return sameFile.some(inTargetPkg) ? 'target' : 'other';
    const callerDir = path.dirname(filePath);
    const sameDir = typeDefs.filter(d => d.file && path.dirname(d.file) === callerDir);
    if (sameDir.length > 0) return sameDir.some(inTargetPkg) ? 'target' : 'other';
    const imports = index.importGraph.get(filePath);
    if (imports) {
        const imported = typeDefs.filter(d => d.file && imports.has(d.file));
        if (imported.length > 0) return imported.some(inTargetPkg) ? 'target' : 'other';
    }
    return 'unknown';
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
function _declaredFieldType(index, rootType, fieldName, language) {
    const defs = index.symbols.get(fieldName);
    if (!defs) return null;
    // 'private field' (JS #-fields, fix #219): equally compiler-true, and
    // safer — nothing outside the class can rebind them.
    const fields = defs.filter(d =>
        (d.type === 'field' || d.memberType === 'field' || d.memberType === 'private field') &&
        d.className === rootType && d.fieldType);
    if (fields.length === 0) return null;
    const normalized = new Set();
    for (const f of fields) {
        const t = _normalizeFieldTypeName(f.fieldType, language);
        if (t) normalized.add(t);
        else return null; // any un-normalizable declaration → no evidence
    }
    if (normalized.size !== 1) return null; // same-named classes disagree
    const typeName = [...normalized][0];
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
    if (!/^[A-Z]/.test(receiver)) return null;
    let typeDefs = typeKindsOf(receiver);
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
        if (language === 'java' && /[a-z]/.test(receiver) &&
            !_isGenericParamReceiverType(index, def.file, call.line, receiver)) {
            return { external: true };
        }
        return null;
    }
    if (traits?.typeSystem === 'structural') {
        const inFile = typeDefs.some(d => d.file === def.file);
        const bound = (fileEntry?.bindings || []).some(b => b.name === receiver);
        if (!inFile && !bound) return null;
    }
    // Alias closure (#208): a pure alias set agreeing on one base is the
    // SAME type — the method may live on the base's inherent impl.
    const candidateTypes = [receiver];
    if (typeDefs.every(d => d.type === 'type' && d.aliasOf)) {
        const bases = new Set(typeDefs.map(d => d.aliasOf));
        if (bases.size === 1) candidateTypes.push(bases.values().next().value);
    }
    const symbols = index.symbols.get(call.name) || [];
    const isCallable = (s) => !NON_CALLABLE_TYPES.has(s.type) ||
        (s.type === 'field' && s.fieldType && /^func\b/.test(s.fieldType));
    const matchOn = (tn) => symbols.find(s => isCallable(s) &&
        (s.className === tn || (s.receiver && s.receiver.replace(/^\*/, '') === tn)));
    let match = null;
    let matchedType = null;
    for (const tn of candidateTypes) {
        match = matchOn(tn);
        if (match) { matchedType = tn; break; }
    }
    if (!match && traits?.typeSystem === 'nominal') {
        for (const tn of candidateTypes) {
            const parentNames = index._getInheritanceParents?.(tn, def.file);
            if (!parentNames) continue;
            for (const pName of parentNames) {
                match = matchOn(pName);
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

function _calleeLanguageCompatible(index, def, callerLanguage) {
    if (!callerLanguage) return true;
    const defLang = index.files.get(def.file)?.language;
    if (!defLang || defLang === callerLanguage) return true;
    return _JS_CALLABLE_FAMILY.has(defLang) && _JS_CALLABLE_FAMILY.has(callerLanguage);
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
    const head = _structuralTypeHead(raw) || raw;
    const norm = _PY_TYPING_BUILTINS[head] || head;
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

function _calleeSingleOwnerMatch(index, def, fileEntry, call, name, language, flowEntry) {
    if (JS_GLOBAL_RECEIVERS.has(call.receiver)) return null;
    if (call.receiverIsModule) return null;
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
        const head = _structuralTypeHead(call.receiverType) || call.receiverType;
        const norm = _PY_TYPING_BUILTINS[head] || head;
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
    const traits = langTraits(language);
    const selfNames = new Set((traits?.selfParam || [])
        .map(s => String(s).replace(/&|mut\s*/g, '').trim()));
    let sawComparable = false;
    for (const def of targetDefs) {
        if (NON_CALLABLE_TYPES.has(def.type)) return true;
        const ps = def.paramsStructured;
        if (!Array.isArray(ps)) return true;
        if (ps.some(p => p && p.rest)) return true;
        const params = ps.filter((p, i) => !(i === 0 && p &&
            selfNames.has(String(p.name || '').replace(/&|mut\s*/g, '').trim())));
        const isMethodDef = !!(def.className || def.receiver);
        // The receiver-as-first-arg shift applies only to call shapes that
        // can actually be unbound: Rust UFCS (Type::method(&x)) and Go
        // method expressions (Type.Method(recv)) — the receiver text IS the
        // type. Java has no unbound instance-call form.
        const defType = def.className || (def.receiver || '').replace(/^\*/, '');
        const unboundForm = call.isPathCall || (!!call.receiver && call.receiver === defType);
        const max = params.length + (isMethodDef && unboundForm ? 1 : 0);
        const min = params.filter(p => p && !p.optional && p.default === undefined).length;
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
};

/**
 * Can an argument of static kind `kind` (from the Java parser's argKinds)
 * bind a parameter declared as `paramType`? Unknown kinds ('expr',
 * 'lambda'), unknown/generic param types, and unresolvable hierarchies all
 * match — a mismatch must be provable to count.
 */
function _javaArgKindMatches(index, kind, paramType) {
    if (!kind || kind === 'expr' || kind === 'lambda') return true;
    if (!paramType) return true;
    const bare = String(paramType).replace(/<.*$/s, '').trim()
        .replace(/\.\.\.$/, '').replace(/\[\]$/, '').split('.').pop();
    if (!bare || bare === 'Object') return true;
    if (/^[A-Z][0-9]?$/.test(bare)) return true; // generic type variable (T, E, K1...)
    if (kind === 'null') return !JAVA_PRIMITIVES.has(bare);
    if (kind.startsWith('new:') || kind.startsWith('cast:')) {
        const t = kind.slice(kind.indexOf(':') + 1);
        if (t === bare) return true;
        const tDefs = (index.symbols.get(t) || [])
            .filter(d => d.type === 'class' || d.type === 'interface');
        if (tDefs.length === 0) return true; // external arg type — unknowable
        const asTarget = [{ className: t, file: tDefs[0].file }];
        if (_isDispatchAncestor(index, bare, asTarget)) return true;
        // Deny only when t's ancestry is fully project-visible — a chain
        // that dead-ends external may still reach paramType.
        return !_targetAncestryFullyResolved(index, asTarget);
    }
    const allowed = JAVA_KIND_TYPES[kind];
    if (!allowed) return true;
    return allowed.includes(bare);
}

/** Is overload `def` applicable to this call's static argument shape? */
function _overloadApplicable(index, call, def) {
    const ps = def.paramsStructured;
    if (!Array.isArray(ps)) return true;
    const hasRest = ps.some(p => p && p.rest);
    const min = ps.filter(p => p && !p.optional && p.default === undefined && !p.rest).length;
    if (call.argCount < min) return false;
    if (!hasRest && call.argCount > ps.length) return false;
    const kinds = call.argKinds;
    if (!Array.isArray(kinds)) return true;
    for (let i = 0; i < kinds.length && i < ps.length; i++) {
        const p = ps[i];
        if (!p || p.rest) break;
        if (!_javaArgKindMatches(index, kinds[i], p.type)) return false;
    }
    return true;
}

/**
 * Overload discipline (Java): when the pinned target has same-class sibling
 * overloads, decide what the call site's static argument shape proves.
 * Returns 'other-overload' (binds a sibling — exclusion evidence),
 * {ambiguous, candidates} (cannot tell — visible unverified), or null
 * (no siblings / uniquely the pinned one / model has no opinion).
 */
function _overloadDiscipline(index, call, targetDefs, definitions) {
    const targetOwners = new Set(targetDefs.map(d => d.className).filter(Boolean));
    if (targetOwners.size === 0) return null;
    const family = definitions.filter(d => !NON_CALLABLE_TYPES.has(d.type) &&
        d.className && targetOwners.has(d.className));
    if (family.length <= 1) return null;
    const pinnedKeys = new Set(targetDefs.map(d => `${d.file}:${d.startLine}`));
    if (family.every(d => pinnedKeys.has(`${d.file}:${d.startLine}`))) return null;
    const applicable = family.filter(d => _overloadApplicable(index, call, d));
    if (applicable.length === 0) return null; // shape fits nothing we model — no claim
    const pinnedApplicable = applicable.some(d => pinnedKeys.has(`${d.file}:${d.startLine}`));
    if (!pinnedApplicable) return 'other-overload';
    if (applicable.length === 1) return null; // uniquely the pinned overload
    return { ambiguous: true, candidates: applicable.length };
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
        if (td.className) targetTypes.add(td.className);
        if (td.receiver) targetTypes.add(td.receiver.replace(/^\*/, ''));
    }
    if (targetTypes.size > 0) {
        const queue = [...targetTypes];
        while (queue.length > 0) {
            const children = index.extendedByGraph?.get(queue.pop());
            if (!children) continue;
            for (const child of children) {
                const cName = typeof child === 'string' ? child : child.name;
                if (!cName || targetTypes.has(cName)) continue;
                const overrides = definitions.some(d => d.className === cName);
                if (overrides) continue;
                targetTypes.add(cName);
                queue.push(cName);
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
                    if (base === null) base = d.aliasOf;
                    else if (base !== d.aliasOf) { pure = false; break; }
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
    if (traits.allMethodsVirtual) {
        return _isDispatchAncestor(index, typeName, targetDefs);
    }
    return false;
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
function _declaredFieldInterfaceType(index, rootType, fieldName, language) {
    const defs = index.symbols.get(fieldName);
    if (!defs) return null;
    const fields = defs.filter(d =>
        (d.type === 'field' || d.memberType === 'field') &&
        d.className === rootType && d.fieldType);
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
    if (language === 'java') {
        const m = t.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:<.*>)?$/s);
        if (!m) return null;
        return m[1].split('.').pop();
    }
    if (langTraits(language)?.typeSystem === 'structural') {
        // JS/TS/Python (fix #219): compiler-true annotation heads, value-
        // position semantics — a field declared Promise<X> HOLDS a Promise.
        return _structuralTypeHead(t);
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
    if (t.includes('|')) {
        const parts = t.split('|').map(s => s.trim())
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
    return _PY_TYPING_BUILTINS[last] || last;
}

// Structural annotation heads that carry no receiver identity: TS escape
// hatches, the receiver-polymorphic `this`/`Self`, and Python's object root.
const _STRUCTURAL_FLOW_REJECT = new Set([
    'any', 'unknown', 'object', 'void', 'never', 'undefined', 'null',
    'this', 'Self', 'Object', 'None',
]);

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
    let producer = null;
    let selfClass;
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
        // Method producer: every same-name method def project-wide must carry
        // an annotation and agree (#219 discipline — whichever class
        // dispatches, the type is the same).
        const methodDefs = defs.filter(d => d.className || d.receiver);
        if (methodDefs.length === 0) return null;
        if (!methodDefs.every(d => d.returnType)) return null;
        if (new Set(methodDefs.map(d => d.returnType)).size !== 1) return null;
        producer = methodDefs[0];
        const classes = new Set(methodDefs.map(d =>
            d.className || (d.receiver || '').replace(/^\*/, '')));
        selfClass = classes.size === 1 ? [...classes][0] : undefined;
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
    for (const d of producers) {
        const h = _structuralTypeHead(d.returnType, { unwrapAsync: call.receiverCallAwaited });
        if (!h) return null;
        heads.add(h);
        if (heads.size > 1) return null;
    }
    const head = [...heads][0];
    if (/^[A-Z][A-Z0-9]?$/.test(head)) return null; // generic type param (T, K, V1)
    if (_STRUCTURAL_FLOW_REJECT.has(head)) return null;
    return head;
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
        let h = _structuralTypeHead(d.returnType, { unwrapAsync: opts.consumerAwaited });
        if (h === 'this' || h === 'Self') h = selfType;
        if (!h) return null;
        heads.add(h);
        if (heads.size > 1) return null;
    }
    const head = [...heads][0];
    if (/^[A-Z][A-Z0-9]?$/.test(head)) return null; // generic type param
    if (_STRUCTURAL_FLOW_REJECT.has(head)) return null;
    return { type: head };
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
    if (ctx.visiting.has(record) || ctx.visiting.size > 64) return null;
    ctx.visiting.add(record);
    let out = null;
    try {
        out = _typeOfCallResultFoldInner(index, fileEntry, filePath, record, ctx, consumerAwaited);
    } finally {
        ctx.visiting.delete(record);
    }
    ctx.memo.set(record, out);
    return out;
}

function _typeOfCallResultFoldInner(index, fileEntry, filePath, record, ctx, consumerAwaited) {
    if (record.isMacro || record.inMacro) return null; // token-tree records carry no chain physics
    const language = fileEntry.language;
    const traits = langTraits(language);
    const nominal = traits?.typeSystem === 'nominal';
    const name = record.name;

    // Path producer (Rust): Command::new(...) — the last path segment names
    // the impl type (flow-map rails: module-path producers stay untyped);
    // Self::new() resolves through the enclosing impl. The type's identity
    // is pinned from THIS file's scope (#206 discipline — clap's derive
    // tests define dozens of local `struct Command` fixtures; the pin keeps
    // the fold on the imported one).
    if (nominal && record.isPathCall && record.receiver) {
        const segs = String(record.receiver).split('::');
        let seg = segs.pop();
        if (seg === 'Self') {
            const enclosing = index.findEnclosingFunction(filePath, record.line, true);
            seg = enclosing && enclosing.className;
            if (!seg) return null;
        }
        if (!seg || !/^[A-Z]/.test(seg)) return null;
        if (/^[A-Z][A-Z0-9]?$/.test(seg)) return null; // generic-param convention (#220)
        const qual = segs.length > 0 ? segs[segs.length - 1] : undefined;
        const origin = _resolveFlowTypeOrigin(index, filePath, seg,
            qual && !['crate', 'self', 'super'].includes(qual) ? qual : undefined);
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
            return { externalVia: `${record.receiver}.${name}` };
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
    if (!nominal && record.isMethod && record.receiver && record.receiverIsModule) {
        const binding = (fileEntry?.importBindings || []).find(b => b.name === record.receiver);
        const rel = binding && fileEntry.moduleResolved && fileEntry.moduleResolved[binding.module];
        if (binding && !rel) {
            const mod = String(binding.module);
            const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
            if (!mod.startsWith('.') &&
                !(firstSeg && _projectTopLevelNames(index).has(firstSeg))) {
                return { externalVia: `${record.receiver}.${name}` };
            }
            return null;
        }
        if (!rel) return null;
        const modFile = path.join(index.root, rel);
        const cands = (index.symbols.get(name) || [])
            .filter(d => !NON_CALLABLE_TYPES.has(d.type) && d.returnType && !d.className);
        let matches = cands.filter(d => d.file === modFile);
        if (matches.length === 0) {
            const hop = index.importGraph.get(modFile);
            if (hop) matches = cands.filter(d => hop.has(d.file));
        }
        if (matches.length === 0) return null;
        if (language === 'python' && !consumerAwaited && matches.some(d => d.isAsync)) return null;
        const heads = new Set();
        for (const d of matches) {
            const h = _structuralTypeHead(d.returnType, { unwrapAsync: consumerAwaited });
            if (!h) return null;
            heads.add(h);
        }
        if (heads.size !== 1) return null;
        const head = [...heads][0];
        if (/^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
        return { type: head };
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
            rt = { type: record.receiverType };
        }
        if (!rt && record.receiverCall && (!record.receiver || record.receiverIsChainRoot)) {
            rt = _foldChainedReceiverType(index, fileEntry, filePath, record, ctx);
        }
        if (!rt && record.receiver && !record.receiverIsChainRoot) {
            const flowMap = ctx.getFlowMap();
            const fe = flowMap && _lookupReturnTypeFlow(flowMap, record);
            if (fe && fe.externalVia) return { externalVia: fe.externalVia };
            if (fe && fe.type) rt = { type: fe.type, ...(fe.fromFile && { fromFile: fe.fromFile }) };
        }
        if (rt && rt.externalVia) return rt;
        if (rt && rt.type) {
            return _methodReturnOnType(index, rt.type, rt.fromFile, name, language,
                { filePath, consumerAwaited });
        }
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
            const h = _structuralTypeHead(d.returnType, { unwrapAsync: consumerAwaited });
            if (!h) return null;
            heads.add(h);
            if (heads.size > 1) return null;
        }
        const head = [...heads][0];
        if (/^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
        return { type: head };
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
        const parsed = _returnTypeNameNominal(chosen.returnType, language, {});
        if (!parsed) return null;
        const origin = _resolveFlowTypeOrigin(index, chosen.file || filePath, parsed.name, parsed.qualifier);
        if (!origin) return null;
        return { type: parsed.name, ...(origin.fromFile && { fromFile: origin.fromFile }) };
    }
    if (language === 'python' && !consumerAwaited && chosen.isAsync) return null;
    let head = _structuralTypeHead(chosen.returnType, { unwrapAsync: consumerAwaited });
    if (!head || /^[A-Z][A-Z0-9]?$/.test(head) || _STRUCTURAL_FLOW_REJECT.has(head)) return null;
    return { type: head };
}

/**
 * Type the RECEIVER of a chained call from its producer's own record
 * (fix #258). Producer records are matched by (receiverCallLine, name) —
 * when several match (one-line chains like `a.arg(1).arg(2)`), ALL must fold
 * to the same type or the receiver stays untyped. Returns { type, fromFile },
 * { externalVia }, or null (fall back to the legacy one-hop helpers).
 */
function _foldChainedReceiverType(index, fileEntry, filePath, call, ctx) {
    if (!call.receiverCall || !call.receiverCallLine || !ctx.records) return null;
    const prods = ctx.records.filter(r =>
        r !== call && r.line === call.receiverCallLine && r.name === call.receiverCall &&
        !r.isMacro && !r.inMacro &&
        // Kind match: the consumer knows whether its producer was a method-
        // shaped call — `.arg(arg("x"))` has both a chained method `arg` and
        // a plain closure call `arg` on one line; only the right kind folds.
        !!r.isMethod === !!call.receiverCallIsMethod);
    if (prods.length === 0) return null;
    const results = prods.map(r =>
        _typeOfCallResultFold(index, fileEntry, filePath, r, ctx, call.receiverCallAwaited));
    if (!results.every(Boolean)) return null;
    if (results.every(r => r.externalVia)) return { externalVia: results[0].externalVia };
    if (results.some(r => r.externalVia)) return null;
    if (new Set(results.map(r => r.type)).size !== 1) return null;
    const fromFiles = new Set(results.map(r => r.fromFile));
    return { type: results[0].type, ...(fromFiles.size === 1 && results[0].fromFile && { fromFile: results[0].fromFile }) };
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
    let _cachedLines = null;

    for (const call of calls) {
        if (call.line < def.startLine || call.line > def.endLine) continue;

        // Collect receiverType from method calls (inferred by parser from params/receivers)
        if (call.isMethod && call.receiver && call.receiverType) {
            localTypes.set(call.receiver, call.receiverType);
        }

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
                }
            }
        }
    }

    return localTypes.size > 0 ? localTypes : null;
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

            const langModule = getLanguageModule(language);
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

module.exports = { getCachedCalls, findCallers, findCallees, getInstanceAttributeTypes, findCallbackUsages, _nameBindingReaches, _declaredFieldType, _projectTopLevelNames };
