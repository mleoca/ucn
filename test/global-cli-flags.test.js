const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('path');
const fs = require('fs');

const CLI_PATH = path.join(__dirname, '..', 'cli', 'index.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

function runUcn(args) {
    return spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8' });
}

test('ucn --version prints the correct version and exits 0', () => {
    const result = runUcn(['--version']);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), pkg.version);
});

test('ucn -v prints the correct version and exits 0', () => {
    const result = runUcn(['-v']);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), pkg.version);
});

test('ucn --help contains the version flag information', () => {
    const result = runUcn(['--help']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /-v, --version/);
    assert.match(result.stdout, /Print version information/);
});
