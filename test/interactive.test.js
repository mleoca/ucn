/**
 * UCN Interactive Mode Tests
 *
 * Tests for the --interactive CLI mode.
 * Extracted from parser.test.js lines 13262-13360 (Fix #100).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const { CLI_PATH, PROJECT_DIR, tmp, rm, runInteractive } = require('./helpers');
const { CANONICAL_COMMANDS, toCliName } = require('../core/registry');

function helpListsCommand(help, command) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s{2}${escaped}(?:\\s|<)`, 'm').test(help);
}

describe('Interactive Mode', () => {
    it('supports all commands without errors', () => {
        const commands = [
            'deadcode',
            'related processData',
            'example processData',
            'verify processData',
            'expand 1',
        ];

        const input = commands.join('\n') + '\nquit\n';

        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input,
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        assert.ok(!result.includes('Unknown command: deadcode'), 'deadcode should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: related'), 'related should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: example'), 'example should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: verify'), 'verify should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: expand'), 'expand should be recognized in interactive mode');
    });

    it('help lists all commands', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'help\nquit\n',
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        for (const canonical of CANONICAL_COMMANDS) {
            const cmd = toCliName(canonical);
            assert.ok(helpListsCommand(result, cmd), `Interactive help should list "${cmd}"`);
        }
    });

    it('one-shot help lists every registered command', () => {
        const result = execFileSync('node', [CLI_PATH, '--help'], {
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        for (const canonical of CANONICAL_COMMANDS) {
            const cmd = toCliName(canonical);
            assert.ok(helpListsCommand(result, cmd), `CLI help should list "${cmd}"`);
        }
    });

    it('supports fn, class, lines, graph, file-exports commands', () => {
        const commands = [
            'fn formatToc',
            'class ProjectIndex',
            'lines 1-3 --file=core/output.js',
            'graph core/output.js',
            'file-exports core/output.js',
        ];

        const input = commands.join('\n') + '\nquit\n';
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input,
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        assert.ok(!result.includes('Unknown command: fn'), 'fn should be recognized');
        assert.ok(!result.includes('Unknown command: class'), 'class should be recognized');
        assert.ok(!result.includes('Unknown command: lines'), 'lines should be recognized');
        assert.ok(!result.includes('Unknown command: graph'), 'graph should be recognized');
        assert.ok(!result.includes('Unknown command: file-exports'), 'file-exports should be recognized');
        assert.ok(result.includes('formatToc'), 'fn command should output formatToc');
        assert.ok(result.includes('ProjectIndex'), 'class command should output ProjectIndex');
    });

    it('parses flags per-command (not frozen)', () => {
        const commands = [
            'find formatToc --exact',
            'find format',
        ];

        const input = commands.join('\n') + '\nquit\n';
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input,
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        assert.ok(!result.includes('Error'), 'Neither find should error');
        assert.ok(result.includes('formatToc'), 'First find should include formatToc');
    });

    // MED-2 (Round 5): bare `stats` in interactive must not crash with
    // "Invalid --top value: must be a positive integer (got 0)". Previously
    // parseFlags defaulted top to 0 and the dispatch handler passed that
    // straight through to the executor, which rejected it.
    it('MED-2: bare stats command succeeds in interactive mode', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'stats\nquit\n',
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.ok(!result.includes('Invalid --top'),
            `bare stats should not produce 'Invalid --top' error, got: ${result.slice(0, 500)}`);
        assert.ok(result.includes('PROJECT STATISTICS'),
            `stats should print the standard header, got: ${result.slice(0, 500)}`);
    });

    // MED-3 (Round 5): bad --top value should be rejected in interactive mode
    // (matching CLI behaviour) instead of being silently coerced to falsy.
    it('MED-3: interactive rejects --top=abc with helpful error', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'context formatToc --top=abc\nquit\n',
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.ok(result.includes('Invalid --top'),
            `interactive should reject --top=abc, got: ${result.slice(0, 500)}`);
    });

    // MED-5 (Round 5): --limit=0 must be rejected, not treated as "no limit".
    it('MED-5: interactive rejects --limit=0', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'find formatToc --limit=0\nquit\n',
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.ok(result.includes('Invalid --limit'),
            `interactive should reject --limit=0, got: ${result.slice(0, 500)}`);
    });
});

describe('fix #250: interactive flag discipline', () => {
    it('unknown flags error instead of folding values into the name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function addTask() { return 1; }\nmodule.exports = { addTask };\n',
        });
        try {
            const out = runInteractive(dir, ['about addTask --bogus 5']);
            assert.ok(out.includes('Unknown flag(s): --bogus'), out.slice(0, 400));
            assert.ok(!out.includes('addTask 5'), 'value not folded into the symbol name');
        } finally { rm(dir); }
    });

    it('--json prints a note about one-shot JSON instead of silence', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function addTask() { return 1; }\nmodule.exports = { addTask };\n',
        });
        try {
            const out = runInteractive(dir, ['find addTask --json']);
            assert.ok(out.includes('--json'), 'note mentions the flag: ' + out.slice(0, 400));
            assert.ok(out.includes('one-shot'), 'note points at the working alternative');
        } finally { rm(dir); }
    });

    it('tiered no-op notes print in interactive mode too', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function addTask() { return 1; }\nfunction caller() { return addTask(); }\nmodule.exports = { addTask, caller };\n',
        });
        try {
            const out = runInteractive(dir, ['impact addTask --include-methods']);
            assert.ok(out.includes('--include-methods has no effect'), out.slice(0, 500));
        } finally { rm(dir); }
    });

    it('truncation notes render after the output, not before', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function u1() {}\nfunction u2() {}\nfunction u3() {}\nmodule.exports = {};\n',
        });
        try {
            const out = runInteractive(dir, ['deadcode --limit 2']);
            const noteIdx = out.indexOf('Showing 2 of');
            const listIdx = out.indexOf('u1');
            assert.ok(noteIdx > 0 && listIdx > 0, 'both present: ' + out.slice(0, 500));
            assert.ok(noteIdx > listIdx, 'note follows the data it describes');
        } finally { rm(dir); }
    });
});
