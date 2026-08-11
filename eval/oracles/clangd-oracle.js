/**
 * Independent C/C++ semantic oracle backed by clangd.
 *
 * Symbol enumeration comes from textDocument/documentSymbol. Exact
 * reference identity comes from textDocument/references. Call candidates
 * come from LSP call hierarchy and are validated against clangd's AST
 * extension so a function pointer passed as an argument is not mislabeled as
 * a direct call. A generated compilation database is used only when the
 * repository does not provide one.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');

const SOURCE_EXTENSIONS = new Set([
    '.c', '.cc', '.cpp', '.cxx', '.m', '.mm',
    '.h', '.hh', '.hpp', '.hxx', '.inc',
]);
const EXCLUDED_DIRS = new Set([
    '.git', '.svn', 'build', 'cmake-build-debug', 'cmake-build-release',
    'node_modules', 'vendor',
]);
const SYMBOL_KIND = {
    NAMESPACE: 3,
    CLASS: 5,
    METHOD: 6,
    CONSTRUCTOR: 9,
    INTERFACE: 11,
    FUNCTION: 12,
    STRUCT: 23,
};

const clangdOracle = {
    name: 'clangd',
    languages: ['c', 'cpp'],
    comprehensiveReferences: true,
    // clangd's textDocument/references result is pinned to the selected C/C++
    // declaration/overload. Re-running definition lookup on every returned
    // reference is weaker for macro bodies: clangd can map the source token to
    // the macro's lexical declaration even though the original reference query
    // already established exact target identity.
    exactReferenceIdentity: true,

    async prepare(repoDir, { repo } = {}) {
        const clangd = resolveClangd();
        const root = canonical(repoDir);
        const language = repo?.language === 'c' ? 'c' : 'cpp';
        const files = enumerateSourceFiles(root, repo?.oracleExclude || []);
        const database = findCompilationDatabase(root) ||
            createCompilationDatabase(root, files, language,
                repo?.clangFlags || []);
        const inactiveRegions = new Map();
        const fileStatus = new Map();
        const lsp = new LspClient(clangd, [
            '--background-index',
            '--clang-tidy=false',
            '--header-insertion=never',
            // clangd otherwise caps reference/search answers (commonly at
            // 100), which silently turns valid UCN edges beyond the cap into
            // apparent false positives on real repositories.
            '--limit-results=0',
            '--log=error',
            `--compile-commands-dir=${database.directory}`,
        ], {
            capabilities: {
                textDocument: {
                    callHierarchy: { dynamicRegistration: false },
                    documentSymbol: {
                        dynamicRegistration: false,
                        hierarchicalDocumentSymbolSupport: true,
                    },
                    inactiveRegionsCapabilities: { inactiveRegions: true },
                },
            },
            onNotification(method, params) {
                if (method === 'textDocument/inactiveRegions') {
                    const uri = params?.textDocument?.uri || params?.uri;
                    if (uri) inactiveRegions.set(
                        canonical(uriToPath(uri)), params.regions || []);
                }
                if (method === 'textDocument/clangd.fileStatus') {
                    const uri = params?.uri;
                    if (uri) fileStatus.set(
                        canonical(uriToPath(uri)), params.state || '');
                }
            },
            stderr: 'ignore',
        });
        await lsp.initialize(root, {
            compilationDatabasePath: database.directory,
        });
        const version = spawnSync(clangd, ['--version'], {
            stdio: 'pipe',
        }).stdout?.toString().trim().split('\n')[0] || 'unknown';
        process.stdout.write(
            `  ${version} (${files.length} C-family files, compilation DB ` +
            `${database.generated ? 'generated' : 'repository'})\n`);
        return {
            lsp,
            root,
            language,
            files,
            fileSet: new Set(files.map(canonical)),
            opened: new Set(),
            source: new Map(),
            versions: new Map(),
            symbols: new Map(),
            astLines: new Map(),
            occurrenceCache: new Map(),
            lexicalCodeCache: new Map(),
            inactiveRegions,
            fileStatus,
            database,
        };
    },

    async listSymbols(handle, { kinds, limit } = {}) {
        const wanted = kinds ? new Set(kinds) : null;
        const rows = [];
        const seen = new Set();
        for (const absFile of handle.files) {
            ensureOpen(handle, absFile);
            let response;
            try {
                response = await handle.lsp.request(
                    'textDocument/documentSymbol',
                    { textDocument: { uri: pathToUri(absFile) } });
            } catch {
                continue;
            }
            const relFile = path.relative(handle.root, absFile);
            // clangd emits two DocumentSymbols for `typedef struct Name {}`:
            // one on the record name and one on the closing typedef alias.
            // They are one compiler type and UCN indexes the record start.
            // Anonymous records also expose a synthetic `(anonymous struct)`
            // whose selection range points at the `struct` keyword. Sampling
            // either artifact creates an impossible public `find` target.
            const namedRecords = collectNamedRecordDeclarations(response || []);
            const visit = (entry, containers = []) => {
                if (!entry) return;
                const mappedKind = oracleKind(entry.kind);
                const range = entry.selectionRange ||
                    entry.location?.range || entry.range;
                const semanticName = documentSymbolName(entry.name);
                const compilerArtifact = isAnonymousRecordSymbol(entry) ||
                    isRedundantRecordTypedef(entry, namedRecords);
                if (mappedKind && range && !compilerArtifact) {
                    const line = range.start.line + 1;
                    const name = sourceIdentifier(
                        handle, absFile, line, range.start.character,
                        entry.name);
                    // Macro-generated declarations often borrow a selection
                    // range from the invocation token or one of its
                    // arguments. If the compiler symbol name and the source
                    // identifier at that range disagree, this is not a
                    // directly invocable source declaration and must not be
                    // sampled as one.
                    if (name && (!semanticName || semanticName === name)) {
                        const key = `${relFile}:${line}:${name}:${mappedKind}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            const row = {
                                name,
                                file: relFile,
                                line,
                                kind: mappedKind,
                                compilerIdentity: callableIdentityKey(
                                    entry, containers),
                            };
                            const arity = callableArity(
                                handle, absFile, entry);
                            rows.push(row);
                            handle.symbols.set(
                                `${relFile}:${line}:${name}`, {
                                    ...row,
                                    column: range.start.character,
                                    ...(arity && { arity }),
                                });
                        }
                    }
                }
                const childContainers = isContainerSymbol(entry.kind)
                    ? [...containers, semanticName || entry.name]
                    : containers;
                for (const child of entry.children || []) {
                    visit(child, childContainers);
                }
            };
            for (const entry of response || []) visit(entry);
        }
        rows.sort((left, right) =>
            left.file.localeCompare(right.file) ||
            left.line - right.line ||
            left.name.localeCompare(right.name));
        const filtered = wanted
            ? rows.filter(row => wanted.has(row.kind))
            : rows;
        return limit ? filtered.slice(0, limit) : filtered;
    },

    async findReferences(handle, { name, file, line, comprehensive = false }) {
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const symbol = handle.symbols.get(`${file}:${line}:${name}`);
        const targetArity = symbol?.arity || null;
        const targetIsClass = symbol?.kind === 'class';
        const repeatedCallableName = handle.language === 'cpp' &&
            callableIdentityCount(handle, name) > 1;
        const character = symbol?.column ??
            nameColumns(sourceLine(handle, absFile, line), name)[0] ?? 0;
        const position = { line: line - 1, character };
        const callSites = await incomingCallSites(
            handle, absFile, position);
        const locations = await handle.lsp.request(
            'textDocument/references', {
                textDocument: { uri: pathToUri(absFile) },
                position,
                context: { includeDeclaration: true },
            }) || [];
        const refs = new Map();
        for (const location of locations) {
            const normalized = normalizeLocation(location);
            if (!normalized) continue;
            const refAbs = canonical(uriToPath(normalized.uri));
            if (!inside(handle.root, refAbs)) continue;
            if (handle.fileSet && !handle.fileSet.has(refAbs)) continue;
            const rel = path.relative(handle.root, refAbs);
            const refLine = normalized.range.start.line + 1;
            const refColumn = normalized.range.start.character;
            const siteKey = `${rel}:${refLine}`;
            const isDefinition =
                (rel === file && refLine === line) ||
                handle.symbols.has(`${rel}:${refLine}:${name}`);
            const astCall = isDefinition || targetIsClass
                ? { isCall: false } :
                await callReferenceInfo(
                    handle, refAbs, normalized.range, name, {
                        directCalleeOnly: false,
                    });
            // Clang call hierarchy can include callable references (a
            // function pointer passed to a constructor) as incoming "calls".
            // The AST callee subtree is the authority when available; fall
            // back to hierarchy only on clangd versions without the AST
            // extension.
            const compilerCall = !isDefinition &&
                (astCall == null ? callSites.has(siteKey) : astCall.isCall);
            if (compilerCall && targetArity &&
                astCall?.argCount != null &&
                !arityAccepts(targetArity, astCall.argCount)) {
                continue;
            }
            const kind = isDefinition ? 'definition' :
                compilerCall ? 'call' : 'reference';
            refs.set(`${rel}:${refLine}:${refColumn}:${kind}`, {
                file: rel,
                line: refLine,
                column: refColumn,
                kind,
                ...(compilerCall &&
                    (astCall?.uncertaintyClass || repeatedCallableName) && {
                    uncertaintyClass: astCall?.uncertaintyClass ||
                        'compile-time-dispatch',
                }),
                ...(compilerCall &&
                    !identifierOnLine(handle, refAbs, refLine, name) && {
                    oracleResolution: 'macro-expansion',
                }),
            });
        }
        for (const [siteKey, site] of callSites) {
            if (targetIsClass) break;
            const siteAbs = path.join(handle.root, site.file);
            if (handle.fileSet &&
                !handle.fileSet.has(canonical(siteAbs))) {
                continue;
            }
            const astCall = await callReferenceInfo(
                handle, siteAbs, site.range, name, {
                    directCalleeOnly: symbol?.kind === 'class',
                });
            // Incoming-call hierarchy is not sufficient evidence: clangd
            // also reports callable references passed as constructor
            // arguments. Retain hierarchy-only sites only when the AST
            // extension is unavailable; a negative AST answer is decisive.
            if (astCall?.isCall === false) continue;
            if (targetArity && astCall?.argCount != null &&
                !arityAccepts(targetArity, astCall.argCount)) {
                continue;
            }
            refs.set(`${siteKey}:${site.column}:call`, {
                file: site.file,
                line: site.line,
                column: site.column,
                kind: 'call',
                ...((astCall?.uncertaintyClass || repeatedCallableName) && {
                    uncertaintyClass: astCall?.uncertaintyClass ||
                        'compile-time-dispatch',
                }),
                ...(!identifierOnLine(
                    handle, path.join(handle.root, site.file),
                    site.line, name) && {
                    oracleResolution: 'macro-expansion',
                }),
            });
        }
        if (comprehensive && !targetIsClass) {
            await addCompilerResolvedCallOccurrences(handle, {
                name,
                file,
                line,
                refs,
            });
        }
        return [...refs.values()];
    },

    async resolveDefinition(handle, { name, file, line, column }) {
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const columns = Number.isInteger(column)
            ? [column]
            : nameColumns(sourceLine(handle, absFile, line), name);
        const definitions = new Map();
        for (const character of columns) {
            for (const method of [
                'textDocument/definition',
                'textDocument/declaration',
            ]) {
                let response;
                try {
                    response = await handle.lsp.request(method, {
                        textDocument: { uri: pathToUri(absFile) },
                        position: { line: line - 1, character },
                    }) || [];
                } catch (error) {
                    // Declaration is an optional LSP extension. Definition is
                    // mandatory for this oracle and must retain its visible
                    // failure semantics.
                    if (method.endsWith('/declaration')) continue;
                    throw error;
                }
                for (const location of Array.isArray(response)
                    ? response : [response]) {
                    const normalized = normalizeLocation(location);
                    if (!normalized) continue;
                    const definitionAbs =
                        canonical(uriToPath(normalized.uri));
                    const definitionLine =
                        normalized.range.start.line + 1;
                    if (!inside(handle.root, definitionAbs)) {
                        definitions.set(
                            `external:${definitionAbs}:${definitionLine}`, {
                                file: definitionAbs,
                                line: definitionLine,
                                external: true,
                            });
                        continue;
                    }
                    const entry = {
                        file: path.relative(handle.root, definitionAbs),
                        line: definitionLine,
                    };
                    definitions.set(`${entry.file}:${entry.line}`, entry);
                }
            }
        }
        return [...definitions.values()];
    },

    async isConfigurationGated(handle, { file, line }) {
        const absFile = canonical(path.join(handle.root, file));
        ensureOpen(handle, absFile);
        const regions = handle.inactiveRegions.get(absFile) || [];
        const zeroBased = line - 1;
        return regions.some(region =>
            zeroBased >= region.start.line &&
            zeroBased <= region.end.line);
    },

    async dispose(handle) {
        let exited = false;
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
            exited = await handle.lsp.waitForExit(2000);
        } catch {
            // Fall through to the unconditional kill below.
        }
        if (!exited) {
            handle.lsp.kill();
            await handle.lsp.waitForExit(2000);
        }
        if (handle.database.generated) {
            fs.rmSync(handle.database.directory, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 50,
            });
        }
    },
};

async function incomingCallSites(handle, absFile, position) {
    const sites = new Map();
    let prepared;
    try {
        prepared = await handle.lsp.request(
            'textDocument/prepareCallHierarchy', {
                textDocument: { uri: pathToUri(absFile) },
                position,
            }) || [];
    } catch {
        return sites;
    }
    for (const item of prepared || []) {
        let incoming;
        try {
            incoming = await handle.lsp.request(
                'callHierarchy/incomingCalls', { item }) || [];
        } catch {
            continue;
        }
        for (const call of incoming) {
            const callerAbs = canonical(uriToPath(call.from?.uri || ''));
            if (!callerAbs || !inside(handle.root, callerAbs)) continue;
            const rel = path.relative(handle.root, callerAbs);
            for (const range of call.fromRanges || []) {
                const line = range.start.line + 1;
                sites.set(`${rel}:${line}`, {
                    file: rel,
                    line,
                    column: range.start.character,
                    range,
                });
            }
        }
    }
    return sites;
}

/**
 * Call hierarchy is definition-oriented and clangd can legitimately return
 * no hierarchy item for a header-only declaration (or for an unresolved
 * callback contract such as Unity's setUp/tearDown hooks). Reference search
 * still has exact symbol identity. Clangd's AST extension independently
 * classifies whether that exact reference occupies the callee subtree of a
 * call expression, without lexical or regex inference.
 */
async function callReferenceInfo(handle, absFile, range, name, {
    directCalleeOnly = false,
} = {}) {
    const line = range.start.line;
    const cacheKey = `${canonical(absFile)}:${line}`;
    let ast = handle.astLines.get(cacheKey);
    if (ast === undefined) {
        ensureOpen(handle, absFile);
        try {
            ast = await handle.lsp.request('textDocument/ast', {
                textDocument: { uri: pathToUri(absFile) },
                range: {
                    start: { line, character: 0 },
                    end: { line, character: 1000000 },
                },
            });
        } catch {
            ast = null;
        }
        handle.astLines.set(cacheKey, ast);
    }
    if (!ast) return null;
    const column = range.start.character;
    const containsReference = node => {
        if (!node?.range) return true; // macro-expanded nodes omit source ranges
        const start = node.range.start;
        const end = node.range.end;
        return line >= start.line && line <= end.line &&
            (line !== start.line || column >= start.character) &&
            (line !== end.line || column <= end.character);
    };
    const visitCallee = node => {
        if (!node || !containsReference(node)) return null;
        const dependent = [
            'UnresolvedLookup', 'UnresolvedMember',
            'DependentScopeDeclRef', 'Recovery',
        ].includes(node.kind) ||
            /<dependent type>|contains-errors/.test(String(node.arcana || ''));
        // The reference query has already established exact compiler symbol
        // identity. For dependent/template calls clangd often omits `detail`
        // on UnresolvedLookup nodes, so range containment is stronger than a
        // text-name check here.
        if (['DeclRef', 'Member', 'Type', 'UnresolvedLookup',
            'UnresolvedMember', 'DependentScopeDeclRef']
            .includes(node.kind) &&
            (!node.detail || node.detail === name ||
             String(node.detail).split('::').pop() === name)) {
            return { dependent };
        }
        if (directCalleeOnly && node.range) {
            const start = node.range.start;
            const end = node.range.end;
            // A class name nested inside another callable's template
            // arguments (`make_descriptor<context>()`) is a type reference,
            // not construction/call of `context`. Descend only through
            // wrappers whose source range is the class token itself.
            if (start.line !== range.start.line ||
                start.character !== range.start.character ||
                end.line !== range.end.line ||
                end.character !== range.end.character) {
                return null;
            }
        }
        for (const child of node.children || []) {
            const result = visitCallee(child);
            if (result) return {
                dependent: dependent || result.dependent,
            };
        }
        return null;
    };
    const visit = node => {
        if (!node || !containsReference(node)) return null;
        if (/Call$/.test(node.kind || '') || node.kind === 'Recovery') {
            // Clang's first child is the callee expression; later children
            // are arguments and must not turn a passed function reference
            // into a call to that function. Construct/New nodes deliberately
            // do not enter here: their children are constructor arguments,
            // while the constructed type is carried in the node itself.
            // Recovery is clangd's representation for a dependent nested
            // call when surrounding template code is not fully instantiated;
            // it preserves the same callee-first child layout.
            const callee = visitCallee(node.children?.[0]);
            if (callee) {
                return {
                    isCall: true,
                    argCount: Math.max(0, (node.children || []).length - 1),
                    ...(callee.dependent && {
                        uncertaintyClass: 'compile-time-dispatch',
                    }),
                };
            }
        }
        for (const child of node.children || []) {
            const result = visit(child);
            if (result) return result;
        }
        return null;
    };
    return visit(ast) || { isCall: false };
}

function identifierOnLine(handle, absFile, line, name) {
    const text = sourceLine(handle, absFile, line);
    const escaped = String(name)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`)
        .test(text);
}

function oracleKind(kind) {
    if (kind === SYMBOL_KIND.FUNCTION) return 'function';
    if (kind === SYMBOL_KIND.METHOD) return 'method';
    if (kind === SYMBOL_KIND.CLASS || kind === SYMBOL_KIND.STRUCT ||
        kind === SYMBOL_KIND.INTERFACE) return 'class';
    // Constructors are represented by their containing class in UCN's
    // class-usage contract; emitting a second same-named sampled row would
    // double-count one compiler type.
    if (kind === SYMBOL_KIND.CONSTRUCTOR) return null;
    return null;
}

function isContainerSymbol(kind) {
    return kind === SYMBOL_KIND.NAMESPACE ||
        kind === SYMBOL_KIND.CLASS ||
        kind === SYMBOL_KIND.STRUCT ||
        kind === SYMBOL_KIND.INTERFACE;
}

function collectNamedRecordDeclarations(entries) {
    const records = [];
    const visit = entry => {
        if (!entry) return;
        const name = documentSymbolName(entry.name);
        if ((entry.kind === SYMBOL_KIND.CLASS ||
            entry.kind === SYMBOL_KIND.STRUCT ||
            entry.kind === SYMBOL_KIND.INTERFACE) &&
            entry.detail !== 'type alias' && name &&
            !isAnonymousRecordSymbol(entry)) {
            records.push({
                name,
                startLine: entry.range?.start?.line,
                endLine: entry.range?.end?.line,
            });
        }
        for (const child of entry.children || []) visit(child);
    };
    for (const entry of entries || []) visit(entry);
    return records;
}

function isAnonymousRecordSymbol(entry) {
    return /\b(?:anonymous|unnamed)\b/i.test(String(entry?.name || ''));
}

function isRedundantRecordTypedef(entry, namedRecords) {
    if (entry?.detail !== 'type alias') return false;
    const name = documentSymbolName(entry.name);
    const startLine = entry.range?.start?.line;
    const endLine = entry.range?.end?.line;
    return !!name && namedRecords.some(record =>
        record.name === name &&
        record.startLine === startLine &&
        record.endLine === endLine);
}

function callableIdentityKey(entry, containers = []) {
    const owner = containers.map(container => String(container).trim())
        .filter(Boolean).join('::');
    const name = documentSymbolName(entry?.name) || String(entry?.name || '');
    const signature = String(entry?.detail || '')
        .replace(/\s+/g, ' ').trim();
    // clangd emits the same semantic detail for a prototype and its
    // implementation. Keeping the lexical owner and full compiler signature
    // distinguishes same-arity overloads while folding those two source
    // locations into one callable slot.
    return `${entry?.kind || ''}:${owner}:${name}:${signature}`;
}

function callableIdentityCount(handle, name) {
    const identities = new Set();
    for (const candidate of handle.symbols.values()) {
        if (candidate.name !== name ||
            (candidate.kind !== 'function' && candidate.kind !== 'method')) {
            continue;
        }
        identities.add(candidate.compilerIdentity ||
            `${candidate.kind}:${candidate.file}:${candidate.line}`);
    }
    return identities.size;
}

function ensureOpen(handle, absFile) {
    const canonicalFile = canonical(absFile);
    if (handle.opened.has(canonicalFile)) return;
    const text = fs.readFileSync(canonicalFile, 'utf8');
    handle.source.set(canonicalFile, text.split('\n'));
    handle.lsp.didOpen(
        canonicalFile,
        handle.language === 'c' ? 'c' : 'cpp',
        text);
    handle.versions.set(canonicalFile, 1);
    handle.opened.add(canonicalFile);
}

function definitionKey(definition) {
    return definition.external
        ? `external:${definition.file}:${definition.line}`
        : `${definition.file}:${definition.line}`;
}

async function definitionsAt(handle, absFile, line, column) {
    ensureOpen(handle, absFile);
    const response = await handle.lsp.request(
        'textDocument/definition', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: line - 1, character: column },
        }) || [];
    const definitions = new Map();
    for (const location of Array.isArray(response) ? response : [response]) {
        const normalized = normalizeLocation(location);
        if (!normalized) continue;
        const definitionAbs = canonical(uriToPath(normalized.uri));
        const definitionLine = normalized.range.start.line + 1;
        const definition = inside(handle.root, definitionAbs)
            ? {
                file: path.relative(handle.root, definitionAbs),
                line: definitionLine,
            }
            : {
                file: definitionAbs,
                line: definitionLine,
                external: true,
            };
        definitions.set(definitionKey(definition), definition);
    }
    return [...definitions.values()];
}

async function declarationsAt(handle, absFile, line, column) {
    ensureOpen(handle, absFile);
    let response;
    try {
        response = await handle.lsp.request(
            'textDocument/declaration', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character: column },
            }) || [];
    } catch {
        return [];
    }
    const declarations = new Map();
    for (const location of Array.isArray(response) ? response : [response]) {
        const normalized = normalizeLocation(location);
        if (!normalized) continue;
        const declarationAbs = canonical(uriToPath(normalized.uri));
        const declarationLine = normalized.range.start.line + 1;
        const declaration = inside(handle.root, declarationAbs)
            ? {
                file: path.relative(handle.root, declarationAbs),
                line: declarationLine,
            }
            : {
                file: declarationAbs,
                line: declarationLine,
                external: true,
            };
        declarations.set(definitionKey(declaration), declaration);
    }
    return [...declarations.values()];
}

function occurrencesForName(handle, name) {
    if (handle.occurrenceCache.has(name)) {
        return handle.occurrenceCache.get(name);
    }
    const occurrences = [];
    for (const absFile of handle.files) {
        const lines = handle.source.get(absFile) ||
            fs.readFileSync(absFile, 'utf8').split('\n');
        handle.source.set(absFile, lines);
        for (let index = 0; index < lines.length; index++) {
            for (const column of nameColumns(lines[index], name)) {
                occurrences.push({
                    absFile,
                    file: path.relative(handle.root, absFile),
                    line: index + 1,
                    column,
                });
            }
        }
    }
    handle.occurrenceCache.set(name, occurrences);
    return occurrences;
}

function macroTokenBefore(line, column) {
    const prefix = String(line || '').slice(0, column);
    const pattern = /\b([A-Z][A-Z0-9_]{2,})\s*\(/g;
    let match;
    let selected = null;
    while ((match = pattern.exec(prefix)) !== null) {
        selected = {
            start: match.index,
            end: match.index + match[1].length,
            name: match[1],
        };
    }
    return selected;
}

function clearAstCacheForFile(handle, absFile) {
    const prefix = `${canonical(absFile)}:`;
    for (const key of handle.astLines.keys()) {
        if (key.startsWith(prefix)) handle.astLines.delete(key);
    }
}

async function replaceOpenDocument(handle, absFile, text) {
    const canonicalFile = canonical(absFile);
    ensureOpen(handle, canonicalFile);
    const version = (handle.versions.get(canonicalFile) || 1) + 1;
    handle.versions.set(canonicalFile, version);
    clearAstCacheForFile(handle, canonicalFile);
    handle.lsp.didChange(canonicalFile, version, text);
    // LSP messages are ordered. This request is a deterministic parse barrier
    // for the preceding full-document change.
    await handle.lsp.request('textDocument/documentSymbol', {
        textDocument: { uri: pathToUri(canonicalFile) },
    });
}

async function addCompilerResolvedCallOccurrences(handle, {
    name,
    file,
    line,
    refs,
}) {
    const targetAbs = path.join(handle.root, file);
    const symbol = handle.symbols.get(`${file}:${line}:${name}`);
    const targetArity = symbol?.arity || null;
    const targetColumn = symbol?.column ??
        nameColumns(sourceLine(handle, targetAbs, line), name)[0] ?? 0;
    const targetDefinitions = await definitionsAt(
        handle, targetAbs, line, targetColumn);
    const targetDeclarations = await declarationsAt(
        handle, targetAbs, line, targetColumn);
    const callableCandidates = [...handle.symbols.values()].filter(candidate =>
        candidate.name === name &&
        (candidate.kind === 'function' || candidate.kind === 'method'));
    const callableIdentities = new Set(callableCandidates.map(candidate =>
        candidate.compilerIdentity ||
        `${candidate.kind}:${candidate.file}:${candidate.line}`));
    const repeatedCallableName = callableIdentities.size > 1;
    const uniqueCallableIdentity = callableIdentities.size === 1;
    const knownCallableLocations = new Set(callableCandidates.map(candidate =>
        `${candidate.file}:${candidate.line}`));
    const targetKeys = new Set([
        `${file}:${line}`,
        ...targetDefinitions
            .filter(definition => !definition.external)
            .map(definitionKey),
        ...targetDeclarations
            .filter(declaration => !declaration.external)
            .map(definitionKey),
    ]);
    const isExactTarget = definitions => {
        const internal = definitions.filter(definition => !definition.external);
        if (internal.length === 0) return false;
        if (internal.some(definition => targetKeys.has(definitionKey(definition))) &&
            internal.every(definition => targetKeys.has(definitionKey(definition)))) {
            return true;
        }
        // Some clangd builds map calls from fallback-parsed or macro-wrapped
        // headers to a namespace/macro source line instead of the callable
        // declaration. When the project has exactly one compiler signature
        // for this name, that non-callable internal landing plus a direct-call
        // AST is still exact identity. Never use this recovery for a real
        // overload set or when clangd names another indexed callable.
        return uniqueCallableIdentity && internal.every(definition =>
            !knownCallableLocations.has(definitionKey(definition)));
    };

    const macroByFile = new Map();
    for (const occurrence of occurrencesForName(handle, name)) {
        if (occurrence.file === file && occurrence.line === line) continue;
        if (handle.symbols.has(
            `${occurrence.file}:${occurrence.line}:${name}`)) {
            continue;
        }
        const source = sourceLine(
            handle, occurrence.absFile, occurrence.line);
        const macro = macroTokenBefore(source, occurrence.column);
        if (macro) {
            if (!macroByFile.has(occurrence.absFile)) {
                macroByFile.set(occurrence.absFile, []);
            }
            macroByFile.get(occurrence.absFile).push({
                ...occurrence,
                macro,
            });
            continue;
        }
        const definitions = await definitionsAt(
            handle, occurrence.absFile, occurrence.line, occurrence.column);
        if (!isExactTarget(definitions)) continue;
        const range = {
            start: {
                line: occurrence.line - 1,
                character: occurrence.column,
            },
            end: {
                line: occurrence.line - 1,
                character: occurrence.column + name.length,
            },
        };
        const callInfo = await callReferenceInfo(
            handle, occurrence.absFile, range, name, {
                directCalleeOnly: symbol?.kind === 'class',
            });
        // Apple clangd can resolve a name to the exact callable while its AST
        // extension returns only an enclosing namespace for fallback-parsed
        // headers. Once definition identity is proven above, ordinary C/C++
        // call syntax is sufficient to distinguish `f(...)` from a value
        // reference to `f`. This fallback never establishes target identity;
        // it only classifies the already compiler-resolved occurrence.
        const effectiveCall = callInfo?.isCall === true
            ? callInfo
            : sourceCallInfo(
                handle, occurrence.absFile, occurrence.line,
                occurrence.column, name);
        if (effectiveCall?.isCall !== true ||
            (targetArity && effectiveCall.argCount != null &&
             !arityAccepts(targetArity, effectiveCall.argCount))) {
            continue;
        }
        const occurrenceKey =
            `${occurrence.file}:${occurrence.line}:${occurrence.column}:call`;
        if (!refs.has(occurrenceKey)) refs.set(
            occurrenceKey, {
                file: occurrence.file,
                line: occurrence.line,
                column: occurrence.column,
                kind: 'call',
                oracleResolution: callInfo?.isCall === true
                    ? 'compiler-occurrence'
                    : 'compiler-definition-source-call',
                ...((effectiveCall.uncertaintyClass || repeatedCallableName) && {
                    // Comprehensive name scanning recovers sites omitted by
                    // reference search. With repeated callable names clangd's
                    // fallback-definition answer can name a conservative
                    // overload family (notably fallback-parsed headers), so it
                    // is compiler evidence for the family, not exact target
                    // identity. Exact reference-search sites stay exact.
                    uncertaintyClass: 'compile-time-dispatch',
                }),
            });
    }

    // clangd deliberately maps positions inside macro arguments to the macro
    // expansion and often cannot answer definition/AST queries there (GTest
    // EXPECT_* is the common case). Unwrap only the enclosing statement-like
    // macro token in a temporary in-memory overlay. Whitespace preserves
    // every source coordinate; the compiler then resolves the original
    // argument expressions in their original lexical scope.
    for (const [absFile, occurrences] of macroByFile) {
        const original = (handle.source.get(absFile) ||
            fs.readFileSync(absFile, 'utf8').split('\n')).join('\n');
        const transformedLines = original.split('\n');
        const blanked = new Set();
        for (const occurrence of occurrences) {
            const key = `${occurrence.line}:${occurrence.macro.start}:${occurrence.macro.end}`;
            if (blanked.has(key)) continue;
            blanked.add(key);
            const index = occurrence.line - 1;
            const text = transformedLines[index] || '';
            transformedLines[index] =
                text.slice(0, occurrence.macro.start) +
                ' '.repeat(occurrence.macro.end - occurrence.macro.start) +
                text.slice(occurrence.macro.end);
        }
        try {
            await replaceOpenDocument(
                handle, absFile, transformedLines.join('\n'));
            for (const occurrence of occurrences) {
                const definitions = await definitionsAt(
                    handle, absFile, occurrence.line, occurrence.column);
                if (!isExactTarget(definitions)) continue;
                const range = {
                    start: {
                        line: occurrence.line - 1,
                        character: occurrence.column,
                    },
                    end: {
                        line: occurrence.line - 1,
                        character: occurrence.column + name.length,
                    },
                };
                const callInfo = await callReferenceInfo(
                    handle, absFile, range, name, {
                        directCalleeOnly: symbol?.kind === 'class',
                    });
                const effectiveCall = callInfo?.isCall === true
                    ? callInfo
                    : sourceCallInfo(
                        handle, absFile, occurrence.line,
                        occurrence.column, name);
                if (effectiveCall?.isCall !== true ||
                    (targetArity && effectiveCall.argCount != null &&
                     !arityAccepts(targetArity, effectiveCall.argCount))) {
                    continue;
                }
                const occurrenceKey =
                    `${occurrence.file}:${occurrence.line}:${occurrence.column}:call`;
                if (!refs.has(occurrenceKey)) refs.set(
                    occurrenceKey, {
                        file: occurrence.file,
                        line: occurrence.line,
                        column: occurrence.column,
                        kind: 'call',
                        oracleResolution: 'macro-argument-compiler',
                        ...((effectiveCall.uncertaintyClass || repeatedCallableName) && {
                            uncertaintyClass: 'compile-time-dispatch',
                        }),
                    });
            }
        } finally {
            await replaceOpenDocument(handle, absFile, original);
        }
    }
}

function sourceCallInfo(handle, absFile, line, column, name) {
    const canonicalFile = canonical(absFile);
    if (!handle.source.has(canonicalFile)) {
        handle.source.set(canonicalFile,
            fs.readFileSync(canonicalFile, 'utf8').split('\n'));
    }
    const lines = handle.source.get(canonicalFile);
    const offsets = [];
    let total = 0;
    for (const sourceLineText of lines) {
        offsets.push(total);
        total += sourceLineText.length + 1;
    }
    const source = lines.join('\n');
    if (!isSourceCodePosition(handle, canonicalFile, line, column)) {
        return { isCall: false };
    }
    let cursor = (offsets[line - 1] || 0) + column + name.length;
    while (/\s/.test(source[cursor] || '')) cursor++;
    // Explicit-template calls are syntactically `f<T>(...)`. Definition
    // lookup has already pinned `f`; balanced angle brackets are only used to
    // locate the call's opening parenthesis.
    if (source[cursor] === '<') {
        const close = matchingDelimiter(source, cursor, '<', '>');
        if (close < 0) return { isCall: false };
        cursor = close + 1;
        while (/\s/.test(source[cursor] || '')) cursor++;
    }
    if (source[cursor] !== '(') return { isCall: false };
    const close = matchingDelimiter(source, cursor, '(', ')');
    if (close < 0) return { isCall: true };
    const argumentsText = source.slice(cursor + 1, close).trim();
    return {
        isCall: true,
        argCount: argumentsText === '' ? 0 : splitTopLevel(argumentsText).length,
    };
}

/**
 * The source-syntax fallback is allowed to classify a call only after clangd
 * has already proven definition identity. Keep even that narrow fallback out
 * of comments and literals: some clangd builds return the nearest declaration
 * for positions in commented examples, which must never become oracle edges.
 */
function isSourceCodePosition(handle, absFile, line, column) {
    const canonicalFile = canonical(absFile);
    let cached = handle.lexicalCodeCache.get(canonicalFile);
    if (!cached) {
        const lines = handle.source.get(canonicalFile) ||
            fs.readFileSync(canonicalFile, 'utf8').split('\n');
        const offsets = [];
        let total = 0;
        for (const text of lines) {
            offsets.push(total);
            total += text.length + 1;
        }
        const source = lines.join('\n');
        const code = new Uint8Array(source.length);
        code.fill(1);
        const mask = (start, end) => code.fill(0, start, Math.min(end, code.length));
        for (let index = 0; index < source.length;) {
            const current = source[index];
            const next = source[index + 1];
            if (current === '/' && next === '/') {
                const end = source.indexOf('\n', index + 2);
                const stop = end < 0 ? source.length : end;
                mask(index, stop);
                index = stop;
                continue;
            }
            if (current === '/' && next === '*') {
                const close = source.indexOf('*/', index + 2);
                const stop = close < 0 ? source.length : close + 2;
                mask(index, stop);
                index = stop;
                continue;
            }
            // C++ raw strings: R"tag(contents)tag". Prefixes such as u8R are
            // harmless because scanning reaches the R before the opening quote.
            if (current === 'R' && next === '"') {
                const open = source.indexOf('(', index + 2);
                const delimiter = open >= 0 && open - (index + 2) <= 16
                    ? source.slice(index + 2, open) : null;
                if (delimiter != null &&
                    ![...delimiter].some(character =>
                        character === '\\' || character === ')' ||
                        character === '(' || /\s/.test(character))) {
                    const token = `)${delimiter}"`;
                    const close = source.indexOf(token, open + 1);
                    const stop = close < 0
                        ? source.length : close + token.length;
                    mask(index, stop);
                    index = stop;
                    continue;
                }
            }
            if (current === '"' || current === "'") {
                const quote = current;
                let cursor = index + 1;
                while (cursor < source.length) {
                    if (source[cursor] === '\\') {
                        cursor += 2;
                        continue;
                    }
                    if (source[cursor++] === quote) break;
                }
                mask(index, cursor);
                index = cursor;
                continue;
            }
            index++;
        }
        cached = { offsets, code };
        handle.lexicalCodeCache.set(canonicalFile, cached);
    }
    const offset = (cached.offsets[line - 1] || 0) + column;
    return cached.code[offset] === 1;
}

function sourceLine(handle, absFile, line) {
    const canonicalFile = canonical(absFile);
    if (!handle.source.has(canonicalFile)) {
        handle.source.set(
            canonicalFile,
            fs.readFileSync(canonicalFile, 'utf8').split('\n'));
    }
    return handle.source.get(canonicalFile)[line - 1] || '';
}

function sourceIdentifier(handle, absFile, line, character, fallback) {
    const text = sourceLine(handle, absFile, line);
    const at = Math.max(0, Math.min(text.length, character));
    const suffix = text.slice(at);
    const prefix = text.slice(0, at);
    const fallbackText = String(fallback || '').trim();
    const operatorName = canonicalOperatorName(suffix) ||
        canonicalOperatorName(fallbackText);
    const right = suffix.match(/^[~A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (right === 'operator' && operatorName) {
        return operatorName;
    }
    if (right) return right;
    const left = prefix.match(/[~A-Za-z_][A-Za-z0-9_]*$/)?.[0];
    if (left) return left;
    if (operatorName) return operatorName;
    return fallbackText
        .replace(/\s*\(.*$/s, '')
        .replace(/^.*::/, '')
        .trim() || null;
}

function canonicalOperatorName(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('operator')) return null;
    // Token set and output shape must stay in lockstep with
    // `canonicalCallableName` in languages/c-family.js (the engine-side
    // canon). This match is a PREFIX (clangd appends parameter lists), so
    // multi-character alternatives must come before their prefixes —
    // `operator++` used to fall through to the bare `+` alternative and
    // truncate to "operator+".
    const symbolic = text.match(
        /^operator\s*(\(\)|\[\]|<=>|<<=?|>>=?|->\*?|\+\+|--|&&|\|\||,|[+\-*/%<>=!&|^~]=?)/)?.[1];
    if (symbolic) return `operator${symbolic}`;
    const wordForm = text.match(/^operator\s+(new|delete)\s*(\[\s*\])?/);
    if (wordForm) return `operator ${wordForm[1]}${wordForm[2] ? '[]' : ''}`;
    const literal = text.match(/^operator\s*""\s*(_[A-Za-z0-9_]*)/);
    if (literal) return `operator""${literal[1]}`;
    const conversion = text.match(
        /^operator\s+([A-Za-z_][A-Za-z0-9_:]*(?:\s*<[^()]*>)?)/)?.[1];
    if (!conversion) return null;
    const destination = conversion.replace(/<.*>$/s, '')
        .split('::').pop().trim();
    return destination ? `operator ${destination}` : null;
}

/**
 * Extract the compiler-declared callable range from clangd's DocumentSymbol
 * detail. The source parameter list is used only to identify defaults and
 * packs; the total parameter count comes from clangd's canonical signature.
 * If source recovery is inconclusive, retain a conservative zero minimum so
 * the oracle never rejects a potentially defaulted call.
 */
function callableArity(handle, absFile, entry) {
    if (entry.kind !== SYMBOL_KIND.FUNCTION &&
        entry.kind !== SYMBOL_KIND.METHOD) {
        return null;
    }
    const detailParams = signatureParameterList(entry.detail);
    if (detailParams == null) return null;
    const detailParts = splitTopLevel(detailParams);
    const detailVoid = detailParts.length === 1 &&
        detailParts[0].trim() === 'void';
    const compilerParams = detailVoid ? [] : detailParts
        .map(part => part.trim()).filter(Boolean);
    const compilerVariadic = compilerParams.some(part =>
        part === '...' || part.includes('...'));
    const fixedCount = compilerParams.filter(part =>
        part !== '...' && !part.includes('...')).length;
    const sourceParams = sourceParameterList(handle, absFile, entry);
    if (sourceParams == null) {
        return {
            min: 0,
            max: compilerVariadic ? null : fixedCount,
        };
    }
    const sourceParts = splitTopLevel(sourceParams)
        .map(part => part.trim()).filter(Boolean);
    const normalizedSource = sourceParts.length === 1 &&
        sourceParts[0] === 'void' ? [] : sourceParts;
    const sourceFixed = normalizedSource.filter(part =>
        !part.includes('...'));
    if (sourceFixed.length !== fixedCount) {
        return {
            min: 0,
            max: compilerVariadic ? null : fixedCount,
        };
    }
    const firstDefault = sourceFixed.findIndex(hasTopLevelDefault);
    const min = firstDefault >= 0 ? firstDefault : sourceFixed.length;
    const variadic = compilerVariadic ||
        normalizedSource.some(part => part.includes('...'));
    return {
        min,
        max: variadic ? null : fixedCount,
    };
}

function signatureParameterList(detail) {
    const text = String(detail || '').trim();
    if (!text) return null;
    let angle = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '<') angle++;
        else if (character === '>') angle = Math.max(0, angle - 1);
        else if (character === '(' && angle === 0) {
            const end = matchingDelimiter(text, index, '(', ')');
            if (end >= 0) return text.slice(index + 1, end);
        }
    }
    return null;
}

function sourceParameterList(handle, absFile, entry) {
    const selection = entry.selectionRange ||
        entry.location?.range || entry.range;
    if (!selection) return null;
    const canonicalFile = canonical(absFile);
    if (!handle.source.has(canonicalFile)) {
        handle.source.set(
            canonicalFile,
            fs.readFileSync(canonicalFile, 'utf8').split('\n'));
    }
    const lines = handle.source.get(canonicalFile);
    const offsets = [];
    let total = 0;
    for (const line of lines) {
        offsets.push(total);
        total += line.length + 1;
    }
    const source = lines.join('\n');
    const startLine = selection.end?.line ?? selection.start.line;
    const startCharacter = selection.end?.character ??
        selection.start.character;
    const from = (offsets[startLine] || 0) + startCharacter;
    const open = source.indexOf('(', from);
    if (open < 0) return null;
    const close = matchingDelimiter(source, open, '(', ')');
    return close < 0 ? null : source.slice(open + 1, close);
}

function matchingDelimiter(text, from, open, close) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = from; index < text.length; index++) {
        const character = text[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === open) depth++;
        else if (character === close && --depth === 0) return index;
    }
    return -1;
}

function splitTopLevel(text) {
    const parts = [];
    let start = 0;
    const depth = { '(': 0, '[': 0, '{': 0, '<': 0 };
    const closing = { ')': '(', ']': '[', '}': '{', '>': '<' };
    let quote = null;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (Object.hasOwn(depth, character)) depth[character]++;
        else if (Object.hasOwn(closing, character)) {
            const opener = closing[character];
            depth[opener] = Math.max(0, depth[opener] - 1);
        } else if (character === ',' &&
            Object.values(depth).every(value => value === 0)) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

function hasTopLevelDefault(parameter) {
    const depth = { '(': 0, '[': 0, '{': 0, '<': 0 };
    const closing = { ')': '(', ']': '[', '}': '{', '>': '<' };
    for (let index = 0; index < parameter.length; index++) {
        const character = parameter[index];
        if (Object.hasOwn(depth, character)) depth[character]++;
        else if (Object.hasOwn(closing, character)) {
            const opener = closing[character];
            depth[opener] = Math.max(0, depth[opener] - 1);
        } else if (character === '=' &&
            parameter[index - 1] !== '=' &&
            parameter[index + 1] !== '=' &&
            Object.values(depth).every(value => value === 0)) {
            return true;
        }
    }
    return false;
}

function arityAccepts(arity, count) {
    return Number.isInteger(count) &&
        count >= arity.min &&
        (arity.max == null || count <= arity.max);
}

function documentSymbolName(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const operatorName = canonicalOperatorName(text);
    if (operatorName) return operatorName;
    let name = text.replace(/\s*\(.*$/s, '').replace(/^.*::/, '').trim();
    name = name.replace(/<.*>$/s, '').trim();
    return name.match(/^~?[A-Za-z_][A-Za-z0-9_]*/)?.[0] || null;
}

function nameColumns(line, name) {
    const columns = [];
    for (let from = 0; from <= line.length - name.length;) {
        const at = line.indexOf(name, from);
        if (at < 0) break;
        const before = at === 0 ? '' : line[at - 1];
        const after = line[at + name.length] || '';
        if (!/[A-Za-z0-9_]/.test(before) &&
            !/[A-Za-z0-9_]/.test(after)) {
            columns.push(at);
        }
        from = at + Math.max(1, name.length);
    }
    return columns;
}

function normalizeLocation(location) {
    if (!location) return null;
    const uri = location.targetUri || location.uri;
    const range = location.targetSelectionRange ||
        location.targetRange || location.range;
    return uri && range ? { uri, range } : null;
}

function enumerateSourceFiles(root, excluded = []) {
    const excludedRoots = excluded.map(relative => {
        const resolved = canonical(path.resolve(root, relative));
        return inside(root, resolved) ? resolved : null;
    }).filter(Boolean);
    const isExcluded = absolute => excludedRoots.some(excludedRoot =>
        inside(excludedRoot, absolute));
    const files = [];
    const queue = [root];
    while (queue.length > 0) {
        const directory = queue.shift();
        if (isExcluded(directory)) continue;
        for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
        })) {
            if (entry.name.startsWith('.') &&
                entry.name !== '.clangd') continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRS.has(entry.name) && !isExcluded(absolute)) {
                    queue.push(absolute);
                }
            } else if (SOURCE_EXTENSIONS.has(
                path.extname(entry.name).toLowerCase()) &&
                !isExcluded(absolute)) {
                files.push(canonical(absolute));
            }
        }
    }
    return files.sort();
}

function findCompilationDatabase(root) {
    let current = root;
    for (let depth = 0; depth < 4; depth++) {
        const file = path.join(current, 'compile_commands.json');
        if (fs.existsSync(file)) {
            return { directory: current, generated: false };
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function createCompilationDatabase(root, files, language, extraFlags) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ucn-clangd-'));
    const compiler = language === 'c' ? resolveClang() : resolveClangxx();
    const standard = language === 'c' ? '-std=c11' : '-std=c++17';
    const includes = [
        `-I${root}`,
        ...(fs.existsSync(path.join(root, 'include'))
            ? [`-I${path.join(root, 'include')}`] : []),
        ...(fs.existsSync(path.join(root, 'src'))
            ? [`-I${path.join(root, 'src')}`] : []),
    ];
    const systemIncludes = language === 'cpp'
        ? resolveCxxSystemIncludes() : [];
    // Headers do not have an independent compilation configuration. Giving
    // each one a synthetic `-x c++-header` command makes clangd prefer that
    // context over the real translation units which instantiate it, leaving
    // template and macro-dependent references unresolved. Publish a normal
    // compilation database for source translation units and let clangd infer
    // each header's command from its actual includers. Header-only fixtures
    // retain standalone commands as the only available configuration.
    const translationUnits = files.filter(file => ![
        '.h', '.hh', '.hpp', '.hxx', '.inc',
    ].includes(path.extname(file).toLowerCase()));
    const commandFiles = translationUnits.length > 0
        ? translationUnits : files;
    const commands = commandFiles.map(file => {
        const extension = path.extname(file).toLowerCase();
        const header = ['.h', '.hh', '.hpp', '.hxx', '.inc']
            .includes(extension);
        const languageFlag = language === 'c'
            ? (header ? 'c-header' : 'c')
            : (header ? 'c++-header' : 'c++');
        return {
            directory: root,
            file,
            arguments: [
                compiler,
                '-x', languageFlag,
                standard,
                ...systemIncludes.flatMap(directory =>
                    ['-isystem', directory]),
                ...includes,
                ...extraFlags,
                '-fsyntax-only',
                file,
            ],
        };
    });
    fs.writeFileSync(
        path.join(directory, 'compile_commands.json'),
        JSON.stringify(commands));
    return { directory, generated: true };
}

function resolveCxxSystemIncludes() {
    // Some Command Line Tools installations advertise
    // `<CLT>/usr/include/c++/v1` even though libc++ ships only inside the
    // selected macOS SDK. clangd then parses every standard-library include as
    // missing and abstains on otherwise resolvable project calls. Supply the
    // SDK libc++ directory when present. Other platforms keep their compiler
    // defaults untouched.
    if (process.platform !== 'darwin') return [];
    const result = spawnSync('xcrun', ['--show-sdk-path'], {
        stdio: 'pipe',
    });
    if (result.status !== 0) return [];
    const sdk = result.stdout?.toString().trim();
    const libcxx = sdk && path.join(sdk, 'usr', 'include', 'c++', 'v1');
    return libcxx && fs.existsSync(path.join(libcxx, 'string'))
        ? [libcxx] : [];
}

function resolveClangd() {
    const explicit = process.env.UCN_EVAL_CLANGD;
    if (explicit) return explicit;
    if (spawnSync('clangd', ['--version'], {
        stdio: 'pipe',
    }).status === 0) return 'clangd';
    throw new Error(
        'clangd not found — install LLVM clangd or set UCN_EVAL_CLANGD');
}

function resolveClang() {
    if (spawnSync('clang', ['--version'], {
        stdio: 'pipe',
    }).status === 0) return 'clang';
    return 'cc';
}

function resolveClangxx() {
    if (spawnSync('clang++', ['--version'], {
        stdio: 'pipe',
    }).status === 0) return 'clang++';
    return 'c++';
}

function canonical(value) {
    if (!value) return '';
    const absolute = path.resolve(value);
    try {
        return fs.realpathSync.native
            ? fs.realpathSync.native(absolute)
            : fs.realpathSync(absolute);
    } catch {
        return absolute;
    }
}

function inside(root, candidate) {
    const relative = path.relative(canonical(root), canonical(candidate));
    return relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' &&
         !path.isAbsolute(relative));
}

// canonicalOperatorName is exported for the lockstep test against the
// engine-side canon (languages/c-family.js).
module.exports = { clangdOracle, canonicalOperatorName };
