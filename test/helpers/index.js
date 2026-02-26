/**
 * Shared test helpers for UCN test suite
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ProjectIndex } = require('../../core/project');

// ── Path constants ──────────────────────────────────────────────────────────

const PROJECT_DIR = path.resolve(__dirname, '../..');
const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures');
const CLI_PATH = path.join(__dirname, '../../cli/index.js');
const MCP_PATH = path.join(__dirname, '../../mcp/server.js');
const TIMEOUT_MS = 30000;

// ── Temp directory helpers ──────────────────────────────────────────────────

let counter = 0;

function createTempDir() {
    const tmpDir = path.join(os.tmpdir(), `ucn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
}

function cleanup(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Create a temp dir with files. Returns the dir path. */
function tmp(files) {
    const dir = path.join(os.tmpdir(), `ucn-test-${Date.now()}-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const fp = path.join(dir, name);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content.replace(/^\n/, ''));
    }
    return dir;
}

/** Remove a directory recursively. */
function rm(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a ProjectIndex for a directory. */
function idx(dir, glob) {
    const i = new ProjectIndex(dir);
    i.build(glob || null, { quiet: true });
    return i;
}

// ── CLI helpers ─────────────────────────────────────────────────────────────

function runCli(fixtureDir, command, args = [], flags = []) {
    const allArgs = [CLI_PATH, fixtureDir, command, ...args, ...flags];
    try {
        return execFileSync('node', allArgs, {
            timeout: TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (e) {
        return (e.stdout || '') + (e.stderr || '');
    }
}

function runInteractive(fixtureDir, commands) {
    const input = commands.join('\n') + '\nquit\n';
    try {
        return execFileSync('node', [CLI_PATH, '--interactive', fixtureDir], {
            input,
            timeout: TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (e) {
        return (e.stdout || '') + (e.stderr || '');
    }
}

// ── MCP Client ──────────────────────────────────────────────────────────────

class McpClient {
    constructor() {
        this.proc = null;
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
    }

    start() {
        return new Promise((resolve, reject) => {
            this.proc = spawn('node', [MCP_PATH], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NODE_ENV: 'test' }
            });

            this.proc.stderr.on('data', () => {
                // MCP server logs to stderr - ignore
            });

            this.proc.stdout.on('data', (chunk) => {
                this.buffer += chunk.toString();
                this._processBuffer();
            });

            this.proc.on('error', (err) => {
                reject(err);
            });

            this.proc.on('exit', (code) => {
                for (const [, entry] of this.pending) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error(`Server exited with code ${code}`));
                }
                this.pending.clear();
            });

            setTimeout(() => resolve(), 500);
        });
    }

    _processBuffer() {
        while (true) {
            const nlIndex = this.buffer.indexOf('\n');
            if (nlIndex === -1) break;

            const line = this.buffer.substring(0, nlIndex).replace(/\r$/, '');
            this.buffer = this.buffer.substring(nlIndex + 1);

            if (!line.trim()) continue;

            try {
                const msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (e) {
                // ignore parse errors
            }
        }
    }

    _handleMessage(msg) {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
                entry.resolve({ error: msg.error });
            } else {
                entry.resolve({ result: msg.result });
            }
        }
    }

    send(method, params) {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('TIMEOUT'));
            }, TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });

            const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            this.proc.stdin.write(message);
        });
    }

    notify(method, params) {
        const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
        this.proc.stdin.write(message);
    }

    async initialize() {
        const res = await this.send('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
        });
        this.notify('notifications/initialized', {});
        return res;
    }

    async callTool(nameOrArgs, args) {
        // Support both signatures:
        //   callTool('ucn', { command: 'about', ... })  — mcp-edge-cases style
        //   callTool({ command: 'about', ... })          — parity-test style
        if (typeof nameOrArgs === 'string') {
            return this.send('tools/call', { name: nameOrArgs, arguments: args });
        }
        const res = await this.send('tools/call', { name: 'ucn', arguments: nameOrArgs });
        if (res.error) return { error: res.error };
        const content = res.result?.content;
        const isError = res.result?.isError === true;
        if (content && content.length > 0) return { text: content[0].text, isError };
        return { text: '', isError };
    }

    stop() {
        if (this.proc) {
            this.proc.stdin.end();
            this.proc.kill();
        }
    }
}

module.exports = {
    PROJECT_DIR,
    FIXTURES_PATH,
    CLI_PATH,
    MCP_PATH,
    TIMEOUT_MS,
    createTempDir,
    cleanup,
    tmp,
    rm,
    idx,
    runCli,
    runInteractive,
    McpClient,
};
