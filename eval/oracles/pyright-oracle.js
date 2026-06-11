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
const readline = require('readline');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');

const HELPER_PATH = path.join(__dirname, 'jedi-helper.py');
const HELPER_TIMEOUT_MS = 120000;

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
        const helper = makeHelperHandle(helperChild);
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
};

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

/** Same serialized line-paired protocol the jedi oracle uses for its helper. */
function makeHelperHandle(child) {
    const rl = readline.createInterface({ input: child.stdout });
    const queue = [];
    let dead = null;

    rl.on('line', (line) => {
        const entry = queue.shift();
        if (entry) {
            clearTimeout(entry.timer);
            entry.resolve(line);
        }
    });
    const fail = (err) => {
        dead = err;
        while (queue.length) {
            const entry = queue.shift();
            clearTimeout(entry.timer);
            entry.reject(err);
        }
    };
    child.on('error', (e) => fail(new Error(`ast helper spawn failed: ${e.message}`)));
    child.on('exit', (code) => fail(new Error(`ast helper exited (code ${code})`)));

    const expectLine = () => new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const entry = { resolve, reject };
        entry.timer = setTimeout(() => {
            fail(new Error(`ast helper timed out after ${HELPER_TIMEOUT_MS}ms`));
            child.kill();
            reject(new Error(`ast helper timed out after ${HELPER_TIMEOUT_MS}ms`));
        }, HELPER_TIMEOUT_MS);
        queue.push(entry);
    });

    const request = async (payload) => {
        if (dead) throw dead;
        child.stdin.write(JSON.stringify(payload) + '\n');
        const line = await expectLine();
        const resp = JSON.parse(line);
        if (!resp.ok) throw new Error(`ast helper: ${resp.error}`);
        return resp;
    };

    return { child, expectLine, request };
}

module.exports = { pyrightOracle };
