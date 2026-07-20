/**
 * eval/oracles/pyright-oracle.js - Python oracle via pyright-langserver (LSP).
 *
 * Stronger inference than jedi (the prior Python oracle): pyright's type
 * checker resolves receivers jedi gives up on, shrinking the unverifiable
 * share of precision scoring. Architecture:
 *  - symbol enumeration + reference CLASSIFICATION reuse jedi-helper.py's
 *    ast machinery (list_symbols / name_position / classify_ref — stdlib
 *    only, no jedi import needed), so the two Python oracles share one
 *    symbol universe and kind taxonomy
 *  - references come from textDocument/references over LSP, rooted at the
 *    detected Python project root so tests/ callers resolve (same universe
 *    rule the jedi oracle learned)
 *
 * pyright is a devDependency (exact-pinned); never loaded at runtime by UCN.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_PATH = path.join(__dirname, 'jedi-helper.py');

const pyrightOracle = {
    name: 'pyright',
    languages: ['python'],

    /**
     * @param {string} repoDir - the analysis target directory (same dir UCN indexes)
     */
    async prepare(repoDir) {
        let serverPath;
        try {
            serverPath = require.resolve('pyright/langserver.index.js');
        } catch (e) {
            throw new Error('pyright devDependency not installed — run npm install');
        }

        // ast helper: any python3 works (no jedi needed for these ops)
        const python = process.env.UCN_EVAL_PYTHON || 'python3';
        const helperChild = spawn(python, [HELPER_PATH, repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(helperChild, { label: 'ast helper' });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) throw new Error(`ast helper failed to start: ${banner.error}`);
        const projectRoot = banner.projectRoot;

        // workspace diagnosticMode: the default openFilesOnly builds the
        // program from opened files + their imports, so references never see
        // unopened callers (tests/). Workspace mode loads every file under
        // the project root — the same universe rule the jedi oracle follows.
        const lsp = new LspClient(process.execPath, [serverPath, '--stdio'], {
            settings: {
                python: {
                    analysis: {
                        diagnosticMode: 'workspace',
                        autoSearchPaths: true,
                        useLibraryCodeForTypes: true,
                    },
                },
            },
        });
        await lsp.initialize(projectRoot);

        // didOpen every .py file: workspace loading is an async background
        // task with no completion barrier, and references only search files
        // already in the program. Opening them all makes the reference
        // universe deterministic (same rationale as pinned commits).
        const opened = new Set();
        const pyFiles = walkPyFiles(projectRoot);
        for (const abs of pyFiles) {
            lsp.didOpen(abs, 'python', fs.readFileSync(abs, 'utf-8'));
            opened.add(abs);
        }
        const version = require('pyright/package.json').version;
        process.stdout.write(`  pyright ${version} (project root ${path.relative(repoDir, projectRoot) || '.'}, ${pyFiles.length} files opened)\n`);

        return { lsp, helper, root: repoDir, projectRoot, opened };
    },

    /** ast-enumerated defs — same universe/line convention as the jedi oracle. */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = resp.symbols;
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** LSP references at the def-name position, ast-classified. */
    async findReferences(handle, { name, file, line }) {
        const pos = await handle.helper.request({ op: 'name_position', file, line, name });
        const absFile = path.join(handle.root, file);
        if (!handle.opened.has(absFile)) {
            handle.lsp.didOpen(absFile, 'python', fs.readFileSync(absFile, 'utf-8'));
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
            if (!refAbs.startsWith(handle.projectRoot + path.sep)) continue;
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

    /** Resolve the exact declaration selected at a claimed call/reference.
     *  Bulk reference search can omit alias, lazy-module, platform, and local
     *  flow sites. Precision credit is granted only when this independent
     *  definition lookup lands on the sampled declaration. */
    async resolveDefinition(handle, { name, file, line }) {
        const absFile = path.join(handle.root, file);
        if (!handle.opened.has(absFile)) {
            handle.lsp.didOpen(absFile, 'python', fs.readFileSync(absFile, 'utf-8'));
            handle.opened.add(absFile);
        }
        const sourceLine = fs.readFileSync(absFile, 'utf-8').split('\n')[line - 1] || '';
        const defs = new Map();
        const requestAt = async (queryFile, queryLine, character) => {
            const response = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(queryFile) },
                position: { line: queryLine - 1, character },
            }) || [];
            for (const loc of Array.isArray(response) ? response : [response]) {
                const uri = loc.targetUri || loc.uri;
                const range = loc.targetSelectionRange || loc.targetRange || loc.range;
                if (!uri || !range) continue;
                const defAbs = uriToPath(uri);
                if (!defAbs.startsWith(handle.projectRoot + path.sep)) continue;
                const entry = {
                    file: path.relative(handle.root, defAbs),
                    line: range.start.line + 1,
                };
                defs.set(`${entry.file}:${entry.line}`, entry);
            }
        };
        for (const character of nameColumns(sourceLine, name)) {
            await requestAt(absFile, line, character);
        }

        // Pyright resolves a call through a local callable alias to the alias
        // assignment. Follow one simple assignment hop to recover the actual
        // declaration while keeping arbitrary data-flow out of the oracle.
        const firstHop = [...defs.values()];
        for (const entry of firstHop) {
            const defAbs = path.join(handle.root, entry.file);
            let defLine = '';
            try { defLine = fs.readFileSync(defAbs, 'utf-8').split('\n')[entry.line - 1] || ''; } catch { continue; }
            const rhs = simpleCallableAliasRhs(defLine, name);
            if (!rhs) continue;
            if (!handle.opened.has(defAbs)) {
                handle.lsp.didOpen(defAbs, 'python', fs.readFileSync(defAbs, 'utf-8'));
                handle.opened.add(defAbs);
            }
            await requestAt(defAbs, entry.line, rhs.character);
        }
        return [...defs.values()];
    },

    async isConfigurationGated(handle, { file, line }) {
        const status = await handle.helper.request({ op: 'source_status', file, line });
        return !!status.configurationGated;
    },
};

function nameColumns(line, name) {
    const cols = [];
    let from = 0;
    while (from <= line.length) {
        const i = line.indexOf(name, from);
        if (i < 0) break;
        const before = i > 0 ? line[i - 1] : '';
        const after = line[i + name.length] || '';
        if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) cols.push(i);
        from = i + Math.max(1, name.length);
    }
    return cols;
}

function simpleCallableAliasRhs(line, queriedName) {
    const match = line.match(/^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*(?:#.*)?$/);
    if (!match || match[1] !== queriedName) return null;
    const rhsName = match[2];
    const character = line.lastIndexOf(rhsName);
    return character >= 0 ? { name: rhsName, character } : null;
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', '.tox', '.ucn-cache']);
const MAX_OPEN_FILES = 5000;

function walkPyFiles(root) {
    const out = [];
    const stack = [root];
    while (stack.length > 0 && out.length < MAX_OPEN_FILES) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
                    stack.push(path.join(dir, entry.name));
                }
            } else if (entry.name.endsWith('.py')) {
                out.push(path.join(dir, entry.name));
            }
        }
    }
    return out.sort();
}

module.exports = { pyrightOracle };
