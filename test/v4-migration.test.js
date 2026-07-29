'use strict';

/**
 * v4 → v5 command migration guidance.
 *
 * Every v4 command name that no longer resolves must produce DIRECTIVE
 * replacement guidance ("For a symbol summary, use: ucn show <name>") on both
 * CLI and MCP — never a bare "Unknown command" dead end, and never a wrong
 * edit-distance suggestion (`fn` must point at `source`, not "find").
 * The names stay invalid (no legacy aliases); only the error text teaches.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const {
    CANONICAL_COMMANDS,
    V4_COMMAND_MIGRATIONS,
    v4MigrationHint,
    resolveCommand,
    toCliName,
    toMcpName,
} = require('../core/registry');
const { tmp, rm, McpClient } = require('./helpers');

const CLI_ENTRY = path.join(__dirname, '..', 'cli', 'index.js');

// The full v4 public surface that v5 removed: canonical names + CLI/MCP
// aliases. This list is the CONTRACT — every entry must map somewhere.
const DEAD_V4_NAMES = [
    // canonical
    'about', 'context', 'blast', 'smart', 'reverseTrace', 'example', 'related',
    'brief', 'toc', 'affectedTests', 'fn', 'class', 'lines', 'expand',
    'imports', 'exporters', 'fileExports', 'graph', 'circularDeps', 'verify',
    'diffImpact', 'typedef', 'stats', 'doctor', 'orient',
    // CLI aliases
    'file-exports', 'what-exports', 'diff-impact', 'what-imports',
    'who-imports', 'stack', 'affected', 'affected-tests', 'reverse-trace',
    'rtrace', 'circular-deps', 'circular', 'cycles', 'entry-points',
    // MCP aliases
    'file_exports', 'diff_impact', 'affected_tests', 'reverse_trace',
    'circular_deps',
];

function runCliExpectFail(dir, args) {
    try {
        execFileSync(process.execPath, [CLI_ENTRY, ...args], {
            cwd: dir, encoding: 'utf8', stdio: 'pipe',
        });
        assert.fail(`expected non-zero exit for: ${args.join(' ')}`);
    } catch (e) {
        return { status: e.status, output: `${e.stdout || ''}${e.stderr || ''}` };
    }
}

describe('v4 → v5 migration guidance', () => {
    it('every dead v4 name has a migration hint on both surfaces', () => {
        for (const name of DEAD_V4_NAMES) {
            assert.equal(resolveCommand(name, 'cli'), null,
                `"${name}" must not resolve as a v5 CLI command`);
            const cliHint = v4MigrationHint(name, 'cli');
            const mcpHint = v4MigrationHint(name, 'mcp');
            assert.ok(cliHint, `"${name}" must have a CLI migration hint`);
            assert.ok(mcpHint, `"${name}" must have an MCP migration hint`);
            assert.match(cliHint, /use: ucn /, `CLI hint for "${name}" must be an invocation`);
            assert.match(mcpHint, /command "/, `MCP hint for "${name}" must name the command param`);
        }
    });

    it('migration targets are live v5 commands and keys never shadow them', () => {
        for (const [key, entry] of Object.entries(V4_COMMAND_MIGRATIONS)) {
            assert.ok(CANONICAL_COMMANDS.includes(entry.to),
                `migration target "${entry.to}" (from "${key}") must be canonical`);
            assert.ok(entry.cli.includes(toCliName(entry.to)),
                `CLI hint for "${key}" must invoke ${toCliName(entry.to)}`);
            assert.ok(entry.mcp.includes(`"${toMcpName(entry.to)}"`),
                `MCP hint for "${key}" must name ${toMcpName(entry.to)}`);
        }
        // A live command name must never get a migration hint — the table
        // only speaks for names that do not resolve.
        for (const cmd of CANONICAL_COMMANDS) {
            assert.equal(v4MigrationHint(toCliName(cmd), 'cli'), null,
                `live command "${cmd}" must not be shadowed by the migration table`);
        }
    });

    it('spelling variants normalize to the same entry', () => {
        for (const spelling of ['reverseTrace', 'reverse-trace', 'reverse_trace', 'rtrace']) {
            assert.match(v4MigrationHint(spelling, 'cli'), /--to=entrypoints/);
        }
        assert.match(v4MigrationHint('fn', 'cli'), /ucn source <name>/);
        assert.match(v4MigrationHint('callers', 'cli'), /--sections=callers/);
    });

    it('CLI prints directive guidance and exits 1 for v4 names', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const about = runCliExpectFail(dir, ['.', 'about', 'helper']);
            assert.equal(about.status, 1);
            assert.match(about.output,
                /Unknown command: about\. For a symbol summary .*use: ucn show <name>\./);

            // `fn` must NOT fall through to the edit-distance suggester
            // ("Did you mean find?") — migration outranks suggestion.
            const fn = runCliExpectFail(dir, ['.', 'fn', 'helper']);
            assert.match(fn.output, /use: ucn source <name>/);
            assert.doesNotMatch(fn.output, /Did you mean/);

            const toc = runCliExpectFail(dir, ['.', 'toc']);
            assert.match(toc.output, /use: ucn repo --sections=files/);

            // Dir-less form: `ucn about helper` — target position holds the
            // v4 name; it must be treated as a command mistake, not a path.
            const dirless = runCliExpectFail(dir, ['about', 'helper']);
            assert.match(dirless.output, /Unknown command: about\./);
            assert.doesNotMatch(dirless.output, /not found/);
        } finally {
            rm(dir);
        }
    });

    it('MCP returns directive guidance for v4 names and lists commands for garbage', async () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();

            const about = await client.callTool({
                command: 'about', project_dir: dir, name: 'helper',
            });
            assert.equal(about.isError, true);
            assert.match(about.text,
                /Unknown command: about\. For a symbol summary .*command "show" with name/);

            const affected = await client.callTool({
                command: 'affected_tests', project_dir: dir, name: 'helper',
            });
            assert.equal(affected.isError, true);
            assert.match(affected.text, /command "tests" with name, depth=<n>/);

            const garbage = await client.callTool({
                command: 'zzznotacommand', project_dir: dir,
            });
            assert.equal(garbage.isError, true);
            assert.match(garbage.text, /Valid commands: show, find, usages/);

            const typo = await client.callTool({
                command: 'shwo', project_dir: dir, name: 'helper',
            });
            assert.equal(typo.isError, true);
            assert.match(typo.text, /Did you mean "show"\?/);
        } finally {
            client.stop();
            rm(dir);
        }
    });
});
