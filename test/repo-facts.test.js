/**
 * What `repo` reads instead of recomputing:
 *
 *   - how often each file uses its language's reflection and code-execution
 *     vocabulary, counted in the file's syntax tree when it is indexed (the
 *     trust report and the completeness footer used to read every file's
 *     text on each query and count pattern matches);
 *   - the HOT ranking, kept per index state and stored beside the index.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmp, rm, idx, runCli, McpClient } = require('./helpers');
const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { getParser, safeParse, getLanguageAdapter, langTraits } = require('../languages');
const { reflectionFactsInTree } = require('../core/reflection');
const hotSummary = require('../core/hot-summary');
const { getProjectCacheDir } = require('../core/cache');

// ---------------------------------------------------------------------------
// Use counts
// ---------------------------------------------------------------------------

const JS_USES = [
    '// Reflect.get(a, b) eval(x) new Function(y)',
    'const TEXT = "new Function(\'x\') eval(1) Reflect.get(a, b)";',
    'function f(o, k, code) {',
    '  Reflect.get(o, k);',
    '  Reflect.ownKeys(o);',
    '  globalThis.Reflect.apply(f, o, []);',
    '  eval(code);',
    '  globalThis.eval(code);',
    '  const g = new Function("a", code);',
    '  o.eval(code);',
    '  o.Reflect.get(o, k);',
    '  return g;',
    '}',
].join('\n');

// One file per language: every spelling of the vocabulary as a call, and the
// same spellings where they are not one (a comment, a string, a method of
// another object, a definition, a same-named method called without a name).
const USE_FIXTURES = {
    python: {
        file: 'uses.py',
        code: [
            'import importlib',
            '# getattr(x, "comment")',
            'TEXT = "eval(1) getattr(a, b) exec(c)"',
            '',
            'def f(obj, name, code):',
            '    """exec(code) in a docstring"""',
            '    v = getattr(obj, name)',
            '    setattr(obj, "x", 1)',
            '    hasattr(obj, name)',
            '    delattr(obj, name)',
            '    obj.getattr(name)',
            '    eval(code)',
            '    exec(code)',
            '    obj.exec(code)',
            '    importlib.import_module(name)',
            '    __import__("os")',
            '    return getattr(getattr(obj, "a"), "b")',
            '',
            'class T:',
            '    def eval(self, context):',
            '        return context',
        ].join('\n'),
        reflectionUses: 6,
        evalUses: 2,
    },
    javascript: { file: 'uses.js', code: JS_USES, reflectionUses: 3, evalUses: 3 },
    typescript: {
        file: 'uses.ts',
        code: JS_USES.replace('function f(o, k, code)', 'function f(o: any, k: string, code: string)'),
        reflectionUses: 3,
        evalUses: 3,
    },
    tsx: {
        file: 'uses.tsx',
        code: JS_USES.replace('function f(o, k, code)', 'function f(o: any, k: string, code: string)'),
        reflectionUses: 3,
        evalUses: 3,
    },
    go: {
        file: 'uses.go',
        code: [
            'package main',
            '',
            'import (',
            '\t"fmt"',
            '\tr "reflect"',
            '\t"reflect"',
            ')',
            '',
            '// reflect.ValueOf(x)',
            'func f(x interface{}, n string) {',
            '\tv := reflect.ValueOf(x)',
            '\tv.MethodByName(n)',
            '\tr.TypeOf(x)',
            '\tfmt.Println("reflect.TypeOf(y)")',
            '\tvar t reflect.Type',
            '\t_ = t',
            '\t_ = reflect.ValueOf(x).Elem().FieldByName(n)',
            '}',
        ].join('\n'),
        reflectionUses: 5,
        evalUses: 0,
    },
    java: {
        file: 'Uses.java',
        code: [
            'class Uses {',
            '    // Class.forName("x")',
            '    void f(Object o, String n, Other other, Request request) throws Exception {',
            '        Class<?> c = Class.forName(n);',
            '        c.getDeclaredMethod(n);',
            '        c.getMethod(n).invoke(o);',
            '        other.forName(n);',
            '        request.getMethod();',
            '        String s = "x.getMethod(y) Class.forName(z)";',
            '        c.getMethod("alpha").getDeclaringClass().getField("beta");',
            '    }',
            '}',
        ].join('\n'),
        reflectionUses: 5,
        evalUses: 0,
    },
    csharp: {
        file: 'Uses.cs',
        code: [
            'class Uses {',
            '    // t.GetMethod("x")',
            '    void F(System.Type t, string n, Request request) {',
            '        t.GetMethod(n);',
            '        t.GetProperty(n);',
            '        request.GetMethod();',
            '        var s = "t.GetField(n)";',
            '        t.GetMethod("Alpha").DeclaringType.GetField("Beta");',
            '    }',
            '}',
        ].join('\n'),
        reflectionUses: 4,
        evalUses: 0,
    },
    // No runtime reflection vocabulary: a function that happens to be named
    // like another language's builtin is an ordinary call.
    rust: {
        file: 'uses.rs',
        code: '// eval(x)\nfn eval(x: i32) -> i32 { x }\nfn f() -> i32 { eval(1) }\n',
        reflectionUses: 0,
        evalUses: 0,
    },
    c: {
        file: 'uses.c',
        code: '/* eval(x) */\nint eval(int x) { return x; }\nint f(void) { return eval(1); }\n',
        reflectionUses: 0,
        evalUses: 0,
    },
};

function projectOfUses() {
    const files = { 'package.json': '{"name":"uses"}' };
    for (const fixture of Object.values(USE_FIXTURES)) files[fixture.file] = fixture.code + '\n';
    return tmp(files);
}

describe('reflection and code-execution uses are counted in the tree at index time', () => {
    for (const [language, fixture] of Object.entries(USE_FIXTURES)) {
        it(`${language}: calls count, the same spelling elsewhere does not`, () => {
            const ir = getLanguageAdapter(language).analyze(fixture.code, getParser(language), fixture.file);
            assert.deepStrictEqual(
                { reflectionUses: ir.reflectionUses || 0, evalUses: ir.evalUses || 0 },
                { reflectionUses: fixture.reflectionUses, evalUses: fixture.evalUses });
        });
    }

    it('the located candidates are the ones a walk of every call finds', () => {
        // Candidates are located from the vocabulary's spellings; a spelling
        // the locator misses would silently drop a use.
        for (const [language, fixture] of Object.entries(USE_FIXTURES)) {
            if (!langTraits(language)?.reflectionApi) continue;
            const parser = getParser(language);
            const ir = getLanguageAdapter(language).analyze(fixture.code, parser, fixture.file);
            const tree = safeParse(parser, fixture.code);
            const located = reflectionFactsInTree(tree, language, fixture.code, { imports: ir.imports });
            const walked = reflectionFactsInTree(tree, language, null, { imports: ir.imports });
            assert.deepStrictEqual(located, walked, language);
        }
    });

    it('every language with a vocabulary is exercised, and no other language counts', () => {
        const { LANGUAGES } = require('../languages');
        for (const [language, config] of Object.entries(LANGUAGES)) {
            const fixture = USE_FIXTURES[language];
            if (config.traits?.reflectionApi) {
                assert.ok(fixture && fixture.reflectionUses > 0, `${language} has a vocabulary and no fixture`);
            } else if (fixture) {
                assert.strictEqual(fixture.reflectionUses + fixture.evalUses, 0, language);
            }
        }
    });

    it('a Go package counts under the name the file imports it by, and only that package', () => {
        const count = code => getLanguageAdapter('go').analyze(code, getParser('go'), 'a.go').reflectionUses || 0;
        assert.strictEqual(count('package a\nimport r "reflect"\nfunc f(x any) { r.ValueOf(x) }\n'), 1);
        // Another module whose last path element is `reflect`.
        assert.strictEqual(count('package a\nimport "example.com/x/reflect"\nfunc f(x any) { reflect.ValueOf(x) }\n'), 0);
        // No import at all: `reflect` is a local value.
        assert.strictEqual(count('package a\nfunc f(reflect T, x any) { reflect.ValueOf(x) }\n'), 0);
        // A blank import binds no qualifier.
        assert.strictEqual(count('package a\nimport _ "reflect"\nfunc f(x any) { reflect.ValueOf(x) }\n'), 0);
    });

    it('an import by name is an import, not a reflection use', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'import importlib\n\ndef f(name):\n    importlib.import_module(name)\n    return importlib.import_module("json")\n',
        });
        try {
            const { result } = execute(idx(dir), 'doctor', {});
            assert.strictEqual(result.blindSpots.reflection.count, 0);
            assert.strictEqual(result.blindSpots.dynamicImports.count, 1, 'the non-literal one');
        } finally { rm(dir); }
    });

    it('the trust report and the completeness footer state the indexed counts', () => {
        const dir = projectOfUses();
        try {
            const index = idx(dir);
            const fixtures = Object.values(USE_FIXTURES);
            const expected = {
                reflection: fixtures.reduce((sum, f) => sum + f.reflectionUses, 0),
                reflectionFiles: fixtures.filter(f => f.reflectionUses > 0).length,
                evalUses: fixtures.reduce((sum, f) => sum + f.evalUses, 0),
                evalFiles: fixtures.filter(f => f.evalUses > 0).length,
            };
            const { result } = execute(index, 'doctor', {});
            assert.strictEqual(result.blindSpots.reflection.count, expected.reflection);
            assert.strictEqual(result.blindSpots.reflection.fileCount, expected.reflectionFiles);
            assert.strictEqual(result.blindSpots.evalCalls.count, expected.evalUses);
            assert.strictEqual(result.blindSpots.evalCalls.fileCount, expected.evalFiles);
            const warnings = index.detectCompleteness().warnings;
            assert.strictEqual(warnings.find(w => w.type === 'reflection').count, expected.reflection);
            assert.strictEqual(warnings.find(w => w.type === 'eval').count, expected.evalUses);
        } finally { rm(dir); }
    });

    it('neither reads a source file', () => {
        const dir = projectOfUses();
        const original = fs.readFileSync;
        try {
            const index = idx(dir);
            const read = [];
            fs.readFileSync = function spy(target, ...rest) {
                if (index.files.has(String(target))) read.push(String(target));
                return original.call(this, target, ...rest);
            };
            execute(index, 'doctor', {});
            index.detectCompleteness();
            assert.deepStrictEqual(read, []);
        } finally {
            fs.readFileSync = original;
            rm(dir);
        }
    });

    it('the counts survive a saved index and a worker build', () => {
        const dir = projectOfUses();
        const cacheDir = tmp({});
        try {
            const built = idx(dir);
            const counts = index => [...index.files.values()]
                .map(fe => [fe.relativePath, fe.reflectionUses || 0, fe.evalUses || 0])
                .sort((a, b) => (a[0] < b[0] ? -1 : 1));
            const cachePath = path.join(cacheDir, 'index.json');
            built.saveCache(cachePath);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            assert.deepStrictEqual(counts(loaded), counts(built));
            const workers = new ProjectIndex(dir);
            workers.build(null, { quiet: true, workers: 2 });
            assert.deepStrictEqual(counts(workers), counts(built));
            assert.ok(counts(built).some(row => row[1] > 0) && counts(built).some(row => row[2] > 0));
        } finally { rm(dir); rm(cacheDir); }
    });
});

describe('a chain of reflective accesses records every access', () => {
    // The second access of `a.getMethod("x").getDeclaringClass().getField("y")`
    // begins at the same offset as the first. It was dropped from the
    // inventory, so the member it names read as unreferenced.
    const CHAINS = {
        java: ['A.java', 'class A {\n  void f(Class<?> c) throws Exception {\n    c.getMethod("alpha").getDeclaringClass().getField("beta");\n  }\n}\n',
            ['getMethod:alpha', 'getField:beta']],
        csharp: ['A.cs', 'class A {\n  void F(System.Type t) {\n    t.GetMethod("Alpha").DeclaringType.GetField("Beta");\n  }\n}\n',
            ['GetMethod:Alpha', 'GetField:Beta']],
        go: ['a.go', 'package a\nfunc f(v reflect.Value) { v.MethodByName("Alpha").Call(nil)[0].FieldByName("Beta") }\n',
            ['MethodByName:Alpha', 'FieldByName:Beta']],
    };
    for (const [language, [file, code, sites]] of Object.entries(CHAINS)) {
        it(`${language}: both names are sites`, () => {
            const ir = getLanguageAdapter(language).analyze(code, getParser(language), file);
            assert.deepStrictEqual((ir.reflectionSites || []).map(site => `${site.kind}:${site.name}`), sites);
        });
    }

    it('a member reached only by the second access is not reported unused', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/Registry.java': [
                'public class Registry {',
                '    private int alpha() { return 1; }',
                '    private int beta() { return 2; }',
                '    private int gamma() { return 3; }',
                '    public Object find(Class<?> c) throws Exception {',
                '        return c.getDeclaredMethod("alpha").getDeclaringClass().getDeclaredMethod("beta");',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const { ok, result } = execute(idx(dir), 'deadcode', {});
            assert.ok(ok);
            const names = (result.items || result).map(item => item.name);
            assert.ok(names.includes('gamma'), `the control is reported: ${names}`);
            assert.ok(!names.includes('alpha'), `first access: ${names}`);
            assert.ok(!names.includes('beta'), `second access: ${names}`);
        } finally { rm(dir); }
    });
});

// ---------------------------------------------------------------------------
// HOT ranking kept per index state
// ---------------------------------------------------------------------------

const HOT_PROJECT = {
    'package.json': '{"name":"hot"}',
    'lib.js': [
        'function helper(x) { return x + 1; }',
        'function other(x) { return x * 2; }',
        'function rare(x) { return x - 1; }',
        'module.exports = { helper, other, rare };',
    ].join('\n') + '\n',
    'app.js': [
        'const { helper, other, rare } = require("./lib");',
        'function a() {',
        '  helper(1);',
        '  helper(2);',
        '  other(1);',
        '}',
        'function b() {',
        '  helper(3);',
        '  other(2);',
        '  rare(1);',
        '}',
        'module.exports = { a, b };',
    ].join('\n') + '\n',
};

/** Run `fn` and return how many exact caller queries it ran. */
function countingCallerQueries(fn) {
    const callers = require('../core/callers');
    const original = callers.findCallers;
    let count = 0;
    callers.findCallers = function counted(...args) {
        count++;
        return original.apply(this, args);
    };
    try { fn(); } finally { callers.findCallers = original; }
    return count;
}

function repo(index, params = {}) {
    const response = execute(index, 'repo', params);
    assert.ok(response.ok, response.error);
    return response.result;
}

describe('the HOT ranking is computed once per index state', () => {
    it('a second request on the same index runs no caller query and answers the same', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            let first;
            let second;
            const firstQueries = countingCallerQueries(() => { first = repo(index); });
            const secondQueries = countingCallerQueries(() => { second = repo(index); });
            assert.ok(firstQueries > 0, 'the fixture must need caller queries');
            assert.strictEqual(secondQueries, 0);
            assert.strictEqual(JSON.stringify(second), JSON.stringify(first));
            assert.deepStrictEqual(first.summary.hot.items.map(item => [item.name, item.callCount]),
                [['helper', 3], ['other', 2], ['rare', 1]]);
        } finally { rm(dir); }
    });

    it('the answer handed out is a copy: changing it changes no later answer', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            const first = index.getStats({ hot: true });
            const expected = JSON.stringify(first.hot);
            first.hot.items.length = 0;
            first.hot.top = 99;
            assert.strictEqual(JSON.stringify(index.getStats({ hot: true }).hot), expected);
        } finally { rm(dir); }
    });

    it('a loaded index answers from the stored summary, byte for byte', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const built = idx(dir);
            built.saveCache(cachePath);
            const fresh = repo(built);
            assert.ok(built.hotSummaryDirty);
            assert.ok(built.saveHotSummaries(cachePath));
            assert.strictEqual(built.hotSummaryDirty, false);
            const stored = JSON.parse(fs.readFileSync(path.join(cacheDir, hotSummary.SUMMARY_FILE), 'utf8'));
            assert.strictEqual(stored.generation, built._callsGenerationKey);

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            let kept;
            const queries = countingCallerQueries(() => { kept = repo(loaded); });
            assert.strictEqual(queries, 0);
            assert.strictEqual(JSON.stringify(kept), JSON.stringify(fresh));
            assert.strictEqual(loaded.hotSummaryDirty, false, 'nothing new to store');
        } finally { rm(dir); rm(cacheDir); }
    });

    it('a rebuild ranks again', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            assert.strictEqual(repo(index).summary.hot.items[0].callCount, 3);
            fs.appendFileSync(path.join(dir, 'app.js'), 'function c() {\n  helper(4);\n  helper(5);\n}\n');
            index.build(null, { quiet: true, forceRebuild: true });
            let after;
            const queries = countingCallerQueries(() => { after = repo(index); });
            assert.ok(queries > 0);
            assert.strictEqual(after.summary.hot.items[0].callCount, 5);
        } finally { rm(dir); }
    });

    it('a summary stored for another index generation is not read', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const built = idx(dir);
            built.saveCache(cachePath);
            const fresh = repo(built);
            built.saveHotSummaries(cachePath);
            const file = path.join(cacheDir, hotSummary.SUMMARY_FILE);
            const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
            // A wrong answer under a generation that is not the index's.
            stored.generation = 'f'.repeat(32);
            stored.summaries[0][1].items[0].callCount = 999;
            fs.writeFileSync(file, JSON.stringify(stored));

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            let answer;
            const queries = countingCallerQueries(() => { answer = repo(loaded); });
            assert.ok(queries > 0);
            assert.strictEqual(JSON.stringify(answer), JSON.stringify(fresh));
        } finally { rm(dir); rm(cacheDir); }
    });

    it('a summary stored by another engine build is not read', () => {
        // A ranking is a verdict of the caller engine: in a development tree
        // an edited engine file must not be answered by the old engine.
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const built = idx(dir);
            built.saveCache(cachePath);
            const fresh = repo(built);
            built.saveHotSummaries(cachePath);
            const file = path.join(cacheDir, hotSummary.SUMMARY_FILE);
            const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.strictEqual(stored.engine, hotSummary.engineStamp());
            stored.engine = '0'.repeat(32);
            stored.summaries[0][1].items[0].callCount = 999;
            fs.writeFileSync(file, JSON.stringify(stored));

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            let answer;
            assert.ok(countingCallerQueries(() => { answer = repo(loaded); }) > 0);
            assert.strictEqual(JSON.stringify(answer), JSON.stringify(fresh));
        } finally { rm(dir); rm(cacheDir); }
    });

    it('a ranking computed while a file differs from the index is answered, not kept', () => {
        // Call records are refreshed from a file that changed under a
        // running command; the ranking then describes neither state.
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            fs.appendFileSync(path.join(dir, 'app.js'), 'function c() {\n  helper(4);\n}\n');
            repo(index);
            assert.strictEqual(index.hotSummaryDirty, false);
            assert.ok(countingCallerQueries(() => { repo(index); }) > 0, 'ranked again');
        } finally { rm(dir); }
    });

    it('a file whose time moved and whose content did not keeps the ranking', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            const later = new Date(Date.now() + 60000);
            fs.utimesSync(path.join(dir, 'app.js'), later, later);
            repo(index);
            assert.strictEqual(index.hotSummaryDirty, true);
            assert.strictEqual(countingCallerQueries(() => { repo(index); }), 0);
        } finally { rm(dir); }
    });

    it('an unreadable or malformed summary file is ranked again', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const built = idx(dir);
            built.saveCache(cachePath);
            const fresh = repo(built);
            const file = path.join(cacheDir, hotSummary.SUMMARY_FILE);
            for (const content of ['{not json', '[]', JSON.stringify({
                format: 1, engine: hotSummary.engineStamp(),
                generation: built._callsGenerationKey, summaries: [['k', { top: 'x', items: 3 }]],
            })]) {
                fs.writeFileSync(file, content);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache(cachePath));
                assert.strictEqual(JSON.stringify(repo(loaded)), JSON.stringify(fresh), content.slice(0, 20));
            }
        } finally { rm(dir); rm(cacheDir); }
    });

    it('saving the index again keeps the summary under the new generation', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const built = idx(dir);
            built.saveCache(cachePath);
            const fresh = repo(built);
            built.saveHotSummaries(cachePath);
            const firstGeneration = built._callsGenerationKey;

            // Another process loads the index and saves it for its own
            // reasons, without ever asking for a ranking.
            const other = new ProjectIndex(dir);
            assert.ok(other.loadCache(cachePath));
            other.saveCache(cachePath);
            assert.notStrictEqual(other._callsGenerationKey, firstGeneration);
            const stored = JSON.parse(fs.readFileSync(path.join(cacheDir, hotSummary.SUMMARY_FILE), 'utf8'));
            assert.strictEqual(stored.generation, other._callsGenerationKey);

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            let kept;
            assert.strictEqual(countingCallerQueries(() => { kept = repo(loaded); }), 0);
            assert.strictEqual(JSON.stringify(kept), JSON.stringify(fresh));
        } finally { rm(dir); rm(cacheDir); }
    });

    it('a rebuilt index does not store what it ranked before the rebuild', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const index = idx(dir);
            index.saveCache(cachePath);
            repo(index);
            index.saveHotSummaries(cachePath);
            fs.appendFileSync(path.join(dir, 'app.js'), 'function c() {\n  other(7);\n  other(8);\n  other(9);\n}\n');
            index.build(null, { quiet: true, forceRebuild: true });
            index.saveCache(cachePath);
            assert.ok(!fs.existsSync(path.join(cacheDir, hotSummary.SUMMARY_FILE)),
                'the stored summary described the previous state');
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            assert.deepStrictEqual(repo(loaded).summary.hot.items.slice(0, 2).map(item => [item.name, item.callCount]),
                [['other', 5], ['helper', 3]]);
        } finally { rm(dir); rm(cacheDir); }
    });

    it('each request is ranked for itself: list length, scope and budgets are part of the key', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            const requests = [
                { hot: true, top: 1 },
                { hot: true, top: 2 },
                { hot: true, top: 2, productionCallsOnly: true },
                { hot: true, top: 2, exclude: ['app'] },
                { hot: true, top: 2, in: '.' },
                { hot: true, top: 2, file: 'lib' },
                { hot: true, top: 2, workBudget: 1 },
                { hot: true, top: 2, maxRefine: 1 },
            ];
            for (const request of requests) {
                let answer;
                const queries = countingCallerQueries(() => { answer = index.getStats(request).hot; });
                const alone = idx(dir).getStats(request).hot;
                assert.strictEqual(JSON.stringify(answer), JSON.stringify(alone), JSON.stringify(request));
                if (answer.refined > 0) assert.ok(queries > 0, `ranked afresh: ${JSON.stringify(request)}`);
            }
            assert.strictEqual(new Set(requests.map(request => hotSummary.keyOf({
                ...request, top: request.top, workBudget: request.workBudget ?? 8000000,
            }))).size, requests.length);
        } finally { rm(dir); }
    });

    it('an index that was never saved stores nothing', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            repo(index);
            assert.strictEqual(index._callsGenerationKey, null);
            assert.strictEqual(index.saveHotSummaries(), null);
            assert.ok(!fs.existsSync(path.join(getProjectCacheDir(dir), hotSummary.SUMMARY_FILE)));
        } finally { rm(dir); }
    });

    it('keeps the latest requests and stores short lists only', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const index = idx(dir);
            index.saveCache(cachePath);
            const item = n => ({ name: `f${n}`, file: 'a.js', startLine: n, callCount: 1 });
            for (let i = 0; i < 12; i++) hotSummary.put(index, `request-${i}`, { top: 1, items: [item(i)] });
            assert.strictEqual(hotSummary.get(index, 'request-3'), undefined, 'the oldest are dropped');
            assert.ok(hotSummary.get(index, 'request-11'));
            // A list longer than the stored-item bound stays in memory only.
            hotSummary.put(index, 'long', { top: 5000, items: Array.from({ length: 2500 }, (_, n) => item(n)) });
            assert.ok(hotSummary.get(index, 'long'));
            index.saveHotSummaries(cachePath);
            const stored = JSON.parse(fs.readFileSync(path.join(cacheDir, hotSummary.SUMMARY_FILE), 'utf8'));
            const keys = stored.summaries.map(row => row[0]);
            assert.ok(!keys.includes('long'));
            assert.ok(keys.includes('request-11'));
            assert.strictEqual(keys.length, 7);
        } finally { rm(dir); rm(cacheDir); }
    });
});

describe('repo through the command line keeps and drops the ranking with the index', () => {
    it('warm answers equal the cold one; an edit ranks again', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const summaryFile = path.join(getProjectCacheDir(dir), hotSummary.SUMMARY_FILE);
            const cold = runCli(dir, 'repo');
            assert.match(cold, /helper — 3 call\(s\)/);
            assert.ok(fs.existsSync(summaryFile), 'the ranking is stored beside the index');
            const index = JSON.parse(fs.readFileSync(path.join(getProjectCacheDir(dir), 'index.json'), 'utf8'));
            assert.strictEqual(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).generation, index.callsGeneration);
            assert.strictEqual(runCli(dir, 'repo'), cold);
            assert.strictEqual(runCli(dir, 'repo', [], ['--json']), runCli(dir, 'repo', [], ['--json']));
            assert.strictEqual(runCli(dir, 'repo', [], ['--no-cache']), cold, 'a fresh ranking gives the kept answer');

            fs.appendFileSync(path.join(dir, 'app.js'), 'function c() {\n  helper(4);\n}\n');
            const edited = runCli(dir, 'repo');
            assert.match(edited, /helper — 4 call\(s\)/);
            assert.strictEqual(runCli(dir, 'repo'), edited);
            assert.strictEqual(runCli(dir, 'repo', [], ['--no-cache']), edited);
        } finally { rm(dir); }
    });

    it('the stats leaderboard is kept the same way', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const flags = ['--sections=stats', '--hot', '--top=2'];
            const cold = runCli(dir, 'repo', [], flags);
            assert.match(cold, /3 calls {2}helper/);
            assert.strictEqual(runCli(dir, 'repo', [], flags), cold);
            // A build without the cache reports its own build time.
            const buildTime = text => text.replace(/^Last index build: .*$/m, 'Last index build');
            assert.strictEqual(buildTime(runCli(dir, 'repo', [], [...flags, '--no-cache'])), buildTime(cold));
        } finally { rm(dir); }
    });
});

describe('repo through MCP stores the ranking for the next session', () => {
    let client;
    before(async () => {
        client = new McpClient();
        await client.start();
        await client.initialize();
    });
    after(() => { client?.stop?.(); });

    it('answers twice the same and leaves the summary beside the index', async () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const first = await client.callTool({ command: 'repo', project_dir: dir });
            const second = await client.callTool({ command: 'repo', project_dir: dir });
            assert.match(first.text, /helper — 3 call\(s\)/);
            assert.strictEqual(second.text, first.text);
            const summaryFile = path.join(getProjectCacheDir(dir), hotSummary.SUMMARY_FILE);
            assert.ok(fs.existsSync(summaryFile));
            // The command line reads the same stored answer.
            assert.match(runCli(dir, 'repo'), /helper — 3 call\(s\)/);
        } finally { rm(dir); }
    });
});

describe('fix #500 review: HOT answers follow the current and saved index states', () => {
    it('an indexFile mutation cannot publish a ranking under the previous saved generation', () => {
        const source = 'function helper() {}\nfunction run() {\n  helper();\n}\nmodule.exports = { helper, run };\n';
        const dir = tmp({ 'package.json': '{}', 'lib.js': source });
        const cacheDir = tmp({});
        try {
            const cachePath = path.join(cacheDir, 'index.json');
            const index = idx(dir);
            index.saveCache(cachePath);
            const oldAnswer = index.getStats({ hot: true }).hot;
            index.saveHotSummaries(cachePath);
            const oldGeneration = index._callsGenerationKey;
            const oldStored = fs.readFileSync(path.join(cacheDir, hotSummary.SUMMARY_FILE), 'utf8');
            const file = path.join(dir, 'lib.js');
            const edited = source.replace('  helper();', '  helper();\n  helper();\n  helper();');
            fs.writeFileSync(file, edited);
            index.indexFile(file);
            const changed = index.getStats({ hot: true }).hot;
            assert.strictEqual(changed.items[0].callCount, 3);
            assert.strictEqual(index._callsGenerationKey, oldGeneration, 'calls shards keep their own generation');
            assert.strictEqual(index.saveHotSummaries(cachePath), null, 'the changed index has not been saved');
            assert.strictEqual(fs.readFileSync(path.join(cacheDir, hotSummary.SUMMARY_FILE), 'utf8'), oldStored);

            fs.writeFileSync(file, source);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(cachePath));
            assert.strictEqual(loaded.isCacheStale(), false);
            assert.deepStrictEqual(loaded.getStats({ hot: true }).hot, oldAnswer);

            fs.writeFileSync(file, edited);
            index.saveCache(cachePath);
            const saved = new ProjectIndex(dir);
            assert.ok(saved.loadCache(cachePath));
            let fromDisk;
            assert.strictEqual(countingCallerQueries(() => { fromDisk = saved.getStats({ hot: true }).hot; }), 0);
            assert.deepStrictEqual(fromDisk, changed, 'a completed save adopts the changed ranking');
        } finally { rm(dir); rm(cacheDir); }
    });

    it('removing a file clears the ranking and prevents publication until the index is saved', () => {
        const dir = tmp(HOT_PROJECT);
        const cacheDir = tmp({});
        try {
            const index = idx(dir);
            const cachePath = path.join(cacheDir, 'index.json');
            index.saveCache(cachePath);
            assert.ok(index.getStats({ hot: true }).hot.items.length > 0);
            const file = path.join(dir, 'app.js');
            index.removeFileSymbols(file);
            index.files.delete(file);
            assert.deepStrictEqual(index.getStats({ hot: true }).hot.items, []);
            assert.strictEqual(index.saveHotSummaries(cachePath), null);
        } finally { rm(dir); rm(cacheDir); }
    });

    it('a cached answer never bypasses an indexed source edit', () => {
        const dir = tmp(HOT_PROJECT);
        try {
            const index = idx(dir);
            const control = idx(dir);
            index.getStats({ hot: true });
            control.getStats({ hot: true });
            hotSummary.reset(control);
            const file = path.join(dir, 'app.js');
            fs.writeFileSync(file, HOT_PROJECT['app.js'].replaceAll('helper(', 'other('));
            let changed;
            assert.ok(countingCallerQueries(() => { changed = index.getStats({ hot: true }).hot; }) > 0);
            assert.deepStrictEqual(changed, control.getStats({ hot: true }).hot,
                'same indexed symbols and call records, existing uncached caller refresh');
            assert.strictEqual(index.hotSummaryDirty, false, 'a ranking over edited source is not retained');
        } finally { rm(dir); }
    });

    it('the cache key preserves an exclude array that changes the scope', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/_lib.js': 'function helper() {}\nfunction run() { helper(); }\nmodule.exports = { helper, run };\n',
        });
        try {
            const index = idx(dir);
            const plain = execute(index, 'repo', { sections: 'stats', hot: true, exclude: [] });
            assert.strictEqual(plain.result.stats.hot.items.length, 1);
            const scoped = execute(index, 'repo', { sections: 'stats', hot: true, exclude: [''] });
            assert.strictEqual(scoped.result.stats.files, 0);
            assert.deepStrictEqual(scoped.result.stats.hot.items, []);
            hotSummary.reset(index);
            assert.deepStrictEqual(scoped.result.stats.hot,
                execute(index, 'repo', { sections: 'stats', hot: true, exclude: [''] }).result.stats.hot);
        } finally { rm(dir); }
    });
});

describe('fix #500 review: reflection uses follow AST callees and package bindings', () => {
    it('nested parentheses do not exceed an arbitrary candidate-location depth', () => {
        const wrap = value => '('.repeat(12) + value + ')'.repeat(12);
        for (const [language, code, expected] of [
            ['javascript', `function f(c) { return ${wrap('eval')}(c); }`, { reflectionUses: 0, evalUses: 1 }],
            ['python', `def f(c):\n    return ${wrap('eval')}(c)\n`, { reflectionUses: 0, evalUses: 1 }],
            ['go', `package p\nimport r "reflect"\nfunc f(x any) { _ = ${wrap('r.ValueOf')}(x) }\n`, { reflectionUses: 1, evalUses: 0 }],
        ]) {
            const parser = getParser(language);
            const ir = getLanguageAdapter(language).analyze(code, parser, `uses.${language}`);
            const tree = safeParse(parser, code);
            assert.strictEqual(tree.rootNode.hasError, false, language);
            const located = reflectionFactsInTree(tree, language, code, { imports: ir.imports });
            assert.deepStrictEqual({ reflectionUses: located.reflectionUses, evalUses: located.evalUses }, expected, language);
            assert.deepStrictEqual(located, reflectionFactsInTree(tree, language, null, { imports: ir.imports }), language);
        }
    });
    const cases = [
        ['javascript', 'function f(o,k,c) { (eval)(c); eval /* c */ (c); Reflect /* c */ .get(o,k); new /* c */ Function(c); new (Function)(c); }', 1, 4],
        ['typescript', 'function f(o:any,k:string,c:string) { (eval)(c); eval /* c */ (c); Reflect /* c */ .get(o,k); new /* c */ Function(c); new (Function)(c); }', 1, 4],
        ['tsx', 'function f(o:any,k:string,c:string) { (eval)(c); eval /* c */ (c); Reflect /* c */ .get(o,k); new /* c */ Function(c); new (Function)(c); }', 1, 4],
        ['python', 'def f(o,k,c):\n    (eval)(c)\n    (exec)(c)\n    (getattr)(o,k)\n', 1, 2],
        ['go', 'package p\nimport 反射 "reflect"\nfunc f(x any) { _ = 反射.ValueOf(x) }\n', 1, 0],
        ['go', 'package p\nimport réfl "reflect"\nfunc f(x any) { _ = réfl /* c */ .ValueOf(x); _ = (réfl.TypeOf)(x); _ = réfl.TypeFor[int]() }\n', 3, 0],
        ['go', 'package p\nimport r "reflect"\nvar t = r.TypeOf(0)\ntype Local struct{}\nfunc (Local) ValueOf(x any) int { return 1 }\nfunc f(r Local, x any) { _ = r.ValueOf(x) }\n', 1, 0],
        ['go', 'package p\nimport r "reflect"\ntype Local struct{}\nfunc (Local) ValueOf(x any) int { return 1 }\nfunc f(x any) { _ = r.TypeOf(x); { r := Local{}; _ = r.ValueOf(x) }; _ = r.ValueOf(x) }\n', 2, 0],
    ];
    for (const [number, [language, code, reflectionUses, evalUses]] of cases.entries()) {
        it(`${language} form ${number + 1}: count and located inventory equal the full walk`, () => {
            const parser = getParser(language);
            const ir = getLanguageAdapter(language).analyze(code, parser, `uses.${language}`);
            const tree = safeParse(parser, code);
            assert.strictEqual(tree.rootNode.hasError, false);
            assert.deepStrictEqual({ reflectionUses: ir.reflectionUses || 0, evalUses: ir.evalUses || 0 },
                { reflectionUses, evalUses });
            assert.deepStrictEqual(reflectionFactsInTree(tree, language, code, { imports: ir.imports }),
                reflectionFactsInTree(tree, language, null, { imports: ir.imports }));
        });
    }
});
