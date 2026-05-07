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
