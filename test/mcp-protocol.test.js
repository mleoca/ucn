'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const { getMcpCommandEnum } = require('../core/registry');
const {
    ERROR,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
} = require('../mcp/stdio-server');

const SERVER_PATH = path.join(__dirname, '..', 'mcp', 'server.js');
const PROJECT_DIR = path.join(__dirname, '..');
const clients = new Set();

class ProtocolClient {
    constructor() {
        this.nextId = 0;
        this.pending = new Map();
        this.messages = [];
        this.buffer = '';
        this.proc = spawn(process.execPath, [SERVER_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'test' },
        });
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', chunk => {
            this.buffer += chunk;
            for (;;) {
                const newline = this.buffer.indexOf('\n');
                if (newline < 0) break;
                const line = this.buffer.slice(0, newline).replace(/\r$/, '');
                this.buffer = this.buffer.slice(newline + 1);
                if (!line) continue;
                const message = JSON.parse(line);
                this.messages.push(message);
                const pending = this.pending.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    pending.resolve(message);
                }
            }
        });
        clients.add(this);
    }

    sendRaw(line) {
        this.proc.stdin.write(`${line}\n`);
    }

    request(method, params) {
        const id = ++this.nextId;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for ${method}`));
            }, 10000);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        return response;
    }

    notify(method, params = {}) {
        this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }

    async waitForMessage(predicate, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.messages.find(predicate);
            if (found) return found;
            if (Date.now() >= deadline) throw new Error('Timed out waiting for MCP message');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    async initialize(protocolVersion = LATEST_PROTOCOL_VERSION) {
        const response = await this.request('initialize', {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'protocol-test', version: '1.0.0' },
        });
        this.notify('notifications/initialized');
        return response;
    }

    close() {
        clients.delete(this);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.resolve({ error: { code: -1, message: 'client closed' } });
        }
        this.pending.clear();
        this.proc.stdin.end();
        this.proc.kill();
    }
}

afterEach(() => {
    for (const client of clients) client.close();
});

describe('dependency-free MCP stdio protocol', () => {
    it('negotiates every supported MCP revision and falls back to the latest stable revision', async () => {
        for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
            const client = new ProtocolClient();
            const response = await client.initialize(version);
            assert.equal(response.result.protocolVersion, version);
            assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
            assert.equal(response.result.serverInfo.name, 'ucn');
            client.close();
        }

        const client = new ProtocolClient();
        const response = await client.initialize('not-a-protocol-version');
        assert.equal(response.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    });

    it('publishes one deterministic, read-only tool with the complete JSON Schema', async () => {
        const client = new ProtocolClient();
        await client.initialize();
        const first = await client.request('tools/list', {});
        const second = await client.request('tools/list', {});
        assert.deepEqual(first.result, second.result);
        assert.equal(first.result.tools.length, 1);

        const tool = first.result.tools[0];
        assert.equal(tool.name, 'ucn');
        assert.equal(tool.execution.taskSupport, 'forbidden');
        assert.deepEqual(tool.annotations, {
            title: 'Universal Code Navigator',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.deepEqual(tool.inputSchema.required, ['command', 'project_dir']);
        assert.deepEqual(tool.inputSchema.properties.command.enum, getMcpCommandEnum());
        assert.equal(tool.inputSchema.properties.top.exclusiveMinimum, 0);
        assert.equal(tool.inputSchema.properties.max_chars.maximum, 100000);
    });

    it('implements ping and standard JSON-RPC errors without crashing the stream', async () => {
        const client = new ProtocolClient();
        await client.initialize();
        assert.deepEqual((await client.request('ping', {})).result, {});

        client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }));
        const nullId = await client.waitForMessage(message =>
            Object.prototype.hasOwnProperty.call(message, 'id') && message.id === null && message.result,
        );
        assert.deepEqual(nullId.result, {});

        const missing = await client.request('resources/list', {});
        assert.equal(missing.error.code, ERROR.METHOD_NOT_FOUND);

        const cursor = await client.request('tools/list', { cursor: 'invalid' });
        assert.equal(cursor.error.code, ERROR.INVALID_PARAMS);

        client.sendRaw('{broken json');
        await client.waitForMessage(message => message.error?.code === ERROR.PARSE);
        assert.deepEqual((await client.request('ping', {})).result, {});
    });

    it('uses protocol errors for malformed calls and tool errors for correctable inputs', async () => {
        const client = new ProtocolClient();
        await client.initialize();

        const unknown = await client.request('tools/call', {
            name: 'not-ucn', arguments: {},
        });
        assert.equal(unknown.error.code, ERROR.INVALID_PARAMS);

        const missingArguments = await client.request('tools/call', { name: 'ucn' });
        assert.equal(missingArguments.result.isError, true);
        assert.match(missingArguments.result.content[0].text, /arguments must be an object/i);

        for (const [key, value] of [
            ['top', 0],
            ['top', 1.5],
            ['depth', -1],
            ['direction', 'sideways'],
            ['include_tests', 'yes'],
        ]) {
            const response = await client.request('tools/call', {
                name: 'ucn',
                arguments: {
                    command: 'show', project_dir: PROJECT_DIR, name: 'main', [key]: value,
                },
            });
            assert.equal(response.result.isError, true, `${key}=${value}`);
            assert.match(response.result.content[0].text, new RegExp(key));
        }

        const blankProject = await client.request('tools/call', {
            name: 'ucn', arguments: { command: 'repo', project_dir: '   ' },
        });
        assert.equal(blankProject.result.isError, true);
        assert.match(blankProject.result.content[0].text, /project_dir/);
    });

    it('lets retired commands and unknown parameters reach actionable agent guidance', async () => {
        const client = new ProtocolClient();
        await client.initialize();
        const retired = await client.request('tools/call', {
            name: 'ucn', arguments: { command: 'toc', project_dir: PROJECT_DIR },
        });
        assert.equal(retired.result.isError, true);
        assert.match(retired.result.content[0].text, /command "repo" with sections="files"/);

        const typo = await client.request('tools/call', {
            name: 'ucn',
            arguments: {
                command: 'find', project_dir: PROJECT_DIR, name: 'main', include_test: true,
            },
        });
        assert.notEqual(typo.result.isError, true);
        assert.match(typo.result.content[0].text, /did you mean include_tests/i);
    });
});
