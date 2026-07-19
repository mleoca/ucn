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
            },
        });
        await lsp2.initialize(repoRoot, {
            settings: {
                java: {
                    // autobuild ON: JDT's search engine answers references from
                    // the BUILT index — with autobuild off every query returns []
                    autobuild: { enabled: true },
                    import: { gradle: { enabled: false }, maven: { enabled: true } },
                    references: { includeDecompiledSources: false },
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
        const handle = { lsp: lsp2, helper, root: repoDir, repoRoot };
        // jdtls does NOT honor includeDeclaration (measured), so a zero-usage
        // sentinel legitimately returns [] — poll across several symbols; ANY
        // non-empty result proves the search index is serving.
        const sentinels = (await helper.request({ op: 'list_symbols' })).symbols
            .filter(s => s.kind === 'method').slice(0, 5);
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
        process.stdout.write(`  jdtls ready (root ${path.relative(repoDir, repoRoot) || '.'}, workspace ${dataDir})\n`);

        return handle;
    },

    /** javac-enumerated defs (methods incl. static, classes/enums/records). */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = resp.symbols || [];
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
            refs.push({ file: relFile, line: refLine, kind: cls.kind });
        }
        return refs;
    },

    /** Resolve the compiler-selected declaration(s) at a call/reference line.
     *  Eclipse reference search intentionally expands virtual method families;
     *  definition lookup recovers the exact static target for precision and
     *  callee-placement adjudication. */
    async resolveDefinition(handle, { name, file, line }) {
        const absFile = path.join(handle.root, file);
        const sourceLine = fs.readFileSync(absFile, 'utf-8').split('\n')[line - 1] || '';
        const columns = nameColumns(sourceLine, name);
        const defs = new Map();
        for (const character of columns) {
            const locations = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character },
            }) || [];
            for (const loc of Array.isArray(locations) ? locations : [locations]) {
                const uri = loc.targetUri || loc.uri;
                const range = loc.targetSelectionRange || loc.targetRange || loc.range;
                if (!uri || !range) continue;
                const defAbs = uriToPath(uri);
                if (!defAbs.startsWith(handle.repoRoot + path.sep)) continue;
                const entry = { file: path.relative(handle.root, defAbs), line: range.start.line + 1 };
                defs.set(`${entry.file}:${entry.line}`, entry);
            }
        }
        return [...defs.values()];
    },

    async dispose(handle) {
        try { handle.helper.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch (e) { /* gone */ }
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
        } catch (e) { /* gone */ }
    },
};

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

module.exports = { jdtlsOracle };
