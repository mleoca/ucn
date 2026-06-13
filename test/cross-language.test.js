/**
 * Cross-language tests — invariants that must hold for ALL supported languages.
 *
 * Uses forEachLanguage() to parameterize the same assertion across JS, TS,
 * Python, Go, Java, and Rust. If a new language is added to the registry,
 * these tests automatically cover it.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { tmp, rm, idx, forEachLanguage, extensionFor, FIXTURES_PATH, langTraits } = require('./helpers');

// ── Per-language code templates ────────────────────────────────────────────
// Each template generates minimal valid code for the test scenario.

const LANG_FIXTURES = {
    javascript: {
        manifest: { 'package.json': '{"name":"test"}' },
        function: (name) => `function ${name}() { return 1; }\nmodule.exports = { ${name} };`,
        caller: (fnName, callerName) =>
            `const { ${fnName} } = require('./lib');\nfunction ${callerName}() { return ${fnName}(); }`,
        unusedAndUsed: (unused, used) =>
            `function ${unused}() {}\nfunction ${used}() {}\nmodule.exports = { ${used} };`,
        mainCaller: (used) =>
            `const { ${used} } = require('./lib');\nfunction main() { ${used}(); }`,
        entryPoint: () => null, // JS has no standalone runtime entry point
    },
    typescript: {
        manifest: { 'package.json': '{"name":"test"}' },
        function: (name) => `export function ${name}() { return 1; }`,
        caller: (fnName, callerName) =>
            `import { ${fnName} } from './lib';\nexport function ${callerName}() { return ${fnName}(); }`,
        unusedAndUsed: (unused, used) =>
            `export function ${unused}() {}\nexport function ${used}() {}`,
        mainCaller: (used) =>
            `import { ${used} } from './lib';\nexport function main() { ${used}(); }`,
        entryPoint: () => null,
    },
    python: {
        manifest: {},
        function: (name) => `def ${name}():\n    return 1`,
        caller: (fnName, callerName) =>
            `from lib import ${fnName}\n\ndef ${callerName}():\n    return ${fnName}()`,
        unusedAndUsed: (unused, used) =>
            `def ${unused}():\n    pass\n\ndef ${used}():\n    pass`,
        mainCaller: (used) =>
            `from lib import ${used}\n\ndef main():\n    ${used}()`,
        entryPoint: () => ({ name: '__init__', code: 'def __init__(self):\n    pass' }),
    },
    go: {
        manifest: { 'go.mod': 'module test\n\ngo 1.21' },
        // Go exported names start with uppercase
        function: (name) => {
            const goName = name.charAt(0).toUpperCase() + name.slice(1);
            return `package main\n\nfunc ${goName}() int {\n\treturn 1\n}`;
        },
        caller: (fnName, callerName) => {
            const goFn = fnName.charAt(0).toUpperCase() + fnName.slice(1);
            const goCaller = callerName.charAt(0).toUpperCase() + callerName.slice(1);
            return `package main\n\nfunc ${goCaller}() int {\n\treturn ${goFn}()\n}`;
        },
        unusedAndUsed: (unused, used) => {
            const goUnused = unused.charAt(0).toUpperCase() + unused.slice(1);
            const goUsed = used.charAt(0).toUpperCase() + used.slice(1);
            return `package main\n\nfunc ${goUnused}() {}\n\nfunc ${goUsed}() {}`;
        },
        mainCaller: (used) => {
            const goUsed = used.charAt(0).toUpperCase() + used.slice(1);
            return `package main\n\nfunc main() {\n\t${goUsed}()\n}`;
        },
        entryPoint: () => ({ name: 'main', code: 'package main\n\nfunc main() {}' }),
    },
    java: {
        manifest: {},
        function: (name) =>
            `public class Lib {\n    public static int ${name}() { return 1; }\n}`,
        caller: (fnName, callerName) =>
            `public class App {\n    public static int ${callerName}() { return Lib.${fnName}(); }\n}`,
        unusedAndUsed: (unused, used) =>
            `public class Lib {\n    public static void ${unused}() {}\n    public static void ${used}() {}\n}`,
        mainCaller: (used) =>
            `public class Main {\n    public static void main(String[] args) { Lib.${used}(); }\n}`,
        entryPoint: () => ({
            name: 'main',
            code: 'public class Main {\n    public static void main(String[] args) {}\n}'
        }),
    },
    rust: {
        manifest: { 'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"' },
        function: (name) => `pub fn ${name}() -> i32 {\n    1\n}`,
        caller: (fnName, callerName) =>
            `mod lib;\n\npub fn ${callerName}() -> i32 {\n    lib::${fnName}()\n}`,
        unusedAndUsed: (unused, used) =>
            `pub fn ${unused}() {}\n\npub fn ${used}() {}`,
        mainCaller: (used) =>
            `mod lib;\n\nfn main() {\n    lib::${used}();\n}`,
        entryPoint: () => ({ name: 'main', code: 'fn main() {}' }),
    },
};

// ── Test suites ────────────────────────────────────────────────────────────

describe('Cross-language: trait consistency', () => {
    forEachLanguage((lang, traits) => {
        it(`${lang}: methodCallInclusion correlates with typeSystem`, () => {
            if (traits.typeSystem === 'nominal') {
                assert.strictEqual(traits.methodCallInclusion, 'auto',
                    `${lang}: nominal should use auto method call inclusion`);
            } else {
                assert.strictEqual(traits.methodCallInclusion, 'explicit',
                    `${lang}: structural should use explicit method call inclusion`);
            }
        });

        it(`${lang}: traits object has all required fields`, () => {
            const required = ['typeSystem', 'methodCallInclusion', 'packageScope',
                'hasReceiverPackageCalls', 'exportVisibility', 'hasDynamicImports'];
            for (const field of required) {
                assert.ok(field in traits,
                    `${lang}: missing trait field '${field}'`);
            }
            // selfParam must exist as key (can be null for Go)
            assert.ok('selfParam' in traits,
                `${lang}: missing trait field 'selfParam'`);
        });
    });
});

describe('Cross-language: find resolves a function', () => {
    forEachLanguage((lang, traits, ext) => {
        const fixtures = LANG_FIXTURES[lang];
        if (!fixtures) return;

        it(`${lang}: find resolves a defined function`, () => {
            const files = {
                ...fixtures.manifest,
                [`lib${ext}`]: fixtures.function('helper'),
            };
            const dir = tmp(files);
            try {
                const index = idx(dir);
                // Go capitalizes exported names
                const searchName = lang === 'go' ? 'Helper' : 'helper';
                const symbols = index.symbols.get(searchName);
                assert.ok(symbols && symbols.length > 0,
                    `${lang}: should find '${searchName}' in symbol table`);
            } finally {
                rm(dir);
            }
        });
    });
});

describe('Cross-language: toc lists symbols', () => {
    forEachLanguage((lang, traits, ext) => {
        const fixtures = LANG_FIXTURES[lang];
        if (!fixtures) return;

        it(`${lang}: toc includes defined function`, () => {
            const files = {
                ...fixtures.manifest,
                [`lib${ext}`]: fixtures.function('myFunc'),
            };
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const toc = index.getToc({ detailed: true });
                const searchName = lang === 'go' ? 'MyFunc' : 'myFunc';
                const hasFunc = toc.files.some(f => {
                    const syms = f.symbols || {};
                    const fns = syms.functions || [];
                    return fns.some(s => s.name === searchName);
                });
                assert.ok(hasFunc, `${lang}: toc should include ${searchName}`);
            } finally {
                rm(dir);
            }
        });
    });
});

describe('Cross-language: deadcode identifies unused functions', () => {
    forEachLanguage((lang, traits, ext) => {
        const fixtures = LANG_FIXTURES[lang];
        if (!fixtures) return;

        it(`${lang}: unused function is flagged as dead code`, () => {
            const unusedName = lang === 'go' ? 'Unused' : 'unused';
            const usedName = lang === 'go' ? 'Used' : 'used';
            const files = {
                ...fixtures.manifest,
                [`lib${ext}`]: fixtures.unusedAndUsed(unusedName, usedName),
                [`main${ext}`]: fixtures.mainCaller(usedName),
            };
            // Java needs class-matching filenames
            if (lang === 'java') {
                files['Lib.java'] = fixtures.unusedAndUsed(unusedName, usedName);
                files['Main.java'] = fixtures.mainCaller(usedName);
                delete files[`lib${ext}`];
                delete files[`main${ext}`];
            }
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const dead = index.deadcode({ includeExported: true });
                const deadNames = dead.map(d => d.name);
                assert.ok(deadNames.includes(unusedName),
                    `${lang}: '${unusedName}' should be flagged as dead code, got: [${deadNames}]`);
                assert.ok(!deadNames.includes(usedName),
                    `${lang}: '${usedName}' should NOT be flagged as dead code`);
            } finally {
                rm(dir);
            }
        });
    });
});

describe('Cross-language: entry points excluded from deadcode', () => {
    forEachLanguage((lang, traits, ext) => {
        const fixtures = LANG_FIXTURES[lang];
        if (!fixtures) return;

        const ep = fixtures.entryPoint();
        if (!ep) return; // JS/TS have no standalone runtime entry point

        it(`${lang}: ${ep.name} is not flagged as dead code`, () => {
            const filename = lang === 'java' ? 'Main.java' : `main${ext}`;
            const files = {
                ...fixtures.manifest,
                [filename]: ep.code,
            };
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const dead = index.deadcode({ includeExported: true });
                const deadNames = dead.map(d => d.name);
                assert.ok(!deadNames.includes(ep.name),
                    `${lang}: entry point '${ep.name}' should NOT be dead code, got: [${deadNames}]`);
            } finally {
                rm(dir);
            }
        });
    });
});

describe('Cross-language: context returns callers', () => {
    forEachLanguage((lang, traits, ext) => {
        const fixtures = LANG_FIXTURES[lang];
        if (!fixtures) return;

        it(`${lang}: context shows caller of a function`, () => {
            const fnName = lang === 'go' ? 'Helper' : 'helper';
            const callerName = lang === 'go' ? 'Caller' : 'caller';
            const files = {
                ...fixtures.manifest,
                [`lib${ext}`]: fixtures.function(fnName),
                [`app${ext}`]: fixtures.caller(fnName, callerName),
            };
            // Java needs class-matching filenames
            if (lang === 'java') {
                files['Lib.java'] = fixtures.function(fnName);
                files['App.java'] = fixtures.caller(fnName, callerName);
                delete files[`lib${ext}`];
                delete files[`app${ext}`];
            }
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const ctx = index.context(fnName);
                assert.ok(ctx, `${lang}: context should return result for '${fnName}'`);
                assert.ok(ctx.callers !== undefined,
                    `${lang}: context should have callers array`);
            } finally {
                rm(dir);
            }
        });
    });
});

describe('Cross-language: isEntryPoint exported from language modules', () => {
    forEachLanguage((lang) => {
        it(`${lang}: language module exports isEntryPoint`, () => {
            const { getLanguageModule } = require('../languages');
            const langModule = getLanguageModule(lang);
            assert.ok(typeof langModule.isEntryPoint === 'function',
                `${lang}: language module should export isEntryPoint()`);
        });
    });
});

// BUG-CX/CY: every language must export getEntryPointKind() so tracing/search
// can distinguish 'test' entries (test cases) from 'main'/'framework' entries
// (runtime entry points). Collapsing these into a single boolean caused
// fn main() to be mis-classified as a test-case in affectedTests.
describe('Cross-language: getEntryPointKind exported and consistent with isEntryPoint', () => {
    forEachLanguage((lang) => {
        it(`${lang}: language module exports getEntryPointKind`, () => {
            const { getLanguageModule } = require('../languages');
            const langModule = getLanguageModule(lang);
            assert.ok(typeof langModule.getEntryPointKind === 'function',
                `${lang}: language module should export getEntryPointKind()`);
        });

        it(`${lang}: getEntryPointKind returns 'test' | 'main' | 'framework' | null`, () => {
            const { getLanguageModule } = require('../languages');
            const langModule = getLanguageModule(lang);
            const ALLOWED = new Set(['test', 'main', 'framework', null]);
            // Probe across realistic shapes — at least every return must be in ALLOWED.
            const probes = [
                { name: 'main', modifiers: ['public', 'static'] },
                { name: 'main', modifiers: [] },
                { name: 'init', modifiers: [] },
                { name: 'test_thing', modifiers: ['test'] },
                { name: 'TestSomething', modifiers: [] },
                { name: 'Benchmark_x', modifiers: [] },
                { name: '__init__', modifiers: [] },
                { name: 'plain', modifiers: [] },
                { name: 'helper', modifiers: ['cfg_test_module'] },
                { name: 'override_method', modifiers: ['override'], isMethod: true, className: 'X' },
                { name: 'componentDidMount', modifiers: [], isMethod: true, className: 'C' },
            ];
            for (const p of probes) {
                const k = langModule.getEntryPointKind(p);
                assert.ok(ALLOWED.has(k),
                    `${lang}: getEntryPointKind returned '${k}' for ${JSON.stringify(p)}; expected one of ['test','main','framework',null]`);
            }
        });

        it(`${lang}: isEntryPoint and getEntryPointKind agree`, () => {
            const { getLanguageModule } = require('../languages');
            const langModule = getLanguageModule(lang);
            const probes = [
                { name: 'main', modifiers: ['public', 'static'] },
                { name: 'main', modifiers: [] },
                { name: 'init', modifiers: [] },
                { name: 'test_thing', modifiers: ['test'] },
                { name: 'TestSomething', modifiers: [] },
                { name: 'plain', modifiers: [] },
                { name: 'helper', modifiers: ['cfg_test_module'] },
                { name: 'componentDidMount', modifiers: [], isMethod: true, className: 'C' },
            ];
            for (const p of probes) {
                const kind = langModule.getEntryPointKind(p);
                const ep = !!langModule.isEntryPoint(p);
                assert.strictEqual(ep, kind !== null,
                    `${lang}: isEntryPoint(${JSON.stringify(p)})=${ep} should equal (kind!==null)=${kind !== null} (kind=${kind})`);
            }
        });
    });
});

// Per-language smoke checks for the test-vs-main distinction. Covers at least
// one test entry and one main/runtime entry per applicable language.
describe('Cross-language: getEntryPointKind returns kind="test" for canonical test symbols', () => {
    const cases = {
        rust: [
            // #[test] attribute is recorded as the 'test' modifier
            { input: { name: 'check', modifiers: ['test'] }, kind: 'test' },
            { input: { name: 'bench_x', modifiers: ['bench'] }, kind: 'test' },
            { input: { name: 'helper', modifiers: ['cfg_test_module'] }, kind: 'test' },
            { input: { name: 'main', modifiers: [] }, kind: 'main' },
        ],
        go: [
            { input: { name: 'TestFoo', modifiers: [] }, kind: 'test' },
            { input: { name: 'BenchmarkX', modifiers: [] }, kind: 'test' },
            { input: { name: 'main', modifiers: [] }, kind: 'main' },
            { input: { name: 'init', modifiers: [] }, kind: 'main' },
        ],
        python: [
            { input: { name: 'test_foo', modifiers: [] }, kind: 'test' },
            { input: { name: 'setUp', modifiers: [] }, kind: 'test' },
            { input: { name: '__init__', modifiers: [] }, kind: 'framework' },
        ],
        java: [
            { input: { name: 'foo', modifiers: ['test'] }, kind: 'test' },
            { input: { name: 'main', modifiers: ['public', 'static'] }, kind: 'main' },
        ],
        javascript: [
            // JS has no function-level test convention — handled via call detection
            { input: { name: 'plain', modifiers: [] }, kind: null },
            { input: { name: 'componentDidMount', modifiers: [], isMethod: true, className: 'C' }, kind: 'framework' },
        ],
        typescript: [
            { input: { name: 'plain', modifiers: [] }, kind: null },
            { input: { name: 'connectedCallback', modifiers: [], isMethod: true, className: 'C' }, kind: 'framework' },
        ],
    };

    forEachLanguage((lang) => {
        const langCases = cases[lang];
        if (!langCases) return;
        const { getLanguageModule } = require('../languages');
        const langModule = getLanguageModule(lang);
        for (const c of langCases) {
            it(`${lang}: ${JSON.stringify(c.input)} -> kind=${c.kind}`, () => {
                assert.strictEqual(
                    langModule.getEntryPointKind(c.input), c.kind,
                    `${lang}: expected kind=${c.kind} for ${JSON.stringify(c.input)}`
                );
            });
        }
    });
});

describe('Cross-language: fixtures exist', () => {
    forEachLanguage((lang) => {
        it(`${lang}: test fixtures directory exists`, () => {
            const fixtureDir = path.join(FIXTURES_PATH, lang);
            assert.ok(fs.existsSync(fixtureDir),
                `${lang}: fixture directory should exist at ${fixtureDir}`);
        });
    });
});

// ── Feature A: every supported language reports patterns for at least one
//    loop. (try is skipped for Go/Rust which lack the construct.) ─────────
describe('Cross-language: Feature A — loop classification', () => {
    // Inline templates per language for a function that has two calls: one
    // inside a loop, one outside. Languages without a clean loop syntax
    // skip themselves.
    const LOOP_FIXTURES = {
        javascript: {
            manifest: { 'package.json': '{"name":"t"}' },
            file: 'app.js',
            code: [
                'function helper(x) { return x; }',
                'function caller() { for (let i = 0; i < 2; i++) { helper(i); } helper(0); }',
                'caller();',
            ].join('\n'),
            verifyName: 'helper',
        },
        typescript: {
            manifest: { 'package.json': '{"name":"t"}', 'tsconfig.json': '{}' },
            file: 'app.ts',
            code: [
                'export function helper(x: number) { return x; }',
                'export function caller() { for (let i = 0; i < 2; i++) { helper(i); } helper(0); }',
            ].join('\n'),
            verifyName: 'helper',
        },
        python: {
            manifest: {},
            file: 'a.py',
            code: [
                'def helper(x):',
                '    return x',
                '',
                'def caller():',
                '    for i in range(2):',
                '        helper(i)',
                '    helper(0)',
                '',
                'caller()',
            ].join('\n'),
            verifyName: 'helper',
        },
        go: {
            manifest: { 'go.mod': 'module t\n\ngo 1.21\n' },
            file: 'main.go',
            code: [
                'package main',
                'func helper(x int) int { return x }',
                'func caller() { for i := 0; i < 2; i++ { helper(i) }; helper(0) }',
                'func main() { caller() }',
            ].join('\n'),
            verifyName: 'helper',
        },
        java: {
            manifest: {},
            file: 'src/Main.java',
            code: [
                'public class Main {',
                '    public static int helper(int x) { return x; }',
                '    public static void caller() { for (int i = 0; i < 2; i++) helper(i); helper(0); }',
                '}',
            ].join('\n'),
            verifyName: 'helper',
        },
        rust: {
            manifest: { 'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"' },
            file: 'src/main.rs',
            code: [
                'fn helper(x: i32) -> i32 { x }',
                'fn caller() { for i in 0..2 { helper(i); } helper(0); }',
                'fn main() { caller(); }',
            ].join('\n'),
            verifyName: 'helper',
        },
    };
    forEachLanguage((lang) => {
        const fix = LOOP_FIXTURES[lang];
        if (!fix) return;
        it(`${lang}: verify reports inLoop > 0 for a call in a loop`, () => {
            const files = { ...fix.manifest, [fix.file]: fix.code };
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const r = index.verify(fix.verifyName);
                assert.ok(r && r.found, `${lang}: ${fix.verifyName} should be found`);
                assert.ok(r.patterns, `${lang}: result should have patterns`);
                assert.ok(r.patterns.inLoop >= 1,
                    `${lang}: at least one call should be inLoop, got ${r.patterns.inLoop}`);
            } finally { rm(dir); }
        });
    });
});

// ── Polyglot endpoint bridging ───────────────────────────────────────────────
// Genuinely cross-language: multiple languages in the same project must bridge
// across language boundaries (Python server + JS client, etc.).

describe('Cross-language endpoints: polyglot bridging', () => {
    const { execute } = require('../core/execute');

    it('Flask Python server + JS axios client → bridges across languages', () => {
        const dir = tmp({
            'package.json': '{"name":"polyglot"}',
            'pyproject.toml': '[project]\nname = "polyglot-server"\nversion = "0.0.1"\n',
            'server.py': [
                'from flask import Flask',
                'app = Flask(__name__)',
                '',
                "@app.route('/api/health', methods=['GET'])",
                'def health():',
                '    return {}',
                '',
                "@app.route('/api/users', methods=['POST'])",
                'def create_user():',
                '    return {}',
                '',
            ].join('\n'),
            'client.js': [
                "async function checkHealth() {",
                "    return await axios.get('/api/health');",
                "}",
                "async function makeUser(data) {",
                "    return await axios.post('/api/users', data);",
                "}",
                "module.exports = { checkHealth, makeUser };",
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            // Server should detect 2 Flask routes
            assert.strictEqual(result.meta.totalRoutes, 2);
            assert.strictEqual(result.meta.byFramework.flask, 2);
            // Client should detect 2 axios requests
            assert.strictEqual(result.meta.totalRequests, 2);
            // Bridges: 2 exact matches across language boundary
            assert.strictEqual(result.meta.totalBridges, 2);
            // Both should be exact (literal-literal) matches
            for (const b of result.bridges) {
                assert.strictEqual(b.matchType, 'exact');
                assert.strictEqual(b.confidence, 1);
                // Confirm cross-language: route in .py, request in .js
                assert.match(b.route.file, /\.py$/);
                assert.match(b.request.file, /\.js$/);
            }
            // Frameworks identified correctly per side
            const routeFrameworks = new Set(result.routes.map(r => r.framework));
            assert.ok(routeFrameworks.has('flask'));
            const reqFrameworks = new Set(result.requests.map(r => r.framework));
            assert.ok(reqFrameworks.has('axios'));
        } finally { rm(dir); }
    });

    it('Go server + Python client: bridges across languages', () => {
        const dir = tmp({
            'go.mod': 'module poly\n\ngo 1.21\n',
            'pyproject.toml': '[project]\nname = "polyglot"\nversion = "0.0.1"\n',
            'server.go': [
                'package main',
                '',
                'import "net/http"',
                '',
                'func main() {',
                '    http.HandleFunc("/api/items", listItems)',
                '}',
                '',
                'func listItems() {}',
            ].join('\n'),
            'client.py': [
                'import requests',
                '',
                'def fetch_items():',
                "    return requests.get('/api/items')",
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.meta.totalRoutes, 1);
            assert.strictEqual(result.meta.totalRequests, 1);
            // Go HandleFunc is method=ALL → matches GET request
            assert.strictEqual(result.bridges.length, 1);
            const b = result.bridges[0];
            assert.match(b.route.file, /\.go$/);
            assert.match(b.request.file, /\.py$/);
            // Path is exact, method is ALL (inferred match)
            assert.ok(b.matchType === 'exact' || b.matchType === 'partial');
            assert.ok(b.methodInferred, 'expected methodInferred=true for ALL→GET');
        } finally { rm(dir); }
    });
});

describe('Cross-language: callee account conserves on every fixture symbol', () => {
    forEachLanguage((lang) => {
        it(`${lang}: every def's callee account partitions its call sites`, () => {
            const dir = path.join(FIXTURES_PATH, lang);
            if (!fs.existsSync(dir)) return;
            const index = idx(dir);
            const NON_CALLABLE = new Set(['class', 'struct', 'interface', 'type', 'field', 'impl', 'trait']);
            let checked = 0;
            for (const [, defs] of index.symbols) {
                for (const def of defs) {
                    if (NON_CALLABLE.has(def.type)) continue;
                    const r = index.findCallees(def, { includeMethods: true, collectAccount: true });
                    const a = r.calleeAccount;
                    if (!a) continue;
                    checked++;
                    assert.ok(a.conserved,
                        `${lang} ${def.name} (${def.relativePath}:${def.startLine}) not conserved: ${JSON.stringify(a)}`);
                    // Legacy identity: collectAccount must not change the edge set
                    const legacy = index.findCallees(def, { includeMethods: true });
                    assert.strictEqual(
                        r.map(c => `${c.name}:${c.file}:${c.startLine}`).join('|'),
                        legacy.map(c => `${c.name}:${c.file}:${c.startLine}`).join('|'),
                        `${lang} ${def.name}: account mode changed callee edges`);
                    // Legacy edges carry no contract fields
                    assert.ok(legacy.every(c => c.tier === undefined && c.sites === undefined),
                        `${lang} ${def.name}: legacy callees must not carry tier/sites`);
                }
            }
            assert.ok(checked > 0, `${lang}: no defs checked`);
        });
    });
});
