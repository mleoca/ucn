#!/usr/bin/env node

/**
 * MCP Server Edge Case Test Suite
 * 
 * Tests UCN MCP tools with null/crash safety, input validation,
 * and normal operation edge cases.
 * 
 * Communicates with the MCP server over stdio using newline-delimited JSON-RPC.
 */

const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'mcp', 'server.js');
const PROJECT_DIR = path.resolve(__dirname, '..');
const TIMEOUT_MS = 30000;

// ============================================================================
// JSON-RPC over stdio transport (newline-delimited JSON)
// ============================================================================

class McpClient {
    constructor() {
        this.proc = null;
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
    }

    start() {
        return new Promise((resolve, reject) => {
            this.proc = spawn('node', [SERVER_PATH], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NODE_ENV: 'test' }
            });

            this.proc.stderr.on('data', (data) => {
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
                for (const [id, entry] of this.pending) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error(`Server exited with code ${code}`));
                }
                this.pending.clear();
            });

            // Give server a moment to start
            setTimeout(() => resolve(), 500);
        });
    }

    _processBuffer() {
        // Newline-delimited JSON: each message is a single line terminated by \n
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
                console.error('Failed to parse JSON-RPC message:', e.message, 'line:', line.substring(0, 100));
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
        // Notifications (no id) are ignored
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

    async callTool(toolName, args) {
        return this.send('tools/call', { name: toolName, arguments: args });
    }

    stop() {
        if (this.proc) {
            this.proc.stdin.end();
            this.proc.kill();
        }
    }
}

// ============================================================================
// Test definitions
// ============================================================================

const tests = [
    // ========================================================================
    // CATEGORY 1: Null/Crash Safety (nonexistent symbols/files)
    // ========================================================================
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_about',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_context',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_impact',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_smart',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_trace',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_verify',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_related',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_example',
        desc: 'nonexistent symbol',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_fn',
        desc: 'nonexistent function',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_function_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_class',
        desc: 'nonexistent class',
        args: { project_dir: PROJECT_DIR, name: 'ZzzNonexistentClassXyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_tests',
        desc: 'nonexistent name',
        args: { project_dir: PROJECT_DIR, name: 'zzz_nonexistent_test_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_typedef',
        desc: 'nonexistent type',
        args: { project_dir: PROJECT_DIR, name: 'ZzzNonexistentTypeXyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_graph',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_file_exports',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_imports',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_exporters',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },

    {
        category: 'Null/Crash Safety',
        tool: 'ucn_api',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_lines',
        desc: 'nonexistent file',
        args: { project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js', range: '1-10' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn_expand',
        desc: 'no prior context call',
        args: { project_dir: PROJECT_DIR, number: 1 }
    },

    // ========================================================================
    // CATEGORY 2: Input Validation
    // ========================================================================
    {
        category: 'Input Validation',
        tool: 'ucn_find',
        desc: 'whitespace-only name',
        args: { project_dir: PROJECT_DIR, name: '   ' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_about',
        desc: 'name with special chars "foo()"',
        args: { project_dir: PROJECT_DIR, name: 'foo()' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_search',
        desc: 'regex special chars "[test"',
        args: { project_dir: PROJECT_DIR, term: '[test' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_plan',
        desc: 'no operation specified',
        args: { project_dir: PROJECT_DIR, name: 'getIndex' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_stacktrace',
        desc: 'empty stack',
        args: { project_dir: PROJECT_DIR, stack: '' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_toc',
        desc: 'nonexistent project_dir',
        args: { project_dir: '/nonexistent/fake/directory/abc123' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_find',
        desc: 'top=0',
        args: { project_dir: PROJECT_DIR, name: 'getIndex', top: 0 }
    },
    {
        category: 'Input Validation',
        tool: 'ucn_find',
        desc: 'top=-1',
        args: { project_dir: PROJECT_DIR, name: 'getIndex', top: -1 }
    },

    // ========================================================================
    // CATEGORY 3: Normal Operations (verify no crash)
    // ========================================================================
    {
        category: 'Normal Operations',
        tool: 'ucn_toc',
        desc: 'project overview',
        args: { project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_find',
        desc: 'find "getIndex"',
        args: { project_dir: PROJECT_DIR, name: 'getIndex' }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_deadcode',
        desc: 'find dead code',
        args: { project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_search',
        desc: 'search for "TODO"',
        args: { project_dir: PROJECT_DIR, term: 'TODO' }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_api',
        desc: 'project API',
        args: { project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_stats',
        desc: 'project stats',
        args: { project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn_lines',
        desc: 'extract lines 1-5 from discovery.js',
        args: { project_dir: PROJECT_DIR, file: 'core/discovery.js', range: '1-5' }
    },
];

// ============================================================================
// Test runner
// ============================================================================

async function run() {
    const client = new McpClient();
    const results = [];

    console.log('Starting MCP server...');
    await client.start();

    console.log('Sending initialize...');
    const initRes = await client.initialize();
    if (initRes.error) {
        console.error('Initialize failed:', JSON.stringify(initRes.error));
        client.stop();
        process.exit(1);
    }
    console.log('Server initialized successfully.\n');
    console.log('Running ' + tests.length + ' edge case tests...\n');

    // Run tests sequentially
    for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const label = `[${i + 1}/${tests.length}] ${t.tool} - ${t.desc}`;
        process.stdout.write(`  ${label} ... `);

        const startTime = Date.now();
        let status = 'FAIL';
        let detail = '';

        try {
            const res = await client.callTool(t.tool, t.args);
            const elapsed = Date.now() - startTime;

            if (res.error) {
                // JSON-RPC level error - server responded, not a crash
                status = 'PASS';
                detail = `RPC error: ${res.error.message || JSON.stringify(res.error)} (${elapsed}ms)`;
            } else if (res.result) {
                const content = res.result.content;
                const isError = res.result.isError === true;
                const text = content && content[0] && content[0].text || '';
                const preview = text.substring(0, 120).replace(/\n/g, '\\n');
                status = 'PASS';
                detail = `${isError ? 'ERROR response' : 'OK'}: "${preview}" (${elapsed}ms)`;
            } else {
                status = 'PASS';
                detail = `Empty result (${elapsed}ms)`;
            }
        } catch (e) {
            const elapsed = Date.now() - startTime;
            if (e.message === 'TIMEOUT') {
                status = 'FAIL';
                detail = `TIMEOUT after ${TIMEOUT_MS}ms`;
            } else {
                status = 'FAIL';
                detail = `CRASH: ${e.message} (${elapsed}ms)`;
            }
        }

        console.log(status);
        results.push({
            num: i + 1,
            category: t.category,
            tool: t.tool,
            desc: t.desc,
            status,
            detail
        });
    }

    client.stop();

    // ========================================================================
    // Summary table
    // ========================================================================
    console.log('\n' + '='.repeat(140));
    console.log('SUMMARY');
    console.log('='.repeat(140));

    const categories = [...new Set(results.map(r => r.category))];
    
    for (const cat of categories) {
        console.log(`\n--- ${cat} ---`);
        console.log(
            '#'.padEnd(5) +
            'Tool'.padEnd(22) +
            'Description'.padEnd(42) +
            'Status'.padEnd(8) +
            'Detail'
        );
        console.log('-'.repeat(140));

        const catResults = results.filter(r => r.category === cat);
        for (const r of catResults) {
            console.log(
                String(r.num).padEnd(5) +
                r.tool.padEnd(22) +
                r.desc.padEnd(42) +
                r.status.padEnd(8) +
                r.detail.substring(0, 100)
            );
        }
    }

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const total = results.length;

    console.log('\n' + '='.repeat(140));
    console.log(`TOTAL: ${total} tests | PASS: ${passed} | FAIL: ${failed}`);
    console.log('='.repeat(140));

    if (failed > 0) {
        console.log('\nFailed tests:');
        for (const r of results.filter(r => r.status === 'FAIL')) {
            console.log(`  ${r.num}. ${r.tool} - ${r.desc}: ${r.detail}`);
        }
    }

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
    console.error('Test runner crashed:', e);
    process.exit(2);
});
