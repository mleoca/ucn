/**
 * eval/oracles/jsonl-helper.js - serialized line-paired protocol for oracle
 * helper subprocesses (jedi-helper.py, go-ast-helper.go): one JSON request
 * per stdin line, one JSON response per stdout line, first line is a banner.
 */

'use strict';

const readline = require('readline');

const DEFAULT_TIMEOUT_MS = 120000;

function makeHelperHandle(child, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'oracle helper' } = {}) {
    const rl = readline.createInterface({ input: child.stdout });
    const queue = [];
    let dead = null;

    rl.on('line', (line) => {
        const entry = queue.shift();
        if (entry) {
            clearTimeout(entry.timer);
            entry.resolve(line);
        }
    });
    const fail = (err) => {
        dead = err;
        while (queue.length) {
            const entry = queue.shift();
            clearTimeout(entry.timer);
            entry.reject(err);
        }
    };
    child.on('error', (e) => fail(new Error(`${label} spawn failed: ${e.message}`)));
    child.on('exit', (code) => fail(new Error(`${label} exited (code ${code})`)));

    const expectLine = () => new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const entry = { resolve, reject };
        // A timeout desynchronizes request/response pairing — kill the helper
        // so every later request fails loudly instead of mis-pairing.
        entry.timer = setTimeout(() => {
            fail(new Error(`${label} timed out after ${timeoutMs}ms`));
            child.kill();
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        queue.push(entry);
    });

    const request = async (payload) => {
        if (dead) throw dead;
        child.stdin.write(JSON.stringify(payload) + '\n');
        const line = await expectLine();
        const resp = JSON.parse(line);
        if (!resp.ok) throw new Error(`${label}: ${resp.error}`);
        return resp;
    };

    return { child, expectLine, request };
}

module.exports = { makeHelperHandle };
