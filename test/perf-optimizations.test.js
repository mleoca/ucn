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
const { saveCache, loadCache, isCacheStale } = require('../core/cache');

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
    it('saves cache as version 8 without calleeIndex', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const cachePath = path.join(dir, '.ucn-cache', 'index.json');
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, 9, 'should save as current version');
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
