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
const fs = require('fs');

const { CLI_PATH, PROJECT_DIR, FIXTURES_PATH, tmp, rm, runInteractive } = require('./helpers');
const { CANONICAL_COMMANDS, toCliName } = require('../core/registry');
const {
    getProjectCacheDir,
    getProjectCachePath,
    getLegacyProjectCacheDir,
    clearProjectCache,
} = require('../core/cache');

function helpListsCommand(help, command) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s{2}${escaped}(?:\\s|<)`, 'm').test(help);
}

describe('Interactive Mode', () => {
    it('--clear-cache clears legacy and per-user state before rebuilding', () => {
        const dir = tmp({
            'package.json': '{"name":"interactive-cache"}',
            'index.js': 'function main() { return 1; }',
        });
        try {
            const cacheDir = getProjectCacheDir(dir);
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, 'obsolete'), 'old');
            const legacyDir = getLegacyProjectCacheDir(dir);
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, 'obsolete'), 'old');

            runInteractive(dir, ['repo'], ['--clear-cache']);

            assert.ok(fs.existsSync(getProjectCachePath(dir)),
                'interactive mode should persist the rebuilt per-user cache');
            assert.ok(!fs.existsSync(path.join(cacheDir, 'obsolete')),
                'old per-user cache contents should be removed');
            assert.ok(!fs.existsSync(legacyDir),
                'legacy project cache should be removed');
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });

    it('supports all commands without errors', () => {
        const commands = [
            'deadcode',
            'show processData --sections=related',
            'show processData --sections=example',
            'check processData',
            'source processData',
        ];

        const input = commands.join('\n') + '\nquit\n';

        // This checks interactive command routing, so use the compact fixture
        // instead of making a parallel test process cold-index the full repo.
        const result = execFileSync('node', [
            CLI_PATH,
            '--interactive',
            path.join(FIXTURES_PATH, 'javascript'),
        ], {
            input,
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        assert.ok(!result.includes('Unknown command: deadcode'), 'deadcode should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: show'), 'show should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: check'), 'check should be recognized in interactive mode');
        assert.ok(!result.includes('Unknown command: source'), 'source should be recognized in interactive mode');
    });

    it('help lists all commands', () => {
        const result = execFileSync('node', [
            CLI_PATH,
            '--interactive',
            path.join(FIXTURES_PATH, 'javascript'),
        ], {
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

    it('supports unified source, deps, and api commands', () => {
        const commands = [
            'source formatToc',
            'source ProjectIndex',
            'source core/output.js:1-3',
            'deps core/output.js',
            'api core/output.js',
        ];

        const input = commands.join('\n') + '\nquit\n';
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input,
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        assert.ok(!result.includes('Unknown command: source'), 'source should be recognized');
        assert.ok(!result.includes('Unknown command: deps'), 'deps should be recognized');
        assert.ok(!result.includes('Unknown command: api'), 'api should be recognized');
        assert.ok(result.includes('formatToc'), 'source should output formatToc');
        assert.ok(result.includes('ProjectIndex'), 'source should output ProjectIndex');
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

    // MED-2 (Round 5): the unified stats projection must not crash with
    // "Invalid --top value: must be a positive integer (got 0)". Previously
    // parseFlags defaulted top to 0 and the dispatch handler passed that
    // straight through to the executor, which rejected it.
    it('MED-2: repo stats projection succeeds in interactive mode', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'repo --sections=stats\nquit\n',
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.ok(!result.includes('Invalid --top'),
            `repo stats should not produce 'Invalid --top' error, got: ${result.slice(0, 500)}`);
        assert.ok(result.includes('PROJECT STATISTICS'),
            `stats should print the standard header, got: ${result.slice(0, 500)}`);
    });

    // MED-3 (Round 5): bad --top value should be rejected in interactive mode
    // (matching CLI behaviour) instead of being silently coerced to falsy.
    it('MED-3: interactive rejects --top=abc with helpful error', () => {
        const result = execFileSync('node', [CLI_PATH, '--interactive', '.'], {
            input: 'show formatToc --top=abc\nquit\n',
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
            const out = runInteractive(dir, ['show addTask --bogus 5']);
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
