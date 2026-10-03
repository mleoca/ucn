'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { tmp, rm } = require('./helpers');

const SERVER_PATH = path.join(__dirname, '..', 'mcp', 'server.js');

describe('official MCP SDK interoperability', () => {
    it('initializes, discovers UCN, validates the schema, and calls the tool', async () => {
        const dir = tmp({
            'package.json': '{"name":"mcp-sdk-compat"}',
            'index.js': 'function greet(name) { return `hello ${name}`; }\nmodule.exports = { greet };\n',
        });
        const client = new Client({ name: 'ucn-sdk-compat-test', version: '1.0.0' });
        // The SDK passes only a minimal environment by default; the test
        // cache root must reach the server so it never writes the user cache
        // (fix #400).
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [SERVER_PATH],
            env: { ...getDefaultEnvironment(), UCN_CACHE_DIR: process.env.UCN_CACHE_DIR },
            stderr: 'pipe',
        });
        try {
            await client.connect(transport);
            const listed = await client.listTools();
            assert.equal(listed.tools.length, 1);
            assert.equal(listed.tools[0].name, 'ucn');
            assert.equal(listed.tools[0].inputSchema.type, 'object');
            assert.equal(listed.tools[0].annotations.readOnlyHint, true);

            const result = await client.callTool({
                name: 'ucn',
                arguments: { command: 'find', project_dir: dir, name: 'greet' },
            });
            assert.notEqual(result.isError, true);
            assert.equal(result.content[0].type, 'text');
            assert.match(result.content[0].text, /greet/);
        } finally {
            await client.close();
            rm(dir);
        }
    });
});
