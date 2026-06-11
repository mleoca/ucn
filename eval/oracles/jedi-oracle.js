/**
 * eval/oracles/jedi-oracle.js - Python oracle via jedi.
 *
 * Ground truth from jedi's static analysis: a persistent Python helper
 * (jedi-helper.py) enumerates function/method/class defs via the stdlib ast
 * module (lines follow UCN's decorator-inclusive convention so file:line:name
 * handles pin exactly) and resolves references via jedi.Script.get_references,
 * classifying each by its exact AST position (call / import / definition /
 * reference).
 *
 * Python resolution: $UCN_EVAL_PYTHON if set, else python3 if it can already
 * import jedi, else a self-bootstrapped venv at <eval-temp>/jedi-venv pinned
 * to JEDI_VERSION (works in CI with no workflow changes). Never loaded at
 * runtime by UCN itself.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { EVAL_TEMP_DIR } = require('../lib/repos');

const JEDI_VERSION = '0.19.2';
const HELPER_PATH = path.join(__dirname, 'jedi-helper.py');
const REQUEST_TIMEOUT_MS = 300000;

const jediOracle = {
    name: 'jedi',
    languages: ['python'],

    /**
     * @param {string} repoDir - the analysis target directory (same dir UCN indexes)
     * @returns {{ request, child, root }}
     */
    async prepare(repoDir) {
        const python = resolvePython();
        const child = spawn(python, [HELPER_PATH, repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const handle = makeHandle(child, repoDir);
        const banner = await handle.expectLine(); // unprompted ready line
        const ready = JSON.parse(banner);
        if (!ready.ok) throw new Error(`jedi helper failed to start: ${ready.error}`);
        process.stdout.write(`  jedi ${ready.jedi} (python ${ready.python})\n`);
        return handle;
    },

    /** All function/method/class defs (limit/kinds filtering done here). */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.request({ op: 'list_symbols' });
        let symbols = resp.symbols;
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** References to the symbol declared at (file, line), classified by AST position. */
    async findReferences(handle, { name, file, line }) {
        const resp = await handle.request({ op: 'find_references', file, line, name });
        return resp.refs;
    },
};

/** Wrap the child in a serialized line-paired request interface. */
function makeHandle(child, root) {
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
    child.on('error', (e) => fail(new Error(`jedi helper spawn failed: ${e.message}`)));
    child.on('exit', (code) => fail(new Error(`jedi helper exited (code ${code})`)));

    const expectLine = () => new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const entry = { resolve, reject };
        // A timeout desynchronizes request/response pairing — kill the helper
        // so every later request fails loudly instead of mis-pairing.
        entry.timer = setTimeout(() => {
            fail(new Error(`jedi helper timed out after ${REQUEST_TIMEOUT_MS}ms`));
            child.kill();
            reject(new Error(`jedi helper timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        queue.push(entry);
    });

    const request = async (payload) => {
        if (dead) throw dead;
        child.stdin.write(JSON.stringify(payload) + '\n');
        const line = await expectLine();
        const resp = JSON.parse(line);
        if (!resp.ok) throw new Error(`jedi helper: ${resp.error}`);
        return resp;
    };

    return { child, root, expectLine, request };
}

/** Find a python that can import jedi, bootstrapping a pinned venv if needed. */
function resolvePython() {
    const explicit = process.env.UCN_EVAL_PYTHON;
    if (explicit) {
        if (!canImportJedi(explicit)) {
            throw new Error(`UCN_EVAL_PYTHON=${explicit} cannot import jedi — pip install jedi==${JEDI_VERSION}`);
        }
        return explicit;
    }
    const system = 'python3';
    const probe = spawnSync(system, ['--version'], { stdio: 'pipe', timeout: 30000 });
    if (probe.error || probe.status !== 0) {
        throw new Error('python3 not found on PATH — install Python 3.8+ or set UCN_EVAL_PYTHON');
    }
    if (canImportJedi(system)) return system;

    const venvDir = path.join(EVAL_TEMP_DIR, 'jedi-venv');
    const venvPython = path.join(venvDir,
        process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
    if (fs.existsSync(venvPython) && canImportJedi(venvPython)) return venvPython;

    process.stdout.write(`  bootstrapping jedi==${JEDI_VERSION} venv at ${venvDir}\n`);
    fs.rmSync(venvDir, { recursive: true, force: true });
    runOrThrow(system, ['-m', 'venv', venvDir]);
    runOrThrow(venvPython, ['-m', 'pip', 'install', '--quiet', `jedi==${JEDI_VERSION}`]);
    if (!canImportJedi(venvPython)) {
        throw new Error(`venv at ${venvDir} still cannot import jedi`);
    }
    return venvPython;
}

function canImportJedi(python) {
    const r = spawnSync(python, ['-c', 'import jedi'], { stdio: 'pipe', timeout: 30000 });
    return !r.error && r.status === 0;
}

function runOrThrow(cmd, args) {
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 300000 });
    if (r.error || r.status !== 0) {
        const stderr = r.stderr ? r.stderr.toString().trim() : '';
        throw new Error(`${cmd} ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`})${stderr ? `: ${stderr}` : ''}`);
    }
}

module.exports = { jediOracle };
