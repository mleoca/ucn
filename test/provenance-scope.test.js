'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmp, rm, idx } = require('./helpers');
const { classKeyOf } = require('../core/class-identity');
const { factIndex, captureOverload, validateOverload, provenanceWork, fileSymbolFact } = require('../core/provenance-overload');
const { declarationIdentity } = require('../core/provenance');
const { selectProvenanceOverload } = require('../core/callers');

describe('fix #471: scope witnesses retain relevant declarations and replay independently', () => {
    it('a projection keeps the declaration visibility of its witness view', () => {
        const file = 'unit.cs', symbols = [{ name: 'Local', type: 'class' }];
        const live = { files: new Map([[file, { language: 'csharp', symbols }]]) };
        const project = view => fileSymbolFact(view, file, 'scope-test', values => values?.map(value => value.name));
        for (const fields of [undefined, ['language'], ['language', 'symbols']]) {
            const reads = {}, view = factIndex(reads, live, fields);
            const expected = fields?.includes('symbols') ? ['Local'] : undefined;
            assert.deepEqual(project(view), expected);
            assert.deepEqual(project(factIndex(JSON.parse(JSON.stringify(reads)), undefined, fields)), expected);
        }
        let observed;
        captureOverload(live, {}, [], 'csharp', view => {
            observed = project(view);
            return { match: null };
        });
        assert.equal(observed, undefined, 'an overload view still omits these declarations');
    });
    const scopes = {
        'js': 'function first() {\n class Inner {}\n}\nfunction second() {\n class Inner {}\n}\n',
        'py': 'def first():\n    class Inner:\n        pass\ndef second():\n    class Inner:\n        pass\n',
        'java': 'class Outer {\n void first() {\n  class Inner {}\n }\n void second() {\n  class Inner {}\n }\n}\n',
        'cs': 'class Outer {\n class Inner {}\n}\nclass Other {\n class Inner {}\n}\n',
        'cpp': 'void first() {\n struct Inner {};\n}\nvoid second() {\n struct Inner {};\n}\n',
        'go': 'package p\nfunc first() {\n type Inner struct{}\n}\nfunc second() {\n type Inner struct{}\n}\n',
        'rs': 'fn first() {\n struct Inner;\n}\nfn second() {\n struct Inner;\n}\n',
    };
    for (const [extension, source] of Object.entries(scopes)) {
        it(`${extension}: same-name declarations in separate scopes keep separate identities`, () => {
            const dir = tmp({ [`scopes.${extension}`]: source });
            try {
                const index = idx(dir);
                const definitions = index.symbols.get('Inner').filter(def => ['class', 'struct'].includes(def.type));
                assert.equal(definitions.length, 2);
                const keys = definitions.map(def => classKeyOf(index, def));
                assert.notEqual(keys[0], keys[1]);
                index._beginOp();
                try {
                    for (const [i, definition] of definitions.entries()) {
                        const reads = {};
                        assert.equal(classKeyOf(factIndex(reads, index, ['language', 'symbols']), definition), keys[i]);
                        const copy = JSON.parse(JSON.stringify(reads));
                        assert.equal(classKeyOf(factIndex(copy, undefined, ['language', 'symbols']), definition), keys[i]);
                        const key = Object.keys(copy).find(key => key.startsWith('fact:["containing-declarations"'));
                        assert.ok(key);
                        assert.ok(copy[key].every(candidate => candidate.startLine <= definition.startLine &&
                            candidate.endLine >= definition.endLine));
                        delete copy[key];
                        assert.throws(() => classKeyOf(factIndex(copy, undefined, ['language', 'symbols']), definition),
                            /Missing provenance fact/);
                    }
                } finally { index._endOp(); }
            } finally { rm(dir); }
        });
    }

    function overload(n) {
        const dir = tmp({ 'Fixture.java': [
            'class Fixture {',
            ' static void pick(String s) {}',
            ' static void pick(int n) {}',
            ' static void run(String value) { pick(value); }',
            ' static <T> T generic(T value) { return value; }',
            ...Array.from({ length: n }, (_, i) => ` static int unused${i}(int n) { return n; }`),
            '}',
        ].join('\n') });
        try {
            const index = idx(dir);
            const call = { ...index.getCachedCalls(path.join(dir, 'Fixture.java')).find(call => call.name === 'pick'),
                argumentFile: 'Fixture.java' };
            index._beginOp();
            try {
                const before = provenanceWork();
                const witness = captureOverload(index, call, index.symbols.get('pick'), 'java', selectProvenanceOverload);
                return { witness, members: index.symbols.get('pick').map(declarationIdentity),
                    encoded: provenanceWork().encodedNodes - before.encodedNodes };
            } finally { index._endOp(); }
        } finally { rm(dir); }
    }

    it('unrelated methods do not enlarge a type-scope proof', () => {
        const small = overload(10), large = overload(200);
        assert.equal(small.witness.selected.startLine, 2);
        assert.equal(large.witness.selected.startLine, 2);
        assert.ok(large.encoded <= small.encoded * 1.1, `${small.encoded} -> ${large.encoded}`);
        const key = Object.keys(large.witness.reads).find(key => key.startsWith('fact:java-type-scope\0'));
        assert.deepEqual(large.witness.reads[key].map(def => def.name), ['Fixture', 'generic']);
    });

    it('copied overload proofs require the captured type scope, including generic name shadows', () => {
        const { witness, members } = overload(20);
        const copy = () => JSON.parse(JSON.stringify(witness));
        assert.equal(validateOverload(copy(), members, witness.selected), true);
        const key = Object.keys(witness.reads).find(key => key.startsWith('fact:java-type-scope\0'));
        const missing = copy();
        delete missing.reads[key];
        assert.equal(validateOverload(missing, members, witness.selected), false);
        const shadowed = copy();
        shadowed.reads[key].find(def => def.name === 'generic').generics = '<String>';
        assert.equal(validateOverload(shadowed, members, witness.selected), false);
    });
});

describe('fix #471: Java lexical type owners are source-bound syntax facts', () => {
    it('reuses immutable spans only for the same source, offset and line', () => {
        const { typeNameOwnersAt } = require('../languages/java-unicode');
        const source = 'class Outer {\n class Inner {\n  void run() { int value = 1; }\n }\n}\n';
        const site = { start: source.indexOf('int value'), line: 3 };
        assert.equal(typeNameOwnersAt(source, { ...site, line: String(site.line) }), null);
        const owners = typeNameOwnersAt(source, site);
        assert.equal(owners.length, 2);
        assert.equal(typeNameOwnersAt(source, site), owners);
        assert.ok(Object.isFrozen(owners) && owners.every(Object.isFrozen));
        assert.equal(typeNameOwnersAt(source, { ...site, line: 4 }), null);
        const changed = `// shifted\n${source}`;
        assert.equal(typeNameOwnersAt(changed, site), null);
        const moved = typeNameOwnersAt(changed, { start: site.start + 11, line: 4 });
        assert.deepEqual(moved, owners.map(owner => ({ start: owner.start + 11, end: owner.end + 11 })));
    });

    it('anonymous owners and malformed sources remain unknown', () => {
        const { typeNameOwnersAt } = require('../languages/java-unicode');
        for (const source of [
            'class Outer { Object value = new Object() { void run() { int value = 1; } }; }',
            'class Outer { void run() { int value = ; } }',
        ]) {
            const site = { start: source.indexOf('int value'), line: 1 };
            assert.equal(typeNameOwnersAt(source, site), null);
            assert.equal(typeNameOwnersAt(source, site), null);
        }
    });
});
