/**
 * eval/oracles/lsp-client.js - Minimal LSP-over-stdio client for oracle use.
 *
 * Just enough protocol for headless batch queries: Content-Length framing,
 * request/response correlation by id, notifications, and stub answers for the
 * server→client requests language servers block on (workspace/configuration,
 * client/registerCapability, window/workDoneProgress/create). Not a general
 * LSP client — no document sync beyond didOpen, no capability negotiation.
 */

'use strict';

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 300000;

class LspClient {
    constructor(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, settings = null, capabilities = null, onNotification = null, env = null } = {}) {
        this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], ...(env && { env }) });
        this.timeoutMs = timeoutMs;
        this.settings = settings; // answers workspace/configuration by dotted section
        this.extraCapabilities = capabilities; // merged into initialize capabilities (e.g. rust-analyzer serverStatus)
        this.onNotification = onNotification; // (method, params) => void — server notifications
        this.nextId = 1;
        this.pending = new Map(); // id -> { resolve, reject, timer }
        this.dead = null;
        this._buffer = Buffer.alloc(0);

        this.child.stdout.on('data', (chunk) => this._onData(chunk));
        this.child.on('error', (e) => this._fail(new Error(`LSP server spawn failed: ${e.message}`)));
        this.child.on('exit', (code) => this._fail(new Error(`LSP server exited (code ${code})`)));
    }

    _fail(err) {
        if (this.dead) return;
        this.dead = err;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this.pending.clear();
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        for (;;) {
            const headerEnd = this._buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const header = this._buffer.slice(0, headerEnd).toString('ascii');
            const m = header.match(/Content-Length: *(\d+)/i);
            if (!m) { this._buffer = this._buffer.slice(headerEnd + 4); continue; }
            const length = Number(m[1]);
            const bodyStart = headerEnd + 4;
            if (this._buffer.length < bodyStart + length) return;
            const body = this._buffer.slice(bodyStart, bodyStart + length).toString('utf-8');
            this._buffer = this._buffer.slice(bodyStart + length);
            let msg;
            try { msg = JSON.parse(body); } catch (e) { continue; }
            this._onMessage(msg);
        }
    }

    _onMessage(msg) {
        if (msg.id !== undefined && msg.method) {
            // server→client request — answer config from this.settings, stub the rest
            let result = null;
            if (msg.method === 'workspace/configuration') {
                result = (msg.params?.items || []).map(item =>
                    this._lookupSection(item?.section));
            }
            this._send({ jsonrpc: '2.0', id: msg.id, result });
            return;
        }
        if (msg.id !== undefined) {
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(`LSP ${msg.error.code}: ${msg.error.message}`));
            else entry.resolve(msg.result);
        }
        else if (msg.method && this.onNotification) this.onNotification(msg.method, msg.params);
        // else: notification (diagnostics, logs) — ignored unless a hook is registered
    }

    _send(msg) {
        const body = Buffer.from(JSON.stringify(msg), 'utf-8');
        this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.child.stdin.write(body);
    }

    request(method, params) {
        if (this.dead) return Promise.reject(this.dead);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // A timed-out server is in an unknown state — kill so later
                // requests fail loudly instead of hanging.
                this._fail(new Error(`LSP request ${method} timed out after ${this.timeoutMs}ms`));
                this.child.kill();
                reject(new Error(`LSP request ${method} timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this._send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        if (this.dead) return;
        this._send({ jsonrpc: '2.0', method, params });
    }

    _lookupSection(section) {
        if (!this.settings) return null;
        if (!section) return this.settings;
        let value = this.settings;
        for (const part of section.split('.')) {
            if (value == null || typeof value !== 'object') return null;
            value = value[part];
        }
        return value ?? null;
    }

    async initialize(rootDir, initializationOptions = undefined) {
        const result = await this.request('initialize', {
            processId: process.pid,
            rootUri: pathToUri(rootDir),
            workspaceFolders: [{ uri: pathToUri(rootDir), name: 'eval' }],
            capabilities: {
                ...(this.settings ? { workspace: { configuration: true, didChangeConfiguration: {} } } : {}),
                ...(this.extraCapabilities || {}),
            },
            ...(initializationOptions && { initializationOptions }),
        });
        this.notify('initialized', {});
        if (this.settings) {
            this.notify('workspace/didChangeConfiguration', { settings: this.settings });
        }
        return result;
    }

    didOpen(filePath, languageId, text) {
        this.notify('textDocument/didOpen', {
            textDocument: { uri: pathToUri(filePath), languageId, version: 1, text },
        });
    }

    kill() {
        try { this.child.kill(); } catch (e) { /* already dead */ }
    }
}

function pathToUri(p) {
    let path_ = p.replace(/\\/g, '/');
    if (!path_.startsWith('/')) path_ = '/' + path_;
    return 'file://' + path_.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

function uriToPath(uri) {
    let p = uri.replace(/^file:\/\//, '');
    return p.split('/').map(decodeURIComponent).join('/');
}

module.exports = { LspClient, pathToUri, uriToPath };
