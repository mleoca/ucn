/**
 * eval/oracles/rust-analyzer-oracle.js - Rust oracle via rust-analyzer (LSP).
 *
 * Same architecture as the gopls/pyright oracles: symbol enumeration +
 * reference CLASSIFICATION come from an independent ast helper
 * (rust-ast-helper, a tiny syn-based crate — no UCN parser involved),
 * reference RESOLUTION comes from rust-analyzer textDocument/references
 * rooted at the cargo WORKSPACE root (ripgrep is a workspace; r-a needs
 * cargo metadata from the root to resolve cross-crate refs).
 *
 * Readiness camp: unlike gopls (sync on first request) and pyright
 * (didOpen-all), rust-analyzer indexes asynchronously after initialize and
 * answers early requests from an incomplete index. The deterministic barrier
 * is the experimental/serverStatus notification with quiescent=true —
 * requested via the serverStatusNotification client capability.
 *
 * Projection (fix #406): rust-analyzer discovers only the Cargo workspace at
 * the root, so a nested workspace (`benches/Cargo.toml` with its own
 * `[workspace]`, fuzz crates, crates excluded from the root workspace) would
 * sit outside its projection while UCN indexes it. Every Cargo workspace
 * under the target is linked explicitly. Configuration status is the
 * server's own answer (pull diagnostics: `inactive-code` ranges and
 * `unlinked-file`), never a syntactic `#[cfg]` test: features=all makes most
 * feature-gated code active, and active code is scored. Calls a project
 * macro_rules! transcriber generates are resolved through rust-analyzer's own
 * expansion of the invocation (`rust-analyzer/expandMacro`), inlined in its
 * in-memory copy of the file.
 *
 * rust-analyzer resolution: $UCN_EVAL_RUST_ANALYZER, else PATH. Requires a
 * cargo toolchain (also builds/runs the syn helper).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_MANIFEST = path.join(__dirname, 'rust-ast-helper', 'Cargo.toml');
// `serverStatus.quiescent` is rust-analyzer's semantic-readiness barrier. The
// evaluator disables optional cache priming below: it is a latency optimization
// that can stall independently after the workspace is ready, and reference
// queries populate the same semantic caches lazily. Keep a bounded failure
// instead of querying an incomplete workspace. CI can override the bound
// explicitly without weakening readiness semantics.
const configuredQuiescentTimeout = Number.parseInt(
    process.env.UCN_EVAL_RUST_QUIESCENT_TIMEOUT_MS || '', 10);
const QUIESCENT_TIMEOUT_MS = Number.isFinite(configuredQuiescentTimeout) &&
    configuredQuiescentTimeout > 0 ? configuredQuiescentTimeout : 900000;

const rustAnalyzerOracle = {
    name: 'rust-analyzer',
    languages: ['rust'],

    async prepare(repoDir) {
        const ra = resolveRustAnalyzer();
        const workspaceRoot = findWorkspaceRoot(repoDir);
        const linkedProjects = cargoLinkedProjects(repoDir, workspaceRoot);

        // Build the helper up front so compile output never races the banner.
        const build = spawnSync('cargo', ['build', '--quiet', '--manifest-path', HELPER_MANIFEST], { stdio: ['ignore', 'ignore', 'inherit'] });
        if (build.status !== 0) throw new Error('rust-ast-helper build failed (cargo toolchain required)');
        const helperChild = spawn('cargo', ['run', '--quiet', '--manifest-path', HELPER_MANIFEST, '--', repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(helperChild, { label: 'rust ast helper' });
        let lsp = null;
        try {
            const banner = JSON.parse(await helper.expectLine());
            if (!banner.ok) throw new Error(`rust ast helper failed to start: ${banner.error}`);

            let quiesced;
            const quiescent = new Promise((resolve, reject) => {
                quiesced = resolve;
                setTimeout(() => reject(new Error(`rust-analyzer not quiescent after ${QUIESCENT_TIMEOUT_MS}ms`)),
                    QUIESCENT_TIMEOUT_MS).unref();
            });
            lsp = new LspClient(ra, [], {
                capabilities: {
                    workspace: {
                        didChangeWatchedFiles: { dynamicRegistration: true },
                    },
                    // Pull diagnostics carry the server's own projection:
                    // inactive-code ranges and unlinked files.
                    textDocument: { diagnostic: { dynamicRegistration: false } },
                    experimental: { serverStatusNotification: true },
                },
                onNotification: (method, params) => {
                    if (method === 'experimental/serverStatus' && params?.quiescent) quiesced(params);
                },
            });
            // Evaluate the all-source contract, not only Cargo's default feature
            // projection. Otherwise valid calls under `#[cfg(feature = ...)]`
            // are mislabeled as UCN false positives merely because rust-analyzer
            // marked that source inactive in this one configuration.
            await lsp.initialize(workspaceRoot, {
                checkOnSave: false,
                cachePriming: { enable: false },
                // Pinned eval clones are immutable while queried. Let the
                // minimal client own change notifications so macOS's server
                // watcher cannot strand VFS readiness at N-1 roots.
                files: { watcher: 'client' },
                cargo: { features: 'all', allTargets: true },
                ...(linkedProjects.length > 1 && { linkedProjects }),
            });
            process.stdout.write('  waiting for rust-analyzer to load the workspace (cargo metadata + build scripts)...\n');
            const status = await quiescent;
            if (status.health && status.health !== 'ok') {
                process.stdout.write(`  ⚠ rust-analyzer health: ${status.health} ${status.message || ''}\n`);
            }
            const version = spawnSync(ra, ['--version'], { stdio: 'pipe' }).stdout?.toString().trim() || 'unknown';
            process.stdout.write(`  ${version} (workspace root ${path.relative(repoDir, workspaceRoot) || '.'})\n`);
            if (linkedProjects.length > 1) {
                process.stdout.write(`  linked Cargo workspaces: ${linkedProjects
                    .map(manifest => path.relative(repoDir, path.dirname(manifest)) || '.').join(', ')}\n`);
            }

            return {
                lsp, helper, root: repoDir, workspaceRoot, opened: new Set(),
                versions: new Map(), projection: new Map(), expansions: new Map(),
            };
        } catch (error) {
            // A prepare failure happens before run-oracle-eval owns a handle,
            // so its normal finally/dispose path cannot help. Close both
            // subprocesses here; otherwise a timed-out PrimeCaches pass keeps
            // consuming resources and contaminates later language rows.
            try { helperChild.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch { /* gone */ }
            try { helperChild.kill(); } catch { /* gone */ }
            try { lsp?.kill(); } catch { /* gone */ }
            throw error;
        }
    },

    /** syn-enumerated defs (fns, impl methods, structs/enums-as-class). */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = resp.symbols || [];
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** rust-analyzer references at the def-name position, syn-classified. */
    async findReferences(handle, { name, file, line }) {
        const pos = await handle.helper.request({ op: 'name_position', file, line, name });
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const locations = await handle.lsp.request('textDocument/references', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: pos.line - 1, character: pos.utf16Col },
            context: { includeDeclaration: true },
        }) || [];

        const refs = [];
        for (const loc of locations) {
            const refAbs = uriToPath(loc.uri);
            if (!refAbs.startsWith(handle.workspaceRoot + path.sep)) continue;
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

    /** Resolve the compiler-selected declaration(s) for a source-line name.
     *  Reference search can omit inactive/re-exported workspace edges; this
     *  independent definition check prevents those gaps from becoming fake
     *  UCN precision failures. */
    async resolveDefinition(handle, { name, file, line, column }) {
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const sourceLine = fs.readFileSync(absFile, 'utf-8').split('\n')[line - 1] || '';
        const columns = Number.isInteger(column) ? [column] : nameColumns(sourceLine, name);
        const defs = new Map();
        for (const character of columns) {
            const locations = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character },
            }) || [];
            for (const entry of definitionEntries(handle, locations)) {
                defs.set(entry.external ? `external:${entry.file}:${entry.line}`
                    : `${entry.file}:${entry.line}`, entry);
            }
        }
        return [...defs.values()];
    },

    /** Resolve a name a project macro_rules! transcriber generated on this
     *  line. The line's source invocations are expanded by rust-analyzer
     *  (recursively), each expansion is inlined in place of its invocation in
     *  the server's in-memory copy of the file, every occurrence of the name
     *  inside it is resolved, and the file is restored. Returns null when no
     *  invocation on the line expands to text holding the name; otherwise
     *  the resolved declarations and how many occurrences resolved nowhere. */
    async resolveExpandedDefinition(handle, { name, file, line }) {
        const cacheKey = `${file}:${line}:${name}`;
        if (handle.expansions.has(cacheKey)) return handle.expansions.get(cacheKey);
        const { calls = [] } = await handle.helper.request({ op: 'macro_calls', file, line });
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const original = fs.readFileSync(absFile, 'utf-8');
        const definitions = new Map();
        let occurrences = 0;
        let unresolved = 0;
        for (const call of calls) {
            const expanded = await handle.lsp.request('rust-analyzer/expandMacro', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: call.pathLine - 1, character: call.pathUtf16Col },
            });
            const inlined = inlineExpansion(original, call, expanded?.expansion);
            if (!inlined) continue;
            const offsets = wordOffsets(inlined.replacement, name)
                .map(offset => inlined.start + offset);
            if (offsets.length === 0) continue;
            setDocumentText(handle, absFile, inlined.text);
            try {
                for (const offset of offsets) {
                    occurrences++;
                    const locations = await handle.lsp.request('textDocument/definition', {
                        textDocument: { uri: pathToUri(absFile) },
                        position: positionAt(inlined.text, offset),
                    }) || [];
                    const entries = definitionEntries(handle, locations, {
                        absFile, inlined,
                    });
                    if (entries.length === 0) unresolved++;
                    for (const entry of entries) {
                        definitions.set(entry.external ? `external:${entry.file}:${entry.line}`
                            : `${entry.file}:${entry.line}:${entry.generated ? 'g' : ''}`, entry);
                    }
                }
            } finally {
                setDocumentText(handle, absFile, original);
            }
        }
        const result = occurrences === 0 ? null
            : { definitions: [...definitions.values()], unresolved };
        handle.expansions.set(cacheKey, result);
        return result;
    },

    /** Whether rust-analyzer's own projection leaves this line out: inside
     *  an `inactive-code` range (a `#[cfg]` false for the loaded features and
     *  host target) or in a file no loaded crate includes (`unlinked-file`).
     *  A line it analyzes is never configuration-gated, whatever `#[cfg]`
     *  attributes it carries. */
    async isConfigurationGated(handle, { file, line }) {
        const absFile = path.join(handle.root, file);
        let status = handle.projection.get(absFile);
        if (!status) {
            ensureOpen(handle, absFile);
            const report = await handle.lsp.request('textDocument/diagnostic', {
                textDocument: { uri: pathToUri(absFile) },
            });
            if (!report || !Array.isArray(report.items)) {
                throw new Error(`rust-analyzer returned no diagnostic report for ${file}`);
            }
            status = projectionStatus(report.items);
            handle.projection.set(absFile, status);
        }
        return lineOutsideProjection(status, line);
    },

    /** Graceful teardown — without LSP shutdown r-a prints a panic backtrace on exit. */
    async dispose(handle) {
        try { handle.helper.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch (e) { /* gone */ }
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
        } catch (e) { /* gone */ }
    },
};

function ensureOpen(handle, absFile) {
    if (handle.opened.has(absFile)) return;
    handle.lsp.didOpen(absFile, 'rust', fs.readFileSync(absFile, 'utf-8'));
    handle.opened.add(absFile);
    handle.versions.set(absFile, 1);
}

function setDocumentText(handle, absFile, text) {
    const version = (handle.versions.get(absFile) || 1) + 1;
    handle.versions.set(absFile, version);
    handle.lsp.didChange(absFile, version, text);
}

/** LSP definition locations as {file, line[, external | generated]}. A
 *  location in the inlined copy of `absFile` maps back to source lines; one
 *  inside the inlined expansion is a declaration the expansion generated. */
function definitionEntries(handle, locations, { absFile = null, inlined = null } = {}) {
    const entries = [];
    for (const loc of Array.isArray(locations) ? locations : [locations]) {
        const uri = loc?.targetUri || loc?.uri;
        const range = loc?.targetSelectionRange || loc?.targetRange || loc?.range;
        if (!uri || !range) continue;
        const defAbs = uriToPath(uri);
        if (!defAbs.startsWith(handle.workspaceRoot + path.sep)) {
            entries.push({ file: defAbs, line: range.start.line + 1, external: true });
            continue;
        }
        let defLine = range.start.line + 1;
        if (inlined && defAbs === absFile) {
            const original = originalLine(inlined, offsetAt(inlined.text, range.start));
            if (original === null) {
                // Declared by the expansion itself: never a source definition.
                entries.push({ file: path.relative(handle.root, defAbs), line: 0, generated: true });
                continue;
            }
            defLine = original;
        }
        entries.push({ file: path.relative(handle.root, defAbs), line: defLine });
    }
    return entries;
}

/** The server's projection facts for one file, from its pull diagnostics. */
function projectionStatus(items) {
    const inactive = [];
    let unlinked = false;
    for (const item of items || []) {
        const code = typeof item?.code === 'object' ? item.code?.value : item?.code;
        if (code === 'unlinked-file') unlinked = true;
        else if (code === 'inactive-code' && item.range) {
            inactive.push([item.range.start.line + 1, item.range.end.line + 1]);
        }
    }
    return { unlinked, inactive };
}

function lineOutsideProjection(status, line) {
    return status.unlinked ||
        status.inactive.some(([start, end]) => line >= start && line <= end);
}

/**
 * Replace one macro invocation with its expansion text. The replacement
 * keeps the invocation's AST position: items stay items, a statement or
 * expression becomes a block (an expansion may be several statements).
 * Positions are 1-based lines and UTF-16 columns (the helper's protocol).
 */
function inlineExpansion(original, call, expansion) {
    if (typeof expansion !== 'string' || expansion.trim() === '') return null;
    let replacement;
    if (call.kind === 'item') replacement = `
${expansion}
`;
    else if (call.kind === 'stmt') replacement = `{
${expansion}
}`;
    else if (call.kind === 'expr') replacement = `({
${expansion}
})`;
    else return null;
    const start = offsetOfPosition(original, call.startLine, call.startUtf16Col);
    const end = offsetOfPosition(original, call.endLine, call.endUtf16Col);
    if (start === null || end === null || end < start) return null;
    return {
        original,
        text: original.slice(0, start) + replacement + original.slice(end),
        start,
        replacement,
        removed: end - start,
    };
}

/** Source line of an offset in the inlined text; null inside the expansion. */
function originalLine(inlined, offset) {
    if (offset === null) return null;
    const replacementEnd = inlined.start + inlined.replacement.length;
    if (offset >= inlined.start && offset < replacementEnd) return null;
    const sourceOffset = offset < inlined.start ? offset
        : offset - inlined.replacement.length + inlined.removed;
    return lineOfOffset(inlined.original, sourceOffset);
}

function offsetOfPosition(text, line, utf16Col) {
    let offset = 0;
    for (let current = 1; current < line; current++) {
        const next = text.indexOf('\n', offset);
        if (next < 0) return null;
        offset = next + 1;
    }
    return offset + utf16Col <= text.length ? offset + utf16Col : null;
}

function offsetAt(text, position) {
    return offsetOfPosition(text, position.line + 1, position.character);
}

function positionAt(text, offset) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length - 1;
    return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

function lineOfOffset(text, offset) {
    return text.slice(0, offset).split('\n').length;
}

/** Word-boundary occurrences of `name` (as Rust identifiers) in `text`. */
function wordOffsets(text, name) {
    const offsets = [];
    for (let from = 0; from <= text.length - name.length;) {
        const at = text.indexOf(name, from);
        if (at < 0) break;
        const before = at === 0 ? '' : text[at - 1];
        const after = text[at + name.length] || '';
        if (!/[\w]/.test(before) && !/[\w]/.test(after)) offsets.push(at);
        from = at + name.length;
    }
    return offsets;
}

/**
 * The Cargo workspaces rust-analyzer must load so its projection covers the
 * target: the target's own workspace plus every workspace whose manifest
 * lies under the target and is not a member of an already loaded one
 * (nested `[workspace]` roots, crates a root workspace excludes). Returns
 * manifest paths, the target's workspace first; a manifest Cargo cannot read
 * is reported and left out (rust-analyzer could not load it either).
 */
function cargoLinkedProjects(repoDir, workspaceRoot, { metadata = cargoMetadata, log = process.stdout } = {}) {
    const rootManifest = path.join(workspaceRoot, 'Cargo.toml');
    const manifests = [rootManifest, ...walkManifests(repoDir)
        .filter(manifest => manifest !== rootManifest)];
    const covered = new Set();
    const linked = [];
    for (const manifest of manifests) {
        if (covered.has(manifest) || !fs.existsSync(manifest)) continue;
        let info;
        try {
            info = metadata(manifest);
        } catch (error) {
            log.write(`  ⚠ Cargo manifest not loadable, outside the oracle projection: ` +
                `${path.relative(repoDir, manifest)} (${String(error.message).split('\n')[0]})\n`);
            continue;
        }
        const workspaceManifest = path.join(info.workspaceRoot, 'Cargo.toml');
        for (const member of info.memberManifests) covered.add(member);
        covered.add(workspaceManifest);
        if (!linked.includes(workspaceManifest)) linked.push(workspaceManifest);
    }
    return linked;
}

function cargoMetadata(manifest) {
    const result = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1',
        '--manifest-path', manifest], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(result.stderr?.toString().trim() || `cargo metadata exited ${result.status}`);
    }
    const parsed = JSON.parse(result.stdout.toString());
    const members = new Set(parsed.workspace_members || []);
    return {
        workspaceRoot: parsed.workspace_root,
        memberManifests: (parsed.packages || [])
            .filter(pkg => members.has(pkg.id))
            .map(pkg => pkg.manifest_path),
    };
}

/** Cargo.toml files under dir, skipping what the syn helper's symbol walk
 *  skips (hidden directories, build output, vendored and test-data trees). */
function walkManifests(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || ['target', 'node_modules', 'testdata', 'vendor']
                .includes(entry.name)) continue;
            out.push(...walkManifests(full));
        } else if (entry.name === 'Cargo.toml') {
            out.push(full);
        }
    }
    return out;
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

function resolveRustAnalyzer() {
    const explicit = process.env.UCN_EVAL_RUST_ANALYZER;
    if (explicit) return explicit;
    if (spawnSync('rust-analyzer', ['--version'], { stdio: 'pipe' }).status === 0) return 'rust-analyzer';
    throw new Error('rust-analyzer not found — brew install rust-analyzer / rustup component add rust-analyzer, or set UCN_EVAL_RUST_ANALYZER');
}

/** Nearest ancestor Cargo.toml with [workspace], else the nearest Cargo.toml. */
function findWorkspaceRoot(dir) {
    let nearestManifest = null;
    let current = dir;
    for (let i = 0; i < 8; i++) {
        const manifest = path.join(current, 'Cargo.toml');
        if (fs.existsSync(manifest)) {
            if (!nearestManifest) nearestManifest = current;
            if (/^\s*\[workspace\]/m.test(fs.readFileSync(manifest, 'utf-8'))) return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return nearestManifest || dir;
}

module.exports = {
    rustAnalyzerOracle,
    cargoLinkedProjects,
    projectionStatus,
    lineOutsideProjection,
    inlineExpansion,
    originalLine,
    wordOffsets,
};
