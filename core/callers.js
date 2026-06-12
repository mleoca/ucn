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
const { NON_CALLABLE_TYPES } = require('./shared');
const { scoreEdge, tierForResolution, TIER } = require('./confidence');

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

    // Conservation accounting (grep-reliability contract): when collectAccount
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
                if (NON_CALLABLE_TYPES.has(d.type)) continue;
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
    // unverified-tier entry (grep-reliability contract: shown in its own
    // section, never silently hidden). Does NOT count toward pendingCount —
    // totals describe the confirmed answer.
    const routeUnverified = (filePath, fileEntry, call, reason, calledAs, meta) => {
        if (!collectAccount) return; // non-account paths (trace/blast/verify) keep the plain drop
        if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
        pendingByFile.get(filePath).push({
            call, fileEntry, callerSymbol: null,
            isMethod: call.isMethod || false, isFunctionReference: false,
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
                    (langTraits(fileEntry.language)?.typeSystem === 'structural' ||
                        (collectAccount && !call.isPotentialCallback && !call.isPathCall &&
                            langTraits(fileEntry.language)?.typeSystem === 'nominal'))) {
                    let flowMap = returnFlowCache.get(filePath);
                    if (flowMap === undefined) {
                        flowMap = _buildReturnTypeFlowMap(index, filePath, calls);
                        returnFlowCache.set(filePath, flowMap);
                    }
                    const flowEntry = flowMap && _lookupReturnTypeFlow(flowMap, call);
                    if (flowEntry) {
                        call = { ...call, receiverType: flowEntry.type,
                            ...(flowEntry.fromFile && { receiverTypeFlowFile: flowEntry.fromFile }) };
                    }
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
                        cbTargetDefs.some(d => d.file && path.dirname(d.file) === path.dirname(filePath));
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
                // Skip binding resolution for calls with non-self/this/cls receivers:
                // e.g., analyzer.analyze_instrument() should NOT resolve to a local
                // standalone function def `analyze_instrument` — they're different symbols.
                // Also skip for Go package-qualified calls (isMethod:false but has receiver like 'cli')
                const selfReceivers = new Set(['self', 'cls', 'this', 'super']);
                const skipLocalBinding = call.receiver && !selfReceivers.has(call.receiver);
                if (!bindingId && !skipLocalBinding) {
                    let bindings = (fileEntry.bindings || []).filter(b => b.name === call.name);
                    // For Go, also check sibling files in same directory (same package scope)
                    if (bindings.length === 0 && langTraits(fileEntry.language)?.packageScope === 'directory') {
                        const dir = path.dirname(filePath);
                        const siblings = index.dirToFiles?.get(dir) || [];
                        for (const fp of siblings) {
                            if (fp !== filePath) {
                                const fe = index.files.get(fp);
                                if (fe) {
                                    const sibling = (fe.bindings || []).filter(b => b.name === call.name);
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
                            if (!options.includeMethods) {
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
                                resolvedBySameClass = true;
                            } else if (!options.includeMethods) {
                                routeUnverified(filePath, fileEntry, call, 'method-no-evidence', calledAs);
                                continue;
                            }
                        }
                    } else if (['self', 'cls', 'this', 'super'].includes(call.receiver)) {
                        // self/this/super.method() — resolve to same-class or parent method
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) {
                            if (!options.includeMethods) {
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
                                    if (!targetClasses.has(matchedClass) &&
                                        !_isAncestorOfTargetClass(index, matchedClass, tDefs) &&
                                        !(fileEntry.language === 'python' &&
                                            _shareProjectDescendant(index, matchedClass, targetClasses))) {
                                        recordExcluded(filePath, call.line, 'other-definition');
                                        continue;
                                    }
                                }
                                resolvedBySameClass = true;
                            } else if (!options.includeMethods) {
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

                // Declared-field receiver typing (fix #202): one-hop field
                // receivers (self.dent.path() / h.inner.Run() /
                // this.service.execute()) resolve through the field's DECLARED
                // type. Computed before binding checks — name-bindings don't
                // model receivers, so a same-file `path` binding must not
                // claim a call whose receiver field is typed elsewhere.
                let fieldHopType = null;
                if (call.isMethod && !call.receiverType && call.receiverField && call.receiverRootType &&
                    !resolvedBySameClass &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    fieldHopType = _declaredFieldType(index, call.receiverRootType, call.receiverField, fileEntry.language);
                }
                // Dispatch attribution (contract surface only): a field DECLARED
                // as a project interface/trait carries no exclusion evidence
                // (_declaredFieldType returns null — any implementor may receive
                // the call), but it IS positive evidence of possible dispatch.
                // Resolved separately so the unverified tier can attribute the
                // edge: "possible-dispatch via <Interface> — 1 of N impls".
                let fieldDispatchType = null;
                if (collectAccount && fieldHopType === null &&
                    call.isMethod && !call.receiverType && call.receiverField && call.receiverRootType &&
                    !resolvedBySameClass &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    fieldDispatchType = _declaredFieldInterfaceType(index, call.receiverRootType, call.receiverField, fileEntry.language);
                }

                // Skip uncertain calls unless resolved by same-class matching or explicitly requested
                if (isUncertain && !resolvedBySameClass && !options.includeUncertain) {
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
                    if (nameBindings.length > 0 && !tFiles.has(filePath)) {
                        let reaches = false;
                        let projectish = false;
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
                                    projectish = true;
                                }
                                continue;
                            }
                            // Resolved to a project file: even if the target is
                            // not reachable within the BFS hop budget, the chain
                            // may continue past it — never exclusion evidence.
                            projectish = true;
                            const resolvedAbs = path.join(index.root, rel);
                            if (_importReaches(index, resolvedAbs, tFiles)) { reaches = true; break; }
                        }
                        if (!reaches && !projectish) {
                            // Every import binding of this name points at an
                            // EXTERNAL module — the bare name is rebound away
                            // from the project def (compiler-checked).
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
                if (!bindingId && !resolvedBySameClass && !call.isPathCall &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    const targetHasClass = targetDefs.some(d => d.className);
                    if (call.isMethod && !targetHasClass) {
                        // Method call but target is a standalone function — skip
                        recordExcluded(filePath, call.line, 'method-kind-mismatch');
                        continue;
                    }
                    if (!call.isMethod && targetHasClass) {
                        // Non-method call but target is a class method — skip
                        recordExcluded(filePath, call.line, 'method-kind-mismatch');
                        continue;
                    }
                }

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
                if (!bindingId && !resolvedBySameClass && call.isMethod && call.receiverIsModule &&
                    call.receiver && langTraits(fileEntry.language)?.typeSystem === 'structural' &&
                    (fileEntry.importBindings || []).length > 0) {
                    const recvBindings = fileEntry.importBindings.filter(b => b.name === call.receiver);
                    const tFiles = new Set(targetDefs.map(d => d.file).filter(Boolean));
                    if (recvBindings.length > 0 && !tFiles.has(filePath)) {
                        let reaches = false;
                        let projectish = false;
                        for (const b of recvBindings) {
                            const rel = fileEntry.moduleResolved && fileEntry.moduleResolved[b.module];
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
                            if (_importReaches(index, resolvedAbs, tFiles)) { reaches = true; break; }
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
                        const knownType = call.receiverType || fieldHopType;
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
                                        const inferredType = localTypes.get(call.receiver);
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
                            if (!inferredMatch && !inferredMismatch && definitions.length > 1 && !fieldDispatchType) {
                                const receiverLower = call.receiver.toLowerCase();
                                const matchesTarget = [...targetTypes].some(cn => cn.toLowerCase() === receiverLower);
                                if (!matchesTarget) {
                                    // Rust/Go path calls (Type::method() / pkg.Method()): receiver IS the type name
                                    // If it doesn't match target, it's definitely a different type — filter it
                                    if (call.isPathCall && /^[A-Z]/.test(call.receiver)) {
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
                if (collectAccount && !bindingId && !resolvedBySameClass &&
                    call.argCount != null && !call.argSpread &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                    !_callArityCompatible(call, targetDefs, fileEntry.language)) {
                    recordExcluded(filePath, call.line, 'arity-mismatch');
                    continue;
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
                    targetDefs2.some(d => d.file && path.dirname(d.file) === path.dirname(filePath));

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
                const receiverBlindBinding = !!bindingId && call.isMethod && !call.receiver;
                if (collectAccount && call.isMethod && (!bindingId || receiverBlindBinding) && !resolvedBySameClass &&
                    !receiverTypeValidated && !nominalInferredMatch &&
                    langTraits(fileEntry.language)?.typeSystem === 'nominal') {
                    const tTypes = dispatchTargetTypes(targetDefs2);
                    // A receiver that shares the target type's NAME is only
                    // type-qualified when the call matches the language's
                    // qualified-call syntax (typeQualifiedCallStyle trait):
                    // Rust requires Type::method (a dot-call receiver matching
                    // a type name is a variable); Go method expressions
                    // T.M(recv, ...) pass the receiver as the first argument,
                    // so a zero-arg call on a type-named receiver is a
                    // variable, not the type (grpc-go's `bb` collision).
                    let typeQualifiedReceiver = !!(call.receiver && tTypes.has(call.receiver));
                    if (typeQualifiedReceiver) {
                        const qualStyle = langTraits(fileEntry.language)?.typeQualifiedCallStyle;
                        if (qualStyle === 'path') typeQualifiedReceiver = !!call.isPathCall;
                        else if (qualStyle === 'method-expr') typeQualifiedReceiver = call.argCount == null || call.argCount >= 1;
                    }
                    if (!typeQualifiedReceiver) {
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
                    // whose module doesn't reach the target.
                    if (call.isMethod && !call.receiverIsModule) {
                        const tTypes = dispatchTargetTypes(targetDefs2);
                        const typeQualifiedReceiver = !!(call.receiver && tTypes.has(call.receiver));
                        if (!typeQualifiedReceiver && methodOwnerKeys().size > 1) {
                            if (call.receiverType) {
                                // Known-but-unvalidated type (supertype of the
                                // target — dynamic dispatch — or an alias/
                                // interface name UCN can't validate): a
                                // possible dispatch edge, attributed via the
                                // receiver's declared type (#204 physics).
                                routeUnverified(filePath, fileEntry, call, 'possible-dispatch', calledAs, {
                                    dispatchVia: call.receiverType,
                                    dispatchCandidates: countDispatchCandidates(call.receiverType),
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

                if (!pendingByFile.has(filePath)) pendingByFile.set(filePath, []);
                pendingByFile.get(filePath).push({
                    call, fileEntry, callerSymbol,
                    isMethod: call.isMethod || false, isFunctionReference: false,
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
                    ...(receiver !== undefined && { receiver }),
                    ...(receiverType && { receiverType }),
                    ...(calledAs && { calledAs }),
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
                    ...(calledAs && { calledAs }),
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
                ...(calledAs && { calledAs }),
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
            if (a.relativePath !== b.relativePath) return a.relativePath.localeCompare(b.relativePath);
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

        // Build local variable type map for receiver resolution
        // Scans for patterns like: bt = Backtester(...) → bt maps to Backtester
        let localTypes = null;
        if (langTraits(language)?.typeSystem === 'structural') {
            localTypes = _buildLocalTypeMap(index, def, calls);
        } else if (langTraits(language)?.typeSystem === 'nominal') {
            localTypes = _buildTypedLocalTypeMap(index, def, calls);
        }

        for (const call of calls) {
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

            // Smart method call handling:
            // - Go: include all method calls (Go doesn't use this/self/cls)
            // - self/this.method(): resolve to same-class method (handled below)
            // - Python self.attr.method(): resolve via selfAttribute (handled below)
            // - Other languages: skip method calls unless explicitly requested
            if (call.isMethod) {
                if (call.selfAttribute && language === 'python') {
                    // Will be resolved in second pass below
                } else if (['self', 'cls', 'this'].includes(call.receiver)) {
                    // self.method() / cls.method() / this.method() — resolve to same-class method below
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
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1 });
                        }
                    }
                    continue;
                } else if (call.receiverType) {
                    // Use parser-inferred receiverType for method resolution
                    // Go/Java/Rust: from param/receiver type declarations
                    // JS/TS: from `new Foo()` assignments or TypeScript type annotations
                    // Python: from constructor calls or type annotations
                    const typeName = call.receiverType;
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
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1 });
                        }
                        continue;
                    }
                    // No match found with inferred type — fall through to include as unresolved
                } else if (langTraits(language)?.hasReceiverPackageCalls && call.receiver) {
                    // Go package-qualified calls: klog.Infof(), wait.UntilWithContext()
                    // Check if receiver is an import alias and resolve to correct package
                    const goImports = fileEntry?.imports || [];
                    // Find import whose package name matches the receiver
                    // Handle Go version suffixes: k8s.io/klog/v2 → klog, not v2
                    const importModule = goImports.find(mod => {
                        const parts = mod.split('/');
                        const last = parts[parts.length - 1];
                        const pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
                        return pkgName === call.receiver;
                    });
                    if (importModule) {
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
                                } else {
                                    callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1 });
                                }
                                continue;
                            }
                        }
                        // Import resolved but no project definition matches — external call, skip
                        continue;
                    }
                } else if (langTraits(language)?.methodCallInclusion === 'explicit' && !options.includeMethods) {
                    continue;
                }
            }

            // Skip keywords and built-ins
            if (index.isKeyword(call.name, language)) continue;

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
                    continue;
                }
                const hasBinding = fileEntry?.bindings?.some(b => b.name === call.name);
                const inSameFile = syms.some(s => s.file === def.file);
                if (!hasBinding && !inSameFile) {
                    continue;
                }
            }

            // Collect selfAttribute calls for second-pass resolution
            if (call.selfAttribute && language === 'python') {
                if (!selfAttrCalls) selfAttrCalls = [];
                selfAttrCalls.push(call);
                continue;
            }

            // Collect self/this.method() calls for same-class resolution
            if (call.isMethod && ['self', 'cls', 'this'].includes(call.receiver)) {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push(call);
                continue;
            }

            // Collect super().method() calls for parent-class resolution
            if (call.isMethod && call.receiver === 'super') {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push(call);
                continue;
            }

            // Resolve binding within this file (without mutating cached call objects)
            let calleeKey = call.bindingId || effectiveName;
            let bindingResolved = call.bindingId;
            let isUncertain = call.uncertain;
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
                    } else {
                        // Go/Java/Rust: nominal type systems make single-def method links
                        // reliable. Only mark uncertain when multiple definitions exist
                        // (cross-type ambiguity, e.g. TypeA.Length vs TypeB.Length).
                        const defs = index.symbols.get(call.name);
                        if (defs && defs.length > 1) {
                            // Go: if receiverType is known, check if it matches exactly one def
                            // This resolves ambiguity like Framework.Run vs Scheduler.Run
                            const rType = call.receiverType || localTypes?.get(call.receiver);
                            if (rType && langTraits(language)?.typeSystem === 'nominal') {
                                const matchingDef = defs.find(d =>
                                    d.className === rType ||
                                    (d.receiver && d.receiver.replace(/^\*/, '') === rType));
                                if (matchingDef) {
                                    // Resolved to specific type — not uncertain
                                    calleeKey = matchingDef.bindingId || `${rType}.${call.name}`;
                                    bindingResolved = matchingDef.bindingId;
                                } else {
                                    isUncertain = true;
                                }
                            } else {
                                isUncertain = true;
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
                        // Add ALL other overloads as potential callees
                        const otherBindings = bindings.filter(b =>
                            b.startLine !== def.startLine
                        );
                        for (const ob of otherBindings) {
                            const existing = callees.get(ob.id);
                            if (existing) {
                                existing.count += 1;
                            } else {
                                callees.set(ob.id, {
                                    name: effectiveName,
                                    bindingId: ob.id,
                                    count: 1
                                });
                            }
                        }
                        continue; // Already added all overloads, skip normal add
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
                            }
                        } else {
                            isUncertain = true;
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
                        }
                    }
                }
            }

            if (isUncertain && !options.includeUncertain) {
                if (options.stats) options.stats.uncertain = (options.stats.uncertain || 0) + 1;
                continue;
            }

            const existing = callees.get(calleeKey);
            if (existing) {
                existing.count += 1;
            } else {
                callees.set(calleeKey, {
                    name: effectiveName,
                    bindingId: bindingResolved,
                    count: 1,
                    ...(call.isConstructor && { isConstructor: true })
                });
            }
        }

        // Second pass: resolve Python self.attr.method() calls
        // Respect includeMethods=false — skip self/this method resolution entirely
        if (selfAttrCalls && def.className && options.includeMethods !== false) {
            const attrTypes = getInstanceAttributeTypes(index, def.file, def.className);
            for (const call of selfAttrCalls) {
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
                    if (!targetClass) continue;

                    // Find method in symbol table where className matches
                    const symbols = index.symbols.get(call.name);
                    if (!symbols) continue;

                    const match = symbols.find(s => s.className === targetClass);
                    if (!match) continue;

                    const key = match.bindingId || `${targetClass}.${call.name}`;
                    const existing = callees.get(key);
                    if (existing) {
                        existing.count += 1;
                    } else {
                        callees.set(key, {
                            name: call.name,
                            bindingId: match.bindingId,
                            count: 1
                        });
                    }
                }
        }

        // Third pass: resolve self/this/super.method() calls to same-class or parent methods
        // Falls back to walking the inheritance chain if not found in same class
        // Respect includeMethods=false — skip self/this method resolution entirely
        if (selfMethodCalls && def.className && options.includeMethods !== false) {
            for (const call of selfMethodCalls) {
                const symbols = index.symbols.get(call.name);
                if (!symbols) continue;

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

                if (!match) continue;

                const key = match.bindingId || `${match.className}.${call.name}`;
                const existing = callees.get(key);
                if (existing) {
                    existing.count += 1;
                } else {
                    callees.set(key, {
                        name: call.name,
                        bindingId: match.bindingId,
                        count: 1
                    });
                }
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

        for (const { name: calleeName, bindingId, count, isConstructor } of callees.values()) {
            const symbols = index.symbols.get(calleeName);
            if (symbols && symbols.length > 0) {
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
                    if (!isFuncField && !isConstructor) continue;
                }

                // Skip test-file callees when caller is production code and
                // there's no binding (import) evidence linking them
                if (!callerIsTest && !bindingId) {
                    const calleeFileEntry = index.files.get(callee.file);
                    if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                        continue;
                    }
                }

                const calleeScored = scoreEdge({
                    hasBindingId: !!bindingId,
                    hasImportEvidence: !!bindingId || (symbols && symbols.length === 1) ||
                        (callee.file === def.file) || callerImportSet.has(callee.file),
                    isUncertain: false, // uncertain callees already filtered above
                });
                result.push({
                    ...callee,
                    callCount: count,
                    weight: index.calculateWeight(count),
                    confidence: calleeScored.confidence,
                    resolution: calleeScored.resolution,
                });
            }
        }

        // Sort by call count (core dependencies first)
        result.sort((a, b) => b.callCount - a.callCount);

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
const BUILTIN_RECEIVER_TYPES = new Set([
    'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'bytes', 'frozenset',
    'Array', 'String', 'Object', 'RegExp', 'Number', 'Boolean', 'Map', 'Set', 'Promise',
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
        // identity is unverifiable from paths, and exclusion requires
        // POSITIVE evidence. Never exclude (a root-module import like
        // `cobra "github.com/spf13/cobra"` must keep confirming root defs
        // regardless of what the checkout directory is named).
        if (!relDir || relDir === '.') return true;
        if (!relDir.startsWith('..') &&
            (importModule === relDir || importModule.endsWith('/' + relDir))) return true;
        const base = path.basename(dir);
        return base === pkgSeg || base === receiver;
    });
    return { importModule, singleSegment: false, targetInPkg };
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
    const fields = defs.filter(d =>
        (d.type === 'field' || d.memberType === 'field') &&
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
    const typeDefs = index.symbols.get(typeName);
    if (typeDefs && typeDefs.some(d => d.type === 'trait' || d.type === 'interface')) return null;
    return typeName;
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
    if (langTraits(language)?.typeSystem !== 'nominal') return false;
    const typeDefs = index.symbols.get(typeName) || [];
    const isIface = typeDefs.some(d => d.type === 'interface' || d.type === 'trait');
    if (isIface) {
        // The interface/trait declares this method → any implementor
        // (recorded or implicit) may receive the call.
        if (definitions.some(d => d.className === typeName)) return true;
        return _isDispatchAncestor(index, typeName, targetDefs);
    }
    if (langTraits(language)?.allMethodsVirtual) {
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
    return null;
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

module.exports = { getCachedCalls, findCallers, findCallees, getInstanceAttributeTypes, findCallbackUsages };
