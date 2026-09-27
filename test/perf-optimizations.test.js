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
const { computeGroundSet } = require('../core/account');
const { scheduleFiles } = require('../core/parallel-build');
const {
    saveCache, loadCache, isCacheStale, getProjectCacheDir, getProjectCachePath,
    CACHE_FORMAT_VERSION,
} = require('../core/cache');

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

describe('perf: size-aware worker scheduling', () => {
    it('queues giant sources first so workers start on them together (fix #365)', () => {
        const sizes = new Map([
            ['small-a', { size: 30 }],
            ['huge-b', { size: 450 }],
            ['small-b', { size: 30 }],
            ['huge-a', { size: 500 }],
        ]);
        const order = scheduleFiles({ files: sizes }, [...sizes.keys()]).map(item => item.file);
        // Largest first; equal sizes keep discovery order.
        assert.deepStrictEqual(order, ['huge-a', 'huge-b', 'small-a', 'small-b']);
    });

    it('honors an explicit worker count as the measured build shape', () => {
        const files = { 'package.json': '{"name":"workers"}' };
        for (let i = 0; i < 8; i++) {
            files[`src/file-${i}.js`] = `export function f${i}(){ return ${i}; }`;
        }
        const dir = tmp(files);
        try {
            const index = new (require('../core/project').ProjectIndex)(dir);
            index.build(null, { quiet: true, workers: 4 });
            assert.strictEqual(index.lastBuildRequestedWorkers, 4);
            assert.strictEqual(index.lastBuildWorkerCount, 4);
            assert.strictEqual(index.lastBuildParallelEligible, true);
        } finally { rm(dir); }
    });
});

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

describe('perf: findCallees inner-method range cache', () => {
    it('builds one sorted range table per file for an operation', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
class Worker {
    start() { return this.step(); }
    step() { return this.finish(); }
    finish() { return 1; }
}
module.exports = { Worker };
`,
        });
        try {
            const index = idx(dir);
            const filePath = path.join(dir, 'lib.js');
            const classDef = index.symbols.get('Worker').find(def => def.type === 'class');
            const methodDef = index.symbols.get('start').find(def => def.className === 'Worker');
            index._beginOp();
            try {
                index.findCallees(classDef, { includeMethods: true });
                const cached = index._opInnerSymbolRangesCache.get(filePath);
                assert.ok(cached, 'class-method ranges should be cached');
                assert.ok(cached.length >= 3, 'all class methods should share the file table');
                index.findCallees(methodDef, { includeMethods: true });
                assert.strictEqual(index._opInnerSymbolRangesCache.get(filePath), cached,
                    'later definitions should reuse the same sorted table');
            } finally {
                index._endOp();
            }
            assert.strictEqual(index._opInnerSymbolRangesCache, null,
                'operation cache should be released');
        } finally {
            rm(dir);
        }
    });
});

describe('perf: chained-receiver identity caches', () => {
    it('memoizes annotation origins during an operation and releases the cache', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "chain-cache"\nversion = "0.1.0"',
            'src/main.rs': `
struct Builder;
impl Builder {
    fn new() -> Self { Self }
    fn step(self) -> Self { self }
}
fn main() { Builder::new().step(); }
`,
        });
        try {
            const index = idx(dir);
            const mainDef = index.symbols.get('main')[0];
            index._beginOp();
            try {
                index.findCallees(mainDef, { includeMethods: true });
                assert.ok(index._opFlowTypeOriginCache.size > 0,
                    'chained return-type identity should be memoized');
            } finally {
                index._endOp();
            }
            assert.strictEqual(index._opFlowTypeOriginCache, null,
                'annotation-origin cache should be released');
        } finally {
            rm(dir);
        }
    });
});

describe('perf: repeated C++ overload identity caches', () => {
    it('shares normalized types and project identity pairs within one operation', () => {
        const dir = tmp({
            'format.cpp': [
                'struct Printer {',
                '  static int format(int value) { return value; }',
                '  static int format(const char* value) { return value ? 1 : 0; }',
                '};',
                'int run() { return Printer::format(1); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('format')
                .find(definition => definition.startLine === 2);
            index._beginOp();
            try {
                const first = index.findCallers('format', {
                    targetDefinitions: [target], collectAccount: true,
                });
                const normalizedCount = index._opCppTypeCategoryCache.size;
                const receiverTypeCount = index._cppScope.resolved.size;
                const derefPairs = index._opDerefPairs;
                const aliasPairs = index._opAliasPairs;
                const second = index.findCallers('format', {
                    targetDefinitions: [target], collectAccount: true,
                });
                assert.ok(normalizedCount > 0,
                    'C++ parameter categories should be cached');
                assert.ok(receiverTypeCount > 0,
                    'qualified C++ receiver identity should be cached');
                assert.strictEqual(index._opCppTypeCategoryCache.size, normalizedCount,
                    'identical overload analysis reuses normalized types');
                assert.strictEqual(index._cppScope.resolved.size, receiverTypeCount,
                    'identical overload analysis reuses qualified receiver identity');
                assert.strictEqual(index._opDerefPairs, derefPairs,
                    'Deref identity scan is shared');
                assert.strictEqual(index._opAliasPairs, aliasPairs,
                    'type-alias identity scan is shared');
                assert.deepStrictEqual(second, first,
                    'memoized derivations preserve the caller answer');
            } finally {
                index._endOp();
            }
            assert.strictEqual(index._opCppTypeCategoryCache, null);
            assert.strictEqual(index._opDerefPairs, null);
            assert.strictEqual(index._opAliasPairs, null);
        } finally { rm(dir); }
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

describe('perf: cross-operation parsed-tree cache', () => {
    it('reuses immutable trees across commands and invalidates them on rebuild', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function helper(value) { return value + 1; }',
        });
        try {
            const index = idx(dir);
            const filePath = path.join(dir, 'lib.js');
            const content = fs.readFileSync(filePath, 'utf8');
            const language = index.files.get(filePath).language;
            let first;
            index._beginOp();
            try {
                first = index._getParsedTree(filePath, content, language);
            } finally {
                index._endOp();
            }
            assert.ok(first);
            assert.strictEqual(index._parsedTreeCache.size, 1);

            index._beginOp();
            try {
                const second = index._getParsedTree(filePath, content, language);
                assert.strictEqual(second, first,
                    'a later command should reuse the same immutable native tree');
            } finally {
                index._endOp();
            }

            fs.appendFileSync(filePath, '\nexport const changed = true;\n');
            index.build(null, { forceRebuild: true, quiet: true, workers: 0 });
            assert.strictEqual(index._parsedTreeCache.has(filePath), false,
                'incremental rebuild must evict a changed file tree');

            const changedContent = fs.readFileSync(filePath, 'utf8');
            index._beginOp();
            try {
                const third = index._getParsedTree(filePath, changedContent, language);
                assert.notStrictEqual(third, first);
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('drops parsed trees before replacing an index from persisted cache', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const filePath = path.join(dir, 'lib.js');
            index.saveCache();
            index._beginOp();
            try {
                index._getParsedTree(
                    filePath,
                    fs.readFileSync(filePath, 'utf8'),
                    index.files.get(filePath).language,
                );
            } finally {
                index._endOp();
            }
            assert.strictEqual(index._parsedTreeCache.size, 1);
            index._groundSetCache.set('stale-ground', { total: 1 });
            index._groundSetCacheLines = 1;
            index._nameBindingReachCache.set('stale-name', 'yes');
            index._returnTypeFlowCache.set('stale-flow', { calls: [], map: null });
            assert.strictEqual(index.loadCache(), true);
            assert.strictEqual(index._parsedTreeCache.size, 0);
            assert.strictEqual(index._groundSetCache.size, 0);
            assert.strictEqual(index._groundSetCacheLines, 0);
            assert.strictEqual(index._nameBindingReachCache.size, 0);
            assert.strictEqual(index._returnTypeFlowCache.size, 0);
        } finally {
            rm(dir);
        }
    });
});

describe('perf: cross-operation account caches', () => {
    it('reuses return-type flow and invalidates it on rebuild', () => {
        const dir = tmp({
            'package.json': '{"name":"return-flow-cache","type":"module"}',
            'factory.ts': [
                'export class Product { run() { return 1; } }',
                'export function make(): Product { return new Product(); }',
            ].join('\n'),
            'app.ts': [
                'import { make } from "./factory.js";',
                'const product = make();',
                'export const value = product.run();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('run')[0];
            const options = { targetDefinitions: [target], collectAccount: true };

            const first = index.findCallers('run', options);
            const populatedSize = index._returnTypeFlowCache.size;
            assert.ok(populatedSize > 0,
                'the first caller query should retain derived per-file flow');
            const cachedEntries = new Map(index._returnTypeFlowCache);

            const second = index.findCallers('run', options);
            assert.deepStrictEqual(second, first,
                'cached return flow must preserve the caller answer');
            assert.strictEqual(index._returnTypeFlowCache.size, populatedSize);
            for (const [file, entry] of cachedEntries) {
                assert.strictEqual(index._returnTypeFlowCache.get(file), entry,
                    'a later query should reuse the same immutable flow entry');
            }

            index.build(null, { forceRebuild: true, quiet: true, workers: 0 });
            assert.strictEqual(index._returnTypeFlowCache.size, 0,
                'a rebuild must clear flow derived from cross-file annotations');
        } finally {
            rm(dir);
        }
    });

    it('reuses name-level export ownership and invalidates it on rebuild', () => {
        const dir = tmp({
            'package.json': '{"name":"name-ownership-cache","type":"module"}',
            'impl.js': 'export function target() { return 1; }',
            'barrel.js': "export { target } from './impl.js';",
            'app.js': "import { target } from './barrel.js';\nexport const value = target();",
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('target')[0];
            const options = { targetDefinitions: [target], collectAccount: true };

            const first = index.findCallers('target', options);
            const populatedSize = index._nameBindingReachCache.size;
            assert.ok(populatedSize > 0,
                'the first ownership walk should populate the cross-operation cache');

            const second = index.findCallers('target', options);
            assert.deepStrictEqual(second, first,
                'cached ownership must preserve the caller answer');
            assert.strictEqual(index._nameBindingReachCache.size, populatedSize,
                'an identical query should reuse existing ownership verdicts');

            index.build(null, { forceRebuild: true, quiet: true, workers: 0 });
            assert.strictEqual(index._nameBindingReachCache.size, 0,
                'a rebuild must clear ownership verdicts derived from the old graph');
        } finally {
            rm(dir);
        }
    });

    it('reuses an exact ground set until the index is rebuilt', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function target() {}\ntarget();\n',
        });
        try {
            const index = idx(dir);
            let first;
            index._beginOp();
            try {
                first = computeGroundSet(index, 'target');
            } finally {
                index._endOp();
            }
            assert.ok(index._groundSetCache.has('target'));

            index._beginOp();
            try {
                const second = computeGroundSet(index, 'target');
                assert.strictEqual(second, first,
                    'later account projections should reuse the immutable ground set');
            } finally {
                index._endOp();
            }

            fs.appendFileSync(path.join(dir, 'lib.js'), 'target();\n');
            index.build(null, { forceRebuild: true, quiet: true, workers: 0 });
            assert.strictEqual(index._groundSetCache.size, 0,
                'a build changes the text universe and must clear ground results');

            index._beginOp();
            try {
                const rebuilt = computeGroundSet(index, 'target');
                assert.notStrictEqual(rebuilt, first);
                assert.strictEqual(rebuilt.total, first.total + 1);
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('reuses AST usage classifications by content hash across operations', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function target() {}\ntarget();\n',
        });
        try {
            const index = idx(dir);
            const filePath = path.join(dir, 'lib.js');
            let first;
            index._beginOp();
            try {
                first = index._getCachedUsages(filePath, 'target');
            } finally {
                index._endOp();
            }
            assert.ok(index._usageResultCache.size > 0);

            index._beginOp();
            try {
                const second = index._getCachedUsages(filePath, 'target');
                assert.strictEqual(second, first,
                    'unchanged content should reuse the immutable AST classification');
            } finally {
                index._endOp();
            }

            fs.appendFileSync(filePath, 'target();\n');
            index.build(null, { forceRebuild: true, quiet: true, workers: 0 });
            index._beginOp();
            try {
                const rebuilt = index._getCachedUsages(filePath, 'target');
                assert.notStrictEqual(rebuilt, first,
                    'a changed content hash must select a new classification');
                assert.strictEqual(rebuilt.length, first.length + 1);
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('persists bounded usage classifications without rewriting the index', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function target() {}\ntarget();\n',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const indexPath = getProjectCachePath(dir);
            const indexMtime = fs.statSync(indexPath).mtimeMs;
            const filePath = path.join(dir, 'lib.js');
            const first = index._getCachedUsages(filePath, 'target', {
                skipCallRecovery: true,
            });
            assert.strictEqual(index.usageCacheDirty, true);
            const usagePath = index.saveUsageCache();
            assert.ok(fs.existsSync(usagePath));
            assert.strictEqual(fs.statSync(indexPath).mtimeMs, indexMtime,
                'saving a read-only query result must not rewrite index.json');

            const { ProjectIndex } = require('../core/project');
            const loaded = new ProjectIndex(dir);
            assert.strictEqual(loaded.loadCache(), true);
            assert.ok(loaded._usageResultCache.size > 0);
            const restored = [...loaded._usageResultCache.values()][0].value;
            const second = loaded._getCachedUsages(filePath, 'target', {
                skipCallRecovery: true,
            });
            assert.strictEqual(second, restored,
                'the next process-shaped index should hit the restored entry');
            assert.deepStrictEqual(second, first);
            assert.strictEqual(loaded.usageCacheDirty, false,
                'a restored cache hit does not schedule another write');
        } finally { rm(dir); }
    });
});

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

    it('custom cache paths load their colocated call shards', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'export function helper() { return 1; }',
            'app.js': 'import { helper } from "./lib.js";\nexport function main() { helper(); }'
        });
        try {
            const cachePath = path.join(dir, 'custom-cache', 'index.json');
            const index1 = idx(dir);
            index1.findCallers('helper');
            index1.saveCache(cachePath);

            const { ProjectIndex } = require('../core/project');
            const index2 = new ProjectIndex(dir);
            assert.strictEqual(index2.loadCache(cachePath), true);
            assert.strictEqual(index2.callsCache.size, 0, 'custom cache remains lazy');
            assert.strictEqual(index2._callsCacheDir, path.dirname(cachePath));

            const calls = index2.getCachedCalls(path.join(dir, 'app.js'));
            assert.ok(calls?.some(c => c.name === 'helper'),
                'semantic call records must come from custom-cache/calls');
            assert.ok(index2.callsCache.size > 0);
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
            const cachePath = getProjectCachePath(dir);
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
            const callsDir = path.join(getProjectCacheDir(dir), 'calls');
            assert.ok(fs.existsSync(callsDir), 'calls dir should exist');
            assert.ok(fs.existsSync(path.join(callsDir, 'manifest.json')), 'manifest should exist');

            // Verify temp directory was cleaned up
            const tmpDir = path.join(getProjectCacheDir(dir), 'calls.tmp');
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
main();
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
            'index.js': 'function main() { return 1; }\nmodule.exports = { main };\nmain();',
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

            // Simulate drift with a real source file. Reliability mode must not
            // silently treat an unreadable synthetic index entry as empty.
            const extraFile = path.join(dir, 'extra.js');
            fs.writeFileSync(extraFile, 'function extra() { return 2; }\n');
            index2.files.set(extraFile, {
                language: 'javascript',
                relativePath: 'extra.js',
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

    it('warm computeReachability uses the persisted result without recomputing', () => {
        const N = 30;
        const files = { 'package.json': '{"name":"test"}' };
        let body = '';
        for (let i = 0; i < N; i++) {
            body += `function fn${i}() { return ${i === 0 ? 1 : `fn${i - 1}()`}; }\n`;
        }
        body += `module.exports = { fn0, fn${N - 1} };\nfn${N - 1}();\n`;
        files['index.js'] = body;
        const dir = tmp(files);
        try {
            const { ProjectIndex } = require('../core/project');
            const { computeReachability } = require('../core/entrypoints');

            const index1 = new ProjectIndex(dir);
            index1.build(null, { quiet: true });
            computeReachability(index1);
            index1.saveCache();

            const index2 = new ProjectIndex(dir);
            assert.ok(index2.loadCache(), 'cache should load');
            const restored = index2._reachableSymbols;
            const warmReachable = computeReachability(index2);
            assert.ok(warmReachable.size > 0, 'warm reachable should be non-empty');
            assert.strictEqual(warmReachable, restored,
                'cache hit should return the persisted Set instead of running the BFS');
            assert.ok(!index2.reachabilityDirty,
                'reading persisted reachability should not mark it for another cache write');
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
main();
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
main();
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
                getProjectCachePath(dir), 'utf-8'));
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
main();
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
                getProjectCachePath(dir), 'utf-8'));
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
                getProjectCachePath(dir), 'utf-8'));
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
                const cachePath = getProjectCachePath(dir);
                const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
                assert.strictEqual(data.version, CACHE_FORMAT_VERSION, 'cache version should be intact');
            }

            const tmpFile = `${getProjectCachePath(dir)}.tmp`;
            assert.ok(!fs.existsSync(tmpFile), '.tmp file should be cleaned up');
        } finally {
            rm(dir);
        }
    });
});

// ── JAVA-2: entrypoints includes test entries by default ──────────────────────

describe('perf: JAVA-2 entrypoints test-entry visibility', () => {
    it('shows JUnit @Test methods with --include-tests for Java', () => {
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
            const { ok, result } = execute(index, 'entrypoints', {
                type: 'test', includeTests: true,
            });
            assert.strictEqual(ok, true);
            const testEntries = (result || []).filter(e =>
                e.framework === 'junit' && e.name === 'shouldRun');
            assert.ok(testEntries.length > 0,
                '@Test method should appear with --include-tests');

            const { ok: ok2, result: result2 } = execute(index, 'entrypoints', {
                type: 'test',
            });
            assert.strictEqual(ok2, true);
            const stillThere = (result2 || []).filter(e =>
                e.framework === 'junit' && e.name === 'shouldRun');
            assert.strictEqual(stillThere.length, 0,
                'test-file @Test methods are hidden by default');
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
            // def line 1, call line 4, and the { run } export shorthand on
            // line 5 as a reference (fix #241 — value-position shorthand
            // properties ARE usages of the symbol). NOT line 2 ($run is a
            // longer identifier; the comment mention is a non-identifier
            // node), NOT line 3 (string content).
            const lines = usages.map(u => u.line).sort((a, b) => a - b);
            assert.deepStrictEqual(lines, [1, 4, 5], JSON.stringify(usages));
            assert.strictEqual(usages.find(u => u.line === 5).usageType, 'reference',
                'shorthand export property is a reference');
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
        // ownerGenerics/
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
            'const HANDLERS = { run: () => typedFn("x", 1) };',
            'export function evidence(b: BaseT) { const c = new BaseT(); b.load("a"); c.load("c"); }',
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
            'pub struct Wrapper(Greeter);',
            'impl std::ops::Deref for Wrapper {',
            '    type Target = Greeter;',
            '    fn deref(&self) -> &Greeter { &self.0 }',
            '}',
            'impl Greet for Greeter {',
            '    fn hello(&self) -> String { String::from("hi") }',
            '}',
            'impl<I: ?Sized> Greet for I {',
            '    fn hello(&self) -> String { String::from("blanket") }',
            '}',
            'pub fn lit() -> usize { "abc".parse().unwrap() }',
            'pub fn chain(g: Greeter) -> usize { g.hello().len() }',
        ].join('\n');
        // fix #220 call-field shapes: Go chained receivers
        // (receiverCall/receiverCallIsMethod/receiverCallReceiver),
        // var-decl/new(T) receiver types, tuple-rest names.
        spec['rich3.go'] = [
            'package rich3',
            'import "bytes"',
            'type Cmd struct{}',
            'func (c *Cmd) Flags() *bytes.Buffer { return nil }',
            'func use(c *Cmd) string {',
            '\tvar sb bytes.Buffer',
            '\tbuf := new(bytes.Buffer)',
            '\tv, err := pair()',
            '\t_, _ = v, err',
            '\treturn c.Flags().String() + sb.String() + buf.String()',
            '}',
            'func pair() (int, error) { return 0, nil }',
        ].join('\n');
        // defaultLike import bindings (CJS callable default), named function
        // expressions (bodyScopedName — bindings-table exclusion must match
        // across build paths), and Java nested types (enclosingType): shapes
        // the guard could not previously generate (the #219 fixture lesson).
        spec['rich4.js'] = [
            'const factory = require("./rich5");',
            'test("boot", function bootPhase() { return factory(); });',
            // one-hop member assignment carries assignedReceiver (fix #286)
            'console.warn = () => {};',
            'module.exports = { go: () => factory() };',
        ].join('\n');
        spec['rich5.js'] = [
            'function createThing() { return 1; }',
            'module.exports = createThing;',
        ].join('\n');
        spec['Rich6.java'] = [
            'public class Rich6 {',
            '    public static class Inner {',
            '        int size() { return 1; }',
            '    }',
            '    int use(Object o) { return ((Inner) o).size(); }',
            '}',
        ].join('\n');
        // Reflection inventory (fix #363): name patterns and receivers are
        // extracted inside the worker's parse.
        spec['rich7.py'] = [
            'class Backend:',
            '    def _get_user_perms(self, u):',
            '        return 1',
            '    def load(self, src, u):',
            '        name = f"_get_{src}_perms"',
            '        return getattr(self, name)(u)',
        ].join('\n');
        const dir = tmp(spec);
        try {
            const seq = new ProjectIndex(dir);
            seq.build(null, { quiet: true, workers: 0 });
            const par = new ProjectIndex(dir);
            par.build(null, { quiet: true, workers: 2 });
            const sourceKinds = new Set(par.getCachedCalls(path.join(dir, 'rich0.ts'))
                .filter(call => call.name === 'load').map(call => call.receiverTypeSource));
            assert.deepStrictEqual(sourceKinds, new Set(['annotation', 'constructor']),
                'the parity fixture must actually produce both receiver origins');
            assert.ok([...par.files.values()].some(fe => fe.reflectionSites?.[0]?.patterns?.[0] === '_get_*_perms'),
                'the parity fixture must actually produce a reflection pattern');
            assert.strictEqual(indexSnapshot(par), indexSnapshot(seq),
                'parallel and sequential builds must produce identical indexes');
        } finally { rm(dir); }
    });

});

describe('fix #340: stats --hot bounds candidates per definition, not per name', () => {
    it('retains distinct typed receiver calls sharing one source line', () => {
        const dir = tmp({ 'lib.ts': [
            'class A { run() {} }',
            'class B { run() {} }',
            'function calls(a: A, b: B) { a.run(); b.run(); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            const hot = index.getStats({ hot: true, top: 20 }).hot;
            assert.deepEqual(hot.items.map(item => [item.name, item.callCount]), [['A.run', 1], ['B.run', 1]]);
        } finally { rm(dir); }
    });
    it('refines only the definitions whose receiver-typed records can confirm them', () => {
        const dir = tmp({
            'go.mod': 'module example.com/hot\n\ngo 1.21\n',
            'pkg/a.go': [
                'package pkg',
                '',
                'type Svc struct{}',
                '',
                'func (s *Svc) Close() error { return nil }',
                '',
                'type Other struct{}',
                '',
                'func (o *Other) Close() error { return nil }',
                '',
                'func Run() {}',
            ].join('\n'),
            'pkg/b.go': [
                'package pkg',
                '',
                'func useSvc() {',
                '\ts := &Svc{}',
                '\ts.Close()',
                '\ts.Close()',
                '\ts.Close()',
                '\tRun()',
                '}',
                '',
                'func useOther() {',
                '\to := &Other{}',
                '\to.Close()',
                '}',
            ].join('\n'),
            'pkg/c_test.go': [
                'package pkg',
                '',
                'import "testing"',
                '',
                'func TestX(t *testing.T) {',
                '\tt.Fatalf("x")',
                '\tt.Fatalf("y")',
                '\tt.Fatalf("z")',
                '\tRun()',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const stats = index.getStats({ hot: true, top: 1 });
            assert.equal(stats.hot.items[0].name, 'Svc.Close', JSON.stringify(stats.hot));
            assert.equal(stats.hot.items[0].callCount, 3);
            // Per-name bounds gave Other.Close the same 4-record ceiling as
            // Svc.Close, so it had to be refined before the early stop could
            // fire; the per-definition bound (typed `s.Close()` records belong
            // to Svc) lets the loop stop after the first exact refinement.
            assert.equal(stats.hot.refined, 1, JSON.stringify(stats.hot));
            // External receivers (`t.Fatalf` on testing.T) never enter a bound.
            assert.ok(!stats.hot.items.some(i => i.name.endsWith('Fatalf')));
        } finally { rm(dir); }
    });
});

describe('fix #340: orientation refines HOT within a disclosed budget', () => {
    it('marks the ranking approximate and points at the exact command when the budget binds', () => {
        const dir = tmp({
            'package.json': '{"name":"hotbudget"}',
            'lib.js': [
                'function alpha() { return 1; }',
                'function beta() { return 2; }',
                'function gamma() { return 3; }',
                'module.exports = { alpha, beta, gamma };',
            ].join('\n'),
            'app.js': [
                'const { alpha, beta, gamma } = require("./lib");',
                'function run() { alpha(); alpha(); beta(); gamma(); return alpha() + beta(); }',
                'module.exports = { run };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { orient } = require('../core/reporting');
            const exact = orient(index, {});
            assert.equal(exact.hot.budgetExhausted, undefined);
            assert.equal(exact.hot.items[0].name, 'alpha');
            const bounded = orient(index, { hotRefineBudget: 1 });
            assert.equal(bounded.hot.budgetExhausted, true);
            assert.equal(bounded.hot.maxRefine, 1);
            assert.equal(bounded.hot.refined, 1);
            const text = require('../core/output').formatOrient(bounded);
            assert.match(text, /refinement budget 1 reached — ranking approximate, exact list: ucn repo --sections=stats --hot/);
            const exactText = require('../core/output').formatOrient(exact);
            assert.ok(!/refinement budget/.test(exactText), 'an exact orientation carries no budget note');
        } finally { rm(dir); }
    });
});

describe('fix #365: HOT ranking and caller scans stay exact while doing less work', () => {
    it('a production ranking bounds and scans production call sites only', () => {
        const dir = tmp({
            'package.json': '{"name":"hotprod"}',
            'lib.js': [
                'function alpha() { return 1; }',
                'function beta() { return 2; }',
                'module.exports = { alpha, beta };',
            ].join('\n'),
            'app.js': [
                'const { alpha, beta } = require("./lib");',
                'function run() {',
                '  beta();',
                '  beta();',
                '  return alpha();',
                '}',
                'module.exports = { run };',
            ].join('\n'),
            'test/lib.test.js': [
                'const { alpha } = require("../lib");',
                'function check() {',
                '  alpha();',
                '  alpha();',
                '  alpha();',
                '  alpha();',
                '  alpha();',
                '}',
                'module.exports = { check };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { orient } = require('../core/reporting');
            // alpha's five test calls can never count toward a production
            // ranking, so its ceiling is 1 and one exact refinement (beta, 2)
            // settles the top item without touching the budget.
            const result = orient(index, { top: 1, hotRefineBudget: 1 });
            assert.equal(result.hot.budgetExhausted, undefined, JSON.stringify(result.hot));
            assert.equal(result.hot.refined, 1);
            assert.equal(result.hot.items[0].name, 'beta');
            assert.equal(result.hot.items[0].callCount, 2);
            // The all-callers ranking still counts the tests.
            const stats = index.getStats({ hot: true, top: 1 });
            assert.equal(stats.hot.items[0].name, 'alpha');
            assert.equal(stats.hot.items[0].callCount, 6);
        } finally { rm(dir); }
    });

    it('findCallers candidateFiles keeps every retained site identical', () => {
        const dir = tmp({
            'package.json': '{"name":"candfiles"}',
            'lib.js': 'function helper(x) { return x; }\nmodule.exports = { helper };\n',
            'a.js': 'const { helper } = require("./lib");\nfunction a() { return helper(1) + helper(2); }\nmodule.exports = { a };\n',
            'b.js': 'const { helper } = require("./lib");\nfunction b() { return helper(3); }\nmodule.exports = { b };\n',
        });
        try {
            const index = idx(dir);
            const { findCallers } = require('../core/callers');
            const def = index.symbols.get('helper')[0];
            const strip = callers => JSON.stringify(callers.map(c => ({ ...c, provenance: undefined })));
            const all = findCallers(index, 'helper', { targetDefinitions: [def], collectAccount: true });
            const aFile = path.join(dir, 'a.js');
            const onlyA = findCallers(index, 'helper', {
                targetDefinitions: [def], collectAccount: true, candidateFiles: new Set([aFile]),
            });
            assert.equal(all.length, 3);
            assert.equal(strip(onlyA), strip(all.filter(c => c.file === aFile)));
        } finally { rm(dir); }
    });

    it('computed dispatch sites come from index expressions in document order', () => {
        const { computedDispatchSites } = require('../core/ast-analysis');
        const js = [
            'function run(handlers, key, xs) {',
            '  handlers[key](1);',
            '  const h = handlers[key];',
            '  h();',
            '  const v = xs[0];',
            '  return table[name]();',
            '}',
        ].join('\n');
        assert.deepEqual(computedDispatchSites(js, 'javascript').map(s => [s.line, s.receiver]),
            [[2, 'handlers'], [6, 'table'], [3, 'handlers']]);
        const py = 'def run(ops, name):\n    ops[name]()\n    f = ops[name]\n    f()\n    return ops[0]()\n';
        assert.deepEqual(computedDispatchSites(py, 'python').map(s => [s.line, s.receiver]),
            [[2, 'ops'], [3, 'ops']]);
        const c = 'void run(void (*table[])(int), int i) {\n  table[i](i);\n}\n';
        assert.deepEqual(computedDispatchSites(c, 'c').map(s => [s.line, s.receiver]), [[2, 'table']]);
    });

    it('a single file loads only its calls shard, and a save still writes every shard', () => {
        const dir = tmp({
            'package.json': '{"name":"shards"}',
            'a/one.js': 'function one() { two(); }\nfunction two() {}\nmodule.exports = { one, two };\n',
            'b/three.js': 'const { one } = require("../a/one");\nfunction three() { one(); }\nmodule.exports = { three };\n',
        });
        try {
            const { ProjectIndex } = require('../core/project');
            const built = new ProjectIndex(dir);
            built.build(null, { quiet: true });
            built.saveCache();

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            const one = path.join(dir, 'a', 'one.js');
            const three = path.join(dir, 'b', 'three.js');
            assert.ok(loaded.getCachedCalls(one).some(call => call.name === 'two'));
            assert.ok(loaded.callsCache.has(one));
            assert.ok(!loaded.callsCache.has(three), 'other directories stay unloaded');
            loaded.saveCache();

            const reloaded = new ProjectIndex(dir);
            assert.ok(reloaded.loadCache());
            require('../core/cache').ensureCallsCacheLoaded(reloaded);
            assert.ok(reloaded.callsCache.get(three).calls.some(call => call.name === 'one'),
                'the save completed the partially loaded cache first');
        } finally { rm(dir); }
    });

    it('complexity measures the callable at the range without walking the rest of the file', () => {
        const { computeAstComplexity } = require('../core/ast-analysis');
        const code = [
            'function first(a) { if (a) { return 1; } return 0; }',
            'function second(a, b) {',
            '  if (a) { for (const x of b) { if (x) return x; } }',
            '  return a ? 1 : 2;',
            '}',
        ].join('\n');
        const result = computeAstComplexity(code, 'javascript', { startLine: 2, endLine: 5 });
        assert.equal(result.branches, 4);
        assert.equal(result.maxDepth, 3);
    });
});

describe('fix #371: audit-async resolves before it reads, and only the sites it needs', () => {
    const files = {
        'Cargo.toml': '[package]\nname = "fx371aa"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': 'pub mod net;\npub mod busy;\npub mod lost;\n',
        'src/net.rs': 'pub struct Conn;\nimpl Conn {\n    pub async fn send(&self) -> u8 { 1 }\n    pub fn close(&self) {}\n}\npub async fn fetch() -> u8 { 2 }\npub fn helper(x: u8) -> u8 { x }\n',
        'src/busy.rs': 'use crate::net::{fetch, helper, Conn};\npub async fn run(c: &Conn) -> u8 {\n    let a = fetch().await;\n    let b = helper(fetch().await);\n    c.send().await;\n    c.close();\n    a + b\n}\n',
        'src/lost.rs': 'use crate::net::{fetch, Conn};\npub async fn run(c: &Conn) {\n    fetch();\n    c.close();\n    let _ = c.send();\n}\n',
    };

    it('Rust call records say how a value is consumed where it is produced', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const calls = index.getCachedCalls(path.join(dir, 'src/busy.rs'));
            const fetches = calls.filter(c => c.name === 'fetch').map(c => c.valueConsumed);
            assert.deepStrictEqual(fetches, ['awaited', 'awaited']);
            assert.strictEqual(calls.find(c => c.name === 'helper').valueConsumed, undefined);
            const src = 'pub fn f(v: Vec<u8>) -> usize { make().len() + g(h()) }\nfn make() -> Vec<u8> { vec![] }\nfn g(x: u8) -> usize { x as usize }\nfn h() -> u8 { 1 }\n';
            fs.writeFileSync(path.join(dir, 'src/lost.rs'), src);
            const index2 = idx(dir);
            const records = index2.getCachedCalls(path.join(dir, 'src/lost.rs'));
            assert.strictEqual(records.find(c => c.name === 'make').consumingMethod, 'len');
            assert.strictEqual(records.find(c => c.name === 'h').valueConsumed, 'argument');
        } finally { rm(dir); }
    });

    it('findCallees siteStarts returns exactly the full run\'s edges at those sites', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const run = (index.symbols.get('run') || []).find(d => d.relativePath === 'src/busy.rs');
            const full = index.findCallees(run, { collectAccount: true });
            const calls = index.getCachedCalls(path.join(dir, 'src/busy.rs'));
            for (const call of calls.filter(c => c.line >= run.startLine && c.line <= run.endLine)) {
                const restricted = index.findCallees(run, { collectAccount: true, siteStarts: new Set([call.callStart]) });
                const at = list => list.filter(c => (c.siteProvenance || []).some(s => s.start === call.callStart))
                    .map(c => `${c.relativePath}:${c.startLine}:${c.name}`).sort();
                assert.deepStrictEqual(at(restricted), at(full), `site ${call.name}@${call.line}`);
            }
        } finally { rm(dir); }
    });

    it('a file whose candidates are all consumed or resolve to no future is never read', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const read = [];
            const original = index._readFile.bind(index);
            index._readFile = file => { read.push(path.relative(dir, file)); return original(file); };
            const result = index.auditAsync();
            assert.ok(!read.includes('src/busy.rs'), `busy.rs awaits everything: ${JSON.stringify(read)}`);
            assert.ok(read.includes('src/lost.rs'), JSON.stringify(read));
            const lines = result.issues.map(i => `${i.file}:${i.line}:${i.reason}`).sort();
            assert.deepStrictEqual(lines, ['src/lost.rs:3:future-discarded', 'src/lost.rs:5:future-dropped']);
        } finally { rm(dir); }
    });
});

describe('fix #372: build-time Cargo manifests, lazy return flow, record-level audit facts, bucketed shards', () => {
    const { ProjectIndex } = require('../core/project');
    const workspace = () => ({
        'Cargo.toml': '[workspace]\nmembers = ["alpha", "beta"]\n',
        'alpha/Cargo.toml': '[package]\nname = "alpha"\nversion = "0.1.0"\n',
        'alpha/src/lib.rs': 'pub fn thing() -> u8 { 1 }\n',
        'beta/Cargo.toml': '[package]\nname = "beta"\nversion = "0.1.0"\n',
        'beta/src/lib.rs': 'use alpha::thing;\npub fn run() -> u8 { thing() }\n',
    });
    const alphaEdge = index => [...(index.importGraph.get(path.join(index.root, 'beta/src/lib.rs')) || [])]
        .some(file => file.endsWith(path.join('alpha', 'src', 'lib.rs')));

    it('the workspace crate registry is persisted and seeded: a loaded index resolves crates without walking the tree', () => {
        const dir = tmp(workspace());
        try {
            const built = new ProjectIndex(dir);
            built.build(null, { quiet: true });
            assert.deepStrictEqual(built.cargoManifests.map(m => m.dir).sort(), ['', 'alpha', 'beta']);
            built.saveCache();
            const imports = require('../core/imports');
            imports.resetCargoCaches(built.root);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            const readdir = fs.readdirSync;
            fs.readdirSync = function (target, ...rest) {
                if (path.resolve(String(target)) === path.resolve(loaded.root)) throw new Error('query-time tree walk');
                return readdir.call(this, target, ...rest);
            };
            try {
                const resolved = imports.resolveRustImport('alpha::thing', path.join(loaded.root, 'beta/src/lib.rs'), loaded.root);
                assert.ok(resolved && resolved.endsWith(path.join('alpha', 'src', 'lib.rs')), String(resolved));
            } finally { fs.readdirSync = readdir; }
        } finally { rm(dir); }
    });

    it('a changed, removed or added Cargo.toml makes the cache stale and an incremental rebuild re-resolves imports', () => {
        const dir = tmp(workspace());
        try {
            const built = new ProjectIndex(dir);
            built.build(null, { quiet: true });
            built.saveCache();
            assert.ok(alphaEdge(built));
            // Rename the alpha package: `use alpha::..` no longer names a workspace crate.
            const manifest = path.join(dir, 'alpha/Cargo.toml');
            fs.writeFileSync(manifest, '[package]\nname = "alpha_renamed"\nversion = "0.1.0"\n');
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(manifest, future, future);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.strictEqual(loaded.isCacheStale(), true);
            loaded.build(null, { quiet: true, forceRebuild: true });
            assert.ok(!alphaEdge(loaded), 'the import graph follows the renamed manifest');
            loaded.saveCache();
            // A new manifest (discovery sees it) is also staleness.
            fs.mkdirSync(path.join(dir, 'gamma'));
            fs.writeFileSync(path.join(dir, 'gamma/Cargo.toml'), '[package]\nname = "gamma"\nversion = "0.1.0"\n');
            const again = new ProjectIndex(dir);
            assert.ok(again.loadCache());
            again._lastFreshAt = 0;
            assert.strictEqual(again.isCacheStale(), true);
        } finally { rm(dir); }
    });

    it('Rust call records say whether a value can be lost, following stored locals; open-call shapes keep the reachability fields', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "fx372"\nversion = "0.1.0"\n',
            'src/lib.rs': [
                'pub async fn fetch() -> u8 { 1 }',
                'pub fn make() -> Vec<u8> { vec![] }',
                'pub async fn run() -> u8 {',
                '    let a = fetch();',
                '    let b = make();',
                '    let n = b.len();',
                '    fetch();',
                '    let c = fetch();',
                '    a.await + n as u8',
                '}',
                'pub fn wrap() -> impl std::future::Future<Output = u8> { fetch() }',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const file = path.join(dir, 'src/lib.rs');
            const calls = index.getCachedCalls(file);
            const at = line => calls.find(call => call.line === line && ['fetch', 'make'].includes(call.name));
            assert.strictEqual(at(4).valueConsumed, 'stored');
            assert.strictEqual(at(5).consumingMethod, 'len');
            assert.strictEqual(at(7).valueConsumed, undefined, 'a discarded value stays open');
            assert.strictEqual(at(8).valueConsumed, undefined, 'a local never read stays open');
            assert.strictEqual(at(11).valueConsumed, 'flow');
            const shapes = index.files.get(file).openCalls;
            assert.ok(shapes.includes('fetch') && shapes.includes('make~len'), JSON.stringify(shapes));
            const { parseOpenCallShape, openCallShape } = require('../languages/rust-value-flow');
            for (const record of [{ name: 'f', isMethod: true, receiverType: 'T', consumingMethod: 'm' },
                { name: 'g', isMethod: true, isPathCall: true, receiver: 'std::fs::File' },
                { name: 'h', isMethod: true, isPathCall: true, receiver: 'crate::a::B' }]) {
                const parsed = parseOpenCallShape(openCallShape(record));
                assert.strictEqual(parsed.name, record.name);
                assert.strictEqual(openCallShape(parsed), openCallShape(record));
            }
            const issues = index.auditAsync({}).issues.map(issue => `${issue.line}:${issue.reason}`).sort();
            assert.deepStrictEqual(issues, ['7:future-discarded', '8:future-unused']);
        } finally { rm(dir); }
    });

    it('return-type flow fills only the looked-up variable\'s records', () => {
        const dir = tmp({
            'src/a.py': 'class A:\n    def m(self):\n        return 1\n\ndef make() -> A:\n    return A()\n\ndef use():\n    x = make()\n    y = make()\n    z = make()\n    x.m()\n',
        });
        try {
            const index = idx(dir);
            const { _buildReturnTypeFlowMap } = require('../core/callers');
            const file = path.join(dir, 'src/a.py');
            index._opReturnTypeFlowCache = null;
            index._returnTypeFlowCache = null;
            const calls = index.getCachedCalls(file);
            const map = _buildReturnTypeFlowMap(index, file, calls);
            const scope = calls.find(call => call.assignedTo === 'x').enclosingFunction.startLine;
            const entries = map.get(`${scope}:x`);
            assert.ok(entries && entries[0].type === 'A', JSON.stringify(entries));
            assert.strictEqual(map._processed.size, 1, 'only the record assigning x was typed');
        } finally { rm(dir); }
    });

    it('large directories split their calls shard into path buckets; one file loads one bucket', () => {
        const files = { 'package.json': '{"name":"buckets"}' };
        const body = Array.from({ length: 400 }, (_, i) => `  helper${i % 7}(${i});`).join('\n');
        for (let i = 0; i < 12; i++) {
            files[`big/f${i}.js`] = `function helper${i % 7}(x) { return x; }\nfunction run${i}() {\n${body}\n}\nmodule.exports = { run${i} };\n`;
        }
        const dir = tmp(files);
        try {
            const built = new ProjectIndex(dir);
            built.build(null, { quiet: true });
            built.saveCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            const shard = loaded._callsManifest.get('big');
            assert.ok(shard.buckets > 1, `buckets: ${shard.buckets}`);
            const one = path.join(dir, 'big/f0.js');
            assert.ok(loaded.getCachedCalls(one).some(call => call.name === 'helper0'));
            assert.strictEqual(shard.loadedBuckets.size, 1);
            assert.ok(loaded.callsCache.size < 12, `loaded ${loaded.callsCache.size} files`);
            require('../core/cache').ensureCallsCacheLoaded(loaded);
            assert.strictEqual(loaded.callsCache.size, 12);
            for (const [file, entry] of built.callsCache) {
                assert.deepStrictEqual(loaded.callsCache.get(file).calls, entry.calls);
            }
        } finally { rm(dir); }
    });
});

describe('fix #375: build parallelism, compact calls shards and one git listing', () => {
    const { ProjectIndex } = require('../core/project');
    const { indexSnapshot } = require('./helpers');

    it('sizes the automatic worker pool by the source bytes a build must parse', () => {
        const files = { 'package.json': '{"name":"bytes"}' };
        const body = Array.from({ length: 900 }, (_, i) => `export function f${i}(x) { return helper(x) + ${i}; }`).join('\n');
        // A comment block pads each file (cheap to parse, counted as bytes).
        const pad = `/*\n${'x'.repeat(78)}\n`.repeat(4300) + '*/\n';
        for (let i = 0; i < 6; i++) files[`src/m${i}.js`] = `import { helper } from './h.js';\n${body}\n${pad}`;
        files['src/h.js'] = 'export function helper(x) { return x; }\n';
        const dir = tmp(files);
        try {
            // ~2.3MB in 7 files: parallel although far below 150 files (fix
            // #388: from 2MB of parse work, 1MB per worker).
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            assert.strictEqual(sequential.lastBuildWorkerCount, 1);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            // An incremental rebuild parses only what changed: one small file
            // is not worth a worker pool.
            fs.appendFileSync(path.join(dir, 'src/h.js'), 'export function extra() { return 0; }\n');
            parallel.build(null, { quiet: true, forceRebuild: true });
            assert.strictEqual(parallel.lastBuildWorkerCount, 1);
            assert.ok(parallel.symbols.has('extra'));
        } finally { rm(dir); }
    });

    it('stores repeated record objects once per file and restores every record exactly', () => {
        const dir = tmp({
            'package.json': '{"name":"tables"}',
            'lib.py': [
                'class Store:',
                '    def get(self): return 1',
                '',
                'def run(store: Store):',
                '    store.get()',
                '    store.get()',
                '    helper()',
                '',
                'def helper(): pass',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            index.findCallers('get');
            const file = path.join(dir, 'lib.py');
            const before = JSON.stringify(index.callsCache.get(file).calls);
            index.saveCache();
            const callsDir = path.join(getProjectCacheDir(dir), 'calls');
            const shard = fs.readdirSync(callsDir).filter(name => name !== 'manifest.json')
                .map(name => JSON.parse(fs.readFileSync(path.join(callsDir, name), 'utf8')))
                .flat().find(([relPath]) => relPath === 'lib.py')[1];
            // One enclosing-function object for the three calls in run(), one
            // receiver-evidence object for the two typed calls.
            assert.deepStrictEqual(shard.fx.map(f => f.name), ['run']);
            assert.deepStrictEqual(shard.calls.map(call => call.enclosingFunction), [0, 0, 0]);
            assert.strictEqual(shard.rx.length, 1);
            assert.deepStrictEqual(shard.calls.map(call => call.receiverTypeEvidence), [0, 0, undefined]);
            // Saving never changes the in-memory records.
            assert.strictEqual(JSON.stringify(index.callsCache.get(file).calls), before);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            loaded.loadCallsCache();
            assert.strictEqual(JSON.stringify(loaded.callsCache.get(file).calls), before);
        } finally { rm(dir); }
    });

    it('one git listing answers both discovery questions exactly as two did', () => {
        const { execFileSync } = require('child_process');
        const { parseGitignore, gitTrackedPaths, gitListing } = require('../core/discovery');
        const dir = tmp({
            '.gitignore': 'build/\n*.log\n!keep.log\n',
            'src/.gitignore': 'gen/\n',
            'src/a.py': 'def a(): pass\n',
            'src/gen/b.py': 'def b(): pass\n',
            'docs/.gitignore': '*.tmp\n',
            'build/.gitignore': 'x\n',
            'notes.log': 'x\n',
            'keep.log': 'x\n',
        });
        try {
            try {
                execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
                execFileSync('git', ['add', '.gitignore', 'src/.gitignore', 'src/a.py'], { cwd: dir, stdio: 'ignore' });
            } catch {
                return; // git unavailable
            }
            const listing = gitListing(dir);
            assert.ok(listing);
            assert.strictEqual(parseGitignore(dir, listing).fingerprint(), parseGitignore(dir).fingerprint());
            const tracked = gitTrackedPaths(dir, listing);
            const separate = gitTrackedPaths(dir);
            assert.deepStrictEqual([...tracked.files].sort(), [...separate.files].sort());
            assert.deepStrictEqual([...tracked.directories].sort(), [...separate.directories].sort());
            // The untracked docs/.gitignore counts; the one under ignored build/ does not.
            assert.ok(parseGitignore(dir, listing).isIgnored('docs/a.tmp'));
            assert.ok(!parseGitignore(dir, listing).fingerprint().includes('@build'));
            assert.strictEqual(gitListing(path.join(dir, '..', 'no-such-dir')), null);
        } finally { rm(dir); }
    });

    it('show loads neither dead-code analysis nor entry-point detection', () => {
        const { execFileSync } = require('child_process');
        const dir = tmp({
            'package.json': '{"name":"lazy"}',
            'a.js': 'function helper() { return 1; }\nfunction main() { return helper(); }\nmodule.exports = { main };\n',
        });
        try {
            const script = [
                `const { ProjectIndex } = require(${JSON.stringify(path.join(__dirname, '../core/project'))});`,
                `const { execute } = require(${JSON.stringify(path.join(__dirname, '../core/execute'))});`,
                `const index = new ProjectIndex(${JSON.stringify(dir)});`,
                'index.build(null, { quiet: true });',
                'if (!execute(index, "show", { name: "helper" }).ok) process.exit(2);',
                'console.log(Object.keys(require.cache).filter(k => /core[\\\\/](deadcode|entrypoints)\\.js$/.test(k)).length);',
            ].join('\n');
            const loaded = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
            assert.strictEqual(loaded, '0');
        } finally { rm(dir); }
    });
});

describe('fix #382: exact HOT refinement at scale', () => {
    it('per-operation memos never change a pinned caller answer', () => {
        const { findCallers } = require('../core/callers');
        const fixtures = {
            go: {
                'go.mod': 'module example.com/m\n\ngo 1.21\n',
                'a/a.go': [
                    'package a',
                    'type Namer interface { Name() string }',
                    'type Base struct{}',
                    'func (b *Base) Name() string { return "base" }',
                    'type Pod struct { Base; Spec Spec }',
                    'type Spec struct{}',
                    'func (s Spec) Name() string { return "spec" }',
                    'type Node struct { Spec Spec }',
                    'func (n *Node) Name() string { return "node" }',
                ].join('\n'),
                'b/b.go': [
                    'package b',
                    'import "example.com/m/a"',
                    'func Use(p *a.Pod, n *a.Node, x a.Namer) string {',
                    '    return p.Name() + p.Spec.Name() + n.Name() + n.Spec.Name() + x.Name()',
                    '}',
                ].join('\n'),
            },
            java: {
                'pom.xml': '<project/>',
                'src/main/java/p/Shape.java': 'package p;\npublic interface Shape { double area(); }\n',
                'src/main/java/p/Square.java': 'package p;\npublic class Square implements Shape { public double area() { return 1; } }\n',
                'src/main/java/p/Circle.java': 'package p;\npublic class Circle extends Square { public double area() { return 2; } }\n',
                'src/main/java/p/Use.java': 'package p;\npublic class Use {\n  double f(Shape s, Square q, Circle c) { return s.area() + q.area() + c.area(); }\n}\n',
            },
            python: {
                'pyproject.toml': '[project]\nname="p"\n',
                'm.py': 'class A:\n    def run(self):\n        return 1\n\n\nclass B(A):\n    def run(self):\n        return 2\n',
                'u.py': 'from m import A, B\n\n\ndef go(a: A, b: B):\n    return a.run() + b.run() + B().run()\n',
            },
        };
        const names = { go: 'Name', java: 'area', python: 'run' };
        for (const [language, files] of Object.entries(fixtures)) {
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const name = names[language];
                const definitions = (index.symbols.get(name) || []).filter(d => d.type !== 'field');
                assert.ok(definitions.length >= 2, `${language}: fixture defines several ${name}`);
                const answer = (definition) => findCallers(index, name, {
                    targetDefinitions: [definition], collectAccount: true, includeTests: true,
                }).map(c => `${c.relativePath}:${c.line}:${c.tier}:${c.reason || ''}`).sort();
                const alone = definitions.map(answer);
                index._beginOp();
                let shared;
                try {
                    shared = definitions.map(answer);
                } finally { index._endOp(); }
                assert.deepStrictEqual(shared, alone, `${language}: memoized answers equal fresh ones`);
            } finally { rm(dir); }
        }
    });

    it('a work budget bounds refinement, completes in fair-share order, and is disclosed', () => {
        const dir = tmp({
            'package.json': '{"name":"hotbudget"}',
            'lib.js': [
                'class A { run() { return 1; } }',
                'class B { run() { return 2; } }',
                'class C { run() { return 3; } }',
                'class D { run() { return 4; } }',
                'function hot() { return 5; }',
                'module.exports = { A, B, C, D, hot };',
            ].join('\n'),
            'app.js': [
                'const { hot } = require("./lib");',
                'function go(x) {',
                '  x.run();', '  x.run();', '  x.run();', '  x.run();', '  x.run();', '  x.run();',
                '  hot();', '  hot();',
                '  return hot();',
                '}',
                'module.exports = { go };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const exact = index.getStats({ hot: true, top: 1 });
            assert.equal(exact.hot.budgetExhausted, undefined);
            assert.deepStrictEqual(exact.hot.items.map(i => [i.name, i.callCount]), [['hot', 3]]);
            // Six `run` records per refinement: the ceiling walk (ceiling 6
            // per `run` definition, 3 for `hot`) spends the budget on one of
            // the four `run` definitions; the completion walk (fair share:
            // 6/4 < 3/1) refines `hot` next. Three `run` ceilings of 6 stay
            // unrefined above the count 3, so the answer is not proven.
            const bounded = index.getStats({ hot: true, top: 1, workBudget: 6 });
            assert.equal(bounded.hot.budgetExhausted, true);
            assert.equal(bounded.hot.workBudget, 6);
            assert.equal(bounded.hot.work, 9);
            assert.equal(bounded.hot.refined, 2);
            assert.deepStrictEqual(bounded.hot.items.map(i => [i.name, i.callCount]), [['hot', 3]]);
            // Deterministic: the same work unit gives the same answer.
            assert.deepStrictEqual(index.getStats({ hot: true, top: 1, workBudget: 6 }).hot, bounded.hot);
            const { orient } = require('../core/reporting');
            const text = require('../core/output').formatOrient(orient(index, { top: 1, hotWorkBudget: 6 }));
            assert.match(text, /refinement budget reached after 2 of \d+ candidates \(9 call records\) — ranking approximate/);
            const statsText = require('../core/output').formatStats(bounded);
            assert.match(statsText, /Refinement budget reached after 2 of \d+ candidates \(9 call records\): ranking approximate, counts exact/);
        } finally { rm(dir); }
    });
});

describe('fix #385: cold-build CPU without answer changes', () => {
    const { getParser, safeParse, PARSE_OPTIONS } = require('../languages');

    it('node parent, offset and field accessors return the native answers', () => {
        const parser = getParser('cpp');
        const code = 'namespace n { struct S { int f(int x) { return g(x + 1); } }; }\nint g(int y) { return y; }\n';
        const walk = tree => {
            const nodes = [];
            const stack = [tree.rootNode];
            while (stack.length > 0) {
                const node = stack.pop();
                nodes.push(node);
                for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
            }
            return nodes;
        };
        const describeNode = node => node ? `${node.type}@${node.startIndex}-${node.endIndex}` : 'null';
        const facts = (node, reads) => {
            let out = '';
            for (let round = 0; round < reads; round++) {
                out = [node.startIndex, node.endIndex, describeNode(node.parent),
                    ...['name', 'body', 'declarator', 'type', 'function', 'arguments']
                        .map(field => describeNode(node.childForFieldName(field)))].join('|');
            }
            return out;
        };
        // Tree A answers from the caches (read three times), tree B from the
        // first, native read of every accessor.
        const a = walk(safeParse(parser, code, undefined, PARSE_OPTIONS)).map(node => facts(node, 3));
        const b = walk(safeParse(parser, code, undefined, PARSE_OPTIONS)).map(node => facts(node, 1));
        assert.deepEqual(a, b);
        assert.ok(a.length > 30);
    });

    it('C++ override/final specifiers keep their order in modifiers', () => {
        const dir = tmp({
            'a.cpp': 'struct B { virtual void f(); virtual void g(); };\nstruct D : B { void f() override final; void g() final override; };\n',
        });
        try {
            const index = idx(dir);
            const byName = name => index.symbols.get(name).find(d => d.className === 'D');
            assert.deepEqual(byName('f').modifiers.filter(m => m === 'override' || m === 'final'), ['final', 'override']);
            assert.deepEqual(byName('g').modifiers.filter(m => m === 'override' || m === 'final'), ['override', 'final']);
        } finally {
            rm(dir);
        }
    });

    it('a selected preprocessor configuration reuses its all-source tree instead of parsing it again', () => {
        const TreeSitter = require('tree-sitter');
        const code = [
            '#ifdef A', 'int f(int x) {', '#else', 'int f(long x) {', '#endif',
            '  return (int) x;', '}', 'int g(void) { return f(1); }', '',
        ].join('\n');
        const original = TreeSitter.prototype.parse;
        const sources = [];
        TreeSitter.prototype.parse = function (input, ...rest) {
            if (typeof input === 'string') sources.push(input);
            return original.call(this, input, ...rest);
        };
        try {
            const dir = tmp({ 'x.c': code });
            try {
                const index = idx(dir);
                assert.ok(index.symbols.get('g'));
            } finally {
                rm(dir);
            }
        } finally {
            TreeSitter.prototype.parse = original;
        }
        const whole = sources.filter(source => source.length === code.length);
        assert.equal(new Set(whole).size, whole.length, 'no source text is parsed twice');
    });

    it('a paste no project name can match is not expanded; one that can is', () => {
        const dir = tmp({
            'suite.h': [
                '#define CLASS_NAME(a, b) a##_##b##_Test',
                '#define TEST(a, b) struct CLASS_NAME(a, b) { void run(); }; void CLASS_NAME(a, b)::run()',
                '#define HANDLER(n) handle_##n',
                '#define CALL(n) HANDLER(n)()',
                'void handle_open(void);',
                '',
            ].join('\n'),
            'use.cpp': '#include "suite.h"\nTEST(io, open) { CALL(open); }\nvoid go() { CALL(open); }\n',
        });
        try {
            const index = idx(dir);
            const { expansionState, macroExpansionSummary } = require('../core/macro-expansion');
            const state = expansionState(index);
            assert.ok(!state.relevant.has('TEST'));
            assert.ok(!state.relevant.has('CLASS_NAME'));
            assert.ok(state.relevant.has('CALL') && state.relevant.has('HANDLER'));
            const open = index.context('handle_open', { file: 'suite.h', line: 5 });
            assert.deepEqual(open.callers.map(c => `${c.relativePath}:${c.line}`).sort(), ['use.cpp:2', 'use.cpp:3']);
            assert.deepEqual(macroExpansionSummary(index).patterns.map(p => p.macro), []);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #387: type-rename latency without answer changes', () => {
    const { getParser, getLanguageAdapter } = require('../languages');

    it('the persisted recovery blanks rebuild the tree the recovery selects, with one parse', () => {
        const code = [
            '#pragma once',
            'namespace lib {',
            'LIB_INLINE App *App::callback(int fn) {',
            '    return this;',
            '}',
            'LIB_NODISCARD LIB_INLINE Option *App::get_option(int key) const {',
            '    return nullptr;',
            '}',
            '#ifdef _WIN32',
            'int platform() { return 1;',
            '#else',
            'int platform() { return 2;',
            '#endif',
            '}',
            '}',
        ].join('\n');
        const language = getLanguageAdapter('cpp');
        const parser = getParser('cpp');
        const parsed = language.parse(code, parser);
        assert.ok(Array.isArray(parsed.recoveryBlanks) && parsed.recoveryBlanks.length > 0);
        const cpp = require('../languages').LANGUAGES.cpp.module();
        const replayed = cpp.recoveredTree(code, parser);
        const rebuilt = cpp.recoveredTree(code, parser, parsed.recoveryBlanks);
        assert.strictEqual(rebuilt.rootNode.toString(), replayed.rootNode.toString());
        // No blanks: the literal tree is the recovered tree.
        assert.strictEqual(cpp.recoveredTree('int f() { return 1; }\n', parser, []), null);
    });

    it('type plans are identical with and without the persisted blanks', () => {
        const dir = tmp({
            'include/Macros.hpp': '#pragma once\n#define LIB_INLINE\n#define LIB_NODISCARD [[nodiscard]]\n',
            'include/App.hpp': '#pragma once\n#include "Macros.hpp"\nnamespace lib {\nclass Option {};\nclass App {\n  public:\n    App *callback(int fn);\n    LIB_NODISCARD Option *get_option(int key) const;\n};\n}\n',
            'include/App_inl.hpp': '#pragma once\n#include "App.hpp"\nnamespace lib {\nLIB_INLINE App *App::callback(int fn) { return this; }\nLIB_NODISCARD LIB_INLINE Option *App::get_option(int key) const { return nullptr; }\n}\n',
            'main.cpp': '#include "include/App_inl.hpp"\nint main() { lib::App app; lib::App *p = app.callback(1); return p != nullptr; }\n',
        });
        try {
            const plan = strip => {
                const index = idx(dir);
                if (strip) for (const entry of index.files.values()) delete entry.recoveryBlanks;
                const r = execute(index, 'plan', { name: 'App', file: 'include/App.hpp', line: 5, renameTo: 'Gadget' });
                assert.ok(r.ok, r.error);
                return JSON.stringify(r.result.changes);
            };
            const withBlanks = plan(false);
            assert.strictEqual(withBlanks, plan(true));
            assert.ok(withBlanks.includes('App_inl.hpp'));
        } finally {
            rm(dir);
        }
    });

    it('the flat node list is reused when the same root arrives through another wrapper', () => {
        // The binding keeps one wrapper per node only while it is alive, so
        // a collected root wrapper makes each later `tree.rootNode` a new
        // object; every extractor pass rebuilt the whole node list.
        const { traverseTreeCached } = require('../languages/utils');
        const parser = getParser('c');
        const tree = parser.parse('int f(void) { return 1; }\nint g;\n');
        const root = tree.rootNode;
        const other = new root.constructor(root.tree);
        for (let i = 0; i < 6; i++) other[i] = root[i];
        assert.notStrictEqual(other, root);
        assert.strictEqual(other.id, root.id);
        const firstVisited = start => {
            let first = null;
            traverseTreeCached(start, node => { first ??= node; });
            return first;
        };
        assert.strictEqual(firstVisited(root), root);
        assert.strictEqual(firstVisited(other), root, 'cache hit: the list built from the first wrapper');
        const otherTree = parser.parse('int f(void) { return 1; }\nint g;\n');
        assert.notStrictEqual(firstVisited(otherTree.rootNode), root, 'a different tree never shares the list');
    });
});

describe('fix #388: cold-build CPU and wall without answer changes', () => {
    const { ProjectIndex } = require('../core/project');
    const { getParser, safeParse, PARSE_OPTIONS } = require('../languages');
    const { getCachedNodeList, traverseTree, cachedNodeRange } = require('../languages/utils');
    const SAMPLES = {
        javascript: 'function f(a, b) { /* c */ return g(a) + h(b, [1, 2]); }\nclass K { m() { return this.f(1); } }\n',
        python: 'def f(a, b):\n    # c\n    return g(a) + h(b, [1, 2])\n\nclass K:\n    def m(self):\n        return self.f(1)\n',
        go: 'package p\n\nfunc F(a int, b int) int { return g(a) + h(b, []int{1, 2}) }\n\ntype K struct{ x int }\n\nfunc (k K) M() int { return k.x }\n',
        rust: 'fn f(a: u8, b: u8) -> u8 { /* c */ g(a) + h(b, &[1, 2]) }\nimpl K { fn m(&self) -> u8 { self.f(1) } }\n',
        java: 'class K { int f(int a, int b) { return g(a) + h(b, new int[]{1, 2}); } int m() { return this.f(1, 2); } }\n',
        csharp: 'class K { int F(int a, int b) { return G(a) + H(b, new[] { 1, 2 }); } int M() => this.F(1, 2); }\n',
        cpp: 'namespace n { struct K { int f(int a) { return g(a + 1); } }; }\nint g(int y) { return y; }\n',
        c: 'static int g(int y) { return y; }\nint f(int a, int b) { /* c */ return g(a) + g(b); }\n',
    };
    const describeNode = node => node ? `${node.type}@${node.startIndex}-${node.endIndex}` : 'null';
    const allNodes = root => {
        const out = [];
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            out.push(node);
            for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
        }
        return out;
    };

    it('named children are read natively once per node and served exactly as the binding serves them', () => {
        for (const [language, code] of Object.entries(SAMPLES)) {
            const parser = getParser(language);
            const facts = node => [
                node.namedChildren.map(describeNode).join(','),
                node.namedChildCount,
                describeNode(node.firstNamedChild),
                describeNode(node.lastNamedChild),
                ...Array.from({ length: node.namedChildCount + 2 }, (_, i) => describeNode(node.namedChild(i - 1))),
            ].join('|');
            // Tree A: every named node listed first (the extractors' flat
            // list), then read twice from the cache; tree B: native reads.
            const a = safeParse(parser, code, undefined, PARSE_OPTIONS);
            getCachedNodeList(a.rootNode);
            const cached = allNodes(a.rootNode).map(node => { facts(node); return facts(node); });
            const b = parser.parse(code, undefined, PARSE_OPTIONS);
            const native = allNodes(b.rootNode).map(facts);
            assert.deepEqual(cached, native, language);
            // Callers own the array they get.
            const node = a.rootNode;
            const first = node.namedChildren;
            first.length = 0;
            assert.ok(node.namedChildren.length > 0, `${language}: a caller's mutation never reaches the cache`);
        }
    });

    it('traverseTree over the cached flat list visits and leaves exactly as the recursive walk', () => {
        for (const [language, code] of Object.entries(SAMPLES)) {
            const parser = getParser(language);
            const events = (root, subtree) => {
                const out = [];
                const start = subtree ? root.namedChild(root.namedChildCount - 1) : root;
                traverseTree(start, node => {
                    out.push(`in ${describeNode(node)}`);
                    // Skipped subtrees are neither walked nor left.
                    return !/parameter|argument/.test(node.type);
                }, { onLeave: node => out.push(`out ${describeNode(node)}`) });
                return out;
            };
            const listed = safeParse(parser, code, undefined, PARSE_OPTIONS);
            getCachedNodeList(listed.rootNode);
            assert.ok(cachedNodeRange(listed.rootNode), `${language}: the list is cached`);
            const walked = parser.parse(code, undefined, PARSE_OPTIONS);
            assert.strictEqual(cachedNodeRange(walked.rootNode), null, `${language}: no list for a fresh tree`);
            for (const subtree of [false, true]) {
                const expected = events(walked.rootNode, subtree);
                assert.ok(expected.length > 4);
                assert.deepEqual(events(listed.rootNode, subtree), expected, `${language} subtree=${subtree}`);
            }
        }
    });

    it("a stored future's use walk only descends into nodes whose text holds its name", () => {
        const { rustValueFacts } = require('../languages/rust-value-flow');
        const code = [
            'async fn run(c: &Client) {',
            '    let fut = c.fetch();',
            '    let other = helper(1, 2, 3);',
            '    for i in 0..10 { log(i); other.push(i); }',
            '    if ready() { let fut = 5; use_it(fut); }',
            '    fut.await;',
            '}',
            'async fn lost(c: &Client) {',
            '    let pending = c.fetch();',
            '    let data = vec![1, 2, 3];',
            '    process(&data);',
            '}',
            '',
        ].join('\n');
        const TreeSitter = require('tree-sitter');
        const descriptor = Object.getOwnPropertyDescriptor(TreeSitter.SyntaxNode.prototype, 'namedChildCount');
        const tree = safeParse(getParser('rust'), code, undefined, PARSE_OPTIONS);
        const calls = tree.rootNode.descendantsOfType('call_expression')
            .filter(call => call.childForFieldName('function')?.text === 'c.fetch');
        assert.strictEqual(calls.length, 2);
        const enumerated = [];
        Object.defineProperty(TreeSitter.SyntaxNode.prototype, 'namedChildCount', {
            configurable: true,
            get() { enumerated.push(this.text); return descriptor.get.call(this); },
        });
        let facts;
        try {
            facts = calls.map(call => { enumerated.length = 0; const f = rustValueFacts(call); return { f, seen: [...enumerated] }; });
        } finally {
            Object.defineProperty(TreeSitter.SyntaxNode.prototype, 'namedChildCount', descriptor);
        }
        // `fut` is awaited after an inner shadow; `pending` is never read.
        assert.deepEqual(facts.map(entry => entry.f.valueConsumed), ['stored', null]);
        for (const [i, name] of ['fut', 'pending'].entries()) {
            const walked = facts[i].seen.filter(text => !text.startsWith('{'));
            assert.ok(walked.every(text => text.includes(name)),
                `${name}: only nodes holding the name are descended into (${walked.filter(t => !t.includes(name)).join(' | ')})`);
        }
    });

    it('an overload witness replay answers a map read with one object per key, like the live index', () => {
        const { factIndex } = require('../core/provenance-overload');
        const live = {
            files: new Map([['/p/a.java', { language: 'java', relativePath: 'a.java',
                importBindings: [{ name: 'X', source: 'b' }], moduleResolved: null, other: 1 }]]),
            symbols: new Map([['f', [{ name: 'f', file: '/p/a.java' }]]]),
        };
        const reads = {};
        const capture = factIndex(reads, live);
        const captured = capture.files.get('/p/a.java');
        assert.strictEqual(capture.files.get('/p/a.java'), captured, 'capture: one object per key');
        assert.deepEqual(captured, { language: 'java', relativePath: 'a.java',
            importBindings: [{ name: 'X', source: 'b' }], moduleResolved: null });
        const replay = factIndex(reads);
        const first = replay.files.get('/p/a.java');
        assert.strictEqual(replay.files.get('/p/a.java'), first, 'replay: one object per key');
        assert.deepEqual(first, captured);
        assert.strictEqual(replay.files.has('/p/a.java'), true);
        assert.throws(() => replay.symbols.get('f'), /Missing overload fact/, 'unrecorded reads still abstain');
    });

    it('a sequential build expands macros in place; a parallel build expands in parse workers it kept', () => {
        const files = {
            'Cargo.toml': '[package]\nname = "keep388"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': [
                '#[macro_export]',
                'macro_rules! tests { ($(fn $n:ident() $b:block)*) => { $( pub fn $n() { let t = crate::helper(0); $b; } )* }; }',
                'pub fn helper(x: u32) -> u32 { x }',
            ].join('\n') + '\n',
        };
        const body = Array.from({ length: 240 }, (_, i) => `        let v${i} = crate::helper(${i});`).join('\n');
        for (let f = 0; f < 6; f++) {
            files['src/lib.rs'] += `pub mod m${f};\n`;
            files[`src/m${f}.rs`] = ['tests! {', `    fn case_${f}() {`, body, '    }', '}', ''].join('\n');
        }
        const dir = tmp(files);
        try {
            const { indexSnapshot } = require('./helpers');
            const facts = index => {
                require('../core/rust-macro-expansion').materializeRustMacroCalls(index);
                return indexSnapshot(index) + [...index.files.values()]
                    .map(entry => JSON.stringify([entry.relativePath, entry.rustMacroExpansion || null])).sort().join('\n');
            };
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 1 });
            assert.strictEqual(sequential.lastBuildWorkerCount, 1);
            assert.strictEqual(sequential.lastBuildExpansionWorkers, 0, 'no thread for a sequential build');
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 3 });
            assert.strictEqual(parallel.lastBuildWorkerCount, 3);
            assert.ok(parallel.lastBuildExpansionWorkers >= 1 && parallel.lastBuildExpansionWorkers <= 3,
                `kept parse workers expand: ${parallel.lastBuildExpansionWorkers}`);
            assert.ok(parallel.symbols.has('case_5'), 'generated declarations indexed');
            assert.strictEqual(facts(parallel), facts(sequential));
        } finally { rm(dir); }
    });
});

describe('fix #389: new parser facts are identical in parallel and sequential builds', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('valueShape, unions, annotation types, value aliases and C++ local class scopes survive workers', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub struct S;\npub struct T(u8);\npub enum E { A, B(u8), C { x: u8 } }\npub union U { a: u32 }\n' +
                'impl S { pub fn m(&self) {} }\npub fn f() { S.m(); let w = S; w.m(); }\n',
            'src/Marker.java': 'package p;\npublic @interface Marker { String value() default ""; int MAX = 1; }\n',
            'src/Use.java': 'package p;\n@Marker("x")\nclass Use { @Marker(value = "y") void m() {} }\n',
            'pkg/models.py': 'class Box:\n    pass\nAlias = Box\n',
            'web/models.js': 'class Box {}\nconst Alias = Box;\nmodule.exports = { Box, Alias };\n',
            'native/mod.cpp': 'int f() { struct L { int g() { return 1; } }; L l; return l.g(); }\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['"valueShape":"unit"', '"valueShape":"tuple"', '"type":"union"',
                '"annotationType":true', 'moduleValueAliases', '"lexicalScopeStartLine":1']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });
});

describe('fix #390: C#/C++ generics and name lines are identical in parallel and sequential builds', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('C# type parameter names and attribute-started name lines, C++ template parameters, Java/TS field name lines survive workers', () => {
        const dir = tmp({
            'src/V.cs': 'namespace N\n{\n    [System.Serializable]\n    public abstract class V<TState, TResult>\n    {\n' +
                '        [System.Obsolete]\n        protected abstract TResult Visit<TArg>(TState s, TArg a);\n    }\n}\n',
            'src/b.hpp': 'template <typename S, int N>\nclass Base { public: virtual void visit(S s) = 0; };\n',
            'src/b.cpp': '#include "b.hpp"\nclass Impl : public Base<int, 2> { public: void visit(int s) override {} };\n',
            'src/A.java': 'package p;\nclass A {\n    @Deprecated\n    int field = 1;\n}\n',
            'src/a.ts': 'function dec(t: any, k?: any): any { return t; }\nexport class W {\n    @dec\n    size = 1;\n}\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['"generics":"<TState, TResult>"', '"generics":"<TArg>"', '"generics":"<S, N>"',
                '"nameLine":4', '"nameLine":7']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });
});

describe('fix #391: friend functions, macro-generated callables, C# configuration views and method type arguments survive workers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry the same facts', () => {
        const dir = tmp({
            'src/v.hpp': 'namespace ns {\nclass V {\n  public:\n    friend bool eq(const V& a, const V& b) { return true; }\n    friend void sw(V& a, V& b);\n};\n}\n',
            'tests/t.cc': '#include "../src/v.hpp"\nTEST(Suite, Name) {\n  ns::V a, b;\n  eq(a, b);\n}\nTEST_CASE("x", "[y]") {\n  eq(ns::V(), ns::V());\n}\n',
            'src/I.cs': 'namespace N;\npublic interface I\n{\n    int F(int x)\n#if FEATURE\n        => G<int>(x)\n#endif\n    ;\n    int G<T>(T x);\n}\n',
            'src/P.java': 'class P {\n    <T> T id(T x) { return x; }\n    void use() { this.<String>id("a"); }\n}\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['"friendOf":"V"', '"generatedByMacro":{"name":"TEST","args":["Suite","Name"]}',
                '"generatedByMacro":{"name":"TEST_CASE"}']) {
                assert.ok(snapshot.includes(fact), fact);
            }
            const { getCachedCalls } = require('../core/callers');
            const typeArgs = [...sequential.files.keys()].flatMap(file =>
                (getCachedCalls(sequential, file) || []).filter(call => call.methodTypeArgs)
                    .map(call => `${call.name}:${call.methodTypeArgs}`));
            assert.deepStrictEqual(typeArgs.sort(), ['G:1', 'id:1']);
            assert.ok(sequential.symbols.get('F').some(d => d.className === 'I'));
        } finally { rm(dir); }
    });
});

describe('fix #392: const/static types, module alias alternatives and enum interfaces survive workers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry the same facts', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "p392"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub struct Flags;\nimpl Flags { pub fn iter(&self) -> u32 { 1 } }\npub const FLAGS: Flags = Flags;\npub static REFS: &Flags = &FLAGS;\n',
            'mod.py': 'import sys\n\nclass Box:\n    pass\n\nif sys.version_info > (3,):\n    Same = Box\nelse:\n    Same = Box\n',
            'a.js': 'class Box {}\nlet L = Box;\nmodule.exports = { L };\n',
            'Ops.java': 'interface Op { int apply(int x); }\nenum Ops implements Op {\n    NEG;\n    @Override\n    public int apply(int x) { return -x; }\n}\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['"valueType":"Flags"', '"implements":["Op"]',
                '\\"alternatives\\":[{\\"target\\":\\"Box\\"},{\\"target\\":\\"Box\\"}]',
                '\\"name\\":\\"L\\",\\"target\\":\\"Box\\"']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });
});

describe('fix #393: unnamed parameters, arrow receivers, template heads and delegate counts survive workers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry the same facts', () => {
        const dir = tmp({
            'a.hpp': [
                '#include <memory>',
                'class App;',
                'using App_p = std::shared_ptr<App>;',
                'class App { public: virtual int f(const App *) const; void g(); };',
                'template<typename J> int from(const J &j) { App_p p; p->g(); return j.size(); }',
            ].join('\n'),
            'D.cs': 'namespace N;\npublic delegate void Handler(string a, int b);\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['"unnamed":true', '"templateParams":"<J>"', '"delegateParams":2',
                '\\"receiverArrow\\":true', '\\"receiverArrowObject\\":\\"App_p\\"']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });
});

describe('fix #395: C# using directive facts survive workers; strict-owner memo keeps answers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry directive namespaces, static and global flags, nested namespaces', () => {
        const dir = tmp({
            'src/A.cs': 'namespace Acme.Tests;\n\nusing Internal;\nusing static Internal.Util;\nusing C = Internal.Cache;\n\npublic class T { }\n',
            'src/B.cs': 'global using Acme.Internal;\nnamespace Acme\n{\n    namespace Deep\n    {\n        using Internal;\n        public class D { }\n    }\n}\n',
            'src/L.cs': 'namespace Acme.Internal;\npublic static class Util { public static int One() => 1; }\npublic static class Cache { }\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const details = [...sequential.files.values()].flatMap(entry => entry.importDetails || [])
                .map(detail => `${detail.module}|${detail.namespace || ''}|${detail.static ? 's' : ''}|${detail.global ? 'g' : ''}`)
                .sort();
            assert.deepStrictEqual(details, ['Acme.Internal|||g', 'Internal.Cache|Acme.Tests||',
                'Internal.Util|Acme.Tests|s|', 'Internal|Acme.Deep||', 'Internal|Acme.Tests||']);
            assert.strictEqual(sequential.symbols.get('D')[0].namespace, 'Acme.Deep');
        } finally { rm(dir); }
    });

    it('bare-call bindings among many same-name nested types resolve the same with and without the operation memo', () => {
        const classes = [];
        for (let i = 0; i < 30; i++) {
            classes.push(`public class Test${i} {\n    class Source { }\n    public object Make() => new Source();\n}\n`);
        }
        const dir = tmp({ 'Many.cs': `namespace Acme;\n${classes.join('')}` });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            const target = index.symbols.get('Source')[7];
            const answer = () => {
                const r = index.findCallers('Source', { targetDefinitions: [target], collectAccount: true });
                return [...r.map(c => `${c.line}:${c.tier}`),
                    ...(r.unverifiedEntries || []).map(e => `${e.line}:${e.reason}`),
                    ...r.accountRaw.excludedEntries.map(e => `${e.line}:${e.reason}`)].sort();
            };
            const plain = answer();
            index._beginOp();
            let memoized;
            try { memoized = answer(); } finally { index._endOp(); }
            assert.deepStrictEqual(memoized, plain);
            assert.strictEqual(plain.length, 30);
        } finally { rm(dir); }
    });

    it('a C# rename parses each caller file once across its slot sweeps; split conditionals keep every branch', () => {
        const TreeSitter = require('tree-sitter');
        const files = {
            'Shapes.cs': 'namespace Acme;\npublic interface IShape { int Area(int k); }\n' +
                'public class Sq : IShape { public int Area(int k) => k * k; }\n' +
                'public class Ci : IShape { public int Area(int k) => 3 * k; }\n',
            'Use.cs': 'namespace Acme;\npublic class Use {\n    public int A(IShape s) => s.Area(1) + s.Area(2);\n' +
                '    public int B(Sq q) => q.Area(3);\n}\n',
            'Cond.cs': 'namespace Acme;\npublic class Cond {\n#if FAST\n    public int F(Ci c) => c.Area(4);\n#else\n' +
                '    public int F(Ci c) => c.Area(5) + 1;\n#endif\n}\n',
            'Split.cs': 'namespace Acme;\npublic class Split {\n    public int G(Ci c)\n#if FAST\n        => c.Area(6);\n' +
                '#else\n        => c.Area(7) + 1;\n#endif\n}\n',
        };
        const dir = tmp(files);
        const original = TreeSitter.prototype.parse;
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            const sources = [];
            TreeSitter.prototype.parse = function (input, ...rest) {
                if (typeof input === 'string') sources.push(input);
                return original.call(this, input, ...rest);
            };
            let result;
            try {
                result = index.plan('Area', { file: 'Shapes.cs', line: 2, renameTo: 'Size' });
            } finally {
                TreeSitter.prototype.parse = original;
            }
            for (const file of ['Use.cs', 'Cond.cs', 'Split.cs']) {
                assert.ok(sources.filter(source => source === files[file]).length <= 1, `${file} parsed once`);
            }
            const calls = result.changes.filter(change => change.editKind === 'call')
                .map(change => `${change.file}:${change.line}`).sort();
            assert.deepStrictEqual(calls, ['Cond.cs:4', 'Cond.cs:6', 'Split.cs:5', 'Split.cs:7',
                'Use.cs:3', 'Use.cs:4']);
        } finally {
            TreeSitter.prototype.parse = original;
            rm(dir);
        }
    });
});

describe('fix #396: C/C++ recovery facts survive workers; cheaper probes and plans keep answers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry typedef names, nested owners, macro facts and external macro records', () => {
        const dir = tmp({
            'lib/common.hpp': '#pragma once\n#define LIB_INLINE inline\n#define LIB_TRY try\n#define LIB_CATCH catch (...) {}\n',
            'lib/pool.hpp': '#pragma once\n#include "common.hpp"\ntemplate <typename K>\nclass List {\n  struct Node;\n  Node* head_;\n};\ntemplate <typename K>\nstruct List<K>::Node { void Next() {} };\n',
            'lib/pool-inl.hpp': '#pragma once\n#include "pool.hpp"\nclass Pool { public: void Stop(); bool Next(); };\nLIB_INLINE void Pool::Stop() {\n    LIB_TRY {\n        for (int i = 0; i < 3; i++) { while (Next()) {} }\n    }\n    LIB_CATCH\n}\n',
            'lib/t.cc': '#include "pool-inl.hpp"\n#define STR_(name) static int Get##name() { return 0; }\nclass S { public: STR_(Min) };\nTEST_F(Fixture, Name) { Next(); }\n',
            'src/a.c': 'typedef struct { int pos; } stream_t, *stream_p;\n#define DEF(x) \\\n    x = 0; /* note */ \\\n    reset(x);\nstatic void reset(int x) { (void)x; }\n',
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            const snapshot = indexSnapshot(sequential);
            assert.strictEqual(indexSnapshot(parallel), snapshot);
            for (const fact of ['"typedefName":true', '"enclosingType":"List"', '"unspelled":true',
                '"args":["Fixture","Name"]', '"externalMacroNames":["LIB_CATCH","LIB_INLINE","LIB_TRY"]']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });

    it('a small parse buffer yields the tree of the default buffer', () => {
        const { getParser, safeParse } = require('../languages');
        const parser = getParser('cpp');
        const source = 'namespace n { template <typename T> struct S { T* f(int a) const { return nullptr; } }; }';
        const small = safeParse(parser, source);
        const large = parser.parse(source, undefined, { bufferSize: 1024 * 1024 });
        assert.strictEqual(small.rootNode.toString(), large.rootNode.toString());
    });

    it('a rename plan without call-argument analysis is the plan with it', () => {
        const dir = tmp({
            'a.hpp': 'class A { public: int f(int x, int y) { return x + y; } };\n',
            'b.cpp': '#include "a.hpp"\nint g(A& a) { return a.f(1, 2) + a.f(3, 4); }\n',
            'c.py': 'def h(x, y=1):\n    return x\n\ndef use():\n    return h(1, y=2) + h(3)\n',
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            const verify = require('../core/verify');
            for (const [name, file, line] of [['f', 'a.hpp', 1], ['h', 'c.py', 1]]) {
                const def = index.symbols.get(name).find(d => d.relativePath === file && d.startLine === line);
                index._beginOp();
                let withArgs;
                let without;
                try {
                    withArgs = verify.computePlanCallSites(index, name, def);
                    without = verify.computePlanCallSites(index, name, def, { analyzeArgs: false });
                } finally { index._endOp(); }
                const strip = sites => sites.map(({ args: _a, argCount: _c, keywordArgNames: _k, positionalCount: _p, ...rest }) => rest);
                assert.deepStrictEqual(strip(without.sites), strip(withArgs.sites));
                const renamed = index.plan(name, { file, line, renameTo: `${name}2` });
                assert.ok(renamed.changes.some(change => change.editKind === 'call'), name);
            }
        } finally { rm(dir); }
    });
});

describe('fix #397: JS destructured members, local shadows, member values and literal accessors survive workers', () => {
    const { ProjectIndex } = require('../core/project');
    const { tmp, rm, indexSnapshot } = require('./helpers');

    it('parallel and sequential builds carry the same facts', () => {
        const dir = tmp({
            'package.json': '{"name":"p397"}',
            'a.ts': [
                'export class Api { run(): number { return 1 } }',
                'const api = new Api()',
                'const { run } = api',
                'run()',
                'export const bound = api.run',
                'export function f(helper: () => number) { return helper() }',
            ].join('\n') + '\n',
            'o.js': 'module.exports = {\n  get size() { return 1 },\n  set size(v) { void v },\n}\n',
            'r.js': "const stringify = require('url').format\nmodule.exports = { stringify }\n",
        });
        try {
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.ok(parallel.lastBuildWorkerCount >= 2, `workers: ${parallel.lastBuildWorkerCount}`);
            assert.strictEqual(indexSnapshot(parallel), indexSnapshot(sequential));
            const snapshot = indexSnapshot(sequential);
            for (const fact of ['\\"destructured\\":{\\"key\\":\\"run\\"', '\\"localShadow\\":-1',
                '\\"memberValue\\":true', '"objectLiteralLine":1', '"memberType":"set"',
                '\\"alias\\":\\"stringify\\"']) {
                assert.ok(snapshot.includes(fact), fact);
            }
        } finally { rm(dir); }
    });
});
