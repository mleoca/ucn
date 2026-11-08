'use strict';

/**
 * The cache root of one test process and of every CLI/MCP process it spawns
 * (fix #433). Required first by every test file, directly or through
 * helpers/index.js.
 *
 * UCN_CACHE_DIR set: a fresh directory inside it, so a suite never writes
 * outside the root the user chose. Unset: a fresh directory under the OS
 * temp dir, never the user's real cache root. Either way the directory is
 * this process's own (tests clear, prune and lock caches) and is removed on
 * exit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIGURED = String(process.env.UCN_CACHE_DIR || '').trim();

function configuredRoot() {
    if (!CONFIGURED) return null;
    if (CONFIGURED === '~') return os.homedir();
    if (CONFIGURED.startsWith('~/') || CONFIGURED.startsWith('~\\')) {
        return path.resolve(os.homedir(), CONFIGURED.slice(2));
    }
    return path.resolve(CONFIGURED);
}

function createRoot() {
    const parent = configuredRoot() || os.tmpdir();
    fs.mkdirSync(parent, { recursive: true });
    return fs.mkdtempSync(path.join(parent, 'ucn-test-cache-'));
}

if (!process.env.UCN_TEST_CACHE_ROOT || process.env.UCN_CACHE_DIR !== process.env.UCN_TEST_CACHE_ROOT) {
    const root = createRoot();
    process.env.UCN_CACHE_DIR = root;
    process.env.UCN_TEST_CACHE_ROOT = root;
    process.once('exit', () => {
        // A terminating CLI/MCP child can finish a cache write during the
        // first removal pass. Retry transient directory races, but still
        // surface a persistent cleanup failure.
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
}

module.exports = { TEST_CACHE_ROOT: process.env.UCN_CACHE_DIR };
