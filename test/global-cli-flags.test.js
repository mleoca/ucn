const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const { CLI_PATH } = require('./helpers');
const packageJson = require('../package.json');

describe('global CLI flags', () => {
    it('prints package version for --version and -v', () => {
        for (const flag of ['--version', '-v']) {
            const out = execFileSync('node', [CLI_PATH, flag], {
                timeout: 30000,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            assert.strictEqual(out, packageJson.version);
        }
    });
});
