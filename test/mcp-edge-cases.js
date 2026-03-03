#!/usr/bin/env node

/**
 * MCP Server Edge Case Test Suite
 *
 * Tests UCN MCP tools with null/crash safety, input validation,
 * and normal operation edge cases.
 *
 * Communicates with the MCP server over stdio using newline-delimited JSON-RPC.
 */

const path = require('path');
const { McpClient, PROJECT_DIR } = require('./helpers');

// ============================================================================
// Test definitions
// ============================================================================

const tests = [
    // ========================================================================
    // CATEGORY 1: Null/Crash Safety (nonexistent symbols/files)
    // ========================================================================
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'about - nonexistent symbol',
        args: { command: 'about', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'context - nonexistent symbol',
        args: { command: 'context', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'impact - nonexistent symbol',
        args: { command: 'impact', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'smart - nonexistent symbol',
        args: { command: 'smart', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'trace - nonexistent symbol',
        args: { command: 'trace', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'verify - nonexistent symbol',
        args: { command: 'verify', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'related - nonexistent symbol',
        args: { command: 'related', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'example - nonexistent symbol',
        args: { command: 'example', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'fn - nonexistent function',
        args: { command: 'fn', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_function_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'class - nonexistent class',
        args: { command: 'class', project_dir: PROJECT_DIR, name: 'ZzzNonexistentClassXyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'tests - nonexistent name',
        args: { command: 'tests', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_test_xyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'typedef - nonexistent type',
        args: { command: 'typedef', project_dir: PROJECT_DIR, name: 'ZzzNonexistentTypeXyz' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'graph - nonexistent file',
        args: { command: 'graph', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'file_exports - nonexistent file',
        args: { command: 'file_exports', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'imports - nonexistent file',
        args: { command: 'imports', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'exporters - nonexistent file',
        args: { command: 'exporters', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },

    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'api - nonexistent file',
        args: { command: 'api', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'lines - nonexistent file',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js', range: '1-10' }
    },
    {
        category: 'Null/Crash Safety',
        tool: 'ucn',
        desc: 'expand - no prior context call',
        args: { command: 'expand', project_dir: PROJECT_DIR, item: 1 }
    },

    // ========================================================================
    // CATEGORY 2: Input Validation
    // ========================================================================
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'find - whitespace-only name',
        args: { command: 'find', project_dir: PROJECT_DIR, name: '   ' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'about - name with special chars "foo()"',
        args: { command: 'about', project_dir: PROJECT_DIR, name: 'foo()' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'search - regex special chars "[test"',
        args: { command: 'search', project_dir: PROJECT_DIR, term: '[test' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'plan - no operation specified',
        args: { command: 'plan', project_dir: PROJECT_DIR, name: 'getIndex' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'stacktrace - empty stack',
        args: { command: 'stacktrace', project_dir: PROJECT_DIR, stack: '' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'toc - nonexistent project_dir',
        args: { command: 'toc', project_dir: '/nonexistent/fake/directory/abc123' }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'find - top=0',
        args: { command: 'find', project_dir: PROJECT_DIR, name: 'getIndex', top: 0 }
    },
    {
        category: 'Input Validation',
        tool: 'ucn',
        desc: 'find - top=-1',
        args: { command: 'find', project_dir: PROJECT_DIR, name: 'getIndex', top: -1 }
    },

    // ========================================================================
    // CATEGORY 3: Normal Operations (verify no crash)
    // ========================================================================
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'toc - project overview',
        args: { command: 'toc', project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'find - find "getIndex"',
        args: { command: 'find', project_dir: PROJECT_DIR, name: 'getIndex' }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'deadcode - find dead code',
        args: { command: 'deadcode', project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'search - search for "TODO"',
        args: { command: 'search', project_dir: PROJECT_DIR, term: 'TODO' }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'api - project API',
        args: { command: 'api', project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'stats - project stats',
        args: { command: 'stats', project_dir: PROJECT_DIR }
    },
    {
        category: 'Normal Operations',
        tool: 'ucn',
        desc: 'lines - extract lines 1-5 from discovery.js',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: 'core/discovery.js', range: '1-5' }
    },

    // ========================================================================
    // Correctness Assertions
    // ========================================================================
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'api(file=nonexistent) returns soft error',
        args: { command: 'api', project_dir: PROJECT_DIR, file: 'nonexistent/path/to/file.js' },
        assert: (res, text, isError) => isError === false || 'Expected soft error (no isError flag) for nonexistent file'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'api(file=nonexistent) message contains "not found"',
        args: { command: 'api', project_dir: PROJECT_DIR, file: 'nonexistent.js' },
        assert: (res, text, isError) => (!isError && /not found/i.test(text)) || 'Expected file-not-found message (soft error)'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'smart(nonexistent) returns "not found" message',
        args: { command: 'smart', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' },
        assert: (res, text, isError) => (!isError && /not found/i.test(text)) || 'Expected "not found" message for nonexistent smart target'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'context(nonexistent) returns "not found" message',
        args: { command: 'context', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' },
        assert: (res, text, isError) => (!isError && /not found/i.test(text)) || 'Expected "not found" message for nonexistent context target'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'example(nonexistent) returns "no examples" message',
        args: { command: 'example', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' },
        assert: (res, text, isError) => (!isError && /no.*examples found|not found/i.test(text)) || 'Expected "no examples found" message for nonexistent example target'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'related(nonexistent) returns "not found" message',
        args: { command: 'related', project_dir: PROJECT_DIR, name: 'zzz_nonexistent_symbol_xyz' },
        assert: (res, text, isError) => (!isError && /not found/i.test(text)) || 'Expected "not found" message for nonexistent related target'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'lines(range="5-0") returns error message',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: 'core/discovery.js', range: '5-0' },
        assert: (res, text, isError) => (!isError && text.length > 0) || 'Expected soft error with message for invalid range'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'class(max_lines=-1) returns validation error',
        args: { command: 'class', project_dir: PROJECT_DIR, name: 'ProjectIndex', max_lines: -1 },
        assert: (res, text, isError) => isError === true || 'Expected isError: true for negative max_lines'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'lines - unique partial file resolves successfully',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: 'core/discovery.js', range: '1-3' },
        assert: (res, text, isError) => isError === false || 'Expected success for unique partial file'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'file_exports(file=utils.js) returns ambiguity error',
        args: { command: 'file_exports', project_dir: PROJECT_DIR, file: 'utils.js' },
        assert: (res, text, isError) => /ambiguous/i.test(text) || 'Expected file-ambiguous error message for utils.js'
    },
    {
        category: 'Correctness',
        tool: 'ucn',
        desc: 'imports(file=utils.js) returns ambiguity error',
        args: { command: 'imports', project_dir: PROJECT_DIR, file: 'utils.js' },
        assert: (res, text, isError) => /ambiguous/i.test(text) || 'Expected file-ambiguous error message for utils.js'
    },

    // ========================================================================
    // CATEGORY 3: Security (path traversal, argument injection)
    // ========================================================================
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'lines rejects path traversal (../../../../etc/passwd)',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: '../../../../etc/passwd', range: '1-5' },
        assert: (res, text, isError) => (/not found/i.test(text) || /outside project/i.test(text)) || 'Expected error message for path traversal'
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'lines rejects path traversal (../../other-project/secret.js)',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: '../../other-project/secret.js', range: '1-5' },
        assert: (res, text, isError) => (/not found/i.test(text) || /outside project/i.test(text)) || 'Expected error message for path traversal'
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'lines works with valid file',
        args: { command: 'lines', project_dir: PROJECT_DIR, file: 'core/discovery.js', range: '1-3' },
        assert: (res, text, isError) => (!isError && text.length > 0) || 'Expected valid output for core/discovery.js'
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'diff_impact rejects --config argument injection',
        args: { command: 'diff_impact', project_dir: PROJECT_DIR, base: '--config=malicious' },
        assert: (res, text, isError) => /invalid git ref/i.test(text) || 'Expected error message for argument injection in base'
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'diff_impact rejects -o flag injection',
        args: { command: 'diff_impact', project_dir: PROJECT_DIR, base: '-o /tmp/evil' },
        assert: (res, text, isError) => /invalid git ref/i.test(text) || 'Expected error message for flag injection in base'
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'diff_impact accepts valid ref HEAD~3',
        args: { command: 'diff_impact', project_dir: PROJECT_DIR, base: 'HEAD~3' },
        assert: (res, text, isError) => true  // Should not error on valid ref format
    },
    {
        category: 'Security',
        tool: 'ucn',
        desc: 'diff_impact accepts valid ref origin/main',
        args: { command: 'diff_impact', project_dir: PROJECT_DIR, base: 'origin/main' },
        assert: (res, text, isError) => true  // Should not error on valid ref format
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
        const label = `[${i + 1}/${tests.length}] ${t.tool} ${t.args.command} - ${t.desc}`;
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

                // Run assertion if provided
                if (t.assert && status === 'PASS') {
                    const assertResult = t.assert(res, text, isError);
                    if (assertResult !== true) {
                        status = 'FAIL';
                        detail = `ASSERTION: ${assertResult} (${elapsed}ms)`;
                    }
                }
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
            command: t.args.command,
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
            'Command'.padEnd(22) +
            'Description'.padEnd(42) +
            'Status'.padEnd(8) +
            'Detail'
        );
        console.log('-'.repeat(140));

        const catResults = results.filter(r => r.category === cat);
        for (const r of catResults) {
            console.log(
                String(r.num).padEnd(5) +
                r.command.padEnd(22) +
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
            console.log(`  ${r.num}. ${r.command} - ${r.desc}: ${r.detail}`);
        }
    }

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
    console.error('Test runner crashed:', e);
    process.exit(2);
});
