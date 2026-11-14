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

const fs = require('fs');
const { tmp, rm, idx } = require('./helpers');
const { ProjectIndex } = require('../core/project');
const { CASES, materialize, deleteTarget } = require('../eval/deletion-matrix-cases');
const { execute } = require('../core/execute');
const { deadcode } = require('../core/deadcode');
const { assessDeletion, projectKind, downstreamExposureBlocks } = require('../core/deletion');
const output = require('../core/output');

describe('fix #501 correction: runtime identity and metadata boundaries', () => {
    const cases = require('./runtime-liveness-cases.json');
    for (const row of cases) it(`engine identity: ${row.id}`, () => {
        const dir = tmp(row.files);
        try {
            const index = idx(dir);
            const definition = index.symbols.get(row.name).find(def => def.relativePath === row.file);
            const record = JSON.parse(JSON.stringify(definition));
            const entry = index.files.get(definition.file);
            assert.strictEqual(assessDeletion(index, definition).verdict === 'no-static-dependents', !row.breaks, 'in place');
            assert.strictEqual(claimed(index).some(value => value.endsWith(`:${row.name}`)), !row.breaks, 'audit');
            fs.writeFileSync(path.join(dir, row.file), row.after);
            const after = idx(dir);
            assert.strictEqual(assessDeletion(after, record, { fileEntry: entry }).verdict === 'no-static-dependents', !row.breaks, 'saved record with file facts');
            assert.strictEqual(assessDeletion(after, record).verdict === 'no-static-dependents', !row.breaks, 'saved record alone');
        } finally { rm(dir); }
    });
    it('bounded origins and normalized runtime names conserve caller accounts', () => {
        for (const id of ['reflection-long-chain', 'correction3-bound-iteration-long-alias', 'nfkc-reflection-function']) {
            const row = cases.find(candidate => candidate.id === id);
            const dir = tmp(row.files);
            try {
                const index = idx(dir);
                index._beginOp();
                try {
                    const account = index.context(row.name).meta.account;
                    assert.strictEqual(account.conserved, true, `${id}: ${JSON.stringify(account)}`);
                    assert.strictEqual(account.unaccounted, 0, `${id}: ${JSON.stringify(account)}`);
                } finally { index._endOp(); }
            } finally { rm(dir); }
        }
    });
    it('normalization capability is scoped to source identifiers and rebuilt per operation', () => {
        const dir = tmp({ 'app.py': 'def _slot(): return 7\n', 'use.py': 'NOTE="_ſlot"\n' });
        try {
            const index = idx(dir);
            assert.strictEqual(assess(index, '_slot').verdict, 'no-static-dependents');
            fs.writeFileSync(path.join(dir, 'use.py'), 'import app\ndef exercise(): return app._ſlot()\n');
            index.build(null, { quiet: true, workers: 0 });
            assert.strictEqual(assess(index, '_slot').reason, 'identifier-normalization');
            index.saveCache();
            const loaded = new ProjectIndex(dir, { quiet: true });
            assert.ok(loaded.loadCache());
            assert.strictEqual(assess(loaded, '_slot').reason, 'identifier-normalization');
            fs.writeFileSync(path.join(dir, 'use.py'), 'NOTE="_ſlot"\n');
            loaded.build(null, { quiet: true, workers: 0 });
            assert.strictEqual(assess(loaded, '_slot').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
    it('project builtin effects follow mutator-only edits across live and cached indexes', () => {
        const quiet = 'import builtins\n';
        const mutation = 'import builtins\ndef register(fn): return fn\nbuiltins.property=register\n';
        const dir = tmp({ 'hooks.py': quiet, 'app.py': 'import hooks\nclass Container:\n    @property\n    def _target(self): return 7\n' });
        try {
            const index = idx(dir);
            assert.strictEqual(assess(index, '_target').verdict, 'no-static-dependents');
            fs.writeFileSync(path.join(dir, 'hooks.py'), mutation);
            index.build(null, { quiet: true, workers: 0 });
            assert.strictEqual(assess(index, '_target').reason, 'builtin-namespace-effect');
            const partial = { ...index.symbols.get('_target')[0] };
            delete partial.registrationUnknown;
            assert.notStrictEqual(assessDeletion(index, partial).verdict, 'no-static-dependents');
            index.saveCache();
            const loaded = new ProjectIndex(dir, { quiet: true });
            assert.ok(loaded.loadCache());
            assert.strictEqual(assess(loaded, '_target').reason, 'builtin-namespace-effect');
            fs.writeFileSync(path.join(dir, 'hooks.py'), quiet);
            loaded.build(null, { quiet: true, workers: 0 });
            assert.strictEqual(assess(loaded, '_target').verdict, 'no-static-dependents');
            assert.deepStrictEqual(assess(loaded, '_target'), assess(idx(dir), '_target'));
        } finally { rm(dir); }
    });
    it('native witnesses agree before deletion, after deletion, and after repair', t => {
        const { spawnSync } = require('child_process');
        const python = process.env.PYTHON || 'python3';
        if (spawnSync(python, ['--version']).error) { t.skip('Python runtime unavailable'); return; }
        for (const row of cases) {
            const dir = tmp(row.files);
            try {
                const isNode = path.basename(row.native) === 'node';
                const command = isNode ? process.execPath : python;
                const args = isNode ? ['-e', row.run] : ['-B', '-c', row.run];
                const options = { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } };
                const before = spawnSync(command, args, options);
                assert.strictEqual(before.status, 0, `${row.id} baseline: ${before.stderr}`);
                fs.writeFileSync(path.join(dir, row.file), row.after);
                const deleted = spawnSync(command, args, options);
                assert.strictEqual(deleted.status !== 0, row.breaks, `${row.id} deletion: ${deleted.stderr}`);
                fs.writeFileSync(path.join(dir, row.file), row.files[row.file]);
                const repaired = spawnSync(command, args, options);
                assert.strictEqual(repaired.status, 0, `${row.id} repaired: ${repaired.stderr}`);
            } finally { rm(dir); }
        }
    });
});

describe('fix #501: binding-aware runtime liveness', () => {
    const target = 'def _target():\n    return 7\n\ndef keep():\n    return 3\n';
    const rows = [
        ['patch', 'from unittest.mock import patch\ndef exercise():\n    with patch("app._target"): pass\n', true],
        ['patch alias', 'from unittest.mock import patch as replace\ndef exercise():\n    with replace("app._target"): pass\n', true],
        ['patch module alias', 'import unittest.mock as mock\ndef exercise():\n    with mock.patch("app._target"): pass\n', true],
        ['patch create', 'from unittest.mock import patch\ndef exercise():\n    with patch("app._target", create=True): pass\n', false],
        ['patch unrelated module', 'from unittest.mock import patch\ndef exercise():\n    with patch("other._target"): pass\n', false],
        ['ordinary string', 'NOTE="app._target"\n', false],
        ['monkeypatch', 'import pytest\ndef exercise():\n    with pytest.MonkeyPatch.context() as m:\n        m.setattr("app._target", lambda: 4)\n', true],
        ['monkeypatch optional', 'import pytest\ndef exercise():\n    with pytest.MonkeyPatch.context() as m:\n        m.setattr("app._target", lambda: 4, raising=False)\n', false],
        ['getattr import alias', 'import app\nfrom builtins import getattr as read\ndef exercise(): return read(app,"_target")()\n', true],
        ['getattr qualified', 'import app\nimport builtins\ndef exercise(): return builtins.getattr(app,"_target")()\n', true],
        ['getattr local alias', 'import app\nread=getattr\ndef exercise(): return read(app,"_target")()\n', true],
        ['getattr shadow', 'def getattr(*args): return lambda: 3\ndef exercise(): return getattr(None,"_target")()\n', false],
        ['getattr rebound alias', 'import app\nread=getattr\nread=lambda *args: (lambda: 3)\ndef exercise(): return read(app,"_target")()\n', false],
    ];
    for (const [label, use, live] of rows) it(label, () => {
        const dir = tmp({ 'app.py': target, 'use.py': use });
        try {
            const index = idx(dir);
            const answer = assess(index, '_target');
            assert.strictEqual(answer.verdict === 'no-static-dependents', !live, JSON.stringify(answer));
            assert.strictEqual(claimed(index).some(row => row.endsWith(':_target')), !live);
        } finally { rm(dir); }
    });
    for (const name of ['property', 'classmethod', 'staticmethod']) {
        it(`custom ${name} registers; builtin ${name} does not`, () => {
            for (const imported of [false, true]) {
                const dir = tmp({
                    'app.py': `${imported ? `from registry import register as ${name}\n` : ''}class Container:\n    @${name}\n    def _target(self): return 7\n`,
                    'registry.py': 'handlers=[]\ndef register(fn):\n    handlers.append(fn)\n    return fn\n',
                });
                try {
                    const answer = assess(idx(dir), '_target');
                    assert.strictEqual(answer.verdict, imported ? 'review' : 'no-static-dependents', JSON.stringify(answer));
                } finally { rm(dir); }
            }
        });
    }
    for (const name of ['getter', 'setter', 'deleter']) it(`custom ${name} registers`, () => {
        const dir = tmp({ 'app.py': `from registry import hook\n@hook.${name}\ndef _target(): return 7\n` });
        try { assert.strictEqual(assess(idx(dir), '_target').reason, 'registered'); } finally { rm(dir); }
    });
    for (const alias of ['object', 'Object', 'Generic', 'ExternalBase']) it(`external base aliased ${alias}`, () => {
        const dir = tmp({ 'app.py': `from external_engine import Base as ${alias}\nclass Container(${alias}):\n    def renderHook(self): return 7\n` });
        try { assert.strictEqual(assess(idx(dir), 'renderHook').reason, 'external-contract'); } finally { rm(dir); }
    });
    for (const base of ['object', 'Generic[T]']) it(`genuine ${base} remains clearable`, () => {
        const dir = tmp({ 'app.py': `from typing import Generic, TypeVar\nT=TypeVar("T")\nclass Container(${base}):\n    def renderHook(self): return 7\n` });
        try { assert.strictEqual(assess(idx(dir), 'renderHook').verdict, 'no-static-dependents'); } finally { rm(dir); }
    });
    const metadata = [
        ['pyproject.toml', '[project.scripts]\nsample="app:_target"\n'],
        ['pyproject.toml', '[project.gui-scripts]\nsample="app:_target"\n'],
        ['pyproject.toml', '[project.entry-points."sample.plugins"]\nsample="app:_target"\n'],
        ['setup.cfg', '[options.entry_points]\nconsole_scripts =\n    sample = app:_target\n'],
        ['setup.py', 'from setuptools import setup\nsetup(entry_points={"console_scripts":["sample=app:_target"]})\n'],
        ['pyproject.toml', '[project."scripts"]\nsample="app:_target"\n'],
        ['pyproject.toml', 'project.scripts = { sample = "app:_target" }\n'],
        ['pyproject.toml', '[project]\nscripts.sample = "app:_target"\n'],
        ['pyproject.toml', '[project.scripts]\nsample="""app:_target"""\n'],
        ['pyproject.toml', '[project.scripts]\nsample="app:_tar\\u0067et"\n'],
        ['setup.py', 'from setuptools import setup\nrows={"console_scripts":["sample=app:_target"]}\nsetup(entry_points=rows)\n'],
        ['setup.py', 'from setuptools import setup\nsetup(entry_points="""[console_scripts]\nsample=app:_target\n""")\n'],
    ];
    for (const [file, source] of metadata) it(`runtime entrypoint in ${file}: ${source.split('\n')[0]}`, () => {
        const dir = tmp({ 'app.py': target, [file]: source });
        try {
            const index = idx(dir);
            assert.strictEqual(assess(index, '_target').reason, 'runtime-entrypoint');
            assert.ok(!claimed(index).some(row => row.endsWith(':_target')));
            fs.writeFileSync(path.join(dir, file), source.replaceAll('app:', 'other:'));
            const current = file === 'setup.py' ? idx(dir) : index;
            assert.strictEqual(assess(current, '_target').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
    it('unread entrypoint expressions explicitly withhold deletion claims', () => {
        for (const [file, source] of [
            ['pyproject.toml', '[project]\ndynamic=["scripts"]\n'],
            ['setup.py', 'from setuptools import setup\nfrom config import entries\nsetup(entry_points=entries)\n'],
            ['setup.py', 'from setuptools import setup\nentries={"console_scripts":["sample=other:missing"]}\nentries["console_scripts"]=["sample=app:_target"]\nsetup(entry_points=entries)\n'],
        ]) {
            const dir = tmp({ 'app.py': target, [file]: source });
            try { assert.strictEqual(assess(idx(dir), '_target').reason, 'runtime-entrypoint'); } finally { rm(dir); }
        }
    });
    it('metadata-only additions and removals stay fresh on a live index', () => {
        const dir = tmp({ 'app.py': target });
        try {
            const index = idx(dir);
            assert.strictEqual(assess(index, '_target').verdict, 'no-static-dependents');
            fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project.scripts]\nsample="app:_target"\n');
            assert.deepStrictEqual(assess(index, '_target'), assess(idx(dir), '_target'));
            assert.strictEqual(assess(index, '_target').reason, 'runtime-entrypoint');
            fs.unlinkSync(path.join(dir, 'pyproject.toml'));
            assert.deepStrictEqual(assess(index, '_target'), assess(idx(dir), '_target'));
            assert.strictEqual(assess(index, '_target').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
    it('a property replaced before its accessor is a registration boundary', () => {
        const dir = tmp({ 'app.py': 'from registry import hook\nclass Container:\n    @property\n    def value(self): return 1\n    value=hook\n    @value.getter\n    def _target(self): return 7\n' });
        try { assert.strictEqual(assess(idx(dir), '_target').reason, 'registered'); } finally { rm(dir); }
    });
    for (const body of [
        'function exercise(key) { return item[key](); }',
        'function exercise({key}) { return item[key](); }',
        'function exercise() { const {key}=object; return item[key](); }',
        'function exercise() { try {} catch(key) { return item[key](); } }',
        'function exercise() { for (const key of keys) { item[key](); } }',
        'function exercise() { { var key="other"; } return item[key](); }',
        'function exercise() { return item[key](); function key() {} }',
    ]) it(`a nearer binding cannot borrow an outer const key: ${body}`, () => {
        const dir = tmp({ 'app.js': `class Container { _target() {} }\nconst item=new Container();\nconst key="_target";\n${body}\n` });
        try {
            const index = idx(dir);
            assert.ok(!index.getCachedCalls(path.join(dir, 'app.js')).some(call => call.name === '_target'), 'unknown key is not an exact named call');
        } finally { rm(dir); }
    });
    it('native Python witnesses judge registration, patch targets and packaging entrypoints', t => {
        const { spawnSync } = require('child_process');
        const python = process.env.PYTHON || 'python3';
        const version = spawnSync(python, ['--version'], { encoding: 'utf8' });
        if (version.error) { t.skip('Python runtime unavailable; native witnesses require python3'); return; }
        const witnesses = [
            { label: 'patch', files: { 'app.py': target, 'use.py': 'from unittest.mock import patch\ndef exercise():\n    with patch("app._target", return_value=4) as mocked: assert mocked()==4\n' },
                run: 'from use import exercise; exercise()', after: 'def keep(): return 3\n', breaks: true },
            { label: 'patch create control', files: { 'app.py': target, 'use.py': 'from unittest.mock import patch\ndef exercise():\n    with patch("app._target", return_value=4, create=True) as mocked: assert mocked()==4\n' },
                run: 'from use import exercise; exercise()', after: 'def keep(): return 3\n', breaks: false },
            { label: 'custom decorator', files: {
                'registry.py': 'handlers=[]\ndef property(fn):\n    handlers.append(fn)\n    return fn\ndef run(): return sum(fn() for fn in handlers)\n',
                'app.py': 'from registry import property\n@property\ndef _target(): return 7\n' },
                run: 'import app; from registry import run; assert run()==7', after: 'from registry import property\n', breaks: true },
            { label: 'TOML loader', files: { 'app.py': target, 'pyproject.toml': 'project.scripts = { sample="app:_tar\\u0067et" }\n' },
                run: 'import tomllib; from pathlib import Path; from importlib.metadata import EntryPoint; value=tomllib.loads(Path("pyproject.toml").read_text())["project"]["scripts"]["sample"]; assert EntryPoint(name="sample",value=value,group="console_scripts").load()()==7',
                after: 'def keep(): return 3\n', breaks: true },
            { label: 'INI loader', files: { 'app.py': target, 'setup.cfg': '[options.entry_points]\nconsole_scripts=\n sample=app:_target\n' },
                run: 'from configparser import ConfigParser; from importlib.metadata import EntryPoint; p=ConfigParser(); p.read("setup.cfg"); value=p["options.entry_points"]["console_scripts"].split("=",1)[1].strip(); assert EntryPoint(name="sample",value=value,group="console_scripts").load()()==7',
                after: 'def keep(): return 3\n', breaks: true },
        ];
        for (const witness of witnesses) {
            const dir = tmp(witness.files);
            try {
                const options = { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } };
                const before = spawnSync(python, ['-B', '-c', witness.run], options);
                assert.strictEqual(before.status, 0, `${witness.label} baseline: ${before.stderr}`);
                assert.strictEqual(assess(idx(dir), '_target').verdict === 'no-static-dependents', !witness.breaks, witness.label);
                fs.writeFileSync(path.join(dir, 'app.py'), witness.after);
                const after = spawnSync(python, ['-B', '-c', witness.run], options);
                assert.strictEqual(after.status !== 0, witness.breaks, `${witness.label} deletion: ${after.stderr}`);
            } finally { rm(dir); }
        }
    });
    for (const expression of ['item["_target"]()', 'new Container()["_target"]()',
        'item["_tar\\u0067et"]()', 'item["\\137target"]()', 'item[key]()']) it(`ordinary bracket call: ${expression}`, () => {
        const dir = tmp({ 'app.js': `class Container { _target() { return 7; } }\nconst item=new Container();\nconst key="_target";\nfunction exercise() { return ${expression}; }\n` });
        try {
            const index = idx(dir);
            assert.notStrictEqual(assess(index, '_target').verdict, 'no-static-dependents');
            assert.ok(!claimed(index).some(row => row.endsWith(':_target')));
            assert.ok(index.getCachedCalls(path.join(dir, 'app.js')).some(call => call.name === '_target'));
            const { spawnSync } = require('child_process');
            fs.appendFileSync(path.join(dir, 'app.js'), '\nmodule.exports.exercise=exercise;\n');
            const args = ['-e', 'if(require("./app.js").exercise()!==7)throw Error("wrong result")'];
            const before = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
            assert.strictEqual(before.status, 0, before.stderr);
            const source = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            fs.writeFileSync(path.join(dir, 'app.js'), source.replace('class Container { _target() { return 7; } }', 'class Container {}'));
            const after = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
            assert.notStrictEqual(after.status, 0);
            assert.match(after.stderr, /TypeError/);
        } finally { rm(dir); }
    });
    it('dynamic member of a constructed class is review, unrelated classes stay clearable', () => {
        const dir = tmp({ 'app.js': 'class Container { _target() { return 7; } }\nclass Other { unused() {} }\nfunction exercise(key) { return new Container()[key](); }\n' });
        try {
            const index = idx(dir);
            assert.strictEqual(assess(index, '_target').reason, 'reflection');
            assert.strictEqual(assess(index, 'unused').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
    it('first use belongs to the selected definition, or no proven site is claimed', () => {
        const dir = tmp({ 'a.py': target, 'b.py': target,
            'a_wrong.py': 'from b import _target\ndef wrong(): return _target()\n',
            'z_right.py': 'from a import _target\ndef right(): return _target()\n' });
        try {
            const answer = assess(idx(dir), '_target', 'a.py');
            assert.strictEqual(answer.site.file, 'z_right.py');
            fs.unlinkSync(path.join(dir, 'z_right.py'));
            const second = assess(idx(dir), '_target', 'a.py');
            assert.strictEqual(second.verdict, 'review');
            assert.strictEqual(second.reason, 'unresolved-use');
            assert.strictEqual(second.site, undefined);
        } finally { rm(dir); }
    });
    it('reflection identity and computed calls survive cache load and source rebuild', () => {
        const dir = tmp({ 'app.py': target, 'use.py': 'import app\nfrom builtins import getattr as read\ndef exercise(): return read(app,"_target")()\n' });
        try {
            const fresh = idx(dir);
            const expected = assess(fresh, '_target');
            fresh.saveCache();
            const loaded = new ProjectIndex(dir, { quiet: true });
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(assess(loaded, '_target'), expected);
            fs.writeFileSync(path.join(dir, 'use.py'), 'NOTE="_target"\n');
            loaded.build();
            assert.strictEqual(assess(loaded, '_target').verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
    it('registration identity survives worker serialization, cache load and deletion', () => {
        const files = { 'app.py': 'class Container:\n    @property\n    def quiet(self): return 7\n\nfrom registry import register as property\n@property\ndef _target(): return 7\n',
            'registry.py': 'def register(fn): return fn\n' };
        // The module rebinds property: use a separate file for the genuine builtin.
        files['builtin.py'] = 'class Container:\n    @property\n    def quiet(self): return 7\n';
        files['nested.py'] = 'class Outer:\n    class Inner:\n        @staticmethod\n        def __target(): return 7\n';
        files['pyproject.toml'] = '[project.scripts]\nrun = "nested:Outer.Inner._Inner__target"\n';
        for (let i = 0; i < 8; i++) files[`f${i}.py`] = `def f${i}(): return ${i}\n`;
        const dir = tmp(files);
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true, workers: 2 });
            assert.strictEqual(index.lastBuildParallelEligible, true);
            const quiet = index.symbols.get('quiet').find(def => def.relativePath === 'builtin.py');
            const target = index.symbols.get('_target')[0];
            assert.strictEqual(quiet.registrationUnknown, false);
            assert.strictEqual(target.registrationUnknown, true);
            const nested = index.symbols.get('__target')[0];
            assert.deepStrictEqual(nested.runtimeOwnerPath, ['Outer', 'Inner']);
            index.saveCache();
            const loaded = new ProjectIndex(dir, { quiet: true });
            assert.ok(loaded.loadCache());
            assert.strictEqual(loaded.symbols.get('_target')[0].registrationUnknown, true);
            assert.strictEqual(loaded.symbols.get('quiet').find(def => def.relativePath === 'builtin.py').registrationUnknown, false);
            assert.deepStrictEqual(loaded.symbols.get('__target')[0].runtimeOwnerPath, ['Outer', 'Inner']);
            fs.writeFileSync(path.join(dir, 'app.py'), 'from registry import register as property\n');
            assert.strictEqual(assessDeletion(idx(dir), JSON.parse(JSON.stringify(target))).reason, 'registered');
            fs.writeFileSync(path.join(dir, 'nested.py'), 'class Outer:\n    class Inner:\n        pass\n');
            assert.strictEqual(assessDeletion(idx(dir), JSON.parse(JSON.stringify(nested))).verdict, 'review');
        } finally { rm(dir); }
    });
});

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
            const params = { name: 'svc.py:2:_run', delete: true };
            const text = output.formatPublicText('plan', execute(index, 'plan', params).result, params);
            assert.match(text, /VERDICT: has-static-dependents\n {2}basis: a call is proven to reach this declaration from outside it\n {2}first use: svc\.py:7\n/);
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
            // The other direction: a trait member is held by the impl that
            // is written against the trait by name, required or defaulted.
            // With it gone, `impl Contract for Impl { fn rust_slot }` is a
            // method that is not a member of the trait.
            for (const name of ['rust_slot', 'defaulted']) {
                const requirement = (index.symbols.get(name) || []).find(def =>
                    def.relativePath === 'tr.rs' && def.className === 'Contract');
                const answer = assessDeletion(index, requirement);
                assert.deepStrictEqual([answer.verdict, answer.reason], ['review', 'required-slot'], name);
            }
            const listed = claimed(index);
            assert.ok(!listed.some(row => /:(area|slot|goSlot|rust_slot|defaulted)$/.test(row) &&
                !/shape\.ts:1:|base\.py:6:|contract\.go:4:/.test(row)), listed.join(' '));
            // Three implementations and the two trait members.
            assert.strictEqual(deadcode(index, {}).excludedRequiredSlot, 5);
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
            assert.strictEqual(sameLine.verdict, 'review');
            assert.strictEqual(sameLine.reason, 'unresolved-use');
        } finally { rm(dir); }
    });

    it('a whole file that is gone: each declaration by what still names it', () => {
        const dir = tmp({
            'package.json': '{"name":"gone-file"}',
            '.ucn.json': '{"kind":"application"}',
            'gone.ts': [
                'export interface Contract { slot(): number; }',
                'export class Impl implements Contract {',
                '    slot() { return 1; }',
                '}',
                'export function helper() { return 2; }',
                'export function unused() { return 3; }',
            ].join('\n'),
            'keep.ts': 'import { helper } from "./gone";\nconsole.log(helper());',
        });
        try {
            const before = idx(dir);
            const saved = (name, className) => JSON.parse(JSON.stringify(
                (before.symbols.get(name) || []).find(definition =>
                    definition.relativePath === 'gone.ts' && (definition.className || null) === className)));
            const records = { slot: saved('slot', 'Impl'), helper: saved('helper', null), unused: saved('unused', null) };
            const fileEntry = before.files.get(path.join(dir, 'gone.ts'));
            // While the file stands, the interface holds the member.
            assert.strictEqual(assessDeletion(before, records.slot).reason, 'required-slot');
            fs.rmSync(path.join(dir, 'gone.ts'));
            const after = idx(dir);
            // Still imported and called from a file that stayed.
            const helper = assessDeletion(after, records.helper, { fileEntry });
            assert.deepStrictEqual([helper.verdict, helper.reason, helper.site],
                ['has-static-dependents', 'has-usages', { file: 'keep.ts', line: 1 }]);
            // Named by nothing that stayed.
            assert.strictEqual(assessDeletion(after, records.unused, { fileEntry }).verdict, 'no-static-dependents');
            // Its owner type and the interface went with the file: nothing
            // left in the snapshot can require it.
            assert.strictEqual(assessDeletion(after, records.slot, { fileEntry }).verdict, 'no-static-dependents');
        } finally { rm(dir); }
    });
});

describe('deletion: members held in place by a contract nothing names', () => {
    // eval/deletion-matrix-cases.js: one declaration per case that no call
    // and no reference names. `expect` is what the language's own toolchain
    // says about deleting it (judged by eval/run-deletion-matrix.js, not
    // here); `answer` is the engine's. Each case is asked three ways: in
    // place, after the declaration is deleted with the file facts of the
    // revision it came from, and from the saved record alone.
    const answerOf = assessment => `${assessment.verdict}/${assessment.reason}`;
    for (const testCase of CASES) {
        it(`${testCase.id}: ${testCase.answer}`, () => {
            const dir = tmp({});
            try {
                const target = materialize(testCase, dir);
                const before = idx(dir);
                const definitions = (before.symbols.get(testCase.name) || []).filter(definition =>
                    definition.relativePath === target.file &&
                    definition.startLine >= target.from && definition.startLine <= target.to);
                assert.strictEqual(definitions.length, 1, 'the marked lines hold one declaration');
                const inPlace = assessDeletion(before, definitions[0]);
                const record = JSON.parse(JSON.stringify(definitions[0]));
                const fileEntry = before.files.get(definitions[0].file);

                deleteTarget(dir, target);
                const after = idx(dir);
                const remaining = (after.symbols.get(testCase.name) || []).length;
                const deleted = assessDeletion(after, record, { fileEntry });
                const recordOnly = assessDeletion(after, record);

                assert.strictEqual(answerOf(inPlace), testCase.answer, 'in place');
                // A declaration that is gone is asked about as if it still
                // stood in its owner: the answer may not change because the
                // text did.
                assert.strictEqual(answerOf(deleted), testCase.answer, 'deleted, with its file facts');
                assert.strictEqual(answerOf(recordOnly), testCase.answer, 'deleted, from the record alone');
                assert.strictEqual(deleted.indexed, false);
                // Standing it back in its owner is temporary: the index
                // holds what it held before the question.
                assert.strictEqual((after.symbols.get(testCase.name) || []).length, remaining);
            } finally { rm(dir); }
        });
    }

    it('never clears a deletion the toolchain rejects', () => {
        const rejected = CASES.filter(testCase => testCase.expect === 'break');
        assert.ok(rejected.length >= 40, `${rejected.length} rejected deletions on the board`);
        for (const testCase of rejected) {
            assert.ok(!testCase.answer.startsWith('no-static-dependents/'), testCase.id);
        }
        // Every language has both a deletion its toolchain rejects and one
        // it accepts and the engine clears: withholding everything would
        // pass the first half of this test and fail the second.
        for (const lang of new Set(CASES.map(testCase => testCase.lang))) {
            const ofLang = CASES.filter(testCase => testCase.lang === lang);
            assert.ok(ofLang.some(testCase => testCase.expect === 'break'), `${lang}: a rejected deletion`);
            assert.ok(ofLang.some(testCase => testCase.expect === 'clean' &&
                testCase.answer === 'no-static-dependents/claimed'), `${lang}: a cleared deletion`);
        }
    });

    it('a deleted member with two candidate owners is not guessed at', () => {
        const dir = tmp({
            'package.json': '{"name":"two-owners"}',
            '.ucn.json': '{"kind":"application"}',
            'a.ts': [
                'namespace One { export class Box { slot() { return 1; } } }',
                'namespace Two { export class Box { other() { return 2; } } }',
            ].join('\n'),
        });
        try {
            const before = idx(dir);
            const slot = (before.symbols.get('slot') || [])[0];
            assert.ok(slot && slot.className === 'Box');
            const record = JSON.parse(JSON.stringify(slot));
            fs.writeFileSync(`${dir}/a.ts`, [
                'namespace One { export class Box { } }',
                'namespace Two { export class Box { other() { return 2; } } }',
            ].join('\n'));
            const answer = assessDeletion(idx(dir), record);
            assert.deepStrictEqual([answer.verdict, answer.reason], ['review', 'owner-ambiguous']);
        } finally { rm(dir); }
    });
});

describe('deletion: the requirement fact is read from syntax', () => {
    // `requiredMember`: a member a subtype or a structural satisfier must
    // supply. Never inferred from the text of the declaration: an object
    // type in a signature has braces, an optional member has none.
    const files = {
        'package.json': '{"name":"requirement-facts"}',
        'a.ts': [
            'interface Contract {',
            '    slot(): { value: number };',
            '    opt?(): void;',
            '    prop: () => void;',
            '    note?: string;',
            '}',
            'abstract class Base {',
            '    abstract run(): void;',
            '    plain() {}',
            '}',
            'type Alias = { aliased(): void; maybe?(): void };',
        ].join('\n'),
        'A.java': [
            'interface Contract {',
            '    void slot();',
            '    default void dflt() {}',
            '    static void stat() {}',
            '}',
            'abstract class Base {',
            '    abstract void run();',
            '    void plain() {}',
            '}',
        ].join('\n'),
        'a.cs': [
            'interface IContract {',
            '    void Slot();',
            '    void Dflt() { }',
            '    int Value { get; }',
            '    int Calc => 1;',
            '}',
            'abstract class Base {',
            '    public abstract void Run();',
            '    public virtual void Virt() { }',
            '}',
        ].join('\n'),
        'a.rs': [
            'trait Contract {',
            '    fn slot(&self);',
            '    fn provided(&self) {}',
            '}',
        ].join('\n'),
        'a.go': [
            'package facts',
            '',
            'type contract interface {',
            '\tgoSlot()',
            '}',
            '',
            'type impl struct{}',
            '',
            'func (impl) goSlot() {}',
        ].join('\n'),
        'a.py': [
            'from abc import ABC, abstractmethod',
            'from typing import Protocol',
            'import typing',
            'from typing import Protocol as Shape',
            'class Greeter(Protocol):',
            '    def greet(self) -> str: ...',
            '',
            'class Generic(typing.Protocol[int]):',
            '    def hello(self) -> str:',
            '        return "x"',
            '',
            'class Base(ABC):',
            '    @abstractmethod',
            '    def run(self): ...',
            '    def plain(self): pass',
            '',
            'class English(Greeter):',
            '    def greet(self) -> str:',
            '        return "hi"',
            '',
            'class Aliased(Shape):',
            '    def shaped(self) -> str: ...',
        ].join('\n'),
        'a.cpp': [
            'struct Shape {',
            '    virtual double area() const = 0;',
            '    virtual void draw();',
            '    virtual ~Shape() = 0;',
            '    void plain() {}',
            '    int count = 0;',
            '};',
        ].join('\n'),
    };
    const REQUIRED = [
        'A.java:2:slot', 'A.java:7:run',
        'a.cpp:2:area',
        'a.cs:2:Slot', 'a.cs:4:Value', 'a.cs:8:Run',
        'a.go:4:goSlot',
        'a.py:13:run', 'a.py:22:shaped', 'a.py:6:greet', 'a.py:9:hello',
        'a.rs:2:slot',
        'a.ts:11:aliased', 'a.ts:2:slot', 'a.ts:4:prop', 'a.ts:8:run',
    ];
    const requiredIn = index => {
        const rows = [];
        for (const definitions of index.symbols.values()) {
            for (const definition of definitions) {
                if (definition.requiredMember) {
                    rows.push(`${definition.relativePath}:${definition.startLine}:${definition.name}`);
                }
            }
        }
        return rows.sort();
    };

    it('marks requirements and nothing else, in every language', () => {
        const dir = tmp(files);
        try {
            // Not marked: optional signatures, default-bodied interface and
            // trait members, static interface methods, concrete members of
            // an abstract class, a method that implements a protocol, a
            // virtual that is not pure, a destructor, a data member.
            assert.deepStrictEqual(requiredIn(idx(dir)), REQUIRED);
        } finally { rm(dir); }
    });

    it('a Python protocol class is known as one, an implementation of it is not', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const protocols = [...index.symbols.values()].flat()
                .filter(definition => definition.protocolClass).map(definition => definition.name).sort();
            // `Aliased(Shape)`: Shape is `Protocol` under an import alias.
            // `English(Greeter)` inherits from a protocol and is a class.
            assert.deepStrictEqual(protocols, ['Aliased', 'Generic', 'Greeter']);
        } finally { rm(dir); }
    });

    it('survives a parallel build and a cache round trip', () => {
        const dir = tmp(files);
        try {
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.strictEqual(parallel.lastBuildParallelEligible, true);
            assert.deepStrictEqual(requiredIn(parallel), REQUIRED);
            const protocols = index => [...index.symbols.values()].flat()
                .filter(definition => definition.protocolClass).map(definition => definition.name).sort();
            assert.deepStrictEqual(protocols(parallel), ['Aliased', 'Generic', 'Greeter']);
            parallel.saveCache();
            const reloaded = new ProjectIndex(dir);
            assert.ok(reloaded.loadCache(), 'cache should load');
            assert.deepStrictEqual(requiredIn(reloaded), REQUIRED);
            assert.deepStrictEqual(protocols(reloaded), ['Aliased', 'Generic', 'Greeter']);
        } finally { rm(dir); }
    });
});

describe('deletion: plan --delete', () => {
    it('answers through the public command, in text and JSON', () => {
        const dir = tmp({
            'package.json': '{"name":"plan-delete"}',
            'lib.js': 'function used() { return 1; }\nfunction unused() { return 2; }\nmodule.exports = { run: () => used() };',
        });
        try {
            const index = idx(dir);
            const done = execute(index, 'plan', { name: 'unused', delete: true });
            assert.ok(done.ok, done.error);
            assert.strictEqual(done.result.operation, 'delete');
            assert.strictEqual(done.result.verdict, 'no-static-dependents');
            const text = output.formatPublicText('plan', done.result, { name: 'unused', delete: true });
            assert.match(text, /^Deletion assessment: unused\n/);
            assert.match(text, /lib\.js:2 {2}\(function\)/);
            assert.match(text, /VERDICT: no-static-dependents\n {2}basis: /);
            const json = JSON.parse(output.formatPublicJson('plan', done.result,
                { name: 'unused', delete: true }, { ...done, surface: 'cli' }));
            assert.strictEqual(json.data.verdict, 'no-static-dependents');
            assert.strictEqual(json.data.safeToDelete, false);

            const used = execute(index, 'plan', { name: 'used', delete: true }).result;
            assert.strictEqual(used.verdict, 'has-static-dependents');
            assert.match(output.formatPublicText('plan', used, { name: 'used', delete: true }),
                /next: ucn show lib\.js:1:used lists the callers/);
            // The handle form pins the declaration.
            const pinned = execute(index, 'plan', { name: 'lib.js:2:unused', delete: true });
            assert.strictEqual(pinned.result.declaration.startLine, 2);
        } finally { rm(dir); }
    });

    it('says which declaration a bare name selected, and the others it could mean', () => {
        const dir = tmp({
            'package.json': '{"name":"plan-delete-ambiguous"}',
            'a.js': 'function spare() { return 1; }\nfunction keep() { return 2; }\nkeep();',
            'b.js': 'export function spare() { return 3; }',
        });
        try {
            const index = idx(dir);
            const params = { name: 'spare', delete: true };
            const done = execute(index, 'plan', params);
            assert.ok(done.ok, done.error);
            // The verdict is about a.js:1 only. Without the note it reads
            // as an answer about every `spare`.
            assert.strictEqual(done.result.declaration.file, 'a.js');
            assert.strictEqual(done.result.verdict, 'no-static-dependents');
            assert.strictEqual(done.result.warnings.length, 1);
            assert.deepStrictEqual(done.result.warnings[0].alternatives, [{ file: 'b.js', line: 1 }]);
            const text = output.formatPublicText('plan', done.result, params);
            assert.match(text, /a\.js:1 {2}\(function\)\nNote: Found 2 definitions for "spare"\. Using a\.js:1\. Also in: b\.js:1\. Use file= to disambiguate\.\nVERDICT: /);
            const json = JSON.parse(output.formatPublicJson('plan', done.result, params, { ...done, surface: 'cli' }));
            assert.deepStrictEqual(json.data.warnings[0].alternatives, [{ file: 'b.js', line: 1 }]);
            // A handle that pins one declaration has nothing to disclose.
            const pinned = execute(index, 'plan', { name: 'a.js:1:spare', delete: true });
            assert.strictEqual(pinned.result.warnings, undefined);
        } finally { rm(dir); }
    });

    it('is one operation: it cannot be combined, and plan still needs one', () => {
        const dir = tmp({ 'package.json': '{}', 'lib.js': 'function f() {}\n' });
        try {
            const index = idx(dir);
            const both = execute(index, 'plan', { name: 'f', delete: true, renameTo: 'g' });
            assert.strictEqual(both.ok, false);
            assert.match(both.error, /exactly one operation/);
            const none = execute(index, 'plan', { name: 'f' });
            assert.strictEqual(none.ok, false);
            assert.match(none.error, /delete/);
            const missing = execute(index, 'plan', { name: 'nope', delete: true });
            assert.strictEqual(missing.ok, false);
        } finally { rm(dir); }
    });
});
