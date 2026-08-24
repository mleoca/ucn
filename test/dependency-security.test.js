'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = require('../package.json');
const lock = require('../package-lock.json');

function resolveLockedDependency(from, name) {
    let cursor = from;
    for (;;) {
        const candidate = cursor
            ? `${cursor}/node_modules/${name}`
            : `node_modules/${name}`;
        if (lock.packages[candidate]) return candidate;
        const parentMarker = cursor.lastIndexOf('/node_modules/');
        if (parentMarker >= 0) {
            cursor = cursor.slice(0, parentMarker);
        } else if (cursor) {
            cursor = '';
        } else {
            return null;
        }
    }
}

function productionClosure() {
    const seen = new Set(['']);
    const queue = [''];
    while (queue.length > 0) {
        const key = queue.shift();
        const entry = lock.packages[key] || {};
        for (const bucket of ['dependencies', 'optionalDependencies']) {
            for (const name of Object.keys(entry[bucket] || {})) {
                const resolved = resolveLockedDependency(key, name);
                if (resolved && !seen.has(resolved)) {
                    seen.add(resolved);
                    queue.push(resolved);
                }
            }
        }
    }
    return seen;
}

function lockedPackageName(key) {
    if (key === '') return manifest.name;
    return lock.packages[key]?.name || key.slice(key.lastIndexOf('node_modules/') + 13);
}

describe('published dependency security policy', () => {
    it('pins every runtime dependency and has no optional hidden feature tree', () => {
        assert.deepEqual(manifest.optionalDependencies, undefined);
        for (const [name, version] of Object.entries(manifest.dependencies)) {
            assert.match(version, /^\d+\.\d+\.\d+$/,
                `${name} must be pinned so the reviewed npm graph is reproducible`);
        }
        assert.deepEqual(lock.packages[''].optionalDependencies, undefined);
    });

    it('keeps the production closure limited to parsers and regex safety', () => {
        const allowed = new Set([...Object.keys(manifest.dependencies), 'ucn']);
        const closure = productionClosure();
        const unexpected = [...closure]
            .map(lockedPackageName)
            .filter(name => !allowed.has(name));
        assert.deepEqual(unexpected, [],
            `unexpected production packages: ${unexpected.join(', ')}`);

        const unpinnedTransitives = [...closure]
            .map(lockedPackageName)
            .filter(name => name !== manifest.name && !manifest.dependencies[name]);
        assert.deepEqual(unpinnedTransitives, [],
            'every production transitive must be promoted to an exact reviewed pin');
    });

    it('does not ship general-purpose HTTP, shell, or dynamic-schema stacks', () => {
        const forbidden = new Set([
            '@hono/node-server',
            '@modelcontextprotocol/sdk',
            'ajv',
            'cors',
            'cross-spawn',
            'eventsource',
            'express',
            'express-rate-limit',
            'hono',
            'jose',
            'require-from-string',
            'router',
            'zod',
            'zod-to-json-schema',
        ]);
        const present = [...productionClosure()]
            .map(lockedPackageName)
            .filter(name => forbidden.has(name));
        assert.deepEqual(present, []);

        const mcpSource = [
            fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8'),
            fs.readFileSync(path.join(ROOT, 'mcp', 'stdio-server.js'), 'utf8'),
        ].join('\n');
        assert.doesNotMatch(mcpSource,
            /require\(['"](?:child_process|http|https|net|tls|@modelcontextprotocol\/sdk|zod)['"]\)/);
    });
});
