/**
 * eval/oracles/jdtls-oracle.js - Java oracle via Eclipse JDT language server.
 *
 * Same architecture as the gopls/rust-analyzer oracles: symbol enumeration +
 * reference CLASSIFICATION come from an independent ast helper
 * (JavaAstHelper.java — the JDK's own javac tree API, parse-only, no
 * third-party deps; run via single-file source launch), reference RESOLUTION
 * comes from jdtls textDocument/references rooted at the repository root so
 * every Maven module (gson/, extras/, ...) is in the reference universe.
 *
 * Readiness camp: like rust-analyzer, jdtls imports the project async after
 * initialize and answers early requests from an incomplete index. The
 * barrier is the custom `language/status` notification with type
 * "ServiceReady" (all import/index jobs done).
 *
 * jdtls resolution: $UCN_EVAL_JDTLS, else `jdtls` on PATH. Java resolution:
 * $UCN_EVAL_JAVA, else $JAVA_HOME/bin/java, else `java`, else Homebrew's
 * keg-only openjdk. JDK 17+ required (jdtls and the single-file helper).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_PATH = path.join(__dirname, 'JavaAstHelper.java');
const READY_TIMEOUT_MS = 600000; // first run imports the Maven project

const jdtlsOracle = {
    name: 'jdtls',
    languages: ['java'],

    async prepare(repoDir) {
        const java = resolveJava();
        const jdtls = resolveJdtls();
        // Canonicalize: macOS $TMPDIR lives under /var -> /private/var, and
        // Eclipse resolves workspace resources to CANONICAL paths. A
        // non-canonical textDocument URI misses the workspace resource and
        // references silently return [] (measured — run-to-run flakiness).
        repoDir = fs.realpathSync(repoDir);
        const repoRoot = findRepoRoot(repoDir);

        const helperChild = spawn(java, [HELPER_PATH, repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(helperChild, { label: 'java ast helper' });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) throw new Error(`java ast helper failed to start: ${banner.error}`);

        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jdtls-data-'));
        const compileErrors = new Map();
        let ready;
        const serviceReady = new Promise((resolve, reject) => {
            ready = resolve;
            setTimeout(() => reject(new Error(`jdtls not ServiceReady after ${READY_TIMEOUT_MS}ms`)),
                READY_TIMEOUT_MS).unref();
        });
        const javaHome = path.dirname(path.dirname(java));
        // jdtls wrapper script needs a JDK on PATH/JAVA_HOME
        const lsp2 = new LspClient(jdtls, ['-data', dataDir], {
            timeoutMs: READY_TIMEOUT_MS,
            env: { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}:${process.env.PATH}` },
            onNotification: (method, params) => {
                if (method === 'language/status' && params?.type === 'ServiceReady') ready(params);
                // Compile errors per file, as the build reports them.
                if (method === 'textDocument/publishDiagnostics' && params?.uri) {
                    const errors = (params.diagnostics || []).filter(d => d.severity === 1);
                    compileErrors.set(safeRealpath(uriToPath(params.uri)), errors.length);
                }
            },
        });
        await lsp2.initialize(repoRoot, {
            // Definitions in JDK/library classes come back as jdt:// class
            // file locations only when the client says it can read them;
            // without this jdtls answers nothing for `obj.hashCode()` on an
            // Object receiver, and the edge read as definition-unresolved
            // instead of statically bound to an external member (fix #429).
            extendedClientCapabilities: { classFileContentsSupport: true },
            settings: {
                java: {
                    // autobuild ON: JDT's search engine answers references from
                    // the BUILT index — with autobuild off every query returns []
                    autobuild: { enabled: true },
                    import: { gradle: { enabled: false }, maven: { enabled: true } },
                    // includeAccessors (jdtls default true) adds a field's
                    // getter/setter calls to its references: accessor calls
                    // are not uses of the field (fix #429, value arm).
                    references: { includeDecompiledSources: false, includeAccessors: false },
                },
            },
        });
        process.stdout.write('  waiting for jdtls to import the project (ServiceReady)...\n');
        await serviceReady;
        // Deterministic index barrier, two stages — ServiceReady alone races
        // the background indexer (measured: empty reference sets on EVERY
        // query):
        //  1. java/buildWorkspace and wait for it. Retried: the command's
        //     registration itself races ServiceReady (measured: one run threw
        //     "unsupported method", leaving the index unbuilt).
        //  2. Sentinel poll: a declaration queried with includeDeclaration
        //     MUST return at least itself once the index serves references.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const buildStatus = await lsp2.request('java/buildWorkspace', false);
                if (buildStatus === 0 || buildStatus === 3) {
                    process.stdout.write(`  ⚠ jdtls buildWorkspace status ${buildStatus} (failed/cancelled)\n`);
                }
                break;
            } catch (e) {
                if (attempt === 2) process.stdout.write(`  ⚠ jdtls buildWorkspace unavailable: ${e.message}\n`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        const handle = { lsp: lsp2, helper, root: repoDir, repoRoot, sourcePaths: null, compileErrors };
        // The build path: jdtls compiles and indexes only the source folders
        // of the projects it imported (Maven source/test roots). Java files
        // elsewhere (commons-pool `doc/*.java` examples) are outside the
        // oracle's projection (fix #429).
        handle.sourcePaths = await listSourcePaths(lsp2, 3);
        // jdtls does NOT honor includeDeclaration (measured), so a zero-usage
        // sentinel legitimately returns [] — poll across several symbols; ANY
        // non-empty result proves the search index is serving. Sentinels come
        // from build-path files, one per file: files jdtls never indexes
        // answer [] forever (fix #429: commons-pool's first five methods were
        // all in doc/*.java and failed the run).
        const sentinels = [];
        const sentinelFiles = new Set();
        for (const symbol of (await helper.request({ op: 'list_symbols' })).symbols) {
            if (symbol.kind !== 'method' || sentinelFiles.has(symbol.file) ||
                !onBuildPath(handle, symbol.file)) continue;
            sentinelFiles.add(symbol.file);
            sentinels.push(symbol);
            // Without the build path, more files make it likelier that one
            // is on it.
            if (sentinels.length >= (handle.sourcePaths ? 5 : 20)) break;
        }
        if (sentinels.length > 0) {
            const deadline = Date.now() + 180000;
            let lastError = null;
            polling: for (;;) {
                for (const sentinel of sentinels) {
                    try {
                        const refs = await jdtlsOracle.findReferences(handle, sentinel);
                        if (refs.length > 0) break polling;
                    } catch (e) {
                        lastError = e;
                    }
                }
                if (Date.now() > deadline) {
                    throw new Error('jdtls index never served references (5 sentinels empty after 180s)' +
                        (lastError ? `; last error: ${lastError.message}` : '; queries returned [] throughout'));
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        // The command registers with the project model; once the index
        // serves references it answers (measured: early calls fail).
        if (!handle.sourcePaths) handle.sourcePaths = await listSourcePaths(lsp2, 15);
        if (!handle.sourcePaths) {
            process.stdout.write('  ⚠ jdtls did not list its source paths; every Java file under the root is treated as on the build path\n');
        }
        process.stdout.write(`  jdtls ready (root ${path.relative(repoDir, repoRoot) || '.'}, workspace ${dataDir}` +
            `${handle.sourcePaths ? `, ${handle.sourcePaths.length} source folder(s)` : ''})\n`);
        const erroneous = [...compileErrors.values()].filter(count => count > 0).length;
        if (erroneous > 0) {
            process.stdout.write(`  ⚠ jdtls build reports compile errors in ${erroneous} file(s) (a language level or ` +
                'classpath its project model does not reproduce): definition lookups there abstain\n');
        }

        return handle;
    },

    /** javac-enumerated defs (methods incl. static, classes/enums/records)
     *  in files on jdtls' build path. */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = (resp.symbols || []).filter(s => onBuildPath(handle, s.file));
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** jdtls references at the def-name position, javac-classified.
     *  NO didOpen — jdtls resolves closed files from the workspace index, and
     *  a didOpen racing the project-model update permanently binds the
     *  document to the default (syntax-only) project where references always
     *  return [] (measured — the failure mode of this oracle's first runs). */
    async findReferences(handle, { name, file, line }) {
        const pos = await handle.helper.request({ op: 'name_position', file, line, name });
        const absFile = path.join(handle.root, file);
        const locations = await handle.lsp.request('textDocument/references', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: pos.line - 1, character: pos.utf16Col },
            context: { includeDeclaration: true },
        }) || [];

        const refs = [];
        for (const loc of locations) {
            const refAbs = uriToPath(loc.uri);
            if (!refAbs.startsWith(handle.repoRoot + path.sep)) continue; // jar/decompiled refs
            const relFile = path.relative(handle.root, refAbs);
            const refLine = loc.range.start.line + 1;
            const cls = await handle.helper.request({
                op: 'classify_ref', file: relFile, line: refLine,
                utf16_col: loc.range.start.character, name,
            });
            refs.push({
                file: relFile,
                line: refLine,
                column: loc.range.start.character,
                kind: cls.kind,
            });
        }
        return refs;
    },

    /** Resolve the compiler-selected declaration(s) at a call/reference line.
     *  Eclipse reference search intentionally expands virtual method families;
     *  definition lookup recovers the exact static target for precision and
     *  callee-placement adjudication. */
    async resolveDefinition(handle, { name, file, line, column }) {
        const absFile = path.join(handle.root, file);
        // A unit the oracle's build does not compile (fix #429: gson's
        // Java 17 record tests under a lower test release) is answered by
        // error recovery: `gson.toJson(record)` bound to toJson(JsonElement).
        // No compiler answer there: abstain.
        if ((handle.compileErrors.get(safeRealpath(absFile)) || 0) > 0) return [];
        const source = fs.readFileSync(absFile, 'utf-8').split('\n');
        const sourceLine = source[line - 1] || '';
        const columns = Number.isInteger(column) ? [column] : nameColumns(sourceLine, name);
        const defs = new Map();
        const staticTargets = [];
        for (const character of columns) {
            const locations = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character },
            }) || [];
            // jdtls answers the name of a method reference `T::m` with the
            // functional interface method it converts to (`CharPredicate.test`
            // for `TokenQueue::isIdent`): a declaration that does not spell
            // the name is not the reference's binding (fix #429).
            const methodReference = /::\s*$/.test(sourceLine.slice(0, character));
            for (const loc of Array.isArray(locations) ? locations : [locations]) {
                const uri = loc.targetUri || loc.uri;
                const range = loc.targetSelectionRange || loc.targetRange || loc.range;
                if (!uri || !range) continue;
                if (methodReference && !(await declarationSpells(handle, uri, range.start.line, name))) continue;
                const defAbs = uriToPath(uri);
                if (!defAbs.startsWith(handle.repoRoot + path.sep)) {
                    defs.set(`external:${defAbs}:${range.start.line + 1}`, {
                        file: defAbs,
                        line: range.start.line + 1,
                        external: true,
                    });
                    continue;
                }
                const entry = { file: path.relative(handle.root, defAbs), line: range.start.line + 1 };
                defs.set(`${entry.file}:${entry.line}`, entry);
                staticTargets.push({ uri, position: range.start });
            }
        }
        if (defs.size === 0 && sourceLine.includes('->')) {
            const fallback = await resolveLambdaReceiverMethod(
                handle, { absFile, file, line, name, source, sourceLine });
            for (const entry of fallback) {
                defs.set(`${entry.file}:${entry.line}`, entry);
            }
        }
        // Static definition lookup stops at an interface declaration, but an
        // exactly constructed receiver has a known runtime class. Follow that
        // class through JDT's type hierarchy and include the inherited
        // implementation selected at runtime. Example:
        //   Connection.Request req = new HttpConnection.Request();
        //   req.addHeader(...)
        // The static target is Connection.Base.addHeader; the executed body is
        // HttpConnection.Base.addHeader. This is compiler-backed adjudication,
        // not a name-based oracle exception.
        const runtimeDefs = await resolveConstructedReceiverMethods(
            handle, { absFile, file, line, name, source, sourceLine, staticTargets });
        for (const entry of runtimeDefs) {
            defs.set(`${entry.file}:${entry.line}`, entry);
        }
        return [...defs.values()];
    },

    /** A method that overrides or implements a member of a supertype
     *  declared outside the project (`toString`, `run`, a library callback)
     *  is reached through that contract by code reference search cannot
     *  see (fix #429). */
    async referenceBlindness(handle, { name, file, line }) {
        const owner = await handle.helper.request({ op: 'method_owner', file, line, name });
        if (owner.line == null) return null;
        const absFile = path.join(handle.root, file);
        let frontier = await handle.lsp.request('textDocument/prepareTypeHierarchy', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: owner.line - 1, character: owner.utf16Col },
        }) || [];
        frontier = Array.isArray(frontier) ? frontier : [frontier];
        const visited = new Set();
        let declaredInProject = false;
        let external = null;
        while (frontier.length > 0 && visited.size < 64) {
            const next = [];
            for (const item of frontier) {
                if (!item?.uri || visited.has(`${item.uri}:${item.name}`)) continue;
                visited.add(`${item.uri}:${item.name}`);
                if (visited.size > 1) {
                    const inProject = uriToPath(item.uri).startsWith(handle.repoRoot + path.sep);
                    let symbols;
                    try {
                        symbols = await handle.lsp.request('textDocument/documentSymbol', {
                            textDocument: { uri: item.uri },
                        }) || [];
                    } catch { symbols = []; }
                    const declares = documentMethodSignatures(symbols, item.name, name)
                        .some(params => params == null || params === owner.params);
                    if (declares && inProject) declaredInProject = true;
                    if (declares && !inProject && !external) external = `${item.name}.${name}`;
                }
                let parents;
                try { parents = await handle.lsp.request('typeHierarchy/supertypes', { item }) || []; } catch { parents = []; }
                next.push(...parents);
            }
            frontier = next;
        }
        if (external) return { reason: 'external-contract', detail: external };
        // @Override is compiler-checked: with no project supertype declaring
        // the method, the overridden member is external.
        if (owner.override && !declaredInProject) return { reason: 'external-contract', detail: `@Override ${name}` };
        return null;
    },

    /** A file outside every imported project's source folders is outside
     *  the oracle's projection (fix #429). */
    async isConfigurationGated(handle, { file }) {
        return !onBuildPath(handle, file);
    },

    async dispose(handle) {
        try { handle.helper.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch (e) { /* gone */ }
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
        } catch (e) { /* gone */ }
    },
};

/** Whether the declaration line at `uri` (a project file or a jdt:// class
 *  file, read through `java/classFileContents`) spells `name`. */
async function declarationSpells(handle, uri, zeroBasedLine, name) {
    handle.declarationText ||= new Map();
    if (!handle.declarationText.has(uri)) {
        let text;
        try {
            text = uri.startsWith('jdt:')
                ? await handle.lsp.request('java/classFileContents', { uri })
                : fs.readFileSync(uriToPath(uri), 'utf-8');
        } catch { text = null; }
        handle.declarationText.set(uri, typeof text === 'string' ? text.split('\n') : null);
    }
    const lines = handle.declarationText.get(uri);
    if (!lines) return false;
    return nameColumns(lines[zeroBasedLine] || '', name).length > 0;
}

function nameColumns(line, name) {
    const cols = [];
    for (let from = 0; from <= line.length - name.length;) {
        const at = line.indexOf(name, from);
        if (at < 0) break;
        const before = at === 0 ? '' : line[at - 1];
        const after = line[at + name.length] || '';
        if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) cols.push(at);
        from = at + name.length;
    }
    return cols;
}

async function definitionLocationsAt(handle, absFile, line, character) {
    const response = await handle.lsp.request('textDocument/definition', {
        textDocument: { uri: pathToUri(absFile) },
        position: { line: line - 1, character },
    }) || [];
    const out = [];
    for (const loc of Array.isArray(response) ? response : [response]) {
        const uri = loc.targetUri || loc.uri;
        const range = loc.targetSelectionRange || loc.targetRange || loc.range;
        if (!uri || !range) continue;
        const defAbs = uriToPath(uri);
        if (!defAbs.startsWith(handle.repoRoot + path.sep)) continue;
        out.push({ absFile: defAbs, file: path.relative(handle.root, defAbs),
            line: range.start.line + 1 });
    }
    return out;
}

async function resolveLambdaReceiverMethod(handle, query) {
    const escaped = query.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let receiver = null;
    let receiverStart = -1;
    for (const nameCol of nameColumns(query.sourceLine, query.name)) {
        const prefix = query.sourceLine.slice(0, nameCol);
        const match = prefix.match(new RegExp(
            `([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\.\\s*$`));
        if (!match || !new RegExp(`^${escaped}$`).test(query.sourceLine.slice(nameCol, nameCol + query.name.length))) {
            continue;
        }
        receiver = match[1];
        receiverStart = prefix.lastIndexOf(receiver);
        break;
    }
    if (!receiver) return [];

    const rootName = receiver.split('.')[0];
    let ownerName = null;
    let ownerLocations = [];
    if (/^[A-Z_$]/.test(rootName)) {
        ownerName = rootName;
        ownerLocations = await definitionLocationsAt(
            handle, query.absFile, query.line, receiverStart);
    } else {
        const escapedRoot = rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const floor = methodScanFloor(query.source, query.line);
        for (let at = query.line - 2, remaining = 250; at > floor && remaining-- > 0; at--) {
            const text = query.source[at];
            const explicit = text.match(new RegExp(
                `\\b([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*(?:\\s*<[^;=]+>)?(?:\\[\\])?)\\s+${escapedRoot}\\s*(?:=|;)`));
            const inferred = text.match(new RegExp(
                `\\bvar\\s+${escapedRoot}\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`));
            const rawType = inferred ? inferred[1] : explicit?.[1];
            if (!rawType) continue;
            ownerName = rawType.replace(/<.*$/, '').replace(/\[\]$/, '').split('.').pop();
            const typeCol = text.indexOf(ownerName);
            if (typeCol < 0) return [];
            ownerLocations = await definitionLocationsAt(handle, query.absFile, at + 1, typeCol);
            break;
        }
    }
    if (!ownerName || ownerLocations.length !== 1) return [];

    const owner = ownerLocations[0];
    const symbols = await handle.lsp.request('textDocument/documentSymbol', {
        textDocument: { uri: pathToUri(owner.absFile) },
    }) || [];
    const methods = documentMethodsForOwner(symbols, ownerName, query.name);
    if (methods.length !== 1) return [];
    return [{ file: owner.file, line: methods[0].line }];
}

function constructedReceiverAt(query) {
    let receiver = null;
    for (const nameCol of nameColumns(query.sourceLine, query.name)) {
        const prefix = query.sourceLine.slice(0, nameCol);
        // `receiver.m(..)` and the method reference `receiver::m` (fix #429).
        const match = prefix.match(/([A-Za-z_$][\w$]*)\s*(?:\.|::)\s*$/);
        if (match) { receiver = match[1]; break; }
    }
    if (!receiver) return null;

    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const assignment = new RegExp(
        `\\b${escaped}\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`);
    const anyAssignment = new RegExp(`\\b${escaped}\\s*=`);
    const floor = methodScanFloor(query.source, query.line);
    for (let at = query.line - 2, remaining = 300; at > floor && remaining-- > 0; at--) {
        const text = query.source[at];
        const exact = text.match(assignment);
        if (exact) {
            const rawType = exact[1];
            return {
                receiver,
                rawType,
                ownerName: rawType.split('.').pop(),
                line: at + 1,
                character: text.lastIndexOf(rawType.split('.').pop()),
            };
        }
        // A nearer non-constructor assignment invalidates older provenance.
        if (anyAssignment.test(text)) return null;
    }
    return null;
}

async function resolveConstructedReceiverMethods(handle, query) {
    const constructed = constructedReceiverAt(query);
    if (!constructed || constructed.character < 0) return [];

    // The executed body is the static target or one of its overrides
    // (jdtls `textDocument/implementation` of the exact overload the call
    // binds to), declared by the nearest type of the constructed class's
    // hierarchy (fix #429: a by-name search abstained on every overloaded
    // interface member, commons-pool `kop.getNumIdle(key)`).
    const bodies = [];
    for (const target of query.staticTargets || []) {
        bodies.push({ uri: target.uri, line: target.position.line });
        let implementations;
        try {
            implementations = await handle.lsp.request('textDocument/implementation', {
                textDocument: { uri: target.uri },
                position: target.position,
            }) || [];
        } catch { implementations = []; }
        for (const loc of Array.isArray(implementations) ? implementations : [implementations]) {
            const uri = loc.targetUri || loc.uri;
            const range = loc.targetSelectionRange || loc.targetRange || loc.range;
            if (uri && range) bodies.push({ uri, line: range.start.line });
        }
    }
    const starts = await handle.lsp.request('textDocument/prepareTypeHierarchy', {
        textDocument: { uri: pathToUri(query.absFile) },
        position: { line: constructed.line - 1, character: constructed.character },
    }) || [];
    let frontier = Array.isArray(starts) ? [...starts] : [starts];
    const visited = new Set();
    while (frontier.length > 0 && visited.size < 64) {
        const next = [];
        const levelMatches = [];
        for (const item of frontier) {
            if (!item?.uri) continue;
            const itemRange = item.selectionRange || item.range;
            const itemKey = `${item.uri}:${itemRange?.start?.line ?? -1}:${item.name}`;
            if (visited.has(itemKey)) continue;
            visited.add(itemKey);

            const ownerAbs = uriToPath(item.uri);
            if (ownerAbs.startsWith(handle.repoRoot + path.sep)) {
                if (bodies.length > 0) {
                    // Bodies declared directly in this type: inside the type's
                    // declaration (a hierarchy item prepared at a construction
                    // carries the constructor's range, so the type's own range
                    // comes from the document's symbols) and not inside a
                    // nested type declared within it.
                    const symbols = await handle.lsp.request('textDocument/documentSymbol', {
                        textDocument: { uri: item.uri },
                    }) || [];
                    for (const body of bodies) {
                        if (uriToPath(body.uri) !== ownerAbs) continue;
                        const declaring = declaringTypeName(symbols, body.line);
                        if (!declaring || bareTypeName(declaring) !== bareTypeName(item.name)) continue;
                        levelMatches.push({ file: path.relative(handle.root, ownerAbs), line: body.line + 1 });
                    }
                } else {
                    const symbols = await handle.lsp.request('textDocument/documentSymbol', {
                        textDocument: { uri: item.uri },
                    }) || [];
                    for (const method of documentMethodsForOwner(symbols, item.name, query.name)) {
                        levelMatches.push({ file: path.relative(handle.root, ownerAbs), line: method.line });
                    }
                }
            }

            const parents = await handle.lsp.request('typeHierarchy/supertypes', { item }) || [];
            for (const parent of parents) next.push(parent);
        }
        // Java dispatch selects the nearest declaration. Continuing above it
        // would incorrectly credit overridden interface/superclass methods.
        // Uniqueness guard: several same-name declarations at the nearest
        // level are an overload family — crediting them all would let an
        // edge confirmed against the WRONG overload pass (the engine's own
        // #205 discipline). Abstain instead of guessing.
        if (levelMatches.length === 1) return levelMatches;
        if (levelMatches.length > 1) return [];
        frontier = next;
    }
    return [];
}

// Provenance scans must not cross the enclosing method: a same-named local
// constructed in an EARLIER method is not this receiver's type. Walk upward
// tracking unmatched '{' openers — control-flow openers keep scanning (a
// local declared before an if-block is real provenance), method/type openers
// floor the scan.
function methodScanFloor(source, fromLine) {
    let depth = 0;
    // Braces inside string/char literals and line comments are not block
    // delimiters (`a2q("{'a':1}")`), and a statement head can span lines: a
    // multi-line `try (JsonParser p = new X(...,\n ...)) {` opens a
    // try block, not a method.
    const code = at => String(source[at] || '')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])+'/g, "''")
        .replace(/\/\/.*$/, '');
    const statementHead = (at, column) => {
        let head = code(at).slice(0, column);
        for (let up = at - 1; up >= 0 && !/[;{}]/.test(head) && at - up <= 20; up--) {
            head = `${code(up)} ${head}`;
        }
        const boundary = Math.max(head.lastIndexOf(';'), head.lastIndexOf('{'), head.lastIndexOf('}'));
        return boundary >= 0 ? head.slice(boundary + 1) : head;
    };
    for (let at = fromLine - 2; at >= 0; at--) {
        const text = code(at);
        for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '}') depth++;
            else if (ch === '{') {
                if (depth > 0) { depth--; continue; }
                const head = statementHead(at, i);
                if (!/\b(?:if|else|for|while|switch|try|catch|finally|do|synchronized)\b[^{]*$/.test(head)) {
                    return at;
                }
            }
        }
    }
    return -1;
}

function bareTypeName(name) {
    return String(name || '').replace(/<.*$/, '').split('.').pop();
}

/** The innermost type declaring the member whose declaration covers `line`
 *  (0-based), from a documentSymbol answer in either shape: flat
 *  SymbolInformation (a member's containerName) or hierarchical symbols. */
function declaringTypeName(symbols, line) {
    let best = null;
    const consider = (range, owner) => {
        if (!range || !owner || !lineInRange(line, range)) return;
        if (!best || range.end.line - range.start.line < best.size) {
            best = { size: range.end.line - range.start.line, owner };
        }
    };
    const walk = (nodes, owner) => {
        for (const node of nodes || []) {
            const range = node.range || node.location?.range;
            const isType = [5, 10, 11, 23].includes(node.kind);
            if (!isType) consider(range, node.containerName || owner);
            walk(node.children, isType ? node.name : owner);
        }
    };
    walk(symbols, null);
    return best?.owner || null;
}

function safeRealpath(file) {
    try { return fs.realpathSync(file); } catch { return file; }
}

function lineInRange(line, range) {
    return !!range && line >= range.start.line && line <= range.end.line;
}

/** Ranges of the types declared inside `outer` (not `outer` itself). */
function nestedTypeRanges(symbols, outer) {
    const ranges = [];
    const walk = nodes => {
        for (const node of nodes || []) {
            const range = node.range || node.location?.range;
            if ([5, 10, 11, 23].includes(node.kind) && range && outer &&
                range.start.line >= outer.start.line && range.end.line <= outer.end.line &&
                !(range.start.line === outer.start.line && range.end.line === outer.end.line)) {
                ranges.push(range);
            }
            walk(node.children);
        }
    };
    walk(symbols);
    return ranges;
}

/** The source folders of every project jdtls imported (absolute paths), or
 *  null when the server does not answer the command. */
async function listSourcePaths(lsp, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await lsp.request('workspace/executeCommand', {
                command: 'java.project.listSourcePaths', arguments: [],
            });
            const paths = (response?.data || []).map(entry => entry.path).filter(Boolean);
            // Declared folders need not exist (a Maven resources root).
            if (paths.length > 0) {
                return paths.map(entry => {
                    try { return fs.realpathSync(entry); } catch { return path.resolve(entry); }
                });
            }
        } catch { /* registration can race readiness: retry */ }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return null;
}

function onBuildPath(handle, relFile) {
    if (!handle.sourcePaths) return true;
    const absolute = path.join(handle.root, relFile);
    return handle.sourcePaths.some(folder => absolute === folder || absolute.startsWith(folder + path.sep));
}

/** Parameter counts of the methods named `methodName` declared by the type
 *  `ownerName` in a documentSymbol answer (null when the detail has none). */
function documentMethodSignatures(symbols, ownerName, methodName) {
    const counts = [];
    const visit = (nodes, inOwner) => {
        for (const node of nodes || []) {
            const label = String(node.name || '');
            const base = label.replace(/\(.*/, '');
            // Flat SymbolInformation names the declaring type in containerName.
            const declaredHere = inOwner || (node.containerName != null &&
                bareTypeName(node.containerName) === bareTypeName(ownerName));
            if (declaredHere && node.kind === 6 && base === methodName) {
                const params = label.includes('(') ? label.slice(label.indexOf('(') + 1, label.lastIndexOf(')')).trim() : null;
                counts.push(params == null ? null : (params === '' ? 0 : params.split(',').length));
            }
            const owner = [5, 10, 11, 23].includes(node.kind) && base.replace(/<.*/, '') === ownerName.replace(/<.*/, '');
            visit(node.children, owner || (inOwner && ![5, 10, 11, 23].includes(node.kind)));
        }
    };
    visit(symbols, false);
    return counts;
}

function documentMethodsForOwner(symbols, ownerName, methodName) {
    const matches = [];
    const walkOwner = node => {
        for (const child of node.children || []) {
            if (child.name.replace(/\(.*/, '') === methodName && child.kind === 6) {
                const range = child.selectionRange || child.range;
                if (range) matches.push({ line: range.start.line + 1 });
            }
        }
    };
    const walk = nodes => {
        for (const node of nodes || []) {
            if (node.name === ownerName && [5, 10, 11, 23].includes(node.kind)) walkOwner(node);
            if (node.children) walk(node.children);
            if (node.containerName === ownerName &&
                node.name.replace(/\(.*/, '') === methodName && node.kind === 6) {
                const range = node.location?.range || node.selectionRange || node.range;
                if (range) matches.push({ line: range.start.line + 1 });
            }
        }
    };
    walk(symbols);
    return matches;
}

function resolveJava() {
    const candidates = [
        process.env.UCN_EVAL_JAVA,
        process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java'),
        'java',
        '/opt/homebrew/opt/openjdk/bin/java',
    ].filter(Boolean);
    for (const c of candidates) {
        const r = spawnSync(c, ['--version'], { stdio: 'pipe' });
        if (r.status === 0) return c;
    }
    throw new Error('java (JDK 17+) not found — set UCN_EVAL_JAVA or JAVA_HOME');
}

function resolveJdtls() {
    const explicit = process.env.UCN_EVAL_JDTLS;
    if (explicit) return explicit;
    // No --version probe: jdtls has no version flag — probing STARTS the
    // server and spawnSync would block forever. Locate the launcher instead.
    const which = spawnSync('which', ['jdtls'], { stdio: 'pipe' });
    if (which.status === 0) return which.stdout.toString().trim();
    if (fs.existsSync('/opt/homebrew/bin/jdtls')) return '/opt/homebrew/bin/jdtls';
    throw new Error('jdtls not found — brew install jdtls, or set UCN_EVAL_JDTLS');
}

/** Nearest ancestor with a .git dir (covers multi-module Maven repos), else nearest pom.xml root. */
function findRepoRoot(dir) {
    let pomRoot = null;
    let current = dir;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(current, 'pom.xml'))) pomRoot = current;
        if (fs.existsSync(path.join(current, '.git'))) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return pomRoot || dir;
}

module.exports = { jdtlsOracle, constructedReceiverAt, documentMethodSignatures, nestedTypeRanges, onBuildPath, declarationSpells,
    declaringTypeName };
