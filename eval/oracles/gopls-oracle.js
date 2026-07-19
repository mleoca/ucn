/**
 * eval/oracles/gopls-oracle.js - Go oracle via gopls (LSP).
 *
 * Same architecture as the pyright oracle: symbol enumeration + reference
 * CLASSIFICATION come from a stdlib-ast helper (go-ast-helper.go via
 * `go run` — go/parser positions, no UCN parser involved), references come
 * from gopls textDocument/references rooted at the Go module root. gopls
 * loads the whole module graph itself, so no didOpen-all is needed — only
 * the queried file is opened.
 *
 * gopls resolution: $UCN_EVAL_GOPLS, else `gopls` on PATH, else ~/go/bin/gopls.
 * Requires a Go toolchain (also needed to `go run` the helper).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_PATH = path.join(__dirname, 'go-ast-helper.go');

const goplsOracle = {
    name: 'gopls',
    languages: ['go'],

    async prepare(repoDir) {
        const gopls = resolveGopls();
        const moduleRoot = findModuleRoot(repoDir);

        const helperChild = spawn('go', ['run', HELPER_PATH, repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(helperChild, { label: 'go ast helper' });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) throw new Error(`go ast helper failed to start: ${banner.error}`);

        const lsp = new LspClient(gopls, ['serve']);
        await lsp.initialize(moduleRoot);
        const version = spawnSync(gopls, ['version'], { stdio: 'pipe' }).stdout?.toString().trim().split('\n')[0] || 'unknown';
        process.stdout.write(`  ${version} (module root ${path.relative(repoDir, moduleRoot) || '.'})\n`);

        return { lsp, helper, root: repoDir, moduleRoot, opened: new Set() };
    },

    /** ast-enumerated defs (functions, methods, structs-as-class). */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = resp.symbols || [];
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** gopls references at the def-name position, go/ast-classified. */
    async findReferences(handle, { name, file, line }) {
        const pos = await handle.helper.request({ op: 'name_position', file, line, name });
        const absFile = path.join(handle.root, file);
        if (!handle.opened.has(absFile)) {
            handle.lsp.didOpen(absFile, 'go', fs.readFileSync(absFile, 'utf-8'));
            handle.opened.add(absFile);
        }
        const locations = await handle.lsp.request('textDocument/references', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: pos.line - 1, character: pos.utf16Col },
            context: { includeDeclaration: true },
        }) || [];

        const refs = [];
        for (const loc of locations) {
            const refAbs = uriToPath(loc.uri);
            if (!refAbs.startsWith(handle.moduleRoot + path.sep)) continue;
            const relFile = path.relative(handle.root, refAbs);
            const refLine = loc.range.start.line + 1;
            const cls = await handle.helper.request({
                op: 'classify_ref', file: relFile, line: refLine,
                utf16_col: loc.range.start.character, name,
            });
            refs.push({ file: relFile, line: refLine, kind: cls.kind });
        }
        return refs;
    },

    /** Resolve the compiler-selected declaration at a call/reference line.
     *  gopls reference search expands implicit interface implementation
     *  families; definition lookup recovers the static target so broad
     *  virtual-family references do not masquerade as exact edges. */
    async resolveDefinition(handle, { name, file, line }) {
        const absFile = path.join(handle.root, file);
        ensureOpen(handle, absFile);
        const sourceLine = fs.readFileSync(absFile, 'utf-8').split('\n')[line - 1] || '';
        const defs = new Map();
        for (const character of nameColumns(sourceLine, name)) {
            const locations = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character },
            }) || [];
            for (const loc of Array.isArray(locations) ? locations : [locations]) {
                const uri = loc.targetUri || loc.uri;
                const range = loc.targetSelectionRange || loc.targetRange || loc.range;
                if (!uri || !range) continue;
                const defAbs = uriToPath(uri);
                if (!defAbs.startsWith(handle.moduleRoot + path.sep)) continue;
                const entry = {
                    file: path.relative(handle.root, defAbs),
                    line: range.start.line + 1,
                };
                defs.set(`${entry.file}:${entry.line}`, entry);
            }
        }
        return [...defs.values()];
    },

    /** Go build constraints and ignored source directories are outside the
     *  active gopls package universe. Keep such UCN edges explicit but
     *  unscored instead of reporting them as false positives. */
    async isConfigurationGated(handle, { file }) {
        const resp = await handle.helper.request({ op: 'source_status', file });
        return !!resp.gated;
    },

    async dispose(handle) {
        try { handle.helper.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch { /* gone */ }
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
        } catch { /* gone */ }
    },
};

function ensureOpen(handle, absFile) {
    if (handle.opened.has(absFile)) return;
    handle.lsp.didOpen(absFile, 'go', fs.readFileSync(absFile, 'utf-8'));
    handle.opened.add(absFile);
}

function nameColumns(line, name) {
    const out = [];
    for (let from = 0; from <= line.length;) {
        const i = line.indexOf(name, from);
        if (i < 0) break;
        const before = i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]);
        const end = i + name.length;
        const after = end >= line.length || !/[A-Za-z0-9_]/.test(line[end]);
        if (before && after) out.push([...line.slice(0, i)].join('').length);
        from = i + Math.max(1, name.length);
    }
    return out;
}

function resolveGopls() {
    const explicit = process.env.UCN_EVAL_GOPLS;
    if (explicit) return explicit;
    if (spawnSync('gopls', ['version'], { stdio: 'pipe' }).status === 0) return 'gopls';
    const gopath = path.join(os.homedir(), 'go', 'bin', 'gopls');
    if (fs.existsSync(gopath)) return gopath;
    throw new Error('gopls not found — go install golang.org/x/tools/gopls@latest, or set UCN_EVAL_GOPLS');
}

function findModuleRoot(dir) {
    let current = dir;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(current, 'go.mod'))) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return dir;
}

module.exports = { goplsOracle };
