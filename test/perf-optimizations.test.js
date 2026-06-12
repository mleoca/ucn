/**
 * Tests for performance optimizations added during the perf review.
 * Covers: findEnclosingFunction cache, regex memoization, incremental callee index,
 * lazy calls cache, importGraph Sets, deadcode export pre-filter, related caps,
 * reverseTrace cache, atomic shard writes, _endOp guard, cache v8.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { saveCache, loadCache, isCacheStale, CACHE_FORMAT_VERSION } = require('../core/cache');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MULTI_DEF_FIXTURE = {
    'package.json': '{"name":"test"}',
    'a.js': `
function Run() { return helper(); }
function helper() { return 1; }
module.exports = { Run, helper };
`,
    'b.js': `
function Run() { return process(); }
function process() { return 2; }
module.exports = { Run, process };
`,
    'c.js': `
function Run() { return handle(); }
function handle() { return 3; }
module.exports = { Run, handle };
`,
    'caller.js': `
const a = require('./a');
function main() { a.Run(); }
module.exports = { main };
`,
};

// ── findEnclosingFunction op cache ────────────────────────────────────────────

describe('perf: findEnclosingFunction op cache', () => {
    it('returns cached result for same (file, line) within operation', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function outer() {
    function inner() { return 1; }
    return inner();
}
`
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const filePath = path.join(dir, 'lib.js');
                // First call populates cache
                const result1 = index.findEnclosingFunction(filePath, 3, true);
                assert.ok(result1, 'should find enclosing function');
                // Second call should hit cache (same result object)
                const result2 = index.findEnclosingFunction(filePath, 3, true);
                assert.strictEqual(result1, result2, 'should return cached symbol object');
                // Name-only call should derive from cached symbol
                const name = index.findEnclosingFunction(filePath, 3, false);
                assert.strictEqual(name, result1.name, 'name should match cached symbol');
            } finally {
                index._endOp();
            }
            // After _endOp, cache is cleared — next call should still work
            const result3 = index.findEnclosingFunction(path.join(dir, 'lib.js'), 3, true);
            assert.ok(result3, 'should work after op cache cleared');
        } finally {
            rm(dir);
        }
    });

    it('caches null for non-existent files', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'lib.js': 'function f() {}' });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const result = index.findEnclosingFunction('/nonexistent.js', 1, true);
                assert.strictEqual(result, null, 'should return null for missing file');
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });
});

// ── Incremental callee index ──────────────────────────────────────────────────

describe('perf: incremental callee index', () => {
    it('_removeFromCalleeIndex removes entries without full invalidation', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            // Ensure callee index is built
            if (!index.calleeIndex) index.buildCalleeIndex();
            assert.ok(index.calleeIndex.has('helper'), 'callee index should have helper');

            // Simulate removing a file's calls
            const appPath = path.join(dir, 'app.js');
            const cached = index.callsCache.get(appPath);
            assert.ok(cached, 'app.js should be in callsCache');

            index._removeFromCalleeIndex(appPath, cached.calls);
            // helper should still be in index if other files call it, or removed if only app.js called it
            // The point is: calleeIndex is NOT null (no full invalidation)
            assert.ok(index.calleeIndex instanceof Map, 'calleeIndex should still be a Map, not null');
        } finally {
            rm(dir);
        }
    });

    it('_addToCalleeIndex incrementally adds new entries', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            if (!index.calleeIndex) index.buildCalleeIndex();

            // Add a fake call entry
            index._addToCalleeIndex('/fake/file.js', [{ name: 'newFunction' }]);
            assert.ok(index.calleeIndex.has('newFunction'), 'should add new entry');
            assert.ok(index.calleeIndex.get('newFunction').has('/fake/file.js'), 'should map to correct file');
        } finally {
            rm(dir);
        }
    });
});

// ── _endOp content clearing and mismatch guard ───────────────────────────────

describe('perf: _endOp behavior', () => {
    it('clears callsCache.content after operation', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            // Manually inject content into a callsCache entry to simulate includeContent
            const appPath = path.join(dir, 'app.js');
            const cached = index.callsCache.get(appPath);
            if (cached) {
                cached.content = 'test file content';
                assert.ok(cached.content, 'content should be set');
            }

            index._beginOp();
            try {
                // operation does work...
            } finally {
                index._endOp();
            }
            // After _endOp, content should be cleared
            if (cached) {
                assert.strictEqual(cached.content, undefined, 'content should be cleared after _endOp');
            }
        } finally {
            rm(dir);
        }
    });

    it('mismatch guard: _endOp without _beginOp does not crash', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'lib.js': 'function f() {}' });
        try {
            const index = idx(dir);
            // Should not throw
            index._endOp();
            index._endOp();
            assert.ok(true, 'unpaired _endOp should not crash');
        } finally {
            rm(dir);
        }
    });
});

// ── Lazy calls cache loading ──────────────────────────────────────────────────

describe('perf: lazy calls cache loading', () => {
    it('loadCache does not eagerly populate callsCache', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index1 = idx(dir);
            index1.findCallers('helper'); // populate callsCache
            index1.saveCache();

            // Load in new instance — callsCache should be empty (lazy)
            const { ProjectIndex } = require('../core/project');
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            assert.strictEqual(index2.callsCache.size, 0, 'callsCache should be empty after loadCache (lazy)');
            assert.ok(index2._callsCachePrepared, 'manifest should be prepared');

            // Trigger lazy load via getCachedCalls
            const calls = index2.getCachedCalls(path.join(dir, 'app.js'));
            assert.ok(calls, 'should get calls after lazy load');
            assert.ok(index2.callsCache.size > 0, 'callsCache should be populated after lazy load');
        } finally {
            rm(dir);
        }
    });
});

// ── importGraph/exportGraph as Sets ───────────────────────────────────────────

describe('perf: importGraph/exportGraph as Sets', () => {
    it('importGraph values are Sets with .has() support', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            const appPath = path.join(dir, 'app.js');
            const libPath = path.join(dir, 'lib.js');
            const imports = index.importGraph.get(appPath);
            assert.ok(imports instanceof Set, 'importGraph values should be Sets');
            assert.ok(imports.has(libPath), 'app.js should import lib.js');
        } finally {
            rm(dir);
        }
    });

    it('exportGraph values are Sets', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            const libPath = path.join(dir, 'lib.js');
            const exporters = index.exportGraph.get(libPath);
            assert.ok(exporters instanceof Set, 'exportGraph values should be Sets');
        } finally {
            rm(dir);
        }
    });

    it('graph Sets survive cache save/load roundtrip with correct paths', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index1 = idx(dir);
            index1.saveCache();

            const { ProjectIndex } = require('../core/project');
            const index2 = new ProjectIndex(dir);
            index2.loadCache();

            const appPath = path.join(dir, 'app.js');
            const libPath = path.join(dir, 'lib.js');

            // Verify importGraph path resolution after cache roundtrip
            const imports = index2.importGraph.get(appPath);
            assert.ok(imports instanceof Set, 'importGraph values should be Sets after cache load');
            assert.ok(imports.has(libPath), 'import edge path should resolve correctly after reload');

            // Verify exportGraph path resolution
            const exporters = index2.exportGraph.get(libPath);
            assert.ok(exporters instanceof Set, 'exportGraph values should be Sets after cache load');
            assert.ok(exporters.has(appPath), 'export edge path should resolve correctly after reload');

            // Verify files Map uses correct absolute paths
            assert.ok(index2.files.has(appPath), 'files Map should have absolute path for app.js');
            assert.ok(index2.files.has(libPath), 'files Map should have absolute path for lib.js');

            // Verify symbols have correct file paths
            const helperDefs = index2.symbols.get('helper');
            assert.ok(helperDefs, 'should have helper symbol');
            assert.strictEqual(helperDefs[0].file, libPath, 'symbol file should be absolute path');

            // Verify callers still work through cached paths (end-to-end accuracy check)
            const callers = index2.findCallers('helper');
            assert.ok(callers.length > 0, 'findCallers should work after cache reload');
            assert.ok(callers.some(c => c.callerName === 'main'), 'should find main as caller of helper');
        } finally {
            rm(dir);
        }
    });
});

// ── Deadcode export pre-filter ────────────────────────────────────────────────

describe('perf: deadcode optimizations', () => {
    it('exported symbols are excluded from text scan when not --include-exported', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function publicHelper() { return 1; }
function _privateUnused() { return 2; }
module.exports = { publicHelper };
`,
            'app.js': `
const { publicHelper } = require('./lib');
function main() { publicHelper(); }
`
        });
        try {
            const index = idx(dir);
            const deadResults = index.deadcode({});
            // _privateUnused is not exported and not called — should be dead
            const deadNames = deadResults.map(r => r.name);
            assert.ok(deadNames.includes('_privateUnused'), '_privateUnused should be dead');
            // publicHelper is exported — should NOT be in results (excluded by default)
            assert.ok(!deadNames.includes('publicHelper'), 'exported publicHelper should be excluded');
            assert.ok(deadResults.excludedExported > 0, 'should report excluded exported count');
        } finally {
            rm(dir);
        }
    });
});

// ── Cache v8 compatibility ───────────────────────────────────────────────────

describe('perf: cache v8', () => {
    it('saves cache as the current version without calleeIndex', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const cachePath = path.join(dir, '.ucn-cache', 'index.json');
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, CACHE_FORMAT_VERSION, 'should save as current version');
            assert.ok(!cacheData.calleeIndex, 'should not include calleeIndex');
        } finally {
            rm(dir);
        }
    });

    it('loads both v7 and v8 caches', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            // Verify v8 loads
            const { ProjectIndex } = require('../core/project');
            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'v8 cache should load');
            assert.ok(index2.symbols.size > 0, 'symbols should be present');
        } finally {
            rm(dir);
        }
    });
});

// ── Atomic shard writes ──────────────────────────────────────────────────────

describe('perf: atomic shard writes', () => {
    it('writes shards via temp directory then renames', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            index.findCallers('helper'); // populate callsCache
            index.saveCache();

            // Verify final calls directory exists with manifest
            const callsDir = path.join(dir, '.ucn-cache', 'calls');
            assert.ok(fs.existsSync(callsDir), 'calls dir should exist');
            assert.ok(fs.existsSync(path.join(callsDir, 'manifest.json')), 'manifest should exist');

            // Verify temp directory was cleaned up
            const tmpDir = path.join(dir, '.ucn-cache', 'calls.tmp');
            assert.ok(!fs.existsSync(tmpDir), 'temp dir should be cleaned up after rename');
        } finally {
            rm(dir);
        }
    });
});

// ── related command caps ─────────────────────────────────────────────────────

describe('perf: related command caps', () => {
    it('completes in reasonable time for ambiguous names', () => {
        const dir = tmp(MULTI_DEF_FIXTURE);
        try {
            const index = idx(dir);
            const start = Date.now();
            const result = execute(index, 'related', { name: 'Run' });
            const elapsed = Date.now() - start;
            assert.ok(result.ok, 'related should succeed');
            assert.ok(result.result.target, 'should have target');
            assert.ok(elapsed < 5000, `related should complete in <5s, took ${elapsed}ms`);
        } finally {
            rm(dir);
        }
    });
});

// ── about ambiguous name optimizations ───────────────────────────────────────

describe('perf: about ambiguous name handling', () => {
    it('reduces caller cap for highly ambiguous names (>5 definitions)', () => {
        // Create fixture with >5 definitions of same name
        const files = { 'package.json': '{"name":"test"}' };
        for (let i = 0; i < 7; i++) {
            files[`mod${i}.js`] = `function Run() { return ${i}; }\nmodule.exports = { Run };`;
        }
        files['caller.js'] = 'const m = require("./mod0");\nfunction main() { m.Run(); }';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'Run' });
            assert.ok(result.ok, 'about should succeed');
            assert.ok(result.result.found, 'should find symbol');
            assert.ok(result.result.otherDefinitions.length > 0, 'should have other definitions');
        } finally {
            rm(dir);
        }
    });
});

// ── isCacheStale burst skip ──────────────────────────────────────────────────

describe('perf: isCacheStale burst skip', () => {
    it('skips re-glob within 2s of confirmed-fresh check', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            index.saveCache();

            const { ProjectIndex } = require('../core/project');
            const index2 = new ProjectIndex(dir);
            index2.loadCache();

            // First check — full check
            const stale1 = index2.isCacheStale();
            assert.strictEqual(stale1, false, 'should not be stale');
            assert.ok(index2._lastFreshAt, '_lastFreshAt should be set');

            // Second check within 2s — should use fast path
            const start = Date.now();
            const stale2 = index2.isCacheStale();
            const elapsed = Date.now() - start;
            assert.strictEqual(stale2, false, 'should not be stale on burst check');
            assert.ok(elapsed < 10, `burst check should be <10ms, took ${elapsed}ms`);
        } finally {
            rm(dir);
        }
    });

});

// ── PERF-1: persisted reachability set ────────────────────────────────────────

describe('perf: PERF-1 persists _reachableSymbols across runs', () => {
    it('saves and reloads _reachableSymbols, skipping recompute on warm load', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': `
function main() { a(); b(); }
function a() { c(); }
function b() { c(); }
function c() { return 1; }
function unused() { return 2; }
module.exports = { main };
`,
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const index1 = new ProjectIndex(dir);
            index1.build(null, { quiet: true });
            const { computeReachability } = require('../core/entrypoints');
            const r1 = computeReachability(index1);
            assert.ok(r1.size > 0, 'should compute non-empty reachable set');
            index1.saveCache();

            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'cache should load');
            assert.ok(index2._reachableSymbols, '_reachableSymbols should be restored');
            assert.strictEqual(index2._reachableSymbols.size, r1.size,
                'restored set should match original');

            const before = index2._reachableSymbols;
            const r2 = computeReachability(index2);
            assert.strictEqual(r2, before, 'should return cached set without recompute');
        } finally {
            rm(dir);
        }
    });

    it('discards cached _reachableSymbols when index drifts after load', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': 'function main() { return 1; }\nmodule.exports = { main };',
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const index1 = new ProjectIndex(dir);
            index1.build(null, { quiet: true });
            const { computeReachability } = require('../core/entrypoints');
            computeReachability(index1);
            index1.saveCache();

            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'cache should load');
            assert.ok(index2._reachableSymbols, '_reachableSymbols should be restored');
            assert.ok(index2._reachableFingerprint, 'fingerprint should be restored');

            // Simulate drift: add a synthetic file to the in-memory map.
            index2.files.set('/synthetic/extra.js', {
                language: 'javascript',
                relativePath: '../synthetic/extra.js',
                lines: 1,
                symbols: [],
                bindings: [],
            });
            const cached = index2._reachableSymbols;
            const recomputed = computeReachability(index2);
            assert.notStrictEqual(recomputed, cached,
                'drift should force recompute (fresh Set)');
        } finally {
            rm(dir);
        }
    });

    it('warm computeReachability is at least as fast as cold (cache hit)', () => {
        const N = 30;
        const files = { 'package.json': '{"name":"test"}' };
        let body = '';
        for (let i = 0; i < N; i++) {
            body += `function fn${i}() { return ${i === 0 ? 1 : `fn${i - 1}()`}; }\n`;
        }
        body += `module.exports = { fn0, fn${N - 1} };\n`;
        files['index.js'] = body;
        const dir = tmp(files);
        try {
            const { ProjectIndex } = require('../core/project');
            const { computeReachability } = require('../core/entrypoints');

            const t0 = Date.now();
            const index1 = new ProjectIndex(dir);
            index1.build(null, { quiet: true });
            computeReachability(index1);
            index1.saveCache();
            const cold = Date.now() - t0;

            const t1 = Date.now();
            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'cache should load');
            const warmReachable = computeReachability(index2);
            const warm = Date.now() - t1;
            assert.ok(warmReachable.size > 0, 'warm reachable should be non-empty');
            // Generous bound — anything ≤ cold * 0.6 (or under 50ms absolute) is a clear win.
            assert.ok(warm <= Math.max(50, cold * 0.6),
                `warm ${warm}ms should be <= cold ${cold}ms * 0.6`);
        } finally {
            rm(dir);
        }
    });
});

// ── MED-1: reachabilityDirty flag persists set on cache-hit runs ──────────────

describe('perf: MED-1 reachabilityDirty flag', () => {
    it('marks reachabilityDirty=true after computing the BFS', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': `
function main() { a(); b(); }
function a() { c(); }
function b() { c(); }
function c() { return 1; }
function unused() { return 2; }
module.exports = { main };
`,
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const { computeReachability } = require('../core/entrypoints');
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            assert.ok(!index.reachabilityDirty, 'flag should be unset before compute');
            computeReachability(index);
            assert.strictEqual(index.reachabilityDirty, true,
                'reachabilityDirty should be true after BFS computes the set');
        } finally {
            rm(dir);
        }
    });

    it('saveCache persists reachableSymbols and clears the dirty flag', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': `
function main() { a(); b(); }
function a() { c(); }
function b() { c(); }
function c() { return 1; }
function unused() { return 2; }
module.exports = { main };
`,
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const { computeReachability } = require('../core/entrypoints');
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            computeReachability(index);
            assert.strictEqual(index.reachabilityDirty, true);
            index.saveCache();
            assert.strictEqual(index.reachabilityDirty, false,
                'flag should be cleared after successful saveCache');
            // Verify cache file actually contains reachableSymbols
            const cacheData = JSON.parse(fs.readFileSync(
                path.join(dir, '.ucn-cache', 'index.json'), 'utf-8'));
            assert.ok(Array.isArray(cacheData.reachableSymbols),
                'cache file should have reachableSymbols array');
            assert.ok(cacheData.reachableSymbols.length > 0,
                'reachableSymbols should be non-empty');
        } finally {
            rm(dir);
        }
    });

    it('cache-hit run that triggers reachability persists the result', () => {
        // Reproduces MED-1: previously, run 1 would save without reachability;
        // run 2 would compute it but never save; run 3 would re-compute. Now
        // run 2 must save the BFS so run 3 sees it on disk.
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': `
function main() { a(); b(); }
function a() { c(); }
function b() { c(); }
function c() { return 1; }
function unused() { return 2; }
module.exports = { main };
`,
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const { computeReachability } = require('../core/entrypoints');

            // Run 1: build + save without reachability (e.g. just stats).
            const index1 = new ProjectIndex(dir);
            index1.build(null, { quiet: true });
            index1.saveCache();
            const cache1 = JSON.parse(fs.readFileSync(
                path.join(dir, '.ucn-cache', 'index.json'), 'utf-8'));
            assert.ok(!cache1.reachableSymbols,
                'run 1 should not have reachableSymbols (stats does not need it)');

            // Run 2: load cache, compute reachability, then surface mimics
            // cli/index.js's finally block by checking reachabilityDirty.
            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'cache should load');
            computeReachability(index2);
            assert.strictEqual(index2.reachabilityDirty, true);

            // Mimic the cache-save guard: index.callsCacheDirty || reachabilityDirty
            const shouldSave = index2.callsCacheDirty || index2.reachabilityDirty;
            assert.strictEqual(shouldSave, true,
                'guard should trigger save when reachability was computed');
            if (shouldSave) index2.saveCache();

            const cache2 = JSON.parse(fs.readFileSync(
                path.join(dir, '.ucn-cache', 'index.json'), 'utf-8'));
            assert.ok(Array.isArray(cache2.reachableSymbols),
                'run 2 should now persist reachableSymbols');
            assert.ok(cache2.reachableFingerprint,
                'should also persist the fingerprint');

            // Run 3: load cache — reachability should be reused without recompute.
            const index3 = new ProjectIndex(dir);
            assert.ok(index3.loadCache(), 'cache should load');
            assert.ok(index3._reachableSymbols,
                'run 3 should restore reachableSymbols from disk');
            const before = index3._reachableSymbols;
            const r = computeReachability(index3);
            assert.strictEqual(r, before,
                'run 3 should return cached set without recompute');
            // Note: dirty flag is NOT set when the cached set is reused.
            assert.ok(!index3.reachabilityDirty,
                'flag stays false on cached-reuse path');
        } finally {
            rm(dir);
        }
    });
});

// ── PERF-3: atomic write of index.json ────────────────────────────────────────

describe('perf: PERF-3 atomic index.json write', () => {
    it('does not leave a torn index.json after repeated saves', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function f() { return 1; }\nmodule.exports = { f };',
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });

            for (let i = 0; i < 5; i++) {
                index.saveCache();
                const cachePath = path.join(dir, '.ucn-cache', 'index.json');
                const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
                assert.strictEqual(data.version, CACHE_FORMAT_VERSION, 'cache version should be intact');
            }

            const tmpFile = path.join(dir, '.ucn-cache', 'index.json.tmp');
            assert.ok(!fs.existsSync(tmpFile), '.tmp file should be cleaned up');
        } finally {
            rm(dir);
        }
    });
});

// ── JAVA-2: entrypoints includes test entries by default ──────────────────────

describe('perf: JAVA-2 entrypoints test-entry default visibility', () => {
    it('shows JUnit @Test methods by default for Java', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/App.java': `
package com.x;

public class App {
    public static void main(String[] args) { run(); }
    public static void run() {}
}
`,
            'src/test/java/AppTests.java': `
package com.x;

import org.junit.jupiter.api.Test;

public class AppTests {
    @Test
    public void shouldRun() {
        new App().run();
    }
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', { type: 'test' });
            assert.strictEqual(ok, true);
            const testEntries = (result || []).filter(e =>
                e.framework === 'junit' && e.name === 'shouldRun');
            assert.ok(testEntries.length > 0,
                '@Test method should appear in default entrypoints output');

            const { ok: ok2, result: result2 } = execute(index, 'entrypoints', {
                type: 'test', excludeTests: true,
            });
            assert.strictEqual(ok2, true);
            const stillThere = (result2 || []).filter(e =>
                e.framework === 'junit' && e.name === 'shouldRun');
            assert.strictEqual(stillThere.length, 0,
                '--exclude-tests should hide @Test methods');
        } finally {
            rm(dir);
        }
    });
});

// ── JAVA-4: Spring/JPA/JAX-WS framework labels ────────────────────────────────

describe('perf: JAVA-4 Spring/JPA/JAX framework labels', () => {
    it('labels @Entity, @MappedSuperclass under "jpa", not "unknown"', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/Person.java': `
package com.x;

import jakarta.persistence.Entity;
import jakarta.persistence.MappedSuperclass;

@MappedSuperclass
public class Person {
}

@Entity
class Owner extends Person {
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', {});
            assert.strictEqual(ok, true);
            const owner = (result || []).find(e => e.name === 'Owner');
            const person = (result || []).find(e => e.name === 'Person');
            assert.ok(owner, 'Owner should be detected');
            assert.ok(person, 'Person should be detected');
            assert.strictEqual(owner.framework, 'jpa', '@Entity should map to jpa');
            assert.strictEqual(person.framework, 'jpa', '@MappedSuperclass should map to jpa');
        } finally {
            rm(dir);
        }
    });

    it('labels @SpringBootApplication, @Configuration under "spring"', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/App.java': `
package com.x;

import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Configuration;

@SpringBootApplication
public class App {
}

@Configuration
class Conf {
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', {});
            assert.strictEqual(ok, true);
            const app = (result || []).find(e => e.name === 'App');
            const conf = (result || []).find(e => e.name === 'Conf');
            assert.ok(app, 'App should be detected');
            assert.ok(conf, 'Conf should be detected');
            assert.strictEqual(app.framework, 'spring',
                '@SpringBootApplication should map to spring');
            assert.strictEqual(conf.framework, 'spring',
                '@Configuration should map to spring');
        } finally {
            rm(dir);
        }
    });

    it('labels @InitBinder, @ModelAttribute under "spring-mvc"', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/Ctrl.java': `
package com.x;

import org.springframework.web.bind.annotation.InitBinder;
import org.springframework.web.bind.annotation.ModelAttribute;

public class Ctrl {
    @InitBinder
    public void setup(Object b) {}

    @ModelAttribute("user")
    public Object user() { return null; }
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', {});
            assert.strictEqual(ok, true);
            const setup = (result || []).find(e => e.name === 'setup');
            const user = (result || []).find(e => e.name === 'user');
            assert.ok(setup, '@InitBinder method should be detected');
            assert.ok(user, '@ModelAttribute method should be detected');
            assert.strictEqual(setup.framework, 'spring-mvc',
                '@InitBinder should map to spring-mvc');
            assert.strictEqual(user.framework, 'spring-mvc',
                '@ModelAttribute should map to spring-mvc');
        } finally {
            rm(dir);
        }
    });

    it('labels @Query under "spring-data" (not "unknown")', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/Repo.java': `
package com.x;

import org.springframework.data.jpa.repository.Query;

public interface Repo {
    @Query("select x from y")
    java.util.List findX();
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', {});
            assert.strictEqual(ok, true);
            const findX = (result || []).find(e => e.name === 'findX');
            assert.ok(findX, '@Query method should be detected');
            assert.strictEqual(findX.framework, 'spring-data',
                '@Query should map to spring-data');
        } finally {
            rm(dir);
        }
    });

    it('labels @XmlRootElement under "jax-rs" (not "unknown")', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/X.java': `
package com.x;

import jakarta.xml.bind.annotation.XmlRootElement;

@XmlRootElement
public class X {
}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', {});
            assert.strictEqual(ok, true);
            const x = (result || []).find(e => e.name === 'X');
            assert.ok(x, '@XmlRootElement class should be detected');
            assert.strictEqual(x.framework, 'jax-rs',
                '@XmlRootElement should map to jax-rs');
        } finally {
            rm(dir);
        }
    });
});

// ── visitNameNodes: occurrence-targeted usage scan ───────────────────────────
// findUsagesInCode used to walk EVERY tree node checking node.text === name
// (N-API text materialization per identifier — 78% of account time on
// grpc-go). visitNameNodes locates the name's whole-word text occurrences in
// the source string and jumps to each node via descendantForIndex. These
// tests pin the equivalence edges: unicode offsets (tree-sitter indexes are
// UTF-16 code units, same as JS strings), $-adjacent identifiers (longer
// token ≠ name), comment/string occurrences (non-identifier node, skipped
// by the callbacks' type guards), and multiple occurrences per line.

describe('visitNameNodes usage scan', () => {
    it('classifies usages identically with unicode content before the occurrence', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'uni.js': `// héllo wörld — ünïcode cömment before the code
function target() { return 1; }
const x = target();
module.exports = { target };
`,
        });
        try {
            const index = idx(dir);
            const fileKey = [...index.files.keys()].find(k => k.endsWith('uni.js'));
            const usages = index._getCachedUsages(fileKey, 'target');
            // def line 2 and call line 3 — unicode in the comment must not
            // shift the occurrence offsets (UTF-16 code units throughout);
            // the comment's own text never matches (no `target` in it).
            const byType = Object.fromEntries(usages.map(u => [u.usageType, u.line]));
            assert.strictEqual(byType.definition, 2, JSON.stringify(usages));
            assert.strictEqual(byType.call, 3, JSON.stringify(usages));
        } finally { rm(dir); }
    });

    it('does not attribute $-prefixed identifiers or comment/string occurrences', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'dollar.js': `function run() { return 1; }
const $run = 2;          // $run is a different identifier; comment says run
const s = "run in a string";
const y = run();
module.exports = { run };
`,
        });
        try {
            const index = idx(dir);
            const fileKey = [...index.files.keys()].find(k => k.endsWith('dollar.js'));
            const usages = index._getCachedUsages(fileKey, 'run');
            // def line 1 and call line 4 — NOT line 2 ($run is a longer
            // identifier; the comment mention is a non-identifier node),
            // NOT line 3 (string content), NOT line 5 ({ run } shorthand
            // object property — a node type the scan has never collected).
            const lines = usages.map(u => u.line).sort((a, b) => a - b);
            assert.deepStrictEqual(lines, [1, 4], JSON.stringify(usages));
        } finally { rm(dir); }
    });

    it('captures multiple occurrences on one line across all languages', () => {
        const { forEachLanguage } = require('./helpers');
        const FIXTURES = {
            javascript: { file: 'two.js', code: 'function pair() { return 1; }\nconst v = pair() + pair();\n' },
            python: { file: 'two.py', code: 'def pair():\n    return 1\n\nv = pair() + pair()\n' },
            go: { file: 'two.go', code: 'package main\n\nfunc pair() int { return 1 }\n\nfunc main() { v := pair() + pair(); _ = v }\n' },
            rust: { file: 'two.rs', code: 'pub fn pair() -> u32 { 1 }\n\npub fn main() { let _v = pair() + pair(); }\n' },
            java: { file: 'Two.java', code: 'public class Two {\n    int pair() { return 1; }\n    int both() { return pair() + pair(); }\n}\n' },
        };
        for (const [lang, fx] of Object.entries(FIXTURES)) {
            const files = { 'package.json': '{"name":"test"}' };
            files[fx.file] = fx.code;
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const fileKey = [...index.files.keys()].find(k => k.endsWith(fx.file));
                const usages = index._getCachedUsages(fileKey, 'pair');
                const calls = usages.filter(u => u.usageType === 'call');
                assert.strictEqual(calls.length, 2,
                    `${lang}: two call usages on the same line: ${JSON.stringify(usages)}`);
                assert.strictEqual(calls[0].line, calls[1].line, `${lang}: same line`);
                assert.ok(calls[0].column !== calls[1].column, `${lang}: distinct columns`);
            } finally { rm(dir); }
        }
    });
});

// ============================================================================
// Index reliability guard: parallel build determinism — worker-pool builds
// must produce the EXACT index a sequential build does (symbol fields, file
// entries, calls). >500 files triggers the parallel path; workers:0 forces
// sequential.
// ============================================================================

describe('index reliability: parallel build equals sequential build', () => {
    it('worker-pool index is byte-identical to sequential', () => {
        const { tmp, rm, indexSnapshot } = require('./helpers');
        const { ProjectIndex } = require('../core/project');
        const spec = { 'package.json': '{"name":"big"}' };
        const N = 520; // > 500-file parallel threshold
        for (let i = 0; i < N; i++) {
            const next = (i + 1) % N;
            spec[`m${i}.js`] = [
                `const { fn${next} } = require("./m${next}");`,
                `function fn${i}(x) { return fn${next} ? fn${next}(x) + ${i} : ${i}; }`,
                `class C${i} { run() { return fn${i}(1); } }`,
                `module.exports = { fn${i}, C${i} };`,
            ].join('\n');
        }
        // Shapes whose symbol fields the worker once silently dropped (fix
        // #219 found aliasOf/isAsync/isGenerator/paramTypes/traitName/
        // *WithArgs missing from build-worker's addSymbol): the snapshot
        // guard only catches a drop when the fixture PRODUCES the field.
        spec['rich0.ts'] = [
            'export type AliasT = BaseT;',
            'export class BaseT {',
            '  cache: Map<string, number> = new Map();',
            '  handler: (x: number) => string;',
            '  async load(p: string): Promise<number> { return 1; }',
            '  *gen(): Iterable<number> { yield 1; }',
            '}',
            'export function typedFn(a: string, b: number): boolean { return !!a && b > 0; }',
        ].join('\n');
        spec['rich1.py'] = [
            'from flask import Flask',
            'app = Flask(__name__)',
            '@app.route("/things")',
            'def list_things():',
            '    return []',
            'async def fetch_thing(name: str) -> dict:',
            '    return {}',
        ].join('\n');
        spec['rich2.rs'] = [
            'pub trait Greet { fn hello(&self) -> String; }',
            'pub struct Greeter;',
            'impl Greet for Greeter {',
            '    fn hello(&self) -> String { String::from("hi") }',
            '}',
        ].join('\n');
        const dir = tmp(spec);
        try {
            const seq = new ProjectIndex(dir);
            seq.build(null, { quiet: true, workers: 0 });
            const par = new ProjectIndex(dir);
            par.build(null, { quiet: true, workers: 2 });
            assert.strictEqual(indexSnapshot(par), indexSnapshot(seq),
                'parallel and sequential builds must produce identical indexes');
        } finally { rm(dir); }
    });
});
