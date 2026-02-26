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

const { CLI_PATH, PROJECT_DIR } = require('./helpers');

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

        const expectedCommands = ['expand', 'deadcode', 'related', 'example', 'verify', 'plan', 'stacktrace', 'fn', 'class', 'lines', 'graph', 'file-exports'];
        for (const cmd of expectedCommands) {
            assert.ok(result.includes(cmd), `Interactive help should list "${cmd}"`);
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
});
