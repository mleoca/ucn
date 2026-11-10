'use strict';

/**
 * core/deletion.js: can this declaration be deleted?
 *
 * One eligibility rule (the dead-code pipeline) answers for the audit and
 * for a single declaration. These tests pin that the two never disagree,
 * that downstream exposure is a policy the project kind relaxes while
 * contracts are facts no kind or flag relaxes, that a member a project
 * contract requires is withheld, and that a declaration the index no longer
 * holds can still be assessed from its record.
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { deadcode } = require('../core/deadcode');
const { assessDeletion, projectKind, downstreamExposureBlocks } = require('../core/deletion');
const output = require('../core/output');

function assess(index, name, file) {
    const defs = (index.symbols.get(name) || []).filter(def =>
        !file || def.relativePath === file);
    assert.strictEqual(defs.length, 1, `${name}${file ? ` in ${file}` : ''}: one definition`);
    return assessDeletion(index, defs[0]);
}

function claimed(index, options = {}) {
    return deadcode(index, options).map(row => `${row.file}:${row.startLine}:${row.name}`).sort();
}

describe('deletion: one rule for the audit and for one declaration', () => {
    const files = {
        'package.json': '{"name":"deletion-fixture"}',
        'lib.js': [
            'function used() { return 1; }',
            'function unused() { return 2; }',
            'function referenced() { return 3; }',
            'const table = { referenced };',
            'function alsoExported() { return 4; }',
            'module.exports = { run: () => used() + table.referenced(), alsoExported };',
            'module.exports.handle = function () { return 5; };',
            'const socket = {};',
            'socket.onmessage = function () { return 6; };',
        ].join('\n'),
        'a.py': 'def unused():\n    return 1\n\n\ndef _private_unused():\n    return 2\n',
        'b.go': 'package main\n\nfunc helperUnused() int { return 1 }\n\nfunc main() {}\n',
    };

    it('every declaration the audit lists is exactly one the assessment clears', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const listed = new Set(claimed(index));
            assert.ok(listed.size > 0);
            let compared = 0;
            for (const defs of index.symbols.values()) {
                for (const def of defs) {
                    const cleared = assessDeletion(index, def).verdict === 'no-static-dependents';
                    assert.strictEqual(cleared,
                        listed.has(`${def.relativePath}:${def.startLine}:${def.name}`),
                        `${def.relativePath}:${def.startLine}:${def.name}`);
                    compared++;
                }
            }
            assert.ok(compared >= 9);
        } finally { rm(dir); }
    });

    it('names its reason: a call, another use, exposure, a runtime assignment', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            assert.deepStrictEqual(
                [assess(index, 'used').verdict, assess(index, 'used').reason],
                ['has-static-dependents', 'has-callers']);
            const referenced = assess(index, 'referenced');
            assert.strictEqual(referenced.verdict, 'has-static-dependents');
            const unused = assess(index, 'unused', 'lib.js');
            assert.deepStrictEqual([unused.verdict, unused.reason],
                ['no-static-dependents', 'claimed']);
            const exported = assess(index, 'alsoExported');
            assert.deepStrictEqual([exported.verdict, exported.reason],
                ['review', 'downstream-exposure']);
            // An assignment to a member of something that is not the export
            // object IS the registration: no name to count, no claim.
            const assigned = assess(index, 'onmessage');
            assert.deepStrictEqual([assigned.verdict, assigned.reason],
                ['review', 'runtime-contract']);
            // The verdict is evidence, never a guarantee.
            for (const answer of [unused, exported, assigned]) {
                assert.strictEqual(answer.safeToDelete, false);
                assert.strictEqual(answer.requiresCompilerAndTests, true);
            }
        } finally { rm(dir); }
    });

    it('a use outranks a shield: an exported symbol with callers has dependents', () => {
        const dir = tmp({
            'package.json': '{"name":"outrank-fixture"}',
            'lib.js': [
                'function api() { return 1; }',
                'function value() { return 2; }',
                'function quiet() { return 3; }',
                'module.exports = { api, value, quiet };',
            ].join('\n'),
            'use.js': [
                'const lib = require("./lib");',
                'lib.api();',
                'const table = [lib.value];',
                'console.log(table);',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // Called inside the repository: "consumers outside may use it"
            // must not hide that.
            const called = assess(index, 'api');
            assert.deepStrictEqual([called.verdict, called.reason],
                ['has-static-dependents', 'has-callers']);
            // The answer names the first use, so it can be checked.
            assert.deepStrictEqual(called.site, { file: 'use.js', line: 2 });
            // Used as a value, never called.
            const value = assess(index, 'value');
            assert.deepStrictEqual([value.verdict, value.reason, value.site],
                ['has-static-dependents', 'has-usages', { file: 'use.js', line: 3 }]);
            // Exported and unused in the repository: exposure is the answer.
            const quiet = assess(index, 'quiet');
            assert.deepStrictEqual([quiet.verdict, quiet.reason], ['review', 'downstream-exposure']);
            // The audit is unchanged by the ordering: nothing here is listed.
            assert.deepStrictEqual(claimed(index), []);
        } finally { rm(dir); }
    });

    it('a use inside the declaration is deleted with it and is no dependent', () => {
        const dir = tmp({
            'package.json': '{"name":"own-body-fixture"}',
            // Delegation to a member of the same name.
            'store.js': [
                'class Store {',
                '    constructor() { this.items = new Map(); }',
                '    clear() { this.items.clear(); }',
                '}',
                'new Store();',
            ].join('\n'),
            // An override that calls the method it overrides.
            'svc.py': [
                'class _Base:',
                '    def _run(self):',
                '        return 1',
                '',
                'class _Child(_Base):',
                '    def _run(self):',
                '        return super()._run() + 1',
            ].join('\n'),
            'wrap.rs': [
                'struct Wrapper { inner: Vec<u8> }',
                'impl Wrapper {',
                '    fn len(&self) -> usize { self.inner.len() }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const own = (name, file, line) => {
                const def = (index.symbols.get(name) || []).find(d =>
                    d.relativePath === file && d.startLine === line);
                assert.ok(def, `${file}:${line}:${name}`);
                return assessDeletion(index, def);
            };
            // The only call of each name is inside the declaration. It was
            // answered "a call of this name exists": true of the name, and
            // no reason to keep the declaration.
            for (const [name, file, line] of [
                ['clear', 'store.js', 3], ['_run', 'svc.py', 6], ['len', 'wrap.rs', 3],
            ]) {
                const answer = own(name, file, line);
                assert.deepStrictEqual([answer.verdict, answer.reason, answer.site],
                    ['review', 'used-only-within-itself', undefined], `${file}:${line}:${name}`);
            }
            // The same call IS a dependent of the method it reaches: the
            // base member is used from the override's body.
            const base = own('_run', 'svc.py', 2);
            assert.deepStrictEqual([base.verdict, base.reason, base.site],
                ['has-static-dependents', 'has-callers', { file: 'svc.py', line: 7 }]);
            // Abstaining is not clearing: the audit lists none of them, so
            // the two surfaces still agree.
            const listed = claimed(index);
            for (const row of ['store.js:3:clear', 'svc.py:6:_run', 'wrap.rs:3:len']) {
                assert.ok(!listed.includes(row), `${row} is not claimed`);
            }
        } finally { rm(dir); }
    });

    it('two unused same-name functions get one answer from both surfaces', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const listed = claimed(index);
            assert.ok(listed.includes('lib.js:2:unused'));
            // a.py is no package: its top-level `unused` is not public surface.
            assert.ok(listed.includes('a.py:1:unused'));
            assert.strictEqual(assess(index, 'unused', 'lib.js').verdict, 'no-static-dependents');
            assert.strictEqual(assess(index, 'unused', 'a.py').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
});

describe('deletion: exposure is a policy, a contract is a fact', () => {
    const files = kind => ({
        'package.json': '{"name":"kind-fixture"}',
        ...(kind && { '.ucn.json': JSON.stringify({ kind }) }),
        'lib.js': [
            'function exportedUnused() { return 1; }',
            'module.exports = { exportedUnused };',
            'module.exports.handle = function () { return 2; };',
            'const socket = {};',
            'socket.onmessage = function () { return 3; };',
        ].join('\n'),
        'worker.py': [
            'import threading',
            '',
            '',
            'class _Local(threading.Thread):',
            '    def run(self):',
            '        return 1',
            '',
            '',
            '_WORKER = _Local()',
        ].join('\n'),
    });

    it('a library keeps exported symbols out of a claim; an application does not', () => {
        const library = tmp(files(null));
        const application = tmp(files('application'));
        try {
            const lib = idx(library);
            const app = idx(application);
            assert.strictEqual(projectKind(lib), 'library');
            assert.strictEqual(projectKind(app), 'application');
            assert.strictEqual(downstreamExposureBlocks(lib, true), true);
            assert.strictEqual(downstreamExposureBlocks(lib, true, { includeExported: true }), false);
            assert.strictEqual(downstreamExposureBlocks(app, true), false);
            assert.strictEqual(downstreamExposureBlocks(lib, false), false);

            assert.deepStrictEqual(
                [assess(lib, 'exportedUnused').verdict, assess(lib, 'exportedUnused').reason],
                ['review', 'downstream-exposure']);
            assert.strictEqual(assess(app, 'exportedUnused').verdict, 'no-static-dependents');
            // A CommonJS export assignment is an export, so an application
            // audits it. The same syntax on any other object stays a
            // runtime registration under both kinds: the export FACT is
            // what tells them apart, and the kind never rewrites it.
            assert.strictEqual(assess(app, 'handle').verdict, 'no-static-dependents');
            assert.deepStrictEqual([assess(lib, 'handle').verdict, assess(lib, 'handle').reason],
                ['review', 'downstream-exposure']);
            for (const index of [lib, app]) {
                assert.deepStrictEqual(
                    [assess(index, 'onmessage').verdict, assess(index, 'onmessage').reason],
                    ['review', 'runtime-contract']);
            }
            const appText = output.formatPublicText('deadcode', execute(app, 'deadcode', {}).result, {});
            assert.match(appText, /Project kind: application/);
            assert.doesNotMatch(appText, /excluded from the audit/);
        } finally { rm(library); rm(application); }
    });

    it('an unexported override of an out-of-tree base is withheld under both kinds', () => {
        const library = tmp(files(null));
        const application = tmp(files('application'));
        try {
            for (const dir of [library, application]) {
                const index = idx(dir);
                const run = assess(index, 'run');
                assert.deepStrictEqual([run.verdict, run.reason], ['review', 'external-contract'],
                    projectKind(index));
                assert.ok(!claimed(index).includes('worker.py:5:run'), projectKind(index));
                // --include-exported LISTS it, tagged, as before. Listed is
                // not cleared.
                const revealed = deadcode(index, { includeExported: true })
                    .find(row => row.name === 'run');
                assert.strictEqual(revealed && revealed.externalContract, true, projectKind(index));
                const withFlag = assessDeletion(index,
                    index.symbols.get('run')[0], { includeExported: true });
                assert.deepStrictEqual([withFlag.verdict, withFlag.reason],
                    ['review', 'external-contract'], projectKind(index));
            }
        } finally { rm(library); rm(application); }
    });
});

describe('deletion: a member a project contract requires is withheld', () => {
    it('the implementation a type owes to an interface, abstract class or trait', () => {
        const dir = tmp({
            'package.json': '{"name":"slot-fixture"}',
            'shape.ts': [
                'interface Shape { area(): number; }',
                'class Circle implements Shape {',
                '    area(): number { return 1; }',
                '}',
                'const made = new Circle();',
                'console.log(made);',
            ].join('\n'),
            'base.py': [
                'import abc',
                '',
                '',
                'class _Contract(metaclass=abc.ABCMeta):',
                '    @abc.abstractmethod',
                '    def slot(self):',
                '        raise NotImplementedError',
                '',
                '',
                'class _Impl(_Contract):',
                '    marker = 1',
                '',
                '    def slot(self):',
                '        return 1',
                '',
                '',
                '_INSTANCE = _Impl()',
            ].join('\n'),
            'contract.go': [
                'package main',
                '',
                'type contract interface {',
                '\tgoSlot() int',
                '}',
                '',
                'type impl struct{}',
                '',
                'func (impl) goSlot() int {',
                '\treturn 1',
                '}',
                '',
                'var _ contract = impl{}',
                '',
                'func main() {}',
            ].join('\n'),
            'tr.rs': [
                'trait Contract {',
                '    fn rust_slot(&self) -> i32;',
                '    fn defaulted(&self) -> i32 { 0 }',
                '}',
                'struct Impl;',
                'impl Contract for Impl {',
                '    fn rust_slot(&self) -> i32 { 1 }',
                '    fn defaulted(&self) -> i32 { 2 }',
                '}',
                'fn main() { let _ = Impl; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const implementation = (name, file) => {
                const defs = (index.symbols.get(name) || []).filter(def =>
                    def.relativePath === file && def.className && !/ontract|Shape/.test(def.className));
                assert.strictEqual(defs.length, 1, `${file}:${name}`);
                return assessDeletion(index, defs[0]);
            };
            for (const [name, file] of [['area', 'shape.ts'], ['slot', 'base.py'],
                ['goSlot', 'contract.go']]) {
                const answer = implementation(name, file);
                assert.deepStrictEqual([answer.verdict, answer.reason], ['review', 'required-slot'],
                    `${file}:${name}`);
            }
            // A Rust trait implementation was already withheld (the language
            // adapter treats trait methods as entry points); it stays so.
            assert.strictEqual(implementation('rust_slot', 'tr.rs').verdict, 'review');
            const listed = claimed(index);
            assert.ok(!listed.some(row => /:(area|slot|goSlot|rust_slot)$/.test(row) &&
                !/shape\.ts:1:|base\.py:6:|contract\.go:4:|tr\.rs:2:/.test(row)), listed.join(' '));
            assert.strictEqual(deadcode(index, {}).excludedRequiredSlot, 3);
        } finally { rm(dir); }
    });

    it('a plain override of a concrete method is not a requirement', () => {
        const dir = tmp({
            'package.json': '{"name":"override-fixture"}',
            'run.js': [
                'class Base { run() { return 1; } }',
                'class Child extends Base { run() { return 2; } }',
                'console.log(new Base(), new Child());',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(claimed(index), ['run.js:1:run', 'run.js:2:run']);
            for (const def of index.symbols.get('run')) {
                assert.strictEqual(assessDeletion(index, def).verdict, 'no-static-dependents');
            }
        } finally { rm(dir); }
    });

    it('a base member a descendant says it overrides is held in place', () => {
        const dir = tmp({
            'package.json': '{"name":"marked-fixture"}',
            'run.ts': [
                'class Base { run(): number { return 1; } }',
                'class Child extends Base { override run(): number { return 2; } }',
                'console.log(new Base(), new Child());',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const base = index.symbols.get('run').find(def => def.className === 'Base');
            const child = index.symbols.get('run').find(def => def.className === 'Child');
            assert.deepStrictEqual(
                [assessDeletion(index, base).verdict, assessDeletion(index, base).reason],
                ['review', 'required-slot']);
            // The override itself can go: calls fall back to Base.run.
            assert.strictEqual(assessDeletion(index, child).verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
});

describe('deletion: a declaration the index no longer holds', () => {
    it('is assessed from its record against the uses that remain', () => {
        const dir = tmp({
            'package.json': '{"name":"absent-fixture"}',
            'lib.js': 'function kept() { return gone(); }\nmodule.exports = { run: () => kept() };',
            'util.go': 'package main\n\nfunc main() {}\n',
        });
        try {
            const index = idx(dir);
            const record = (name, file, extra = {}) => ({
                name, type: 'function', file: path.join(dir, file),
                relativePath: file, startLine: 40, endLine: 42, ...extra,
            });
            // Deleted, and still called.
            const called = assessDeletion(index, record('gone', 'lib.js'));
            assert.deepStrictEqual([called.verdict, called.reason, called.indexed],
                ['has-static-dependents', 'has-callers', false]);
            // Deleted, and nothing names it.
            const clean = assessDeletion(index, record('neverNamed', 'lib.js'));
            assert.deepStrictEqual([clean.verdict, clean.indexed],
                ['no-static-dependents', false]);
            // Deleted from a file that is gone too, and exported by the
            // language's own rule: consumers outside may still name it.
            const exported = assessDeletion(index, record('Removed', 'removed.go'));
            assert.deepStrictEqual([exported.verdict, exported.reason],
                ['review', 'downstream-exposure']);
            // Its line numbers never mark a definition site in the current
            // text: a use that happens to sit on that line still counts.
            const sameLine = assessDeletion(index, record('kept', 'lib.js',
                { startLine: 2, endLine: 2 }));
            assert.strictEqual(sameLine.verdict, 'has-static-dependents');
        } finally { rm(dir); }
    });
});
