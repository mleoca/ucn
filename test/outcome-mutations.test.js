'use strict';

/**
 * Unit tests for eval/outcome-mutations.js: the seeded source mutations of
 * the task-outcome eval. Every mutation must land where the grammar puts the
 * header and the body, leave a tree without parse errors, and report its own
 * edit range.
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const mutations = require('../eval/outcome-mutations');
const { getParser, safeParse } = require('../languages');

const SOURCES = {
    python: {
        file: 'pkg/mod.py',
        content: [
            'class Store:',
            '    def get(self, key):',
            '        """Doc."""',
            '        return self.rows[key]',
            '',
            '',
            'def plain(a, b=1):',
            '    return a + b',
            '',
            '',
            'def typed(a: int) -> int:',
            '    return a',
            '',
            '',
            'def oneliner(a): return a',
            '',
            '',
            'def kwonly(*, session):',
            '    return session',
            '',
        ].join('\n'),
        defs: {
            get: { name: 'get', nameLine: 2, startLine: 2, endLine: 4, className: 'Store' },
            plain: { name: 'plain', nameLine: 7, startLine: 7, endLine: 8 },
            typed: { name: 'typed', nameLine: 11, startLine: 11, endLine: 12 },
            oneliner: { name: 'oneliner', nameLine: 15, startLine: 15, endLine: 15 },
            kwonly: { name: 'kwonly', nameLine: 18, startLine: 18, endLine: 19 },
        },
    },
    go: {
        file: 'pkg/mod.go',
        content: [
            'package pkg',
            '',
            'type T struct{}',
            '',
            'func (t *T) Get(key string) (string, error) {',
            '\treturn key, nil',
            '}',
            '',
            'func helper() int {',
            '\treturn 1',
            '}',
            '',
        ].join('\n'),
        defs: {
            Get: { name: 'Get', nameLine: 5, startLine: 5, endLine: 7, className: 'T' },
            helper: { name: 'helper', nameLine: 9, startLine: 9, endLine: 11 },
        },
    },
    rust: {
        file: 'src/lib.rs',
        content: [
            'pub struct S;',
            '',
            'impl S {',
            '    pub fn get(&self, key: &str) -> String {',
            '        key.to_string()',
            '    }',
            '}',
            '',
            'fn helper(a: i32) -> i32 {',
            '    a',
            '}',
            '',
        ].join('\n'),
        defs: {
            get: { name: 'get', nameLine: 4, startLine: 4, endLine: 6, className: 'S' },
            helper: { name: 'helper', nameLine: 9, startLine: 9, endLine: 11 },
        },
    },
    java: {
        file: 'src/pkg/D.java',
        content: [
            'package pkg;',
            '',
            'public class D {',
            '    public int get(int key) {',
            '        return key;',
            '    }',
            '',
            '    private static int helper() {',
            '        return 1;',
            '    }',
            '}',
            '',
        ].join('\n'),
        defs: {
            get: { name: 'get', nameLine: 4, startLine: 4, endLine: 6, className: 'D' },
            helper: { name: 'helper', nameLine: 8, startLine: 8, endLine: 10, className: 'D' },
        },
    },
};

function input(language, defName) {
    const source = SOURCES[language];
    return {
        language,
        relativePath: source.file,
        content: source.content,
        def: defName ? source.defs[defName] : null,
    };
}

function parsesCleanly(language, content) {
    return !safeParse(getParser(language), content).rootNode.hasError;
}

function line(result, number) {
    return result.files[0].content.split('\n')[number - 1];
}

describe('outcome-mutations: body edits', () => {
    it('inserts an inert statement before the first body statement', () => {
        const expected = {
            python: ['get', 3, '        pass'],
            go: ['Get', 6, '\t_ = 0'],
            rust: ['get', 5, '        let _ = 0;'],
            java: ['get', 5, '        ;'],
        };
        for (const [language, [def, row, text]] of Object.entries(expected)) {
            const result = mutations.inertBodyEdit(input(language, def));
            assert.ok(result, language);
            assert.strictEqual(line(result, row), text, language);
            assert.deepStrictEqual(result.changedRanges,
                [{ file: SOURCES[language].file, startLine: row, endLine: row }], language);
            assert.ok(parsesCleanly(language, result.files[0].content), language);
        }
    });

    it('declines a body that shares its header line', () => {
        assert.strictEqual(mutations.inertBodyEdit(input('python', 'oneliner')), null);
    });

    it('a generator transition exists only where a template and no annotation do', () => {
        const result = mutations.generatorTransition(input('python', 'plain'));
        assert.strictEqual(line(result, 8), '    yield None');
        assert.ok(parsesCleanly('python', result.files[0].content));
        // An annotated callable would report the mismatch on its own header.
        assert.strictEqual(mutations.generatorTransition(input('python', 'typed')), null);
        for (const language of ['go', 'rust', 'java']) {
            assert.strictEqual(mutations.generatorTransition(input(language, 'helper')), null);
        }
    });

    it('a return-contract edit nulls the single return of an unannotated callable', () => {
        const result = mutations.returnContractEdit(input('python', 'get'));
        assert.strictEqual(line(result, 4), '        return None');
        assert.deepStrictEqual(result.changedRanges,
            [{ file: 'pkg/mod.py', startLine: 4, endLine: 4 }]);
        assert.strictEqual(mutations.returnContractEdit(input('python', 'typed')), null);
        for (const language of ['go', 'rust', 'java']) {
            assert.strictEqual(mutations.returnContractEdit(input(language, 'helper')), null);
        }
    });

    it('a nested callable keeps its own returns', () => {
        const content = [
            'def outer():',
            '    def inner():',
            '        return 1',
            '    return inner',
            '',
        ].join('\n');
        const result = mutations.returnContractEdit({
            language: 'python', relativePath: 'a.py', content,
            def: { name: 'outer', nameLine: 1, startLine: 1, endLine: 4 },
        });
        assert.strictEqual(line(result, 3), '        return 1');
        assert.strictEqual(line(result, 4), '    return None');
    });
});

describe('outcome-mutations: required parameter', () => {
    it('adds the parameter after a receiver, else first, else into an empty list', () => {
        const expected = [
            ['python', 'get', 2, '    def get(self, ucnq_required, key):'],
            ['python', 'plain', 7, 'def plain(ucnq_required, a, b=1):'],
            ['python', 'kwonly', 18, 'def kwonly(ucnq_required, *, session):'],
            ['go', 'Get', 5, 'func (t *T) Get(ucnqRequired int, key string) (string, error) {'],
            ['go', 'helper', 9, 'func helper(ucnqRequired int) int {'],
            ['rust', 'get', 4, '    pub fn get(&self, ucnq_required: i32, key: &str) -> String {'],
            ['rust', 'helper', 9, 'fn helper(ucnq_required: i32, a: i32) -> i32 {'],
            ['java', 'get', 4, '    public int get(int ucnqRequired, int key) {'],
            ['java', 'helper', 8, '    private static int helper(int ucnqRequired) {'],
        ];
        for (const [language, def, row, text] of expected) {
            const result = mutations.requiredParam(input(language, def));
            assert.ok(result, `${language} ${def}`);
            assert.strictEqual(line(result, row), text, `${language} ${def}`);
            assert.deepStrictEqual(result.changedRanges,
                [{ file: SOURCES[language].file, startLine: row, endLine: row }]);
            assert.ok(parsesCleanly(language, result.files[0].content), `${language} ${def}`);
        }
    });

    it('declines a header line it cannot address by column', () => {
        const result = mutations.requiredParam({
            language: 'python', relativePath: 'a.py',
            content: 'def f(a="é"):\n    return a\n',
            def: { name: 'f', nameLine: 1, startLine: 1, endLine: 2 },
        });
        assert.strictEqual(result, null);
    });
});

describe('outcome-mutations: additions and seeded delete targets', () => {
    it('adds a novel callable as a new file or an appended item', () => {
        const python = mutations.additiveSymbol(input('python'), 3);
        assert.deepStrictEqual(python.files.map(file => [file.path, file.created]),
            [['pkg/ucnq_added_3.py', true]]);
        const go = mutations.additiveSymbol(input('go'), 3);
        assert.strictEqual(go.files[0].path, 'pkg/ucnq_added_3.go');
        assert.match(go.files[0].content, /^package pkg\n/);
        const java = mutations.additiveSymbol(input('java'), 3);
        assert.strictEqual(java.files[0].path, 'src/pkg/UcnqAdded3.java');
        assert.match(java.files[0].content, /^package pkg;\n/);
        const rust = mutations.additiveSymbol(input('rust'), 3);
        assert.strictEqual(rust.files[0].path, 'src/lib.rs');
        assert.ok(!rust.files[0].created);
        assert.deepStrictEqual(rust.changedRanges,
            [{ file: 'src/lib.rs', startLine: 12, endLine: 15 }]);
        for (const [language, result] of Object.entries({ python, go, java, rust })) {
            assert.ok(parsesCleanly(language, result.files[0].content), language);
        }
    });

    it('seeds a private dead callable and reports its definition range', () => {
        for (const language of ['python', 'go', 'rust', 'java']) {
            const result = mutations.seededDeadAddition(input(language), 7);
            const text = result.files[0].content;
            assert.ok(parsesCleanly(language, text), language);
            const header = text.split('\n')[result.target.startLine - 1];
            assert.ok(header.includes(result.target.name), `${language}: ${header}`);
            assert.strictEqual(result.target.relativePath, SOURCES[language].file);
            assert.ok(result.target.endLine > result.target.startLine, language);
            // The name occurs once: nothing refers to it.
            assert.strictEqual(text.split(result.target.name).length - 1, 1, language);
        }
        const allowed = mutations.seededDeadAddition(input('rust'), 7, { allowDead: true });
        const lines = allowed.files[0].content.split('\n');
        assert.strictEqual(lines[allowed.target.startLine - 2], '#[allow(dead_code)]');
        assert.match(lines[allowed.target.startLine - 1], /^fn ucnq_seeded_dead_7/);
    });

    it('seeds a contract-bound member whose range is the implementation', () => {
        for (const language of ['python', 'go', 'rust', 'java']) {
            const result = mutations.seededContractBound(input(language), 9);
            const lines = result.files[0].content.split('\n');
            assert.ok(parsesCleanly(language, result.files[0].content), language);
            const header = lines[result.target.startLine - 1];
            assert.ok(header.includes(result.target.name), `${language}: ${header}`);
            assert.ok(result.target.className.includes('Impl'), language);
            // Removing the implementation leaves a tree that still parses:
            // the breakage the judge reports is the contract, not syntax.
            const without = [
                ...lines.slice(0, result.target.startLine - 1),
                ...lines.slice(result.target.endLine),
            ].join('\n');
            assert.ok(parsesCleanly(language, without), language);
            // The member is declared by the contract and implemented once.
            assert.strictEqual(without.split(result.target.name).length - 1, 1, language);
        }
    });
});
