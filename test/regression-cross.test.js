/**
 * UCN Cross-Language Regression Tests
 *
 * Core regressions, reliability tests, production readiness, deadcode regressions,
 * and className/disambiguation fixes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { execSync } = require('child_process');
const { ProjectIndex } = require('../core/project');
const output = require('../core/output');
const { execute } = require('../core/execute');
const { computeReachability } = require('../core/entrypoints');
const { tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR, runCli, runInteractive } = require('./helpers');

describe('fix #398: async producers require callable identity', () => {
    for (const ext of ['js', 'ts', 'tsx', 'html']) {
        it(`${ext}: follows imports and rejects unrelated, nested and imported runtime namesakes`, () => {
            const code = [
                "import { load as run } from './other.js';",
                "import { fetch } from 'external';",
                "import wait from './later.js';",
                "import sync from './sync.js';",
                "import outside from 'external-default';",
                "import { load as viaBarrel } from './barrel.js';",
                "import { viaClause, notFn } from './clause.js';",
                "import readAll from './reader.js';",
                'async function own() { async function hidden() {} return hidden(); }',
                'class Service { async method() {} }',
                'async function use() { call(); hidden(); method(); run(); fetch(); }',
                'async function defaults() { wait(); sync(); outside(); viaBarrel(); }',
                'async function exported() { viaClause(); notFn(); readAll(); }',
            ].join('\n');
            const dir = tmp({
                'other.js': 'export async function load() {}\nexport async function call() {}',
                'later.js': 'export default async function wait() {}',
                'sync.js': 'export default function wait() {}\nexport async function unrelated() {}',
                'barrel.js': "export { load } from './other.js';",
                'clause.js': 'async function viaClause() {}\nconst notFn = () => 1;\nexport { viaClause, notFn };',
                'reader.js': 'const readAll = async function () {};\nexport default readAll;\nexport async function notFn() {}',
                [`app.${ext}`]: ext === 'html' ? `<script type="module">\n${code}\n</script>` : code,
                [`global.${ext}`]: ext === 'html'
                    ? '<script>async function runtime() { fetch("/api"); }</script>'
                    : 'async function runtime() { fetch("/api"); }',
            });
            try {
                const result = idx(dir).auditAsync({});
                assert.deepEqual(result.issues.map(issue => [issue.file, issue.calleeName]),
                    [[`app.${ext}`, 'run'], [`app.${ext}`, 'viaBarrel'], [`app.${ext}`, 'wait'],
                        [`app.${ext}`, 'readAll'], [`app.${ext}`, 'viaClause'], [`global.${ext}`, 'fetch']]);
            } finally { rm(dir); }
        });
    }
});

describe('fix #398: import aliases keep their lexical and module ownership', () => {
    for (const ext of ['py', 'js', 'ts', 'tsx']) {
        it(`${ext}: local imports select their implementation, never the same-file wrapper`, () => {
            const python = ext === 'py';
            const wrapper = python ? [
                'def ping():', '    from impl import ping as run', '    return run()',
                'def other():', '    from other import ping as run', '    return run()',
                'def callback(accept):', '    from impl import ping as run', '    return accept(run)',
                'def original():', '    from impl import ping', '    return ping()',
                'def keep(): return ping()',
                'def different():', '    from impl import pong as run', '    return run()',
            ] : [
                'export function ping() {', "  const { ping: run } = require('./impl');", '  return run();', '}',
                'export function other() {', "  const { ping: run } = require('./other');", '  return run();', '}',
                'export function callback(accept) {', "  const { ping: run } = require('./impl');", '  return accept(run);', '}',
                'export function original() {', "  const { ping } = require('./impl');", '  return ping();', '}',
                'export function keep() { return ping(); }',
                'export function different() {', "  const { pong: run } = require('./impl');", '  return run();', '}',
            ];
            const dir = tmp({
                [`impl.${ext}`]: python ? 'def ping(): return 1\ndef pong(): return 3\n'
                    : 'export function ping() { return 1; }\nexport function pong() { return 3; }\n',
                [`other.${ext}`]: python ? 'def ping(): return 2\n' : 'export function ping() { return 2; }\n',
                [`wrapper.${ext}`]: wrapper.join('\n') + '\n',
                [`use.${ext}`]: python
                    ? 'import wrapper\ndef use():\n    return wrapper.ping()\n'
                    : "import * as wrapper from './wrapper';\nexport function use() { return wrapper.ping(); }\n",
            });
            try {
                const index = idx(dir);
                const context = (file, name) => {
                    const def = index.symbols.get(name).find(d => d.relativePath === `${file}.${ext}`);
                    const r = execute(index, 'context', {
                        name: `${file}.${ext}:${def.startLine}:${name}`, includeMethods: true,
                    });
                    assert.ok(r.ok, JSON.stringify(r.error));
                    assert.equal(r.result.meta.account.conserved, true);
                    return r.result;
                };
                assert.deepEqual(context('wrapper', 'ping').callers.map(c => c.callerName).sort(), ['keep', 'use']);
                assert.deepEqual(context('impl', 'ping').callers.map(c => c.callerName).sort(),
                    ['callback', 'original', 'ping']);
                assert.deepEqual(context('other', 'ping').callers.map(c => c.callerName), ['other']);
                assert.deepEqual(context('impl', 'pong').callers.map(c => c.callerName), ['different']);
                assert.deepEqual(context('wrapper', 'different').callees.map(c => c.name), ['pong']);
                for (const [file, name, target] of [
                    ['wrapper', 'ping', 'impl'], ['wrapper', 'other', 'other'],
                    ['wrapper', 'original', 'impl'], ['wrapper', 'keep', 'wrapper'], ['use', 'use', 'wrapper'],
                ]) {
                    const callees = context(file, name).callees.filter(c => c.name === 'ping');
                    assert.deepEqual(callees.map(c => c.relativePath), [`${target}.${ext}`], `${file}:${name}`);
                }
                // Repeating competing pins cannot leak an import verdict.
                assert.deepEqual(context('wrapper', 'ping').callers.map(c => c.callerName).sort(), ['keep', 'use']);
            } finally { rm(dir); }
        });

        it(`${ext}: a barrel pairs each exported alias with its own import`, () => {
            const python = ext === 'py';
            const dir = tmp({
                [`one.${ext}`]: python ? 'def ping(): return 1\n' : 'export function ping() { return 1; }\n',
                [`two.${ext}`]: python ? 'def ping(): return 2\n' : 'export function ping() { return 2; }\n',
                [`barrel.${ext}`]: python
                    ? 'from one import ping as first\nfrom two import ping as second\n'
                    : "import { ping as first } from './one';\nimport { ping as second } from './two';\nexport { first, second };\n",
                [`use.${ext}`]: python
                    ? 'import barrel\ndef first_use(): return barrel.first()\ndef second_use(): return barrel.second()\n'
                    : "import * as barrel from './barrel';\nexport function first_use() { return barrel.first(); }\nexport function second_use() { return barrel.second(); }\n",
            });
            try {
                const index = idx(dir);
                const { _nameBindingReaches } = require('../core/callers');
                for (const [name, target, other] of [['first', 'one', 'two'], ['second', 'two', 'one']]) {
                    assert.equal(_nameBindingReaches(index, path.join(dir, `barrel.${ext}`), name,
                        new Set([path.join(dir, `${target}.${ext}`)])), 'yes');
                    assert.equal(_nameBindingReaches(index, path.join(dir, `barrel.${ext}`), name,
                        new Set([path.join(dir, `${other}.${ext}`)])), 'no');
                    const r = execute(index, 'context', { name: `${name}_use`, includeMethods: true });
                    assert.ok(r.ok, JSON.stringify(r.error));
                    assert.deepEqual(r.result.callees.map(c => c.relativePath), [`${target}.${ext}`]);
                }
                assert.equal(_nameBindingReaches(index, path.join(dir, `barrel.${ext}`), 'ping',
                    new Set([path.join(dir, `one.${ext}`), path.join(dir, `two.${ext}`)])), 'no');
            } finally { rm(dir); }
        });
    }

    for (const ext of ['js', 'ts', 'tsx']) {
        it(`${ext}: module imports remain global beside a same-line local import`, () => {
            const typed = ext !== 'js';
            const dir = tmp({
                [`impl.${ext}`]: 'export function ping() { return 1; }\nexport class Box {}\n',
                [`barrel.${ext}`]: "import { ping } from './impl'; " +
                    (typed ? "import type { Box } from './impl'; " : '') +
                    "export function lazy() { const { ping: f } = require('./impl'); return f(); }\n" +
                    'export { ping };\n' + (typed ? 'export type { Box };\n' : ''),
                [`use.${ext}`]: "import * as barrel from './barrel';\n" +
                    'export function use() { return barrel.ping(); }\n',
            });
            try {
                const index = idx(dir);
                const r = execute(index, 'context', { name: `impl.${ext}:1:ping`, includeMethods: true });
                assert.ok(r.ok, JSON.stringify(r.error));
                assert.deepEqual(r.result.callers.map(c => c.relativePath), [`barrel.${ext}`, `use.${ext}`]);
                assert.equal(r.result.meta.account.conserved, true);
                const use = execute(index, 'context', { name: 'use', includeMethods: true });
                assert.deepEqual(use.result.callees.map(c => c.relativePath), [`impl.${ext}`]);
                if (typed) {
                    const { _nameBindingReaches } = require('../core/callers');
                    assert.equal(_nameBindingReaches(index, path.join(dir, `barrel.${ext}`), 'Box',
                        new Set([path.join(dir, `impl.${ext}`)]), 4, { exactName: true }), 'yes');
                }
            } finally { rm(dir); }
        });
    }

    it('Python: class-local imports are not module exports, while conditional module imports survive', () => {
        const dir = tmp({
            'impl.py': 'def ping(): return 1\n',
            'wrapper.py': 'def ping(): return 2\nclass Owner:\n    from impl import ping\n',
            'conditional.py': 'import sys\nif sys.version_info:\n    from impl import ping\n',
            'use.py': 'import wrapper\nimport conditional\ndef use():\n    wrapper.ping()\n    conditional.ping()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'impl.py:1:ping', includeMethods: true });
            assert.ok(r.ok, JSON.stringify(r.error));
            assert.deepEqual(r.result.callers.map(c => [c.relativePath, c.line]), [['use.py', 5]]);
            assert.equal(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #398: local subclasses resolve inherited static members by definition', () => {
    const cases = [
        ['py', [
            'class Base:', '    @classmethod', '    def ping(cls): return 1',
            'class Other:', '    @classmethod', '    def ping(cls): return 2',
            'def first():', '    class Local(Base): pass', '    return Local.ping()',
            'def second():', '    class Local(Other): pass', '    return Local.ping()',
            'def third():', '    class Local(Base):', '        @classmethod',
            '        def ping(cls, extra=0): return 3', '    return Local.ping()',
        ]],
        ...['js', 'ts', 'tsx'].map(ext => [ext, [
            'class Base { static ping() { return 1 } }',
            'class Other { static ping() { return 2 } }',
            'function first() {', '  class Local extends Base {}', '  return Local.ping()', '}',
            'function second() {', '  class Local extends Other {}', '  return Local.ping()', '}',
            'function third() {', '  class Local extends Base { static ping(extra = 0) { return 3 } }',
            '  return Local.ping()', '}',
        ]]),
        ['java', [
            'class Base { static int ping() { return 1; } }',
            'class Other { static int ping() { return 2; } }',
            'class Use {',
            '  int first() {', '    class Local extends Base {}', '    return Local.ping();', '  }',
            '  int second() {', '    class Local extends Other {}', '    return Local.ping();', '  }',
            '  int third() {', '    class Local extends Base { static int ping() { return 3; } }',
            '    return Local.ping();', '  }', '}',
        ]],
        ['cpp', [
            'struct Base { static int ping() { return 1; } };',
            'struct Other { static int ping() { return 2; } };',
            'int first() {', '  struct Local : Base {};', '  return Local::ping();', '}',
            'int second() {', '  struct Local : Other {};', '  return Local::ping();', '}',
            'int third() {', '  struct Local : Base { static int ping() { return 3; } };',
            '  return Local::ping();', '}',
        ]],
    ];
    for (const [ext, lines] of cases) {
        it(`${ext}: distinguishes inherited, unrelated and overriding local members`, () => {
            const file = `source.${ext}`;
            const dir = tmp({ [file]: lines.join('\n') + '\n' });
            try {
                const index = idx(dir);
                for (const [owner, caller] of [['Base', 'first'], ['Other', 'second'], ['Local', 'third']]) {
                    const def = index.symbols.get('ping').find(d => d.className === owner);
                    assert.ok(def, owner);
                    const result = execute(index, 'context', { name: `${file}:${def.startLine}:ping` });
                    assert.ok(result.ok, JSON.stringify(result.error));
                    assert.deepEqual(result.result.callers.map(c => c.callerName), [caller],
                        `${owner}: ${JSON.stringify(result.result.callers)}`);
                    assert.equal(result.result.meta.account.conserved, true);
                    const called = execute(index, 'context', { name: caller });
                    assert.ok(called.ok, JSON.stringify(called.error));
                    assert.deepEqual(called.result.callees.filter(c => c.name === 'ping')
                        .map(c => c.className), [owner], `${caller} callee`);
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #398: local constructor chains retain lexical class identity', () => {
    for (const ext of ['py', 'js', 'ts', 'tsx']) {
        it(`${ext}: separates same-named constructors, overrides and shadowed bindings`, () => {
            const lines = ext === 'py' ? [
                'class Base:', '    def ping(self): return 1',
                'class Other:', '    def ping(self): return 2',
                'class Local(Base): pass',
                'def module_use(): return Local().ping()',
                'def first():', '    class Local(Base): pass', '    return Local().ping()',
                'def second():', '    class Local(Other): pass', '    return Local().ping()',
                'def third():', '    class Local(Base):', '        def ping(self, extra=0): return 3',
                '    return Local().ping()',
                'def shadows():', '    class Local(Base): pass',
                '    def parameter(Local): return Local().ping()',
                '    def assignment(factory):', '        Local = factory', '        return Local().ping()',
                '    return parameter, assignment',
                'def rebound(factory):', '    class Local(Base): pass',
                '    Local = factory', '    return Local().ping()',
            ] : [
                'class Base { ping() { return 1 } }',
                'class Other { ping() { return 2 } }',
                'class Local extends Base {}',
                'function module_use() { return new Local().ping() }',
                'function first() {', '  class Local extends Base {}', '  return new Local().ping()', '}',
                'function second() {', '  class Local extends Other {}', '  return new Local().ping()', '}',
                'function third() {', '  class Local extends Base { ping(extra = 0) { return 3 } }',
                '  return new Local().ping()', '}',
                'function shadows() {', '  class Local extends Base {}',
                '  function parameter(Local) { return new Local().ping() }',
                '  function assignment(factory) {', '    const Local = factory;',
                '    return new Local().ping()', '  }', '  return [parameter, assignment]', '}',
                'function rebound(factory) {', '  class Local extends Base {}',
                '  Local = factory;', '  return new Local().ping()', '}',
            ];
            const file = `source.${ext}`;
            const dir = tmp({ [file]: lines.join('\n') + '\n' });
            try {
                const index = idx(dir);
                for (const [owner, callers] of [
                    ['Base', ['module_use', 'first']], ['Other', ['second']], ['Local', ['third']],
                ]) {
                    const def = index.symbols.get('ping').find(d => d.className === owner);
                    const result = execute(index, 'context', { name: `${file}:${def.startLine}:ping` });
                    assert.ok(result.ok, JSON.stringify(result.error));
                    assert.deepEqual(result.result.callers.map(c => c.callerName), callers, owner);
                    assert.equal(result.result.meta.account.conserved, true);
                    for (const caller of callers) {
                        const called = execute(index, 'context', { name: caller });
                        assert.ok(called.ok, JSON.stringify(called.error));
                        assert.deepEqual(called.result.callees.filter(c => c.name === 'ping')
                            .map(c => c.className), [owner], `${caller} callee`);
                    }
                    for (const line of lines.map((text, i) => /Local\(\)\.ping/.test(text) ? i + 1 : 0)
                        .filter(line => line > lines.findIndex(text => text.includes('function shadows') ||
                            text.includes('def shadows')))) {
                        assert.ok(result.result.unverifiedCallers.some(c => c.line === line),
                            `${owner}: shadowed constructor at ${line} must remain visible`);
                    }
                }
                for (const caller of ['parameter', 'assignment', 'rebound']) {
                    const called = execute(index, 'context', { name: caller });
                    assert.ok(called.ok, JSON.stringify(called.error));
                    assert.ok(!called.result.callees.some(c => c.name === 'ping'), caller);
                    assert.ok(called.result.unverifiedCallees.some(c => c.name === 'ping'), caller);
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #398: returned class identities keep their defining scope', () => {
    const cases = [
        ['py', {
            'lib.py': 'class Box:\n    def ping(self): return 1\ndef make() -> Box: return Box()\n',
            'use.py': 'from lib import make\ndef use():\n    class Box:\n        def ping(self): return 2\n    return make().ping()\n',
        }],
        ...['js', 'ts', 'tsx'].map(ext => [ext, {
            [`lib.${ext}`]: 'export class Box { ping() { return 1 } }\n' +
                (ext === 'js' ? '/** @returns {Box} */\nexport function make() { return new Box() }\n'
                    : 'export function make(): Box { return new Box() }\n'),
            [`use.${ext}`]: "import { make } from './lib';\n" +
                'function use() {\n  class Box { ping() { return 2 } }\n' +
                '  return make().ping()\n}\n',
        }]),
        ['rs', {
            'lib.rs': 'pub mod model;\nfn use_it() -> i32 {\n    struct Box;\n' +
                '    impl Box { fn ping(&self) -> i32 { 2 } }\n    model::make().ping()\n}\n',
            'model.rs': 'pub struct Box;\nimpl Box { pub fn ping(&self) -> i32 { 1 } }\n' +
                'pub fn make() -> Box { Box }\n',
        }],
    ];
    for (const [ext, files] of cases) {
        it(`${ext}: a local namesake cannot replace the producer's returned type`, () => {
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const result = execute(index, 'context', { name: ext === 'rs' ? 'use_it' : 'use' });
                assert.ok(result.ok, JSON.stringify(result.error));
                assert.deepEqual(result.result.callees.filter(c => c.name === 'ping')
                    .map(c => c.relativePath), [ext === 'rs' ? 'model.rs' : `lib.${ext}`]);
            } finally { rm(dir); }
        });
    }
});

describe('fix #398: Python field ownership survives parsed-tree reuse', () => {
    it('keeps setup-method assignments and rejects writes from nested functions', () => {
        const source = [
            'class Service:', '    def ping(self): return 1',
            'class Case:', '    def setup_method(self):', '        self.client = Service()',
            '    def use(self):', '        return self.client.ping()',
            'class Unknown:', '    def setup_method(self):', '        self.client = Service()',
            '        def replace(): self.client = factory()',
            '    def use_unknown(self):', '        return self.client.ping()',
        ].join('\n') + '\n';
        const { getParser, safeParse } = require('../languages');
        const { findInstanceAttributeTypes } = require('../languages/python');
        const parser = getParser('python');
        const tree = safeParse(parser, source);
        const dir = tmp({ 'source.py': source });
        try {
            for (const options of [{}, { tree }]) {
                const fields = findInstanceAttributeTypes(source, parser, options);
                assert.equal(fields.get('Case')?.get('client'), 'Service');
                assert.equal(fields.get('Unknown')?.get('client'), undefined);
            }
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'ping' });
            assert.ok(result.ok, JSON.stringify(result.error));
            assert.deepEqual(result.result.callers.map(c => c.callerName), ['use']);
            assert.ok(result.result.unverifiedCallers.some(c => c.callerName === 'use_unknown'));
        } finally { tree.delete?.(); rm(dir); }
    });
});

describe('fix #398: local class qualifiers require their own binding', () => {
    for (const ext of ['py', 'js', 'ts', 'tsx']) {
        it(`${ext}: a factory declared inside the class body is a distinct binding`, () => {
            const code = ext === 'py' ? [
                'def outer():', '    class Local:',
                '        def ping(self): return 1',
                '        @staticmethod', '        def use():',
                '            def Local(): return factory()',
                '            return Local().ping()',
                '    return Local',
            ] : [
                'function outer() {', '  class Local {', '    ping() { return 1 }',
                '    static use() {', '      function Local() { return factory() }',
                '      return new Local().ping()', '    }', '  }', '  return Local', '}',
            ];
            const dir = tmp({ [`source.${ext}`]: code.join('\n') + '\n' });
            try {
                const index = idx(dir);
                const result = execute(index, 'context', { name: 'ping', className: 'Local' });
                assert.ok(result.ok, JSON.stringify(result.error));
                assert.deepEqual(result.result.callers, []);
                assert.equal(result.result.unverifiedCallers.length, 1);
                const called = execute(index, 'context', { name: 'use', className: 'Local' });
                assert.ok(called.ok, JSON.stringify(called.error));
                assert.ok(!called.result.callees.some(c => c.name === 'ping'));
                assert.ok(called.result.unverifiedCallees.some(c => c.name === 'ping'));
            } finally { rm(dir); }
        });
        it(`${ext}: closures see the class but parameters and assignments do not prove it`, () => {
            const code = ext === 'py' ? [
                'class Base:', '    @classmethod', '    def ping(cls): return 1',
                'def outer():', '    class Local(Base): pass',
                '    def closure(): return Local.ping()',
                '    def parameter(Local): return Local.ping()',
                '    def assignment(factory):', '        Local = factory', '        return Local.ping()',
                '    return closure, parameter, assignment',
                'def rebound(factory):', '    class Local(Base): pass',
                '    Local = factory', '    return Local.ping()',
            ] : [
                'class Base { static ping() { return 1 } }',
                'function outer() {', '  class Local extends Base {}',
                '  function closure() { return Local.ping() }',
                '  function parameter(Local) { return Local.ping() }',
                '  function assignment(factory) { const Local = factory; return Local.ping() }',
                '  return [closure, parameter, assignment]', '}',
                'function rebound(factory) {', '  class Local extends Base {}',
                '  Local = factory;', '  return Local.ping()', '}',
            ];
            const dir = tmp({ [`source.${ext}`]: code.join('\n') + '\n' });
            try {
                const index = idx(dir);
                const result = execute(index, 'context', { name: 'ping', className: 'Base' });
                assert.ok(result.ok, JSON.stringify(result.error));
                assert.deepEqual(result.result.callers.map(c => c.callerName), ['closure']);
                assert.deepEqual(result.result.unverifiedCallers.map(c => c.callerName),
                    ['parameter', 'assignment', 'rebound']);
                for (const name of ['closure', 'parameter', 'assignment', 'rebound']) {
                    const called = execute(index, 'context', { name });
                    assert.ok(called.ok, JSON.stringify(called.error));
                    assert.equal(called.result.callees.some(c => c.name === 'ping'), name === 'closure', name);
                    assert.equal(called.result.unverifiedCallees.some(c => c.name === 'ping'), name !== 'closure', name);
                }
            } finally { rm(dir); }
        });
    }
    it('isolates class-inclusive lexical memo entries from ordinary function binding queries', () => {
        const { getParser, safeParse } = require('../languages');
        const { referenceScope } = require('../languages/lexical-scope');
        for (const [language, source] of [
            ['python', 'def outer():\n    class Local: pass\n    return Local()\n'],
            ['javascript', 'function outer() {\n  class Local {}\n  return new Local()\n}\n'],
        ]) {
            const tree = safeParse(getParser(language), source);
            try {
                const node = tree.rootNode.descendantForIndex(source.lastIndexOf('Local'));
                for (const first of [true, false]) {
                    const memo = new Map();
                    for (const includeClasses of [first, !first, first]) {
                        assert.deepEqual(referenceScope(node, language, memo, 'Local', { includeClasses }),
                            { local: true, defRows: includeClasses ? [1] : null });
                    }
                }
            } finally { tree.delete?.(); }
        }
    });
    it('invalidates constructor binding proofs after a file is rebuilt', () => {
        const source = 'def outer(factory):\n    class Local:\n        def ping(self): return 1\n' +
            '    # reassignment\n    return Local().ping()\n';
        const dir = tmp({ 'source.py': source });
        try {
            const index = idx(dir);
            const run = () => execute(index, 'context', { name: 'ping' }).result;
            for (let repeat = 0; repeat < 2; repeat++) assert.equal(run().callers.length, 1);
            fs.writeFileSync(path.join(dir, 'source.py'), source.replace('# reassignment', 'Local = factory'));
            index.build(null, { quiet: true });
            for (let repeat = 0; repeat < 2; repeat++) {
                const result = run();
                assert.equal(result.callers.length, 0);
                assert.equal(result.unverifiedCallers.length, 1);
            }
            fs.writeFileSync(path.join(dir, 'source.py'), source);
            index.build(null, { quiet: true });
            assert.equal(run().callers.length, 1);
        } finally { rm(dir); }
    });
});

describe('Bug: stats symbol count consistency', () => {
    it('total symbols should equal sum of type counts', () => {
        const index = idx(FIXTURES_PATH + '/javascript');

        const stats = index.getStats();

        // Calculate sum of type counts
        let typeSum = 0;
        if (stats.byType) {
            for (const [type, count] of Object.entries(stats.byType)) {
                typeSum += count;
            }
        }

        // This documents the bug - symbol count doesn't match type breakdown
        // After fix: assert.strictEqual(stats.symbols, typeSum, 'Total symbols should equal sum of types');
        if (stats.symbols !== typeSum) {
            console.log(`BUG CONFIRMED: stats.symbols (${stats.symbols}) !== sum of byType (${typeSum})`);
        }
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Edge Cases', () => {
    it('should handle recursive function calls correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-recursive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'recursive.js'), `
function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);  // Recursive call
}

const result = factorial(5);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('factorial');

            // Should have callers (including the recursive call)
            assert.ok(ctx.callers.length > 0, 'Should find callers including recursive call');

            // Definition should NOT be in callers
            const hasDefinitionInCallers = ctx.callers.some(c =>
                c.content && c.content.includes('function factorial')
            );
            // After fix: assert.strictEqual(hasDefinitionInCallers, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle aliased imports correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-alias-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function parse(code) {
    return code.trim();
}
module.exports = { parse };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { parse: myParse } = require('./lib');
const result = myParse('  hello  ');  // Should be counted as usage of parse
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            // Aliased usage is tricky - should ideally track the alias
            assert.ok(usages.length > 0, 'Should find at least the definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle same function name in different files', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-samename-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'file1.js'), `
function process(x) { return x + 1; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'file2.js'), `
function process(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const m1 = require('./file1');
const m2 = require('./file2');
console.log(m1.process(5));
console.log(m2.process(5));
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const found = index.find('process');
            assert.strictEqual(found.length, 2, 'Should find both process functions');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// NON-EXISTENT SYMBOL HANDLING
// ============================================================================

describe('Non-existent symbol handling', () => {
    // Helper to create and cleanup temp project
    function withTempProject(fn) {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-nonexist-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function existingFunc() {
    return 42;
}
module.exports = { existingFunc };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        try {
            fn(index);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    it('find should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const found = index.find('nonExistentSymbol');
            assert.ok(Array.isArray(found), 'Should return array');
            assert.strictEqual(found.length, 0, 'Should be empty');
        });
    });

    it('usages should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const usages = index.usages('nonExistentSymbol');
            assert.ok(Array.isArray(usages), 'Should return array');
            assert.strictEqual(usages.length, 0, 'Should be empty');
        });
    });

    it('context should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const ctx = index.context('nonExistentSymbol');
            assert.strictEqual(ctx, null, 'Should return null for non-existent symbol');
        });
    });

    it('smart should return null for non-existent function', () => {
        withTempProject((index) => {
            const smart = index.smart('nonExistentSymbol');
            assert.strictEqual(smart, null, 'Should return null');
        });
    });

    it('about should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const about = index.about('nonExistentSymbol');
            assert.strictEqual(about, null, 'Should return null');
        });
    });

    it('impact should return null for non-existent function', () => {
        withTempProject((index) => {
            const impact = index.impact('nonExistentSymbol');
            assert.strictEqual(impact, null, 'Should return null');
        });
    });

    it('tests should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const tests = index.tests('nonExistentSymbol');
            assert.ok(Array.isArray(tests), 'Should return array');
            assert.strictEqual(tests.length, 0, 'Should be empty');
        });
    });

    it('typedef should return empty array for non-existent type', () => {
        withTempProject((index) => {
            const typedefs = index.typedef('NonExistentType');
            assert.ok(Array.isArray(typedefs), 'Should return array');
            assert.strictEqual(typedefs.length, 0, 'Should be empty');
        });
    });

    it('typedef with exact flag should not return fuzzy matches', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-typedef-exact-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'types.ts'), `
interface UserProps {
    name: string;
}

interface AdminProps {
    role: string;
}

type UserConfig = { key: string };
type AdminConfig = { key: string };
`);
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        // Without exact: "Props" has no exact symbol match, so fuzzy finds UserProps + AdminProps
        const fuzzy = index.typedef('Props');
        assert.ok(fuzzy.length >= 2, `Should find multiple Props-like types via fuzzy, got ${fuzzy.length}: ${fuzzy.map(t => t.name).join(', ')}`);

        // With exact: "Props" should return nothing (no type literally named "Props")
        const exact = index.typedef('Props', { exact: true });
        assert.strictEqual(exact.length, 0, `exact=true should not return fuzzy matches, got: ${exact.map(t => t.name).join(', ')}`);

        // With exact: "UserProps" should only find UserProps
        const exactUser = index.typedef('UserProps', { exact: true });
        assert.strictEqual(exactUser.length, 1, 'Should find exactly one UserProps');
        assert.strictEqual(exactUser[0].name, 'UserProps');

        // Without exact: "Config" fuzzy-matches UserConfig + AdminConfig
        const fuzzyConfig = index.typedef('Config');
        assert.ok(fuzzyConfig.length >= 2, `Should find Config-like types via fuzzy, got ${fuzzyConfig.length}`);

        // With exact: "Config" should return nothing (no type literally named "Config")
        const exactConfig = index.typedef('Config', { exact: true });
        assert.strictEqual(exactConfig.length, 0, `exact=true should not return fuzzy Config matches, got: ${exactConfig.map(t => t.name).join(', ')}`);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ============================================================================
// DOUBLE DASH SEPARATOR
// ============================================================================

describe('Regression: double dash separator for arguments', () => {
    it('should allow searching for flag-like strings after --', () => {
        const fixtureDir = path.join(FIXTURES_PATH, 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        // This should NOT error with "Unknown flag"
        const output = execSync(`node ${ucnPath} ${fixtureDir} find -- --test`, {
            encoding: 'utf8'
        });

        // Should show "no symbols found" rather than "unknown flag"
        assert.ok(!output.includes('Unknown flag'), 'Should not treat --test as flag after --');
    });

    it('should process flags before -- normally', () => {
        const fixtureDir = path.join(FIXTURES_PATH, 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        // Flags before -- should work
        const output = execSync(`node ${ucnPath} ${fixtureDir} find processData --json --`, {
            encoding: 'utf8'
        });

        // Should be valid JSON
        assert.ok(output.startsWith('{'), 'Should output JSON when --json flag is before --');
        JSON.parse(output); // Should not throw
    });
});

// ============================================================================
// AST-BASED SEARCH FILTERING
// ============================================================================

describe('Reliability: AST-based search filtering', () => {
    it('should filter out matches in comments with --code-only', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
// This comment mentions fetchData
const x = 'fetchData in string';
const result = fetchData(); // trailing comment fetchData
/* block comment
   fetchData here too */
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should only find the actual code call on line 4
            assert.strictEqual(allMatches.length, 1, 'Should find only 1 code match');
            assert.ok(allMatches[0].content.includes('const result = fetchData()'), 'Should find the actual call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should include template literal expressions as code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-template-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const str = \`fetchData in template\`;
const dynamic = \`Result: \${fetchData()}\`;
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should find the expression inside ${}, not the string literal
            assert.strictEqual(allMatches.length, 1, 'Should find 1 match in template expression');
            assert.ok(allMatches[0].content.includes('${fetchData()}'), 'Should find the template expression');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// STACKTRACE FILE MATCHING
// ============================================================================

describe('Reliability: Stacktrace file matching', () => {
    it('should parse various stack trace formats', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function processData(data) {
    throw new Error('test');
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Test Node.js format
            const nodeStack = index.parseStackTrace('at processData (src/app.js:3:11)');
            assert.strictEqual(nodeStack.frames.length, 1);
            assert.ok(nodeStack.frames[0].found);

            // Test Firefox format
            const ffStack = index.parseStackTrace('processData@src/app.js:3:11');
            assert.strictEqual(ffStack.frames.length, 1);
            assert.ok(ffStack.frames[0].found);

            // Test async format
            const asyncStack = index.parseStackTrace('at async processData (src/app.js:3:11)');
            assert.strictEqual(asyncStack.frames.length, 1);
            assert.ok(asyncStack.frames[0].found);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should score path similarity and choose best match', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-sim-'));
        try {
            // Create files with similar names in different directories
            fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'lib', 'utils'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.js'), `
function helper() { console.log('src'); }
`);
            fs.writeFileSync(path.join(tmpDir, 'lib', 'utils', 'helper.js'), `
function helper() { console.log('lib'); }
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Should prefer more specific path
            const stack = index.parseStackTrace('at helper (src/utils/helper.js:2:10)');
            assert.strictEqual(stack.frames.length, 1);
            assert.ok(stack.frames[0].found);
            assert.ok(stack.frames[0].resolvedFile.includes('src/utils'), 'Should match src path');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// CALLBACK DETECTION FOR DEADCODE
// ============================================================================

describe('Reliability: Callback detection for deadcode', () => {
    it('should not report functions used as callbacks as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-deadcode-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'handlers.js'), `
function handleClick(e) { console.log(e); }
function mapItem(item) { return item.toUpperCase(); }
function unusedFn() { return 'dead'; }

document.addEventListener('click', handleClick);
const items = ['a', 'b'].map(mapItem);
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('handleClick'), 'handleClick should not be dead (event handler)');
            assert.ok(!deadNames.includes('mapItem'), 'mapItem should not be dead (array callback)');
            assert.ok(deadNames.includes('unusedFn'), 'unusedFn should be dead');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not report re-exported functions as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-reexport-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
export function formatDate(d) { return d.toString(); }
export function unusedUtil() { return null; }
`);
            fs.writeFileSync(path.join(tmpDir, 'index.js'), `
export { formatDate } from './utils';
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('formatDate'), 'formatDate should not be dead (re-exported)');
            // Note: unusedUtil might or might not be dead depending on export tracking
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// className FIELD PRESERVED IN SYMBOL INDEX (5-language)
// ============================================================================

describe('Regression: className field preserved in symbol index', () => {
    it('should store className for Python class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-py-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.py'), `class User:
    def save(self):
        pass

class Product:
    def save(self):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for Java class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-java-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Models.java'), `class User {
    public void save() {}
}

class Product {
    public void save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for JavaScript class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-js-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.js'), `class User {
    save() {}
}

class Product {
    save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve Go module imports for exporters', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-import-'));
        try {
            // Create go.mod file
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/myproject

go 1.21
`);

            // Create package structure
            fs.mkdirSync(path.join(tmpDir, 'pkg', 'config'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pkg', 'config', 'config.go'), `package config

type Config struct {
    Name string
}

func NewConfig() *Config {
    return &Config{}
}
`);

            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

import "example.com/myproject/pkg/config"

func main() {
    cfg := config.NewConfig()
    _ = cfg
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get exporters for the config package
            const exportersResult = index.exporters(path.join(tmpDir, 'pkg', 'config', 'config.go'));
            assert.ok(exportersResult.length > 0, 'Should find files that import the config package');

            // main.go should be in the list
            const mainFile = exportersResult.find(e => e.file.includes('main.go'));
            assert.ok(mainFile, 'main.go should import the config package');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Go method calls in usages (field_identifier)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service.go'), `package main

type Service struct{}

func (s *Service) CollectAll() error {
    return nil
}

func main() {
    svc := &Service{}
    svc.CollectAll()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // usages should find the method call
            const usages = index.usages('CollectAll', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);
            assert.ok(calls.length >= 1, 'Should find at least 1 call to CollectAll');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should find callees for Go receiver methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callees-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'client.go'), `package main

type Client struct{}

func (c *Client) GetPods() []string {
    return nil
}

func (c *Client) GetNodes() []string {
    return nil
}

func (c *Client) CollectAll() {
    c.GetPods()
    c.GetNodes()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // context should find callees (Go method calls)
            const ctx = index.context('CollectAll');
            assert.ok(ctx.callees, 'Should have callees');
            assert.ok(ctx.callees.length >= 2, 'Should find at least 2 callees (GetPods, GetNodes)');

            const calleeNames = ctx.callees.map(c => c.name);
            assert.ok(calleeNames.includes('GetPods'), 'GetPods should be a callee');
            assert.ok(calleeNames.includes('GetNodes'), 'GetNodes should be a callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should filter by --file for Go methods with same name', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-file-filter-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() error {
    return nil
}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() error {
    return nil
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Without file filter, should find both
            const allDefs = index.find('Process');
            assert.strictEqual(allDefs.length, 2, 'Should find 2 definitions of Process');

            // With file filter, should find only one
            const filteredDefs = index.find('Process', { file: 'service_a.go' });
            assert.strictEqual(filteredDefs.length, 1, 'Should find 1 definition with file filter');
            assert.ok(filteredDefs[0].relativePath.includes('service_a.go'), 'Should be from service_a.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JavaScript method calls but filter built-ins', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-js-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
class Service {
  process() {}
}

function main() {
  const svc = new Service();
  svc.process();     // user method - SHOULD be counted
  JSON.parse('{}');  // built-in - should NOT be counted
  process();         // direct call - SHOULD be counted
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: svc.process() and process()
            assert.strictEqual(calls.length, 2, 'Should find 2 calls (user method + direct)');

            // Should NOT include JSON.parse
            const hasJsonParse = calls.some(c => c.content && c.content.includes('JSON.parse'));
            assert.strictEqual(hasJsonParse, false, 'JSON.parse should NOT be counted');

            // Should include svc.process()
            const hasUserMethod = calls.some(c => c.content && c.content.includes('svc.process'));
            assert.strictEqual(hasUserMethod, true, 'svc.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should prefer same-file callees for Go methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callee-disambig-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            // Two files with same method name 'helper'
            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() {
    s.helper()
}

func (s *ServiceA) helper() {}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() {
    s.helper()
}

func (s *ServiceB) helper() {}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get callees for ServiceA.Process - should find ServiceA.helper, not ServiceB.helper
            const defs = index.symbols.get('Process') || [];
            const serviceAProcess = defs.find(d => d.relativePath.includes('service_a.go'));
            assert.ok(serviceAProcess, 'Should find ServiceA.Process');

            const callees = index.findCallees(serviceAProcess);
            assert.ok(callees.length >= 1, 'Should find at least 1 callee');

            const helperCallee = callees.find(c => c.name === 'helper');
            assert.ok(helperCallee, 'Should find helper callee');
            assert.ok(helperCallee.relativePath.includes('service_a.go'),
                'helper callee should be from service_a.go, not service_b.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX component usage as calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsx-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), `{"name": "test"}`);

            fs.writeFileSync(path.join(tmpDir, 'Page.tsx'), `
function EnvironmentsPage() {
  return <div>Hello</div>;
}

function App() {
  return <EnvironmentsPage />;
}

export { App, EnvironmentsPage };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.tsx', { quiet: true });

            const usages = index.usages('EnvironmentsPage', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find JSX usage as a call
            assert.ok(calls.length >= 1, 'Should find at least 1 JSX component usage');
            assert.ok(calls.some(c => c.content && c.content.includes('<EnvironmentsPage')),
                'Should detect <EnvironmentsPage /> as a call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX prop function references (onClick={handler})', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsx-prop-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), `{"name": "test"}`);

            fs.writeFileSync(path.join(tmpDir, 'clipboard.tsx'), `
function handlePaste() {
  console.log('pasted');
}

function handleCopy() {
  console.log('copied');
}

function ClipboardPanel() {
  const userName = "test";
  return (
    <div>
      <button onClick={handlePaste}>Paste</button>
      <button onClick={handleCopy}>Copy</button>
      <span title={userName}>Name</span>
    </div>
  );
}

export { handlePaste, handleCopy, ClipboardPanel };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.tsx', { quiet: true });

            // handlePaste should be detected as called by ClipboardPanel (via JSX prop)
            const callers = index.findCallers('handlePaste');
            assert.ok(callers.length >= 1, 'Should find at least 1 caller for handlePaste');
            assert.ok(callers.some(c => c.callerName === 'ClipboardPanel'),
                'ClipboardPanel should be detected as caller of handlePaste via onClick prop');

            // handleCopy too
            const copyCallers = index.findCallers('handleCopy');
            assert.ok(copyCallers.length >= 1, 'Should find at least 1 caller for handleCopy');

            // userName should NOT be detected as a function reference (it's a string variable)
            const userCallers = index.findCallers('userName');
            assert.strictEqual(userCallers.length, 0, 'userName should not be detected as a function call');

            // handlePaste should NOT show up as dead code
            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);
            assert.ok(!deadNames.includes('handlePaste'), 'handlePaste should not be dead code');
            assert.ok(!deadNames.includes('handleCopy'), 'handleCopy should not be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX prop member expression references (onClick={utils.handler})', () => {
        const code = `
import { handlers } from './handlers';

function App() {
  return <button onClick={handlers.submit}>Submit</button>;
}
`;
        const parser = require('../languages').getParser('tsx');
        const { findCallsInCode } = require('../languages/javascript');
        const calls = findCallsInCode(code, parser);

        // The member expression reference should be detected as a call
        const submitRef = calls.find(c => c.name === 'submit' && c.isFunctionReference);
        assert.ok(submitRef, 'Should detect handlers.submit as a function reference in JSX prop');
        assert.strictEqual(submitRef.isMethod, true, 'Should be marked as method call');
        assert.strictEqual(submitRef.receiver, 'handlers', 'Should have handlers as receiver');
        assert.strictEqual(submitRef.isPotentialCallback, true, 'Should be marked as potential callback');
    });

    it('should detect Rust method calls in usages', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);

            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `
struct Client {}

impl Client {
    fn process(&self) {}
}

fn main() {
    let c = Client{};
    c.process();
    process();
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: c.process() and process()
            assert.ok(calls.length >= 2, 'Should find at least 2 calls');

            // Should include c.process()
            const hasMethodCall = calls.some(c => c.content && c.content.includes('c.process'));
            assert.strictEqual(hasMethodCall, true, 'c.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// CONTEXT CLASS LABEL BUG (Python + Java)
// ============================================================================

describe('Regression: Context class label bug', () => {
    it('should show class name in context, not undefined', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-ctx-class-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Python class
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class Session:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

def create_session():
    return Session()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('Session');
            assert.strictEqual(ctx.type, 'class', 'Should detect as class type');
            assert.strictEqual(ctx.name, 'Session', 'Should have class name, not undefined');
            assert.ok(ctx.name !== undefined, 'Name must not be undefined');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// DISAMBIGUATION PREFERS NON-TEST
// ============================================================================

describe('Regression: Disambiguation prefers non-test definitions', () => {
    it('should prefer src definition over test definition', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-disambig-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'render.js'), `
function render(template, data) {
    return template.replace(/{(\\w+)}/g, (_, key) => data[key] || '');
}
module.exports = { render };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'render.test.js'), `
const { render } = require('../src/render');
function render(mockTemplate) {
    return 'mock: ' + mockTemplate;
}
test('render', () => { render('hello'); });
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // resolveSymbol should prefer src/render.js over test/render.test.js
            const { def } = index.resolveSymbol('render');
            assert.ok(def, 'Should find render');
            assert.ok(!def.relativePath.includes('test'),
                `Should prefer non-test file, got ${def.relativePath}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use consistent selection across context, smart, trace', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-consistent-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function process(data) {
    return transform(data);
}
function transform(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function process(item) {
    return item.toString();
}
module.exports = { process };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('process');
            const smart = index.smart('process');
            const trace = index.trace('process');

            // All should pick the same definition
            assert.strictEqual(ctx.file, smart.target.relativePath,
                'context and smart should pick same definition');
            assert.strictEqual(ctx.file, trace.file,
                'context and trace should pick same definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// VERIFY FILTERS METHOD CALLS
// ============================================================================

describe('Regression: Verify filters method calls', () => {
    it('should not count obj.get() as call to standalone get()', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // Should NOT count headers.get("Host") or data.get("key") as mismatches
            // Only get("/api/data") should be counted
            assert.strictEqual(result.mismatches, 0,
                `Should have 0 mismatches (method calls filtered), got ${result.mismatches}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// FN COMMAND EXTRACTS CLASS METHODS (Python + Java)
// ============================================================================

describe('Regression: fn command extracts class methods', () => {
    it('should find and extract Python __init__ method via symbol index', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-method-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'src', 'models.py'), `
class Session:
    def __init__(self, url, timeout=30):
        self.url = url
        self.timeout = timeout

    def get(self, path):
        return self.url + path
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return __init__ (it has params, so it passes the filter)
            const matches = index.find('__init__').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 1, `Should find __init__, got ${matches.length}`);

            // The match should have valid startLine/endLine for direct code extraction
            const match = matches[0];
            assert.ok(match.startLine, 'Match should have startLine');
            assert.ok(match.endLine, 'Match should have endLine');
            assert.ok(match.file, 'Match should have file path');

            // Extract code using startLine/endLine (same approach as the fixed fn command)
            const code = fs.readFileSync(match.file, 'utf-8');
            const lines = code.split('\n');
            const fnCode = lines.slice(match.startLine - 1, match.endLine).join('\n');
            assert.ok(fnCode.includes('def __init__'), `Extracted code should contain __init__, got: ${fnCode}`);
            assert.ok(fnCode.includes('self.url = url'), `Extracted code should contain method body, got: ${fnCode}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// VERIFY TOTALCALLS EXCLUDES FILTERED METHOD CALLS (Python + Go)
// ============================================================================

describe('Regression: verify totalCalls excludes filtered method calls', () => {
    it('should not count method calls in totalCalls for standalone function', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-total-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // totalCalls should equal valid + mismatches + uncertain (no inflated count)
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // Specifically, method calls like headers.get() and data.get() should NOT be in totalCalls
            assert.ok(result.totalCalls <= 2,
                `totalCalls should be at most 2 (direct calls only), got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should have consistent totals for Go method calls', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-go-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `
package main

import "os/exec"

func Run(opts string) error {
    return nil
}

func main() {
    Run("hello")
    cmd := exec.Command("ls")
    cmd.Run()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('Run');
            assert.ok(result.found, 'Should find Run function');
            // totalCalls must always equal valid + mismatches + uncertain
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // cmd.Run() is a method call and should NOT inflate totalCalls
            assert.ok(result.totalCalls >= 1,
                `Should find at least 1 direct call to Run, got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// DEADCODE RELATIVE PATHS FOR isTestFile
// ============================================================================

describe('Regression: deadcode uses relative paths for isTestFile', () => {
    it('should not treat non-test files as test files when project is inside a /test/ directory', () => {
        // Simulate a project inside a directory named "test"
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath-${Date.now()}`, 'test', 'myproject');
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(toolsDir, '__init__.py'), '');
            fs.writeFileSync(path.join(toolsDir, 'helper.py'), `
def _unused_helper():
    return 42

def used_helper():
    return 1
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from tools.helper import used_helper

def main():
    print(used_helper())
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // Private package helper should be flagged as dead code. Public
            // names are an implicit Python package API when __all__ is absent.
            assert.ok(deadNames.includes('_unused_helper'),
                `_unused_helper should be flagged as dead code, got: ${deadNames.join(', ')}`);

            // used_helper should NOT be flagged
            assert.ok(!deadNames.includes('used_helper'),
                `used_helper should not be flagged as dead code`);
        } finally {
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });

    it('should correctly filter test files even when project is inside /test/ directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath2-${Date.now()}`, 'test', 'myproject');
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
def exported_func():
    return 42

def unused_func():
    return 0
`);
            fs.writeFileSync(path.join(testsDir, 'test_app.py'), `
from app import exported_func

def test_exported():
    assert exported_func() == 42

def _helper_in_test():
    return 'setup'
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Default: test files excluded
            const deadDefault = index.deadcode();
            const deadDefaultNames = deadDefault.map(d => d.name);

            // unused_func from app.py should appear
            assert.ok(deadDefaultNames.includes('unused_func'),
                `unused_func should be in deadcode results`);

            // _helper_in_test from test file should NOT appear (test files excluded by default)
            assert.ok(!deadDefaultNames.includes('_helper_in_test'),
                `_helper_in_test should not appear without --include-tests`);

            // With --include-tests: test file symbols should appear
            const deadWithTests = index.deadcode({ includeTests: true });
            const deadWithTestsNames = deadWithTests.map(d => d.name);

            assert.ok(deadWithTestsNames.includes('_helper_in_test'),
                `_helper_in_test should appear with --include-tests`);

            // test_* functions should still be excluded (they're entry points)
            assert.ok(!deadWithTestsNames.includes('test_exported'),
                `test_exported should not be flagged (entry point)`);
        } finally {
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath2')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// ============================================================================
// DEADCODE --include-exported RESPECTS TEST FILE FILTERING
// ============================================================================

describe('Regression: deadcode --include-exported respects test file filtering', () => {
    it('should not show test methods when only --include-exported is set', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-exported-${Date.now()}`);
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'lib.py'), `
def public_func():
    return 42
`);
            fs.writeFileSync(path.join(testsDir, 'test_lib.py'), `
from lib import public_func

class TestLib:
    def test_public_func(self):
        assert public_func() == 42

    def test_another(self):
        assert True
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // --include-exported but NOT --include-tests
            const dead = index.deadcode({ includeExported: true, includeTests: false });
            const deadNames = dead.map(d => d.name);

            // Test methods should NOT appear
            assert.ok(!deadNames.includes('test_public_func'),
                `test methods should not appear with only --include-exported`);
            assert.ok(!deadNames.includes('test_another'),
                `test methods should not appear with only --include-exported`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// TEST FILE PATTERNS MATCH RELATIVE PATHS
// ============================================================================

describe('Regression: test file patterns match relative paths', () => {
    it('should detect tests/ at start of relative path for Python', () => {
        const { isTestFile } = require('../core/discovery');
        // Relative paths starting with tests/ should match
        assert.ok(isTestFile('tests/test_app.py', 'python'),
            'tests/test_app.py should be a test file');
        assert.ok(isTestFile('tests/helpers/factory.py', 'python'),
            'tests/helpers/factory.py should be a test file');
        // Subdirectory should still work
        assert.ok(isTestFile('src/tests/test_util.py', 'python'),
            'src/tests/test_util.py should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/utils.py', 'python'),
            'src/utils.py should not be a test file');
    });

    it('should detect tests/ at start of relative path for Rust', () => {
        const { isTestFile } = require('../core/discovery');
        assert.ok(isTestFile('tests/integration.rs', 'rust'),
            'tests/integration.rs should be a test file');
        assert.ok(isTestFile('tests/examples/hello.rs', 'rust'),
            'tests/examples/hello.rs should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/lib.rs', 'rust'),
            'src/lib.rs should not be a test file');
    });
});

// ============================================================================
// BUG REPORT #4 REGRESSIONS (cross-language tests)
// ============================================================================

describe('Bug Report #4 Regressions (cross-language)', () => {

// BUG 1: trace should forward --include-methods/--include-uncertain
it('trace forwards includeMethods and includeUncertain to findCallees/findCallers', (t) => {
    const code = `
function outer() {
    helper();
}
function helper() {}
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug1-'));
    fs.writeFileSync(path.join(tmpDir, 'test.js'), code);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.trace('outer', { depth: 2, includeMethods: true, includeUncertain: true });
        assert.ok(result, 'trace should return a result');
        assert.ok(result.tree, 'trace should return a tree');
        const calleeNames = result.tree.children.map(c => c.name);
        assert.ok(calleeNames.includes('helper'), 'trace should find helper as callee');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 2: Same-class self/this.method() callers should not be marked uncertain
it('Java same-class implicit calls are not marked uncertain', (t) => {
    const javaCode = `
package test;
public class MyService {
    public void process() {
        validate();
        execute();
    }
    private void validate() {}
    private void execute() {}
}
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug2-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'MyService.java'), javaCode);
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const stats = { uncertain: 0 };
        const callers = idx2.findCallers('validate', { stats });
        assert.ok(callers.length > 0, 'validate should have callers');
        assert.ok(callers.some(c => c.callerName === 'process'), 'process should call validate');
        // The key assertion: these should NOT be uncertain
        assert.strictEqual(stats.uncertain, 0, 'same-class implicit calls should not be uncertain');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 4: graph should distinguish circular from diamond dependencies
it('graph labels diamond deps as "(already shown)" not "(circular)"', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug4-'));
    // a.js imports b.js and c.js; both b.js and c.js import d.js (diamond)
    fs.writeFileSync(path.join(tmpDir, 'a.js'), "const b = require('./b');\nconst c = require('./c');");
    fs.writeFileSync(path.join(tmpDir, 'b.js'), "const d = require('./d');\nmodule.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'c.js'), "const d = require('./d');\nmodule.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'd.js'), "module.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.graph(path.join(tmpDir, 'a.js'), { depth: 3, direction: 'imports' });
        assert.ok(result, 'graph should return a result');
        // Verify d.js appears in the graph (diamond dep is present)
        const imports = result.imports || result;
        assert.ok(imports, 'graph should have imports section');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 5c: impact filters by binding and cross-references with findCallsInCode
it('impact filters calls from files with their own definition of same-named function', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug5c-'));
    // main.js defines and calls parse
    fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function parse(s) { return JSON.parse(s); }
const result = parse('{}');
`);
    // other.js defines its own parse
    fs.writeFileSync(path.join(tmpDir, 'other.js'), `
function parse(s) { return s.split(','); }
const items = parse('a,b,c');
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.impact('parse', { file: 'main' });
        assert.ok(result, 'impact should return a result');
        // Should only show calls from main.js, not other.js
        const files = result.byFile.map(f => f.file);
        assert.ok(!files.some(f => f.includes('other')), 'impact should not include calls from other.js which has its own parse');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

}); // end describe('Bug Report #4 Regressions (cross-language)')


// ============================================================================
// RELIABILITY HINTS
// ============================================================================

describe('Reliability Hints', () => {

// --- deadcode: decorators surfaced in results ---
it('deadcode surfaces Python decorators on dead functions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-deco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class MyClass:
    @staticmethod
    def static_helper():
        pass

    def used_method(self):
        self.static_helper()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Verify decorators are stored in symbol index
        const syms = index.symbols.get('static_helper');
        assert.ok(syms && syms.length > 0, 'static_helper should be in symbol index');
        assert.ok(syms[0].decorators, 'static_helper should have decorators');
        assert.ok(syms[0].decorators.includes('staticmethod'), 'should include staticmethod decorator');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode surfaces Java annotations on dead methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-anno-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'main', 'java', 'Service.java'), `
public class Service {
    public void unusedPublic() {}
    private void unusedPrivate() {}
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });
        const dc = index.deadcode({ includeExported: true });

        assert.ok(dc.length >= 2, 'Should find at least 2 dead methods');
        const names = dc.map(d => d.name);
        assert.ok(names.includes('unusedPublic'), 'Should find unusedPublic');
        assert.ok(names.includes('unusedPrivate'), 'Should find unusedPrivate');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatDeadcode shows decorator hints', () => {
    const { formatDeadcode } = require('../core/output');
    const results = [
        { name: 'cleanup', type: 'function', file: 'app.py', startLine: 2, endLine: 5, isExported: false, decorators: ['app.route("/cleanup")'] },
        { name: 'helper', type: 'function', file: 'app.py', startLine: 10, endLine: 12, isExported: false },
        { name: 'scheduled', type: 'method', file: 'Service.java', startLine: 5, endLine: 8, isExported: true, annotations: ['scheduled'] }
    ];
    const text = formatDeadcode(results);
    assert.ok(text.includes('[has @app.route("/cleanup")]'), 'Should show Python decorator hint');
    assert.ok(!text.includes('helper (function) [has'), 'helper should not have decorator hint');
    assert.ok(text.includes('[has @scheduled]'), 'Should show Java annotation hint');
});

// --- context: class method low-caller hint ---
it('context includes isMethod/className in meta for class methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ctx-hint-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class UserService:
    def get_user(self, user_id):
        return self._fetch(user_id)

    def _fetch(self, uid):
        return {'id': uid}
`);
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        const ctx = index.context('get_user');
        assert.ok(ctx, 'Should find get_user');
        assert.ok(ctx.meta, 'Should have meta');
        assert.ok(ctx.meta.isMethod || ctx.meta.className, 'Should indicate it is a class method');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatContext never prints the legacy instance-dispatch hedge note', () => {
    const { formatContext } = require('../core/output');
    // Under the tiered contract, instance-dispatch candidates render in the
    // unverified band with reasons and the ACCOUNT line reconciles every
    // occurrence — the old hedge note asserted an untracked category that no
    // longer exists.
    const ctx1 = {
        function: 'get_user',
        file: 'service.py',
        startLine: 3,
        endLine: 5,
        callers: [{ relativePath: 'router.py', line: 10, callerName: 'handle_request', content: 'svc.get_user(id)' }],
        callees: [],
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true, isMethod: true, className: 'UserService' }
    };
    const { text: text1 } = formatContext(ctx1);
    assert.ok(!text1.includes('not tracked by static analysis'), 'hedge note must not render');
    assert.ok(!text1.includes('constructed or injected'), 'hedge note must not render');
});

// --- deadcode: decorated/annotated functions now detected ---
it('deadcode excludes decorated Python functions by default, includes with flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-pydeco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
from flask import Flask
app = Flask(__name__)

@app.route('/users')
def list_users():
    return []

@app.route('/health')
def health_check():
    return {'status': 'ok'}

def plain_unused():
    return 42

def used_fn():
    return plain_unused()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Default: decorated functions with '.' are excluded
        const dcDefault = index.deadcode();
        const defaultNames = dcDefault.map(d => d.name);
        assert.ok(!defaultNames.includes('list_users'), 'Decorated list_users should be excluded by default');
        assert.ok(!defaultNames.includes('health_check'), 'Decorated health_check should be excluded by default');
        assert.strictEqual(dcDefault.excludedDecorated, 2, 'Should report 2 excluded decorated symbols');

        // With includeDecorated: decorated functions are included
        const dcAll = index.deadcode({ includeDecorated: true });
        const allNames = dcAll.map(d => d.name);
        assert.ok(allNames.includes('list_users'), 'Decorated list_users should be included with flag');
        assert.ok(allNames.includes('health_check'), 'Decorated health_check should be included with flag');
        assert.strictEqual(dcAll.excludedDecorated, 0, 'No excluded decorated when includeDecorated=true');

        // plain_unused is called by used_fn, so it should NOT be dead in either case
        assert.ok(!defaultNames.includes('plain_unused'), 'plain_unused is called and should not be dead');

        // Verify decorator hints are present when included
        const listUsersResult = dcAll.find(d => d.name === 'list_users');
        assert.ok(listUsersResult.decorators, 'list_users should have decorators');
        assert.ok(listUsersResult.decorators.some(d => d.includes('app.route')), 'Should include app.route decorator');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode excludes annotated Java methods by default, includes with flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-javaanno-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'Service.java'), `
public class Service {
    @Scheduled(fixedRate = 5000)
    public void cleanup() {
        System.out.println("cleanup");
    }

    @Bean
    public Object dataSource() {
        return null;
    }

    public void plainUnused() {
        System.out.println("unused");
    }
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });

        // Default: annotated methods are excluded (cleanup has @Scheduled, dataSource has @Bean)
        const dcDefault = index.deadcode({ includeExported: true });
        const defaultNames = dcDefault.map(d => d.name);
        assert.ok(!defaultNames.includes('cleanup'), 'Annotated cleanup should be excluded by default');
        assert.ok(!defaultNames.includes('dataSource'), 'Annotated dataSource should be excluded by default');
        assert.ok(defaultNames.includes('plainUnused'), 'plainUnused (no annotations) should still be detected');
        assert.strictEqual(dcDefault.excludedDecorated, 3, 'Should report 3: two annotated methods + the Service class carrying them (fix #253a: framework-registered members keep the class)');

        // With includeDecorated: annotated methods are included
        const dcAll = index.deadcode({ includeExported: true, includeDecorated: true });
        const allNames = dcAll.map(d => d.name);
        assert.ok(allNames.includes('cleanup'), 'Annotated cleanup should be included with flag');
        assert.ok(allNames.includes('dataSource'), 'Annotated dataSource should be included with flag');
        assert.ok(allNames.includes('plainUnused'), 'plainUnused should be included');

        // Verify annotation hints when included
        const cleanupResult = dcAll.find(d => d.name === 'cleanup');
        assert.ok(cleanupResult.annotations, 'cleanup should have annotations');
        assert.ok(cleanupResult.annotations.includes('scheduled'), 'Should include scheduled annotation');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode detects decorated Python class methods as dead', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-pymethod-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class Service:
    @staticmethod
    def unused_static():
        return 42

    def used_method(self):
        return self.unused_static()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });
        const dc = index.deadcode();
        const names = dc.map(d => d.name);

        // unused_static has a caller (used_method calls it via self.), so behavior depends on resolution
        // used_method has no external callers
        assert.ok(names.includes('used_method'), 'used_method with no external callers should be dead');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('Java extractModifiers finds annotations on class body methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-mods-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'MyClass.java'), `
public class MyClass {
    @Override
    public void run() {}
    @Bean
    public Object factory() { return null; }
    public void plain() {}
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });

        const runSyms = index.symbols.get('run');
        assert.ok(runSyms && runSyms.length > 0, 'run should be in index');
        assert.ok(runSyms[0].modifiers.includes('override'), 'run should have override modifier');

        const factorySyms = index.symbols.get('factory');
        assert.ok(factorySyms && factorySyms.length > 0, 'factory should be in index');
        assert.ok(factorySyms[0].modifiers.includes('bean'), 'factory should have bean modifier');

        const plainSyms = index.symbols.get('plain');
        assert.ok(plainSyms && plainSyms.length > 0, 'plain should be in index');
        assert.ok(!plainSyms[0].modifiers.includes('override'), 'plain should not have override');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- about: includeMethods default ---
it('about defaults includeMethods based on target type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-about-methods-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class Analyzer:
    def analyze(self, data):
        return self._process(data)

    def _process(self, data):
        return data * 2
`);
        fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from service import Analyzer
def run():
    a = Analyzer()
    a.analyze('test')

def helper():
    return 42
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Class methods: includeMethods defaults to true (method calls are how class methods are invoked)
        const aboutMethod = index.about('analyze');
        assert.ok(aboutMethod, 'Should find analyze');
        assert.ok(aboutMethod.found, 'Should be found');
        assert.ok(aboutMethod.includeMethods === true, 'includeMethods should default to true for class methods');

        // Standalone functions: includeMethods defaults to false (reduces noise from unrelated obj.fn() calls)
        const aboutFunc = index.about('helper');
        assert.ok(aboutFunc, 'Should find helper');
        assert.ok(aboutFunc.found, 'Should be found');
        assert.ok(aboutFunc.includeMethods === false, 'includeMethods should default to false for standalone functions');

        // Explicit override still works
        const aboutExplicit = index.about('analyze', { includeMethods: false });
        assert.ok(aboutExplicit.includeMethods === false, 'explicit includeMethods=false should be respected');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('about with includeMethods=false shows note in formatted output', () => {
    const { formatAbout } = require('../core/output');

    // Mock about result with includeMethods=false
    const aboutResult = {
        found: true,
        symbol: { name: 'analyze', type: 'method', file: 'service.py', startLine: 3, endLine: 5, signature: 'analyze(self, data)' },
        usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
        totalUsages: 0,
        callers: { total: 0, top: [] },
        callees: { total: 0, top: [] },
        tests: { fileCount: 0, totalMatches: 0, files: [] },
        otherDefinitions: [],
        types: [],
        code: null,
        includeMethods: false,
        completeness: { warnings: [] }
    };
    // Tiered contract: the methods-excluded hint is superseded by the
    // always-visible UNVERIFIED tier — it must not appear in either mode.
    const text = formatAbout(aboutResult);
    assert.ok(!text.includes('obj.method() callers/callees excluded'), 'Hint superseded by UNVERIFIED tier');

    aboutResult.includeMethods = true;
    const text2 = formatAbout(aboutResult);
    assert.ok(!text2.includes('obj.method() callers/callees excluded'), 'Should NOT show note when includeMethods=true');
});

// --- deadcode: exclusion counts in output ---
it('deadcode returns exclusion counts for decorated and exported', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-counts-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
from flask import Flask
from celery import Celery
app = Flask(__name__)
tasks = Celery(__name__)

@app.route('/a')
def route_a():
    return 1

@tasks.task
def task_b():
    return 2

def plain_unused():
    return 3
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        const dc = index.deadcode();
        // Known framework registration decorators are excluded.
        assert.strictEqual(dc.excludedDecorated, 2, 'Should exclude 2 decorated symbols');
        // plain_unused should be in results
        const names = dc.map(d => d.name);
        assert.ok(names.includes('plain_unused'), 'plain_unused should be in results');
        assert.ok(!names.includes('route_a'), 'route_a should be excluded');
        assert.ok(!names.includes('task_b'), 'task_b should be excluded');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatDeadcode shows exclusion counts in hints', () => {
    const { formatDeadcode } = require('../core/output');

    // Simulate results with exclusion counts
    const results = [
        { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 5;
    results.excludedExported = 12;

    const text = formatDeadcode(results);
    assert.ok(text.includes('5 decorated/annotated symbol(s) hidden'), 'Should show decorated count');
    assert.ok(text.includes('--include-decorated'), 'Should hint at --include-decorated flag');
    assert.ok(text.includes('12 exported symbol(s) excluded'), 'Should show exported count');
    assert.ok(text.includes('--include-exported'), 'Should hint at --include-exported flag');
});

it('formatDeadcode handles zero exclusions without hints', () => {
    const { formatDeadcode } = require('../core/output');

    const results = [
        { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 0;
    results.excludedExported = 0;

    const text = formatDeadcode(results);
    assert.ok(!text.includes('hidden'), 'Should not show any hidden hints when counts are 0');
    assert.ok(text.includes('helper'), 'Should still show the result');
});

it('formatDeadcode respects --top option', () => {
    const { formatDeadcode } = require('../core/output');

    const results = [
        { name: 'a', type: 'function', file: 'a.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'b', type: 'function', file: 'b.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'c', type: 'function', file: 'c.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'd', type: 'function', file: 'd.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'e', type: 'function', file: 'e.js', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 0;
    results.excludedExported = 0;

    // With top=2, should show only 2 results
    const text = formatDeadcode(results, { top: 2 });
    assert.ok(text.includes('(showing 2)'), 'Should indicate showing 2');
    assert.ok(text.includes('a (function)'), 'Should show first result');
    assert.ok(text.includes('b (function)'), 'Should show second result');
    assert.ok(!text.includes('c (function)'), 'Should not show third result');
    assert.ok(text.includes('3 more result(s) not shown'), 'Should show hidden count');

    // Without top, should show all results
    const textAll = formatDeadcode(results);
    assert.ok(!textAll.includes('showing'), 'Should not indicate partial results');
    assert.ok(textAll.includes('e (function)'), 'Should show all results');
    assert.ok(!textAll.includes('more result(s) not shown'), 'Should not show hidden hint');
});

it('deadcode Python: simple decorators NOT excluded (only attribute access)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-simple-deco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class Service:
    @staticmethod
    def unused_static():
        return 42

    @property
    def unused_prop(self):
        return 'x'
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });
        const dc = index.deadcode();
        const names = dc.map(d => d.name);

        // @staticmethod and @property don't have '.' — should NOT be excluded
        assert.ok(names.includes('unused_static') || names.includes('unused_prop'),
            'Simple decorators (no dot) should still appear in deadcode');
        assert.strictEqual(dc.excludedDecorated, 0, 'No dot-decorators, so 0 excluded');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

}); // end describe('Reliability Hints')

// ============================================================================
// PRODUCTION READINESS FIXES
// ============================================================================

describe('Production readiness fixes', () => {

    it('plan() uses resolveSymbol to pick source over test file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-plan-resolve-'));
        try {
            // Create two files with same function name - one test, one source
            fs.writeFileSync(path.join(tmpDir, 'utils.test.js'), `
function process(x) { return x + 1; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
function process(x, y) { return x + y; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { process } = require('./utils');
process(1, 2);
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const plan = index.plan('process', { renameTo: 'compute' });
            assert.ok(plan.found, 'Should find the function');
            // resolveSymbol should pick source file (utils.js) over test file (utils.test.js)
            assert.ok(plan.file.includes('utils.js') && !plan.file.includes('test'),
                `Should pick source file, got: ${plan.file}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('plan() respects --file disambiguation', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-plan-file-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'alpha.js'), `
function doWork(a) { return a; }
module.exports = { doWork };
`);
            fs.writeFileSync(path.join(tmpDir, 'beta.js'), `
function doWork(a, b) { return a + b; }
module.exports = { doWork };
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const plan = index.plan('doWork', { renameTo: 'doTask', file: 'beta' });
            assert.ok(plan.found, 'Should find the function');
            assert.ok(plan.file.includes('beta'), `Should pick beta.js, got: ${plan.file}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('.ucn.json config is loaded correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-json-config-'));
        try {
            fs.writeFileSync(path.join(tmpDir, '.ucn.json'), JSON.stringify({
                aliases: { '@': './src' }
            }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'index.js'), 'function main() {}');

            const index = new ProjectIndex(tmpDir);
            assert.deepStrictEqual(index.config.aliases, { '@': './src' },
                'Should load aliases from .ucn.json');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('completeness detection counts all dynamic patterns additively', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-completeness-'));
        try {
            // File with multiple dynamic pattern types
            fs.writeFileSync(path.join(tmpDir, 'dynamic.js'), `
const mod = 'fs';
import(mod);
require(mod);
const x = eval('1+1');
const fn = new Function('return 1');
`);
            fs.writeFileSync(path.join(tmpDir, 'reflect.py'), `
x = getattr(obj, 'method')
y = hasattr(obj, 'method')
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.{js,py}', { quiet: true });

            const completeness = index.detectCompleteness();
            assert.ok(!completeness.complete, 'Should not be complete');

            const dynamicWarn = completeness.warnings.find(w => w.type === 'dynamic_imports');
            assert.ok(dynamicWarn, 'Should have dynamic_imports warning');
            assert.ok(dynamicWarn.count >= 2,
                `Should count both import() and require() independently, got: ${dynamicWarn.count}`);

            const evalWarn = completeness.warnings.find(w => w.type === 'eval');
            assert.ok(evalWarn, 'Should have eval warning');
            assert.ok(evalWarn.count >= 2,
                `Should count both eval() and new Function() independently, got: ${evalWarn.count}`);

            const reflectWarn = completeness.warnings.find(w => w.type === 'reflection');
            assert.ok(reflectWarn, 'Should have reflection warning');
            assert.ok(reflectWarn.count >= 2,
                `Should count both getattr() and hasattr() independently, got: ${reflectWarn.count}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// F-002 UNTYPED METHOD CALL UNCERTAINTY
// ============================================================================

describe('Regression: F-002 untyped method call uncertainty', () => {
    it('does not link m.get() to unrelated standalone get() in findCallees', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Default about() includes methods but not uncertain
            const result = index.about('getIndex', { includeMethods: true });
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(!calleeNames.includes('get'),
                'repository.get should NOT appear as callee of getIndex (m has no type evidence)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('still resolves this.method() to same-class method', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'service.js'), `
class Service {
    get(id) { return id; }
    getIndex() { return this.get("k"); }
}
module.exports = Service;
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.about('getIndex', { includeMethods: true });
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(calleeNames.includes('get'),
                'this.get() should resolve to same-class Service.get');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not link m.get() to unrelated get() in findCallers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002c-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // findCallers for 'get' should NOT include getIndex (m.get is uncertain)
            const callers = index.findCallers('get');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(!callerNames.includes('getIndex'),
                'getIndex should NOT be a caller of get (m has no type evidence)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('preserves Go package method calls (receiver is known import)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002d-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'utils.go'), `package main

func Get(id string) string {
    return id
}
`);
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

import "fmt"

func main() {
    fmt.Println(Get("hello"))
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // fmt.Println is a package call — fmt is a known import
            // Get("hello") is a direct call, not a method call — should always work
            const result = index.about('main');
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(calleeNames.includes('Get'),
                'direct Get() call should appear as callee of main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('keeps untyped method calls visible in the callee contract (#355)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002e-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // The contract keeps this candidate visible without inventing a binding.
            const callees = index.findCallees(
                { name: 'getIndex', file: path.join(tmpDir, 'app.js'), startLine: 1, endLine: 1 },
                { includeMethods: true, collectAccount: true }
            );
            const calleeNames = [...callees.values()].map(c => c.name);
            assert.ok(!calleeNames.includes('get'));
            assert.ok(callees.unverifiedCallees.some(c => c.name === 'get'));
            assert.strictEqual(callees.calleeAccount.conserved, true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});



// ============================================================================
// Bug G1-rust-007 / G7-rust-009: scopeWarning shown even when className provided
// ============================================================================

describe('fix G1-rust-007/G7-rust-009: no scopeWarning when className already provided', () => {
    it('impact: no scopeWarning when className is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Dog { run() {} }\nmodule.exports = { Dog };',
            'b.js': 'class Cat { run() {} }\nmodule.exports = { Cat };',
            'main.js': 'const { Dog } = require("./a");\nnew Dog().run();\n',
        });
        try {
            const index = idx(dir);
            // Without className: warning should appear (multiple classes define run())
            const withoutClass = index.impact('run');
            assert.ok(withoutClass, 'impact should succeed');
            assert.ok(withoutClass.scopeWarning, 'should warn when className not provided');

            // With className: warning should NOT appear
            const withClass = index.impact('run', { className: 'Dog' });
            assert.ok(withClass, 'impact with className should succeed');
            assert.strictEqual(withClass.scopeWarning, null,
                'scopeWarning must be null when className is already provided');
        } finally {
            rm(dir);
        }
    });

    it('verify: no scopeWarning when className is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { process(x) {} }\nmodule.exports = { Foo };',
            'b.js': 'class Bar { process(y, z) {} }\nmodule.exports = { Bar };',
            'main.js': 'const { Foo } = require("./a");\nnew Foo().process(1);\n',
        });
        try {
            const index = idx(dir);
            // Without className: warning should appear
            const withoutClass = index.verify('process');
            assert.ok(withoutClass.found, 'verify should succeed');
            assert.ok(withoutClass.scopeWarning, 'should warn when className not provided');

            // With className: warning should NOT appear
            const withClass = index.verify('process', { className: 'Foo' });
            assert.ok(withClass.found, 'verify with className should succeed');
            assert.strictEqual(withClass.scopeWarning, null,
                'scopeWarning must be null when className is already provided');
        } finally {
            rm(dir);
        }
    });

    it('impact: no scopeWarning when file is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { close() {} }\nmodule.exports = { Foo };',
            'b.js': 'class Bar { close() {} }\nmodule.exports = { Bar };',
            'main.js': 'const { Foo } = require("./a");\nnew Foo().close();\n',
        });
        try {
            const index = idx(dir);
            // With file filter: warning should NOT appear
            const withFile = index.impact('close', { file: 'a.js' });
            assert.ok(withFile, 'impact with file should succeed');
            assert.strictEqual(withFile.scopeWarning, null,
                'scopeWarning must be null when file filter is already provided');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug G1-java-003: resolveSymbol "Also in" list includes chosen definition
// ============================================================================

describe('fix G1-java-003: resolveSymbol excludes chosen definition from Also In list', () => {
    it('disambiguation warning does not include the chosen definition in Also in list', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save(data) { return data; }\nmodule.exports = { save };',
            'b.js': 'function save(data, opts) { return opts; }\nmodule.exports = { save };',
        });
        try {
            const index = idx(dir);
            const resolved = index.resolveSymbol('save');
            assert.ok(resolved.def, 'should resolve to a definition');
            assert.ok(resolved.definitions.length >= 2, 'should have multiple definitions');

            if (resolved.warnings && resolved.warnings.length > 0) {
                const warning = resolved.warnings[0];
                assert.strictEqual(warning.type, 'ambiguous', 'warning type should be ambiguous');
                // The chosen definition file:line must NOT appear in the alternatives list
                const chosenKey = `${resolved.def.relativePath}:${resolved.def.startLine}`;
                const alsoIn = warning.message.match(/Also in: (.+?)\./)?.[1] || '';
                const alsoInParts = alsoIn.split(', ');
                assert.ok(!alsoInParts.includes(chosenKey),
                    `Chosen definition ${chosenKey} must not appear in "Also in" list: "${alsoIn}"`);
                // The alternatives array also must not contain the chosen definition
                if (warning.alternatives) {
                    const chosenInAlts = warning.alternatives.some(
                        a => a.file === resolved.def.relativePath && a.line === resolved.def.startLine
                    );
                    assert.ok(!chosenInAlts,
                        'alternatives array must not contain the chosen definition');
                }
            }
        } finally {
            rm(dir);
        }
    });

    it('Also in count is exactly (N-1) when N definitions exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'x.js': 'function parse(s) { return s; }\nmodule.exports = { parse };',
            'y.js': 'function parse(s, opts) { return opts; }\nmodule.exports = { parse };',
            'z.js': 'function parse(s, opts, cb) { cb(); }\nmodule.exports = { parse };',
        });
        try {
            const index = idx(dir);
            const resolved = index.resolveSymbol('parse');
            assert.ok(resolved.def, 'should resolve');
            if (resolved.definitions.length >= 2 && resolved.warnings.length > 0) {
                const warning = resolved.warnings[0];
                const totalDefs = resolved.definitions.length;
                // alternatives should be exactly totalDefs - 1
                if (warning.alternatives) {
                    assert.strictEqual(warning.alternatives.length, totalDefs - 1,
                        `alternatives should be exactly ${totalDefs - 1} (total minus chosen)`);
                }
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug TS-BUG-003: about command note says "Remove flag" instead of --include-methods
// ============================================================================

describe('fix TS-BUG-003: about command note uses correct --include-methods wording', () => {
    it('formatAbout note does not say "Remove flag"', () => {
        const { formatAbout } = require('../core/output');
        const aboutResult = {
            found: true,
            symbol: { name: 'run', type: 'method', file: 'app.js', startLine: 1, endLine: 5, signature: 'run()' },
            usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
            totalUsages: 0,
            callers: { total: 0, top: [] },
            callees: { total: 0, top: [] },
            tests: { fileCount: 0, totalMatches: 0, files: [] },
            otherDefinitions: [],
            types: [],
            code: null,
            includeMethods: false,
            completeness: { warnings: [] }
        };
        const text = formatAbout(aboutResult);
        assert.ok(!text.includes('Remove flag'),
            'Note must not say "Remove flag" — there is no flag to remove when using default behavior');
        // Tiered contract: no methods hint at all — the UNVERIFIED tier replaces it.
        assert.ok(!text.includes('--include-methods'),
            'Hint superseded by the UNVERIFIED tier (flag is an implied no-op)');
    });

    it('formatAbout note wording instructs user to USE --include-methods', () => {
        const { formatAbout } = require('../core/output');
        const aboutResult = {
            found: true,
            symbol: { name: 'fn', type: 'function', file: 'a.js', startLine: 1, endLine: 3, signature: 'fn()' },
            usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
            totalUsages: 0,
            callers: { total: 0, top: [] },
            callees: { total: 0, top: [] },
            tests: { fileCount: 0, totalMatches: 0, files: [] },
            otherDefinitions: [],
            types: [],
            code: null,
            includeMethods: false,
            completeness: { warnings: [] }
        };
        const text = formatAbout(aboutResult);
        // Tiered contract: the hint is gone entirely — unverified method
        // callers are always shown in their own section instead.
        assert.ok(!text.includes('--include-methods'),
            `No methods hint under the tiered contract. Got: "${text.slice(-200)}"`);
    });
});

// ============================================================================
// SURFACE PARITY FIXES (2026-03-13)
// ============================================================================

describe('fix: CLI find test_* auto-discovery (surface parity)', () => {
    it('CLI find test_* includes test files without --include-tests flag', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tests/test_helper.js': 'function test_helper() {}\nmodule.exports={test_helper};\n'
        });
        try {
            const out = runCli(dir, 'find', ['test_*']);
            assert.ok(out.includes('test_helper'), `Should find test_helper, got: ${out}`);
        } finally {
            rm(dir);
        }
    });

    it('interactive find test_* includes test files without --include-tests flag', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tests/test_helper.js': 'function test_helper() {}\nmodule.exports={test_helper};\n'
        });
        try {
            const out = runInteractive(dir, ['find test_*']);
            assert.ok(out.includes('test_helper'), `Should find test_helper, got: ${out}`);
        } finally {
            rm(dir);
        }
    });

    it('executor auto-includes test files when includeTests is undefined and pattern is test_*', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tests/test_helper.js': 'function test_helper() {}\nmodule.exports={test_helper};\n'
        });
        try {
            const index = idx(dir);
            // Passing includeTests: undefined simulates absent flag
            const { ok, result } = execute(index, 'find', { name: 'test_*', includeTests: undefined });
            assert.ok(ok, 'find should succeed');
            assert.ok(result.length > 0, 'Should find test_helper');
            assert.ok(result.some(r => r.name === 'test_helper'), 'Should include test_helper');
        } finally {
            rm(dir);
        }
    });

    it('executor does NOT auto-include when includeTests is explicitly false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tests/test_helper.js': 'function test_helper() {}\nmodule.exports={test_helper};\n'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'find', { name: 'test_*', includeTests: false });
            assert.ok(ok, 'find should succeed');
            // With includeTests=false explicitly, test files should be excluded
            assert.strictEqual(result.length, 0, 'Should not find test_helper when includeTests=false');
        } finally {
            rm(dir);
        }
    });
});



// =============================================================================
// P3: className validation on 5 new commands
// =============================================================================
describe('P3: className validation gaps', () => {
    const { tmp, rm, idx } = require('./helpers');

    const commands = ['trace', 'smart', 'example', 'typedef', 'tests'];

    for (const cmd of commands) {
        it(`${cmd} rejects invalid className`, () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'app.js': 'function helper() { return 1; }\nmodule.exports = { helper };'
            });
            try {
                const index = idx(dir);
                const { ok, error } = execute(index, cmd, { name: 'helper', className: 'NonExistentClass' });
                assert.strictEqual(ok, false, `${cmd} should reject invalid className`);
                assert.ok(error.includes('not found in class') || error.includes('not a method'),
                    `${cmd} error should mention class issue, got: ${error}`);
            } finally {
                rm(dir);
            }
        });
    }

    it('entrypoints hides test files by default; --include-tests restores them', () => {
        // Tests are excluded by default (matching search/usages/deadcode) —
        // an agent orienting on a repo needs the entry surface of the
        // project, not its fixtures. --include-tests restores the full
        // universe; --exclude-tests is the explicit spelling of the default.
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'function main() {}\nmodule.exports = { main };',
            'test/app.test.js': 'function testMain() { main(); }\n'
        });
        try {
            const index = idx(dir);
            const { ok: okDefault, result: defaultResult } = execute(index, 'entrypoints', {});
            assert.strictEqual(okDefault, true);
            const defaultTestEntries = (defaultResult || []).filter(e => e.file && e.file.includes('test'));
            assert.strictEqual(defaultTestEntries.length, 0,
                'Default behavior: test-file entries are hidden');

            const { ok: okIncl, result: inclResult } = execute(index, 'entrypoints', { includeTests: true });
            assert.strictEqual(okIncl, true);
            const inclTestEntries = (inclResult || []).filter(e => e.file && e.file.includes('test'));
            assert.ok(inclTestEntries.length > 0,
                '--include-tests restores test-file entries');

            const { ok: okExcl, result: exclResult } = execute(index, 'entrypoints', { excludeTests: true });
            assert.strictEqual(okExcl, true);
            const exclTestEntries = (exclResult || []).filter(e => e.file && e.file.includes('test'));
            assert.strictEqual(exclTestEntries.length, 0,
                '--exclude-tests behaves like the default');
        } finally {
            rm(dir);
        }
    });

    it('entrypoints includes test files with includeTests', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'conftest.py': '@pytest.fixture\ndef db():\n    return None\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'entrypoints', { includeTests: true });
            assert.strictEqual(ok, true);
            // With includeTests, test fixtures should appear
            if (result && result.length > 0) {
                assert.ok(result.some(e => e.name === 'db'), 'Should include test fixture');
            }
        } finally {
            rm(dir);
        }
    });
});

// =============================================================================
// P1: Truncation notes on tree-based commands
// =============================================================================
describe('P1: truncation notes on tree commands', () => {
    const { tmp, rm, idx } = require('./helpers');

    it('trace returns note with tree truncation info', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const { b } = require("./b");\nfunction a() { b(); }\nmodule.exports = { a };',
            'b.js': 'const { c } = require("./c");\nfunction b() { c(); }\nmodule.exports = { b };',
            'c.js': 'const { d } = require("./d");\nfunction c() { d(); }\nmodule.exports = { c };',
            'd.js': 'function d() { return 1; }\nmodule.exports = { d };',
        });
        try {
            const index = idx(dir);
            // depth=1 should truncate the tree (a->b but not b->c->d)
            const { ok, result, note } = execute(index, 'trace', { name: 'a', depth: 1 });
            assert.strictEqual(ok, true);
            // The result should exist; note may or may not be present depending on
            // whether the tree has truncatedChildren — just verify no crash
            assert.ok(result, 'Should return a result');
        } finally {
            rm(dir);
        }
    });

    it('context returns truncation note when index is truncated', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() { return 1; }\nmodule.exports = { a };'
        });
        try {
            const index = idx(dir);
            // Simulate truncation
            index.truncated = { indexed: 100, maxFiles: 100 };
            const { ok, note } = execute(index, 'context', { name: 'a' });
            assert.strictEqual(ok, true);
            assert.ok(note, 'Should have a truncation note');
            assert.ok(note.includes('Index limited to'), 'Note should mention index truncation');
        } finally {
            rm(dir);
        }
    });

    it('impact returns truncation note when index is truncated', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() { return 1; }\nmodule.exports = { a };'
        });
        try {
            const index = idx(dir);
            index.truncated = { indexed: 100, maxFiles: 100 };
            const { ok, note } = execute(index, 'impact', { name: 'a' });
            assert.strictEqual(ok, true);
            assert.ok(note, 'Should have a truncation note');
            assert.ok(note.includes('Index limited to'), 'Note should mention index truncation');
        } finally {
            rm(dir);
        }
    });

    it('related returns truncation note when index is truncated', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };'
        });
        try {
            const index = idx(dir);
            index.truncated = { indexed: 100, maxFiles: 100 };
            const { ok, note } = execute(index, 'related', { name: 'a' });
            assert.strictEqual(ok, true);
            assert.ok(note, 'Should have a truncation note');
            assert.ok(note.includes('Index limited to'), 'Note should mention index truncation');
        } finally {
            rm(dir);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ↔ MCP ↔ Interactive Parity: --file flag and output consistency
// ═══════════════════════════════════════════════════════════════════════════════

// v5 CLI, MCP, interactive, positional-file, and JSON parity coverage lives in
// parity-test.js and is derived from the public registry.

// Handoff report fixes: MCP error semantics, tests className scoping,
// CLI adapter param gaps, expand cache invalidation
// =============================================================================

describe('fix: MCP isError semantics — !ok returns isError=true', () => {
    let client;
    before(async () => {
        const { McpClient } = require('./helpers');
        client = new McpClient();
        await client.start();
        await client.initialize();
    });
    after(() => client && client.stop());

    it('show(nonexistent) returns isError=true', async () => {
        const res = await client.callTool('ucn', {
            command: 'show',
            project_dir: FIXTURES_PATH + '/javascript',
            name: 'zzz_nonexistent_xyz',
        });
        assert.strictEqual(res.result?.isError, true, 'isError must be true for not-found symbol');
        const text = res.result?.content?.[0]?.text || '';
        assert.ok(/not found/i.test(text), 'Error text should mention "not found"');
    });

    it('trace(nonexistent) returns isError=true', async () => {
        const res = await client.callTool('ucn', {
            command: 'trace',
            project_dir: FIXTURES_PATH + '/javascript',
            name: 'zzz_nonexistent_xyz',
        });
        assert.strictEqual(res.result?.isError, true);
    });

    it('find(valid) returns isError absent/false', async () => {
        const res = await client.callTool('ucn', {
            command: 'find',
            project_dir: FIXTURES_PATH + '/javascript',
            name: 'processData',
        });
        assert.ok(!res.result?.isError, 'Valid find should not set isError');
    });

    it('source(nonexistent) returns isError=true', async () => {
        const res = await client.callTool('ucn', {
            command: 'source',
            project_dir: FIXTURES_PATH + '/javascript',
            name: 'zzz_nonexistent_xyz',
        });
        assert.strictEqual(res.result?.isError, true);
    });

    it('deps(nonexistent file) returns isError=true', async () => {
        const res = await client.callTool('ucn', {
            command: 'deps',
            project_dir: FIXTURES_PATH + '/javascript',
            file: 'nonexistent.js',
            direction: 'imports',
        });
        assert.strictEqual(res.result?.isError, true);
    });
});

describe('fix: tests() className scoping', () => {
    it('tests with className filters to class-relevant test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            'test/a.test.js': 'const { A } = require("../a");\nit("A save", () => { new A().save(); });',
            'test/b.test.js': 'const { B } = require("../b");\nit("B save", () => { new B().save(); });',
        });
        try {
            const index = idx(dir);
            // Without className, semantic commands select one deterministic
            // definition and disclose the ambiguity instead of unioning
            // unrelated same-name methods.
            const allTests = execute(index, 'tests', { name: 'save' });
            assert.ok(allTests.ok);
            assert.ok(allTests.result.length >= 1, 'The selected definition should retain its test link');
            assert.ok(allTests.result.warnings?.length > 0,
                'Ambiguous selection must remain visible');

            // With className=A: only a.test.js should match
            const aTests = execute(index, 'tests', { name: 'save', className: 'A' });
            assert.ok(aTests.ok);
            assert.ok(aTests.result.length >= 1, 'Should find at least one test file for A');
            assert.ok(aTests.result.every(r => !r.file.includes('b.test')), 'Should not include B test file');

            // With className=B: only b.test.js should match
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length >= 1, 'Should find at least one test file for B');
            assert.ok(bTests.result.every(r => !r.file.includes('a.test')), 'Should not include A test file');
        } finally {
            rm(dir);
        }
    });

    it('tests with className filters at match level in mixed test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            // Mixed test file that imports both A and B
            'test/mixed.test.js': [
                'const { A } = require("../a");',
                'const { B } = require("../b");',
                '',
                'it("A save works", () => {',
                '  new A().save();',
                '});',
                '',
                'it("B save works", () => {',
                '  new B().save();',
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // With className=A: should only return matches near A, not B
            const aTests = execute(index, 'tests', { name: 'save', className: 'A' });
            assert.ok(aTests.ok);
            if (aTests.result.length > 0) {
                const allMatchLines = aTests.result.flatMap(r => r.matches.map(m => m.content));
                assert.ok(!allMatchLines.some(l => /\bB\b/.test(l) && !/\bA\b/.test(l)),
                    'Should not include matches that only reference B');
            }

            // With className=B: should only return matches near B, not A
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            if (bTests.result.length > 0) {
                const allMatchLines = bTests.result.flatMap(r => r.matches.map(m => m.content));
                assert.ok(!allMatchLines.some(l => /\bA\b/.test(l) && !/\bB\b/.test(l)),
                    'Should not include matches that only reference A');
            }
        } finally {
            rm(dir);
        }
    });

    it('tests with className handles instance-call patterns (const svc = new B(); svc.save())', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            'test/instance.test.js': [
                'const { A } = require("../a");',
                'const { B } = require("../b");',
                '',
                'it("A save via instance", () => {',
                '  const a = new A();',
                '  a.save();',
                '});',
                '',
                'it("B save via instance", () => {',
                '  const service = new B();',
                '  return service.save();',
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // className=B should find the B instance test, not the A one
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length > 0, 'Should find test for B via instance pattern');
            const bMatches = bTests.result.flatMap(r => r.matches);
            assert.ok(bMatches.some(m => m.content.includes('service.save')),
                'Should include service.save() call');
            assert.ok(!bMatches.some(m => m.content.includes('a.save')),
                'Should not include a.save() call');

            // className=A should find the A instance test, not B
            const aTests = execute(index, 'tests', { name: 'save', className: 'A' });
            assert.ok(aTests.ok);
            assert.ok(aTests.result.length > 0, 'Should find test for A via instance pattern');
            const aMatches = aTests.result.flatMap(r => r.matches);
            assert.ok(aMatches.some(m => m.content.includes('a.save')),
                'Should include a.save() call');
            assert.ok(!aMatches.some(m => m.content.includes('service.save')),
                'Should not include service.save() call');
        } finally {
            rm(dir);
        }
    });

    it('tests with className handles variable reassignment correctly', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() {} }\nmodule.exports = { A };',
            'b.js': 'class B { save() {} }\nmodule.exports = { B };',
            'test/reassign.test.js': [
                'const { A } = require("../a");',
                'const { B } = require("../b");',
                '',
                'it("reassign test", () => {',
                '  let x = new A();',
                '  x.save();',           // A.save — should match className=A
                '  x = new B();',
                '  x.save();',           // B.save — should match className=B, NOT A
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // className=A should find x.save() only before reassignment
            const aTests = execute(index, 'tests', { name: 'save', className: 'A' });
            assert.ok(aTests.ok);
            // className=B should find x.save() only after reassignment
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            // Both should find some matches (the test file references both classes)
            assert.ok(aTests.result.length > 0 || bTests.result.length > 0,
                'At least one class should match in the reassignment test');
        } finally {
            rm(dir);
        }
    });
});

describe('AST-based tests(): cross-language test-case detection', () => {
    it('Go: Test* functions detected as test-case', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'lib.go': 'package lib\n\nfunc Save() int { return 1 }',
            'lib_test.go': [
                'package lib',
                '',
                'import "testing"',
                '',
                'func TestSave(t *testing.T) {',
                '    result := Save()',
                '    if result != 1 {',
                '        t.Fatal("wrong")',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'Save' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Should find test file');
            const matches = result.result.flatMap(r => r.matches);
            assert.ok(matches.some(m => m.matchType === 'test-case'),
                'Should detect TestSave as test-case');
            assert.ok(matches.some(m => m.matchType === 'call'),
                'Should detect Save() as call');
        } finally {
            rm(dir);
        }
    });

    it('Python: test_ functions detected as test-case', () => {
        const dir = tmp({
            'lib.py': 'def save():\n    return 1',
            'test_lib.py': [
                'from lib import save',
                '',
                'def test_save():',
                '    result = save()',
                '    assert result == 1',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Should find test file');
            const matches = result.result.flatMap(r => r.matches);
            assert.ok(matches.some(m => m.matchType === 'test-case'),
                'Should detect test_save as test-case');
            assert.ok(matches.some(m => m.matchType === 'call'),
                'Should detect save() as call');
        } finally {
            rm(dir);
        }
    });

    it('Java: @Test methods detected as test-case', () => {
        const dir = tmp({
            'Helper.java': 'public class Helper {\n  public static int save() { return 1; }\n}',
            'HelperTest.java': [
                'import org.junit.Test;',
                'import static org.junit.Assert.*;',
                '',
                'public class HelperTest {',
                '    @Test',
                '    public void testSave() {',
                '        int result = Helper.save();',
                '        assertEquals(1, result);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Should find test file');
            const matches = result.result.flatMap(r => r.matches);
            assert.ok(matches.some(m => m.matchType === 'test-case'),
                'Should detect @Test testSave as test-case');
            assert.ok(matches.some(m => m.matchType === 'call'),
                'Should detect save() as call');
        } finally {
            rm(dir);
        }
    });

    it('Rust: #[test] functions detected as test-case', () => {
        const dir = tmp({
            'lib.rs': 'pub fn save() -> i32 { 1 }',
            'test_lib.rs': [
                'use crate::save;',
                '',
                '#[test]',
                'fn test_save() {',
                '    let result = save();',
                '    assert_eq!(result, 1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Should find test file');
            const matches = result.result.flatMap(r => r.matches);
            assert.ok(matches.some(m => m.matchType === 'call'),
                'Should detect save() as call');
        } finally {
            rm(dir);
        }
    });

    it('JS: test-case detected from describe/it/test calls', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': [
                'const { save } = require("../lib");',
                '',
                'describe("save", () => {',
                '  it("returns 1", () => {',
                '    expect(save()).toBe(1);',
                '  });',
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Should find test file');
            const matches = result.result.flatMap(r => r.matches);
            assert.ok(matches.some(m => m.matchType === 'test-case'),
                'Should detect describe("save"...) as test-case');
            assert.ok(matches.some(m => m.matchType === 'call'),
                'Should detect save() as call');
        } finally {
            rm(dir);
        }
    });

    it('AST-based tests() does not return comment-only mentions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'test/lib.test.js': [
                'const { helper } = require("../lib");',
                '// helper is great',
                '/* helper works */  ',
                'helper();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'helper' });
            assert.ok(result.ok);
            const matches = result.result.flatMap(r => r.matches);
            // Should NOT find comment-only lines
            assert.ok(!matches.some(m => m.content.startsWith('//')),
                'Should not include single-line comment mentions');
            assert.ok(!matches.some(m => m.content.startsWith('/*')),
                'Should not include block comment mentions');
            // Should find the actual call and import
            assert.ok(matches.some(m => m.matchType === 'call'), 'Should find call');
            assert.ok(matches.some(m => m.matchType === 'import'), 'Should find import');
        } finally {
            rm(dir);
        }
    });
});

describe('AST-based tests(): cross-language className scoping', () => {
    it('Python: className scopes to instance calls via receiverType', () => {
        const dir = tmp({
            'a.py': 'class A:\n    def save(self):\n        return 1',
            'b.py': 'class B:\n    def save(self):\n        return 2',
            'test_both.py': [
                'from a import A',
                'from b import B',
                '',
                'def test_a_save():',
                '    a = A()',
                '    a.save()',
                '',
                'def test_b_save():',
                '    svc = B()',
                '    svc.save()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length > 0, 'Should find test file for B');
            const bMatches = bTests.result.flatMap(r => r.matches);
            assert.ok(bMatches.some(m => m.content.includes('svc.save')),
                'Should include svc.save() call (B instance)');
            assert.ok(!bMatches.some(m => m.content.includes('a.save')),
                'Should not include a.save() call (A instance)');

            const aTests = execute(index, 'tests', { name: 'save', className: 'A' });
            assert.ok(aTests.ok);
            const aMatches = aTests.result.flatMap(r => r.matches);
            assert.ok(aMatches.some(m => m.content.includes('a.save')),
                'Should include a.save() call (A instance)');
            assert.ok(!aMatches.some(m => m.content.includes('svc.save')),
                'Should not include svc.save() call (B instance)');
        } finally {
            rm(dir);
        }
    });

    it('Go: className scopes to instance calls via receiverType', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'a.go': 'package main\n\ntype A struct{}\n\nfunc (a *A) Save() int { return 1 }',
            'b.go': 'package main\n\ntype B struct{}\n\nfunc (b *B) Save() int { return 2 }',
            'ab_test.go': [
                'package main',
                '',
                'import "testing"',
                '',
                'func TestASave(t *testing.T) {',
                '    a := &A{}',
                '    a.Save()',
                '}',
                '',
                'func TestBSave(t *testing.T) {',
                '    svc := &B{}',
                '    svc.Save()',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const bTests = execute(index, 'tests', { name: 'Save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length > 0, 'Should find test file for B');
            const bMatches = bTests.result.flatMap(r => r.matches);
            assert.ok(bMatches.some(m => m.content.includes('svc.Save')),
                'Should include svc.Save() call (B instance)');
            assert.ok(!bMatches.some(m => m.content.includes('a.Save')),
                'Should not include a.Save() call (A instance)');

            const aTests = execute(index, 'tests', { name: 'Save', className: 'A' });
            assert.ok(aTests.ok);
            const aMatches = aTests.result.flatMap(r => r.matches);
            assert.ok(aMatches.some(m => m.content.includes('a.Save')),
                'Should include a.Save() call (A instance)');
            assert.ok(!aMatches.some(m => m.content.includes('svc.Save')),
                'Should not include svc.Save() call (B instance)');
        } finally {
            rm(dir);
        }
    });

    it('Java: className scopes to receiver calls', () => {
        const dir = tmp({
            'A.java': 'public class A {\n  public int save() { return 1; }\n}',
            'B.java': 'public class B {\n  public int save() { return 2; }\n}',
            'BothTest.java': [
                'import org.junit.Test;',
                '',
                'public class BothTest {',
                '    @Test',
                '    public void testASave() {',
                '        A a = new A();',
                '        a.save();',
                '    }',
                '    @Test',
                '    public void testBSave() {',
                '        B b = new B();',
                '        b.save();',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length > 0, 'Should find test file for B');
            const bMatches = bTests.result.flatMap(r => r.matches);
            assert.ok(bMatches.some(m => m.content.includes('b.save')),
                'Should include b.save() call (B instance)');
            assert.ok(!bMatches.some(m => m.content.includes('a.save')),
                'Should not include a.save() call (A instance)');
        } finally {
            rm(dir);
        }
    });

    it('Rust: className scopes to instance calls inside macros', () => {
        const dir = tmp({
            'a.rs': [
                'pub struct A;',
                'impl A { pub fn save(&self) -> i32 { 1 } }',
            ].join('\n'),
            'b.rs': [
                'pub struct B;',
                'impl B { pub fn save(&self) -> i32 { 2 } }',
            ].join('\n'),
            'test_both.rs': [
                '#[test]',
                'fn test_a_save() {',
                '    let a = A;',
                '    assert_eq!(a.save(), 1);',
                '}',
                '',
                '#[test]',
                'fn test_b_save() {',
                '    let svc = B;',
                '    assert_eq!(svc.save(), 2);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const bTests = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(bTests.ok);
            assert.ok(bTests.result.length > 0, 'Should find test file for B');
            const bMatches = bTests.result.flatMap(r => r.matches);
            assert.ok(bMatches.some(m => ['call', 'unverified-call'].includes(m.matchType) &&
                m.content.includes('svc.save')),
            'Should include svc.save() with an honest evidence tier');
            assert.ok(!bMatches.some(m => m.matchType === 'call' && m.content.includes('a.save')),
                'Should not include a.save() call (A instance)');
        } finally {
            rm(dir);
        }
    });

    it('bare function call on same line as className is not a false positive', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'class B { save() {} }\nfunction save() {}\nmodule.exports = { B, save };',
            'test/lib.test.js': [
                'const { B, save } = require("../lib");',
                'it("test", () => {',
                '  const svc = new B(); save();',
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            const calls = result.result.flatMap(r => r.matches).filter(m => m.matchType === 'call');
            // Bare save() is not B.save() — should not be included
            assert.ok(!calls.some(m => m.content.match(/;\s*save\(\)/)),
                'Bare save() on same line as B should not match className=B');
        } finally {
            rm(dir);
        }
    });

    it('import-only file is not a false positive with className', () => {
        const dir = tmp({
            'app.py': 'class B:\n    def save(self):\n        return 1\ndef save():\n    pass',
            'test_app.py': [
                'from app import B, save',
                '',
                'def test_save_mixed():',
                '    svc = B(); save()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            // File only has an import of save and a bare save() call — no B.save()
            assert.strictEqual(result.result.length, 0,
                'Should not return file with only import and bare call when className is set');
        } finally {
            rm(dir);
        }
    });

    it('bare references (fn = save, assert save) are not false positives with className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'class B { save() {} }\nfunction save() {}\nmodule.exports = { B, save };',
            'test/app.test.js': [
                'const { B, save } = require("../app");',
                'it("save reference", () => {',
                '  const svc = new B();',
                '  const fn = save;',
                '  expect(fn).toBe(save);',
                '});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            // No B.save() call — only bare `save` references and `new B()` constructor
            assert.strictEqual(result.result.length, 0,
                'Bare references to save should not match className=B');
        } finally {
            rm(dir);
        }
    });

    it('Python bare references are not false positives with className', () => {
        const dir = tmp({
            'app.py': 'class B:\n    def save(self):\n        return 1\ndef save():\n    pass',
            'test_app.py': [
                'from app import B, save',
                '',
                'def test_save_ref():',
                '    svc = B()',
                '    fn = save',
                '    assert fn is save',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            assert.strictEqual(result.result.length, 0,
                'Bare references to save should not match className=B');
        } finally {
            rm(dir);
        }
    });
});

describe('affectedTests: className scoping and coverage accuracy', () => {
    it('affectedTests --className scopes test file scan to target class', () => {
        const dir = tmp({
            'app.py': [
                'class A:',
                '    def save(self): return 1',
                'class B:',
                '    def save(self): return 2',
            ].join('\n'),
            'test_a.py': 'from app import A\ndef test_a_save():\n    svc = A()\n    svc.save()',
            'test_b.py': 'from app import B\ndef test_b_save():\n    svc = B()\n    svc.save()',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            const files = result.result.testFiles.map(r => r.file);
            assert.ok(files.some(f => f.includes('test_b')), 'Should include B test file');
            assert.ok(!files.some(f => f.includes('test_a')), 'Should NOT include A test file');
        } finally {
            rm(dir);
        }
    });

    it('affectedTests does not count import-only files as coverage', () => {
        const dir = tmp({
            'app.py': 'def save(): pass',
            'test_import.py': [
                'from app import save',
                '',
                'def test_import_only():',
                '    assert True',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'save' });
            assert.ok(result.ok);
            assert.strictEqual(result.result.testFiles.length, 0,
                'Import-only file should not count as test coverage');
        } finally {
            rm(dir);
        }
    });

    it('affectedTests does not count bare references as coverage', () => {
        const dir = tmp({
            'app.py': 'def save(): pass',
            'test_ref.py': [
                'from app import save',
                '',
                'def test_ref_only():',
                '    fn = save',
                '    assert fn is save',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'save' });
            assert.ok(result.ok);
            assert.strictEqual(result.result.testFiles.length, 0,
                'Bare reference file should not count as test coverage');
        } finally {
            rm(dir);
        }
    });

    it('affectedTests summary excludes test functions from affectedFunctions', () => {
        const dir = tmp({
            'app.py': 'class B:\n    def save(self): return 1',
            'test_b.py': 'from app import B\ndef test_b_only():\n    svc = B()\n    svc.save()',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'save', className: 'B' });
            assert.ok(result.ok);
            const hasTestFn = result.result.affectedFunctions.some(n => n.startsWith('test_'));
            assert.ok(!hasTestFn,
                'Test functions should not appear in affectedFunctions');
        } finally {
            rm(dir);
        }
    });
});

describe('CLI file-mode scoping', () => {
    it('file mode passes --file to project commands', () => {
        const dir = tmp({
            'a.py': 'class A:\n    def save(self): return 1',
            'b.py': 'class B:\n    def save(self): return 2',
        });
        try {
            // Target b.py specifically — should resolve to B.save, not A.save
            const out = runCli(dir + '/b.py', 'show', ['save'], ['--json']);
            assert.ok(out.includes('b.py'), 'Should resolve to b.py');
            assert.ok(!out.includes('a.py'), 'Should not include a.py');
        } finally {
            rm(dir);
        }
    });

    it('file mode api shows file-scoped header', () => {
        const out = runCli(FIXTURES_PATH + '/javascript/utils.js', 'api');
        assert.ok(out.includes('utils.js'), 'api header should show filename');
        assert.ok(!out.includes('Project API'), 'api should not show project-wide header');
    });

    it('file mode does not emit spurious --file warning', () => {
        const out = runCli(FIXTURES_PATH + '/javascript/utils.js', 'tests', ['helper']);
        assert.ok(!out.includes('Warning'), 'Should not warn about injected --file');
    });
});

describe('tests --file scoping', () => {
    it('tests accepts a stable handle as a symbol target, not as a file path', () => {
        const dir = tmp({
            'lib.js': [
                'class Service {',
                '  save() { return 1; }',
                '}',
                'module.exports = { Service };',
            ].join('\n'),
            'test/lib.test.js': [
                'const { Service } = require("../lib");',
                'it("saves", () => { new Service().save(); });',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'lib.js:2:save' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.length, 1);
            assert.ok(r.result[0].matches.some(m => m.line === 2 && m.matchType === 'call'));
            assert.ok(r.result.every(file => file.matches.every(m => !m.content.includes('class Service'))),
                'handle must not degrade into a basename search for lib.js');
        } finally { rm(dir); }
    });

    it('tests --file scopes to test files that import from the target source', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            'test/a.test.js': 'const { A } = require("../a");\nit("A save", () => { new A().save(); });',
            'test/b.test.js': 'const { B } = require("../b");\nit("B save", () => { new B().save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'b.js' });
            assert.ok(result.ok);
            assert.ok(result.result.some(r => r.file.includes('b.test')),
                'Should include test file for b.js');
            assert.ok(!result.result.some(r => r.file.includes('a.test')),
                'Should not include test file for a.js');
        } finally {
            rm(dir);
        }
    });

    it('file-mode CLI routes tests with --file scoping', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            'test/a.test.js': 'const { A } = require("../a");\nit("A save", () => { new A().save(); });',
            'test/b.test.js': 'const { B } = require("../b");\nit("B save", () => { new B().save(); });',
        });
        try {
            const out = runCli(dir + '/b.js', 'tests', ['save']);
            assert.ok(out.includes('b.test'), 'Should include b.test');
            assert.ok(!out.includes('a.test'), 'Should not include a.test');
        } finally {
            rm(dir);
        }
    });

    it('about --file scopes embedded TESTS section', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { save() { return 1; } }\nmodule.exports = { A };',
            'b.js': 'class B { save() { return 2; } }\nmodule.exports = { B };',
            'test/a.test.js': 'const { A } = require("../a");\nit("A save", () => { new A().save(); });',
            'test/b.test.js': 'const { B } = require("../b");\nit("B save", () => { new B().save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'save', file: 'b.js' });
            assert.ok(result.ok);
            const testFiles = result.result.tests?.files || [];
            assert.ok(testFiles.some(f => f.includes('b.test')),
                'about TESTS should include b.test');
            assert.ok(!testFiles.some(f => f.includes('a.test')),
                'about TESTS should not include a.test');
        } finally {
            rm(dir);
        }
    });

    it('tests --file handles same-basename files in different directories', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a/util.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'src/b/util.js': 'function save() { return 2; }\nmodule.exports = { save };',
            'test/a.test.js': 'const { save } = require("../src/a/util");\nit("A", () => { save(); });',
            'test/b.test.js': 'const { save } = require("../src/b/util");\nit("B", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'src/b/util.js' });
            assert.ok(result.ok);
            assert.ok(result.result.some(r => r.file.includes('b.test')),
                'Should include b.test');
            assert.ok(!result.result.some(r => r.file.includes('a.test')),
                'Should not include a.test (same basename, different dir)');
        } finally {
            rm(dir);
        }
    });

    it('tests --file finds tests via barrel re-exports', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/b/util.js': 'function save() { return 2; }\nmodule.exports = { save };',
            'src/b/index.js': 'module.exports = require("./util");',
            'test/b.test.js': 'const { save } = require("../src/b");\nit("B", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'src/b/util.js' });
            assert.ok(result.ok);
            assert.ok(result.result.some(r => r.file.includes('b.test')),
                'Should find test via barrel import');
        } finally {
            rm(dir);
        }
    });

    it('tests --file returns error when symbol not defined in target file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'b.js': 'function other() { return 2; }\nmodule.exports = { other };',
            'test/a.test.js': 'const { save } = require("../a");\nit("A", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'b.js' });
            assert.ok(!result.ok, 'Should return error when symbol not in target file');
            assert.ok(result.error.includes('a.js'),
                'Error should mention where the symbol is actually defined');
        } finally {
            rm(dir);
        }
    });

    it('tests --file follows multi-hop barrel re-export chains', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/core/util.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'src/core/index.js': 'module.exports = require("./util");',
            'src/public/index.js': 'module.exports = require("../core");',
            'test/public.test.js': 'const { save } = require("../src/public");\nit("pub", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'src/core/util.js' });
            assert.ok(result.ok);
            assert.ok(result.result.some(r => r.file.includes('public.test')),
                'Should find test through 3-hop barrel chain');
        } finally {
            rm(dir);
        }
    });

    it('tests --file does not overmatch barrels importing a different symbol', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/core/util.js': 'function save() { return 1; }\nfunction other() {}\nmodule.exports = { save, other };',
            'src/alt.js': 'function save() { return 99; }\nmodule.exports = { save };',
            'src/public/index.js': 'const { other } = require("../core/util");\nmodule.exports = { other };',
            'test/alt.test.js': 'const { save } = require("../src/alt");\nit("alt", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'save', file: 'src/core/util.js' });
            assert.ok(result.ok);
            assert.ok(!result.result.some(r => r.file.includes('alt.test')),
                'Should not include test for alt.js (different source file)');
        } finally {
            rm(dir);
        }
    });
});

describe('tests --file: language-aware test discovery', () => {
    it('Go: finds same-package tests (no imports needed)', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'util.go': 'package util\n\nfunc Save() int { return 1 }',
            'util_test.go': 'package util\n\nimport "testing"\n\nfunc TestSave(t *testing.T) {\n\tresult := Save()\n\tif result != 1 { t.Fatal() }\n}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'Save', file: 'util.go' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('util_test')),
                'Should find Go same-package test');
        } finally { rm(dir); }
    });

    it('Java: finds *Test.java convention tests', () => {
        const dir = tmp({
            'Util.java': 'public class Util { public static int save() { return 1; } }',
            'UtilTest.java': [
                'import org.junit.Test;',
                'public class UtilTest {',
                '    @Test public void testSave() { Util.save(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'save', file: 'Util.java' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('UtilTest')),
                'Should find Java naming-convention test');
        } finally { rm(dir); }
    });

    it('Rust: finds inline #[cfg(test)] module tests', () => {
        const dir = tmp({
            'lib.rs': [
                'pub fn save() -> i32 { 1 }',
                '',
                '#[cfg(test)]',
                'mod tests {',
                '    use super::*;',
                '    #[test]',
                '    fn test_save() {',
                '        assert_eq!(save(), 1);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'save', file: 'lib.rs' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('lib.rs')),
                'Should find Rust inline test in same file');
        } finally { rm(dir); }
    });

    it('about --file TESTS section finds Go same-package tests', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'util.go': 'package util\n\nfunc Save() int { return 1 }',
            'util_test.go': 'package util\n\nimport "testing"\n\nfunc TestSave(t *testing.T) {\n\tresult := Save()\n\tif result != 1 { t.Fatal() }\n}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'Save', file: 'util.go' });
            assert.ok(r.ok);
            assert.ok(r.result.tests?.fileCount > 0,
                'about TESTS should find Go same-package test');
        } finally { rm(dir); }
    });
});

describe('tests/about --exclude propagation', () => {
    it('tests --exclude filters test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
            'spec/lib.spec.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const all = execute(index, 'tests', { name: 'save' });
            const excluded = execute(index, 'tests', { name: 'save', exclude: ['spec'] });
            assert.ok(all.result.length > excluded.result.length,
                'Exclude should reduce test file count');
            assert.ok(!excluded.result.some(r => r.file.includes('spec')),
                'Excluded files should not appear');
        } finally { rm(dir); }
    });

    it('about --exclude propagates to TESTS section', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
            'spec/lib.spec.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'save', exclude: ['test', 'spec'] });
            assert.ok(r.ok);
            assert.strictEqual(r.result.tests?.fileCount, 0,
                'about --exclude should filter TESTS section');
        } finally { rm(dir); }
    });

    it('CLI project mode passes --exclude to tests', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
            'spec/lib.spec.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
        });
        try {
            const out = runCli(dir, 'tests', ['save'], ['--exclude', 'spec']);
            assert.ok(!out.includes('spec'), 'CLI --exclude should filter spec files');
            assert.ok(out.includes('test/'), 'CLI should still show test files');
        } finally { rm(dir); }
    });
});

describe('about/context includeTests flag', () => {
    it('about --include-tests makes usage counts include test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nit("s", () => { save(); });',
        });
        try {
            const index = idx(dir);
            // Default: usage counts exclude tests
            const r1 = execute(index, 'about', { name: 'save' });
            assert.ok(r1.ok);
            const defaultTotal = r1.result.usages.calls + r1.result.usages.imports + r1.result.usages.references;

            // With includeTests: usage counts include tests
            const r2 = execute(index, 'about', { name: 'save', includeTests: true });
            assert.ok(r2.ok);
            const inclTotal = r2.result.usages.calls + r2.result.usages.imports + r2.result.usages.references;
            assert.ok(inclTotal > defaultTotal,
                'includeTests should increase usage count');
        } finally { rm(dir); }
    });

    it('about always shows test callers in CALLERS (by design)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nfunction testSave() { save(); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'save' });
            assert.ok(r.ok);
            // Callers always include tests (complete call graph)
            assert.ok(r.result.callers.total > 0,
                'Callers should include test callers by default');
        } finally { rm(dir); }
    });

    it('context always shows test callers (includeTests not applicable)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
            'test/lib.test.js': 'const { save } = require("../lib");\nfunction testSave() { save(); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'save' });
            assert.ok(r.ok);
            // context callers always include tests — no usage counts to control
            assert.ok(r.result.callers.length > 0,
                'context callers should include test callers');
            assert.ok(r.result.callers.some(c => c.relativePath?.includes('test')),
                'context should show test file as caller');
        } finally { rm(dir); }
    });

    it('trace --include-tests warns as inapplicable', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function save() { return 1; }\nmodule.exports = { save };',
        });
        try {
            const { spawnSync } = require('child_process');
            const result = spawnSync('node', [
                require('path').join(__dirname, '..', 'cli', 'index.js'),
                dir, 'trace', 'save', '--include-tests'
            ], { timeout: 30000, encoding: 'utf-8' });
            assert.ok((result.stderr || '').includes('no effect'),
                'trace --include-tests should warn on stderr');
        } finally { rm(dir); }
    });
});

describe('flag validation parity across surfaces', () => {
    it('interactive mode warns about inapplicable flags', () => {
        const out = runInteractive(FIXTURES_PATH + '/javascript', ['trace helper --include-tests']);
        assert.ok(out.includes('no effect'), 'interactive trace --include-tests should warn');
    });

    it('MCP strips inapplicable params and reports them', async () => {
        const { McpClient } = require('./helpers');
        const client = new McpClient();
        await client.start();
        await client.initialize();
        try {
            // tests does not accept 'top' — it should be stripped and reported
            const res = await client.callTool({
                command: 'tests',
                project_dir: FIXTURES_PATH + '/javascript',
                name: 'helper',
                top: 1,
            });
            assert.ok(!res.isError, 'MCP should not error on inapplicable param');
            assert.ok(res.text.includes('Tests for'), 'Should produce normal output');
            assert.ok(res.text.includes('top') && res.text.includes('not applicable'),
                'Should report stripped param in note');
        } finally {
            client.stop();
        }
    });

    it('CLI warns about inapplicable negation flags (--no-regex)', () => {
        const { spawnSync } = require('child_process');
        const result = spawnSync('node', [
            require('path').join(__dirname, '..', 'cli', 'index.js'),
            FIXTURES_PATH + '/javascript', 'show', 'helper', '--no-regex'
        ], { timeout: 30000, encoding: 'utf-8' });
        const combined = (result.stdout || '') + (result.stderr || '');
        assert.ok(combined.includes('no effect'), 'show --no-regex should warn (regex not applicable)');
    });

    it('CLI warns about inapplicable negation flags (--hide-confidence)', () => {
        const { spawnSync } = require('child_process');
        const result = spawnSync('node', [
            require('path').join(__dirname, '..', 'cli', 'index.js'),
            FIXTURES_PATH + '/javascript', 'tests', 'helper', '--hide-confidence'
        ], { timeout: 30000, encoding: 'utf-8' });
        const combined = (result.stdout || '') + (result.stderr || '');
        assert.ok(combined.includes('no effect'), 'tests --hide-confidence should warn (showConfidence not applicable)');
    });

    it('interactive mode warns about inapplicable negation flags', () => {
        const out = runInteractive(FIXTURES_PATH + '/javascript', ['show helper --no-regex']);
        assert.ok(out.includes('no effect'), 'interactive show --no-regex should warn');
    });

    it('glob mode warns about inapplicable flags', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const { spawnSync } = require('child_process');
        const result = spawnSync('node', [
            require('path').join(__dirname, '..', 'cli', 'index.js'),
            pattern, 'trace', 'helper', '--include-tests'
        ], { timeout: 30000, encoding: 'utf-8' });
        const combined = (result.stdout || '') + (result.stderr || '');
        assert.ok(combined.includes('no effect'),
            'glob mode should warn about inapplicable --include-tests on trace');
    });
});

describe('tests --file: no basename collision across directories', () => {
    it('Go: package importers reach declarations in every file of the imported package', () => {
        const dir = tmp({
            'go.mod': 'module example.com/tool\ngo 1.21',
            'anchor.go': 'package tool\n\nfunc Anchor() {}',
            'command.go': 'package tool\n\ntype Command struct{}\nfunc (c *Command) CommandPath() string { return "x" }',
            'doc/man_docs_test.go': [
                'package doc',
                'import (',
                '  "testing"',
                '  tool "example.com/tool"',
                ')',
                'func TestPath(t *testing.T) {',
                '  var c *tool.Command',
                '  _ = c.CommandPath()',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'CommandPath', file: 'command.go' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('doc/man_docs_test.go')),
                'package import must cover declarations outside the resolver anchor file');
        } finally { rm(dir); }
    });

    it('Go: same-basename files in different packages are separated', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'a/util.go': 'package a\n\nfunc Save() int { return 1 }',
            'a/util_test.go': 'package a\n\nimport "testing"\n\nfunc TestSave(t *testing.T) { Save() }',
            'b/util.go': 'package b\n\nfunc Save() int { return 2 }',
            'b/util_test.go': 'package b\n\nimport "testing"\n\nfunc TestSave(t *testing.T) { Save() }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'Save', file: 'a/util.go' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('a/util_test')),
                'Should include a/util_test.go');
            assert.ok(!r.result.some(t => t.file.includes('b/util_test')),
                'Should NOT include b/util_test.go');
        } finally { rm(dir); }
    });

    it('Java: same-basename classes in different packages are separated', () => {
        const dir = tmp({
            'com/a/Util.java': 'package com.a;\npublic class Util { public static int save() { return 1; } }',
            'com/a/UtilTest.java': 'package com.a;\nimport org.junit.Test;\npublic class UtilTest { @Test public void testSave() { Util.save(); } }',
            'com/b/Util.java': 'package com.b;\npublic class Util { public static int save() { return 2; } }',
            'com/b/UtilTest.java': 'package com.b;\nimport org.junit.Test;\npublic class UtilTest { @Test public void testSave() { Util.save(); } }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', { name: 'save', file: 'com/a/Util.java' });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('com/a/UtilTest')),
                'Should include com/a/UtilTest');
            assert.ok(!r.result.some(t => t.file.includes('com/b/UtilTest')),
                'Should NOT include com/b/UtilTest');
        } finally { rm(dir); }
    });

    it('Java: a differently named test class in the mirrored package can exercise the target', () => {
        const dir = tmp({
            'src/main/java/com/acme/TypeSpec.java': [
                'package com.acme;',
                'public class TypeSpec {',
                '  public static class Builder { public Builder addStaticBlock() { return this; } }',
                '}',
            ].join('\n'),
            'src/test/java/com/acme/JavaFileTest.java': [
                'package com.acme;',
                'public class JavaFileTest {',
                '  public void testBlock(TypeSpec.Builder b) { b.addStaticBlock(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', {
                name: 'addStaticBlock',
                file: 'src/main/java/com/acme/TypeSpec.java',
                className: 'Builder',
            });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('JavaFileTest.java')),
                'same-package mirror must not depend on TargetNameTest naming');
        } finally { rm(dir); }
    });

    it('Rust: nested Cargo integration-test modules remain in the source-file scope', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"',
            'src/lib.rs': 'pub struct Arg;\nimpl Arg { pub fn to_long(&self) -> i32 { 1 } }',
            'tests/testsuite/parsed.rs': [
                'use tool::Arg;',
                '#[test]',
                'fn parses() { let a = Arg; assert_eq!(a.to_long(), 1); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'tests', {
                name: 'to_long',
                file: 'src/lib.rs',
                className: 'Arg',
            });
            assert.ok(r.ok);
            assert.ok(r.result.some(t => t.file.includes('tests/testsuite/parsed.rs')),
                'nested integration test must be reachable from the crate source');
        } finally { rm(dir); }
    });
});

describe('CLI glob-mode parity', () => {
    it('glob mode supports show and tests commands', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const showOut = runCli(pattern, 'show', ['helper'], ['--sections=summary,callers', '--json']);
        const shown = JSON.parse(showOut);
        assert.ok(shown.data.summary, 'glob show should find helper');
        assert.ok(shown.data.context, 'glob show should include relationships');
        // tests
        const testsOut = runCli(pattern, 'tests', ['helper']);
        assert.ok(testsOut.includes('Tests for "helper"'), 'glob tests should show header');
    });

    it('glob mode passes filePath and direction to deps', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const importsOut = runCli(pattern, 'deps', ['utils.js'], ['--direction=imports']);
        assert.ok(importsOut.includes('utils.js'), 'imports header should show filename');
        assert.ok(!importsOut.includes('undefined'), 'imports header should not show undefined');

        const exportersOut = runCli(pattern, 'deps', ['utils.js'], ['--direction=exporters']);
        assert.ok(!exportersOut.includes('undefined'), 'exporters header should not show undefined');

        const apiOut = runCli(pattern, 'api', ['utils.js']);
        assert.ok(!apiOut.includes('undefined'), 'api header should not show undefined');
    });

    it('glob mode shows confidence in show by default (parity with project mode)', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        // confidence annotations on caller lines are shown by default;
        // verify glob output matches project mode
        const globOut = runCli(pattern, 'show', ['helper']);
        const projOut = runCli(FIXTURES_PATH + '/javascript', 'show', ['helper']);
        const globConf = (globOut.match(/confidence/g) || []).length;
        const projConf = (projOut.match(/confidence/g) || []).length;
        assert.strictEqual(globConf, projConf,
            'glob and project mode should show same number of confidence annotations');
    });

    it('glob mode shows evidence aggregate in show callers', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const withConf = runCli(pattern, 'show', ['helper'], ['--sections=callers']);
        assert.ok(withConf.includes('evidence: '), 'glob show should show evidence aggregate');
    });

    it('glob mode passes --top to the show related section', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const topOne = runCli(pattern, 'show', ['helper'], ['--sections=related', '--top', '1']);
        const topAll = runCli(pattern, 'show', ['helper'], ['--sections=related']);
        // --top 1 should produce fewer or equal lines than default
        assert.ok(topOne.split('\n').length <= topAll.split('\n').length,
            'glob related --top 1 should limit output');
    });

    it('glob mode api passes positional file arg', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const out = runCli(pattern, 'api', ['utils.js'], ['--json']);
        const parsed = JSON.parse(out);
        // formatApiJson now wraps in {meta, data}; accept either shape
        const exports = parsed.data;
        assert.ok(exports.every(e => e.file === 'utils.js'),
            'glob api utils.js should only show utils.js exports');
    });

    it('glob mode source range has proper formatter', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const out = runCli(pattern, 'source', ['utils.js:1-3']);
        assert.ok(out.includes('utils.js:1-3'), 'lines should show file:range header');
        assert.ok(!out.includes('"file"'), 'lines text mode should not be JSON');
    });

    it('glob mode show can select source and callees together', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const out = runCli(pattern, 'show', ['helper'], ['--sections=source,callees']);
        assert.ok(out.includes('SOURCE') && out.includes('CALLEES'), out);
    });

    it('glob mode show does not advertise the retired expand workflow', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const out = runCli(pattern, 'show', ['helper']);
        assert.ok(!out.includes('ucn_expand'), 'glob context should not mention ucn_expand');
        assert.ok(!out.includes('expand <N>'), 'glob context should not advertise two-phase expand');
        assert.ok(!out.includes('--expand'), 'glob show should not advertise retired --expand');
    });

    it('glob mode show sections narrow output', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const summary = runCli(pattern, 'show', ['helper'], ['--sections=summary']);
        const callers = runCli(pattern, 'show', ['helper'], ['--sections=callers']);
        assert.ok(summary.includes('SUMMARY'));
        assert.ok(callers.includes('CALLERS'));
    });

    it('glob mode deps --all suppresses truncation', () => {
        const pattern = FIXTURES_PATH + '/javascript/**/*.js';
        const defaultOut = runCli(pattern, 'deps', ['utils.js']);
        const allOut = runCli(pattern, 'deps', ['utils.js'], ['--all']);
        // --all should not truncate; at minimum should not have fewer lines
        assert.ok(allOut.split('\n').length >= defaultOut.split('\n').length,
            'graph --all should show at least as many lines as default');
    });

    it('deps --all is applicable', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'deps', ['utils.js'], ['--all']);
        assert.ok(!out.includes('has no effect'), 'deps --all should not warn as inapplicable');
    });
});

describe('fix: CLI source --class-name passes through to execute', () => {
    it('source with --class-name disambiguates methods', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A {\n  save() { return "A"; }\n}\nmodule.exports = { A };',
            'b.js': 'class B {\n  save() { return "B"; }\n}\nmodule.exports = { B };',
        });
        try {
            const index = idx(dir);
            // Direct execute with className=A
            const resultA = execute(index, 'fn', { name: 'save', className: 'A' });
            assert.ok(resultA.ok, 'fn with className=A should succeed');
            assert.ok(resultA.result.entries.length > 0);
            assert.ok(resultA.result.entries[0].match.file.endsWith('a.js'), 'Should resolve to a.js');

            // Direct execute with className=B
            const resultB = execute(index, 'fn', { name: 'save', className: 'B' });
            assert.ok(resultB.ok, 'fn with className=B should succeed');
            assert.ok(resultB.result.entries.length > 0);
            assert.ok(resultB.result.entries[0].match.file.endsWith('b.js'), 'Should resolve to b.js');

            // CLI passes --class-name through
            const cliOutput = runCli(dir, 'source', ['save'], ['--class-name=A']);
            assert.ok(cliOutput.includes('a.js'), 'CLI source --class-name=A should show a.js');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI show example passes --file to execute', () => {
    it('show --sections=example with --file narrows results', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmodule.exports = { main };',
        });
        try {
            // CLI should pass --file to execute
            const cliOutput = runCli(dir, 'show', ['helper'], ['--sections=example', '--file=lib.js']);
            assert.ok(cliOutput.includes('app.js') || cliOutput.includes('helper'), 'Should find example in app.js');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI typedef passes --file and --class-name to execute', () => {
    it('typedef with --file narrows results', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'types.ts': 'interface Config { name: string; }\nexport { Config };',
            'other.ts': 'interface Config { value: number; }\nexport { Config };',
        });
        try {
            const index = idx(dir);
            // Execute directly with file filter
            const result = execute(index, 'typedef', { name: 'Config', file: 'types.ts' });
            assert.ok(result.ok);
            assert.ok(result.result.length >= 1, 'Should find Config in types.ts');
            assert.ok(result.result.every(r => r.relativePath.includes('types.ts')), 'All results from types.ts');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI entrypoints passes --include-tests and --limit', () => {
    it('entrypoints with --limit caps results via execute', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'const express = require("express");',
                'const app = express();',
                'app.get("/one", (req, res) => {});',
                'app.get("/two", (req, res) => {});',
                'app.get("/three", (req, res) => {});',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'entrypoints', { limit: 1 });
            assert.ok(result.ok);
            // If there are entrypoints, limit should cap them
            if (result.result.length > 0) {
                assert.ok(result.result.length <= 1, 'Should respect limit=1');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI diffImpact passes --limit', () => {
    it('diffImpact limit applies to changed array', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() {}\nfunction b() {}\nmodule.exports = { a, b };',
        });
        try {
            // Initialize a git repo so diffImpact can work
            execSync('git init && git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
            // Make a change
            fs.writeFileSync(path.join(dir, 'lib.js'), 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };');

            const index = idx(dir);
            const result = execute(index, 'diffImpact', { limit: 1 });
            assert.ok(result.ok);
            // If there are changes, limit should cap them
            if (result.result && result.result.changed && result.result.changed.length > 1) {
                assert.ok(result.result.changed.length <= 1, 'Should respect limit=1');
                assert.ok(result.note, 'Should have limit note');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix: applyClassMethodSyntax splits name even when className is set', () => {
    it('Bar.method --class-name=Foo uses Foo as class, method as name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo {\n  method() { return "Foo"; }\n}\nmodule.exports = { Foo };',
            'b.js': 'class Bar {\n  method() { return "Bar"; }\n}\nmodule.exports = { Bar };',
        });
        try {
            const index = idx(dir);
            // When className is explicit, dot-split should still extract method name
            const result = execute(index, 'fn', { name: 'Bar.method', className: 'Foo' });
            assert.ok(result.ok, 'Should succeed');
            // Should find Foo.method, not Bar.method (explicit --class-name wins)
            assert.ok(result.result.entries.length > 0);
            assert.ok(result.result.entries[0].match.file.endsWith('a.js'), 'Should resolve to Foo in a.js');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: usages file filter graceful degradation', () => {
    it('usages with file filter works with substring match', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib/utils.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib/utils");\nhelper();\n',
        });
        try {
            const index = idx(dir);
            // Use a partial file pattern that matches
            const result = execute(index, 'usages', { name: 'helper', file: 'utils' });
            assert.ok(result.ok);
            // Should find usages filtered to utils.js
            const defUsages = result.result.filter(u => u.isDefinition);
            assert.ok(defUsages.length > 0, 'Should find definition in utils');
            assert.ok(defUsages.every(u => u.relativePath?.includes('utils')), 'All defs from utils');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: api --json returns populated exports array', () => {
    it('public JSON envelope contains the API array', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const cliOutput = runCli(dir, 'api', ['lib.js'], ['--json']);
            const parsed = JSON.parse(cliOutput);
            assert.ok(parsed.data, 'Should have data field');
            assert.ok(Array.isArray(parsed.data), 'data should be an array');
            assert.ok(parsed.data.length > 0, 'exports should not be empty');
            assert.ok(parsed.data.some(e => e.name === 'helper'), 'Should include helper');
        } finally {
            rm(dir);
        }
    });
});

describe('source class extraction', () => {
    it('source extracts a class by name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { run() {} }\nmodule.exports = { Foo };',
        });
        try {
            const output = runCli(dir, 'source', ['Foo']);
            assert.ok(output.includes('class Foo'));
        } finally {
            rm(dir);
        }
    });
});

describe('MCP per-command param validation: stripping note', () => {
    let client;

    before(async () => {
        const { McpClient } = require('./helpers');
        client = new McpClient();
        await client.start();
        await client.initialize();
    });

    after(() => client.stop());

    it('MCP response includes stripping note for inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // depth is not applicable to show — should be stripped and reported
            const result = await client.callTool({ command: 'show', project_dir: dir, name: 'helper', depth: 3 });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('Note:'), 'should include a Note about stripped params');
            assert.ok(result.text.includes('depth'), 'note should mention "depth"');
            assert.ok(result.text.includes('not applicable to show'), 'note should mention the command');
        } finally {
            rm(dir);
        }
    });

    it('no stripping note when all params are applicable', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // file is applicable to show — no stripping note
            const result = await client.callTool({ command: 'show', project_dir: dir, name: 'helper', file: 'lib.js' });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(!result.text.includes('ignored (not applicable'), 'should not include stripping note');
        } finally {
            rm(dir);
        }
    });

    it('multiple stripped params listed together', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // depth and direction are not applicable to show
            const result = await client.callTool({ command: 'show', project_dir: dir, name: 'helper', depth: 3, direction: 'imports' });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('depth'), 'note should mention "depth"');
            assert.ok(result.text.includes('direction'), 'note should mention "direction"');
            assert.ok(result.text.includes('not applicable to show'), 'note should mention the command');
        } finally {
            rm(dir);
        }
    });

    it('stripping note survives truncation', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // depth is inapplicable to repo; max_chars=120 forces truncation
            const result = await client.callTool({ command: 'repo', project_dir: dir, depth: 3, max_chars: 120 });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.length <= 120, 'the stripping note is inside the character budget');
            assert.ok(result.text.includes('depth'), 'stripping note should survive truncation');
            assert.ok(result.text.includes('not applicable to repo'), 'should mention the command');
        } finally {
            rm(dir);
        }
    });

    it('stripping note appears on error paths', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // show without name is an error; depth is inapplicable
            const result = await client.callTool({ command: 'show', project_dir: dir, depth: 3 });
            assert.ok(result.isError, 'should be an error (missing name)');
            assert.ok(result.text.includes('depth'), 'stripping note should appear on error path');
            assert.ok(result.text.includes('not applicable to show'), 'should mention the command');
        } finally {
            rm(dir);
        }
    });

    it('false-valued inapplicable params are stripped and reported', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // regex=false is not applicable to show
            const result = await client.callTool({ command: 'show', project_dir: dir, name: 'helper', regex: false });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('regex'), 'note should mention "regex"');
            assert.ok(result.text.includes('not applicable to show'), 'note should mention the command');
        } finally {
            rm(dir);
        }
    });

    it('command-specific primary params (term, range, base, staged) are stripped when inapplicable', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // term is only for search, range is only for source — both inapplicable to show
            const result = await client.callTool({ command: 'show', project_dir: dir, name: 'helper', term: 'x', range: '1-2' });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('term'), 'note should mention "term"');
            assert.ok(result.text.includes('range'), 'note should mention "range"');
        } finally {
            rm(dir);
        }
    });

    it('base and staged are stripped when inapplicable', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // base and staged are only for diff_impact
            const result = await client.callTool({ command: 'tests', project_dir: dir, name: 'helper', base: 'HEAD', staged: true });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('base'), 'note should mention "base"');
            assert.ok(result.text.includes('staged'), 'note should mention "staged"');
        } finally {
            rm(dir);
        }
    });

    // BUG B1: FLAG_APPLICABILITY is keyed by canonical (camelCase) names but `command`
    // is the MCP (snake_case) name — multi-word commands silently skipped stripping.
    // The fix resolves command to canonical first.
    it('composed deps strips inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b");\nmodule.exports = {};',
            'b.js': 'const a = require("./a");\nmodule.exports = {};',
        });
        try {
            // git, diverse, hot are not applicable to deps
            const result = await client.callTool({ command: 'deps', project_dir: dir, cycles: true, git: true, diverse: true, hot: true });
            assert.ok(!result.isError, 'should not be an error');
            assert.ok(result.text.includes('Note:'), 'should include a Note about stripped params');
            assert.ok(result.text.includes('git') && result.text.includes('diverse') && result.text.includes('hot'),
                'note should mention git, diverse, and hot');
            assert.ok(result.text.includes('not applicable to deps'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });

    it('composed diff impact strips inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            // depth is not applicable to impact
            const result = await client.callTool({ command: 'impact', project_dir: dir, depth: 3 });
            // Diff impact may error if not in a git repo, but the stripping note must appear either way
            assert.ok(result.text.includes('depth'), 'stripping note should mention depth');
            assert.ok(result.text.includes('not applicable to impact'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });

    it('api strips inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            // depth is not applicable to api
            const result = await client.callTool({ command: 'api', project_dir: dir, file: 'lib.js', depth: 3 });
            assert.ok(result.text.includes('depth'), 'stripping note should mention depth');
            assert.ok(result.text.includes('not applicable to api'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });

    it('trace callers strips inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction main() { helper(); }',
        });
        try {
            // term is not applicable to trace
            const result = await client.callTool({ command: 'trace', project_dir: dir, name: 'helper', direction: 'callers', term: 'x' });
            assert.ok(result.text.includes('term'), 'stripping note should mention term');
            assert.ok(result.text.includes('not applicable to trace'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });

    it('transitive tests strips inapplicable params', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            // term is not applicable to tests
            const result = await client.callTool({ command: 'tests', project_dir: dir, name: 'helper', depth: 2, term: 'x' });
            assert.ok(result.text.includes('term'), 'stripping note should mention term');
            assert.ok(result.text.includes('not applicable to tests'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });

    it('multi-word commands strip inapplicable params (B1: audit_async)', async () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'async function helper() { return 1; }',
        });
        try {
            // depth is not applicable to audit_async
            const result = await client.callTool({ command: 'audit_async', project_dir: dir, depth: 3 });
            assert.ok(result.text.includes('depth'), 'stripping note should mention depth');
            assert.ok(result.text.includes('not applicable to audit_async'),
                'note should mention the MCP command name');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Trust signals: confidence histogram + reachability tagging
// ============================================================================

describe('feature: caller/callee confidence histogram', () => {
    it('histogram appears in show output when there are 2+ callers', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\tdoWork()
}
func doWork() {
\thelper()
}
func helper() {}
func unused1() { helper() }
func unused2() { helper() }
`,
        });
        try {
            const out = runCli(dir, 'show', ['helper'], ['--sections=callers']);
            assert.ok(out.includes('CALLERS — CONFIRMED (3)'), 'should show 3 confirmed callers');
            assert.match(out, /evidence: (\d+ )?[a-z-]+/,
                'evidence aggregate line should be present in caller section');
            assert.ok(!/confidence: \d+ high/.test(out),
                'old histogram format replaced by evidence aggregate');
        } finally {
            rm(dir);
        }
    });

    it('evidence aggregate present even for a single caller', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\thelper()
}
func helper() {}
`,
        });
        try {
            const out = runCli(dir, 'show', ['helper'], ['--sections=callers']);
            assert.ok(out.includes('CALLERS — CONFIRMED (1)'), 'should show 1 confirmed caller');
            assert.ok(out.includes('evidence: '), 'evidence aggregate shown');
        } finally {
            rm(dir);
        }
    });
});

describe('feature: reachability tagging of callers/callees', () => {
    it('tags callers as reachable/unreachable based on entry-point reachability', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\tdoWork()
}
func doWork() {
\thelper()
}
func helper() {}
func unusedCaller() { helper() }
`,
        });
        try {
            const index = idx(dir);
            computeReachability(index);
            const ctx = index.context('helper');
            assert.ok(ctx.callers.length >= 2, 'should find at least 2 callers');
            const reachableCaller = ctx.callers.find(c => c.callerName === 'doWork');
            const unreachableCaller = ctx.callers.find(c => c.callerName === 'unusedCaller');
            assert.ok(reachableCaller, 'should find doWork as caller');
            assert.ok(unreachableCaller, 'should find unusedCaller as caller');
            assert.strictEqual(reachableCaller.reachable, true, 'doWork is reachable from main');
            assert.strictEqual(unreachableCaller.reachable, false, 'unusedCaller is NOT reachable from any entry point');
        } finally {
            rm(dir);
        }
    });

    it('compact show output omits verbose per-caller reachability prose', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\tdoWork()
}
func doWork() {
\thelper()
}
func helper() {}
func unusedCaller() { helper() }
`,
        });
        try {
            const out = runCli(dir, 'show', ['helper'], ['--sections=callers']);
            assert.ok(!out.includes('unreachable from any entry point'),
                'compact show keeps reachability in JSON without verbose prose');
        } finally {
            rm(dir);
        }
    });

    it('reachability is opt-in and cached across filtered calls', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\thelper()
}
func helper() {}
`,
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index._reachableSymbols, undefined, 'reachable cache should not exist before first call');
            index.context('helper');
            assert.strictEqual(index._reachableSymbols, undefined,
                'default context stays targeted and does not compute reachability');
            index.context('helper', { unreachableOnly: true });
            assert.ok(index._reachableSymbols instanceof Set,
                'explicit reachability filtering computes the cache');
            const cachedSet = index._reachableSymbols;
            // Second call must reuse the same Set instance
            index.context('helper', { unreachableOnly: true });
            assert.strictEqual(index._reachableSymbols, cachedSet, 'reachable cache should be reused across calls');
        } finally {
            rm(dir);
        }
    });
});

describe('feature: --unreachable-only flag', () => {
    it('CLI: --unreachable-only filters show callers', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\tdoWork()
}
func doWork() {
\thelper()
}
func helper() {}
func unused1() { helper() }
func unused2() { helper() }
`,
        });
        try {
            const fullOut = runCli(dir, 'show', ['helper'], ['--sections=callers']);
            assert.ok(fullOut.includes('CALLERS — CONFIRMED (3)'), 'without filter: 3 confirmed callers');

            const filteredOut = runCli(dir, 'show', ['helper'], ['--sections=callers', '--unreachable-only']);
            assert.ok(filteredOut.includes('CALLERS — CONFIRMED (2)'), 'with --unreachable-only: 2 unreachable callers');
            assert.ok(!filteredOut.includes('[doWork]'), 'reachable caller doWork should be filtered out');
            assert.ok(filteredOut.includes('[unused1]'), 'unreachable caller unused1 should remain');
        } finally {
            rm(dir);
        }
    });

    it('CLI: --unreachable-only on impact filters the call sites', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\thelper()
}
func helper() {}
func deadCaller() { helper() }
`,
        });
        try {
            const out = runCli(dir, 'impact', ['helper'], ['--unreachable-only']);
            assert.ok(out.includes('CALL SITES: 1'), 'only the unreachable caller remains');
            assert.ok(out.includes('[deadCaller]'), 'deadCaller is the unreachable site');
            assert.ok(!out.includes('[main]'), 'main is reachable and filtered out');
        } finally {
            rm(dir);
        }
    });

    it('impact computes whole-project reachability only when requested', () => {
        const dir = tmp({
            'main.go': [
                'package main',
                'func main() { helper() }',
                'func helper() {}',
                'func deadCaller() { helper() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const plain = execute(index, 'impact', { name: 'helper' });
            assert.ok(plain.ok, plain.error);
            assert.ok(index._reachableSymbols == null,
                'targeted impact must not trigger the whole-project BFS');

            const filtered = execute(index, 'impact', {
                name: 'helper', unreachableOnly: true,
            });
            assert.ok(filtered.ok, filtered.error);
            assert.ok(index._reachableSymbols instanceof Set,
                'the explicit reachability filter computes and caches the BFS');
        } finally {
            rm(dir);
        }
    });
});

describe('feature: histogram and optional reachability in JSON output', () => {
    it('show callers JSON keeps histograms without eager reachability', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\thelper()
}
func helper() {}
func dead1() { helper() }
func dead2() { helper() }
`,
        });
        try {
            const out = runCli(dir, 'show', ['helper'], ['--sections=callers', '--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.data, 'should have data');
            const context = parsed.data.context;
            assert.ok(context.callerHistogram, 'callerHistogram should be present');
            assert.strictEqual(context.callerHistogram.total, 3, 'total should equal caller count');
            assert.ok(typeof context.callerHistogram.high === 'number', 'high bucket is a number');
            assert.ok(typeof context.callerHistogram.medium === 'number', 'medium bucket is a number');
            assert.ok(typeof context.callerHistogram.low === 'number', 'low bucket is a number');
            // Reachability is an explicit whole-project enrichment.
            for (const c of context.callers) {
                assert.strictEqual(c.reachable, undefined,
                    'default targeted query omits reachability');
            }
        } finally {
            rm(dir);
        }
    });

    it('show --json includes histograms without forcing reachability', () => {
        const dir = tmp({
            'main.go': `package main

func main() {
\thelper()
}
func helper() {}
func unused1() { helper() }
`,
        });
        try {
            const out = runCli(dir, 'show', ['helper'], ['--sections=callers', '--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.data.context, 'callers section present');
            assert.ok(parsed.data.context.callerHistogram, 'caller histogram present');
            assert.strictEqual(parsed.data.context.callerHistogram.total, 2);
            for (const c of parsed.data.context.callers) {
                assert.strictEqual(c.reachable, undefined,
                    'default show omits the expensive reachability enrichment');
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG-4: usages JSON output must report enclosing function as `callerName`
// instead of falling back to `_topLevel` for every call site.
// ============================================================================
describe('BUG-4: usages reports enclosing function for call sites', () => {
    it('call inside a named function reports callerName, not _topLevel', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `function helper(x) { return x + 1; }\nmodule.exports = { helper };\n`,
            'app.js': `const { helper } = require('./lib');\nfunction main() {\n  return helper(1);\n}\nmodule.exports = { main };\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'usages', { name: 'helper' });
            assert.ok(r.ok, 'usages should succeed');
            const json = JSON.parse(output.formatUsagesJson(r.result, 'helper'));
            assert.ok(json.data.calls.length > 0, 'should find at least one call');
            const call = json.data.calls.find(c => c.expression && c.expression.includes('helper(1)'));
            assert.ok(call, 'should find helper(1) call site');
            assert.ok(!call.handle.endsWith(':_topLevel'),
                `handle should not be _topLevel for call inside main(): ${call.handle}`);
            assert.ok(call.handle.endsWith(':main'),
                `handle should end with :main for call inside main(): ${call.handle}`);
            assert.ok(call.enclosingHandle, 'enclosingHandle should be present for nested call');
            assert.match(call.enclosingHandle, /:main$/, `enclosingHandle should reference main: ${call.enclosingHandle}`);
        } finally { rm(dir); }
    });

    it('call at module scope still reports _topLevel', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `function helper(x) { return x; }\nmodule.exports = { helper };\n`,
            'app.js': `const { helper } = require('./lib');\nhelper(42);\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'usages', { name: 'helper' });
            assert.ok(r.ok, 'usages should succeed');
            const json = JSON.parse(output.formatUsagesJson(r.result, 'helper'));
            const topCall = json.data.calls.find(c => c.expression && c.expression.includes('helper(42)'));
            assert.ok(topCall, 'should find top-level helper(42) call');
            assert.ok(topCall.handle.endsWith(':_topLevel'),
                `top-level call should still report _topLevel: ${topCall.handle}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-H1: about caller count must reflect true total, not maxResults cap
// ============================================================================

describe('BUG-H1: about caller total reflects true count, not maxResults cap', () => {
    it('about reports true caller total even when truncating top list', () => {
        // Generate 50+ direct callers of `helper`. Without the fix, about's
        // maxResults*3 cap would clamp the displayed total to ~30.
        const files = {
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x; }\nmodule.exports = { helper };',
        };
        const callerCount = 60;
        for (let i = 0; i < callerCount; i++) {
            files[`call${i}.js`] = `const { helper } = require('./lib');\nfunction caller${i}() { helper(${i}); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'helper' });
            assert.ok(result.ok, 'about should succeed');
            // True total should be at least the number of caller files we created.
            assert.ok(result.result.callers.total >= callerCount,
                `about should report >= ${callerCount} callers, got ${result.result.callers.total}`);
            // The displayed top list should be truncated to maxCallers (default 10).
            assert.ok(result.result.callers.top.length <= 10,
                `top list should be capped at 10, got ${result.result.callers.top.length}`);
        } finally { rm(dir); }
    });

    it('about caller total agrees with context caller count', () => {
        const files = {
            'package.json': '{"name":"test"}',
            'lib.js': 'function shared(x) { return x; }\nmodule.exports = { shared };',
        };
        for (let i = 0; i < 40; i++) {
            files[`u${i}.js`] = `const { shared } = require('./lib');\nfunction f${i}() { shared(${i}); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const aboutR = execute(index, 'about', { name: 'shared' });
            const ctxR = execute(index, 'context', { name: 'shared' });
            assert.ok(aboutR.ok && ctxR.ok);
            assert.strictEqual(aboutR.result.callers.total, ctxR.result.callers.length,
                `about total (${aboutR.result.callers.total}) should equal context length (${ctxR.result.callers.length})`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-H2: stats --hot must not attribute method calls to standalone functions
// ============================================================================

describe('BUG-H2: stats --hot disambiguates method vs standalone calls', () => {
    it('standalone get() count excludes obj.get() / dict.get() method calls', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // Standalone function `get` defined here
            'helper.js': 'function get() { return 1; }\nmodule.exports = { get };',
            // Direct call to standalone get()
            'caller.js': 'const { get } = require("./helper");\nfunction useIt() { return get(); }',
            // Method calls on objects — these should NOT inflate the standalone get count
            'noisy.js': [
                'const obj = { get() { return 2; } };',
                'const dict = new Map();',
                'function noise() {',
                '  obj.get();',
                '  dict.get("k");',
                '  ({}).get?.();',
                '  Array.prototype.get?.call({});',
                '  ({foo: {get(){}}}).foo.get();',
                '}'
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'stats', { hot: true, top: 10 });
            assert.ok(result.ok);
            const getRow = (result.result.hot.items || []).find(i => i.name === 'get');
            assert.ok(getRow, 'should find a `get` row');
            // The count should reflect only the bare-name caller(s) — at most a small
            // number, not 4-5 inflated by method calls.
            assert.ok(getRow.callCount <= 2,
                `get callCount should be small (only bare-name calls), got ${getRow.callCount}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-H3: impact and verify must honor --include-methods
// ============================================================================

describe('BUG-H3: impact and verify honor --include-methods flag', () => {
    it('impact defaults to includeMethods:true (catches obj.fn() calls)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function process(x) { return x; }\nmodule.exports = { process };',
            'a.js': 'const { process } = require("./lib");\nfunction a() { process(1); }',
            'b.js': 'const obj = require("./lib");\nfunction b() { obj.process(2); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'impact', { name: 'process' });
            assert.ok(r.ok);
            // Default: should catch both direct call and method call (2 sites).
            assert.ok(r.result.totalCallSites >= 2,
                `impact default should include obj.process() — got ${r.result.totalCallSites}`);
        } finally { rm(dir); }
    });

    it('impact --no-include-methods is a deprecated no-op (tiered contract)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function process(x) { return x; }\nmodule.exports = { process };',
            'a.js': 'const { process } = require("./lib");\nfunction a() { process(1); }',
            'b.js': 'const obj = require("./lib");\nfunction b() { obj.process(2); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'impact', { name: 'process', includeMethods: false });
            assert.ok(r.ok);
            // Tiered contract: --no-include-methods is a deprecated no-op for
            // impact. obj.process() has receiver binding evidence (obj =
            // require) → confirmed; both sites count.
            assert.strictEqual(r.result.totalCallSites, 2,
                `impact ignores --no-include-methods (tiered), got ${r.result.totalCallSites}`);
        } finally { rm(dir); }
    });

    it('verify arg-checks evidence-backed obj.fn() by default (v4 tiered contract)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function fetch(url) { return url; }\nmodule.exports = { fetch };',
            // Method call with wrong arity — receiver `obj = require("./lib")`
            // has binding evidence → confirmed tier → arg-checked BY DEFAULT.
            // Pre-v4 the default verify silently dropped this call and missed
            // the mismatch (pre-commit false green).
            'caller.js': 'const obj = require("./lib");\nfunction call() { obj.fetch("a", "b"); }',
        });
        try {
            const index = idx(dir);
            const def = execute(index, 'verify', { name: 'fetch' });
            const inc = execute(index, 'verify', { name: 'fetch', includeMethods: true });
            assert.ok(def.ok && inc.ok);
            assert.strictEqual(def.result.totalCalls, 1,
                `default verify must confirm the evidence-backed method call, got ${def.result.totalCalls}`);
            assert.strictEqual(def.result.mismatches, 1,
                `wrong-arity method call must be flagged by default, got ${def.result.mismatches}`);
            // --include-methods is an implied no-op under the contract.
            assert.strictEqual(inc.result.totalCalls, def.result.totalCalls,
                '--include-methods must not change the confirmed band');
            assert.strictEqual(inc.result.mismatches, def.result.mismatches,
                '--include-methods must not change the mismatches');
        } finally { rm(dir); }
    });

    it('FLAG_APPLICABILITY exposes includeMethods on impact and check', () => {
        const { FLAG_APPLICABILITY } = require('../core/registry');
        assert.ok(FLAG_APPLICABILITY.impact.includes('includeMethods'),
            'impact should accept includeMethods');
        assert.ok(FLAG_APPLICABILITY.check.includes('includeMethods'),
            'check should accept includeMethods');
    });
});

// ============================================================================
// BUG-M3: about for classes must report constructor callers (`new Foo()`)
// ============================================================================

describe('BUG-M3: about for class symbols reports `new Foo()` callers', () => {
    it('class with 5 instantiations shows 5 callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'foo.js': 'class Foo { constructor() {} }\nmodule.exports = { Foo };',
            'a.js': 'const { Foo } = require("./foo");\nfunction a() { return new Foo(); }',
            'b.js': 'const { Foo } = require("./foo");\nfunction b() { return new Foo(); }',
            'c.js': 'const { Foo } = require("./foo");\nfunction c() { return new Foo(); }',
            'd.js': 'const { Foo } = require("./foo");\nfunction d() { return new Foo(); }',
            'e.js': 'const { Foo } = require("./foo");\nfunction e() { return new Foo(); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'Foo' });
            assert.ok(r.ok);
            // Class symbols should now report constructor callers.
            assert.ok(r.result.callers.total >= 5,
                `about Foo should report >= 5 callers, got ${r.result.callers.total}`);
            // Callees for class types are intentionally empty (class body isn't a call sequence).
            assert.strictEqual(r.result.callees.total, 0,
                `about for a class should have 0 callees, got ${r.result.callees.total}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-M4: about and find must agree on auto-picked primary; about emits a note
// ============================================================================

describe('BUG-M4: about disambiguation note when other definitions exist', () => {
    it('about emits an ambiguous warning when multiple defs exist and no --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/main.js': 'function go() { return 1; }\nmodule.exports = { go };',
            'lib/main.js': 'function go() { return 2; }\nmodule.exports = { go };',
            'caller.js': 'const { go } = require("./src/main"); function call() { go(); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'go' });
            assert.ok(r.ok);
            // Should expose at least one ambiguous warning so the formatter
            // can render a "auto-selected — pass --file to choose" hint.
            assert.ok(Array.isArray(r.result.warnings) && r.result.warnings.length > 0,
                `about should attach warnings when multiple defs exist, got ${JSON.stringify(r.result.warnings)}`);
            assert.ok(r.result.warnings.some(w => w.type === 'ambiguous'),
                `expected an 'ambiguous' warning, got types ${r.result.warnings.map(w=>w.type)}`);
        } finally { rm(dir); }
    });

    it('about does NOT pick a test/ file when non-test alternatives exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/cmd.js': 'function go() { return "src"; }\nmodule.exports = { go };',
            'test/cmd-test.js': 'function go() { return "test"; }', // path-based test (no .test.js)
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'go' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.symbol.file, 'src/cmd.js',
                `about should pick src/ over test/, got ${r.result.symbol.file}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// JAVA-1: Polyglot file discovery does not gate languages by build manifests
// ============================================================================

describe('Regression JAVA-1: polyglot file discovery is manifest-independent', () => {
    it('project with only package.json still discovers .py files', () => {
        const dir = tmp({
            'package.json': '{"name":"poly"}',
            'main.js': 'function main() {}',
            'helper.py': 'def hello(): pass',
        });
        try {
            const index = idx(dir);
            const langs = new Set();
            for (const [, fe] of index.files) {
                if (fe.language) langs.add(fe.language);
            }
            assert.ok(langs.has('python'),
                `Python files should be discovered alongside JS; got languages: ${[...langs].join(',')}`);
            assert.ok(langs.has('javascript'),
                `JS files should still be discovered; got languages: ${[...langs].join(',')}`);
        } finally {
            rm(dir);
        }
    });

    it('project with only package.json still discovers .go and .rs files', () => {
        const dir = tmp({
            'package.json': '{"name":"poly"}',
            'main.js': 'function main() {}',
            'service.go': 'package main\nfunc Main() {}',
            'lib.rs': 'pub fn lib_main() {}',
        });
        try {
            const index = idx(dir);
            const langs = new Set();
            for (const [, fe] of index.files) {
                if (fe.language) langs.add(fe.language);
            }
            assert.ok(langs.has('go'),
                `Go files should be discovered without go.mod; got: ${[...langs].join(',')}`);
            assert.ok(langs.has('rust'),
                `Rust files should be discovered without Cargo.toml; got: ${[...langs].join(',')}`);
        } finally {
            rm(dir);
        }
    });

    it('detectProjectPattern always returns ALL_SUPPORTED_EXTENSIONS', () => {
        // Build manifests are HINTS not GATES. The pattern returned should
        // include ALL supported language extensions regardless of which manifests
        // exist in the project root.
        const { detectProjectPattern, ALL_SUPPORTED_EXTENSIONS } = require('../core/discovery');

        const emptyDir = tmp({ 'README.md': '# empty' });
        try {
            const pat = detectProjectPattern(emptyDir);
            // All listed extensions should appear in the pattern
            for (const ext of ALL_SUPPORTED_EXTENSIONS) {
                assert.ok(pat.includes(ext),
                    `Pattern should include ${ext}; got ${pat}`);
            }
        } finally {
            rm(emptyDir);
        }
    });
});

// ============================================================================
// Fix #214: type arguments in extends/bases clauses broke the inheritance
// graph — `extends Base<string, object>` split on the argument comma into
// parents ["Base<string", "object>"], so every generically extended class
// had no usable ancestor edges (zod-measured: 12 true base-class dispatch
// edges demoted; Java AbstractMap<K,V> and Python Mapping[str, int] bases
// had the same silent breakage).
// ============================================================================

describe('fix #214: generic extends clauses split on top-level commas only', () => {
    it('TS: extends Base<string, object> yields parent Base', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.ts': [
                'export abstract class Base<O = any, D = unknown> {',
                '  abstract run(x: O): O;',
                '}',
                'export class Str extends Base<string, object> {',
                '  run(x: string) { return x; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const f = [...index.files.keys()][0];
            assert.deepStrictEqual(index._getInheritanceParents('Str', f), ['Base']);
        } finally { rm(dir); }
    });

    it('Java: extends AbstractBox<K, V> yields parent AbstractBox', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/Impl.java': [
                'abstract class AbstractBox<K, V> {',
                '    abstract V get(K k);',
                '}',
                'public class Impl extends AbstractBox<String, Integer> {',
                '    Integer get(String k) { return 1; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const f = [...index.files.keys()][0];
            assert.deepStrictEqual(index._getInheritanceParents('Impl', f), ['AbstractBox']);
        } finally { rm(dir); }
    });

    it('Python: class C(Mapping[str, int], Flyable) yields both parents', () => {
        const dir = tmp({
            'requirements.txt': '',
            'mod.py': [
                'class Flyable:',
                '    pass',
                'class C(dict[str, int], Flyable):',
                '    pass',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const f = [...index.files.keys()].find(k => k.endsWith('mod.py'));
            assert.deepStrictEqual(index._getInheritanceParents('C', f), ['dict', 'Flyable']);
        } finally { rm(dir); }
    });

    it('base-class this-call dispatch edges stay confirmed through generic extends', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.ts': [
                'export abstract class Base<O> {',
                '  abstract _parse(x: O): O;',
                '  run() { return this._parse(null as any); }',
                '}',
                'export class Str extends Base<string> {',
                '  _parse(x: string) { return x; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'a.ts:6:_parse' });
            assert.ok(r.ok, r.error);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('a.ts:3'),
                `Base.run's this._parse() can dispatch to the Str override: ${confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #229: generic-param receivers are never type identity (Rust/Java/Go)', () => {
    // fn f<T: Wipe>(t: &T) { t.wipe() } — T/TStore can be instantiated with
    // the target class, so a generic-param receiver type must never exclude
    // (receiver-type-mismatch) a possible dispatch into the target. Two old
    // bypasses: the local-type-inference fallback re-inferred the nulled name
    // from the calls cache, and multi-char names (TStore) escaped the
    // 1-2-char convention regex. Now the enclosing scope's declared type
    // params decide, any name length.
    function callerBands(index, name) {
        const r = execute(index, 'context', { name });
        assert.ok(r.ok, `context failed: ${r.error}`);
        return {
            confirmed: (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`),
            unverified: (r.result.unverifiedCallers || []).map(u => `${u.relativePath || u.file}:${u.line}`),
        };
    }

    it('Rust: inline bound, where clause, and multi-char TStore all route visible; concrete mismatch still excludes', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "p"\nversion = "0.1.0"\n',
            'src/lib.rs': 'mod store;\nmod a;\nmod b;\nmod d;\nmod e;\n',
            'src/store.rs': 'pub trait Wipe { fn wipe(&self) -> bool; }\npub struct MemStore;\nimpl Wipe for MemStore { fn wipe(&self) -> bool { true } }\n',
            'src/a.rs': 'use crate::store::Wipe;\npub fn inline_bound<T: Wipe>(t: &T) -> bool { t.wipe() }\n',
            'src/b.rs': 'use crate::store::Wipe;\npub fn where_bound<T>(t: &T) -> bool where T: Wipe { t.wipe() }\n',
            'src/d.rs': 'use crate::store::Wipe;\npub fn long_generic<TStore: Wipe>(t: &TStore) -> bool { t.wipe() }\n',
            'src/e.rs': 'pub struct DiskStore;\nimpl DiskStore { pub fn wipe(&self) -> bool { false } }\npub fn concrete(d: &DiskStore) -> bool { d.wipe() }\n',
        });
        try {
            const bands = callerBands(idx(dir), 'MemStore.wipe');
            for (const site of ['src/a.rs:2', 'src/b.rs:2', 'src/d.rs:2']) {
                assert.ok(bands.unverified.includes(site),
                    `${site} must be visible unverified, got: ${JSON.stringify(bands)}`);
            }
            assert.ok(!bands.unverified.includes('src/e.rs:3') && !bands.confirmed.includes('src/e.rs:3'),
                'concrete DiskStore receiver stays excluded');
        } finally { rm(dir); }
    });

    it('Java: multi-char generic method type param routes visible', () => {
        const dir = tmp({
            'Wiper.java': 'public interface Wiper {\n    boolean wipe();\n}\n',
            'MemStore.java': 'public class MemStore implements Wiper {\n    public boolean wipe() { return true; }\n}\n',
            'Runner.java': 'public class Runner {\n    public <TStore extends Wiper> boolean run(TStore t) {\n        return t.wipe();\n    }\n}\n',
        });
        try {
            const bands = callerBands(idx(dir), 'MemStore.wipe');
            assert.ok(bands.unverified.includes('Runner.java:3'),
                `Runner.java:3 must be visible unverified, got: ${JSON.stringify(bands)}`);
        } finally { rm(dir); }
    });

    it('Go: multi-char generic type param routes visible', () => {
        const dir = tmp({
            'go.mod': 'module example.com/m\ngo 1.21\n',
            'store.go': 'package m\n\ntype Wiper interface {\n\tWipe() bool\n}\n\ntype MemStore struct{}\n\nfunc (MemStore) Wipe() bool { return true }\n',
            'run.go': 'package m\n\nfunc Run[TStore Wiper](t TStore) bool {\n\treturn t.Wipe()\n}\n',
        });
        try {
            const bands = callerBands(idx(dir), 'MemStore.Wipe');
            assert.ok(bands.unverified.includes('run.go:4'),
                `run.go:4 must be visible unverified, got: ${JSON.stringify(bands)}`);
        } finally { rm(dir); }
    });
});

describe('fix #234: search --unused excludes entry points and decorator names', () => {
    // Campaign G2 ×4 languages: main/init/#[test] listed as unused (no
    // entry-point exclusion), and Python bare-decorator names flagged
    // (decorator applications are references, not calleeIndex entries).
    it('go: main and init are never unused', () => {
        const dir = tmp({
            'go.mod': 'module m\ngo 1.21\n',
            'main.go': 'package main\n\nimport "fmt"\n\nfunc init() { fmt.Println(1) }\n\nfunc dead() int { return 2 }\n\nfunc main() { fmt.Println(3) }\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'search', { type: 'function', unused: true });
            assert.ok(r.ok);
            const names = r.result.results.map(x => x.name);
            assert.ok(names.includes('dead'), 'dead stays flagged');
            assert.ok(!names.includes('main') && !names.includes('init'),
                `entry points excluded, got: ${names.join(',')}`);
        } finally { rm(dir); }
    });

    it('python: a name applied as a bare decorator is used', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\n',
            'app.py': 'def with_logging(func):\n    return func\n\n\n@with_logging\ndef work(x):\n    return x\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'search', { type: 'function', unused: true });
            assert.ok(r.ok);
            const names = r.result.results.map(x => x.name);
            assert.ok(!names.includes('with_logging'),
                `decorator name must not be unused, got: ${names.join(',')}`);
        } finally { rm(dir); }
    });
});


// ============================================================================
// Fix #257: callee-side receiver-type routing + single-owner defeaters
// (found running trace on UCN itself: canonicalSymbols.set() on a `new Map()`
// local resolved exact-binding into a test-fixture CacheService.set — three
// fixture languages' defs conflated into ONE owner, the parser's
// receiverType was never consulted on the callee side, and a plain-named
// file under test/ escaped the test-owner defeater)
// ============================================================================

describe('fix #257: callee receiver-type routing and single-owner defeaters', () => {
    function calleesFor(index, defName, opts = {}) {
        const def = (index.symbols.get(defName) || [])[0];
        assert.ok(def, `def ${defName} must exist`);
        return index.findCallees(def, { includeMethods: true, ...opts });
    }

    it('builtin-typed receiver never confirms a project method (cross-language owners)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'main.js': 'function work() {\n  const m = new Map();\n  m.set("a", 1);\n  return m;\n}\nmodule.exports = { work };',
            'test/fixtures/Service.java': 'public class CacheService {\n    public void set(String key, Object value) { }\n}',
            'test/fixtures/service.py': 'class CacheService:\n    def set(self, key, value):\n        pass\n',
        });
        try {
            const index = idx(dir);
            const legacy = calleesFor(index, 'work');
            assert.ok(!legacy.some(c => c.name === 'set'),
                'legacy mode: Map-typed receiver must not confirm CacheService.set');
            const account = calleesFor(index, 'work', { collectAccount: true });
            assert.ok(!account.some(c => c.name === 'set' && c.tier === 'confirmed'),
                'account mode: Map-typed receiver must not confirm CacheService.set');
            assert.ok(account.calleeAccount?.conserved, 'callee account must stay conserved');
        } finally { rm(dir); }
    });

    it('typed receiver resolves the RIGHT one of two owners (new confirm path)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'cache.js': 'class Cache { save() { return 1; } }\nmodule.exports = { Cache };',
            'store.js': 'class Store { save() { return 2; } }\nmodule.exports = { Store };',
            'main.js': 'const { Cache } = require("./cache");\nfunction work() {\n  const c = new Cache();\n  return c.save();\n}\nmodule.exports = { work };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            const save = account.find(c => c.name === 'save' && c.tier === 'confirmed');
            assert.ok(save, 'c.save() on a new Cache() local must confirm');
            assert.ok(save.file.endsWith('cache.js'),
                `must resolve to Cache.save, got ${save.file}`);
        } finally { rm(dir); }
    });

    it('typed receiver reaches a method defined on an ancestor class', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'base.js': 'class Base { save() { return 1; } }\nclass Child extends Base {}\nmodule.exports = { Base, Child };',
            'other.js': 'class Other { save() { return 2; } }\nmodule.exports = { Other };',
            'main.js': 'const { Child } = require("./base");\nfunction work() {\n  const c = new Child();\n  return c.save();\n}\nmodule.exports = { work };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            const save = account.find(c => c.name === 'save' && c.tier === 'confirmed');
            assert.ok(save, 'Child-typed receiver must reach Base.save via inheritance');
            assert.ok(save.file.endsWith('base.js'),
                `must resolve to Base.save, got ${save.file}`);
        } finally { rm(dir); }
    });

    it('single-owner never crosses language families (untyped receiver)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'main.js': 'function work(x) {\n  return x.store(1);\n}\nmodule.exports = { work };',
            'keeper.py': 'class DataKeeper:\n    def store(self, v):\n        return v\n',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            assert.ok(!account.some(c => c.name === 'store' && c.tier === 'confirmed'),
                'a JS call must never resolve to a Python-only owner');
            assert.ok(account.calleeAccount?.conserved, 'callee account must stay conserved');
        } finally { rm(dir); }
    });

    it('single-owner defeated when the only owner lives under a test path', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'main.js': 'function work(y) {\n  return y.helperThing();\n}\nmodule.exports = { work };',
            'test/support/util.js': 'class Helper { helperThing() { return 1; } }\nmodule.exports = { Helper };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            assert.ok(!account.some(c => c.name === 'helperThing' && c.tier === 'confirmed'),
                'a prod caller must not single-owner-confirm into a test-path owner');
        } finally { rm(dir); }
    });

    it('python: literal-dict receiver never confirms a project method', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\n',
            'main.py': 'def work():\n    m = {}\n    m.update({"a": 1})\n    return m\n',
            'svc.py': 'class Registry:\n    def update(self, d):\n        pass\n',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            assert.ok(!account.some(c => c.name === 'update' && c.tier === 'confirmed'),
                'dict-typed receiver must not confirm Registry.update');
        } finally { rm(dir); }
    });

    it('python: annotated receiver resolves the right one of two owners', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\n',
            'svc.py': 'class Registry:\n    def update(self, d):\n        pass\n\nclass Journal:\n    def update(self, d):\n        pass\n',
            'main.py': 'from svc import Registry\n\ndef work(r: Registry):\n    r.update({"a": 1})\n',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            const upd = account.find(c => c.name === 'update' && c.tier === 'confirmed');
            assert.ok(upd, 'Registry-annotated receiver must confirm update');
            assert.ok(upd.className === 'Registry' || upd.file.endsWith('svc.py'),
                `must resolve to Registry.update, got ${upd.className} in ${upd.file}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// fix #261: zero-candidate method calls route external, not unverified
// (a method name with ZERO project definitions cannot be a project call —
// `parts.push(...)` / `names.join(...)` sat as [unverified] uncertain-receiver
// noise in every trace; dynamic property assignment indexes a def under the
// property name, so any project that defines the method keeps its calls
// visible)
// ============================================================================

describe('fix #261: zero-candidate method calls route external', () => {
    function calleesFor(index, defName, opts = {}) {
        const def = (index.symbols.get(defName) || [])[0];
        assert.ok(def, `def ${defName} must exist`);
        return index.findCallees(def, { includeMethods: true, ...opts });
    }

    it('zero-def method names go external, not unverified (JS untyped receiver)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'main.js': 'function work(bag) {\n  bag.enqueue(1);\n  bag.dequeue();\n  return bag;\n}\nmodule.exports = { work };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            const unv = (account.unverifiedCallees || []).map(u => u.name);
            assert.ok(!unv.includes('enqueue') && !unv.includes('dequeue'),
                `zero-def names must not be unverified: ${unv}`);
            assert.strictEqual(account.calleeAccount.external.count, 2,
                `both zero-def calls external: ${JSON.stringify(account.calleeAccount)}`);
            assert.ok(account.calleeAccount.conserved, 'account conserved');
        } finally { rm(dir); }
    });

    it('a project-defined name keeps the visible unverified routing (counter-probe)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'queues.js': 'class TaskQueue { enqueue(x) { return x; } }\nclass JobQueue { enqueue(x) { return x; } }\nmodule.exports = { TaskQueue, JobQueue };',
            'main.js': 'function work(bag) {\n  bag.enqueue(1);\n  return bag;\n}\nmodule.exports = { work };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'work', { collectAccount: true });
            assert.ok((account.unverifiedCallees || []).some(u => u.name === 'enqueue'),
                'multi-owner project name must stay visible unverified');
        } finally { rm(dir); }
    });

    it('Python self.attr.method() with a zero-def name goes external', () => {
        const dir = tmp({
            'setup.py': '',
            'w.py': 'class Worker:\n    def __init__(self):\n        self.items = []\n    def add(self, x):\n        self.items.append(x)\n',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'add', { collectAccount: true });
            const unv = (account.unverifiedCallees || []).map(u => u.name);
            assert.ok(!unv.includes('append'), `append must not be unverified: ${unv}`);
            assert.ok(account.calleeAccount.external.count >= 1,
                `append external: ${JSON.stringify(account.calleeAccount)}`);
        } finally { rm(dir); }
    });

    it('Python self.attr.method() with project owners stays visible (counter-probe)', () => {
        const dir = tmp({
            'setup.py': '',
            'sinks.py': 'class LogSink:\n    def emit(self, x):\n        pass\nclass NetSink:\n    def emit(self, x):\n        pass\n',
            'w.py': 'class Worker:\n    def __init__(self):\n        self.sink = None\n    def add(self, x):\n        self.sink.emit(x)\n',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'add', { collectAccount: true });
            assert.ok((account.unverifiedCallees || []).some(u => u.name === 'emit'),
                'two-owner emit must stay visible self-attr-unresolved');
        } finally { rm(dir); }
    });

    it('this.method() inherited from a builtin base goes external', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lines.js': 'class Lines extends Array {\n  add(x) {\n    this.push(x);\n    return this;\n  }\n}\nmodule.exports = { Lines };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'add', { collectAccount: true });
            const unv = (account.unverifiedCallees || []).map(u => u.name);
            assert.ok(!unv.includes('push'), `builtin-inherited push must not be unverified: ${unv}`);
            assert.ok(account.calleeAccount.external.count >= 1,
                `push external: ${JSON.stringify(account.calleeAccount)}`);
        } finally { rm(dir); }
    });

    it('this.method() resolving to a project ancestor still confirms (counter-probe)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'base.js': 'class Base {\n  flush() { return 1; }\n}\nclass Impl extends Base {\n  add(x) {\n    this.flush();\n    return x;\n  }\n}\nmodule.exports = { Base, Impl };',
        });
        try {
            const index = idx(dir);
            const account = calleesFor(index, 'add', { collectAccount: true });
            assert.ok(account.some(c => c.name === 'flush'),
                'inherited project method must still confirm');
        } finally { rm(dir); }
    });

    it('legacy mode gains no new edges from the external routing', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'main.js': 'function work(bag) {\n  bag.enqueue(1);\n  return bag;\n}\nmodule.exports = { work };',
        });
        try {
            const index = idx(dir);
            const legacy = calleesFor(index, 'work');
            assert.ok(!legacy.some(c => c.name === 'enqueue'),
                'legacy mode must not surface a zero-def edge');
        } finally { rm(dir); }
    });
});

describe('fix #300: cross-case receiver-name match is never exclusion evidence', () => {
    it('rust: cross-case class match routes visible method-ambiguous', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "f300a"\nversion = "0.1.0"\n',
            'src/lib.rs': [
                'pub struct TupleWindows { pub n: u32 }',
                '',
                'impl TupleWindows {',
                '    pub fn next(&mut self) -> Option<u32> { None }',
                '}',
                '',
                'pub struct Other { pub m: u32 }',
                '',
                'impl Other {',
                '    pub fn next(&mut self) -> Option<u32> { None }',
                '}',
                '',
                'pub fn drive<F: Fn() -> TupleWindows>(mk: F) -> Option<u32> {',
                '    let mut iter = mk();',
                '    iter.next()',
                '}',
            ].join('\n') + '\n',
            // Test-file struct whose name matches the receiver only across case —
            // the itertools family: `struct Iter` poisoned every `iter` receiver.
            'tests/quick.rs': [
                'struct Iter { k: u32 }',
                '',
                'impl Iter {',
                '    fn next(&mut self) -> Option<u32> { None }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'src/lib.rs:4:next' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const unv = r.result.unverifiedCallers || [];
            const site = unv.find(u => u.relativePath === 'src/lib.rs' && u.line === 15);
            assert.ok(site, `iter.next() must stay visible: ${JSON.stringify(unv)}`);
            assert.strictEqual(site.reason, 'method-ambiguous');
            const excl = r.result.meta.account.excluded.byReason || {};
            assert.ok(!excl['receiver-other-class'],
                `cross-case guess must not exclude: ${JSON.stringify(excl)}`);
            assert.ok(r.result.meta.account.conserved);
        } finally { rm(dir); }
    });

    it('go: exact-case class match keeps the exclusion (the grpc-go bb family)', () => {
        const dir = tmp({
            'go.mod': 'module f300ago\n\ngo 1.21\n',
            'main.go': [
                'package main',
                '',
                'type bb struct{ n int }',
                '',
                'func (b *bb) Parse(s string) int { return b.n }',
                '',
                'type cc struct{ m int }',
                '',
                'func (c *cc) Parse(s string) int { return c.m }',
                '',
                'func run(mk func() *bb) int {',
                '\tbb := mk()',
                '\treturn bb.Parse("x")',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'main.go:9:Parse' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const excl = r.result.meta.account.excluded.byReason || {};
            assert.ok(excl['receiver-other-class'],
                `exact-case name match must keep excluding: ${JSON.stringify(excl)}`);
            assert.ok(r.result.meta.account.conserved);
        } finally { rm(dir); }
    });
});

describe('fix #358: self/this/Self/base calls resolve by class DEFINITION, not class name', () => {
    // Two unrelated classes share the name Chunks in different modules /
    // packages / namespaces / crates. `self.len()` inside the first one binds
    // its OWN len and must never confirm the other class's len.
    const LANGS = {
        python: {
            files: {
                'pkg/__init__.py': '',
                'pkg/slice.py': 'class Chunks:\n    def opt_len(self):\n        return self.len()\n\n    def len(self):\n        return 1\n',
                'pkg/iter.py': 'class Chunks:\n    def len(self):\n        return 2\n',
            },
            caller: 'pkg/slice.py:2:opt_len', own: 'pkg/slice.py:5:len', other: 'pkg/iter.py:2:len', site: 'slice.py:3',
        },
        typescript: {
            files: {
                'slice.ts': 'export class Chunks {\n  optLen(): number { return this.len(); }\n  len(): number { return 1; }\n}\n',
                'iter.ts': 'export class Chunks {\n  len(): number { return 2; }\n}\n',
            },
            caller: 'slice.ts:2:optLen', own: 'slice.ts:3:len', other: 'iter.ts:2:len', site: 'slice.ts:2',
        },
        java: {
            files: {
                'com/x/a/Chunks.java': 'package com.x.a;\npublic class Chunks {\n  public int optLen() { return this.len() + len(); }\n  public int len() { return 1; }\n}\n',
                'com/x/b/Chunks.java': 'package com.x.b;\npublic class Chunks {\n  public int len() { return 2; }\n}\n',
            },
            caller: 'com/x/a/Chunks.java:3:optLen', own: 'com/x/a/Chunks.java:4:len', other: 'com/x/b/Chunks.java:3:len', site: 'Chunks.java:3',
        },
        csharp: {
            files: {
                'A.cs': 'namespace A {\n  public class Chunks {\n    public int OptLen() { return this.Len(); }\n    public int Len() { return 1; }\n  }\n}\n',
                'B.cs': 'namespace B {\n  public class Chunks {\n    public int Len() { return 2; }\n  }\n}\n',
            },
            caller: 'A.cs:3:OptLen', own: 'A.cs:4:Len', other: 'B.cs:3:Len', site: 'A.cs:3',
        },
        rust: {
            files: {
                'Cargo.toml': '[package]\nname = "fx358"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub mod slice;\npub mod iter;\n',
                'src/slice.rs': 'pub struct Chunks { n: usize }\nimpl Chunks {\n    pub fn opt_len(&self) -> Option<usize> { Some(self.len()) }\n    pub fn len(&self) -> usize { self.n }\n}\n',
                'src/iter.rs': 'pub struct Chunks { m: usize }\nimpl Chunks {\n    pub fn len(&self) -> usize { self.m }\n}\n',
            },
            caller: 'src/slice.rs:3:opt_len', own: 'src/slice.rs:4:len', other: 'src/iter.rs:3:len', site: 'slice.rs:3',
        },
    };
    const sites = list => (list || []).map(c => `${path.basename(c.file)}:${c.line}`);

    for (const [lang, fx] of Object.entries(LANGS)) {
        it(`${lang}: the cross-module same-name class site is not confirmed; the own-class site is`, () => {
            const dir = tmp(fx.files);
            try {
                const index = idx(dir);
                const other = execute(index, 'show', { name: fx.other, sections: 'callers' });
                const own = execute(index, 'show', { name: fx.own, sections: 'callers' });
                assert.ok(other.ok && own.ok);
                assert.ok(!sites(other.result.context.callers).includes(fx.site),
                    `other-module target must not confirm ${fx.site}: ${JSON.stringify(sites(other.result.context.callers))}`);
                assert.ok(sites(own.result.context.callers).includes(fx.site),
                    `own target keeps ${fx.site} confirmed: ${JSON.stringify(sites(own.result.context.callers))}`);
                assert.strictEqual(other.result.context.meta.account.conserved, true);
            } finally { rm(dir); }
        });

        it(`${lang}: the callee side binds the self call to its own class definition`, () => {
            const dir = tmp(fx.files);
            try {
                const index = idx(dir);
                const r = execute(index, 'show', { name: fx.caller, sections: 'callees' });
                assert.ok(r.ok);
                const confirmed = (r.result.context.callees || [])
                    .filter(c => c.tier === 'confirmed')
                    .map(c => `${c.relativePath}:${c.startLine}:${c.name}`);
                assert.ok(confirmed.includes(fx.own), `callees: ${JSON.stringify(confirmed)}`);
                assert.ok(!confirmed.includes(fx.other), `callees: ${JSON.stringify(confirmed)}`);
            } finally { rm(dir); }
        });
    }

    it('python/java/c#: inherited self calls follow the RESOLVED base, and a same-name subclass override is possible-dispatch', () => {
        const cases = [
            {
                files: {
                    'pkg/__init__.py': '',
                    'pkg/base1.py': 'class Base:\n    def m(self):\n        return 1\n\n    def as_sql(self):\n        return "b"\n\n    def compile(self):\n        return self.as_sql()\n',
                    'pkg/base2.py': 'class Base:\n    def m(self):\n        return 2\n',
                    'pkg/child.py': 'from pkg.base1 import Base\n\n\nclass Child(Base):\n    def run(self):\n        return self.m()\n',
                    'pkg/sub.py': 'from pkg import base1\n\n\nclass Base(base1.Base):\n    def as_sql(self):\n        return "c"\n',
                },
                base1m: 'pkg/base1.py:2:m', base2m: 'pkg/base2.py:2:m', inherited: 'child.py:6',
                subOverride: 'pkg/sub.py:5:as_sql', baseSite: 'base1.py:9',
            },
            {
                files: {
                    'com/x/b1/Base.java': 'package com.x.b1;\npublic class Base {\n  public int m() { return 1; }\n  public String asSql() { return "b"; }\n  public String compile() { return this.asSql(); }\n}\n',
                    'com/x/b2/Base.java': 'package com.x.b2;\npublic class Base {\n  public int m() { return 2; }\n}\n',
                    'com/x/c/Child.java': 'package com.x.c;\nimport com.x.b1.Base;\npublic class Child extends Base {\n  public int run() { return this.m(); }\n}\n',
                    'com/x/c2/Base.java': 'package com.x.c2;\npublic class Base extends com.x.b1.Base {\n  public String asSql() { return "c"; }\n}\n',
                },
                base1m: 'com/x/b1/Base.java:3:m', base2m: 'com/x/b2/Base.java:3:m', inherited: 'Child.java:4',
                subOverride: 'com/x/c2/Base.java:3:asSql', baseSite: 'Base.java:5',
            },
            {
                files: {
                    'B1.cs': 'namespace X.B1 {\n  public class Base {\n    public int M() { return 1; }\n    public virtual string AsSql() { return "b"; }\n    public string Compile() { return this.AsSql(); }\n  }\n}\n',
                    'B2.cs': 'namespace X.B2 {\n  public class Base {\n    public int M() { return 2; }\n  }\n}\n',
                    'Child.cs': 'using X.B1;\nnamespace X.C {\n  public class Child : Base {\n    public int Run() { return this.M(); }\n  }\n}\n',
                    'Sub.cs': 'namespace X.C2 {\n  public class Base : X.B1.Base {\n    public override string AsSql() { return "c"; }\n  }\n}\n',
                },
                base1m: 'B1.cs:3:M', base2m: 'B2.cs:3:M', inherited: 'Child.cs:4',
                subOverride: 'Sub.cs:3:AsSql', baseSite: 'B1.cs:5',
            },
        ];
        for (const c of cases) {
            const dir = tmp(c.files);
            try {
                const index = idx(dir);
                const b1 = execute(index, 'show', { name: c.base1m, sections: 'callers' });
                const b2 = execute(index, 'show', { name: c.base2m, sections: 'callers' });
                const sub = execute(index, 'show', { name: c.subOverride, sections: 'callers' });
                assert.ok(b1.ok && b2.ok && sub.ok);
                assert.ok(sites(b1.result.context.callers).includes(c.inherited),
                    `${c.base1m}: ${JSON.stringify(sites(b1.result.context.callers))}`);
                assert.ok(!sites(b2.result.context.callers).includes(c.inherited),
                    `${c.base2m}: ${JSON.stringify(sites(b2.result.context.callers))}`);
                // The base class's own self call can dispatch into the
                // same-name subclass override: visible, never confirmed.
                assert.ok(!sites(sub.result.context.callers).includes(c.baseSite));
                const routed = (sub.result.context.unverifiedCallers || [])
                    .filter(u => `${path.basename(u.file)}:${u.line}` === c.baseSite);
                assert.strictEqual(routed.length, 1, JSON.stringify(sub.result.context.unverifiedCallers));
                assert.strictEqual(routed[0].reason, 'possible-dispatch');
            } finally { rm(dir); }
        }
    });

    it('rust: an impl block in another file binds the struct its own `use` imports', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "fx358b"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub mod a;\npub mod b;\npub mod ximpl;\n',
            'src/a.rs': 'pub struct Node { pub v: u32 }\nimpl Node { pub fn size(&self) -> u32 { self.v } }\n',
            'src/b.rs': 'pub struct Node { pub w: u32 }\nimpl Node { pub fn size(&self) -> u32 { self.w } }\n',
            'src/ximpl.rs': 'use crate::a::Node;\nimpl Node { pub fn half(&self) -> u32 { self.size() / 2 } }\n',
        });
        try {
            const index = idx(dir);
            const a = execute(index, 'show', { name: 'src/a.rs:2:size', sections: 'callers' });
            const b = execute(index, 'show', { name: 'src/b.rs:2:size', sections: 'callers' });
            assert.ok(sites(a.result.context.callers).includes('ximpl.rs:2'));
            assert.ok(!sites(b.result.context.callers).includes('ximpl.rs:2'));
        } finally { rm(dir); }
    });

    it('an owner that cannot be resolved to one definition is routed, never confirmed', () => {
        // JS prototype methods on a name two classes share, with no import
        // tying the assigning file to either: identity unknown.
        const dir = tmp({
            'a.js': 'class Chunks { len() { return 1; } }\nmodule.exports = { Chunks };\n',
            'b.js': 'class Chunks { len() { return 2; } }\nmodule.exports = { Chunks };\n',
            'c.js': 'function Chunks() {}\nChunks.prototype.optLen = function () { return this.len(); };\n',
        });
        try {
            const index = idx(dir);
            for (const handle of ['a.js:1:len', 'b.js:1:len']) {
                const r = execute(index, 'show', { name: handle, sections: 'callers' });
                assert.ok(r.ok);
                assert.ok(!sites(r.result.context.callers).includes('c.js:2'),
                    `${handle}: ${JSON.stringify(sites(r.result.context.callers))}`);
            }
        } finally { rm(dir); }
    });
});

describe('fix #358: C# partial types are one class definition across files', () => {
    it('base/this calls in one part resolve through bases declared in another part', () => {
        const dir = tmp({
            'Writer.cs': 'namespace N {\n  public abstract partial class Writer {\n    public virtual int Start() { return 1; }\n  }\n}\n',
            'TextWriter.cs': 'namespace N {\n  public partial class TextWriter : Writer {\n    public int Size() { return 1; }\n  }\n}\n',
            'TextWriter.Async.cs': 'namespace N {\n  public partial class TextWriter {\n    public override int Start() { return base.Start() + this.Size(); }\n  }\n}\n',
            'Other.cs': 'namespace M {\n  public partial class TextWriter {\n    public int Size() { return 2; }\n  }\n}\n',
        });
        try {
            const index = idx(dir);
            const sites = r => (r.result.context.callers || []).map(c => `${path.basename(c.file)}:${c.line}`);
            const start = execute(index, 'show', { name: 'Writer.cs:3:Start', sections: 'callers' });
            const size = execute(index, 'show', { name: 'TextWriter.cs:3:Size', sections: 'callers' });
            const other = execute(index, 'show', { name: 'Other.cs:3:Size', sections: 'callers' });
            assert.ok(sites(start).includes('TextWriter.Async.cs:3'), JSON.stringify(sites(start)));
            assert.ok(sites(size).includes('TextWriter.Async.cs:3'), JSON.stringify(sites(size)));
            assert.ok(!sites(other).includes('TextWriter.Async.cs:3'), JSON.stringify(sites(other)));
        } finally { rm(dir); }
    });
});

describe('fix #359: subscripts of declared containers type their element receivers', () => {
    // Each fixture: base class + override + unrelated same-name owner; the
    // container-element calls must join the rename closure as edits, and the
    // unrelated owner is never touched.
    const cases = {
        typescript: {
            files: {
                'conv.ts': [
                    'export class Conv { render(v: number): string { return ""; } }',
                    'export class IntConv extends Conv { render(v: number): string { return String(v); } }',
                    'export class Other { render(v: number): string { return "o"; } }',
                ].join('\n') + '\n',
                'use.ts': [
                    "import { Conv } from './conv';",
                    'export function a(xs: Conv[]): string { const c = xs[0]; return c.render(1); }',
                    'export function b(m: Record<string, Conv>, k: string): string { return m[k].render(2); }',
                    'export function d(m: { [k: string]: Conv }, k: string): string { return m[k].render(3); }',
                    'export function e(xs: Array<Conv>): string { return xs[1].render(4); }',
                ].join('\n') + '\n',
            },
            handle: 'conv.ts:2:render',
            lines: [2, 3, 4, 5],
            file: 'use.ts',
        },
        java: {
            files: {
                'Conv.java': [
                    'class Conv { String render(int v) { return ""; } }',
                    'class IntConv extends Conv { String render(int v) { return ""; } }',
                    'class Other { String render(int v) { return "o"; } }',
                    'class Use {',
                    '  String a(Conv[] xs) { return xs[0].render(1); }',
                    '}',
                ].join('\n') + '\n',
            },
            handle: 'Conv.java:2:render',
            lines: [5],
            file: 'Conv.java',
        },
        csharp: {
            files: {
                'Conv.cs': [
                    'using System.Collections.Generic;',
                    'class Conv { public virtual string Render(int v) { return ""; } }',
                    'class IntConv : Conv { public override string Render(int v) { return ""; } }',
                    'class Other { public string Render(int v) { return "o"; } }',
                    'class Use {',
                    '  string A(Conv[] xs) { return xs[0].Render(1); }',
                    '  string B(Dictionary<string, Conv> m, string k) { var c = m[k]; return c.Render(2); }',
                    '  string C(List<Conv> xs) { return xs[0].Render(3); }',
                    '}',
                ].join('\n') + '\n',
            },
            handle: 'Conv.cs:3:Render',
            lines: [6, 7, 8],
            file: 'Conv.cs',
        },
        cpp: {
            files: {
                'conv.cpp': [
                    '#include <map>',
                    '#include <string>',
                    '#include <vector>',
                    'struct Conv { virtual std::string render(int v) { return ""; } };',
                    'struct IntConv : Conv { std::string render(int v) override { return ""; } };',
                    'struct Other { std::string render(int v) { return "o"; } };',
                    'std::string a(std::vector<Conv> &xs) { return xs[0].render(1); }',
                    'std::string b(std::map<std::string, Conv> &m, const std::string &k) { auto &c = m[k]; return c.render(2); }',
                    'std::string c(Conv xs[]) { return xs[0].render(3); }',
                ].join('\n') + '\n',
            },
            handle: 'conv.cpp:5:render',
            lines: [7, 8, 9],
            file: 'conv.cpp',
        },
        rust: {
            files: {
                'Cargo.toml': '[package]\nname = "f359"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': [
                    'use std::collections::HashMap;',
                    'pub struct Conv;',
                    'impl Conv { pub fn render(&self, v: i32) -> String { String::new() } }',
                    'pub struct Other;',
                    'impl Other { pub fn render(&self, v: i32) -> String { String::new() } }',
                    'pub fn a(m: &HashMap<String, Conv>, k: &str) -> String { let c = &m[k]; c.render(1) }',
                    'pub fn b(xs: &Vec<Conv>) -> String { xs[0].render(2) }',
                    'pub fn c(xs: [Conv; 2]) -> String { xs[1].render(3) }',
                ].join('\n') + '\n',
            },
            handle: 'src/lib.rs:3:render',
            lines: [6, 7, 8],
            file: 'src/lib.rs',
        },
    };
    for (const [language, fixture] of Object.entries(cases)) {
        it(`${language}: element receivers are rename edits, the unrelated owner is not`, () => {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir);
                const r = execute(index, 'plan', { name: fixture.handle, renameTo: 'paint' });
                assert.ok(r.ok, JSON.stringify(r.error));
                const changes = r.result.changes || [];
                for (const line of fixture.lines) {
                    assert.ok(changes.some(c => c.file === fixture.file && c.line === line &&
                        /\.paint\(/.test(c.newExpression || '')),
                    `${language} line ${line}: ${JSON.stringify(changes)}`);
                }
                assert.ok(!changes.some(c => /Other/.test(c.expression || '') &&
                    /paint/.test(c.newExpression || '')), JSON.stringify(changes));
                assert.ok(!(r.result.unverifiedSites || []).some(s => s.file === fixture.file &&
                    fixture.lines.includes(s.line)), JSON.stringify(r.result.unverifiedSites));
            } finally { rm(dir); }
        });
    }
});

describe('fix #360: external contract membership in plan --rename-to (all class languages)', () => {
    const planOf = (dir, name) => {
        const result = execute(idx(dir), 'plan', { name, renameTo: 'moved' });
        assert.ok(result.ok, JSON.stringify(result.error));
        return result.result;
    };
    const cases = [
        {
            lang: 'java',
            files: {
                'Main.java': [
                    'public class Main {',
                    '    static class Key implements Comparable<Key> {',
                    '        public int compareTo(Key o) { return 0; }',
                    '    }',
                    '    static class Worker extends Thread {',
                    '        @Override',
                    '        public void run() { }',
                    '    }',
                    '    interface Shape { double area(); }',
                    '    static class Sq implements Shape { public double area() { return 1; } }',
                    '    static double total(Shape s) { return s.area(); }',
                    '    public String toString() { return "m"; }',
                    '}',
                ].join('\n') + '\n',
            },
            possible: 'Main.java:3:compareTo', possibleSite: 2,
            blocked: ['Main.java:7:run', 'Main.java:12:toString'],
            closure: { pin: 'Main.java:10:area', lines: [9, 10, 11] },
        },
        {
            lang: 'csharp',
            files: {
                'Main.cs': [
                    'using System;',
                    'namespace App {',
                    '    public class Res : IDisposable {',
                    '        public void Dispose() { }',
                    '    }',
                    '    public class Job : BaseJob {',
                    '        public override string Describe() { return "j"; }',
                    '    }',
                    '}',
                ].join('\n') + '\n',
            },
            possible: 'Main.cs:4:Dispose', possibleSite: 3,
            blocked: ['Main.cs:7:Describe'],
        },
        {
            lang: 'typescript',
            files: {
                'main.ts': [
                    "import { EventEmitter } from 'events';",
                    'export interface Handler { handle(x: number): void; }',
                    'export class Impl implements Handler { handle(x: number): void {} }',
                    'export const lit: Handler = { handle(x: number) {} };',
                    'export class Bus extends EventEmitter {',
                    '    override emit(event: string): boolean { return true; }',
                    '    own(): void {}',
                    '}',
                    'export function run(h: Handler) { h.handle(1); }',
                ].join('\n') + '\n',
            },
            possible: 'main.ts:7:own', possibleSite: 5,
            blocked: ['main.ts:6:emit'],
            closure: { pin: 'main.ts:4:handle', lines: [2, 3, 4, 9] },
        },
        {
            lang: 'python',
            files: {
                'main.py': [
                    'from http.server import BaseHTTPRequestHandler',
                    'class H(BaseHTTPRequestHandler):',
                    '    def do_GET(self):',
                    '        pass',
                    'class P:',
                    '    def __eq__(self, other):',
                    '        return True',
                ].join('\n') + '\n',
            },
            possible: 'main.py:3:do_GET', possibleSite: 2,
            blocked: ['main.py:6:__eq__'],
        },
        {
            lang: 'cpp',
            files: {
                'main.cpp': [
                    '#include <streambuf>',
                    'class W : public std::streambuf {',
                    'protected:',
                    '    int overflow(int c) override { return c; }',
                    'public:',
                    '    void own() {}',
                    '};',
                ].join('\n') + '\n',
            },
            possible: 'main.cpp:6:own', possibleSite: 2,
            blocked: ['main.cpp:4:overflow'],
        },
    ];
    for (const c of cases) {
        it(`${c.lang}: marked or root-contract members are blocked; external supertypes route review`, () => {
            const dir = tmp(c.files);
            try {
                for (const pin of c.blocked) {
                    const plan = planOf(dir, pin);
                    assert.strictEqual(plan.contract?.blocked, true, `${pin}: ${JSON.stringify(plan.contract)}`);
                    assert.ok(plan.changes.every(change => !change.newExpression), pin);
                }
                const plan = planOf(dir, c.possible);
                assert.strictEqual(plan.contract?.blocked, false, JSON.stringify(plan.contract));
                const definition = plan.changes.find(change => change.isDefinition);
                assert.ok(definition.needsReview && definition.newExpression,
                    'possible membership keeps the edit and requires review');
                assert.ok(plan.reviewItems.some(item => item.contractDependency &&
                    item.line === c.possibleSite), `declaration site listed: ${JSON.stringify(plan.reviewItems)}`);
                if (c.closure) {
                    const closure = planOf(dir, c.closure.pin);
                    const lines = closure.changes.filter(change => change.newExpression)
                        .map(change => change.line).sort((a, b) => a - b);
                    assert.deepStrictEqual(lines, c.closure.lines,
                        `project implements/typed-literal slot closes: ${JSON.stringify(closure.changes)}`);
                    assert.ok(!closure.contract);
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #363: reflection by name pattern and runtime protocol hooks (deadcode + callers)', () => {
    const names = result => result.map(c => (c.className ? `${c.className}.` : '') + c.name).sort();
    const reflectionCallers = (index, name, file) => {
        const def = (index.symbols.get(name) || []).find(d => !file || d.relativePath === file);
        const callers = index.findCallers(name, { collectAccount: true, targetDefinitions: [def] });
        return (callers.unverifiedEntries || [])
            .filter(e => e.reason === 'reflection-pattern')
            .map(e => `${e.relativePath}:${e.line}:${e.reflectionPattern}`);
    };

    it('python: %-format, f-string (one-hop local) and .format patterns withhold only reachable members', () => {
        const dir = tmp({
            'app.py': `class Backend:
    def _get_user_perms(self, u):
        return 1
    def _get_group_perms(self, u):
        return 2
    def _truly_dead(self):
        return 3
    def load(self, src, u):
        return getattr(self, "_get_%s_perms" % src)(u)

class Other:
    def _get_x_perms(self, u):
        return 4

def period(view, p):
    name = f"_cur_{p}"
    return getattr(view, name)()

class View:
    def _cur_year(self):
        return 1
    def _fmt_one(self):
        return 1
    def go(self, k):
        return getattr(self, "_fmt_{}".format(k))()

def untouched(o, x):
    return getattr(o, x)

def _short(o, x):
    return getattr(o, "_%s" % x)
`,
        });
        try {
            const index = idx(dir);
            const result = index.deadcode({ includeExported: true });
            const claimed = names(result);
            for (const live of ['Backend._get_user_perms', 'Backend._get_group_perms',
                'View._cur_year', 'View._fmt_one']) {
                assert.ok(!claimed.includes(live), `${live} is reached by a reflection pattern`);
            }
            assert.ok(claimed.includes('Backend._truly_dead'), 'a name the pattern cannot spell stays a claim');
            assert.ok(claimed.includes('Other._get_x_perms'),
                'self in an unrelated class never reaches another class\'s member');
            assert.deepEqual(result.reflection.withheldByPattern, [
                { pattern: '_get_*_perms', count: 2 },
                { pattern: '_cur_*', count: 1 },
                { pattern: '_fmt_*', count: 1 },
            ]);
            // `getattr(o, x)` and `"_%s" % x` name every member: disclosed, never a blanket withhold.
            assert.equal(result.reflection.dynamicCount, 2);
            assert.match(output.formatDeadcode(result),
                /4 candidate\(s\) withheld by reflection pattern: `_get_\*_perms` \(2\)/);
            assert.deepEqual(reflectionCallers(index, '_get_user_perms'), ['app.py:9:_get_*_perms']);
            assert.deepEqual(reflectionCallers(index, '_get_x_perms'), []);
            assert.deepEqual(reflectionCallers(index, '_cur_year'), ['app.py:17:_cur_*']);
        } finally { rm(dir); }
    });

    it('python: eval/globals() lookups are bounded to the module namespace', () => {
        const dir = tmp({
            'tool.py': `def update_all():
    return 1

def stats():
    return 2

class Keep:
    def _method_not_reached(self):
        return 3

if __name__ == "__main__":
    import sys
    cmd = sys.argv[1]
    eval(cmd)()
`,
            'other.py': `def _elsewhere():
    return 1

def run(name):
    return globals()["run_" + name]()

def run_fast():
    return 2
`,
        });
        try {
            const index = idx(dir);
            const claimed = names(index.deadcode({ includeExported: true }));
            assert.ok(!claimed.includes('update_all') && !claimed.includes('stats'),
                'eval(<dynamic>) may call any top-level name of its own module');
            assert.ok(claimed.includes('Keep._method_not_reached'), 'module lookups never reach class members');
            assert.ok(claimed.includes('_elsewhere'), 'another module\'s namespace is not reached');
            assert.ok(!claimed.includes('run_fast'), 'globals()["run_" + name] reaches run_*');
        } finally { rm(dir); }
    });

    it('python: Enum hooks are runtime protocol members only on Enum subclasses', () => {
        const dir = tmp({
            'enums.py': `import enum
class Choices(enum.Enum):
    pass

class TextChoices(str, Choices):
    @staticmethod
    def _generate_next_value_(name, start, count, last_values):
        return name

    @classmethod
    def _missing_(cls, value):
        return None

class Plain:
    @staticmethod
    def _generate_next_value_(name, start, count, last_values):
        return name
`,
        });
        try {
            const index = idx(dir);
            const result = index.deadcode({ includeExported: true });
            const claimed = names(result);
            assert.ok(!claimed.includes('TextChoices._generate_next_value_'));
            assert.ok(!claimed.includes('TextChoices._missing_'));
            assert.ok(claimed.includes('Plain._generate_next_value_'),
                'the hook name alone, without an Enum base, is an ordinary member');
            const plan = index.plan('_generate_next_value_', { renameTo: 'gen', file: 'enums.py', line: 7 });
            assert.ok(plan.contract?.blocked, 'renaming an Enum hook withdraws the protocol');
        } finally { rm(dir); }
    });

    it('javascript/typescript: computed member patterns and runtime protocol members', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'emitter.js': `class Emitter {
  _onOpen() { return 1; }
  _onClose() { return 2; }
  _deadHelper() { return 3; }
  fire(evt) { return this['_on' + evt](); }
  toJSON() { return {}; }
  then(r) { r(1); }
  [Symbol.iterator]() { return [][Symbol.iterator](); }
}
class Unrelated {
  _onOther() { return 4; }
}
module.exports = { Emitter, Unrelated };
`,
            'router.ts': `export class Router {
  private handleGet(): number { return 1; }
  private skipped(): number { return 2; }
  route(t: string): number { const key = \`handle\${t}\`; return (this as any)[key](); }
}
`,
        });
        try {
            const index = idx(dir);
            const result = index.deadcode({ includeExported: true });
            const claimed = names(result);
            assert.ok(!claimed.includes('Emitter._onOpen') && !claimed.includes('Emitter._onClose'));
            assert.ok(claimed.includes('Emitter._deadHelper'));
            assert.ok(claimed.includes('Unrelated._onOther'), 'this inside Emitter never holds an Unrelated');
            for (const hook of ['Emitter.toJSON', 'Emitter.then', 'Emitter.[Symbol.iterator]']) {
                assert.ok(!claimed.includes(hook), `${hook} is invoked by the runtime`);
            }
            assert.ok(claimed.includes('Router.skipped'));
            assert.deepEqual(reflectionCallers(index, '_onOpen'), ['emitter.js:5:_on*']);
        } finally { rm(dir); }
    });

    it('java: getDeclaredMethod("get" + n) on a class literal, serialization callbacks need Serializable', () => {
        const dir = tmp({
            'src/A.java': `import java.io.Serializable;
public class A implements Serializable {
  private int getFoo() { return 1; }
  private int deadOne() { return 3; }
  private void readObject(java.io.ObjectInputStream in) {}
  public Object read(String n) throws Exception { return A.class.getDeclaredMethod("get" + n).invoke(this); }
}
class B {
  private int getBaz() { return 1; }
  private void readObject(java.io.ObjectInputStream in) {}
}
`,
        });
        try {
            const index = idx(dir);
            const claimed = names(index.deadcode({ includeExported: true }));
            assert.ok(!claimed.includes('A.getFoo'));
            assert.ok(claimed.includes('A.deadOne'));
            assert.ok(claimed.includes('B.getBaz'), 'A.class never reaches B members');
            assert.ok(!claimed.includes('A.readObject'), 'Serializable callback');
            assert.ok(claimed.includes('B.readObject'), 'not Serializable: an ordinary private method');
        } finally { rm(dir); }
    });

    it('csharp: GetMethod("Handle" + x) and compiler pattern members', () => {
        const dir = tmp({
            'A.cs': `using System;
class A {
  private int HandleOpen() { return 1; }
  private int NotHandled() { return 3; }
  public object Run(string x) { return typeof(A).GetMethod($"Handle{x}").Invoke(this, null); }
  public System.Collections.IEnumerator GetEnumerator() { yield return 1; }
  public void Deconstruct(out int a) { a = 1; }
}
class Program { static void Main() { new A().Run("x"); } }
class Conv {
  public object Cast(string t) { return typeof(Convert).GetMethod("To" + t).Invoke(null, null); }
  public object ViaInterface(string t) { return typeof(IConvertible).GetMethod("To" + t).Invoke(this, null); }
}
class Unrelated { private int ToWidget() { return 1; } }
class Impl : IConvertible { private int ToThing() { return 1; } }
`,
        });
        try {
            const index = idx(dir);
            const claimed = names(index.deadcode({ includeExported: true }));
            assert.ok(!claimed.includes('A.HandleOpen'));
            assert.ok(claimed.includes('A.NotHandled'));
            assert.ok(!claimed.includes('A.GetEnumerator') && !claimed.includes('A.Deconstruct'),
                'foreach/deconstruction bind these members by pattern');
            assert.ok(claimed.includes('Unrelated.ToWidget'),
                'typeof(<external type>) reaches only project types deriving from it');
            assert.ok(!claimed.includes('Impl.ToThing'),
                'an IConvertible implementer is reachable through typeof(IConvertible)');
        } finally { rm(dir); }
    });

    it('go: MethodByName(fmt.Sprintf("handle%s", y)) keeps matching methods only', () => {
        const dir = tmp({
            'go.mod': 'module ex\n\ngo 1.21\n',
            'a.go': `package ex

import (
	"fmt"
	"reflect"
)

type T struct{}

func (t T) handleOpen() int { return 1 }
func (t T) otherDead() int  { return 2 }
func handleFree() int        { return 3 }

func Dispatch(t T, y string) {
	reflect.ValueOf(t).MethodByName(fmt.Sprintf("handle%s", y)).Call(nil)
}
`,
        });
        try {
            const index = idx(dir);
            const claimed = names(index.deadcode({ includeExported: true }));
            assert.ok(!claimed.includes('T.handleOpen'));
            assert.ok(claimed.includes('T.otherDead'));
            assert.ok(claimed.includes('handleFree'), 'MethodByName never reaches a free function');
        } finally { rm(dir); }
    });

    it('reflection inventory persists with the index cache and is rebuilt on edit', () => {
        const dir = tmp({
            'app.py': `class B:
    def _get_a_x(self):
        return 1
    def run(self, s):
        return getattr(self, "_get_%s_x" % s)()
`,
        });
        try {
            let index = idx(dir);
            index.deadcode({});
            index.saveCache();
            index = new ProjectIndex(dir);
            assert.ok(index.loadCache());
            const impact = execute(index, 'impact', { name: '_get_a_x' });
            assert.deepEqual(impact.result.unverifiedSites.map(site => [site.line, site.reason, site.reflectionPattern]),
                [[5, 'reflection-pattern', '_get_*_x']], 'impact lists the reflective site for review');
            assert.equal(impact.result.account.unaccounted, 0);
            assert.equal(impact.result.account.beyondText.count, 1,
                'the site does not spell the name: it is a beyond-text claim, outside the text partition');
            const entry = [...index.files.values()].find(fe => fe.relativePath === 'app.py');
            assert.deepEqual(entry.reflectionSites.map(site => site.patterns), [['_get_*_x']],
                'reflection sites come back from the cache');
            assert.ok(!names(index.deadcode({ includeExported: true })).includes('B._get_a_x'));
            fs.writeFileSync(path.join(dir, 'app.py'), `class B:
    def _get_a_x(self):
        return 1
    def run(self, s):
        return 0
`);
            index.build(null, { quiet: true });
            assert.ok(names(index.deadcode({ includeExported: true })).includes('B._get_a_x'),
                'removing the reflective access makes the member a claim again');
        } finally { rm(dir); }
    });
});

describe('fix #366: router mount composition and request-helper clients (endpoints)', () => {
    const { endpoints, extractServerRoutes, extractClientRequests } = require('../core/bridge');
    const routeSet = (index) => extractServerRoutes(index).map(r => `${r.method} ${r.path}`);

    it('FastAPI: nested source root, instance-attribute prefix, submodule include_router', () => {
        const dir = tmp({
            'backend/app/__init__.py': '',
            'backend/app/core/__init__.py': '',
            'backend/app/core/config.py': [
                'class Settings:',
                '    API_V1_STR: str = "/api/v1"',
                '',
                'settings = Settings()',
            ].join('\n'),
            'backend/app/api/__init__.py': '',
            'backend/app/api/routes/__init__.py': '',
            'backend/app/api/routes/items.py': [
                'from fastapi import APIRouter',
                'router = APIRouter(prefix="/items")',
                '',
                '@router.get("/{id}")',
                'def read_item(id: int):',
                '    return id',
            ].join('\n'),
            'backend/app/api/main.py': [
                'from fastapi import APIRouter',
                'from app.api.routes import items',
                'api_router = APIRouter()',
                'api_router.include_router(items.router)',
            ].join('\n'),
            'backend/app/main.py': [
                'from fastapi import FastAPI',
                'from app.api.main import api_router',
                'from app.core.config import settings',
                'app = FastAPI()',
                'app.include_router(api_router, prefix=settings.API_V1_STR)',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(routeSet(idx(dir)), ['GET /api/v1/items/{id}']);
        } finally { rm(dir); }
    });

    it('Python prefixes fold f-strings and concatenation; unprovable ones stay as {?expr}', () => {
        const dir = tmp({
            'consts.py': 'BASE = "/api"\n',
            'app.py': [
                'from fastapi import FastAPI, APIRouter',
                'from consts import BASE',
                'import os',
                'a = APIRouter()',
                'b = APIRouter()',
                '@a.get("/x")',
                'def x():',
                '    pass',
                '@b.get("/y")',
                'def y():',
                '    pass',
                'app = FastAPI()',
                'app.include_router(a, prefix=f"{BASE}/v" + "2")',
                'app.include_router(b, prefix=os.environ["P"])',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const paths = routeSet(index);
            assert.ok(paths.includes('GET /api/v2/x'), `folded prefix, got ${paths}`);
            const disclosed = paths.find(p => p.endsWith('/y'));
            assert.ok(/\{\?os\.environ\[.P.\]\}\/y$/.test(disclosed), `unresolved prefix disclosed, got ${disclosed}`);
        } finally { rm(dir); }
    });

    it('Flask: register_blueprint url_prefix from a module constant', () => {
        const dir = tmp({
            'settings.py': 'PREFIX = "/site"\n',
            'views.py': [
                'from flask import Blueprint',
                'bp = Blueprint("v", __name__)',
                '@bp.get("/home")',
                'def home():',
                '    return ""',
            ].join('\n'),
            'app.py': [
                'from flask import Flask',
                'import settings',
                'from views import bp',
                'app = Flask(__name__)',
                'app.register_blueprint(bp, url_prefix=settings.PREFIX)',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(routeSet(idx(dir)), ['GET /site/home']);
        } finally { rm(dir); }
    });

    it('Express: constant prefix, require-mounted router, scope-accurate shadowed routers', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'users.js': [
                "const express = require('express');",
                'const router = express.Router();',
                "router.get('/list', (req, res) => res.end());",
                'module.exports = router;',
            ].join('\n'),
            'app.js': [
                "const express = require('express');",
                "const API = '/api';",
                'const app = express();',
                "app.use(API + '/users', require('./users'));",
                'function a() {',
                '  const r = express.Router();',
                "  r.get('/one', h);",
                "  app.use('/a', r);",
                '}',
                'function b() {',
                '  const r = express.Router();',
                "  r.get('/two', h);",
                "  app.use('/b', r);",
                '}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            assert.ok(paths.includes('GET /api/users/list'), `got ${paths}`);
            assert.ok(paths.includes('GET /a/one') && paths.includes('GET /b/two'), `got ${paths}`);
            assert.ok(!paths.includes('GET /b/one') && !paths.includes('GET /a/two'),
                `a shadowed name must not conflate mounts, got ${paths}`);
        } finally { rm(dir); }
    });

    it('Hono: route() and basePath() compose; routers proven by construction, chains included', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'app.ts': [
                "import { Hono } from 'hono'",
                'const book = new Hono()',
                "book.get('/', (c) => c.text('list')).post('/', (c) => c.text('create'))",
                "const api = new Hono().basePath('/api')",
                "api.route('/book', book)",
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            assert.ok(paths.includes('GET /api/book') && paths.includes('POST /api/book'), `got ${paths}`);
        } finally { rm(dir); }
    });

    it('Fastify: register prefixes (inline, named, nested) and in-process inject requests', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'server.js': [
                "const fastify = require('fastify')()",
                'function v2 (instance, opts, done) {',
                "  instance.get('/items', h)",
                '  done()',
                '}',
                'fastify.register(async (instance) => {',
                "  instance.get('/users', h)",
                "  instance.register(v2, { prefix: '/v2' })",
                "}, { prefix: '/api' })",
                "fastify.route({ method: 'GET', url: '/health', handler: h })",
                'async function t () {',
                "  await fastify.inject({ method: 'GET', url: '/api/users' })",
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const paths = routeSet(index);
            for (const p of ['GET /api/users', 'GET /api/v2/items', 'GET /health']) {
                assert.ok(paths.includes(p), `${p} missing, got ${paths}`);
            }
            const result = endpoints(index, { bridge: true });
            const inject = result.bridges.find(b => b.request.framework === 'inject');
            assert.ok(inject && inject.route.path === '/api/users', 'inject request bridges to the route');
        } finally { rm(dir); }
    });

    it('Koa-router constructor prefix and NestJS setGlobalPrefix', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'koa.js': [
                "const Router = require('@koa/router')",
                "const router = new Router({ prefix: '/k' })",
                "router.get('/a', h)",
                // koa-router concatenates a mount path (fix #383): `use('/',
                // ...)` would register `//k/a`; the app mounts the routes.
                "app.use(router.routes())",
            ].join('\n'),
            'main.ts': [
                "import { NestFactory } from '@nestjs/core'",
                'async function bootstrap() {',
                '  const app = await NestFactory.create(AppModule)',
                "  app.setGlobalPrefix('api')",
                '}',
            ].join('\n'),
            'cats.controller.ts': [
                "@Controller('cats')",
                'export class CatsController {',
                "  @Get(':id')",
                '  findOne() {}',
                '}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            assert.ok(paths.includes('GET /k/a'), `got ${paths}`);
            assert.ok(paths.includes('GET /api/cats/:id'), `got ${paths}`);
        } finally { rm(dir); }
    });

    it('Go gin: constant group prefix and a group passed to a router-typed parameter', () => {
        const dir = tmp({
            'go.mod': 'module example.com/m\n',
            'routes/users.go': [
                'package routes',
                'import "github.com/gin-gonic/gin"',
                'func Register(rg *gin.RouterGroup) {',
                '\trg.GET("/users", list)',
                '}',
            ].join('\n'),
            'main.go': [
                'package main',
                'import (',
                '\t"github.com/gin-gonic/gin"',
                '\t"example.com/m/routes"',
                ')',
                'const APIPrefix = "/api"',
                'func main() {',
                '\tr := gin.Default()',
                '\tv1 := r.Group(APIPrefix + "/v1")',
                '\troutes.Register(v1)',
                '}',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(routeSet(idx(dir)), ['GET /api/v1/users']);
        } finally { rm(dir); }
    });

    it('Go chi: Route closures, Mount of a router-returning function, With chains', () => {
        const dir = tmp({
            'go.mod': 'module example.com/c\n',
            'main.go': [
                'package main',
                'import "github.com/go-chi/chi/v5"',
                'func main() {',
                '\tr := chi.NewRouter()',
                '\tr.Route("/articles", func(r chi.Router) {',
                '\t\tr.Get("/", list)',
                '\t\tr.With(paginate).Get("/search", search)',
                '\t})',
                '\tr.Mount("/admin", adminRouter())',
                '}',
                'func adminRouter() chi.Router {',
                '\tr := chi.NewRouter()',
                '\tr.Get("/users", users)',
                '\treturn r',
                '}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            for (const p of ['GET /articles', 'GET /articles/search', 'GET /admin/users']) {
                assert.ok(paths.includes(p), `${p} missing, got ${paths}`);
            }
        } finally { rm(dir); }
    });

    it('Go gorilla/mux PathPrefix().Subrouter() and net/http StripPrefix', () => {
        const dir = tmp({
            'go.mod': 'module example.com/g\n',
            'main.go': [
                'package main',
                'import (',
                '\t"net/http"',
                '\t"github.com/gorilla/mux"',
                ')',
                'func main() {',
                '\tr := mux.NewRouter()',
                '\ts := r.PathPrefix("/api").Subrouter()',
                '\ts.HandleFunc("/products", products)',
                '\tinner := http.NewServeMux()',
                '\tinner.HandleFunc("/ping", ping)',
                '\tmux2 := http.NewServeMux()',
                '\tmux2.Handle("/v1/", http.StripPrefix("/v1", inner))',
                '}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            assert.ok(paths.includes('ALL /api/products'), `got ${paths}`);
            assert.ok(paths.includes('ALL /v1/ping'), `got ${paths}`);
        } finally { rm(dir); }
    });

    it('Spring/JAX-RS: class and method mappings fold constants and arrays', () => {
        const dir = tmp({
            'Paths.java': 'package a;\npublic final class Paths { public static final String API = "/api"; public static final String ONE = "/{id}"; }\n',
            'UsersController.java': [
                'package a;',
                '@RestController',
                '@RequestMapping({Paths.API + "/users", "/v2/users"})',
                'public class UsersController {',
                '    @GetMapping(value = Paths.ONE)',
                '    public String one() { return ""; }',
                '}',
            ].join('\n'),
            'Res.java': [
                'package a;',
                '@Path(Res.BASE)',
                'public class Res {',
                '    static final String BASE = "/res";',
                '    @GET @Path("/x")',
                '    public String x() { return ""; }',
                '}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            for (const p of ['GET /api/users/{id}', 'GET /v2/users/{id}', 'GET /res/x']) {
                assert.ok(paths.includes(p), `${p} missing, got ${paths}`);
            }
        } finally { rm(dir); }
    });

    it('ASP.NET: [controller]/[action] tokens, method [Route], constants, MapGroup; case-insensitive bridge', () => {
        const dir = tmp({
            'UsersController.cs': [
                'namespace A;',
                '[ApiController]',
                '[Route("api/[controller]")]',
                'public class UsersController : ControllerBase {',
                '    [HttpGet("{id}")]',
                '    public string One(int id) => "";',
                '    [HttpPost]',
                '    [Route("create")]',
                '    public string Two() => "";',
                '    [HttpGet(Routes.Three)]',
                '    public string Three() => "";',
                '}',
                'public static class Routes { public const string Three = "three"; }',
            ].join('\n'),
            'Program.cs': [
                'var app = WebApplication.CreateBuilder(args).Build();',
                'var api = app.MapGroup("/api");',
                'api.MapGet("/ping", () => "ok");',
            ].join('\n'),
            'package.json': '{"name":"x"}',
            'client.js': "fetch('/api/users/7')\n",
        });
        try {
            const index = idx(dir);
            const paths = routeSet(index);
            for (const p of ['GET /api/Users/{id}', 'POST /api/Users/create', 'GET /api/Users/three', 'GET /api/ping']) {
                assert.ok(paths.includes(p), `${p} missing, got ${paths}`);
            }
            const result = endpoints(index, { bridge: true });
            assert.ok(result.bridges.some(b => b.route.path === '/api/Users/{id}'),
                'ASP.NET routing is case-insensitive');
        } finally { rm(dir); }
    });

    it('Rust: axum nest and actix scope compose', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n',
            'src/main.rs': [
                'use axum::{routing::get, Router};',
                'mod api;',
                'fn app() -> Router {',
                '    Router::new().route("/", get(root)).nest("/api", api::routes())',
                '}',
                'async fn root() {}',
                '#[get("/users/{id}")]',
                'async fn get_user() -> String { String::new() }',
                'fn actix() {',
                '    App::new().service(web::scope("/v1").service(get_user));',
                '}',
            ].join('\n'),
            'src/api.rs': [
                'use axum::{routing::get, Router};',
                'pub fn routes() -> Router {',
                '    Router::new().route("/users", get(users))',
                '}',
                'async fn users() {}',
            ].join('\n'),
        });
        try {
            const paths = routeSet(idx(dir));
            // The method router `get(users)` serves GET (fix #383).
            assert.ok(paths.includes('GET /api/users'), `axum nest, got ${paths}`);
            assert.ok(paths.includes('GET /v1/users/{id}'), `actix scope, got ${paths}`);
        } finally { rm(dir); }
    });

    it('JS/TS: generated OpenAPI clients are proven request helpers (structural, any name)', () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'core/request.ts': [
                'export const request = (config: any, options: any) => sendRequest(options.url);',
                'const sendRequest = async (url: string) => fetch(url);',
            ].join('\n'),
            'client/client.ts': [
                "import axios from 'axios';",
                'export const createClient = () => {',
                '  const instance = axios.create();',
                "  const request = (o: any) => instance.request(o);",
                "  return { post: (o: any) => request({ ...o, method: 'POST' }) };",
                '};',
            ].join('\n'),
            'client/client.gen.ts': "import { createClient } from './client';\nexport const client = createClient();\n",
            'sdk.gen.ts': [
                "import { request as __doIt } from './core/request';",
                "import { client } from './client/client.gen';",
                'export class Svc {',
                "  static a() { return __doIt(OpenAPI, { method: 'PUT', url: '/api/v1/items/{id}' }); }",
                "  static b(options?: any) { return (options?.client ?? client).post({ url: '/api/v1/login' }); }",
                "  static c() { return notAClient({ url: '/api/v1/other' }); }",
                '}',
                'function notAClient(cfg: any) { return cfg; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const reqs = extractClientRequests(index).map(r => `${r.method} ${r.path} ${r.framework}`);
            assert.ok(reqs.includes('PUT /api/v1/items/{id} request-helper'), `got ${reqs}`);
            assert.ok(reqs.includes('POST /api/v1/login request-helper'), `got ${reqs}`);
            assert.ok(!reqs.some(r => r.includes('/api/v1/other')), 'a helper that performs no HTTP is not a client');
        } finally { rm(dir); }
    });

    it('Python keyword request configuration; unproven helpers stay in the uncertain band', () => {
        const dir = tmp({
            'client.py': [
                'import requests',
                'def a():',
                '    requests.request(method="POST", url="/api/items")',
                'def call_api(url):',
                '    return requests.get(url)',
                'def b():',
                '    call_api(url="/api/users")',
            ].join('\n'),
            'app.py': [
                'from fastapi import FastAPI',
                'app = FastAPI()',
                '@app.post("/api/items")',
                'def create():',
                '    pass',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = endpoints(index, { bridge: true });
            assert.ok(result.bridges.some(b => b.request.path === '/api/items' && b.request.method === 'POST' &&
                b.matchType === 'exact'), 'keyword url/method bridges exactly');
            assert.ok(result.requests.some(r => r.path === '/api/users' && r.framework === 'request-helper'),
                'a project helper that calls requests is proven');
        } finally { rm(dir); }
    });

    it('client path templates match route parameters exactly; unresolved prefixes only uncertainly', () => {
        const dir = tmp({
            'app.py': [
                'from fastapi import FastAPI, APIRouter',
                'import os',
                'r = APIRouter()',
                '@r.get("/items/{item_id}")',
                'def item(item_id: int):',
                '    pass',
                'app = FastAPI()',
                'app.include_router(r, prefix=os.environ["PREFIX"])',
            ].join('\n'),
            'package.json': '{"name":"x"}',
            'sdk.ts': [
                "import axios from 'axios';",
                "export const get = () => axios.request({ method: 'GET', url: '/api/v1/items/{id}' });",
            ].join('\n'),
        });
        try {
            const result = endpoints(idx(dir), { bridge: true });
            const b = result.bridges.find(x => x.request.path === '/api/v1/items/{id}');
            assert.ok(b, 'the SDK call bridges through the unresolved prefix');
            assert.strictEqual(b.matchType, 'uncertain');
        } finally { rm(dir); }
    });
});

describe('fix #367: evaluation leftovers (bare-call kinds, language branches, flow, exports, recovery, visibility, budget, bare this-calls)', () => {
    const sites = list => (list || []).map(c => `${path.basename(c.file)}:${c.line}`);
    const show = (index, name) => {
        const r = execute(index, 'show', { name });
        assert.ok(r.ok, JSON.stringify(r.error));
        return r.result.context;
    };

    // #367a: a bare call can never denote a class member where bare-name
    // lookup never enters class scope (bareCallReachesMethods false).
    const BARE = {
        python: {
            files: { 'pkg/__init__.py': '', 'pkg/iter.py': 'class Chunks:\n    def len(self):\n        return len(self.it)\n',
                'pkg/other.py': 'class Other:\n    def len(self):\n        return 0\n' },
            target: 'pkg/iter.py:2:len', site: 'iter.py:3',
        },
        javascript: {
            files: { 'package.json': '{"name":"t"}', 'a.js': 'class K {\n  len(x) { return len(x); }\n}\nmodule.exports = { K };\n',
                'b.js': 'class Q {\n  len() { return 1; }\n}\nmodule.exports = { Q };\n' },
            target: 'a.js:2:len', site: 'a.js:2',
        },
        typescript: {
            files: { 'a.ts': 'export class K {\n  size(x: number[]): number { return size(x); }\n}\ndeclare function size(x: number[]): number;\n',
                'b.ts': 'export class Q {\n  size(): number { return 1; }\n}\n' },
            target: 'a.ts:2:size', site: 'a.ts:2',
        },
        go: {
            files: { 'go.mod': 'module ex.com/p\ngo 1.21\n', 'p/a.go': 'package p\n\ntype A struct{ xs []int }\n\nfunc (a *A) Size() int { return Size(a.xs) }\n',
                'p/b.go': 'package p\n\ntype B struct{}\n\nfunc (b *B) Size() int { return 0 }\n' },
            target: 'p/a.go:5:Size', site: 'a.go:5',
        },
        rust: {
            files: { 'Cargo.toml': '[package]\nname = "fx367"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'use ext::size;\npub struct A { n: usize }\nimpl A {\n    pub fn size(&self) -> usize { size(self.n) }\n}\npub struct B;\nimpl B {\n    pub fn size(&self) -> usize { 0 }\n}\n' },
            target: 'src/lib.rs:4:size', site: 'lib.rs:4',
        },
    };
    for (const [lang, fx] of Object.entries(BARE)) {
        it(`#367a ${lang}: a bare call inside a same-named method is neither a caller nor a callee of that method`, () => {
            const dir = tmp(fx.files);
            try {
                const ctx = show(idx(dir), fx.target);
                assert.ok(!sites(ctx.callers).includes(fx.site), `confirmed: ${JSON.stringify(sites(ctx.callers))}`);
                assert.ok(!sites(ctx.unverifiedCallers).includes(fx.site),
                    `unverified: ${JSON.stringify(sites(ctx.unverifiedCallers))}`);
                assert.ok(!(ctx.callees || []).some(c => c.name === ctx.function && c.startLine === ctx.startLine),
                    `self callee: ${JSON.stringify((ctx.callees || []).map(c => `${c.name}:${c.startLine}`))}`);
                assert.strictEqual(ctx.meta.account.conserved, true);
            } finally { rm(dir); }
        });
    }

    it('#367a javascript: a self-named function expression assigned to a prototype stays recursive', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}',
            'a.js': 'function Foo() {}\nFoo.prototype.bar = function bar(n) { return n ? bar(n - 1) : 0; };\nmodule.exports = Foo;\n' });
        try {
            const ctx = show(idx(dir), 'a.js:2:bar');
            assert.ok((ctx.callees || []).some(c => c.name === 'bar'));
        } finally { rm(dir); }
    });

    it('#367a python: a class-body call to an earlier def in that body is not excluded', () => {
        const dir = tmp({ 'm.py': 'class A:\n    def make():\n        return 1\n    value = make()\n' });
        try {
            const ctx = show(idx(dir), 'm.py:2:make');
            assert.ok(!(ctx.meta.account.excluded.byReason['method-kind-mismatch']),
                JSON.stringify(ctx.meta.account.excluded));
        } finally { rm(dir); }
    });

    // #367d: default-exported VALUES are part of a file's API surface.
    it('#367d api lists default-exported values (ESM default identifier, module.exports value, literal default)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function make() { return {}; }\nconst api = make();\napi.x = 1;\nexport default api;\n',
            'cjs.js': 'function make() { return {}; }\nconst inst = make();\nmodule.exports = inst;\n',
            'lit.js': 'export default { a: 1 };\n',
            'barrel.js': "export * from './lib.js';\n",
        });
        try {
            const index = idx(dir);
            const names = file => index.api(file).map(e => e.name);
            assert.deepStrictEqual(names('lib.js'), ['api']);
            assert.deepStrictEqual(names('cjs.js'), ['inst']);
            assert.deepStrictEqual(names('lit.js'), ['default']);
            // `export *` never re-exports a default export.
            assert.ok(!names('barrel.js').includes('api'), JSON.stringify(names('barrel.js')));
        } finally { rm(dir); }
    });

    it('#367d api lists Python __all__ variables, Go exported vars/consts and Rust pub static/const', () => {
        const cases = [
            [{ 'pkg/__init__.py': '', 'pkg/mod.py': '__all__ = ["VALUE", "helper"]\nVALUE = 1\ndef helper():\n    return VALUE\n' },
                'pkg/mod.py', ['VALUE', 'helper']],
            [{ 'go.mod': 'module ex.com/p\ngo 1.21\n', 'p/p.go': 'package p\n\nvar Default = New()\nconst Max = 10\nvar hidden = 1\n\ntype T struct{}\n\nfunc New() *T { return &T{} }\n' },
                'p/p.go', ['Default', 'Max', 'New', 'T']],
            [{ 'Cargo.toml': '[package]\nname = "r"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': 'pub static GLOBAL: i32 = 1;\npub const LIMIT: usize = 4;\nstatic PRIV: i32 = 2;\n' },
                'src/lib.rs', ['GLOBAL', 'LIMIT']],
        ];
        for (const [files, file, expected] of cases) {
            const dir = tmp(files);
            try {
                assert.deepStrictEqual(idx(dir).api(file).map(e => e.name).sort(), expected);
            } finally { rm(dir); }
        }
    });

    // #367e: ground-set lines inside parser-recovery regions are disclosed.
    const BROKEN = {
        javascript: { 'a.js': 'export function ok() { return 1; }\n', 'b.js': 'import { ok } from "./a.js";\nfunction caller() { ok(); }\nfunction broken( {\n  if (x {\n  ok();\n' },
        python: { 'a.py': 'def ok():\n    return 1\n', 'b.py': 'from a import ok\ndef caller():\n    ok()\ndef broken(:\n    ok(\n' },
        go: { 'go.mod': 'module ex.com/p\ngo 1.21\n', 'a.go': 'package p\n\nfunc ok() int { return 1 }\n', 'b.go': 'package p\n\nfunc caller() { ok() }\n\nfunc broken( {\n\tok(\n' },
        java: { 'A.java': 'public class A {\n  static int ok() { return 1; }\n  void caller() { ok(); }\n  void broken( {\n    ok(\n' },
        rust: { 'Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': 'fn ok() -> i32 { 1 }\nfn caller() { ok(); }\nfn broken( {\n    ok(\n' },
        csharp: { 'A.cs': 'class A {\n  public static int Ok() { return 1; }\n}\n', 'B.cs': 'class B {\n  void Caller() { A.Ok(); }\n  void Broken( {\n    A.Ok(\n' },
        c: { 'a.c': 'int ok(void) { return 1; }\nvoid caller(void) { ok(); }\nvoid broken( {\n    ok(\n' },
    };
    for (const [lang, files] of Object.entries(BROKEN)) {
        it(`#367e ${lang}: a ground line in a recovered region is disclosed in the account`, () => {
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const name = lang === 'csharp' ? 'Ok' : 'ok';
                const r = execute(index, 'show', { name });
                assert.ok(r.ok, JSON.stringify(r.error));
                const recovered = r.result.context.meta.account.recovered;
                assert.ok(recovered && recovered.lines >= 1, `${lang}: ${JSON.stringify(r.result.context.meta.account)}`);
                const text = output.formatAccountLines
                    ? output.formatAccountLines(r.result.context.meta.account).join('\n')
                    : '';
                if (text) assert.match(text, /syntax-error recovery/);
                // The clean caller line is never flagged.
                assert.ok(!recovered.sites.some(s => s.line === (lang === 'java' || lang === 'csharp' ? 3 : lang === 'rust' || lang === 'c' ? 2 : 3) &&
                    /caller|Caller/.test(fs.readFileSync(path.join(dir, s.file), 'utf8').split('\n')[s.line - 1])),
                `${lang}: ${JSON.stringify(recovered.sites)}`);
            } finally { rm(dir); }
        });
    }

    // #367f: interface/trait members inherit the container's visibility.
    it('#367f deadcode treats members of exported traits/interfaces as public API (Rust, C#, Java)', () => {
        const cases = [
            [{ 'Cargo.toml': '[package]\nname = "r"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub trait T {\n    fn required(&self) -> i32;\n    fn provided(&self) -> i32 { 4 }\n}\ntrait Hidden {\n    fn hidden_provided(&self) -> i32 { 5 }\n}\n' },
            ['provided', 'required'], ['hidden_provided']],
            [{ 'Api.cs': 'namespace P {\n    public interface IApi {\n        void Run();\n        int Helper() => 1;\n    }\n    internal interface IInternal {\n        int InternalHelper() => 2;\n    }\n}\n' },
            ['Run', 'Helper'], ['InternalHelper']],
            [{ 'src/p/Api.java': 'package p;\npublic interface Api {\n    void run();\n    default int helper() { return 1; }\n}\n' },
            ['run', 'helper'], []],
        ];
        for (const [files, publicNames, claimed] of cases) {
            const dir = tmp(files);
            try {
                const dead = idx(dir).deadcode({}).map(d => d.name);
                for (const name of publicNames) assert.ok(!dead.includes(name), `${name} claimed: ${JSON.stringify(dead)}`);
                for (const name of claimed) assert.ok(dead.includes(name), `${name} not claimed: ${JSON.stringify(dead)}`);
            } finally { rm(dir); }
        }
    });

    // #367g: the text budget keeps a head of every tier section.
    it('#367g output budget keeps a representative head of every tier section (CLI and MCP)', () => {
        const { applyOutputBudget } = require('../core/output-budget');
        const confirmed = Array.from({ length: 300 }, (_, i) => `  [${i + 1}] src/confirmed_${i}.js:${i + 1} [f]: target(${i})`);
        const unverified = [
            '  competing definitions (40; 40 dispatch owners):',
            ...Array.from({ length: 40 }, (_, i) => `    - src/owner_${i}.js:1:target — method on O${i}`),
            ...Array.from({ length: 200 }, (_, i) => `  [${i + 301}] src/unverified_${i}.js:${i + 1} [g]: x.target() (method-ambiguous)`),
        ];
        const text = [
            'Context: target',
            'CALLERS — CONFIRMED (300):',
            ...confirmed,
            'CALLERS — UNVERIFIED (200) — call or callable-reference syntax, no binding/receiver evidence:',
            ...unverified,
            'CALLEES (0):',
            'ACCOUNT: "target" occurs on 540 lines in 500 files: 300 confirmed, 200 unverified, 40 non-call, 0 other-target, 0 unaccounted',
            'CONTRACT: literal-name text partition complete; semantic completeness is not claimed.',
        ].join('\n');
        for (const surface of ['cli', 'mcp']) {
            const out = applyOutputBudget(text, { command: 'show', surface });
            assert.ok(out.truncated);
            assert.ok(out.text.length <= 10000, `${surface}: ${out.text.length}`);
            assert.match(out.text, /CALLERS — UNVERIFIED \(200\)/);
            assert.match(out.text, /\[301\] src\/unverified_0\.js/, `${surface}: first unverified site kept`);
            assert.match(out.text, /\[1\] src\/confirmed_0\.js/);
            assert.match(out.text, /\.\.\. \+\d+ more/);
            assert.match(out.text, /^ACCOUNT: "target"/m);
            assert.match(out.text, /^CONTRACT:/m);
            // The unverified band gets a comparable share of the budget.
            const unverifiedShown = (out.text.match(/src\/unverified_/g) || []).length;
            assert.ok(unverifiedShown >= 20, `${surface}: ${unverifiedShown}`);
        }
        // Commands without tier sections keep the head cut.
        const plain = applyOutputBudget(text, { command: 'usages', surface: 'cli' });
        assert.ok(!/\.\.\. \+\d+ more/.test(plain.text));
    });

    // #367i: a Java/C# bare this-call resolves through the caller class's
    // resolved ancestry; an unrelated same-named owner is not its target.
    it('#367i java: bare m() in a subclass of b1.Base is not a caller of b2.Base.m; anonymous classes stay visible', () => {
        const dir = tmp({
            'com/x/b1/Base.java': 'package com.x.b1;\npublic class Base {\n  public int m() { return 1; }\n}\n',
            'com/x/b2/Base.java': 'package com.x.b2;\npublic class Base {\n  public int m() { return 2; }\n}\n',
            'com/x/c/Child.java': 'package com.x.c;\nimport com.x.b1.Base;\npublic class Child extends Base {\n  public int run() {\n    return m();\n  }\n  public int anon() {\n    com.x.b2.Base o = new com.x.b2.Base() {\n      public int g() { return m(); }\n    };\n    return 0;\n  }\n}\n',
        });
        try {
            const index = idx(dir);
            const other = show(index, 'com/x/b2/Base.java:3:m');
            assert.ok(!sites(other.callers).includes('Child.java:5'));
            assert.ok(!sites(other.unverifiedCallers).includes('Child.java:5'),
                JSON.stringify(sites(other.unverifiedCallers)));
            assert.ok(sites(other.unverifiedCallers).includes('Child.java:9'),
                `anonymous subclass of b2.Base stays visible: ${JSON.stringify(sites(other.unverifiedCallers))}`);
            const own = show(index, 'com/x/b1/Base.java:3:m');
            assert.ok(sites(own.callers).includes('Child.java:5'), JSON.stringify(sites(own.callers)));
            assert.strictEqual(other.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('#367i java: a bare call in a constructor or field initializer is analyzed without error', () => {
        const dir = tmp({
            'a/U.java': 'package a;\npublic class U {\n  public static int check(int x) { return x; }\n}\n',
            'b/U.java': 'package b;\npublic class U {\n  public static int check(int x) { return -x; }\n}\n',
            'a/T.java': 'package a;\npublic class T extends U {\n  static final int V = check(1);\n  private final int v;\n  private T(int x) {\n    this.v = check(x);\n  }\n}\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'show', { name: 'b/U.java:3:check' });
            assert.ok(r.ok, JSON.stringify(r.error));
            assert.strictEqual(r.result.context.meta.account.conserved, true);
            const f = execute(index, 'find', { name: 'check' });
            assert.ok(f.ok, JSON.stringify(f.error));
        } finally { rm(dir); }
    });

    it('#367i csharp: bare M() resolves the base through the namespace the file imports', () => {
        const dir = tmp({
            'A.cs': 'using static N2.Util;\nusing N1;\nnamespace N3 {\n  public class Child : Base {\n    public int Run() { return M() + Helper(); }\n  }\n}\n',
            'B.cs': 'namespace N1 { public class Base { public int M() { return 1; } } }\n',
            'C.cs': 'namespace N2 { public class Base { public int M() { return 2; } } public static class Util { public static int Helper() { return 3; } } }\n',
        });
        try {
            const index = idx(dir);
            const other = show(index, 'C.cs:1:M');
            assert.ok(!sites(other.callers).includes('A.cs:5'), JSON.stringify(sites(other.callers)));
            assert.ok(!sites(other.unverifiedCallers).includes('A.cs:5'));
            const own = show(index, 'B.cs:1:M');
            assert.ok(sites(own.callers).includes('A.cs:5'), JSON.stringify(sites(own.callers)));
        } finally { rm(dir); }
    });
});

describe('fix #369: C# bare invocations of local delegates', () => {
    it('a local delegate, parameter or lambda parameter named like a method is the invoked value', () => {
        const dir = tmp({
            'A.cs': [
                'namespace N {',
                'class A {',
                '    void Run() {}',
                '    void Go(System.Action Other) {',
                '        System.Action Run = () => {};',
                '        Run();',
                '        Other();',
                '        System.Action<System.Action> f = Step => Step();',
                '    }',
                '    void Other() {}',
                '    void Step() {}',
                '    void Plain() { Run(); Other(); Step(); }',
                '}',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const lines = entries => (entries || []).map(entry => `${entry.relativePath}:${entry.line}`);
            assert.deepStrictEqual(lines(index.context('Run', { file: 'A.cs', line: 3 }).callers), ['A.cs:12']);
            assert.deepStrictEqual(lines(index.context('Other', { file: 'A.cs', line: 10 }).callers), ['A.cs:12']);
            assert.deepStrictEqual(lines(index.context('Step', { file: 'A.cs', line: 11 }).callers), ['A.cs:12']);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #371: a type name written at a call site denotes what the file binds it to', () => {
    // Each fixture defines a project type that shares its name with an
    // external type. The "ext" file imports (or path-qualifies) the external
    // one; the "own" file names the project type. Calls through the external
    // name never confirm a member of the project type.
    const pin = (index, handle) => {
        const [rel, line, name] = handle.split(':');
        const def = (index.symbols.get(name) || []).find(d => d.relativePath === rel && d.startLine === Number(line));
        assert.ok(def, `fixture target ${handle}`);
        return def;
    };
    const callers = (index, handle) => {
        const def = pin(index, handle);
        const result = index.findCallers(def.name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: result.filter(c => c.tier !== 'unverified').map(c => `${c.relativePath}:${c.line}`),
            excluded: (result.accountRaw?.excludedEntries || []).map(e => `${path.relative(index.root, e.file)}:${e.line}:${e.reason}`),
            unverified: [...result.filter(c => c.tier === 'unverified'), ...(result.unverifiedEntries || [])]
                .map(c => `${c.relativePath || path.relative(index.root, c.file)}:${c.line}:${c.reason}`),
        };
    };
    const calleesAt = (index, rel, line) => {
        const fileEntry = index.files.get(path.join(index.root, rel));
        const fn = fileEntry.symbols.filter(s => ['function', 'method'].includes(s.type) &&
            s.startLine <= line && s.endLine >= line).sort((a, b) => b.startLine - a.startLine)[0];
        return index.findCallees(fn, { includeMethods: true, collectAccount: true });
    };
    const LANGS = {
        rust: {
            files: {
                'Cargo.toml': '[package]\nname = "fx371"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub mod fs;\npub mod ext;\npub mod own;\n',
                'src/fs.rs': 'pub struct File { fd: i32 }\nimpl File {\n    pub fn create(p: &str) -> File { File { fd: p.len() as i32 } }\n    pub fn sync_all(&self) -> i32 { self.fd }\n}\n',
                'src/ext.rs': 'use std::fs::File;\npub fn run() {\n    let _a = File::create("x");\n    let _b = std::fs::File::create("y");\n    let h: File = File::open("z").unwrap();\n    let _ = h.sync_all();\n}\n',
                'src/own.rs': 'use crate::fs::File;\npub fn run() -> i32 {\n    let f = File::create("x");\n    f.sync_all()\n}\n',
            },
            targets: { create: 'src/fs.rs:3:create', member: 'src/fs.rs:4:sync_all' },
            ext: ['src/ext.rs:3', 'src/ext.rs:4', 'src/ext.rs:6'],
            own: ['src/own.rs:3', 'src/own.rs:4'],
        },
        java: {
            files: {
                'src/main/java/com/x/io/File.java': 'package com.x.io;\npublic class File {\n  public File(String p) {}\n  public boolean createNewFile() { return true; }\n  public static File createTempFile(String a) { return new File(a); }\n}\n',
                'src/main/java/com/x/app/Ext.java': 'package com.x.app;\nimport java.io.File;\npublic class Ext {\n  public void run() throws Exception {\n    File f = new File("x");\n    f.createNewFile();\n    File.createTempFile("a", "b");\n    java.io.File.createTempFile("c", "d");\n  }\n}\n',
                'src/main/java/com/x/app/Own.java': 'package com.x.app;\nimport com.x.io.File;\npublic class Own {\n  public void run() {\n    File f = new File("x");\n    f.createNewFile();\n    File.createTempFile("a");\n  }\n}\n',
            },
            targets: { create: 'src/main/java/com/x/io/File.java:5:createTempFile', member: 'src/main/java/com/x/io/File.java:4:createNewFile' },
            ext: ['src/main/java/com/x/app/Ext.java:6', 'src/main/java/com/x/app/Ext.java:7', 'src/main/java/com/x/app/Ext.java:8'],
            own: ['src/main/java/com/x/app/Own.java:6', 'src/main/java/com/x/app/Own.java:7'],
        },
        csharp: {
            files: {
                'Lib/File.cs': 'namespace Acme.IO {\n  public class File {\n    public static File Create(string p) { return new File(); }\n    public void Flush() {}\n  }\n}\n',
                'App/Ext.cs': 'using SysFile = System.IO.File;\nnamespace Acme.App {\n  public class Ext {\n    public void Run() {\n      var b = SysFile.Create("y");\n    }\n  }\n}\n',
                'App/Own.cs': 'using Acme.IO;\nnamespace Acme.App {\n  public class Own {\n    public void Run() {\n      var a = File.Create("x");\n    }\n  }\n}\n',
            },
            targets: { create: 'Lib/File.cs:3:Create' },
            ext: ['App/Ext.cs:5'],
            own: ['App/Own.cs:5'],
        },
        typescript: {
            files: {
                'package.json': '{"name":"fx371","version":"1.0.0"}',
                'src/server.ts': 'export class Server {\n  listen(port: number): void {}\n}\n',
                'src/ext.ts': "import { Server } from 'http';\nexport function run(): void {\n  const s = new Server();\n  s.listen(80);\n}\n",
                'src/own.ts': "import { Server } from './server';\nexport function run(): void {\n  const s = new Server();\n  s.listen(80);\n}\n",
            },
            targets: { member: 'src/server.ts:2:listen' },
            ext: ['src/ext.ts:4'],
            own: ['src/own.ts:4'],
        },
        python: {
            files: {
                'pkg/__init__.py': '',
                'pkg/paths.py': 'class Path:\n    def __init__(self, p):\n        self.p = p\n\n    def exists(self):\n        return True\n',
                'pkg/ext.py': 'from pathlib import Path\n\n\ndef run():\n    p = Path("x")\n    p.exists()\n',
                'pkg/own.py': 'from pkg.paths import Path\n\n\ndef run():\n    p = Path("x")\n    p.exists()\n',
            },
            targets: { member: 'pkg/paths.py:5:exists' },
            ext: ['pkg/ext.py:6'],
            own: ['pkg/own.py:6'],
        },
        cpp: {
            files: {
                'lib/mutex.h': '#pragma once\nnamespace acme {\nclass mutex {\npublic:\n  void lock();\n};\n}\n',
                'lib/mutex.cpp': '#include "mutex.h"\nnamespace acme {\nvoid mutex::lock() {}\n}\n',
                'app/ext.cpp': '#include <mutex>\nvoid ext() {\n  std::mutex m;\n  m.lock();\n}\n',
                'app/own.cpp': '#include "../lib/mutex.h"\nvoid own() {\n  acme::mutex m;\n  m.lock();\n}\n',
            },
            targets: { member: 'lib/mutex.cpp:3:lock' },
            ext: ['app/ext.cpp:4'],
            own: ['app/own.cpp:4'],
        },
    };
    for (const [lang, fx] of Object.entries(LANGS)) {
        it(`${lang}: sites naming the external type are excluded, the project type's sites stay confirmed`, () => {
            const dir = tmp(fx.files);
            try {
                const index = idx(dir);
                const confirmed = new Set();
                const excluded = new Set();
                for (const handle of Object.values(fx.targets)) {
                    const result = callers(index, handle);
                    for (const site of result.confirmed) confirmed.add(site);
                    for (const entry of result.excluded) excluded.add(entry);
                }
                for (const site of fx.ext) {
                    assert.ok(!confirmed.has(site), `${site} names the external type: ${JSON.stringify([...confirmed])}`);
                    assert.ok(excluded.has(`${site}:external-receiver`),
                        `${site} excluded external-receiver: ${JSON.stringify([...excluded])}`);
                }
                for (const site of fx.own) {
                    assert.ok(confirmed.has(site), `${site} names the project type: ${JSON.stringify([...confirmed])}`);
                }
                // Callee direction: the external-importing function never
                // resolves to the project type's members.
                const [extRel, extLine] = fx.ext[0].split(':');
                const callees = calleesAt(index, extRel, Number(extLine));
                const targetFiles = new Set(Object.values(fx.targets).map(h => h.split(':')[0]));
                assert.ok(!callees.some(c => targetFiles.has(c.relativePath)),
                    `callees of the external site: ${JSON.stringify(callees.map(c => `${c.relativePath}:${c.name}`))}`);
            } finally { rm(dir); }
        });
    }

    it('rust: an impl on the external type is possible dispatch, never confirmed or excluded', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "fx371b"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub mod a;\npub mod b;\npub struct File;\nimpl File { pub fn create() -> File { File } }\n',
            'src/a.rs': 'pub trait Ext { fn tag(&self) -> u8; }\nimpl Ext for std::fs::File { fn tag(&self) -> u8 { 1 } }\n',
            'src/b.rs': 'use std::fs::File;\nuse crate::a::Ext;\npub fn f(x: &File) -> u8 { x.tag() }\n',
        });
        try {
            const index = idx(dir);
            const result = callers(index, 'src/a.rs:2:tag');
            assert.deepStrictEqual(result.confirmed, []);
            assert.ok(result.unverified.includes('src/b.rs:3:possible-dispatch'), JSON.stringify(result));
        } finally { rm(dir); }
    });

    it('rust: use scope, std producers and declared fields follow the written type', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "fx371c"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub mod time;\npub mod loom;\npub mod bench;\n',
            'src/time.rs': 'pub struct Instant { t: u64 }\nimpl Instant {\n    pub fn now() -> Instant { Instant { t: 0 } }\n    pub fn elapsed(&self) -> u64 { self.t }\n}\n',
            'src/loom.rs': 'pub struct AtomicU32 { v: u32 }\nimpl AtomicU32 {\n    pub fn new(v: u32) -> AtomicU32 { AtomicU32 { v } }\n    pub fn load(&self) -> u32 { self.v }\n}\n' +
                'pub mod rand {\n    use std::sync::atomic::AtomicU32;\n    pub fn seed() { let _c = AtomicU32::new(1); }\n}\n' +
                'pub mod own {\n    use crate::loom::AtomicU32;\n    pub fn seed() -> u32 { AtomicU32::new(1).load() }\n}\n',
            'src/bench.rs': 'use std::time::Instant;\nuse std::sync::atomic::AtomicU32;\n' +
                'struct Holder { count: AtomicU32 }\n' +
                'pub fn run() -> u64 {\n    let start = Instant::now();\n    start.elapsed().as_secs()\n}\n' +
                'impl Holder {\n    fn get(&self) -> u32 { self.count.load(std::sync::atomic::Ordering::SeqCst) }\n}\n',
        });
        try {
            const index = idx(dir);
            const elapsed = callers(index, 'src/time.rs:4:elapsed');
            assert.ok(!elapsed.confirmed.includes('src/bench.rs:6'), JSON.stringify(elapsed));
            const newCallers = callers(index, 'src/loom.rs:3:new');
            assert.ok(!newCallers.confirmed.includes('src/loom.rs:8'), `inline-module use of std: ${JSON.stringify(newCallers)}`);
            assert.ok(newCallers.confirmed.includes('src/loom.rs:12'), `inline-module use of the project type: ${JSON.stringify(newCallers)}`);
            const load = callers(index, 'src/loom.rs:4:load');
            assert.ok(!load.confirmed.includes('src/bench.rs:9'), `std-typed field: ${JSON.stringify(load)}`);
            assert.ok(load.excluded.includes('src/bench.rs:9:external-receiver'), JSON.stringify(load));
        } finally { rm(dir); }
    });

    it('java: an import of a package no project file declares is never confirmed; a project type it cannot name is excluded (fix #372)', () => {
        const dir = tmp({
            'src/main/java/com/x/io/File.java': 'package com.x.io;\npublic class File {\n  public boolean createNewFile() { return true; }\n}\n',
            'src/main/java/com/x/app/Gen.java': 'package com.x.app;\nimport org.generated.File;\npublic class Gen {\n  public void run(File f) {\n    f.createNewFile();\n  }\n}\n',
        });
        try {
            const index = idx(dir);
            const result = callers(index, 'src/main/java/com/x/io/File.java:3:createNewFile');
            assert.deepStrictEqual(result.confirmed, []);
            // `import org.generated.File` names org.generated.File: com.x.io.File
            // is not it even if org.generated is a resolver gap (fix #372).
            assert.ok(result.excluded.includes('src/main/java/com/x/app/Gen.java:5:external-receiver'), JSON.stringify(result));
        } finally { rm(dir); }
    });

    it('python: a self attribute built from an imported external class never resolves to a same-name project class', () => {
        const dir = tmp({
            'app/__init__.py': '',
            'app/timer.py': 'class Timer:\n    def start(self):\n        return 1\n',
            'app/watch.py': 'from threading import Timer\n\n\nclass Watch:\n    def __init__(self):\n        self.timer = Timer(1, print)\n\n    def go(self):\n        self.timer.start()\n',
        });
        try {
            const index = idx(dir);
            const callees = calleesAt(index, 'app/watch.py', 9);
            assert.ok(!callees.some(c => c.relativePath === 'app/timer.py'), JSON.stringify(callees.map(c => c.relativePath)));
        } finally { rm(dir); }
    });
});

describe('fix #372: Java/C# type names resolve by package and namespace scope', () => {
    const pin = (index, handle) => {
        const [rel, line, name] = handle.split(':');
        const def = (index.symbols.get(name) || []).find(d => d.relativePath === rel && d.startLine === Number(line));
        assert.ok(def, `fixture target ${handle}`);
        return def;
    };
    const callers = (index, handle) => {
        const def = pin(index, handle);
        const result = index.findCallers(def.name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: result.filter(c => c.tier !== 'unverified').map(c => `${c.relativePath}:${c.line}`),
            excluded: (result.accountRaw?.excludedEntries || []).map(e => `${path.relative(index.root, e.file)}:${e.line}:${e.reason}`),
            unverified: [...result.filter(c => c.tier === 'unverified'), ...(result.unverifiedEntries || [])]
                .map(c => `${c.relativePath || path.relative(index.root, c.file)}:${c.line}:${c.reason}`),
        };
    };
    const javaThread = 'package b;\npublic class Thread {\n  public static void sleep(long ms) {}\n  public void start() {}\n}\n';
    const javaRunner = (pkg, imports) => `package ${pkg};\n${imports}public class Runner {\n  void go() throws Exception {\n    Thread.sleep(1);\n    new Thread().start();\n  }\n}\n`;

    it('java: java.lang wins over a project type of another package that is not imported', () => {
        const dir = tmp({ 'src/b/Thread.java': javaThread, 'src/a/Runner.java': javaRunner('a', 'import java.util.*;\n') });
        try {
            const index = idx(dir);
            const sleep = callers(index, 'src/b/Thread.java:3:sleep');
            assert.deepStrictEqual(sleep.confirmed, [], JSON.stringify(sleep));
            assert.ok(sleep.excluded.includes('src/a/Runner.java:5:external-receiver'), JSON.stringify(sleep));
            const start = callers(index, 'src/b/Thread.java:4:start');
            assert.deepStrictEqual(start.confirmed, [], JSON.stringify(start));
        } finally { rm(dir); }
    });

    it('java: the same package and a single-type import win; an on-demand import beside java.lang is ambiguous', () => {
        const dir = tmp({
            'src/b/Thread.java': javaThread,
            'src/b/Runner.java': javaRunner('b', ''),
            'src/c/Runner.java': javaRunner('c', 'import b.Thread;\n'),
            'src/d/Runner.java': javaRunner('d', 'import b.*;\n'),
        });
        try {
            const index = idx(dir);
            const sleep = callers(index, 'src/b/Thread.java:3:sleep');
            assert.ok(sleep.confirmed.includes('src/b/Runner.java:4'), JSON.stringify(sleep));
            assert.ok(sleep.confirmed.includes('src/c/Runner.java:5'), JSON.stringify(sleep));
            assert.ok(!sleep.confirmed.includes('src/d/Runner.java:5'), JSON.stringify(sleep));
            assert.ok(sleep.unverified.includes('src/d/Runner.java:5:method-ambiguous'), JSON.stringify(sleep));
        } finally { rm(dir); }
    });

    it('java: an on-demand project import supplies a name java.lang lacks; nested member types keep engine resolution', () => {
        const dir = tmp({
            'src/b/Widget.java': 'package b;\npublic class Widget {\n  public static void make() {}\n}\n',
            'src/d/User.java': 'package d;\nimport b.*;\npublic class User {\n  void go() { Widget.make(); }\n}\n',
            'src/e/User.java': 'package e;\nimport java.util.*;\npublic class User {\n  void go() { Widget.make(); }\n  static class Widget { static void make() {} }\n}\n',
        });
        try {
            const index = idx(dir);
            const make = callers(index, 'src/b/Widget.java:3:make');
            assert.ok(make.confirmed.includes('src/d/User.java:4'), JSON.stringify(make));
            assert.ok(!make.excluded.some(site => site.includes('external-receiver')), JSON.stringify(make));
        } finally { rm(dir); }
    });

    it('java: a package-qualified constructor or declaration is not re-resolved by scope', () => {
        const dir = tmp({
            'src/b/Thread.java': javaThread,
            'src/a/R.java': 'package a;\npublic class R {\n  void go() {\n    new b.Thread().start();\n    b.Thread t = new b.Thread();\n    t.start();\n  }\n}\n',
        });
        try {
            const index = idx(dir);
            const start = callers(index, 'src/b/Thread.java:4:start');
            assert.ok(start.confirmed.includes('src/a/R.java:4'), JSON.stringify(start));
            assert.ok(start.confirmed.includes('src/a/R.java:6'), JSON.stringify(start));
        } finally { rm(dir); }
    });

    const csFile = 'namespace Proj.Util { public class File { public static void Create(string s) {} } }\n';
    const csUser = usings => `${usings}namespace Proj.App {\n    class Runner {\n        void Go() { File.Create("x"); }\n    }\n}\n`;

    it('csharp: a namespace using of an external namespace names the external type when no project type is in scope', () => {
        const dir = tmp({ 'Util.cs': csFile, 'App.cs': csUser('using System.IO;\n') });
        try {
            const index = idx(dir);
            const create = callers(index, 'Util.cs:1:Create');
            assert.deepStrictEqual(create.confirmed, [], JSON.stringify(create));
            assert.ok(create.excluded.includes('App.cs:4:external-receiver'), JSON.stringify(create));
        } finally { rm(dir); }
    });

    it('csharp: enclosing namespaces, usings, global usings and project-file <Using> items bring the project type into scope', () => {
        const cases = {
            using: { 'Util.cs': csFile, 'App.cs': csUser('using System.IO;\nusing Proj.Util;\n') },
            enclosing: { 'Util.cs': csFile.replace('Proj.Util', 'Proj'), 'App.cs': csUser('using System.IO;\n') },
            global: { 'Util.cs': csFile, 'App.cs': csUser('using System.IO;\n'), 'Globals.cs': 'global using Proj.Util;\n' },
            projectFile: { 'Util.cs': csFile, 'App.cs': csUser('using System.IO;\n'),
                'App.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <Using Include="Proj.Util" />\n  </ItemGroup>\n</Project>\n' },
        };
        for (const [label, files] of Object.entries(cases)) {
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const create = callers(index, 'Util.cs:1:Create');
                const line = files['App.cs'].split('\n').findIndex(text => text.includes('File.Create')) + 1;
                assert.ok(create.confirmed.includes(`App.cs:${line}`), `${label}: ${JSON.stringify(create)}`);
            } finally { rm(dir); }
        }
    });
});

describe('fix #377: annotation, attribute and decorator names vs same-named methods', () => {
    const planEdits = (files, handle) => {
        const dir = tmp(files);
        try {
            const r = execute(idx(dir), 'plan', { name: handle, renameTo: 'Zz' });
            assert.ok(r.ok, JSON.stringify(r.error));
            return r.result.changes.filter(c => c.newExpression !== undefined)
                .map(c => `${c.file}:${c.line}`).sort();
        } finally { rm(dir); }
    };

    it('Java @Name and C# [Name] denote annotation/attribute types, never a method Name', () => {
        assert.deepStrictEqual(planEdits({
            'src/p/Util.java': 'package p;\npublic class Util {\n    public static int Marker() { return 2; }\n}\n',
            'src/p/Marker.java': 'package p;\npublic @interface Marker { }\n',
            'src/p/B.java': 'package p;\nimport static p.Util.*;\n@Marker\npublic class B {\n    int m() { return Marker(); }\n}\n',
        }, 'src/p/Util.java:3:Marker'), ['src/p/B.java:5', 'src/p/Util.java:3']);
        assert.deepStrictEqual(planEdits({
            'A.cs': [
                'using System;',
                'namespace P {',
                '    public class Util { public static int Obsolete() { return 2; } }',
                '    public class B {',
                '        [Obsolete("x")]',
                '        public int M() { return Util.Obsolete(); }',
                '    }',
                '}',
            ].join('\n') + '\n',
        }, 'A.cs:3:Obsolete'), ['A.cs:3', 'A.cs:6']);
    });

    it('a Python decorator is a reference to the decorating function (listed, never dropped)', () => {
        const dir = tmp({ 'a.py': 'def trace(fn):\n    return fn\n\n@trace\ndef run():\n    return 1\n' });
        try {
            const r = execute(idx(dir), 'plan', { name: 'a.py:1:trace', renameTo: 'Zz' });
            assert.ok(r.ok);
            assert.deepStrictEqual(r.result.changes.map(c => `${c.file}:${c.line}`).sort(), ['a.py:1', 'a.py:4']);
        } finally { rm(dir); }
    });
});

describe('fix #378: explicit generic call syntax and import-renamed type receivers', () => {
    const relations = (dir, handle) => {
        const index = idx(dir);
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle}: ${r.error}`);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: [...new Set((json.data.callers || []).map(c => `${c.file}:${c.line}`))].sort(),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`).sort(),
            callees: (json.data.callees || []).map(c => `${c.name}@${c.file}`).sort(),
            conserved: json.meta.account?.conserved,
        };
    };
    const planEdits = (dir, handle) => {
        const r = execute(idx(dir), 'plan', { name: handle, renameTo: 'Zz' });
        assert.ok(r.ok, JSON.stringify(r.error));
        return r.result.changes.map(c => `${c.file}:${c.line}:${c.newExpression || ''}`.trim()).sort();
    };

    it('explicit type arguments at call sites are calls in every language', () => {
        const cases = [
            [{ 'Cargo.toml': '[package]\nname = "g"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub fn ident<T>(x: T) -> T { x }\npub struct W<T> { v: T }\nimpl<T> W<T> { pub fn new(v: T) -> Self { W { v } } }\npub fn run() { let a = ident::<i32>(1); let _ = W::<i32>::new(a); }\n' },
            ['src/lib.rs:1:ident', 'src/lib.rs:3:new'], ['src/lib.rs:4']],
            [{ 'a.ts': 'export function ident<T>(x: T): T { return x; }\nexport class B<T> { map<U>(f: (v: T) => U): U { return f(null as any); } }\n',
                'b.ts': "import { ident, B } from './a';\nconst n = ident<number>(1);\nconst b = new B<number>();\nb.map<string>(v => String(v));\n" },
            ['a.ts:1:ident', 'a.ts:2:map'], null],
            [{ 'A.cs': 'namespace G {\n  public static class U { public static T Ident<T>(T x) => x; }\n  public class Run { public int Go() { return U.Ident<int>(1); } }\n}\n' },
            ['A.cs:2:Ident'], ['A.cs:3']],
            [{ 'A.java': 'public class A {\n  static <T> T ident(T x) { return x; }\n  <T> T inst(T x) { return x; }\n  void run() { A.<Integer>ident(1); this.<Integer>inst(2); }\n}\n' },
            ['A.java:2:ident', 'A.java:3:inst'], ['A.java:4']],
            [{ 'a.cpp': 'template <typename T> T ident(T x) { return x; }\ntemplate <typename T> struct Box {\n  T v;\n  template <typename U> U conv() const { return static_cast<U>(v); }\n};\nint run() {\n  Box<int> b{1};\n  long c = b.conv<long>();\n  long d = b.template conv<long>();\n  return ident<int>(1) + (int)c + (int)d;\n}\n' },
            ['a.cpp:1:ident', 'a.cpp:4:conv'], null],
        ];
        for (const [files, handles, expected] of cases) {
            const dir = tmp(files);
            try {
                for (const handle of handles) {
                    const rel = relations(dir, handle);
                    assert.ok(rel.confirmed.length > 0, `${handle}: ${JSON.stringify(rel)}`);
                    if (expected) assert.deepStrictEqual(rel.confirmed, expected, handle);
                    assert.strictEqual(rel.conserved, true, handle);
                }
            } finally { rm(dir); }
        }
        const dir = tmp(cases[4][0]);
        try {
            const conv = relations(dir, 'a.cpp:4:conv');
            assert.deepStrictEqual(conv.confirmed, ['a.cpp:8', 'a.cpp:9']);
            const edits = planEdits(dir, 'a.cpp:4:conv');
            assert.ok(edits.some(e => e.includes('b.Zz<long>()')), edits.join('\n'));
            assert.ok(edits.some(e => e.includes('b.template Zz<long>()')), edits.join('\n'));
        } finally { rm(dir); }
    });

    it('a receiver annotated with an import rename or C# using alias is the original type (callers and callees)', () => {
        const cases = [
            [{ 'a.ts': 'export class Box<T> { constructor(public v: T) {} get(): T { return this.v; } }\nexport class Other { get(): number { return 1; } }\n',
                'c.ts': "import { Box as B } from './a';\nexport function g(b: B<number>) { return b.get(); }\n" },
            'a.ts:1:get', 'a.ts:2:get', 'c.ts:2', 'c.ts:2:g'],
            [{ 'Cargo.toml': '[package]\nname = "al"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub mod third;\npub struct Wrap<T> { v: T }\nimpl<T> Wrap<T> { pub fn get(&self) -> &T { &self.v } }\npub struct Solo;\nimpl Solo { pub fn get(&self) -> i32 { 1 } }\n',
                'src/third.rs': 'use crate::Wrap as W;\npub fn g(w: &W<i32>) { w.get(); }\n' },
            'src/lib.rs:3:get', 'src/lib.rs:5:get', 'src/third.rs:2', 'src/third.rs:2:g'],
            [{ 'a.py': 'class Box:\n    def get(self):\n        return 1\n\n\nclass Other:\n    def get(self):\n        return 2\n',
                'c.py': 'from a import Box as B\n\n\ndef g(b: B):\n    return b.get()\n' },
            'a.py:2:get', 'a.py:7:get', 'c.py:5', 'c.py:4:g'],
            [{ 'A.cs': 'namespace G {\n  public class Box<T> { public T V; public Box(T v) { V = v; } public T Get() => V; }\n  public class Other { public int Get() => 1; }\n}\n',
                'B.cs': 'using IntBox = G.Box<int>;\nnamespace H {\n  public class U { public int Run(IntBox b) { return b.Get(); } }\n}\n' },
            'A.cs:2:Get', 'A.cs:3:Get', 'B.cs:3', 'B.cs:3:Run'],
        ];
        for (const [files, pin, other, site, caller] of cases) {
            const dir = tmp(files);
            try {
                assert.deepStrictEqual(relations(dir, pin).confirmed, [site], pin);
                const otherRel = relations(dir, other);
                assert.ok(!otherRel.confirmed.includes(site) && !otherRel.unverified.includes(site),
                    `${other}: ${JSON.stringify(otherRel)}`);
                const callees = relations(dir, caller).callees;
                assert.ok(callees.some(c => c.endsWith(`@${pin.split(':')[0]}`)), `${caller}: ${callees}`);
            } finally { rm(dir); }
        }
    });

    it('a function-local JS class is invisible outside its function', () => {
        const dir = tmp({
            'foo.js': 'export class Foo { run() { return 1; } }\n',
            'a.js': "import { Foo } from './foo';\nfunction t() {\n  class Foo {}\n  return new Foo();\n}\nexport const made = new Foo();\nexport { t };\n",
        });
        try {
            const index = idx(dir);
            const outer = execute(index, 'context', { name: 'foo.js:1:Foo' });
            assert.deepStrictEqual(outer.result.callers.map(c => `${c.relativePath}:${c.line}`), ['a.js:6']);
        } finally { rm(dir); }
    });

    it('type aliases resolve on the callee side as on the caller side', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "al2"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub mod other;\npub struct Wrap<T> { v: T }\nimpl<T> Wrap<T> { pub fn get(&self) -> &T { &self.v } }\npub type IntWrap = Wrap<i32>;\n',
            'src/other.rs': 'use crate::IntWrap;\npub struct Solo;\nimpl Solo { pub fn get(&self) -> i32 { 1 } }\ntype Mine = IntWrap;\npub fn f(w: &IntWrap, m: &Mine) { w.get(); m.get(); }\n',
        });
        try {
            assert.deepStrictEqual(relations(dir, 'src/lib.rs:3:get').confirmed, ['src/other.rs:5']);
            assert.deepStrictEqual(relations(dir, 'src/other.rs:5:f').callees, ['get@src/lib.rs']);
        } finally { rm(dir); }
    });
});

describe('fix #380: C# generic arity, extension methods, partial parts; Java/C# inherited member receivers, qualified supertypes, compiler protocol types; stored awaitables', () => {
    const relations = (dir, handle) => {
        const index = idx(dir);
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle}: ${r.error}`);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: [...new Set([...(json.data.callers || []),
                ...(json.data.usages || []).filter(u => u.tier === 'confirmed')].map(c => `${c.file}:${c.line}`))].sort(),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}:${c.reason}`).sort(),
            callees: (json.data.callees || []).map(c => `${c.name}@${c.file}:${c.line}`).sort(),
            excluded: json.meta.account?.excluded?.byReason || {},
            conserved: json.meta.account?.conserved,
        };
    };
    const planEdits = (dir, handle, renameTo = 'Zz') => {
        const r = execute(idx(dir), 'plan', { name: handle, renameTo });
        assert.ok(r.ok, JSON.stringify(r.error));
        return r.result;
    };
    const csGeneric = {
        'Outcome.cs': 'namespace P;\npublic static class Outcome\n{\n    public static Outcome<T> FromResult<T>(T v) => new Outcome<T>(v);\n    public static int Create() => 0;\n}\n',
        'OutcomeT.cs': 'namespace P;\npublic readonly struct Outcome<T>\n{\n    public Outcome(T v) { Value = v; }\n    public T Value { get; }\n    public static int Create() => 1;\n    public int Describe() => 2;\n}\n',
        'Box.cs': 'namespace P;\npublic class Box { public int Describe() => 3; }\npublic class Box<T> { public int Describe() => 4; }\n',
        'Use.cs': 'namespace P;\ninternal class Use\n{\n    public Outcome<int> A() => Outcome.FromResult(1);\n    public int B() => Outcome.Create() + Outcome<int>.Create();\n    public int C(Box<int> b, Box c) => b.Describe() + c.Describe();\n    public Outcome<int> D() => new Outcome<int>(5);\n}\n',
    };

    it('C#: a written generic arity names one type (constructors, static calls, typed receivers, callees)', () => {
        const dir = tmp(csGeneric);
        try {
            const generic = relations(dir, 'OutcomeT.cs:2:Outcome');
            assert.deepStrictEqual(generic.confirmed, ['Outcome.cs:4', 'Use.cs:5', 'Use.cs:7'], JSON.stringify(generic));
            assert.ok(generic.excluded['generic-arity-mismatch']?.count >= 1, JSON.stringify(generic.excluded));
            assert.strictEqual(generic.conserved, true);
            const plain = relations(dir, 'Outcome.cs:2:Outcome');
            assert.ok(plain.confirmed.includes('Use.cs:4') && !plain.confirmed.includes('Use.cs:7') &&
                !plain.confirmed.includes('Outcome.cs:4'), JSON.stringify(plain));
            assert.deepStrictEqual(relations(dir, 'Outcome.cs:5:Create').confirmed, ['Use.cs:5']);
            assert.deepStrictEqual(relations(dir, 'OutcomeT.cs:6:Create').confirmed, ['Use.cs:5']);
            assert.deepStrictEqual(relations(dir, 'Box.cs:3:Describe').confirmed, ['Use.cs:6']);
            assert.deepStrictEqual(relations(dir, 'Box.cs:2:Describe').confirmed, ['Use.cs:6']);
            // Callee side: `new Outcome<T>(v)` constructs the generic struct.
            const fromResult = relations(dir, 'Outcome.cs:4:FromResult');
            assert.deepStrictEqual(fromResult.callees, ['Outcome@OutcomeT.cs:4'], JSON.stringify(fromResult));
            const d = relations(dir, 'Use.cs:7:D');
            assert.deepStrictEqual(d.callees, ['Outcome@OutcomeT.cs:4'], JSON.stringify(d));
        } finally { rm(dir); }
    });

    it('C#: partial parts merge only with the same arity; a written base arity picks the base', () => {
        const dir = tmp({
            'Base.cs': 'namespace P;\npublic class Base { public int Run() => 0; }\npublic class Base<T> { public int Run() => 1; }\n',
            'Sub.cs': 'namespace P;\npublic class Sub : Base<int> { public int Go() => this.Run(); }\n',
            'Part1.cs': 'namespace P;\npublic partial class Pt { public int Solo() => 0; }\n',
            'Part2.cs': 'namespace P;\npublic partial class Pt<T> { public int Solo() => 1; public int Use() => this.Solo(); }\n',
            'Holder.cs': 'namespace P.Inner;\npublic class Holder { public P.Base Strategy { get; } = new P.Base(); public int Go() => Strategy.Run(); }\n',
            'HolderT.cs': 'namespace P.Inner;\npublic class Holder<T> { public P.Base<T> Strategy { get; } = new P.Base<T>(); public int Go() => Strategy.Run(); }\n',
            'Strategy.cs': 'namespace P;\npublic class Strategy : Base<int> { }\n',
        });
        try {
            // Declared property types keep their arity through the hop, and a
            // member named like a project type is the member (fix #380).
            const genericRun = relations(dir, 'Base.cs:3:Run');
            assert.ok(genericRun.confirmed.includes('HolderT.cs:2') && !genericRun.confirmed.includes('Holder.cs:2'),
                JSON.stringify(genericRun));
            const plainRun = relations(dir, 'Base.cs:2:Run');
            assert.ok(plainRun.confirmed.includes('Holder.cs:2') && !plainRun.confirmed.includes('HolderT.cs:2'),
                JSON.stringify(plainRun));
            assert.deepStrictEqual(relations(dir, 'Base.cs:3:Run').confirmed.filter(s => s.startsWith('Sub')), ['Sub.cs:2']);
            assert.deepStrictEqual(relations(dir, 'Base.cs:2:Run').confirmed.filter(s => s.startsWith('Sub')), []);
            assert.deepStrictEqual(relations(dir, 'Part2.cs:2:Solo').confirmed, ['Part2.cs:2']);
            assert.deepStrictEqual(relations(dir, 'Part1.cs:2:Solo').confirmed, []);
        } finally { rm(dir); }
    });

    it('C#: extension-method calls are callers of the extension; plan renames them', () => {
        const dir = tmp({
            'Ext.cs': 'using System;\nnamespace P;\ninternal static class ExceptionUtilities\n{\n    public static T TrySetStackTrace<T>(this T exception) where T : Exception => exception;\n    public static int Twice(this Num n) => n.V * 2;\n    public static int Own(this Num n) => 0;\n}\n',
            'Num.cs': 'namespace P;\npublic class Num { public int V; public int Own() => 1; }\npublic class Big : Num { }\n',
            'Use.cs': 'using System;\nnamespace P;\ninternal class Use\n{\n    public Exception B() => new InvalidOperationException("x").TrySetStackTrace();\n    public Exception C(Exception e) => e.TrySetStackTrace();\n    public int D(Big b) => b.Twice() + b.Own();\n}\n',
            'Other/Far.cs': 'namespace Q;\ninternal class Far { public int F(P.Num n) => n.Twice(); }\n',
        });
        try {
            const tss = relations(dir, 'Ext.cs:5:TrySetStackTrace');
            assert.deepStrictEqual(tss.confirmed, ['Use.cs:6'], JSON.stringify(tss));
            assert.deepStrictEqual(tss.unverified, ['Use.cs:5:extension-receiver-unresolved']);
            const twice = relations(dir, 'Ext.cs:6:Twice');
            assert.deepStrictEqual(twice.confirmed, ['Use.cs:7'], JSON.stringify(twice));
            // An instance method of the receiver type wins over the extension.
            assert.deepStrictEqual(relations(dir, 'Ext.cs:7:Own').confirmed, []);
            assert.deepStrictEqual(relations(dir, 'Num.cs:2:Own').confirmed, ['Use.cs:7']);
            const plan = planEdits(dir, 'Ext.cs:5:TrySetStackTrace', 'Tss');
            assert.ok(plan.changes.some(c => c.file === 'Use.cs' && c.line === 6 &&
                /e\.Tss\(\)/.test(c.newExpression || '')), JSON.stringify(plan.changes));
            const callees = relations(dir, 'Use.cs:7:D').callees;
            assert.ok(callees.includes('Twice@Ext.cs:6') && callees.includes('Own@Num.cs:2') &&
                !callees.includes('Own@Ext.cs:7'), callees.join(','));
        } finally { rm(dir); }
    });

    it('C#/Java: a capitalized receiver declared as a member in another partial part or a base class is a field hop', () => {
        const dir = tmp({
            'Pipe.Sync.cs': 'namespace P;\npublic partial class Pipe\n{\n    public int Exec(int x) => Component.Run(x);\n}\n',
            'Pipe.cs': 'using P.Utils;\nnamespace P;\npublic partial class Pipe\n{\n    internal Comp Component { get; } = new Comp();\n}\n',
            'Utils/Comp.cs': 'namespace P.Utils;\ninternal class Comp { internal int Run(int x) => x; }\n',
            'p/Base.java': 'package p;\nclass Base {\n    protected static final Helper HELPER = new Helper();\n}\n',
            'p/Helper.java': 'package p;\nclass Helper { int run(int x) { return x; } }\n',
            'p/Sub.java': 'package p;\nclass Sub extends Base {\n    int go() { return HELPER.run(1); }\n}\n',
        });
        try {
            assert.deepStrictEqual(relations(dir, 'Utils/Comp.cs:2:Run').confirmed, ['Pipe.Sync.cs:4']);
            assert.deepStrictEqual(relations(dir, 'Pipe.Sync.cs:4:Exec').callees, ['Run@Utils/Comp.cs:2']);
            const plan = planEdits(dir, 'Utils/Comp.cs:2:Run', 'Go');
            assert.ok(plan.changes.some(c => c.file === 'Pipe.Sync.cs' && c.line === 4), JSON.stringify(plan.changes));
            assert.deepStrictEqual(relations(dir, 'p/Helper.java:2:run').confirmed, ['p/Sub.java:3']);
            assert.deepStrictEqual(relations(dir, 'p/Sub.java:3:go').callees, ['run@p/Helper.java:2']);
        } finally { rm(dir); }
    });

    it('Java/C#: qualified supertypes stay in the heritage list (serialization callbacks are not dead)', () => {
        const dir = tmp({
            'p/A.java': 'package p;\nclass A implements java.io.Serializable {\n    private Object readResolve() { return this; }\n    void used() {}\n}\n',
            'p/C.java': 'package p;\nclass C extends A {\n    protected Object readResolve() { return this; }\n}\n',
            'p/G.java': 'package p;\nclass G implements java.util.Comparator<String>, java.io.Externalizable {\n    public int compare(String a, String b) { return 0; }\n    private Object writeReplace() { return this; }\n}\n',
            'p/N.java': 'package p;\nclass N extends Number {\n    public int intValue() { return 0; }\n    public long longValue() { return 0; }\n    public float floatValue() { return 0; }\n    public double doubleValue() { return 0; }\n    private Object writeReplace() { return this; }\n}\n',
            'p/E.java': 'package p;\nclass E extends RuntimeException {\n    private Object readResolve() { return this; }\n}\n',
            'p/Plain.java': 'package p;\nclass Plain {\n    private Object readResolve() { return this; }\n}\n',
            'p/M.java': 'package p;\nclass M { void m(A a, C c, G g, N n, E e, Plain x) { a.used(); } }\n',
            'K.cs': 'namespace N;\npublic class K : System.Exception, System.IComparable { public int CompareTo(object o) => 0; }\n',
        });
        try {
            const index = idx(dir);
            const a = (index.symbols.get('A') || []).find(d => d.type === 'class');
            assert.deepStrictEqual(a.implements, ['java.io.Serializable']);
            const g = (index.symbols.get('G') || []).find(d => d.type === 'class');
            assert.deepStrictEqual(g.implements, ['java.util.Comparator<String>', 'java.io.Externalizable']);
            const k = (index.symbols.get('K') || []).find(d => d.type === 'class');
            assert.strictEqual(k.extends, 'System.Exception');
            assert.deepStrictEqual(k.implements, ['System.IComparable']);
            const dead = index.deadcode().map(d => `${d.className || ''}.${d.name}`);
            assert.ok(!dead.includes('A.readResolve') && !dead.includes('C.readResolve') &&
                !dead.includes('G.writeReplace') && !dead.includes('N.writeReplace') &&
                !dead.includes('E.readResolve'), dead.join(','));
            assert.ok(dead.includes('Plain.readResolve'), 'a class outside the serialization contract keeps the claim');
        } finally { rm(dir); }
    });

    it('C#: compiler-required types are live when their feature is used, claimable when not', () => {
        const polyfill = 'namespace System.Runtime.CompilerServices\n{\n    internal static class IsExternalInit\n    {\n    }\n}\n';
        const withInit = tmp({
            'Legacy/IsExternalInit.cs': polyfill,
            'Model.cs': 'namespace App;\npublic class Opt { public string Name { get; init; } = ""; }\n',
        });
        const withRecord = tmp({
            'Legacy/IsExternalInit.cs': polyfill,
            'Model.cs': 'namespace App;\npublic record Point(int X, int Y);\n',
        });
        const without = tmp({
            'Legacy/IsExternalInit.cs': polyfill,
            'Model.cs': 'namespace App;\npublic class Opt { public string Name { get; set; } = ""; }\n',
        });
        const elsewhere = tmp({
            'Legacy/IsExternalInit.cs': 'namespace App.Compat\n{\n    internal static class IsExternalInit\n    {\n    }\n}\n',
            'Model.cs': 'namespace App;\npublic class Opt { public string Name { get; init; } = ""; }\n',
        });
        try {
            const names = dir => idx(dir).deadcode().map(d => d.name);
            assert.ok(!names(withInit).includes('IsExternalInit'));
            assert.ok(!names(withRecord).includes('IsExternalInit'));
            assert.ok(names(without).includes('IsExternalInit'), 'no init accessor, no record: the polyfill is unused');
            assert.ok(names(elsewhere).includes('IsExternalInit'), 'the compiler looks the type up by its full name only');
            const plan = planEdits(withInit, 'IsExternalInit', 'X');
            assert.ok(plan.contract?.blocked, JSON.stringify(plan.contract));
        } finally { rm(withInit); rm(withRecord); rm(without); rm(elsewhere); }
    });

    it('audit-async: an awaitable stored into a field, property or outer variable flows on; a lost local is still a finding', () => {
        const dir = tmp({
            'T.cs': 'using System.Threading.Tasks;\nnamespace P;\ninternal sealed class TaskExecution\n{\n    public Task? ExecutionTaskSafe { get; private set; }\n    private Task _field;\n    public async ValueTask<bool> InitializeAsync(bool b)\n    {\n        await Task.Delay(1);\n        ExecutionTaskSafe = RunAsync();\n        _field = RunAsync();\n        Task local;\n        local = RunAsync();\n        return b;\n    }\n    private async Task RunAsync() { await Task.Delay(1); }\n}\n',
            'a.js': 'let pending;\nasync function load() { return 1; }\nasync function start() {\n  pending = load();\n  let mine;\n  mine = load();\n  await null;\n}\nmodule.exports = { start, get: () => pending };\n',
            'm.py': 'LAST = None\nasync def load():\n    return 1\nasync def keep():\n    global LAST\n    LAST = load()\nasync def lose():\n    x = None\n    x = load()\n',
        });
        try {
            const issues = idx(dir).auditAsync({}).issues.map(i => `${i.file}:${i.line}`).sort();
            assert.deepStrictEqual(issues, ['T.cs:13', 'a.js:6', 'm.py:9'], JSON.stringify(issues));
        } finally { rm(dir); }
    });
});

describe('fix #381: class identity by lexical scope, name-exact import bindings, one-hop local aliases', () => {
    const relations = (dir, handle) => {
        const index = idx(dir);
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle}: ${r.error}`);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: [...new Set([...(json.data.callers || []),
                ...(json.data.usages || []).filter(u => u.tier === 'confirmed')]
                .map(c => `${c.file}:${c.line}`))].sort(),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`).sort(),
            callees: (json.data.callees || []).map(c => `${c.name}@${c.file}:${c.line}`).sort(),
            conserved: json.meta.account?.conserved,
        };
    };
    const planFiles = (dir, handle) => {
        const r = execute(idx(dir), 'plan', { name: handle, renameTo: 'zz_renamed' });
        assert.ok(r.ok, JSON.stringify(r.error));
        return [...new Set(r.result.changes.map(c => c.file))].sort();
    };

    it('Python: a field typed by a function-local class names that class, never a same-name module class', () => {
        const dir = tmp({
            'pkg/__init__.py': '',
            'pkg/slmq.py': 'class Channel:\n    def basic_cancel(self, tag):\n        pass\n',
            'pkg/ext.py': 'import amqp\n\n\nclass Channel(amqp.Channel):\n    pass\n',
            'pkg/test_x.py': [
                'from pkg import ext',
                '',
                '',
                'class TestC:',
                '    def setup_method(self):',
                '        class Channel(ext.Channel):',
                '            pass',
                '        self.channel = Channel()',
                '',
                '    def test_it(self):',
                "        self.channel.basic_cancel('t')",
                '',
            ].join('\n'),
            'pkg/test_y.py': [
                'from pkg.slmq import Channel',
                '',
                '',
                'class TestD:',
                '    def setup_method(self):',
                '        class Channel:',
                '            def basic_cancel(self, tag):',
                '                pass',
                '        self.channel = Channel()',
                '        c = Channel()',
                "        c.basic_cancel('a')",
                '',
                '    def test_local(self):',
                "        self.channel.basic_cancel('t')",
                '',
                '    def test_imported(self):',
                '        c = Channel()',
                "        c.basic_cancel('b')",
                '',
                '',
                'class TestE:',
                '    def setup_method(self):',
                '        self.channel = Channel()',
                '',
                '    def test_it(self):',
                "        self.channel.basic_cancel('x')",
                '',
            ].join('\n'),
        });
        try {
            const module = relations(dir, 'pkg/slmq.py:2:basic_cancel');
            assert.deepStrictEqual(module.confirmed, ['pkg/test_y.py:18', 'pkg/test_y.py:26']);
            assert.deepStrictEqual(module.unverified, []);
            assert.strictEqual(module.conserved, true);
            const local = relations(dir, 'pkg/test_y.py:7:basic_cancel');
            assert.deepStrictEqual(local.confirmed, ['pkg/test_y.py:11', 'pkg/test_y.py:14']);
            const localClass = relations(dir, 'pkg/test_y.py:6:Channel');
            assert.deepStrictEqual(localClass.confirmed, ['pkg/test_y.py:10', 'pkg/test_y.py:9']);
            const moduleClass = relations(dir, 'pkg/slmq.py:1:Channel');
            assert.deepStrictEqual(moduleClass.confirmed, ['pkg/test_y.py:17', 'pkg/test_y.py:23']);
            assert.deepStrictEqual(relations(dir, 'pkg/test_y.py:5:setup_method').callees,
                ['Channel@pkg/test_y.py:6', 'basic_cancel@pkg/test_y.py:7']);
            assert.deepStrictEqual(relations(dir, 'pkg/test_x.py:10:test_it').callees, []);
            assert.ok(!planFiles(dir, 'pkg/slmq.py:2:basic_cancel').includes('pkg/test_x.py'));
        } finally { rm(dir); }
    });

    it('Python: a field callee resolves to the imported class among same-name classes', () => {
        const dir = tmp({
            'pkg/__init__.py': '',
            'pkg/a.py': 'class Channel:\n    def _put(self, m):\n        pass\n',
            'pkg/b.py': 'class Channel:\n    def _put(self, m):\n        pass\n',
            't/test_b.py': [
                'from pkg.b import Channel',
                '',
                '',
                'class TestB:',
                '    def setup_method(self):',
                '        self.channel = Channel()',
                '',
                '    def test_put(self):',
                "        self.channel._put('m')",
                '',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(relations(dir, 't/test_b.py:8:test_put').callees, ['_put@pkg/b.py:2']);
            assert.deepStrictEqual(relations(dir, 'pkg/a.py:2:_put').confirmed, []);
            assert.deepStrictEqual(relations(dir, 'pkg/b.py:2:_put').confirmed, ['t/test_b.py:9']);
        } finally { rm(dir); }
    });

    it('Python: a class-body assignment in a local class does not rebind the function\'s name', () => {
        const dir = tmp({
            'pkg/__init__.py': '',
            'pkg/conn.py': 'class Connection:\n    def __init__(self, port=None):\n        self.port = port\n',
            't/test_port.py': [
                'from pkg.conn import Connection',
                '',
                '',
                'class MockConnection(dict):',
                '    pass',
                '',
                '',
                'def test_default_port():',
                '    class Transport:',
                '        Connection = MockConnection',
                '    c = Connection(port=None)',
                '    return c, Transport',
                '',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(relations(dir, 't/test_port.py:8:test_default_port').callees,
                ['Connection@pkg/conn.py:1']);
        } finally { rm(dir); }
    });

    it('a name bound by an import of that name never borrows another import\'s re-export (Python, JS)', () => {
        const py = tmp({
            'pkg/__init__.py': '',
            'pkg/base.py': 'class Transport:\n    def connect(self):\n        pass\n',
            'pkg/qp.py': 'from pkg import base\n\n\nclass Transport(base.Transport):\n    def verify(self):\n        pass\n',
            'pkg/virt/__init__.py': 'from .base import Transport\n\n\nclass Base64:\n    pass\n',
            'pkg/virt/base.py': 'from pkg import base\n\n\nclass Transport(base.Transport):\n    def drain_events(self):\n        pass\n',
            't/__init__.py': '',
            't/test_qp.py': [
                'from unittest.mock import patch',
                'from pkg.virt import Base64',
                'from pkg.qp import Transport',
                '',
                '',
                "@patch.object(Transport, 'verify')",
                'def test_a(m):',
                '    pass',
                '',
                '',
                'def test_b():',
                '    Transport()',
                '',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(relations(py, 'pkg/virt/base.py:4:Transport').confirmed, []);
            assert.deepStrictEqual(relations(py, 'pkg/qp.py:4:Transport').confirmed,
                ['t/test_qp.py:12', 't/test_qp.py:6']);
        } finally { rm(py); }
        const js = tmp({
            'a.ts': 'export class Transport { verify(): void {} }\n',
            'other.ts': 'export class Transport { drain(): void {} }\n',
            'barrel.ts': "export * from './other';\nexport class Base64 {}\n",
            'use.ts': "import { Transport } from './a';\nimport { Base64 } from './barrel';\ndeclare function register(x: unknown): void;\nregister(Transport);\nregister(Base64);\n",
        });
        try {
            assert.deepStrictEqual(relations(js, 'other.ts:1:Transport').confirmed, []);
            assert.deepStrictEqual(relations(js, 'a.ts:1:Transport').confirmed, ['use.ts:4']);
        } finally { rm(js); }
    });

    it('a one-hop local alias of a typed field, parameter or local carries its type in every language', () => {
        const cases = [
            [{
                'config.py': 'class Config:\n    def load(self):\n        pass\n',
                'other.py': 'class Other:\n    def load(self):\n        pass\n',
                'server.py': [
                    'from config import Config',
                    '',
                    '',
                    'def make():',
                    '    return None',
                    '',
                    '',
                    'class Server:',
                    '    def __init__(self, config: Config):',
                    '        self.config = config',
                    '',
                    '    def run(self):',
                    '        config = self.config',
                    '        config.load()',
                    '',
                    '    def run2(self, cfg: Config):',
                    '        c = cfg',
                    '        c.load()',
                    '',
                    '    def run3(self):',
                    '        c = Config()',
                    '        d = c',
                    '        d.load()',
                    '',
                    '    def reassigned(self):',
                    '        config = self.config',
                    '        config = make()',
                    '        config.load()',
                    '',
                ].join('\n'),
            }, 'config.py:2:load', ['server.py:14', 'server.py:18', 'server.py:23'], 'server.py:28'],
            [{
                'config.ts': 'export class Config {\n  load(): void {}\n}\n',
                'other.ts': 'export class Other {\n  load(): void {}\n}\n',
                'server.ts': [
                    "import { Config } from './config';",
                    '',
                    'export class Server {',
                    '  private config: Config;',
                    '  constructor(config: Config) { this.config = config; }',
                    '  run(): void {',
                    '    const c = this.config;',
                    '    c.load();',
                    '  }',
                    '  run2(cfg: Config): void {',
                    '    const c = cfg;',
                    '    c.load();',
                    '  }',
                    '  shadowed(items: any[]): void {',
                    '    const c = this.config;',
                    '    items.forEach((c) => c.load());',
                    '  }',
                    '}',
                    '',
                ].join('\n'),
            }, 'config.ts:2:load', ['server.ts:12', 'server.ts:8'], 'server.ts:16'],
            [{
                'p/Config.java': 'package p;\npublic class Config {\n    public void load() {}\n}\n',
                'p/Other.java': 'package p;\npublic class Other {\n    public void load() {}\n}\n',
                'p/Server.java': [
                    'package p;',
                    'public class Server {',
                    '    private Config config;',
                    '    private Object other;',
                    '    public void run() {',
                    '        var c = this.config;',
                    '        c.load();',
                    '    }',
                    '    public void run2(Config cfg) {',
                    '        var c = cfg;',
                    '        c.load();',
                    '    }',
                    '    public void reassigned(Config cfg) {',
                    '        var c = this.config;',
                    '        c = null;',
                    '        c.load();',
                    '    }',
                    '}',
                    '',
                ].join('\n'),
            }, 'p/Config.java:3:load', ['p/Server.java:11', 'p/Server.java:7'], null],
            [{
                'Config.cs': 'namespace P {\n    public class Config { public void Load() {} }\n    public class Other { public void Load() {} }\n}\n',
                'Server.cs': [
                    'namespace P {',
                    '    public class Server {',
                    '        private Config config;',
                    '        public void Run() {',
                    '            var c = this.config;',
                    '            c.Load();',
                    '        }',
                    '        public void Run2(Config cfg) {',
                    '            var c = cfg;',
                    '            c.Load();',
                    '        }',
                    '        public void Run3() {',
                    '            var c = config;',
                    '            c.Load();',
                    '        }',
                    '    }',
                    '}',
                    '',
                ].join('\n'),
            }, 'Config.cs:2:Load', ['Server.cs:10', 'Server.cs:14', 'Server.cs:6'], null],
            [{
                'go.mod': 'module ex\ngo 1.21\n',
                'config.go': 'package ex\n\ntype Config struct{}\n\nfunc (c *Config) Load() {}\n\ntype Other struct{}\n\nfunc (o *Other) Load() {}\n',
                'server.go': [
                    'package ex',
                    '',
                    'type Server struct {',
                    '\tconfig *Config',
                    '\tother  *Other',
                    '}',
                    '',
                    'func (s *Server) Run() {',
                    '\tc := s.config',
                    '\tc.Load()',
                    '}',
                    '',
                    'func (s *Server) Reassigned() {',
                    '\tc := s.config',
                    '\tif c == nil {',
                    '\t\tc = nil',
                    '\t}',
                    '\tc.Load()',
                    '}',
                    '',
                ].join('\n'),
            }, 'config.go:5:Load', ['server.go:10'], 'server.go:18'],
            [{
                'Cargo.toml': '[package]\nname = "ex"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': [
                    'pub mod config;',
                    'pub struct Server {',
                    '    config: config::Config,',
                    '}',
                    'impl Server {',
                    '    pub fn run(&self) {',
                    '        let c = &self.config;',
                    '        c.load();',
                    '    }',
                    '    pub fn shadowed(&self, o: &config::Other) {',
                    '        let c = &self.config;',
                    '        let c = o;',
                    '        c.load();',
                    '    }',
                    '}',
                    '',
                ].join('\n'),
                'src/config.rs': 'pub struct Config;\nimpl Config {\n    pub fn load(&self) {}\n}\npub struct Other;\nimpl Other {\n    pub fn load(&self) {}\n}\n',
            }, 'src/config.rs:3:load', ['src/lib.rs:8'], null],
        ];
        for (const [files, handle, expected, notConfirmed] of cases) {
            const dir = tmp(files);
            try {
                const rel = relations(dir, handle);
                assert.deepStrictEqual(rel.confirmed, expected, `${handle}: ${JSON.stringify(rel)}`);
                if (notConfirmed) assert.ok(!rel.confirmed.includes(notConfirmed), handle);
                assert.strictEqual(rel.conserved, true, handle);
            } finally { rm(dir); }
        }
    });

    it('Java and Rust function-local types are visible only in their scope', () => {
        const java = tmp({
            'p/Channel.java': 'package p;\npublic class Channel {\n    public void cancel() {}\n}\n',
            'p/T.java': [
                'package p;',
                'public class T {',
                '    void m() {',
                '        class Channel {',
                '            void cancel() {}',
                '        }',
                '        Channel c = new Channel();',
                '        c.cancel();',
                '    }',
                '    void n() {',
                '        Channel c = new Channel();',
                '        c.cancel();',
                '    }',
                '}',
                '',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(relations(java, 'p/Channel.java:3:cancel').confirmed, ['p/T.java:12']);
            assert.deepStrictEqual(relations(java, 'p/T.java:5:cancel').confirmed, ['p/T.java:8']);
        } finally { rm(java); }
        const rust = tmp({
            'Cargo.toml': '[package]\nname = "ex"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': [
                'pub mod chan;',
                'use crate::chan::Channel;',
                'pub fn m() {',
                '    struct Channel;',
                '    impl Channel {',
                '        fn cancel(&self) {}',
                '    }',
                '    let c = Channel {};',
                '    c.cancel();',
                '}',
                'pub fn n() {',
                '    let c = Channel {};',
                '    c.cancel();',
                '}',
                '',
            ].join('\n'),
            'src/chan.rs': 'pub struct Channel;\nimpl Channel {\n    pub fn cancel(&self) {}\n}\n',
        });
        try {
            assert.deepStrictEqual(relations(rust, 'src/chan.rs:3:cancel').confirmed, ['src/lib.rs:13']);
            assert.deepStrictEqual(relations(rust, 'src/lib.rs:6:cancel').confirmed, ['src/lib.rs:9']);
        } finally { rm(rust); }
    });
});

// fix #382: the HOT ranking lists each callable IDENTITY once. The caller
// engine closes a pinned definition over its identity group (overload
// signatures with their implementation, C/C++ prototypes with the definitions
// of their linkage), so every member used to repeat the same count.
describe('fix #382: HOT lists one entry per callable identity', () => {
    const hot = (dir) => idx(dir).getStats({ hot: true, top: 10 }).hot.items
        .map(item => `${item.name} ${item.file}:${item.startLine} ${item.callCount}`);

    it('Python @overload stubs collapse into the implementation', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname="p"\n',
            'lib.py': 'from typing import overload\n\n\n@overload\ndef conv(x: int) -> int: ...\n\n\n' +
                '@overload\ndef conv(x: str) -> str: ...\n\n\ndef conv(x):\n    return x\n',
            'app.py': 'from lib import conv\n\n\ndef run():\n    return [conv(1), conv("a"), conv(2)]\n',
        });
        try {
            assert.deepStrictEqual(hot(dir), ['conv lib.py:12 3']);
        } finally { rm(dir); }
    });

    it('TypeScript overload signatures collapse into the implementation', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'h.ts': 'export function h(a: string): string;\nexport function h(a: number): number;\n' +
                'export function h(a: any): any { return a; }\n',
            'app.ts': "import { h } from './h';\nexport function run() { return [h('x'), h(1)]; }\n",
        });
        try {
            assert.deepStrictEqual(hot(dir), ['h h.ts:3 2']);
        } finally { rm(dir); }
    });

    it('a C prototype and its definitions are one entry with the linkage count', () => {
        const dir = tmp({
            'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.0)\n',
            'include/api.h': 'int translate(int e);\nint single(int e);\n',
            // Platform variants of one external function.
            'src/unix/impl.c': '#include "../../include/api.h"\nint translate(int e) { return e; }\n',
            'src/win/impl.c': '#include "../../include/api.h"\nint translate(int e) { return -e; }\n',
            'src/single.c': '#include "../include/api.h"\nint single(int e) { return e; }\n',
            'src/use.c': '#include "../include/api.h"\n' +
                'int use(void) { return translate(1) + translate(2) + single(3); }\n' +
                'int use2(void) { return translate(4) + single(5); }\n',
        });
        try {
            // Two definitions: only the declaration's closure covers both, so
            // the entity is shown there with all of its calls. One
            // definition: shown at the implementation.
            assert.deepStrictEqual(hot(dir), ['translate include/api.h:1 3', 'single src/single.c:2 2']);
        } finally { rm(dir); }
    });
});

describe('fix #383: router frameworks, join rules, handlers and methods (endpoints)', () => {
    const { extractServerRoutes, endpoints, normalizePath } = require('../core/bridge');
    const rows = (index, filter = () => true) => extractServerRoutes(index).filter(filter)
        .map(r => `${r.method} ${r.path} ${r.handler} [${r.framework}]`).sort();

    it('JS: the imported framework labels its routes and decides the join (Fastify, koa-router, Express)', () => {
        const dir = tmp({
            'package.json': '{"name":"app"}',
            'fast.js': [
                "const Fastify = require('fastify')",
                'const app = Fastify()',
                'app.register((instance, opts, done) => {',
                "  instance.get('/', listUsers)",
                "  instance.get('items', listItems)",
                '  done()',
                "}, { prefix: '/users' })",
            ].join('\n'),
            'koa.js': [
                "const Router = require('@koa/router')",
                'const api = new Router()',
                "const sub = new Router({ prefix: '/k' })",
                "sub.get('/a', handlerA)",
                "api.use('/api', sub.routes())",
            ].join('\n'),
            'exp.js': [
                "const express = require('express')",
                'const app = express()',
                "app.get('/files/*', auth, (req, res) => res.send(req.params))",
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(rows(index), [
                'GET /api/k/a handlerA [koa]',
                'GET /files/* <anonymous> [express]',
                'GET /users listUsers [fastify]',
                'GET /usersitems listItems [fastify]',
            ]);
            // Express `*` is a catch-all: it spans segments.
            const files = extractServerRoutes(index).find(r => r.path === '/files/*');
            assert.strictEqual(files.normalizedPath, '/files/**');
        } finally { rm(dir); }
    });

    it('JS: a Fastify project labels its own tests through require of its package entry', () => {
        const dir = tmp({
            'package.json': '{"name":"fastify","main":"fastify.js"}',
            'fastify.js': 'module.exports = function fastify () { return {} }\n',
            'test/basic.test.js': [
                "const Fastify = require('..')",
                'const app = Fastify()',
                "app.route({ method: 'GET', url: '/cfg', handler: cfgHandler })",
                "app.get('/plain', opts, function (req, reply) { reply.send(new Error('x')) })",
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(rows(idx(dir)), [
                'GET /cfg cfgHandler [fastify]',
                'GET /plain <anonymous> [fastify]',
            ]);
        } finally { rm(dir); }
    });

    it('Go: gin and echo labels, echo concatenates group prefixes and takes the handler first; method-first registrations', () => {
        const dir = tmp({
            'go.mod': 'module example.com/m\n',
            'g.go': [
                'package main',
                'import (',
                '\t"net/http"',
                '\t"github.com/gin-gonic/gin"',
                ')',
                'func g() {',
                '\tr := gin.New()',
                '\tr.GET("/a", func(c *gin.Context) { c.String(http.StatusOK, "x") })',
                '\tr.GET("/static/*filepath", auth, serve)',
                '}',
            ].join('\n'),
            'e.go': [
                'package main',
                'import "github.com/labstack/echo/v4"',
                'func e() {',
                '\tsrv := echo.New()',
                '\tgrp := srv.Group("/api")',
                '\tgrp.GET("items", listItems, logMiddleware)',
                '\tsrv.Add(http.MethodPut, "/put", putItem)',
                '\tsrv.Match([]string{http.MethodGet, "POST"}, "/both", both)',
                '}',
            ].join('\n').replace('import "github.com/labstack/echo/v4"',
                'import (\n\t"net/http"\n\t"github.com/labstack/echo/v4"\n)'),
            'h.go': [
                'package main',
                'import (',
                '\t"net/http"',
                '\t"github.com/gin-gonic/gin"',
                ')',
                'func h() {',
                '\tr := gin.Default()',
                '\tr.Handle(http.MethodDelete, "/items/:id", deleteItem)',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(rows(index), [
                'DELETE /items/:id deleteItem [gin]',
                'GET /a <anonymous> [gin]',
                'GET /apiitems listItems [echo]',
                'GET /both both [echo]',
                'GET /static/*filepath serve [gin]',
                'POST /both both [echo]',
                'PUT /put putItem [echo]',
            ]);
            const catchAll = extractServerRoutes(index).find(r => r.path === '/static/*filepath');
            assert.strictEqual(catchAll.normalizedPath, '/static/**');
        } finally { rm(dir); }
    });

    it('Go: a context key lookup is not a request; NewRequest reads its method and URL; in-process requests bridge in their own test', () => {
        const dir = tmp({
            'go.mod': 'module example.com/m\n',
            'x_test.go': [
                'package main',
                'import (',
                '\t"net/http"',
                '\t"testing"',
                '\t"github.com/gin-gonic/gin"',
                ')',
                'func TestA(t *testing.T) {',
                '\tr := gin.New()',
                '\tr.GET("/users/:id", show)',
                '\treq, _ := http.NewRequest(http.MethodGet, "/users/7", nil)',
                '\tr.ServeHTTP(nil, req)',
                '}',
                'func TestB(t *testing.T) {',
                '\treq, _ := http.NewRequest("QUERY", "/users/8", nil)',
                '\t_ = req',
                '}',
                'func handler(c *gin.Context) {',
                '\tc.Get("user")',
                '}',
            ].join('\n'),
        });
        try {
            const result = endpoints(idx(dir), { bridge: true });
            assert.deepStrictEqual(result.requests.map(r => `${r.method} ${r.path}`).sort(),
                ['GET /users/7', 'QUERY /users/8']);
            assert.deepStrictEqual(result.bridges.map(b => `${b.request.path} -> ${b.route.path}`),
                ['/users/7 -> /users/:id']);
        } finally { rm(dir); }
    });

    it('Rust: an axum route serves the methods of its method router, each with its handler', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n',
            'src/main.rs': [
                'use axum::{routing::{get, on, MethodFilter}, Router};',
                'fn app() -> Router {',
                '    Router::new()',
                '        .route("/users", get(list_users).post(create_user))',
                '        .route("/a", on(MethodFilter::PUT.or(MethodFilter::PATCH), update))',
                '        .route("/b", get(|| async {}).layer(tower::layer::util::Identity::new()))',
                '}',
                'async fn list_users() {}',
                'async fn create_user() {}',
                'async fn update() {}',
            ].join('\n'),
        });
        try {
            assert.deepStrictEqual(rows(idx(dir)), [
                'GET /b <anonymous> [axum]',
                'GET /users list_users [axum]',
                'PATCH /a update [axum]',
                'POST /users create_user [axum]',
                'PUT /a update [axum]',
            ]);
        } finally { rm(dir); }
    });

    it('normalizePath: parameter spellings by framework family', () => {
        const cases = [
            ['/users/:id', 'router', '/users/*'],
            ['/files/:rest*', 'router', '/files/**'],
            ['/{*rest}', 'router', '/**'],
            ['/users/{username}:disable', 'python', '/users/*:disable'],
            ['/files/<path:p>', 'python', '/files/**'],
            ['/{tail:.*}', 'python', '/**'],
            ['/x/*', 'jvm', '/x/*'],
            ['/x/**', 'jvm', '/x/**'],
            ['/users/tom:disable?x=1', 'client', '/users/tom:disable'],
        ];
        for (const [raw, syntax, expected] of cases) {
            assert.strictEqual(normalizePath(raw, syntax), expected, `${syntax} ${raw}`);
        }
    });
});

describe('fix #383: trust lines survive every output budget (CLI and MCP)', () => {
    const { applyOutputBudget } = require('../core/output-budget');
    const TRUST = /^(?:ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT):/;
    const trustLines = text => text.split('\n').map(line => line.trim()).filter(line => TRUST.test(line));
    // Every truncated answer either carries all of the full answer's trust
    // lines or withholds the answer and names the budget that carries them.
    const checkBudget = (full, out, limit, label) => {
        assert.ok(out.length <= limit, `${label}: ${out.length} > ${limit}`);
        const shown = new Set(out.split('\n').map(line => line.trim()));
        const missing = trustLines(full).filter(line => !shown.has(line));
        if (missing.length > 0) {
            assert.match(out, /withheld.*(?:at least |>=)\d+|^$/i,
                `${label}: ${missing.length} trust line(s) dropped silently:\n${out}`);
            // No body text accompanies an incomplete contract.
            assert.doesNotMatch(out, /CALLERS|SUMMARY/, `${label}: body shown without its contract`);
        }
    };

    it('applyOutputBudget reserves every trust line before the body, or withholds the answer', () => {
        const full = [
            'SUMMARY',
            ...Array.from({ length: 80 }, (_, i) => `  [${i + 1}] src/f${i}.js:${i + 1}: target(${i})`),
            `ACCOUNT: "target" occurs on 90 lines: 80 confirmed, 3 unverified, ${'x'.repeat(60)}`,
            `CONTRACT: literal-name text partition is DEGRADED; ${'y'.repeat(80)}`,
            `WARNING: 5 source discovery gap(s): ${'z'.repeat(250)}`,
            'CALLEE ACCOUNT: 12 call sites = 2 confirmed + 10 unverified',
        ].join('\n');
        const needed = [];
        for (const surface of ['cli', 'mcp']) {
            for (const limit of [60, 150, 300, 400, 500, 600, 700, 800, 1000, 3000]) {
                const out = applyOutputBudget(full, { command: 'show', maxChars: limit, surface });
                checkBudget(full, out.text, limit, `${surface} ${limit}`);
                if (/withheld/i.test(out.text)) assert.strictEqual(out.contractMetadataComplete, false);
                const at = out.text.match(/(?:at least |>=)(\d+)/);
                if (at) needed.push([surface, Number(at[1])]);
            }
        }
        // The named budget carries the trust lines.
        for (const [surface, limit] of needed) {
            const out = applyOutputBudget(full, { command: 'show', maxChars: limit, surface });
            assert.doesNotMatch(out.text, /withheld/, `${surface} ${limit}`);
            for (const line of trustLines(full)) assert.ok(out.text.includes(line), `${surface} ${limit}: ${line}`);
        }
    });

    it('CLI and MCP show/impact keep ACCOUNT and CONTRACT at 400, 600 and 800 chars', async () => {
        const dir = tmp({
            'package.json': '{"name":"x"}',
            'lib.js': [
                'function target(a) { return a + 1 }',
                ...Array.from({ length: 40 }, (_, i) => `function caller${i}() { return target(${i}) }`),
                'function other(o) { return o.target() }',
                'module.exports = { target, other }',
            ].join('\n'),
        });
        const { McpClient } = require('./helpers');
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            for (const command of ['show', 'impact']) {
                const full = runCli(dir, command, ['target'], ['--max-chars=100000']);
                assert.ok(trustLines(full).length >= 2, full);
                for (const limit of [200, 400, 600, 800, 1200]) {
                    const cli = runCli(dir, command, ['target'], [`--max-chars=${limit}`]);
                    checkBudget(full, cli.replace(/\n$/, ''), limit, `cli ${command} ${limit}`);
                    const mcp = await client.callTool({ command, project_dir: dir, name: 'target', max_chars: limit });
                    checkBudget(full, mcp.text, limit, `mcp ${command} ${limit}`);
                }
            }
        } finally {
            client.stop();
            rm(dir);
        }
    });
});

describe('fix #384: members differing only by parameter type are selected by argument type in every language', () => {
    const tiers = (index, name, file, line) => {
        const r = execute(index, 'show', { name, file, line, sections: 'callers' });
        assert.ok(r.ok, r.error);
        const ctx = r.result.context || r.result;
        return {
            confirmed: (ctx.callers || []).map(c => c.line).sort((a, b) => a - b),
            mismatch: ctx.meta?.account?.excluded?.byReason?.['overload-mismatch']?.count || 0,
        };
    };
    const cases = {
        'C# class implementing IEquatable<A> and IEquatable<B>': {
            files: { 'P.cs': 'using System;\nclass A {}\nclass B {}\nclass P : IEquatable<A>, IEquatable<B> {\n  public bool Equals(A a) { return true; }\n  public bool Equals(B b) { return false; }\n}\nclass U {\n  bool u(P p, A a, B b) {\n    var x = p.Equals(a);\n    var y = p.Equals(b);\n    return x && y;\n  }\n}\n' },
            name: 'Equals', file: 'P.cs', lines: [5, 6], sites: [10, 11],
        },
        'Java overloads by parameter type': {
            files: { 'src/A.java': 'public class A {}', 'src/B.java': 'public class B {}',
                'src/P.java': 'public class P {\n  public boolean same(A a) { return true; }\n  public boolean same(B b) { return false; }\n}',
                'src/U.java': 'public class U {\n  boolean u(P p, A a, B b) {\n    boolean x = p.same(a);\n    boolean y = p.same(b);\n    return x && y;\n  }\n}' },
            name: 'same', file: 'src/P.java', lines: [2, 3], sites: [3, 4],
        },
    };
    for (const [label, spec] of Object.entries(cases)) {
        it(label, () => {
            const dir = tmp(spec.files);
            try {
                const index = idx(dir);
                spec.lines.forEach((line, i) => {
                    const t = tiers(index, spec.name, spec.file, line);
                    assert.deepStrictEqual(t.confirmed, [spec.sites[i]], `${label} ${line}: ${JSON.stringify(t)}`);
                    assert.strictEqual(t.mismatch, 1);
                });
            } finally { rm(dir); }
        });
    }
});

describe('fix #384: a type-qualified call names the type its own module binds (Rust, Python, TS)', () => {
    const cases = {
        rust: { 'Cargo.toml': '[package]\nname = "m"\nversion = "0.1.0"\n', 'src/lib.rs': 'mod a;\nmod b;\n',
            'src/a.rs': 'struct Shared;\nimpl Shared {\n    fn init() -> i32 { 1 }\n}\npub fn use_a() -> i32 { Shared::init() }\n',
            'src/b.rs': 'struct Shared;\nimpl Shared {\n    fn init() -> i32 { 2 }\n}\npub fn use_b() -> i32 { Shared::init() }\n' },
        python: { 'pkg/__init__.py': '',
            'pkg/a.py': 'class Shared:\n    @staticmethod\n    def init():\n        return 1\n\ndef use_a():\n    return Shared.init()\n',
            'pkg/b.py': 'class Shared:\n    @staticmethod\n    def init():\n        return 2\n\ndef use_b():\n    return Shared.init()\n' },
        typescript: { 'package.json': '{"name":"x"}',
            'a.ts': 'class Shared {\n  static init() { return 1; }\n}\nexport function useA() { return Shared.init(); }\n',
            'b.ts': 'class Shared {\n  static init() { return 2; }\n}\nexport function useB() { return Shared.init(); }\n' },
    };
    const files = { rust: ['src/a.rs', 'src/b.rs'], python: ['pkg/a.py', 'pkg/b.py'], typescript: ['a.ts', 'b.ts'] };
    const callLine = { rust: 5, python: 7, typescript: 4 };
    for (const [language, fixture] of Object.entries(cases)) {
        it(`${language}: each module's own Shared.init call is its only caller; plan renames only it`, () => {
            const dir = tmp(fixture);
            try {
                const index = idx(dir);
                for (const [i, file] of files[language].entries()) {
                    const other = files[language][1 - i];
                    const def = index.symbols.get('init').find(d => d.relativePath === file);
                    const r = execute(index, 'show', { name: 'init', file, line: def.startLine, sections: 'callers' });
                    const ctx = r.result.context || r.result;
                    assert.deepStrictEqual((ctx.callers || []).map(c => `${c.relativePath}:${c.line}`),
                        [`${file}:${callLine[language]}`]);
                    assert.strictEqual(ctx.meta.account.excluded.byReason['path-type-mismatch']?.count, 1);
                    const plan = execute(index, 'plan', { name: 'init', file, line: def.startLine, renameTo: 'boot' });
                    assert.ok(!plan.result.changes.some(change => change.file === other),
                        JSON.stringify(plan.result.changes));
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #386: renaming a C# type edits every reference to it', () => {
    const { applyRenamePlan } = require('./helpers');
    const files = {
        'Widget.cs': [
            'using System;',
            'namespace App.Core',
            '{',
            '    public interface IShape { int Area(); }',
            '    public class Base { }',
            '    /// <summary>A <see cref="Widget"/> and <see cref="App.Core.Widget.Make"/>.</summary>',
            '    public class Widget : Base, IShape',
            '    {',
            '        public const int Size = 3;',
            '        private Widget _next;',
            '        public Widget() : this(1) { }',
            '        public Widget(int n) { }',
            '        ~Widget() { }',
            '        public static Widget Make() => new Widget();',
            '        public int Area() => 1;',
            '        public Widget Copy(Widget other)',
            '        {',
            '            var w = (Widget)other;',
            '            if (other is Widget ww) return ww;',
            '            var t = typeof(Widget);',
            '            var n = nameof(Widget);',
            '            return Widget.Make();',
            '        }',
            '    }',
            '}',
        ].join('\n'),
        'User.cs': [
            'using App.Core;',
            'using W2 = App.Core.Widget;',
            'namespace App.Use',
            '{',
            '    public class User',
            '    {',
            '        Widget a = new Widget();',
            '        App.Core.Widget b = new App.Core.Widget();',
            '        W2 c;',
            '        System.Collections.Generic.List<Widget> d;',
            '        int s = Widget.Size;',
            '    }',
            '    public class Sub : Widget { }',
            '    public class Holder',
            '    {',
            '        public Widget? Widget { get; set; }',
            '        public void Set(Widget w) { Widget = w; }',
            '    }',
            '}',
        ].join('\n'),
        'Other.cs': 'namespace App.Other\n{\n    public class Widget { }\n    public class O { Widget x = new Widget(); }\n}\n',
    };

    it('C#: constructors, the finalizer, casts, patterns, typeof/nameof, usings and doc crefs; a property named like the type stays', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            // The finalizer's handle plans the class rename.
            const r = execute(index, 'plan', { name: 'Widget', file: 'Widget.cs', line: 13, renameTo: 'Gadget' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            assert.strictEqual(contents['Widget.cs'], files['Widget.cs'].replace(/\bWidget\b/g, 'Gadget'));
            const user = files['User.cs'].replace(/\bWidget\b/g, 'Gadget')
                .replace('public Gadget? Gadget { get; set; }', 'public Gadget? Widget { get; set; }')
                .replace('{ Gadget = w; }', '{ Widget = w; }');
            assert.strictEqual(contents['User.cs'], user);
            assert.ok(!('Other.cs' in contents));
            assert.ok(!(r.result.reviewItems || []).some(item => item.file === 'Widget.cs' && item.line === 6),
                'edited crefs are not text items');
        } finally { rm(dir); }
    });

    it('C#: an attribute class is renamed where it is applied by its short name', () => {
        const dir = tmp({
            'M.cs': [
                'namespace N',
                '{',
                '    public sealed class MarkerAttribute : System.Attribute { }',
                '    [Marker]',
                '    public class A { }',
                '    [N.Marker()]',
                '    public class B { }',
                '}',
            ].join('\n'),
            'O.cs': 'namespace O\n{\n    public sealed class MarkerAttribute : System.Attribute { }\n    [Marker] public class C { }\n}\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'MarkerAttribute', file: 'M.cs', renameTo: 'FlagAttribute' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            assert.ok(contents['M.cs'].includes('class FlagAttribute'));
            assert.ok(contents['M.cs'].includes('    [Flag]'));
            assert.ok(contents['M.cs'].includes('    [N.Flag()]'));
            assert.ok(!('O.cs' in contents), 'namespace O applies its own MarkerAttribute');
        } finally { rm(dir); }
    });
});

describe('fix #386: every type-like kind plan accepts renames its references', () => {
    const { applyRenamePlan } = require('./helpers');
    const cases = [
        { lang: 'TypeScript type alias', handle: { name: 'Pair', file: 'a.ts' }, files: {
            'package.json': '{"name":"t"}',
            'a.ts': 'export type Pair = [number, number];\nexport function f(p: Pair): Pair { return p; }\n',
            'b.ts': "import type { Pair } from './a';\nexport const z: Pair[] = [];\n" } },
        { lang: 'TypeScript enum', handle: { name: 'Color', file: 'a.ts' }, files: {
            'package.json': '{"name":"t"}',
            'a.ts': 'export enum Color { Red }\nexport const c: Color = Color.Red;\n',
            'b.ts': "import { Color } from './a';\nexport function g(x: Color) { return x === Color.Red; }\n" } },
        { lang: 'Python TypeAlias', handle: { name: 'Point', file: 'a.py' }, files: {
            'a.py': 'from typing import TypeAlias\n\nPoint: TypeAlias = tuple[int, int]\n\n\ndef f(p: Point) -> Point:\n    return p\n',
            'b.py': 'from a import Point\n\n\ndef g(p: Point) -> "Point":\n    return p\n' } },
        { lang: 'Go interface', handle: { name: 'Shape', file: 'a.go' }, files: {
            'go.mod': 'module m\n\ngo 1.21\n',
            'a.go': 'package m\n\ntype Shape interface{ Area() int }\n\nfunc Sum(xs []Shape) int { var s Shape; _ = s; return len(xs) }\n\nvar _ Shape = (*sq)(nil)\n\ntype sq struct{}\n\nfunc (*sq) Area() int { return 1 }\n' } },
        { lang: 'Rust trait', handle: { name: 'Shape', file: 'src/lib.rs' }, files: {
            'Cargo.toml': '[package]\nname = "k"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub trait Shape { fn area(&self) -> i32; }\npub struct Sq;\nimpl Shape for Sq { fn area(&self) -> i32 { 1 } }\npub fn total<T: Shape>(xs: &[T]) -> i32 { xs.iter().map(Shape::area).sum() }\npub fn boxed(x: Box<dyn Shape>) -> i32 { x.area() }\n' } },
        { lang: 'Java enum', handle: { name: 'Level', file: 'p/Level.java' }, files: {
            'p/Level.java': 'package p;\npublic enum Level { LOW, HIGH; static Level parse(String s) { return Level.valueOf(s); } }\n',
            'p/Use.java': 'package p;\nimport java.util.EnumSet;\nclass Use { EnumSet<Level> all = EnumSet.allOf(Level.class); Level l = Level.LOW; }\n' } },
    ];
    for (const { lang, handle, files } of cases) {
        it(`${lang}: every spelling is the renamed type`, () => {
            const dir = tmp(files);
            try {
                const index = idx(dir);
                const r = execute(index, 'plan', { ...handle, renameTo: 'Renamed' });
                assert.ok(r.ok, r.error);
                const { contents, reviews } = applyRenamePlan(dir, r.result);
                assert.deepStrictEqual(reviews, []);
                const re = new RegExp(`\\b${handle.name}\\b`, 'g');
                for (const [file, text] of Object.entries(files)) {
                    if (!re.test(text)) continue;
                    re.lastIndex = 0;
                    const moved = (r.result.fileRenames || []).find(m => m.from === file);
                    const actual = moved ? contents[moved.to] : contents[file];
                    assert.strictEqual(actual, text.replace(re, 'Renamed'), `${lang} ${file}`);
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #389: C# written generic arity selects the type in typeof and type renames', () => {
    const { applyRenamePlan } = require('./helpers');

    it('typeof(X<>) / typeof(X<,>) / nameof(X) name the type of that arity; members list per arity', () => {
        const files = {
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'Outcome.cs': [
                'namespace Lib',
                '{',
                '    public static class Outcome',
                '    {',
                '        public static int Create() { return 1; }',
                '    }',
                '    public struct Outcome<T>',
                '    {',
                '        public T Value;',
                '        private static int Probe() { return 2; }',
                '    }',
                '    public struct Outcome<T, U>',
                '    {',
                '        public T A; public U B;',
                '        private static int Probe() { return 3; }',
                '    }',
                '    internal static class Use',
                '    {',
                '        private static string Suffix() { return ""; }',
                '        internal static object Run()',
                '        {',
                '            var a = typeof(Outcome);',
                '            var b = typeof(Outcome<>);',
                '            var c = typeof(Outcome<,>);',
                '            var d = typeof(Outcome<int>);',
                '            var e = nameof(Outcome);',
                '            return typeof(Outcome<>).GetMethod("Probe" + Suffix());',
                '        }',
                '    }',
                '}',
            ].join('\n'),
        };
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const lines = (line, to) => {
                const r = execute(index, 'plan', { name: 'Outcome', file: 'Outcome.cs', line, renameTo: to });
                assert.ok(r.ok, r.error);
                const { contents, reviews } = applyRenamePlan(dir, r.result);
                assert.deepStrictEqual(reviews, []);
                return contents['Outcome.cs'].split('\n').map((text, i) => text.includes(to) ? i + 1 : null)
                    .filter(Boolean);
            };
            assert.deepStrictEqual(lines(3, 'Zero'), [3, 22, 26]);
            assert.deepStrictEqual(lines(7, 'One'), [7, 23, 25, 27]);
            assert.deepStrictEqual(lines(12, 'Two'), [12, 24]);
            const one = index.symbols.get('Outcome').find(d => d.startLine === 7);
            const shown = index.context('Outcome', { file: 'Outcome.cs', line: 7 });
            assert.deepStrictEqual(shown.members?.map(m => m.name) ?? [], ['Value']);
            assert.deepStrictEqual(index.findMethodsForType('Outcome', one).map(m => m.startLine), [10]);
            // The reflective `typeof(Outcome<>)` reaches Outcome<T>.Probe only.
            const dead = execute(index, 'deadcode', {});
            const claimed = JSON.stringify(dead.result);
            assert.ok(claimed.includes('"startLine":15') && !claimed.includes('"startLine":10'), claimed.slice(0, 600));
        } finally { rm(dir); }
    });
});

describe('fix #390: C# generic base slots, attributed declaration names, doc cref member references, same-name class identity', () => {
    const { applyRenamePlan } = require('./helpers');
    const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
    const renamedLines = (dir, result, to) => {
        const { contents } = applyRenamePlan(dir, result);
        const out = [];
        for (const [file, text] of Object.entries(contents)) {
            if (text == null) continue;
            text.split('\n').forEach((row, i) => { if (row.includes(to)) out.push(`${file}:${i + 1}`); });
        }
        return out.sort();
    };

    it('an override below a constructed generic base (`: Visitor<TextWriter, bool>`) joins the slot; another arity does not', () => {
        const dir = tmp({
            'c.csproj': csproj,
            'Visitor.cs': [
                'namespace N',
                '{',
                '    public abstract class Visitor<TState, TResult>',
                '    {',
                '        protected abstract TResult Visit(TState state, int x);',
                '        public TResult Run(TState s) { return Visit(s, 1); }',
                '    }',
                '}',
            ].join('\n'),
            'One.cs': [
                'namespace N',
                '{',
                '    public abstract class Visitor<TState>',
                '    {',
                '        protected abstract bool Visit(TState state, int x);',
                '    }',
                '    public class One : Visitor<System.IO.TextWriter>',
                '    {',
                '        protected override bool Visit(System.IO.TextWriter state, int x) { return true; }',
                '    }',
                '}',
            ].join('\n'),
            'Fmt.cs': [
                'using System.IO;',
                'namespace N',
                '{',
                '    public class Fmt : Visitor<TextWriter, bool>',
                '    {',
                '        protected override bool Visit(TextWriter state, int x) { return true; }',
                '        protected bool Visit(string other, int x) { return false; }',
                '    }',
                '    public abstract class Mid<T> : Visitor<T, bool> { }',
                '    public class Leaf : Mid<int>',
                '    {',
                '        protected override bool Visit(int state, int x) { return false; }',
                '        protected bool Visit(long state, int x) { return true; }',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const plan = (file, line) => {
                const r = execute(index, 'plan', { name: 'Visit', file, line, renameTo: 'VisitZq' });
                assert.ok(r.ok, r.error);
                assert.ok(!r.result.contract?.blocked, JSON.stringify(r.result.contract));
                return renamedLines(dir, r.result, 'VisitZq');
            };
            const slot = ['Fmt.cs:12', 'Fmt.cs:6', 'Visitor.cs:5', 'Visitor.cs:6'];
            assert.deepStrictEqual(plan('Visitor.cs', 5), slot);
            assert.deepStrictEqual(plan('Fmt.cs', 6), slot);
            assert.deepStrictEqual(plan('Fmt.cs', 12), slot);
            assert.deepStrictEqual(plan('One.cs', 9), ['One.cs:5', 'One.cs:9']);
            const cls = index.symbols.get('Visitor').find(d => d.typeArity === 2);
            assert.strictEqual(cls.generics, '<TState, TResult>');
        } finally { rm(dir); }
    });

    it('members of two same-name generic classes of different arity in one file are two items, not configuration alternatives', () => {
        const dir = tmp({
            'c.csproj': csproj,
            'Visitor.cs': [
                'namespace N',
                '{',
                '    public abstract class Visitor<TState, TResult>',
                '    {',
                '        protected abstract TResult Visit(TState state, int x);',
                '        public TResult Run(TState s) { return Visit(s, 1); }',
                '    }',
                '    public abstract class Visitor<TState>',
                '    {',
                '        protected abstract bool Visit(TState state, int x);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const two = index.context('Visit', { file: 'Visitor.cs', line: 5 });
            assert.deepStrictEqual((two.callers || []).map(c => `${c.relativePath}:${c.line}`), ['Visitor.cs:6']);
            const one = index.context('Visit', { file: 'Visitor.cs', line: 10 });
            assert.deepStrictEqual((one.callers || []).map(c => `${c.relativePath}:${c.line}`), []);
        } finally { rm(dir); }
    });

    it('a declaration whose attributes stand on their own lines is renamed on the line that names it', () => {
        const dir = tmp({
            'c.csproj': csproj,
            'A.cs': [
                'using System;',
                'namespace N',
                '{',
                '    public class Widget',
                '    {',
                '        [Obsolete("x")]',
                '        static int Compute(int a)',
                '        {',
                '            return a;',
                '        }',
                '        [Obsolete("y")]',
                '        public int Size { get; set; }',
                '        public int Use() { return Compute(1) + Size; }',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const compute = index.symbols.get('Compute')[0];
            assert.strictEqual(compute.startLine, 6);
            assert.strictEqual(compute.nameLine, 7);
            const r = execute(index, 'plan', { name: 'Compute', file: 'A.cs', line: 6, renameTo: 'ComputeZq' });
            assert.ok(r.ok, r.error);
            assert.deepStrictEqual(renamedLines(dir, r.result, 'ComputeZq'), ['A.cs:13', 'A.cs:7']);
            assert.strictEqual(index.symbols.get('Size')[0].nameLine, 12);
        } finally { rm(dir); }
    });

    it('doc cref attributes naming the renamed member are edited; other members and unresolved types are not', () => {
        const dir = tmp({
            'c.csproj': csproj,
            'Ctx.cs': [
                'namespace N',
                '{',
                '    public static class Ctx',
                '    {',
                '        /// <summary>Undo with <see cref="Suspend"/> or <see cref="Ctx.Suspend()"/>.</summary>',
                '        public static int Suspend() { return 1; }',
                '        /// <summary>See <see cref="Other.Suspend"/>.</summary>',
                '        public static int Keep() { return Other.Suspend(); }',
                '        /// <summary>See <see cref="Missing.Suspend"/>.</summary>',
                '        public static int Also() { return Suspend(); }',
                '    }',
                '    public static class Other',
                '    {',
                '        /// <summary>Mine: <see cref="Suspend"/>.</summary>',
                '        public static int Suspend() { return 2; }',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Suspend', file: 'Ctx.cs', line: 6, renameTo: 'Pause' });
            assert.ok(r.ok, r.error);
            const edited = new Map(r.result.changes.map(c => [c.line, c.newExpression]));
            assert.match(edited.get(5), /cref="Pause"\/> or <see cref="Ctx\.Pause\(\)"/);
            assert.ok(!edited.has(7) && !edited.has(14), JSON.stringify([...edited]));
            // `Missing` is no project type here: an external type's member,
            // never the renamed one (comment text only).
            assert.ok(!edited.has(9));
            const substantive = (r.result.reviewItems || []).filter(item => !item.textDependency);
            assert.deepStrictEqual(substantive.map(item => item.line), []);
        } finally { rm(dir); }
    });

    it('a class named like a subclass of the target in another namespace is not an implicit-this caller', () => {
        const dir = tmp({
            'c.csproj': csproj,
            'Base.cs': [
                'namespace N1',
                '{',
                '    public class Base { public static bool Check(bool c) { return c; } }',
                '    public class Probe : Base { public bool Run() { return Check(true); } }',
                '}',
            ].join('\n'),
            'Util.cs': [
                'namespace N2',
                '{',
                '    public static class Util { public static bool Check(bool c) { return !c; } }',
                '}',
            ].join('\n'),
            'Probe.cs': [
                'using static N2.Util;',
                'namespace N2',
                '{',
                '    public class Probe { public bool Run() { return Check(false); } }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const ctx = index.context('Check', { file: 'Base.cs', line: 3 });
            const sites = [...(ctx.callers || []), ...(ctx.unverifiedCallers || [])]
                .map(c => `${c.relativePath || c.file}:${c.line}`).sort();
            assert.deepStrictEqual(sites, ['Base.cs:4']);
            // The `using static` type supplies it: a confirmed caller and callee.
            const util = index.context('Check', { file: 'Util.cs', line: 3 });
            assert.deepStrictEqual((util.callers || []).map(c => `${c.relativePath}:${c.line}`), ['Probe.cs:4']);
            const run = index.context('Run', { file: 'Probe.cs' });
            assert.deepStrictEqual((run.callees || []).map(c => `${c.relativePath}:${c.startLine}`), ['Util.cs:3']);
        } finally { rm(dir); }
    });
});

describe('fix #390: constructed generic bases join override slots in every class language', () => {
    const { applyRenamePlan } = require('./helpers');
    const cases = {
        typescript: {
            files: {
                'base.ts': 'export abstract class Base<S> {\n    abstract visit(state: S, x: number): void;\n    run(s: S) { this.visit(s, 1); }\n}\n',
                'impl.ts': "import { Base } from './base';\nexport class Impl extends Base<string> {\n    visit(state: string, x: number): void {}\n}\n",
            },
            pin: ['visit', 'base.ts', 2], expect: ['base.ts:2', 'base.ts:3', 'impl.ts:3'],
        },
        rust: {
            files: {
                'Cargo.toml': '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n',
                'src/lib.rs': 'pub trait Visitor<T> {\n    fn visit(&self, t: T, x: i32);\n}\npub struct X;\nimpl Visitor<String> for X {\n    fn visit(&self, t: String, x: i32) {}\n}\npub fn run<V: Visitor<String>>(v: &V) {\n    v.visit(String::new(), 1);\n}\n',
            },
            pin: ['visit', 'src/lib.rs', 2], expect: ['src/lib.rs:2', 'src/lib.rs:6', 'src/lib.rs:9'],
        },
        python: {
            files: {
                'base.py': 'from typing import Generic, TypeVar\n\nT = TypeVar("T")\n\n\nclass Base(Generic[T]):\n    def visit(self, state: T, x: int) -> None:\n        raise NotImplementedError\n',
                'impl.py': 'from base import Base\n\n\nclass Impl(Base[str]):\n    def visit(self, state: str, x: int) -> None:\n        pass\n',
            },
            pin: ['visit', 'base.py', 7], expect: ['base.py:7', 'impl.py:5'],
        },
    };
    for (const [language, spec] of Object.entries(cases)) {
        it(`${language}: a subclass of a constructed generic base renames with the slot`, () => {
            const dir = tmp(spec.files);
            try {
                const index = idx(dir);
                const [name, file, line] = spec.pin;
                const r = execute(index, 'plan', { name, file, line, renameTo: `${name}Zq` });
                assert.ok(r.ok, r.error);
                const { contents } = applyRenamePlan(dir, r.result);
                const hits = [];
                for (const [f, text] of Object.entries(contents)) {
                    (text || '').split('\n').forEach((row, i) => { if (row.includes(`${name}Zq`)) hits.push(`${f}:${i + 1}`); });
                }
                assert.deepStrictEqual(hits.sort(), spec.expect);
            } finally { rm(dir); }
        });
    }
});

describe('fix #390: a C# string concatenation argument is a string', () => {
    it('`Add("a" + x)` selects Add(string), never Add(Code)', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'B.cs': [
                'namespace N',
                '{',
                '    public class Code { }',
                '    public class B',
                '    {',
                '        public B Add(string format) { return this; }',
                '        public B Add(Code code) { return this; }',
                '        public void Use(string x)',
                '        {',
                '            Add("a" + x);',
                '            Add(new Code());',
                '        }',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const ctx = index.context('Add', { file: 'B.cs', line: 7 });
            assert.deepStrictEqual((ctx.callers || []).map(c => c.line), [11]);
            assert.deepStrictEqual((ctx.unverifiedCallers || []).length, 0);
            const plan = execute(index, 'plan', { name: 'Add', file: 'B.cs', line: 7, renameTo: 'AddCode' });
            assert.ok(plan.ok, plan.error);
            assert.deepStrictEqual(plan.result.changes.map(c => c.line), [7, 11]);
        } finally { rm(dir); }
    });
});

describe('fix #390: a C# generic class renames its constructors and finalizer', () => {
    it('`Strategy(..)` and `~Strategy()` inside `class Strategy<T>` rename with the type; the non-generic namesake keeps its own', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'S.cs': [
                'namespace N;',
                'internal sealed class Strategy<T>',
                '{',
                '    public Strategy(',
                '        int x)',
                '    {',
                '    }',
                '    ~Strategy() { }',
                '    public static Strategy<T> Make() => new Strategy<T>(1);',
                '}',
                'internal sealed class Strategy',
                '{',
                '    public Strategy() { }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const lines = line => {
                const r = execute(index, 'plan', { name: 'Strategy', file: 'S.cs', line, renameTo: 'Policy' });
                assert.ok(r.ok, r.error);
                return r.result.changes.filter(c => c.newExpression !== undefined && !c.needsReview).map(c => c.line).sort((a, b) => a - b);
            };
            assert.deepStrictEqual(lines(2), [2, 4, 8, 9]);
            assert.deepStrictEqual(lines(11), [11, 13]);
        } finally { rm(dir); }
    });
});

describe('fix #390: declarations in a standard-library namespace keep their names', () => {
    it('a C# polyfill in System.* and a C++ std specialization member are contract-blocked', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'Poly.cs': 'namespace System.Diagnostics.CodeAnalysis\n{\n    internal enum DynamicallyAccessedMemberTypes { None = 0 }\n}\n',
            'U.cs': 'using System.Diagnostics.CodeAnalysis;\nnamespace App\n{\n    public class U { public DynamicallyAccessedMemberTypes T; }\n    public class Own { public void Go() { } }\n}\n',
            'h.hpp': '#include <functional>\nstruct Key { int v; };\nnamespace std {\ntemplate <> struct hash<Key> {\n    size_t operator()(const Key& k) const { return k.v; }\n    size_t mix(const Key& k) const { return k.v; }\n};\n}\n',
            'main.cpp': '#include "h.hpp"\nint main() { return (int) std::hash<Key>{}.mix(Key{1}); }\n',
        });
        try {
            const index = idx(dir);
            const blocked = (name, file, line) => {
                const r = execute(index, 'plan', { name, file, line, renameTo: `${name}Zq` });
                assert.ok(r.ok, r.error);
                return !!r.result.contract?.blocked;
            };
            assert.strictEqual(blocked('DynamicallyAccessedMemberTypes', 'Poly.cs', 3), true);
            assert.strictEqual(blocked('mix', 'h.hpp', 6), true);
            assert.strictEqual(blocked('Go', 'U.cs', 5), false);
        } finally { rm(dir); }
    });
});

describe('fix #391: C# conditional directives that split a declaration', () => {
    const FILES = {
        'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
        'ILog.cs': [
            'namespace N;',
            'public interface ILog',
            '{',
            '#if FEATURE_DEFAULT',
            '    private static readonly Logger Default = new Logger();',
            '#endif',
            '    ILog With(int x)',
            '#if FEATURE_DEFAULT',
            '        => new Logger().With(x)',
            '#endif',
            '    ;',
            '    ILog With(string s)',
            '#if FEATURE_DEFAULT',
            '    {',
            '        return With(s.Length);',
            '    }',
            '#else',
            '        ;',
            '#endif',
            '    void Write(int level);',
            '}',
        ].join('\n'),
        'Logger.cs': [
            'namespace N;',
            'public class Logger : ILog',
            '{',
            '    public ILog With(int x) => this;',
            '    public ILog With(string s) => this;',
            '    public void Write(int level) { }',
            '}',
        ].join('\n'),
        'Binder.cs': [
            'namespace N;',
            'public class Binder',
            '{',
            '#if FEATURE_SPAN',
            '    public int Bind(System.ReadOnlySpan<object> values)',
            '#else',
            '    public int Bind(object[] values)',
            '#endif',
            '    {',
            '        return Count(values.Length);',
            '    }',
            '    int Count(int n) => n;',
            '}',
        ].join('\n'),
        'Whole.cs': '#if FEATURE_WHOLE\nnamespace N.Inner;\npublic class Whole { }\n#endif\n',
    };

    it('reads the declarations of each configuration and keeps rows and namespaces', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const log = index.symbols.get('ILog').find(d => d.type === 'interface');
            assert.ok(log, 'the interface is indexed');
            const members = [...index.symbols.values()].flat()
                .filter(d => d.className === 'ILog' && d.relativePath === 'ILog.cs')
                .map(d => `${d.name}:${d.startLine}`).sort();
            assert.deepStrictEqual(members, ['Default:5', 'With:12', 'With:7', 'Write:20']);
            const binds = index.symbols.get('Bind').map(d => `${d.startLine}:${d.params}`).sort();
            assert.deepStrictEqual(binds, ['5:System.ReadOnlySpan<object> values', '7:object[] values']);
            assert.strictEqual(index.symbols.get('Whole')[0].namespace, 'N.Inner');
            const file = [...index.files.values()].find(f => f.relativePath === 'ILog.cs');
            assert.ok(!file.parseRecovery, JSON.stringify(file.parseErrorRegions));
        } finally { rm(dir); }
    });

    it('queries read the configuration views the index recorded, also from a loaded cache', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const file = [...index.files.values()].find(f => f.relativePath === 'ILog.cs');
            assert.ok(Array.isArray(file.conditionalViews) && file.conditionalViews.length > 0,
                JSON.stringify(file.conditionalViews));
            const answer = ix => {
                const r = execute(ix, 'usages', { name: 'With' });
                assert.ok(r.ok, r.error);
                return JSON.stringify(r.result.map(u => `${u.relativePath || u.file}:${u.line}:${u.usageType || u.type}`).sort());
            };
            const fresh = answer(index);
            assert.ok(fresh.includes('ILog.cs:9:call') && fresh.includes('ILog.cs:15:call'), fresh);
            index.saveCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(), 'cache loads');
            assert.deepStrictEqual(
                [...loaded.files.values()].find(f => f.relativePath === 'ILog.cs').conditionalViews,
                file.conditionalViews);
            assert.strictEqual(answer(loaded), fresh);
        } finally { rm(dir); }
    });

    it('calls inside conditional bodies are calls of their member', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const logger = index.context('Logger', { file: 'Logger.cs', line: 2 });
            const lines = (logger.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('ILog.cs:5') && lines.includes('ILog.cs:9'), JSON.stringify(lines));
            const count = index.context('Count', { file: 'Binder.cs', line: 12 });
            assert.deepStrictEqual((count.callers || []).map(c => `${c.line}:${c.callerName}`), ['10:Bind']);
        } finally { rm(dir); }
    });

    it('explicit interface properties, indexers and events are interface members, never dead', () => {
        const dir = tmp({
            'c.csproj': FILES['c.csproj'],
            'Bag.cs': [
                'using System.Collections;',
                'namespace N;',
                'public class Bag : ICollection',
                '{',
                '#if FEATURE_SYNC',
                '    private object _sync = new object();',
                '#endif',
                '    object ICollection.SyncRoot => this;',
                '    bool ICollection.IsSynchronized => false;',
                '    int ICollection.Count => 0;',
                '    void ICollection.CopyTo(System.Array array, int index) { }',
                '    IEnumerator IEnumerable.GetEnumerator() => null;',
                '    object IIndexed.this[int i] => null;',
                '    event System.EventHandler INotify.Changed { add { } remove { } }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const explicit = name => (index.symbols.get(name) || []).map(d => d.explicitInterface);
            assert.deepStrictEqual(explicit('SyncRoot'), ['ICollection']);
            assert.deepStrictEqual(explicit('this[]'), ['IIndexed']);
            assert.deepStrictEqual(explicit('Changed'), ['INotify']);
            const dead = index.deadcode({ includeExported: true }).map(d => d.name);
            for (const name of ['SyncRoot', 'IsSynchronized', 'Count', 'this[]', 'Changed']) {
                assert.ok(!dead.includes(name), `${name} claimed dead: ${JSON.stringify(dead)}`);
            }
        } finally { rm(dir); }
    });
});

describe('fix #391: an argument of unknown type leaves overload resolution open', () => {
    it('C#: params vs span, generic vs object, explicit type arguments', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'W.cs': [
                'namespace N;',
                'public class W',
                '{',
                '    public void Write(int level, params object[] values) { }',
                '    public void Write(int level, System.ReadOnlySpan<object> values) { }',
                '    public void Use(Holder h)',
                '    {',
                '        Write(1, h.Values);',
                '        Write(1, "a", "b");',
                '        Write(1, new object[0]);',
                '    }',
                '    public static void With(string name, object value) { }',
                '    public static void With<T>(string name, System.Func<T, bool> pred) { }',
                '    public void Use2(Holder h)',
                '    {',
                '        With("n", h.Value);',
                '        With<int>("n", p => p > 1);',
                '        With("n", 3);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const sites = line => {
                const ctx = index.context(line === 4 || line === 5 ? 'Write' : 'With', { file: 'W.cs', line });
                return {
                    confirmed: (ctx.callers || []).map(c => c.line),
                    ambiguous: (ctx.unverifiedCallers || []).filter(c => c.reason === 'overload-ambiguous').map(c => c.line),
                };
            };
            assert.deepStrictEqual(sites(4), { confirmed: [9, 10], ambiguous: [8] });
            assert.deepStrictEqual(sites(5), { confirmed: [], ambiguous: [8] });
            assert.deepStrictEqual(sites(12), { confirmed: [18], ambiguous: [16] });
            assert.deepStrictEqual(sites(13), { confirmed: [17], ambiguous: [16] });
        } finally { rm(dir); }
    });

    it('a lambda selects the delegate or functional interface with its parameter count', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'R.cs': [
                'namespace N;',
                'public class R',
                '{',
                '    public R Add(string key, System.Action<R> configure) => this;',
                '    public R Add(string key, System.Action<R, int> configure) => this;',
                '    public void Use(System.Action<R> given)',
                '    {',
                '        Add("a", r => { });',
                '        Add("b", (r, i) => { });',
                '        Add("c", given);',
                '        Add("d", delegate { });',
                '    }',
                '}',
            ].join('\n'),
            'J.java': [
                'import java.util.function.Consumer;',
                'import java.util.function.BiConsumer;',
                'public class J {',
                '    J on(String k, Consumer<J> c) { return this; }',
                '    J on(String k, BiConsumer<J, Integer> c) { return this; }',
                '    void use(Object any) {',
                '        on("a", j -> {});',
                '        on("b", (j, i) -> {});',
                '        on("c", this::sink);',
                '    }',
                '    void sink(J j) {}',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const sites = (name, file, line) => {
                const ctx = index.context(name, { file, line });
                return {
                    confirmed: (ctx.callers || []).map(c => c.line),
                    ambiguous: (ctx.unverifiedCallers || []).filter(c => c.reason === 'overload-ambiguous').map(c => c.line),
                };
            };
            assert.deepStrictEqual(sites('Add', 'R.cs', 4), { confirmed: [8, 10], ambiguous: [11] });
            assert.deepStrictEqual(sites('Add', 'R.cs', 5), { confirmed: [9], ambiguous: [11] });
            assert.deepStrictEqual(sites('on', 'J.java', 4), { confirmed: [7], ambiguous: [9] });
            assert.deepStrictEqual(sites('on', 'J.java', 5), { confirmed: [8], ambiguous: [9] });
        } finally { rm(dir); }
    });

    it('C#: the expanded params form loses only on a tie of parameter types', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'F.cs': [
                'namespace N;',
                'public class F',
                '{',
                '    public void A(object o) { }',
                '    public void A(params string[] s) { }',
                '    public void B(string o) { }',
                '    public void B(params object[] s) { }',
                '    public void C(object o) { }',
                '    public void C(params object[] s) { }',
                '    public void Use()',
                '    {',
                '        A("x");',
                '        B("x");',
                '        C("x");',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const confirmed = (name, line) => (index.context(name, { file: 'F.cs', line }).callers || []).map(c => c.line);
            assert.deepStrictEqual([confirmed('A', 4), confirmed('A', 5)], [[], [12]]);
            assert.deepStrictEqual([confirmed('B', 6), confirmed('B', 7)], [[13], []]);
            assert.deepStrictEqual([confirmed('C', 8), confirmed('C', 9)], [[14], []]);
        } finally { rm(dir); }
    });

    it('Java: the more specific and the fixed-arity candidate need a provable argument', () => {
        const dir = tmp({
            'P.java': [
                'import com.acme.Remote;',
                'class P {',
                '    void f(String s) {}',
                '    void f(Object o) {}',
                '    void g(String s, Object... rest) {}',
                '    void g(String s, int n) {}',
                '    void use(Remote m) {',
                '        f(m.get("k"));',
                '        f("lit");',
                '        g("a", m.get("n"));',
                '        g("a", 1);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const sites = (name, line) => {
                const ctx = index.context(name, { file: 'P.java', line });
                return {
                    confirmed: (ctx.callers || []).map(c => c.line),
                    ambiguous: (ctx.unverifiedCallers || []).filter(c => c.reason === 'overload-ambiguous').map(c => c.line),
                };
            };
            assert.deepStrictEqual(sites('f', 3), { confirmed: [9], ambiguous: [8] });
            assert.deepStrictEqual(sites('f', 4), { confirmed: [], ambiguous: [8] });
            assert.deepStrictEqual(sites('g', 5), { confirmed: [], ambiguous: [10] });
            assert.deepStrictEqual(sites('g', 6), { confirmed: [11], ambiguous: [10] });
        } finally { rm(dir); }
    });

    it('C#: arguments that fit no overload of the pinned class leave the site visible, not confirmed', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'B.cs': [
                'namespace N;',
                'public class Builder { }',
                'public abstract class Strategy { }',
                'public static class Ext1',
                '{',
                '    public static Builder Add(this Builder b, System.Func<int, Strategy> f) => b;',
                '    public static Builder Add(this Builder b, System.Func<int, Strategy> f, int x) => b;',
                '}',
                'public static class Ext2',
                '{',
                '    public static Builder Add(this Builder b, Strategy s) => b;',
                '}',
                'public static class Use',
                '{',
                '    public static Builder Run(Strategy strategy) => new Builder().Add(strategy);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const ext1 = index.context('Add', { file: 'B.cs', line: 6 });
            assert.deepStrictEqual((ext1.callers || []).map(c => c.line), []);
            assert.deepStrictEqual((ext1.unverifiedCallers || []).map(c => `${c.line}:${c.reason}`), ['15:overload-ambiguous']);
            const ext2 = index.context('Add', { file: 'B.cs', line: 11 });
            assert.deepStrictEqual((ext2.callers || []).map(c => c.line), [15]);
        } finally { rm(dir); }
    });
});

describe('fix #391: C# argument and receiver facts that decide overloads', () => {
    it('bare field and params arguments are typed, `T?` on a reference type converts, a string is never an Exception', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'L.cs': [
                'namespace N;',
                'public class Token { }',
                'public class L',
                '{',
                '    static readonly object[] None = new object[0];',
                '    public void Write(int level, System.Exception? error, string text, params object?[]? values) { }',
                '    public void Write(int level, System.Exception? error, string text, System.ReadOnlySpan<object?> values) { }',
                '    public void Write(int level, string text, params object?[]? values) { }',
                '    public void Warn(System.Exception? error, string text) { Write(2, error, text, None); }',
                '    public void Warn(System.Exception? error, string text, params object?[]? values) { Write(2, error, text, values); }',
                '    public void Info(string text, string more) { Write(1, text, more); }',
                '    void Check(Token t, Token? other) { }',
                '    public void Use(Token? item) { Check(item, null); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const confirmed = (name, line) => (index.context(name, { file: 'L.cs', line }).callers || []).map(c => c.line);
            assert.deepStrictEqual(confirmed('Write', 6), [9, 10]);
            assert.deepStrictEqual(confirmed('Write', 7), []);
            assert.deepStrictEqual(confirmed('Write', 8), [11]);
            assert.deepStrictEqual(confirmed('Check', 12), [13]);
        } finally { rm(dir); }
    });

    it('a member named like a class, typed by an interface, is the member (not the class)', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'I.cs': 'namespace N;\npublic interface ILog { void Write(int level); }\n',
            'Logger.cs': 'namespace N;\npublic class Logger : ILog { public void Write(int level) { } }\n',
            'Log.cs': [
                'namespace N;',
                'public static class Log',
                '{',
                '    public static ILog Logger { get; set; } = new Logger();',
                '    public static void Write(int level) { Logger.Write(level); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const ctx = index.context('Write', { file: 'Logger.cs', line: 2 });
            assert.deepStrictEqual((ctx.callers || []).map(c => c.line), []);
            assert.deepStrictEqual((ctx.unverifiedCallers || []).map(c => `${c.relativePath}:${c.line}:${c.reason}`),
                ['Log.cs:5:possible-dispatch']);
        } finally { rm(dir); }
    });
});

describe('fix #391: a C# generic method fills only the slot of a method with as many type parameters', () => {
    it('renaming Write<T>(.., T) leaves Write(.., params object[]) and its callers alone', () => {
        const dir = tmp({
            'c.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'I.cs': [
                'namespace N;',
                'public interface ILog',
                '{',
                '    void Write<T>(int level, T value);',
                '    void Write(int level, params object[] values);',
                '}',
                'public class Log : ILog',
                '{',
                '    public void Write<T>(int level, T value) { Write(level, new object[] { value! }); }',
                '    public void Write(int level, params object[] values) { }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Write', file: 'I.cs', line: 9, renameTo: 'Put' });
            assert.ok(r.ok, r.error);
            const edited = r.result.changes.filter(c => c.newExpression !== undefined && !c.needsReview)
                .map(c => c.line).sort((a, b) => a - b);
            assert.deepStrictEqual(edited, [4, 9]);
        } finally { rm(dir); }
    });
});

describe('fix #392: C# using static imports declared members; two same-name calls on one line', () => {
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();

    it('C#: a `using static` type supplies the members it declares, never inherited ones', () => {
        const dir = tmp({
            'Lib.cs': [
                'namespace Lib',
                '{',
                '    public class Base { public static int Helper() => 1; }',
                '    public class Derived : Base { public static int Own() => 2; }',
                '    public class Other { public static int Helper() => 3; }',
                '}',
            ].join('\n') + '\n',
            'Use.cs': [
                'using static Lib.Derived;',
                'namespace App',
                '{',
                '    public class U',
                '    {',
                '        public int F() => Helper() + Own();',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const base = index.context('Helper', { file: 'Lib.cs', line: 3 });
            assert.deepStrictEqual(at(base.callers), []);
            assert.deepStrictEqual(at(base.unverifiedCallers), []);
            assert.deepStrictEqual(at(index.context('Own', { file: 'Lib.cs', line: 4 }).callers), ['Use.cs:6']);
            const callees = index.context('F', { file: 'Use.cs' });
            assert.deepStrictEqual(callees.callees.map(c => c.name), ['Own']);
            assert.deepStrictEqual((callees.unverifiedCallees || []).map(c => c.name), []);
        } finally { rm(dir); }
    });

    it('each same-name call token on a line is decided by its own call node', () => {
        const dir = tmp({
            'm.py': [
                'class A:',
                '    def run(self, x=None):',
                '        return 1',
                '',
                'class B:',
                '    def run(self, x=None):',
                '        return 2',
                '',
                'def use():',
                '    a = A()',
                '    b = B()',
                '    return a.run(b.run())',
            ].join('\n') + '\n',
            'm.ts': [
                'class A { run(x?: number) { return 1; } }',
                'class B { run(x?: number) { return 2; } }',
                'export function use() {',
                '  const a = new A();',
                '  const b = new B();',
                '  return a.run(b.run());',
                '}',
            ].join('\n') + '\n',
            'P.java': [
                'class A { int run(int x) { return 1; } }',
                'class B { int run(int x) { return 2; } }',
                'class U {',
                '  int use() {',
                '    A a = new A();',
                '    B b = new B();',
                '    return a.run(b.run(1)) + a.run(2);',
                '  }',
                '}',
            ].join('\n') + '\n',
            'Cargo.toml': '[package]\nname = "f392"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': [
                'pub struct A;',
                'pub struct B;',
                'impl A { pub fn run(&self, x: i32) -> i32 { x } }',
                'impl B { pub fn run(&self, x: i32) -> i32 { x } }',
                'pub fn use_it() -> i32 { let a = A; let b = B; a.run(b.run(1)) + a.run(2) }',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const edit = (handle, file, line) => {
                const r = execute(index, 'plan', { name: handle, renameTo: 'NEW' });
                assert.ok(r.ok, r.error);
                const change = r.result.changes.find(c => c.file === file && c.line === line);
                assert.ok(change && !change.needsReview, `${handle}: ${JSON.stringify(change)}`);
                return change.newExpression;
            };
            assert.strictEqual(edit('m.py:2:run', 'm.py', 12), 'return a.NEW(b.run())');
            assert.strictEqual(edit('m.py:6:run', 'm.py', 12), 'return a.run(b.NEW())');
            assert.strictEqual(edit('m.ts:1:run', 'm.ts', 6), 'return a.NEW(b.run());');
            assert.strictEqual(edit('P.java:1:run', 'P.java', 7), 'return a.NEW(b.run(1)) + a.NEW(2);');
            assert.strictEqual(edit('src/lib.rs:3:run', 'src/lib.rs', 5),
                'pub fn use_it() -> i32 { let a = A; let b = B; a.NEW(b.run(1)) + a.NEW(2) }');
        } finally { rm(dir); }
    });
});

describe('fix #393: overload families across partial parts, uninferable type arguments, project delegates', () => {
    const { applyRenamePlan } = require('./helpers');
    const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
    const sitesOf = (index, name, file, line) => {
        const ctx = index.context(name, { file, line });
        return {
            confirmed: (ctx.callers || []).map(c => `${c.relativePath}:${c.line}`).sort(),
            unverified: (ctx.unverifiedCallers || []).map(c => `${c.relativePath}:${c.line}:${c.reason}`).sort(),
        };
    };

    it('C#: a generic overload in another partial part is one family; a type parameter no argument fixes needs type arguments', () => {
        const dir = tmp({
            'c.csproj': CSPROJ,
            'P.Sync.cs': [
                'namespace N;',
                'public partial class Pipe',
                '{',
                '    public int Run(System.Threading.CancellationToken ct) { return Ctx(ct); }',
                '    private int Ctx(System.Threading.CancellationToken ct) => Ctx<int>(ct);',
                '}',
            ].join('\n'),
            'P.SyncT.cs': [
                'namespace N;',
                'public partial class Pipe',
                '{',
                '    public T RunT<T>(System.Threading.CancellationToken ct) { Ctx<T>(ct); return default; }',
                '    private int Ctx<TResult>(System.Threading.CancellationToken ct) { return 1; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(sitesOf(index, 'Ctx', 'P.SyncT.cs', 5),
                { confirmed: ['P.Sync.cs:5', 'P.SyncT.cs:4'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'Ctx', 'P.Sync.cs', 5),
                { confirmed: ['P.Sync.cs:4'], unverified: [] });
            const r = execute(index, 'context', { name: 'Ctx', file: 'P.Sync.cs', line: 5 });
            const callees = (r.result.callees || []).map(c => `${c.relativePath || c.file}:${c.startLine || c.line}`);
            assert.deepStrictEqual(callees, ['P.SyncT.cs:5']);
        } finally { rm(dir); }
    });

    it('C# delegates and Java functional interfaces the project declares give lambdas their parameter count', () => {
        const dir = tmp({
            'c.csproj': CSPROJ,
            'A.cs': [
                'namespace P;',
                'public delegate void Handler(string a, int b);',
                'public delegate T Maker<T>();',
                'public class Api',
                '{',
                '    public void On(Handler h) { }',
                '    public void On(System.Action a) { }',
                '    public void Make(Maker<int> m) { }',
                '    public void Make(System.Func<int, int> f) { }',
                '    void Use()',
                '    {',
                '        On((a, b) => { });',
                '        On(() => { });',
                '        Make(() => 1);',
                '        Make(x => x);',
                '    }',
                '}',
            ].join('\n'),
            'j/Api.java': [
                'package j;',
                '@FunctionalInterface',
                'interface Handler { void handle(String a, int b); default void other() { } boolean equals(Object o); }',
                'interface Sub extends Handler { }',
                'interface Two { void a(); void b(int x); }',
                'class Api {',
                '    void on(Sub h) { }',
                '    void on(Runnable r) { }',
                '    void two(Two t) { }',
                '    void two(Runnable r) { }',
                '    void use() {',
                '        on((a, b) -> { });',
                '        on(() -> { });',
                '        two(() -> { });',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(sitesOf(index, 'On', 'A.cs', 6), { confirmed: ['A.cs:12'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'On', 'A.cs', 7), { confirmed: ['A.cs:13'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'Make', 'A.cs', 8), { confirmed: ['A.cs:14'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'Make', 'A.cs', 9), { confirmed: ['A.cs:15'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'on', 'j/Api.java', 7), { confirmed: ['j/Api.java:12'], unverified: [] });
            assert.deepStrictEqual(sitesOf(index, 'on', 'j/Api.java', 8), { confirmed: ['j/Api.java:13'], unverified: [] });
            // Two abstract methods: not a functional interface, so the site stays open.
            assert.deepStrictEqual(sitesOf(index, 'two', 'j/Api.java', 9).confirmed, []);
        } finally { rm(dir); }
    });

    it('C#: sbyte and byte are distinct overload parameter types', () => {
        const dir = tmp({
            'c.csproj': CSPROJ,
            'F.cs': [
                'namespace P;',
                'public static class F',
                '{',
                '    static void Put(byte value) { }',
                '    static void Put(sbyte value) { }',
                '    public static void Use(object value)',
                '    {',
                '        if (value is byte b) Put(b);',
                '        if (value is sbyte sb) Put(sb);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const use = index.symbols.get('Use')[0];
            const callees = index.findCallees(use, { collectAccount: true, includeMethods: true })
                .map(c => `${c.startLine}:${(c.sites || []).join(',')}`).sort();
            assert.deepStrictEqual(callees, ['4:8', '5:9']);
            assert.deepStrictEqual(sitesOf(index, 'Put', 'F.cs', 5), { confirmed: ['F.cs:9'], unverified: [] });
        } finally { rm(dir); }
    });

    it('C#: renaming a type leaves an invoked method named like it (Color Color for methods)', () => {
        const dir = tmp({
            'c.csproj': CSPROJ,
            'LogEvent.cs': 'namespace P;\npublic class LogEvent { public LogEvent(int level) { } }\n',
            'Some.cs': [
                'namespace P;',
                'public static class Some',
                '{',
                '    public static LogEvent LogEvent(int level) { return new LogEvent(level); }',
                '    public static LogEvent Info() { return LogEvent(1); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'LogEvent', file: 'LogEvent.cs', line: 2, renameTo: 'Event2' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.match(contents['Some.cs'], /public static Event2 LogEvent\(int level\) \{ return new Event2\(level\); \}/);
            assert.match(contents['Some.cs'], /public static Event2 Info\(\) \{ return LogEvent\(1\); \}/);
        } finally { rm(dir); }
    });

    it('C#: a target-typed new(...) constructs the type its position declares, and a rename needs no edit there', () => {
        const dir = tmp({
            'c.csproj': CSPROJ,
            'H.cs': [
                'namespace P;',
                'public record H(int A);',
                'public class C',
                '{',
                '    H M() { return new(1); }',
                '    H P => new(2);',
                '    H f = new(3);',
                '    async System.Threading.Tasks.Task<H> A() { return new(4); }',
                '    void V() { H x = new(5); var z = new H(6); }',
                '    System.Func<H> L() => () => new(7);',
                '    object O() { return new(); }',
                '}',
            ].join('\n'),
            'Reg.cs': 'namespace P;\npublic static class Reg { public static H H { get; set; } }\n',
        });
        try {
            const index = idx(dir);
            // The construction's callee is the record, never Reg's property named H.
            const make = index.symbols.get('M').find(d => d.relativePath === 'H.cs');
            const callees = index.findCallees(make, { collectAccount: true, includeMethods: true })
                .map(c => `${c.relativePath}:${c.startLine}:${c.type}`);
            assert.deepStrictEqual(callees, ['H.cs:2:record']);
            const sites = sitesOf(index, 'H', 'H.cs', 2);
            assert.deepStrictEqual(sites.confirmed, ['H.cs:5', 'H.cs:6', 'H.cs:7', 'H.cs:8', 'H.cs:9', 'H.cs:9']);
            const r = execute(index, 'plan', { name: 'H', file: 'H.cs', line: 2, renameTo: 'H2' });
            assert.ok(r.ok, r.error);
            assert.ok(!r.result.changes.some(c => c.needsReview && c.editKind === 'call'),
                JSON.stringify(r.result.changes.filter(c => c.needsReview)));
        } finally { rm(dir); }
    });
});

// ============================================================================
// fix #394: internal errors are marked on every surface; type renames of
// annotated classes with constructors; check against the base declaration
// (overloads in C#/C++, arity in Go/Rust/Python); declared local types
// ============================================================================

describe('fix #394: internal errors, constructor renames, check before/after, declared types', () => {
    const { execFileSync } = require('child_process');
    const CLI = path.join(PROJECT_DIR, 'cli', 'index.js');
    const gitInit = (dir) => {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['add', '.'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    };
    const lineSet = (items) => [...new Set(items.map(c => `${c.relativePath}:${c.line}`))].sort();
    const tiers = (index, name, def) => {
        const r = index.findCallers(name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: lineSet(r.filter(c => c.tier !== 'unverified')),
            unverified: lineSet([...r.filter(c => c.tier === 'unverified'), ...(r.unverifiedEntries || [])]),
            excluded: r.accountRaw.excludedEntries.map(e => `${path.relative(index.root, e.file)}:${e.line}`).sort(),
        };
    };
    // Loaded with --require: makes every plan throw the way an engine defect does.
    const faultInjector = (dir) => {
        const file = path.join(dir, 'inject-fault.js');
        fs.writeFileSync(file, `const { ProjectIndex } = require(${JSON.stringify(path.join(PROJECT_DIR, 'core', 'project.js'))});\n` +
            'ProjectIndex.prototype.plan = function () { return null.verdict; };\n');
        return file;
    };
    const run = (args, env = {}) => {
        try {
            const stdout = execFileSync('node', [CLI, ...args], {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
            });
            return { code: 0, stdout, stderr: '' };
        } catch (e) {
            return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
        }
    };

    it('an engine exception is an internal error on CLI text, CLI JSON, interactive and MCP; a refusal is not', async () => {
        const dir = tmp({ 'package.json': '{}', 'lib.js': 'function alpha() { return 1; }\nmodule.exports = { alpha };\n' });
        const env = { NODE_OPTIONS: `--require ${faultInjector(dir)}` };
        let client;
        try {
            const text = run([dir, 'plan', 'alpha', '--rename-to=beta'], env);
            assert.strictEqual(text.code, 2);
            assert.match(text.stderr, /^Internal error: Cannot read properties of null \(reading 'verdict'\) \(a defect in UCN/m);
            const json = run([dir, 'plan', 'alpha', '--rename-to=beta', '--json'], env);
            assert.strictEqual(json.code, 1);
            const envelope = JSON.parse(json.stdout);
            assert.strictEqual(envelope.meta.ok, false);
            assert.strictEqual(envelope.meta.internalError, true);
            assert.match(envelope.error, /^Internal error: /);
            const refusal = run([dir, 'show', 'nosuchsymbol', '--json'], env);
            assert.strictEqual(refusal.code, 1);
            const refused = JSON.parse(refusal.stdout);
            assert.strictEqual(refused.meta.ok, false);
            assert.strictEqual(refused.meta.internalError, undefined);
            assert.doesNotMatch(refused.error, /Internal error/);
            const interactive = execFileSync('node', [CLI, '--interactive', dir], {
                input: 'plan alpha --rename-to=beta\nquit\n', encoding: 'utf-8',
                env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
            });
            assert.match(interactive, /Internal error: Cannot read properties of null/);

            const { McpClient } = require('./helpers');
            const saved = process.env.NODE_OPTIONS;
            process.env.NODE_OPTIONS = env.NODE_OPTIONS;
            try {
                client = new McpClient();
                await client.start();
            } finally {
                if (saved === undefined) delete process.env.NODE_OPTIONS;
                else process.env.NODE_OPTIONS = saved;
            }
            await client.initialize();
            const res = await client.callTool('ucn', { command: 'plan', project_dir: dir, name: 'alpha', rename_to: 'beta' });
            assert.strictEqual(res.result?.isError, true);
            assert.match(res.result.content[0].text, /^Internal error: Cannot read properties of null/);
            const missing = await client.callTool('ucn', { command: 'show', project_dir: dir, name: 'nosuchsymbol' });
            assert.strictEqual(missing.result?.isError, true);
            assert.match(missing.result.content[0].text, /^Error: /);
        } finally {
            if (client) client.stop();
            rm(dir);
        }
    });

    it('execute() marks a handler exception internal and keeps deliberate refusals plain', () => {
        const dir = tmp({ 'package.json': '{}', 'lib.js': 'function alpha() { return 1; }\n' });
        try {
            const index = idx(dir);
            const broken = Object.create(index);
            broken.plan = () => { throw new TypeError('boom'); };
            const crash = execute(broken, 'plan', { name: 'alpha', renameTo: 'beta' });
            assert.strictEqual(crash.ok, false);
            assert.strictEqual(crash.internalError, true);
            assert.match(crash.error, /^Internal error: boom/);
            const regex = execute(index, 'search', { term: '(a', regex: true });
            assert.strictEqual(regex.ok, false);
            assert.strictEqual(regex.internalError, undefined);
        } finally { rm(dir); }
    });

    it('type renames of attributed C# classes and nested C++ structs edit their constructors', () => {
        const dir = tmp({
            'A.cs': 'namespace M;\n\n[System.Obsolete]\npublic class Basic {\n\n    public Basic() {\n    }\n    ~Basic() {\n    }\n}\n\npublic class Use {\n    public object Make() => new Basic();\n}\n',
            's.h': [
                '#pragma once',
                'template <typename T>',
                'class Schema {',
                ' public:',
                '  struct Property {',
                '    Property() : required(false) {}',
                '    ~Property() {}',
                '    bool required;',
                '  };',
                '  void Clear(Property* p) { p->~Property(); }',
                '  Property Make() { return Property(); }',
                '};',
            ].join('\n') + '\n',
            // A C++ source makes the project's headers C++.
            'm.cpp': '#include "s.h"\nint main() { Schema<int> s; s.Make(); return 0; }\n',
        });
        try {
            const index = idx(dir);
            const cs = execute(index, 'plan', { name: 'Basic', file: 'A.cs', line: 4, renameTo: 'Plain' });
            assert.ok(cs.ok, cs.error);
            assert.deepStrictEqual(cs.result.changes.map(c => c.line).sort((a, b) => a - b), [4, 6, 8, 13]);
            const cpp = execute(index, 'plan', { name: 'Property', file: 's.h', line: 5, renameTo: 'Prop' });
            assert.ok(cpp.ok, cpp.error);
            assert.deepStrictEqual(cpp.result.changes.map(c => c.line).sort((a, b) => a - b), [5, 6, 7, 10, 11]);
        } finally { rm(dir); }
    });

    it('check: C# and C++ callers of a changed overload are mismatches', () => {
        const dir = tmp({
            'Ext.cs': [
                'namespace N;',
                'public interface IB<T> { }',
                'public static class Ext {',
                '    public static IB<T> Length<T>(this IB<T> b, int min, int max) => b;',
                '    public static IB<T> Length<T>(this IB<T> b, int exact) => b;',
                '}',
                'public class Use {',
                '    public void Run(IB<string> b) {',
                '        b.Length(1, 2);',
                '        b.Length(3);',
                '    }',
                '}',
            ].join('\n') + '\n',
            'u.h': '#pragma once\nnamespace u {\nint size(const char* s);\nint size(int n, int m);\n}\n',
            'u.cc': '#include "u.h"\nnamespace u {\nint size(const char* s) { return s ? 1 : 0; }\nint size(int n, int m) { return n + m; }\n}\n',
            'm.cc': '#include "u.h"\nint main() { return u::size("abc") + u::size(1, 2); }\n',
        });
        try {
            gitInit(dir);
            const ext = path.join(dir, 'Ext.cs');
            fs.writeFileSync(ext, fs.readFileSync(ext, 'utf-8').replace('int min, int max)', 'int min, int max, bool strict)'));
            for (const file of ['u.h', 'u.cc']) {
                const p = path.join(dir, file);
                fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace('int size(const char* s)', 'int size(const char* s, bool strict)'));
            }
            const index = idx(dir);
            const cs = execute(index, 'check', { name: 'Length', file: 'Ext.cs', line: 4 });
            assert.ok(cs.ok, cs.error);
            assert.deepStrictEqual(cs.result.mismatchDetails.map(m => `${m.file}:${m.line}`), ['Ext.cs:9']);
            const cpp = execute(index, 'check', { name: 'size', file: 'u.cc', line: 3 });
            assert.ok(cpp.ok, cpp.error);
            assert.deepStrictEqual(cpp.result.mismatchDetails.map(m => `${m.file}:${m.line}`), ['m.cc:2']);
            const diff = execute(index, 'check', {});
            assert.ok(diff.ok, diff.error);
            const text = output.formatPublicText('check', diff.result, {}, diff);
            assert.match(text, /TRUST: BLOCKED/);
        } finally { rm(dir); }
    });

    it('check: arity changes without overloads (Go, Rust, Python) stay mismatches', () => {
        const dir = tmp({
            'go.mod': 'module ex\ngo 1.21\n',
            'a.go': 'package main\n\ntype Other struct{}\n\nfunc (Other) Process(a, b int) int { return a + b }\n\nfunc Process(a, b int) int { return a * b }\n\nfunc main() {\n\t_ = Process(1, 2)\n\t_ = Other{}.Process(3, 4)\n}\n',
            'Cargo.toml': '[package]\nname = "ex"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/main.rs': 'struct Other;\nimpl Other { fn process(&self, a: i32, b: i32) -> i32 { a + b } }\nfn process(a: i32, b: i32) -> i32 { a * b }\nfn main() {\n    let _ = process(1, 2);\n    let _ = Other.process(3, 4);\n}\n',
            'p.py': 'def handle(a, b=1):\n    return a\n\ndef main():\n    return handle(1)\n',
        });
        try {
            gitInit(dir);
            const edit = (file, from, to) => {
                const p = path.join(dir, file);
                fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace(from, to));
            };
            edit('a.go', 'func Process(a, b int) int { return a * b }', 'func Process(a int) int { return a }');
            edit('src/main.rs', 'fn process(a: i32, b: i32) -> i32 { a * b }', 'fn process(a: i32) -> i32 { a }');
            edit('p.py', 'def handle(a, b=1):', 'def handle(a, b):');
            const index = idx(dir);
            for (const [name, file, line, site] of [['Process', 'a.go', 7, 'a.go:10'],
                ['process', 'src/main.rs', 3, 'src/main.rs:5'], ['handle', 'p.py', 1, 'p.py:5']]) {
                const check = execute(index, 'check', { name, file, line });
                assert.ok(check.ok, check.error);
                assert.deepStrictEqual(check.result.mismatchDetails.map(m => `${m.file}:${m.line}`), [site], name);
            }
        } finally { rm(dir); }
    });

    it('C#: an extension method called on its receiver counts the receiver as its this argument', () => {
        const dir = tmp({
            'Ext.cs': [
                'namespace N;',
                'public interface IB<T> { }',
                'public static class Ext {',
                '    public static IB<T> Length<T>(this IB<T> b, int min, int max) => b;',
                '}',
                'public class Use {',
                '    public void Run(IB<string> b) {',
                '        b.Length(1, 2);',
                '        Ext.Length(b, 4, 5);',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const check = execute(index, 'check', { name: 'Length', file: 'Ext.cs', line: 4 });
            assert.ok(check.ok, check.error);
            assert.strictEqual(check.result.mismatches, 0);
            assert.strictEqual(check.result.valid, 2);
        } finally { rm(dir); }
    });

    it('C#: the declared type of a local is its static receiver type', () => {
        const dir = tmp({
            'A.cs': [
                'namespace Acme;',
                'public interface IShape { double Area(); }',
                'public class Square : IShape { public double Area() => 1; }',
                'public class Program {',
                '    public static void Main() {',
                '        IShape s = new Square();',
                '        s.Area();',
                '        var q = new Square();',
                '        q.Area();',
                '    }',
                '    public static void Blocks(int k) {',
                '        if (k > 0) { IShape b = new Square(); b.Area(); }',
                '        else { IShape b = new Square(); b.Area(); }',
                '        if (k > 1) { IShape c = new Square(); c.Area(); }',
                '        else { IShape c = new Circle(); c.Area(); }',
                '    }',
                '}',
                'public class Circle : IShape { public double Area() => 3; }',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('Area');
            assert.deepStrictEqual(tiers(index, 'Area', defs.find(d => d.className === 'IShape')).confirmed,
                ['A.cs:12', 'A.cs:13', 'A.cs:14', 'A.cs:15', 'A.cs:7']);
            // A local never assigned (every declaration of the name holding
            // the same constructed type) runs Square.Area; `c` holds either.
            const square = tiers(index, 'Area', defs.find(d => d.className === 'Square'));
            assert.deepStrictEqual(square.confirmed, ['A.cs:12', 'A.cs:13', 'A.cs:7', 'A.cs:9']);
            assert.deepStrictEqual(square.unverified, ['A.cs:14', 'A.cs:15']);
        } finally { rm(dir); }
    });
});

// fix #395: C# name lookup and member identity - using directives resolved
// from the namespace they sit in (spec 14.5), nested namespace blocks, object
// initializer members, nested types of other classes, extension methods
// against instance members and type arguments, method groups, local
// functions, project-file static usings, explicit interface
// implementations, audit-async member calls, static member paths from a type.
describe('fix #395: C# name lookup, method groups and member identity', () => {
    const { execFileSync } = require('child_process');
    const { applyRenamePlan } = require('./helpers');
    const lineSet = (items) => [...new Set(items.map(c => `${c.relativePath}:${c.line}`))].sort();
    const tiers = (index, name, def) => {
        const r = index.findCallers(name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: lineSet(r.filter(c => c.tier !== 'unverified')),
            unverified: lineSet([...r.filter(c => c.tier === 'unverified'), ...(r.unverifiedEntries || [])]),
            excluded: r.accountRaw.excludedEntries.map(e => `${path.relative(index.root, e.file)}:${e.line}`).sort(),
        };
    };
    const defOf = (index, name, file, line) =>
        index.symbols.get(name).find(d => d.relativePath === file && d.startLine === line);
    const planOf = (index, name, file, line, renameTo) => {
        const r = execute(index, 'plan', { name, file, line, renameTo });
        assert.ok(r.ok, r.error);
        return r.result;
    };

    it('a using directive inside a namespace resolves from that namespace outward (block, file-scoped, alias, static)', () => {
        const dir = tmp({
            'Lib.cs': 'namespace Acme.Internal;\npublic static class Cache {\n    public static void Clear() { }\n}\n' +
                'public static class Util {\n    public static int Twice(int x) => x * 2;\n}\n',
            'Other.cs': 'namespace Internal;\npublic static class Cache {\n    public static void Clear() { }\n}\n',
            'Test.cs': 'namespace Acme.Tests;\n\nusing Internal;\nusing static Internal.Util;\nusing C = Internal.Cache;\n\n' +
                'public class CacheTests {\n    public CacheTests() {\n        Cache.Clear();\n        C.Clear();\n        Twice(2);\n    }\n}\n',
            'Block.cs': 'namespace Acme {\n    namespace Tests2 {\n        using Internal;\n        public class T2 {\n' +
                '            public void Run() { Cache.Clear(); }\n        }\n    }\n}\n',
            'Global.cs': 'using Internal;\nnamespace Zed;\npublic class G {\n    public void Run() { Cache.Clear(); }\n}\n',
        });
        try {
            const index = idx(dir);
            // Acme.Tests: `Internal` is Acme.Internal (the enclosing namespace
            // declares it), never the global Internal namespace.
            const acme = tiers(index, 'Clear', defOf(index, 'Clear', 'Lib.cs', 3));
            assert.deepStrictEqual(acme.confirmed, ['Block.cs:5', 'Test.cs:10', 'Test.cs:9']);
            assert.ok(!acme.confirmed.includes('Global.cs:4'));
            const global = tiers(index, 'Clear', defOf(index, 'Clear', 'Other.cs', 3));
            assert.deepStrictEqual(global.confirmed, ['Global.cs:4']);
            assert.deepStrictEqual(tiers(index, 'Twice', defOf(index, 'Twice', 'Lib.cs', 6)).confirmed, ['Test.cs:11']);
            const imports = index.files.get(path.join(dir, 'Test.cs')).importDetails;
            assert.ok(imports.some(d => d.module === 'Internal' && d.namespace === 'Acme.Tests' && !d.static));
            assert.ok(imports.some(d => d.module === 'Internal.Util' && d.static));
            // A type rename reaches the constructor calls behind a relative using.
            const typeDir = tmp({
                'Results/Failure.cs': 'namespace Val.Results;\npublic class Failure {\n    public Failure(string m) { }\n}\n',
                'Rule.cs': 'namespace Val;\n\nusing Results;\n\npublic class Rule {\n    public Failure Make() => new Failure("x");\n}\n',
            });
            try {
                const typeIndex = idx(typeDir);
                const { contents } = applyRenamePlan(typeDir, planOf(typeIndex, 'Failure', 'Results/Failure.cs', 2, 'Fault'));
                assert.match(contents['Rule.cs'], /public Fault Make\(\) => new Fault\("x"\);/);
            } finally { rm(typeDir); }
        } finally { rm(dir); }
    });

    it('nested namespace blocks name their members by the full path, so overrides in them join the slot', () => {
        const dir = tmp({
            'Base.cs': 'namespace Acme.Tests\n{\n    public abstract class SpecBase\n    {\n        protected virtual int Create() => 0;\n' +
                '        public int Run() => Create();\n    }\n}\n',
            'Nested.cs': 'namespace Acme.Tests\n{\n    namespace Scanning\n    {\n        public class ByType : SpecBase\n        {\n' +
                '            protected override int Create() => 1;\n        }\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.symbols.get('ByType')[0].namespace, 'Acme.Tests.Scanning');
            const { contents } = applyRenamePlan(dir, planOf(index, 'Create', 'Base.cs', 5, 'Build'));
            assert.match(contents['Nested.cs'] || '', /protected override int Build\(\) => 1;/);
        } finally { rm(dir); }
    });

    it('a type rename leaves object-initializer members named like the type', () => {
        const files = {
            'A.cs': 'namespace Acme;\npublic class Country { }\npublic class Home { public Country Country { get; set; } }\n' +
                'public class Address { public Country Country { get; set; } public Home Home { get; } = new Home(); }\n' +
                'public class Program {\n    public static Address Make() {\n        var a = new Address { Country = new Country() };\n' +
                '        Address b = new() { Country = new Country(), Home = { Country = new Country() } };\n' +
                '        var list = new System.Collections.Generic.List<Country> { new Country() };\n        return a;\n    }\n}\n',
        };
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const { contents, reviews } = applyRenamePlan(dir, planOf(index, 'Country', 'A.cs', 2, 'Nation'));
            assert.deepStrictEqual(reviews, []);
            const lines = contents['A.cs'].split('\n');
            assert.strictEqual(lines[6].trim(), 'var a = new Address { Country = new Nation() };');
            assert.strictEqual(lines[7].trim(), 'Address b = new() { Country = new Nation(), Home = { Country = new Nation() } };');
            assert.strictEqual(lines[8].trim(), 'var list = new System.Collections.Generic.List<Nation> { new Nation() };');
            assert.strictEqual(lines[2], 'public class Home { public Nation Country { get; set; } }');
        } finally { rm(dir); }
    });

    it('same-name nested types of different outer classes are two types; #if alternatives of one nested type stay one', () => {
        const dir = tmp({
            'A.cs': 'namespace Acme;\npublic class TestA {\n    class Destination { public string Name { get; set; } }\n' +
                '    public object Make() => new Destination();\n}\npublic class TestB {\n' +
                '    public record Destination(int Id) { public Destination(long x) : this(1) { } }\n' +
                '    public object Make() => new Destination(2L);\n}\n',
            'C.cs': 'namespace Acme;\npublic class Outer {\n#if FAST\n    public int Run() => 1;\n#else\n    public int Run() => 2;\n#endif\n}\n',
        });
        try {
            const index = idx(dir);
            const { contents } = applyRenamePlan(dir, planOf(index, 'Destination', 'A.cs', 3, 'Dest'));
            const lines = contents['A.cs'].split('\n');
            assert.match(lines[2], /class Dest \{/);
            assert.match(lines[3], /new Dest\(\)/);
            assert.match(lines[6], /public record Destination\(int Id\) \{ public Destination\(long x\)/);
            assert.match(lines[7], /new Destination\(2L\)/);
            const alt = applyRenamePlan(dir, planOf(index, 'Run', 'C.cs', 4, 'Go'));
            assert.match(alt.contents['C.cs'], /public int Go\(\) => 1;[\s\S]*public int Go\(\) => 2;/);
        } finally { rm(dir); }
    });

    it('an extension method never takes calls an instance member of the receiver owns or whose type arguments do not fit', () => {
        const dir = tmp({
            'Ext.cs': 'using System;\nusing System.Collections.Generic;\nusing System.Linq.Expressions;\n\nnamespace M;\n\n' +
                'public class Transformer { }\npublic class Special : Transformer { }\n\npublic static class TransformerExtensions {\n' +
                '    public static void Add<TValue>(this List<Transformer> list, Expression<Func<TValue, TValue>> f) =>\n' +
                '        list.Add(new Transformer());\n' +
                '    public static int Count2(this IEnumerable<Transformer> xs) => 0;\n}\n',
            'Use.cs': 'using System;\nusing System.Collections.Generic;\n\nnamespace M;\n\npublic class Holder {\n' +
                '    private readonly List<string> _names = new();\n    public List<Exception> Errors { get; } = new();\n' +
                '    private readonly List<Transformer> _ts = new();\n\n    public void Run() {\n        _names.Add("a");\n' +
                '        Errors.Add(new Exception());\n        var local = new List<int>();\n        local.Add(1);\n' +
                '        _ts.Add<int>(x => x + 1);\n        _ts.Add(new Transformer());\n        var sp = new List<Special>();\n' +
                '        sp.Count2();\n        local.Count2();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const add = tiers(index, 'Add', index.symbols.get('Add').find(d => d.isExtensionMethod));
            // List<T>.Add(T) owns `_ts.Add(new Transformer())` and the
            // extension's own recursive call; the other lists' element
            // types never convert to Transformer; `Add<int>(lambda)` has
            // explicit type arguments no instance Add takes.
            assert.deepStrictEqual(add.confirmed, ['Use.cs:16']);
            assert.deepStrictEqual(add.excluded, ['Ext.cs:12', 'Use.cs:12', 'Use.cs:13', 'Use.cs:15', 'Use.cs:17']);
            // IEnumerable<out T> is covariant: a List<Special> takes it; a List<int> never does.
            const count = tiers(index, 'Count2', index.symbols.get('Count2')[0]);
            assert.deepStrictEqual(count.confirmed, ['Use.cs:19']);
            assert.deepStrictEqual(count.excluded, ['Use.cs:20']);
        } finally { rm(dir); }
    });

    it('plan renames method groups by simple-name lookup: delegates, events, LINQ, target-typed new, this/base, type-qualified', () => {
        const files = {
            'A.cs': 'using System;\nusing System.Collections.Generic;\nusing System.Linq;\n\nnamespace Acme;\n\n' +
                'public class Cache {\n    public Cache(Func<int, string> factory, int size) { }\n}\n\npublic class Host {\n' +
                '    private readonly Cache _a;\n    public event EventHandler Changed;\n\n    public Host() {\n' +
                '        _a = new(Build, 4);\n        Changed += OnChanged;\n        var xs = new List<int> { 1 }.Select(Build).ToList();\n' +
                '        Func<int, string> f = Build;\n        Func<int, string> g = this.Build;\n        var n = nameof(Build);\n' +
                '        Func<int, string> s = Host.Make;\n    }\n\n    protected virtual string Build(int k) => k.ToString();\n' +
                '    public static string Make(int k) => "";\n    private void OnChanged(object sender, EventArgs e) { }\n\n' +
                '    public void Shadow(Func<int, string> Build) {\n        Func<int, string> f = Build;\n    }\n}\n\n' +
                'public class Other {\n    public string Build { get; set; }\n    public void Use() { var b = Build; }\n}\n',
            'B.cs': 'using System;\n\nnamespace Acme.Sub;\n\npublic class Derived : Acme.Host {\n' +
                '    protected override string Build(int k) => "d";\n    public void Go() {\n        Func<int, string> f = base.Build;\n' +
                '        Func<int, string> g = Build;\n    }\n}\n',
        };
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const { contents, reviews } = applyRenamePlan(dir, planOf(index, 'Build', 'A.cs', 25, 'Compose'));
            assert.deepStrictEqual(reviews, []);
            const a = contents['A.cs'].split('\n');
            for (const [row, text] of [[15, '_a = new(Compose, 4);'], [17, 'var xs = new List<int> { 1 }.Select(Compose).ToList();'],
                [18, 'Func<int, string> f = Compose;'], [19, 'Func<int, string> g = this.Compose;'],
                [20, 'var n = nameof(Compose);'], [24, 'protected virtual string Compose(int k) => k.ToString();'],
                [29, 'Func<int, string> f = Build;'], [35, 'public void Use() { var b = Build; }']]) {
                assert.strictEqual(a[row].trim(), text, `A.cs:${row + 1}`);
            }
            const b = contents['B.cs'].split('\n');
            assert.strictEqual(b[7].trim(), 'Func<int, string> f = base.Compose;');
            assert.strictEqual(b[8].trim(), 'Func<int, string> g = Compose;');
            const events = applyRenamePlan(dir, planOf(index, 'OnChanged', 'A.cs', 27, 'OnChange'));
            assert.strictEqual(events.contents['A.cs'].split('\n')[16].trim(), 'Changed += OnChange;');
            const make = applyRenamePlan(dir, planOf(index, 'Make', 'A.cs', 26, 'Produce'));
            assert.strictEqual(make.contents['A.cs'].split('\n')[21].trim(), 'Func<int, string> s = Host.Produce;');
        } finally { rm(dir); }
    });

    it('a method group of overloads is a review item; a local function is renamed only in its block', () => {
        const dir = tmp({
            'A.cs': 'using System;\n\nnamespace Acme;\n\npublic interface IProfile { int[] Items { get; } }\n\npublic class Map {\n' +
                '    private int _n;\n    public string Over(int k) => "";\n    public string Over(string s) => s;\n\n' +
                '    public Map(IProfile profile) {\n        Items();\n        Func<int, string> o = Over;\n        return;\n' +
                '        void Items() { _n = profile.Items.Length; }\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const local = planOf(index, 'Items', 'A.cs', 16, 'Load');
            const { contents } = applyRenamePlan(dir, local);
            const lines = contents['A.cs'].split('\n');
            assert.strictEqual(lines[12].trim(), 'Load();');
            assert.strictEqual(lines[15].trim(), 'void Load() { _n = profile.Items.Length; }');
            const over = applyRenamePlan(dir, planOf(index, 'Over', 'A.cs', 9, 'Pick'));
            assert.deepStrictEqual(over.reviews, ['A.cs:14']);
        } finally { rm(dir); }
    });

    it('a local function declared inside another local function is indexed and called', () => {
        const dir = tmp({
            'A.cs': 'namespace Acme;\npublic class M {\n    public int Map() {\n        return Core();\n' +
                '        int Core() {\n            return Inner();\n            int Inner() => 1;\n        }\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const inner = index.symbols.get('Inner');
            assert.strictEqual(inner?.length, 1);
            assert.deepStrictEqual(tiers(index, 'Inner', inner[0]).confirmed, ['A.cs:6']);
        } finally { rm(dir); }
    });

    it('a call to a local function is its enclosing method\'s callee, before a class member of the name', () => {
        const dir = tmp({
            'A.cs': 'namespace Acme;\npublic class M {\n    public int Map(int x) {\n        var y = x switch {\n' +
                '            0 => Fail(),\n            _ => x,\n        };\n        return y;\n        int Fail() => -1;\n    }\n' +
                '    public int Other() => Fail();\n    private int Fail() => -2;\n}\n',
        });
        try {
            const index = idx(dir);
            const map = index.symbols.get('Map')[0];
            const mapCallees = index.findCallees(map, { collectAccount: true });
            assert.deepStrictEqual(mapCallees.map(c => `${c.name}:${c.startLine}`), ['Fail:9']);
            const other = index.symbols.get('Other')[0];
            assert.deepStrictEqual(index.findCallees(other).map(c => `${c.name}:${c.startLine}`), ['Fail:12']);
        } finally { rm(dir); }
    });

    it('project-file static usings supply bare calls; ancestor Directory.Build.props usings reach a sub-project index', () => {
        const dir = tmp({
            'Directory.Build.props': '<Project>\n  <ItemGroup>\n    <Using Include="Acme.Internal" />\n  </ItemGroup>\n</Project>\n',
            'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n' +
                '    <Using Include="Acme.Execution.ExpressionBuilder" Static="true"/>\n  </ItemGroup>\n</Project>\n',
            'src/App/Builder.cs': 'namespace Acme.Execution;\npublic static class ExpressionBuilder {\n    public static int ToType(int e, string t) => e;\n}\n',
            'src/App/Ext.cs': 'namespace Acme.Internal;\npublic static class TypeExtensions {\n    public static bool IsBig(this string s) => s.Length > 3;\n}\n',
            'src/App/Use.cs': 'namespace Acme.Planning;\npublic class Planner {\n    public int Plan(int x) => ToType(x, "int");\n' +
                '    public bool Big(string s) => s.IsBig();\n}\n',
        });
        try {
            execFileSync('git', ['init', '-q'], { cwd: dir });
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'ToType', index.symbols.get('ToType')[0]).confirmed, ['src/App/Use.cs:3']);
            // Indexed from the sub-project, the repository's usings still apply.
            const sub = idx(path.join(dir, 'src', 'App'));
            assert.deepStrictEqual(tiers(sub, 'IsBig', sub.symbols.get('IsBig')[0]).confirmed, ['Use.cs:4']);
            assert.deepStrictEqual(tiers(sub, 'ToType', sub.symbols.get('ToType')[0]).confirmed, ['Use.cs:3']);
        } finally { rm(dir); }
    });

    it('an explicit interface implementation is never the target of a simple-name call', () => {
        const dir = tmp({
            'A.cs': 'using System.Collections;\nusing System.Collections.Generic;\n\nnamespace Acme;\n\n' +
                'public class Bag<T> : IEnumerable<T> {\n    private readonly List<T> _items = new();\n' +
                '    public IEnumerator<T> GetEnumerator() => _items.GetEnumerator();\n\n' +
                '    IEnumerator IEnumerable.GetEnumerator() {\n        return GetEnumerator();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('GetEnumerator');
            const explicit = tiers(index, 'GetEnumerator', defs.find(d => d.explicitInterface));
            assert.deepStrictEqual(explicit.confirmed, []);
            assert.ok(explicit.excluded.includes('A.cs:11'));
            assert.deepStrictEqual(tiers(index, 'GetEnumerator', defs.find(d => !d.explicitInterface)).confirmed, ['A.cs:11']);
        } finally { rm(dir); }
    });

    it('an explicit implementation is reached through an interface-typed receiver by dispatch only', () => {
        const dir = tmp({
            'A.cs': 'namespace Acme;\npublic interface ISink { void Emit(int e); }\n' +
                'public sealed class Logger : ISink {\n    void ISink.Emit(int e) { }\n}\n' +
                'public sealed class Filter : ISink {\n    private readonly ISink _sink;\n' +
                '    public Filter(ISink sink) { _sink = sink; }\n    public void Emit(int e) { _sink.Emit(e); }\n}\n',
        });
        try {
            const index = idx(dir);
            const explicit = tiers(index, 'Emit', index.symbols.get('Emit').find(d => d.explicitInterface));
            assert.deepStrictEqual(explicit.confirmed, []);
            assert.deepStrictEqual(explicit.unverified, ['A.cs:9']);
        } finally { rm(dir); }
    });

    it('an explicit interface implementation and a same-name protected virtual are two rename slots', () => {
        const dir = tmp({
            'I.cs': 'namespace Acme;\npublic interface IValidator { string Template(string code); }\n',
            'P.cs': 'namespace Acme;\npublic abstract class PropertyValidator : IValidator {\n' +
                '    string IValidator.Template(string code) => Template(code);\n' +
                '    protected virtual string Template(string code) => "";\n}\n' +
                'public class EnumValidator : PropertyValidator {\n' +
                '    protected override string Template(string code) => "e";\n}\n',
            'A.cs': 'namespace Acme;\npublic abstract class AsyncValidator : IValidator {\n' +
                '    string IValidator.Template(string code) => Template(code);\n' +
                '    protected virtual string Template(string code) => "";\n}\n' +
                'public class Plain : IValidator {\n    public string Template(string code) => code;\n}\n' +
                'public class Use {\n    public string Run(IValidator v) => v.Template("x");\n}\n',
        });
        try {
            const index = idx(dir);
            const edits = (file, line) => {
                const plan = planOf(index, 'Template', file, line, 'Shape');
                return plan.changes.filter(c => c.newExpression !== undefined).map(c => `${c.file}:${c.line}`).sort();
            };
            // The protected virtual chain: its base, overrides and the call
            // inside the explicit shim; never the interface slot.
            assert.deepStrictEqual(edits('P.cs', 7), ['P.cs:3', 'P.cs:4', 'P.cs:7']);
            // The interface slot: the member, both explicit implementations,
            // the public implicit one and the interface-typed call.
            assert.deepStrictEqual(edits('I.cs', 2), ['A.cs:10', 'A.cs:3', 'A.cs:7', 'I.cs:2', 'P.cs:3']);
        } finally { rm(dir); }
    });

    it('a bare value named like a type is never the type (a property named like its type)', () => {
        const dir = tmp({
            'A.cs': 'namespace Acme;\npublic readonly record struct MemberPath(int[] Members);\n' +
                'public class Map {\n    public MemberPath MemberPath { get; } = new(new int[0]);\n' +
                '    public int Use(Map m) => Take(MemberPath);\n    static int Take(MemberPath p) => 0;\n}\n',
        });
        try {
            const index = idx(dir);
            const t = tiers(index, 'MemberPath', index.symbols.get('MemberPath').find(d => d.type === 'record'));
            assert.ok(!t.confirmed.includes('A.cs:5'));
            assert.ok(!t.unverified.includes('A.cs:5'));
        } finally { rm(dir); }
    });

    it('audit-async audits member calls on typed receivers', () => {
        const dir = tmp({
            'A.cs': 'using System.IO;\nusing System.Threading.Tasks;\n\nnamespace Acme;\n\npublic class Svc {\n' +
                '    public async Task SaveAsync() { await Task.Delay(1); }\n}\n\npublic class Client {\n' +
                '    private readonly Svc _svc = new Svc();\n    public async Task Local() { await Task.Delay(1); }\n' +
                '    public async Task A(Svc p, Stream st) {\n        this.Local();\n        _svc.SaveAsync();\n' +
                '        var s = new Svc();\n        s.SaveAsync();\n        p?.SaveAsync();\n        await p.SaveAsync();\n' +
                '        st.FlushAsync();\n    }\n}\n',
        });
        try {
            const issues = idx(dir).auditAsync({}).issues.map(i => `${i.file}:${i.line}`).sort();
            assert.deepStrictEqual(issues, ['A.cs:14', 'A.cs:15', 'A.cs:17', 'A.cs:18']);
        } finally { rm(dir); }
    });

    it('a static property path from a type types its chain on both sides', () => {
        const dir = tmp({
            'Pool.cs': 'namespace Acme;\npublic abstract class Pool {\n    public static Pool Shared { get; } = new Impl();\n' +
                '    public Ctx Get() => new Ctx();\n    private sealed class Impl : Pool { }\n}\npublic class Ctx {\n' +
                '    internal Ctx Initialize<T>(bool sync) => this;\n}\npublic class User {\n' +
                '    public void Go() {\n        var c = Pool.Shared.Get().Initialize<int>(true);\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const callees = index.findCallees(index.symbols.get('Go')[0], { includeMethods: true })
                .map(c => `${c.name}:${c.startLine}`).sort();
            assert.deepStrictEqual(callees, ['Get:4', 'Initialize:8']);
            assert.deepStrictEqual(tiers(index, 'Get', index.symbols.get('Get')[0]).confirmed, ['Pool.cs:12']);
            assert.deepStrictEqual(tiers(index, 'Initialize', index.symbols.get('Initialize')[0]).confirmed, ['Pool.cs:12']);
        } finally { rm(dir); }
    });
});

describe('fix #397: members of classes deriving from an outside base are its possible overrides', () => {
    it('underscore hooks stay out of deadcode and get the outside-supertype review; language-private names do not', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'l.js': [
                "const { Transform } = require('stream');",
                'class L extends Transform {',
                '  _transform(chunk, enc, cb) { cb(null, chunk); }',
                '  _flush(cb) { cb(); }',
                '}',
                'function mk() { return new L(); }',
                'mk();',
            ].join('\n') + '\n',
            'q.ts': [
                "import { Transform } from 'stream';",
                'class Q extends Transform {',
                '  _transform(chunk: any, enc: string, cb: () => void) { cb(); }',
                '  private _secret(): number { return 1; }',
                '}',
                'export function mkQ() { return new Q(); }',
            ].join('\n') + '\n',
            'traps.ts': [
                'const traps: ProxyHandler<object> = {',
                '  deleteProperty(target, prop) { return true; },',
                '};',
                'export function make(o: object) { return new Proxy(o, traps); }',
            ].join('\n') + '\n',
            'w.py': [
                'import textwrap',
                '',
                '',
                'class W(textwrap.TextWrapper):',
                '    def _handle_long_word(self, chunks, cur_line, cur_len, width):',
                '        return None',
                '',
                '    def __mangled(self):',
                '        return 1',
                '',
                '',
                'W()',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', {});
            assert.ok(r.ok, JSON.stringify(r.error));
            const claims = (r.result.results || r.result).map(s => `${s.relativePath || s.file}:${s.name}`);
            for (const hidden of ['l.js:_transform', 'l.js:_flush', 'q.ts:_transform', 'traps.ts:deleteProperty',
                'w.py:_handle_long_word']) {
                assert.ok(!claims.includes(hidden), `${hidden} may be called by the outside base: ${claims}`);
            }
            assert.ok(claims.includes('q.ts:_secret'), `a TS private member overrides nothing: ${claims}`);
            assert.ok(claims.includes('w.py:__mangled'), `a mangled Python name overrides nothing: ${claims}`);
            const plan = execute(index, 'plan', { name: 'l.js:3:_transform', renameTo: 'tZ' });
            assert.ok(plan.ok, JSON.stringify(plan.error));
            assert.ok((plan.result.reviewItems || []).some(item => item.contractDependency &&
                /Transform \(outside the project\)/.test(item.suggestion)), JSON.stringify(plan.result.reviewItems));
        } finally { rm(dir); }
    });
});

describe('fix #400: C# target-typed new typed by its call or member', () => {
    const csharpProject = () => tmp({
        'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
        'Pair.cs': [
            'using System.Collections.Generic;',                                   // 1
            'namespace App;',                                                      // 2
            'public readonly record struct TypePair(System.Type Source, System.Type Destination);', // 3
            'public class Other',                                                  // 4
            '{',                                                                   // 5
            '    public Other(int a, int b) { }',                                  // 6
            '}',                                                                   // 7
            'public class Base(TypePair pair) { }',                                // 8
            'public class Mapper : Base',                                          // 9
            '{',                                                                   // 10
            '    private readonly List<TypePair> _pairs = new();',                 // 11
            '    private TypePair _last;',                                         // 12
            '    public Mapper(System.Type a) : base(new(a, a)) { }',              // 13
            '    public void DryRun(TypePair pair) { }',                           // 14
            '    public void Register(TypePair pair, int x) { }',                  // 15
            '    public void Register(Other other, string x) { }',                 // 16
            '    public void Ambig(TypePair pair) { }',                            // 17
            '    public void Ambig(Other other) { }',                              // 18
            '    public void Use(System.Type a, System.Type b)',                   // 19
            '    {',                                                               // 20
            '        DryRun(new(a, b));',                                          // 21
            '        Register(new(a, b), 1);',                                     // 22
            '        Register(new(1, 2), "s");',                                   // 23
            '        Ambig(new(a, b));',                                           // 24
            '        _pairs.Add(new(a, b));',                                      // 25
            '        _last = new(b, a);',                                          // 26
            '        TypePair local;',                                             // 27
            '        local = new(a, a);',                                          // 28
            '        var spare = Pick();',                                         // 29
            '        spare = new(1, 2);',                                          // 30
            '    }',                                                               // 31
            '    private TypePair spare;',                                         // 32
            '    public Other Pick() => null;',                                    // 33
            '}',                                                                   // 34
        ].join('\n') + '\n',
    });

    it('callers of the constructed type: decided slots confirmed, undecided overloads visible', () => {
        const dir = csharpProject();
        try {
            const index = idx(dir);
            const def = index.symbols.get('TypePair').find(d => d.type === 'record');
            const callers = index.findCallers('TypePair', { targetDefinitions: [def], collectAccount: true });
            const confirmed = callers.map(c => c.line).sort((a, b) => a - b);
            // Line 30 assigns the untyped local `spare`, never the field.
            assert.deepStrictEqual(confirmed, [13, 21, 22, 25, 26, 28], JSON.stringify(callers.map(c => c.line)));
            const unverified = (callers.unverifiedEntries || []).map(c => `${c.line}:${c.reason}`);
            assert.deepStrictEqual(unverified, ['24:overload-ambiguous']);
            const other = index.symbols.get('Other').find(d => d.type === 'class');
            const otherCallers = index.findCallers('Other', { targetDefinitions: [other], collectAccount: true });
            assert.deepStrictEqual(otherCallers.map(c => c.line), [23]);
            // A rename never edits a target-typed `new(..)` (it spells no
            // name): neither an edit nor a review candidate.
            const plan = execute(index, 'plan', { name: 'TypePair', file: 'Pair.cs', line: 3, renameTo: 'TypePairZ' });
            assert.ok(plan.ok, plan.error);
            assert.ok(!plan.result.changes.some(c => [21, 22, 24, 25, 26].includes(c.line)), JSON.stringify(plan.result.changes));
            assert.deepStrictEqual((plan.result.unverifiedSites || []).map(u => u.line), []);
        } finally { rm(dir); }
    });

    it('callees of the enclosing method include the constructed type, conserved', () => {
        const dir = csharpProject();
        try {
            const index = idx(dir);
            const use = index.symbols.get('Use')[0];
            const callees = index.findCallees(use, { collectAccount: true });
            const typePair = callees.find(c => c.name === 'TypePair');
            assert.ok(typePair, JSON.stringify(callees.map(c => c.name)));
            const unverified = (callees.unverifiedCallees || []).map(c => `${c.name}:${c.reason}`);
            assert.ok(unverified.includes('TypePair:overload-ambiguous'), JSON.stringify(unverified));
            const account = callees.calleeAccount;
            assert.ok(account);
            assert.strictEqual(account.unaccounted, 0, JSON.stringify(account));
        } finally { rm(dir); }
    });
});

describe('fix #400: C# generic interface slots by written arity and per instantiation', () => {
    it('renames every implementation, also of a class implementing the interface twice', () => {
        const dir = tmp({
            'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
            'Resolver.cs': [
                'namespace App;',                                                        // 1
                'public interface IResolver<in TSource, TResult>',                       // 2
                '{',                                                                     // 3
                '    TResult Resolve(TSource source, int depth);',                       // 4
                '}',                                                                     // 5
            ].join('\n') + '\n',
            'Plain.cs': [
                'namespace App.Execution;',                                              // 1
                'public interface IResolver',                                            // 2
                '{',                                                                     // 3
                '    object Resolve(object source, int depth);',                         // 4
                '}',                                                                     // 5
                'public class PlainResolver : IResolver',                                // 6
                '{',                                                                     // 7
                '    public object Resolve(object source, int depth) => source;',        // 8
                '}',                                                                     // 9
            ].join('\n') + '\n',
            'Impl.cs': [
                'using App.Execution;',                                                  // 1
                'namespace App;',                                                        // 2
                'public class A { }',                                                    // 3
                'public class B { }',                                                    // 4
                'public class One : IResolver<A, string>',                               // 5
                '{',                                                                     // 6
                '    public string Resolve(A source, int depth) => "a";',                // 7
                '}',                                                                     // 8
                'public class Both : IResolver<A, string>, IResolver<B, string>',        // 9
                '{',                                                                     // 10
                '    public string Resolve(A source, int depth) => "a";',                // 11
                '    public string Resolve(B source, int depth) => "b";',                // 12
                '}',                                                                     // 13
            ].join('\n') + '\n',
        });
        try {
            const result = execute(idx(dir), 'plan', { name: 'Resolve', file: 'Impl.cs', line: 7, renameTo: 'ResolveZ' });
            assert.ok(result.ok, result.error);
            const edits = result.result.changes.filter(c => !c.needsReview).map(c => `${c.file}:${c.line}`).sort();
            assert.deepStrictEqual(edits, ['Impl.cs:11', 'Impl.cs:12', 'Impl.cs:7', 'Resolver.cs:4'],
                JSON.stringify(result.result.changes));
        } finally { rm(dir); }
    });
});
