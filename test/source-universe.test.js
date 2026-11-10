'use strict';

/**
 * core/source-universe.js: what a completeness claim ranges over.
 *
 * Source UCN reads without analyzing is searched per name (one scanner for
 * every command), a path nothing can be read from degrades every account,
 * and a declared-outside path belongs to no claim. These tests pin the
 * scanner against a whole-text reference, the byte budget, the model's
 * single ownership of raw discovery facts, and what an edit to unanalyzed
 * source does to a fresh, a cache-loaded and a long-lived index.
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmp, rm, idx } = require('./helpers');
const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { saveCache, loadCache, isCacheStale } = require('../core/cache');
const { literalNameRegex } = require('../core/shared');
const universe = require('../core/source-universe');

function referenceLines(content, name) {
    const pattern = literalNameRegex(name);
    const lines = [];
    content.split('\n').forEach((line, i) => {
        if (line.includes(name) && pattern.test(line)) lines.push(i + 1);
    });
    return lines;
}

function chunked(content, sizes) {
    const chunks = [];
    for (let at = 0, i = 0; at < content.length; i++) {
        const size = sizes[i % sizes.length];
        chunks.push(content.slice(at, at + size));
        at += size;
    }
    return chunks;
}

function scanLines(chunks, name) {
    const lines = [];
    universe.scanChunksForName(chunks, name, line => lines.push(line));
    return lines;
}

describe('source universe: one name scanner', () => {
    // Deterministic generator: the cases are the same on every run.
    let seed = 20261110;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pieces = ['get', 'getX', '_get', 'get_', ' ', '\n', '(', ')', '.', 'é', 'ñget',
        'get😀', '😀', 'x', '$get', 'a', '\t', 'gét', 'ge', 't'];
    const names = ['get', 'getX', 'é', 'x', '$get', 'ge'];
    const chunkings = content => [[content.length + 1], [1], [2, 3], [7], [64, 1, 300], [1000]];

    it('matches a whole-text reference under any chunking', () => {
        for (let round = 0; round < 120; round++) {
            let content = '';
            const count = 5 + Math.floor(random() * 300);
            for (let i = 0; i < count; i++) content += pieces[Math.floor(random() * pieces.length)];
            if (round % 7 === 0) content = content.replace(/\n/g, ' ');
            if (round % 11 === 0) content += `${'x'.repeat(700)} get ${'y'.repeat(700)}`;
            for (const name of names) {
                const expected = referenceLines(content, name);
                for (const sizes of chunkings(content)) {
                    assert.deepStrictEqual(scanLines(chunked(content, sizes), name), expected,
                        JSON.stringify({ name, sizes, content: content.slice(0, 200) }));
                }
            }
        }
    });

    it('finds a name in a multi-megabyte single line and shows a window around it', () => {
        const big = `${'a'.repeat(1500000)} needle ${'b'.repeat(1500000)}\nneedle2 needle\n${'c'.repeat(10)}`;
        for (const sizes of [[big.length + 1], [1 << 20], [65536]]) {
            const sites = [];
            universe.scanChunksForName(chunked(big, sizes), 'needle',
                (line, text) => sites.push({ line, text }));
            assert.deepStrictEqual(sites.map(site => site.line), [1, 2]);
            assert.ok(sites[0].text.includes('needle'), 'the window contains the match');
            assert.ok(sites[0].text.length <= 160);
            assert.strictEqual(sites[1].text, 'needle2 needle');
        }
    });

    it('uses the ground set\'s Unicode boundaries, not ASCII word boundaries', () => {
        assert.deepStrictEqual(scanLines(['hitΔ()\nhit()\nΔhit\n hit '], 'hit'), [2, 4]);
        // The same word split across a chunk edge is still one word.
        assert.deepStrictEqual(scanLines(['hi', 'tΔ()\nh', 'it()'], 'hit'), [2]);
    });

    it('the one-pass multi-name scan agrees with the single-name scan', () => {
        const all = [...names, 'missing_name', 'getXY'];
        for (let round = 0; round < 60; round++) {
            let content = '';
            const count = 5 + Math.floor(random() * 200);
            for (let i = 0; i < count; i++) content += pieces[Math.floor(random() * pieces.length)];
            for (const sizes of [[content.length + 1], [1], [5, 2]]) {
                const found = universe.scanChunksForNames(() => chunked(content, sizes), all);
                for (const name of all) {
                    assert.strictEqual(found.has(name), referenceLines(content, name).length > 0,
                        JSON.stringify({ name, sizes, content: content.slice(0, 200) }));
                }
            }
        }
    });
});

describe('source universe: classification and budget', () => {
    it('classifies every non-indexed path once, by what can be said about a name', () => {
        const dir = tmp({
            'package.json': '{}',
            '.ucn.json': JSON.stringify({ exclude: ['legacy/**'], outsideProject: ['third_party'] }),
            'lib.js': 'export function target() {}',
            'legacy/old.js': 'target();',
            'legacy/data.json': '{"target": 1}',
            'third_party/dep.js': 'target();',
            'tool.rb': 'target',
            'vendor.min.js': 'x',
            'vendor.js.map': '{}',
        });
        try {
            const model = universe.universe(idx(dir));
            assert.deepStrictEqual(model.textOnly.map(entry => [entry.relativePath, entry.reason]), [
                ['legacy/old.js', 'config-exclude'],
                ['tool.rb', 'unsupported-language'],
                ['vendor.min.js', 'bundled'],
            ]);
            assert.deepStrictEqual(model.opaque, []);
            assert.deepStrictEqual(model.outside.map(entry => [entry.relativePath, entry.reason]), [
                ['third_party', 'outside-project'],
                ['vendor.js.map', 'source-map'],
            ]);
        } finally { rm(dir); }
    });

    it('the byte budget keeps the smallest files and depends only on the file table', () => {
        const files = {
            'package.json': '{}',
            '.ucn.json': JSON.stringify({ textScanBudgetBytes: 100 }),
            'lib.js': 'export function target() {}\nexport function other() {}',
            'a.rb': `target ${'#'.repeat(53)}`,   // 60 bytes
            'b.rb': `target ${'#'.repeat(53)}`,   // 60 bytes: over the budget after a.rb
            'small.rb': 'other',                  // 5 bytes
        };
        const dir = tmp(files);
        try {
            const first = universe.universe(idx(dir));
            const second = universe.universe(idx(dir));
            assert.deepStrictEqual(first, second, 'same repository, same assignment');
            assert.deepStrictEqual(first.textOnly.map(entry => entry.relativePath), ['a.rb', 'small.rb']);
            assert.deepStrictEqual(first.opaque.map(entry => [entry.relativePath, entry.reason]),
                [['b.rb', 'text-scan-budget']]);
            assert.deepStrictEqual(first.budget, { limitBytes: 100, usedBytes: 65 });
            // Text past the budget cannot clear any name: every account says so.
            const account = execute(idx(dir), 'impact', { name: 'other' }).result.account;
            assert.strictEqual(account.contract.textComplete, false);
            assert.deepStrictEqual(account.opaque.reasons, { 'text-scan-budget': 1 });
            assert.strictEqual(account.unsupported.lines, 1); // small.rb was searched
        } finally { rm(dir); }
    });

    it('only the build, the cache and the universe read raw discovery facts', () => {
        const allowed = new Set([
            'core/project.js', 'core/cache.js', 'core/source-universe.js',
            'cli/index.js', // glob mode appends its own walk's issues to the index
        ]);
        const offenders = [];
        const visit = relative => {
            const absolute = path.join(__dirname, '..', relative);
            for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
                const child = `${relative}/${entry.name}`;
                if (entry.isDirectory()) { visit(child); continue; }
                if (!entry.name.endsWith('.js') || allowed.has(child)) continue;
                const text = fs.readFileSync(path.join(absolute, entry.name), 'utf8');
                if (/\bdiscoveryIssues\b|\bskippedSources\s*=\s*.*discoveryIssues/.test(text)) {
                    offenders.push(child);
                }
            }
        };
        for (const root of ['core', 'cli', 'mcp']) visit(root);
        assert.deepStrictEqual(offenders, [],
            'read core/source-universe.js instead of interpreting discovery issues');
    });
});

describe('source universe: edits to unanalyzed source', () => {
    const complete = (index, name) =>
        execute(index, 'impact', { name }).result.account.contract.textComplete;
    const cached = (dir, index) => {
        const cacheFile = path.join(dir, '.cache-test', 'index.json');
        saveCache(index, cacheFile);
        const warm = new ProjectIndex(dir);
        assert.strictEqual(loadCache(warm, cacheFile), true);
        return warm;
    };
    const check = index => { index._lastFreshAt = 0; return isCacheStale(index); };

    it('an edited bundle changes the next answer without a rebuild', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export function target() {}',
            'vendor.min.js': 'unrelated();',
        });
        try {
            const live = idx(dir);
            const warm = cached(dir, live);
            assert.strictEqual(complete(live, 'target'), true);
            assert.strictEqual(complete(warm, 'target'), true);
            fs.writeFileSync(path.join(dir, 'vendor.min.js'), 'unrelated(); target();');
            // Still a bundle: no symbol changed, so neither index is stale...
            assert.strictEqual(check(live), false);
            assert.strictEqual(check(warm), false);
            // ...and neither serves the scan it made before the edit.
            assert.strictEqual(complete(live, 'target'), false);
            assert.strictEqual(complete(warm, 'target'), false);
            assert.strictEqual(complete(idx(dir), 'target'), false, 'a fresh build agrees');
        } finally { rm(dir); }
    });

    it('a file crossing the size limit in either direction is a rebuild', () => {
        const dir = tmp({
            'package.json': '{}',
            '.ucn.json': JSON.stringify({ maxFileSize: 200 }),
            'lib.js': 'export function target() {}',
            'big.js': `export function oversized() {}\n// ${'x'.repeat(300)}`,
        });
        try {
            const live = idx(dir);
            assert.deepStrictEqual(live.discoveryIssues.map(issue => [issue.reason, issue.relativePath]),
                [['max-file-size', 'big.js']]);
            assert.strictEqual(live.find('oversized', { exact: true, skipCounts: true }).length, 0);
            complete(live, 'target'); // classify before the edit
            const warm = cached(dir, live);
            assert.strictEqual(check(live), false);
            assert.strictEqual(check(warm), false);
            // Back under the limit: it can be indexed now.
            fs.writeFileSync(path.join(dir, 'big.js'), 'export function oversized() {}');
            assert.strictEqual(check(live), true);
            assert.strictEqual(check(warm), true);
            const rebuilt = idx(dir);
            assert.strictEqual(rebuilt.find('oversized', { exact: true, skipCounts: true }).length, 1);
            assert.deepStrictEqual(rebuilt.discoveryIssues, []);
            // An indexed file growing past the limit is a rebuild too.
            fs.writeFileSync(path.join(dir, 'lib.js'),
                `export function target() {}\n// ${'y'.repeat(300)}`);
            assert.strictEqual(check(rebuilt), true);
        } finally { rm(dir); }
    });

    it('a parse failure is retried when its file changes', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export function target() {}',
            'broken.js': 'export function later() {}',
        });
        try {
            const live = idx(dir);
            // Stand in for a file the parser could not ingest.
            const broken = path.join(dir, 'broken.js');
            live.removeFileSymbols(broken);
            live.files.delete(broken);
            live.failedFiles.add(broken);
            const warm = cached(dir, live);
            assert.strictEqual(check(live), false);
            assert.strictEqual(check(warm), false);
            fs.writeFileSync(broken, 'export function later() { return 1; }');
            assert.strictEqual(check(live), true, 'a long-lived index retries the file');
            assert.strictEqual(check(warm), true, 'so does a cache-loaded one');
        } finally { rm(dir); }
    });

    it('the budget is reassigned when a text-only file changes size', () => {
        const dir = tmp({
            'package.json': '{}',
            '.ucn.json': JSON.stringify({ textScanBudgetBytes: 100 }),
            'lib.js': 'export function target() {}',
            'a.rb': '#'.repeat(60),
            'b.rb': '#'.repeat(60),
        });
        try {
            const live = idx(dir);
            assert.strictEqual(complete(live, 'target'), false, 'b.rb is past the budget');
            const warm = cached(dir, live);
            fs.writeFileSync(path.join(dir, 'a.rb'), '#'.repeat(30));
            assert.strictEqual(check(live), false);
            assert.strictEqual(check(warm), false);
            for (const index of [live, warm, idx(dir)]) {
                assert.strictEqual(complete(index, 'target'), true);
                assert.deepStrictEqual(universe.universe(index).budget,
                    { limitBytes: 100, usedBytes: 90 });
            }
        } finally { rm(dir); }
    });
});
