'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parse } = require('../core/parser');
const { getLanguageAdapter, getParser, detectLanguage } = require('../languages');
const { resolveImport } = require('../core/imports');
const { execute } = require('../core/execute');
const { tmp, rm, idx } = require('./helpers');
const {
    conditionalRecoverySources,
    mergeExtracted,
} = require('../languages/c-family');

describe('fix #486: qualified C++ standard string conversions', () => {
    const source = [
        '#include <string>', '#include <string_view>',
        'namespace app {',
        'void log(std::string_view message) {}',
        'void log(int code) {}',
        'void emit(const std::string& text) {}',
        'void emit(double value) {}',
        'void run() {',
        ' log("hello");', ' log(42);', ' emit("text");', ' emit(1.5);',
        '}', '}',
    ].join('\n');
    it('confirms each standard string and arithmetic overload', () => {
        const dir = tmp({ 'log.cpp': source });
        try {
            const index = idx(dir);
            for (const [name, line, caller] of [['log', 4, 9], ['log', 5, 10], ['emit', 6, 11], ['emit', 7, 12]]) {
                const answer = index.context(name, { file: 'log.cpp', line });
                assert.deepEqual(answer.callers.map(site => site.line), [caller]);
                assert.equal(answer.unverifiedCallers.length, 0);
                assert.equal(answer.meta.account.conserved, true);
                const { declarationIdentity } = require('../core/provenance');
                const { captureOverload, validateOverload } = require('../core/provenance-overload');
                const { selectProvenanceOverload } = require('../core/callers');
                const definition = index.symbols.get(name).find(def => def.startLine === line);
                const call = index.getCachedCalls(path.join(dir, 'log.cpp')).find(site => site.line === caller);
                const members = index.symbols.get(name);
                const witness = captureOverload(index, { ...call, argumentFile: 'log.cpp' }, members,
                    'cpp', selectProvenanceOverload);
                assert.ok(validateOverload(JSON.parse(JSON.stringify(witness)), members.map(declarationIdentity),
                    declarationIdentity(definition)));
            }
        } finally { rm(dir); }
    });
    for (const [imports, spelling] of [
        ['using namespace std;', 'string_view'],
        ['using std::string_view;', 'string_view'],
        ['namespace platform = std;', 'platform::string_view'],
        ['using View = std::string_view;', 'View'],
        ['', 'std::basic_string_view<char>'],
    ]) it(`resolves ${spelling} through its declaring scope`, () => {
        const dir = tmp({ 'n.cpp': [
            '#include <string_view>', imports,
            `void pick(${spelling} text) {}`, 'void pick(int value) {}',
            'void run() { pick("text"); pick(42); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            for (const line of [3, 4]) {
                const answer = index.context('pick', { file: 'n.cpp', line });
                assert.equal(answer.callers.length, 1);
                assert.equal(answer.unverifiedCallers.length, 0);
            }
        } finally { rm(dir); }
    });
    it('does not borrow the platform contract for project names or a shadowed std namespace', () => {
        const dir = tmp({ 'n.cpp': [
            'namespace app {', 'namespace std { struct string_view { string_view(int); }; }',
            'void pick(std::string_view value) {}', 'void pick(const char* value) {}',
            'void run() { pick(42); }', '}',
        ].join('\n') });
        try {
            const answer = idx(dir).context('pick', { file: 'n.cpp', line: 3 });
            assert.equal(answer.callers.length + answer.unverifiedCallers.length, 1);
        } finally { rm(dir); }
    });
    it('keeps the character encoding and standard string-to-view conversion', () => {
        const dir = tmp({ 'n.cpp': [
            '#include <string>', '#include <string_view>',
            'void pick(std::string_view text) {}', 'void pick(std::wstring_view text) {}',
            'void run(std::string text, std::wstring wide) {',
            ' pick("text");', ' pick(L"text");', ' pick(text);', ' pick(wide);', '}',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 3 }).callers.map(site => site.line), [6, 8]);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 4 }).callers.map(site => site.line), [7, 9]);
        } finally { rm(dir); }
    });
    it('distinguishes character pointers from extra indirection and volatile characters', () => {
        const dir = tmp({ 'n.cpp': [
            '#include <string_view>', 'void pick(std::string_view text) {}',
            'void run(char** nested, volatile char* vol, char* const fixed) {',
            ' pick(nested);', ' pick(vol);', ' pick(fixed);', '}',
        ].join('\n') });
        try {
            const index = idx(dir), definition = index.symbols.get('pick')[0];
            const calls = index.getCachedCalls(path.join(dir, 'n.cpp')).filter(call => call.name === 'pick');
            const { argumentConversion, platformConversion } = require('../core/cpp-conversions');
            for (let n = 0; n < calls.length; n++) {
                const call = { ...calls[n], argumentFile: 'n.cpp' };
                const args = [index, call.argKinds[0], 'std::string_view', definition, call, 0];
                assert.equal(argumentConversion(...args), n === 2);
                assert.equal(platformConversion(...args), n === 2);
            }
        } finally { rm(dir); }
    });

    it('does not prove a temporary string binds to a mutable reference', () => {
        const dir = tmp({ 'n.cpp': [
            '#include <string>', 'void pick(std::string& text) {}',
            'void pick(const char* text, ...) {}', 'void run() { pick("text"); }',
        ].join('\n') });
        try {
            const index = idx(dir), definition = index.symbols.get('pick')[0];
            const call = index.getCachedCalls(path.join(dir, 'n.cpp')).find(site => site.name === 'pick');
            const { platformConversion } = require('../core/cpp-conversions');
            assert.equal(platformConversion(index, call.argKinds[0], definition.paramsStructured[0].type,
                definition, { ...call, argumentFile: 'n.cpp' }, 0), null);
            assert.equal(index.context('pick', { file: 'n.cpp', line: 2 }).callers.length, 0);
            assert.ok(index.context('pick', { file: 'n.cpp', line: 3 }).unverifiedCallers.some(site => site.line === 4));
        } finally { rm(dir); }
    });

    it('preserves qualified argument types through workers and disk caches', () => {
        const { ProjectIndex } = require('../core/project');
        const { saveCache, loadCache } = require('../core/cache');
        const dir = tmp({ 'n.cpp': '#include <string>\nvoid run(std::string text) { send(text); }' });
        try {
            const records = index => index.getCachedCalls(path.join(dir, 'n.cpp'));
            const sequential = new ProjectIndex(dir); sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir); parallel.build(null, { quiet: true, workers: 2 });
            assert.deepEqual(records(sequential)[0].argKinds, ['type:std::string']);
            assert.deepEqual(records(parallel), records(sequential));
            const cache = path.join(dir, '.cache-486', 'index.json'); saveCache(sequential, cache);
            const loaded = new ProjectIndex(dir); assert.ok(loadCache(loaded, cache));
            assert.deepEqual(records(loaded), records(sequential));
        } finally { rm(dir); }
    });
});

describe('fix #486: source-backed C++ conversion constraints', () => {
    it('does not give the NULL macro the conversion rules of nullptr', () => {
        const dir = tmp({ 'n.cpp': [
            '#define NULL 0', 'struct Gate { Gate(void*); };',
            'void pick(Gate value) {}', 'void pick(bool value) {}',
            'void run() { pick(NULL); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            for (const line of [3, 4]) {
                const result = index.context('pick', { file: 'n.cpp', line });
                assert.equal(result.callers.length, 0);
                assert.deepEqual(result.unverifiedCallers.map(call => call.line), [5]);
            }
        } finally { rm(dir); }
    });

    it('deduces a conversion operator target in the parameter declaration scope', () => {
        const dir = tmp({ 'n.cpp': [
            'namespace A { struct Token { using member = int; }; }',
            'namespace B { namespace A { struct Token {}; }',
            'struct Value { template<class T, class = typename T::member> operator T() const; }; }',
            'void pick(A::Token value) {}', 'void pick(int value) {}',
            'void run(B::Value value) { pick(value); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 4 }).callers.map(call => call.line), [6]);
            assert.equal(index.context('pick', { file: 'n.cpp', line: 5 }).callers.length, 0);
        } finally { rm(dir); }
    });

    it('retains the full pointer type returned by a conversion operator', () => {
        const dir = tmp({ 'n.cpp': [
            'struct Value { operator const char*() const; };',
            'void pick(const char* text) {}', 'void pick(int code) {}',
            'void run(Value value) { pick(value); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            const pointer = index.context('pick', { file: 'n.cpp', line: 2 });
            assert.deepEqual(pointer.callers.map(call => call.line), [4]);
            const number = index.context('pick', { file: 'n.cpp', line: 3 });
            assert.equal(number.callers.length + number.unverifiedCallers.length, 0);
            const run = index.context('run', { file: 'n.cpp', line: 4 });
            assert.deepEqual(run.callees.filter(call => call.name === 'pick').map(call => call.startLine), [2]);
        } finally { rm(dir); }
    });

    it('replays constructor constraints from recorded declarations without live caches', () => {
        const dir = tmp({ 'n.cpp': [
            'struct Gate { template<class T, class = typename T::member> Gate(T); };',
            'void pick(Gate value) {}', 'void pick(const char* value) {}',
            'void run() { pick("text"); }',
        ].join('\n') });
        try {
            const index = idx(dir), members = index.symbols.get('pick');
            const call = index.getCachedCalls(path.join(dir, 'n.cpp')).find(site => site.name === 'pick');
            const { captureOverload, validateOverload } = require('../core/provenance-overload');
            const { declarationIdentity } = require('../core/provenance');
            const { selectProvenanceOverload } = require('../core/callers');
            const witness = captureOverload(index, { ...call, argumentFile: 'n.cpp' }, members,
                'cpp', selectProvenanceOverload);
            const copy = JSON.parse(JSON.stringify(witness));
            const identities = members.map(declarationIdentity), selected = declarationIdentity(members[1]);
            assert.ok(validateOverload(copy, identities, selected));
            const key = Object.keys(copy.reads).find(key => key.startsWith('fact:cpp-conversion-class:'));
            assert.ok(key);
            copy.reads[key].constructors[0].syntax.templateComplete = false;
            assert.equal(validateOverload(copy, identities, selected), false);
            delete copy.reads[key];
            assert.equal(validateOverload(copy, identities, selected), false);
        } finally { rm(dir); }
    });

    const cases = [
        ['empty class', 'struct Gate {};', 'const char*', '"text"', 'other'],
        ['class named T', 'struct T {}; using Gate = T;', 'const char*', '"text"', 'other'],
        ['converting constructor', 'struct Gate { Gate(bool); };', 'const char*', 'true', 'gate'],
        ['explicit constructor', 'struct Gate { explicit Gate(const char*); };', 'const char*', '"text"', 'other'],
        ['non-class dependent member', 'struct Gate { template<class Char, class = typename Char::member> Gate(Char); };', 'const char*', '"text"', 'other'],
        ['requires dependent member', 'struct Gate { template<class Char> requires requires { typename Char::member; } Gate(Char); };', 'const char*', '"text"', 'other'],
        ['standard same-type constraint', 'struct Gate { template<class Char, std::enable_if_t<std::is_same<Char, int>::value, int> = 0> Gate(Char); };', 'const char*', '"text"', 'other'],
        ['standard conversion constraint', 'struct Gate { template<class Char, std::enable_if_t<std::is_convertible<Char, int>::value, int> = 0> Gate(Char); };', 'const char*', '"text"', 'other'],
        ['project constraint macro', '#define ENABLE(...) std::enable_if_t<(__VA_ARGS__), int> = 0\nstruct Gate { template<class Char, ENABLE(sizeof(typename Char::member))> Gate(Char); };', 'const char*', '"text"', 'other'],
        ['a deduced integer type is not a null pointer constant', 'struct Gate { template<class T, std::enable_if_t<std::is_convertible<T, const char*>::value, int> = 0> Gate(T); };', 'const char*', '0', 'other'],
        ['reference binding is not a category-only trait proof', 'struct Gate { template<class T, std::enable_if_t<!std::is_convertible<T, int&>::value, int> = 0> Gate(T); };', 'const char*', 'true', 'gate'],
        ['unknown constraint preserves candidate', 'struct Gate { template<class Char> requires (sizeof(Char) > 0) Gate(Char); };', 'const char*', '"text"', 'review'],
        ['integer suffix keeps template type undecided', 'struct Gate { template<class Char, std::enable_if_t<std::is_same<Char, long>::value, int> = 0> Gate(Char); };', 'double', '1L', 'review'],
        ['inherited converting constructors', 'struct Base { Base(bool); }; struct Gate : Base { using Base::Base; };', 'const char*', 'true', 'gate'],
        ['derived-to-base conversion', 'struct Gate {}; struct Child : Gate {};', 'int', 'Child{}', 'gate'],
        ['source conversion operator', 'struct Gate { operator int() const; };', 'int', 'Gate{}', 'gate'],
    ];
    for (const [label, prelude, other, value, selected] of cases) it(label, () => {
        const code = ['#include <type_traits>', prelude, 'void pick(Gate value) {}',
            `void pick(${other} value) {}`, `void run() { pick(${value}); }`].join('\n');
        const dir = tmp({ 'n.cpp': code });
        try {
            const index = idx(dir), definitions = index.symbols.get('pick');
            for (let position = 0; position < definitions.length; position++) {
                const result = index.context('pick', { file: 'n.cpp', line: definitions[position].startLine });
                const chosen = selected === (position === 0 ? 'gate' : 'other');
                assert.equal(result.callers.length, chosen ? 1 : 0, label);
                assert.equal(result.unverifiedCallers.length, selected === 'review' ? 1 : 0, label);
                assert.equal(result.meta.account.conserved, true);
            }
        } finally { rm(dir); }
    });

    it('reads an argument type where its declaration bound the alias', () => {
        const dir = tmp({ 'n.cpp': [
            '#include <string_view>', 'using Text = std::string_view;',
            'void pick(std::string_view value) {}', 'void pick(int value) {}',
            'void run(Text text) {', ' { using Text = int;', '   pick(text);', ' }', '}',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 3 }).callers.map(call => call.line), [7]);
            assert.equal(index.context('pick', { file: 'n.cpp', line: 4 }).callers.length, 0);
            const call = index.getCachedCalls(path.join(dir, 'n.cpp')).find(call => call.name === 'pick');
            assert.equal(call.argTypeOrigins[0].line, 5);
        } finally { rm(dir); }
    });

    it('deduced project types keep the argument declaration namespace', () => {
        const dir = tmp({ 'n.cpp': [
            'namespace A { struct Token { using member = int; }; }',
            'namespace B { struct Token {};',
            'struct Gate { template<class T, class = typename T::member> Gate(T); };',
            'void pick(Gate value) {}', 'void pick(int value) {}', '}',
            'void run(A::Token value) { B::pick(value); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 4 }).callers.map(call => call.line), [7]);
            assert.equal(index.context('pick', { file: 'n.cpp', line: 5 }).callers.length, 0);
        } finally { rm(dir); }
    });

    it('class template arguments resolve where the specialization is written', () => {
        const dir = tmp({ 'n.cpp': [
            'namespace A { struct Token { using member = int; }; }',
            'namespace B { namespace A { struct Token {}; }',
            'template<class T> struct Box { using member = typename T::member; };',
            'struct Gate { template<class T, class = typename T::member> Gate(T); };',
            'void pick(Gate value) {}', 'void pick(int value) {}', '}',
            'void run(B::Box<A::Token> value) { B::pick(value); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(index.context('pick', { file: 'n.cpp', line: 5 }).callers.map(call => call.line), [8]);
            assert.equal(index.context('pick', { file: 'n.cpp', line: 6 }).callers.length, 0);
        } finally { rm(dir); }
    });

    it('incomplete source classes keep their possible conversions visible', () => {
        const dir = tmp({ 'n.cpp': 'struct Unknown;\nstruct Gate {};\nvoid pick(Gate);\nvoid pick(int);\nvoid run(Unknown& value) { pick(value); }' });
        try {
            const index = idx(dir);
            for (const line of [3, 4]) {
                const result = index.context('pick', { file: 'n.cpp', line });
                assert.equal(result.callers.length, 0);
                assert.deepEqual(result.unverifiedCallers.map(call => call.line), [5]);
            }
        } finally { rm(dir); }
    });

    it('reuses conversion facts until an edit, rebuild or cache load changes the index', () => {
        const source = 'struct Gate { Gate(int); };\nvoid pick(Gate value) {}\nvoid pick(const char* value) {}\nvoid run() { pick("text"); }';
        const dir = tmp({ 'n.cpp': source });
        try {
            const index = idx(dir), file = path.join(dir, 'n.cpp');
            const query = () => require('../core/cpp-conversions').argumentConversion(index,
                'string:char', 'Gate', index.symbols.get('pick')[0], { argumentFile: 'n.cpp', line: 4 }, 0);
            assert.equal(query(), false);
            const memo = index._cppScope.conversionResults;
            query(); assert.strictEqual(index._cppScope.conversionResults, memo);
            const cache = path.join(dir, 'index.json'); index.saveCache(cache);
            fs.writeFileSync(file, source.replace('Gate(int)', 'Gate(const char*)'));
            index.indexFile(file);
            assert.equal(query(), null);
            assert.notStrictEqual(index._cppScope.conversionResults, memo);
            fs.writeFileSync(file, source);
            assert.ok(index.loadCache(cache));
            assert.equal(query(), false);
            fs.writeFileSync(file, source.replace('Gate(int)', 'Gate(const char*)'));
            index.build(null, { quiet: true, workers: 0 });
            assert.equal(query(), null);
        } finally { rm(dir); }
    });

    it('a function template parameter does not borrow a project type of the same name', () => {
        const dir = tmp({ 'n.cpp': [
            'struct Char {};', 'struct Gate { Gate(int); };',
            'void pick(Gate value) {}', 'void pick(const char* value) {}',
            'template<class Char> void run(Char value) { pick(value); }',
        ].join('\n') });
        try {
            const index = idx(dir);
            for (const line of [3, 4]) {
                const result = index.context('pick', { file: 'n.cpp', line });
                assert.equal(result.callers.length, 0);
                assert.equal(result.unverifiedCallers.length, 1);
            }
        } finally { rm(dir); }
    });
});

describe('fix #485: integer zero remains a null pointer constant', () => {
    const zeros = ['0', '0L', '0u', '0x0', '00', '0b0', "0'0", '0ULL'];
    const source = [
        'struct Gate { Gate(int); };',
        'void pick(const char* value) {}',
        'void pick(Gate value) {}',
        'void run() {',
        ...zeros.map(value => ` pick(${value});`),
        '}',
    ].join('\n');
    it('keeps pointer overloads visible beside user-defined conversions', () => {
        const dir = tmp({ 'n.cpp': source });
        try {
            const index = idx(dir);
            for (const line of [2, 3]) {
                const answer = index.context('pick', { file: 'n.cpp', line });
                const sites = [...answer.callers, ...answer.unverifiedCallers];
                assert.deepEqual(sites.map(site => site.line).sort((a, b) => a - b),
                    zeros.map((_, offset) => offset + 5));
                assert.equal(answer.meta.account.conserved, true);
            }
        } finally { rm(dir); }
    });
    it('distinguishes zero literals from booleans, characters, identifiers and nonzero integers', () => {
        const code = "void run() { f(0); f(false); f('\\0'); f(NULL); f(ZERO); f(0.0); f(0xdead); f(0x0F); f(1e2); }";
        const calls = getLanguageAdapter('cpp').findCallsInCode(code, getParser('cpp'));
        assert.deepEqual(calls.map(call => call.argKinds[0]), [
            'number:zero', 'bool', 'char:char', 'expr', 'expr', 'number:floating',
            'number:integer', 'number:integer', 'number:floating',
        ]);
    });
    it('preserves zero kinds in sequential, worker and disk-cache builds', () => {
        const { ProjectIndex } = require('../core/project');
        const { saveCache, loadCache } = require('../core/cache');
        const dir = tmp({ 'n.cpp': source });
        try {
            const records = index => [...index.files.keys()].sort().map(file => index.getCachedCalls(file));
            const sequential = new ProjectIndex(dir); sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir); parallel.build(null, { quiet: true, workers: 2 });
            assert.deepEqual(records(parallel), records(sequential));
            assert.equal(records(sequential).flat().filter(call => call.argKinds?.[0] === 'number:zero').length, zeros.length);
            const cache = path.join(dir, '.cache-485', 'index.json');
            saveCache(sequential, cache);
            const loaded = new ProjectIndex(dir);
            assert.ok(loadCache(loaded, cache));
            assert.deepEqual(records(loaded), records(sequential));
        } finally { rm(dir); }
    });
});

describe('C-family recovery resource and ordering contracts', () => {
    for (const extension of ['c', 'cpp']) {
        it(`${extension}: occurrence kinds preserve full classification and isolate receiver caches`, () => {
            const file = `kinds.${extension}`;
            const source = [
                'int target(int value) { return value; }',
                '#define RUN target(1)',
                '#if OPTION',
                'struct Other { int (*target)(int); };',
                '#else',
                'struct Other { int (*target)(int); int value; };',
                '#endif',
                'void use(struct Other* other) { other->target(2); (target)(3); int (*callback)(int) = target; }',
                'const char* text = "target target"; // target',
                ...(extension === 'cpp' ? [
                    'struct Holder { int target; void use() { target; this->target; } };',
                    'namespace ns { template<typename T> int target(T value) { return value; } }',
                    'template<typename T> void use(T& other) { other.template target<int>(); ns::target<int>(1); ::target(2); }',
                ] : []),
            ].join('\n');
            const dir = tmp({ [file]: source }), absolute = path.join(dir, file);
            const positions = rows => rows.map(({ line, column, usageType }) => ({ line, column, usageType }));
            const compare = index => {
                index._beginOp();
                try {
                    for (const name of ['target', 'Other', 'Holder', 'value', 'callback', 'T', 'missing']) {
                        const options = { skipCallRecovery: true };
                        const kinds = index._getCachedUsages(absolute, name, { ...options, usageKindsOnly: true });
                        const full = index._getCachedUsages(absolute, name, options);
                        assert.deepEqual(positions(kinds), positions(full), name);
                        assert.ok(kinds.every(row => !row.receiver), name);
                        if (name === 'target') assert.ok(full.some(row => row.receiver), 'ordinary usages retain receivers');
                        assert.deepEqual(index._getCachedUsages(absolute, name,
                            { ...options, lexicalScopes: true, usageKindsOnly: true }),
                        index._getCachedUsages(absolute, name, { ...options, lexicalScopes: true }));
                    }
                } finally { index._endOp(); }
                const original = index._getCachedUsages;
                const handle = `${file}:1:target`;
                const expected = execute(index, 'show', { name: handle });
                assert.ok(expected.ok, expected.error);
                try {
                    index._getCachedUsages = function (file, name, options) {
                        return original.call(this, file, name, { ...options, usageKindsOnly: false });
                    };
                    assert.deepEqual(execute(index, 'show', { name: handle }), expected);
                } finally { index._getCachedUsages = original; }
            };
            try {
                const index = idx(dir);
                compare(index);
                index.saveCache();
                index.saveUsageCache();
                const loaded = new (require('../core/project').ProjectIndex)(dir);
                assert.equal(loaded.loadCache(), true);
                compare(loaded);
                fs.appendFileSync(absolute, '\nvoid later(struct Other* other) { other->target(4); }\n');
                loaded.build(null, { forceRebuild: true, quiet: true, workers: 0 });
                compare(loaded);
            } finally { rm(dir); }
        });
    }

    for (const extension of ['c', 'cpp']) {
        it(`${extension}: account recovery uses indexed macro calls across cache and source changes`, () => {
            const file = `calls.${extension}`;
            const dir = tmp({ [file]: [
                'int target(int value) { return value; }',
                '#define RUN(value) target(value)',
                '#define CALLBACK (&target)',
                '#if OPTION',
                '#define CHOSEN target(2)',
                '#else',
                '#define CHOSEN target(3)',
                '#endif',
                '#define APPLY(fn, value) fn(value)',
                'void use(void) { RUN(1); APPLY(target, 4); }',
            ].join('\n') });
            const handle = `${file}:1:target`, absolute = path.join(dir, file);
            const compare = index => {
                const original = index._getCachedUsages;
                const full = {};
                try {
                    index._getCachedUsages = function (file, name, options) {
                        return original.call(this, file, name, { ...options, skipCallRecovery: false });
                    };
                    for (const command of ['show', 'impact']) {
                        full[command] = execute(index, command, { name: handle });
                        assert.ok(full[command].ok, full[command].error);
                    }
                } finally { index._getCachedUsages = original; }
                for (const command of ['show', 'impact']) {
                    assert.deepEqual(execute(index, command, { name: handle }), full[command], command);
                }
                const account = index._getCachedUsages(absolute, 'target', { skipCallRecovery: true });
                const usages = index._getCachedUsages(absolute, 'target');
                for (const line of [2, 5, 7]) {
                    assert.ok(usages.some(usage => usage.line === line && usage.usageType === 'call'));
                    assert.ok(!account.some(usage => usage.line === line && usage.usageType === 'call'));
                }
                assert.ok(!account.some(usage => usage.line === 999), 'obsolete usage modes are not reused');
            };
            try {
                const index = idx(dir);
                const cache = require('../core/cache');
                cache.storeUsageResult(index, absolute, 'target', 'skip-call-recovery',
                    [{ line: 999, usageType: 'call' }]);
                index.saveCache();
                index.saveUsageCache();
                compare(index);
                index.saveUsageCache();
                const loaded = new (require('../core/project').ProjectIndex)(dir);
                assert.equal(loaded.loadCache(), true);
                compare(loaded);
                fs.appendFileSync(absolute, '\n#define LATER target(5)\nvoid later(void) { LATER; }\n');
                loaded.build(null, { forceRebuild: true, quiet: true, workers: 0 });
                compare(loaded);
                assert.ok(loaded._getCachedUsages(absolute, 'target').some(usage =>
                    usage.line === 11 && usage.usageType === 'call'));
            } finally { rm(dir); }
        });
    }

    it('skips whole-file conditional sweeps above the native-tree memory cap', () => {
        const ordinary = '#if FEATURE\nint enabled;\n#else\nint disabled;\n#endif\n';
        assert.ok(conditionalRecoverySources(ordinary).length >= 2);
        const amalgamation = ordinary + ' '.repeat(256 * 1024);
        assert.deepEqual(conditionalRecoverySources(amalgamation), []);
    });

    it('sorts facts contributed by secondary recovery trees into source order', () => {
        const merged = mergeExtracted(
            [{ name: 'later', line: 8, column: 2 }],
            [{ name: 'earlier', line: 3, column: 4 },
                { name: 'middle', line: 8, column: 1 }],
            item => item.name,
        );
        assert.deepEqual(merged.map(item => item.name),
            ['earlier', 'middle', 'later']);
    });
});

describe('fix #398: indexed C/C++ bindings preserve lexical precedence', () => {
    for (const language of ['c', 'cpp']) {
        it(`${language}: chooses the narrowest visible binding after its declaration`, () => {
            const code = [
                'struct Global* item;',
                'void use(struct Outer* item) {',
                '  item->run();',
                '  {',
                '    item->run();',
                '    struct Inner* item = 0;',
                '    item->run();',
                '    item->run();',
                '  }',
                '  item->run();',
                '}',
                'void other(struct Other* item) { item->run(); }',
                'void global_use() { item->run(); }',
            ].join('\n');
            const calls = getLanguageAdapter(language).findCalls(code, getParser(language))
                .filter(call => call.name === 'run');
            assert.deepEqual(calls.map(call => call.receiverType), [
                'Outer', 'Outer', 'Inner', 'Inner', 'Outer', 'Other', 'Global',
            ]);
        });
    }
});

describe('C language support', () => {
    it('extracts includes, structs, functions, parameters, and calls', () => {
        const code = [
            '#include "util.h"',
            'typedef struct User { int id; } User;',
            'static int helper(int value) { return value; }',
            'int run(User *user) { return helper(user->id); }',
        ].join('\n');
        const result = parse(code, 'c');
        assert.deepEqual(result.imports.map(item => item.module), ['./util.h']);
        assert.ok(result.classes.some(item => item.name === 'User' && item.type === 'struct'));
        assert.ok(result.functions.some(item => item.name === 'run' &&
            item.paramsStructured[0].type === 'User *'));
        const calls = getLanguageAdapter('c').findCalls(code, getParser('c'));
        assert.ok(calls.some(call => call.name === 'helper' && call.argCount === 1));
    });

    it('preserves anonymous C-style variadic tails for arity', () => {
        const dir = tmp({
            'variadic.cpp': [
                'void safe_print(char* buffer, const char* format, ...);',
                'void fallback(...);',
                'void use(char* buffer) {',
                '  safe_print(buffer, "%d", 42);',
                '  fallback(1, 2);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const definition = index.symbols.get('safe_print')[0];
            assert.equal(definition.paramsStructured.at(-1).rest, true);
            const result = index.context('safe_print');
            assert.deepEqual(result.callers.map(call => call.line), [4]);
            assert.equal(result.meta.account.conserved, true);
            const fallback = index.symbols.get('fallback')[0];
            assert.equal(fallback.paramsStructured[0].rest, true);
            assert.deepEqual(
                index.context('fallback').callers.map(call => call.line),
                [5],
            );
        } finally {
            rm(dir);
        }
    });

    it('indexes callers and conserves the caller account', () => {
        const dir = tmp({
            'lib.h': 'int helper(int value);',
            'lib.c': '#include "lib.h"\nint helper(int value) { return value; }',
            'main.c': '#include "lib.h"\nint main(void) { return helper(1); }',
        });
        try {
            const index = idx(dir);
            const result = index.context('helper');
            assert.ok(result.callers.some(call => call.relativePath === 'main.c'));
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('treats an included prototype and implementation as one callable identity', () => {
        const dir = tmp({
            'lib.h': 'int helper(int value);',
            'lib.c': '#include "lib.h"\nint helper(int value) { return value; }',
            'main.c': '#include "lib.h"\nint main(void) { return helper(1); }',
        });
        try {
            const index = idx(dir);
            for (const target of [
                { file: 'lib.h', line: 1 },
                { file: 'lib.c', line: 2 },
            ]) {
                const result = index.context('helper', target);
                assert.deepEqual(result.callers.map(call => [
                    call.relativePath, call.line, call.tier,
                ]), [['main.c', 2, 'confirmed']]);
                assert.equal(result.unverifiedCallers.length, 0);
                assert.equal(result.meta.account.conserved, true);
            }
        } finally {
            rm(dir);
        }
    });

    it('resolves identifier-line handles and follows transitive test includes', () => {
        const dir = tmp({
            'include/detail.h': [
                'typedef enum',
                '{',
                '    FIRST = 0',
                '} FLAGS_T;',
            ].join('\n'),
            'include/api.h': '#include "detail.h"',
            'tests/check.c': [
                '#include "../include/api.h"',
                'int check(FLAGS_T flags) { return flags == FIRST; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const context = execute(index, 'context', {
                name: 'include/detail.h:4:FLAGS_T',
            });
            assert.equal(context.ok, true, context.error);
            const foundTests = execute(index, 'tests', {
                name: 'include/detail.h:1:FLAGS_T',
            });
            assert.equal(foundTests.ok, true, foundTests.error);
            assert.ok(foundTests.result.some(file =>
                file.file === 'tests/check.c' &&
                file.matches.some(match => match.line === 2)));
        } finally {
            rm(dir);
        }
    });

    it('indexes object-like and function-like preprocessor macros', () => {
        const dir = tmp({
            'main.c': [
                '#define VERSION 3',
                '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
                'int main(void) { return MAX(VERSION, 2); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.equal(index.symbols.get('VERSION')?.[0]?.type, 'macro');
            assert.equal(index.symbols.get('MAX')?.[0]?.type, 'macro');
            assert.equal(index.symbols.get('MAX')?.[0]?.params, 'a, b');
            const callees = index.findCallees(index.symbols.get('main')[0], {
                collectAccount: true,
            });
            assert.ok(callees.some(callee => callee.name === 'MAX'));
        } finally {
            rm(dir);
        }
    });

    it('parses calls inside multiline replacement lists across public surfaces', () => {
        const dir = tmp({
            'tests/check.c': [
                'static int target(int value) { return value; }',
                '#define RUN_TARGET(value) \\',
                '  do { \\',
                '    target(value); \\',
                '  } while (0)',
                '#define APPLY(fn, value) fn(value)',
                'void check(void) {',
                '  RUN_TARGET(1);',
                '  APPLY(target, 2);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('target')
                .find(symbol => symbol.relativePath === 'tests/check.c');
            const context = index.context('target', {
                file: 'tests/check.c', line: target.startLine,
            });
            assert.ok(context.callers.some(caller =>
                caller.relativePath === 'tests/check.c' && caller.line === 4));
            assert.ok(!context.callers.some(caller =>
                caller.relativePath === 'tests/check.c' && caller.line === 6));
            assert.equal(context.meta.account.conserved, true);

            const sourcePath = path.join(dir, 'tests/check.c');
            const accountUsages = index._getCachedUsages(
                sourcePath, 'target', { skipCallRecovery: true });
            assert.ok(Array.isArray(accountUsages));
            assert.ok(!accountUsages.some(usage => usage.line === 4 && usage.usageType === 'call'),
                'account mode does not recover calls already held in the call index');
            assert.ok([...index._usageResultCache.keys()].some(key =>
                key.endsWith('\0skip-call-recovery-v2')),
            'account-mode classifications use an isolated cache partition');

            const macro = index.symbols.get('RUN_TARGET')[0];
            const callees = index.findCallees(macro, { collectAccount: true });
            assert.ok(callees.some(callee =>
                callee.name === 'target' && callee.sites.includes(4)));
            const apply = index.symbols.get('APPLY')[0];
            const applyCallees = index.findCallees(apply, {
                collectAccount: true,
            });
            assert.equal(
                applyCallees.calleeAccount.excluded.byReason['macro-parameter'],
                1,
            );

            const usages = execute(index, 'usages', {
                name: 'target', includeTests: true,
            });
            assert.equal(usages.ok, true, usages.error);
            assert.ok(usages.result.some(usage =>
                usage.relativePath === 'tests/check.c' &&
                usage.line === 4 && usage.usageType === 'call'));
            assert.ok([...index._usageResultCache.keys()].some(key =>
                !key.endsWith('\0skip-call-recovery-v2') && key.includes('\0target')),
            'full usages retains its own macro-complete cache entry');

            const tests = execute(index, 'tests', {
                name: 'target', file: 'tests/check.c', line: 1,
            });
            assert.equal(tests.ok, true, tests.error);
            assert.ok(tests.result.some(file =>
                file.file === 'tests/check.c' &&
                file.matches.some(match => match.line === 4)));
        } finally {
            rm(dir);
        }
    });

    it('recovers a calling-convention macro between return type and function name', () => {
        const code = [
            'int CDECL main(void)',
            '{',
            '    return 0;',
            '}',
        ].join('\n');
        const result = parse(code, 'c');
        const main = result.functions.find(fn => fn.name === 'main');
        assert.equal(main?.startLine, 1);
        assert.equal(main?.returnType, 'int');
        assert.equal(result.parseRecovery, undefined);
    });
});

describe('C++ language support', () => {
    it('extracts inheritance, methods, receiver types, and calls', () => {
        const code = [
            'class Base { public: virtual int run(int x) = 0; };',
            'class Service : public Base {',
            'public:',
            '  int run(int x) override { return helper(x); }',
            '};',
            'int caller() { Service service; return service.run(1); }',
        ].join('\n');
        const result = parse(code, 'cpp');
        const service = result.classes.find(item => item.name === 'Service');
        assert.equal(service.extends, 'Base');
        assert.ok(service.members.some(member => member.name === 'run'));
        const calls = getLanguageAdapter('cpp').findCalls(code, getParser('cpp'));
        assert.ok(calls.some(call => call.name === 'run' &&
            call.receiverType === 'Service'));
    });

    it('uses compile_commands.json for ambiguous headers and include paths', () => {
        const dir = tmp({
            'include/api.h': 'class Api { public: int run(); };',
            'src/main.cpp': '#include "api.h"\nint main() { Api api; return api.run(); }',
        });
        try {
            fs.writeFileSync(path.join(dir, 'compile_commands.json'), JSON.stringify([{
                directory: dir,
                file: 'src/main.cpp',
                arguments: ['clang++', '-I', 'include', '-c', 'src/main.cpp'],
            }]));
            assert.equal(detectLanguage(path.join(dir, 'include/api.h')), 'cpp');
            assert.equal(resolveImport('./api.h', path.join(dir, 'src/main.cpp'), {
                language: 'cpp',
                root: dir,
            }), path.join(dir, 'include/api.h'));
            const index = idx(dir);
            assert.ok(index.importGraph.get(path.join(dir, 'src/main.cpp'))
                .has(path.join(dir, 'include/api.h')));
        } finally {
            rm(dir);
        }
    });

    it('uses configured C/C++ include paths without a compilation database', () => {
        const dir = tmp({
            '.ucn.json': JSON.stringify({
                includePaths: ['third_party/gtest'],
                exclude: ['third_party/unused/**'],
            }),
            'third_party/gtest/gmock/gmock.h': 'struct MockApi {};',
            'third_party/unused/ignored.cpp': 'void ignored() {}',
            'test/helper.h': '#include "gmock/gmock.h"',
        });
        try {
            const index = idx(dir);
            assert.ok(index.importGraph.get(path.join(dir, 'test/helper.h'))
                .has(path.join(dir, 'third_party/gtest/gmock/gmock.h')));
            assert.equal(index.files.has(
                path.join(dir, 'third_party/unused/ignored.cpp')), false);
        } finally {
            rm(dir);
        }
    });

    it('uses the repository translation-unit convention for distant headers', () => {
        const dir = tmp({
            '.git/HEAD': 'ref: refs/heads/main',
            'include/api/detail.h': 'class Api { public: int run(); };',
            'src/main.cpp': '#include "../include/api/detail.h"',
        });
        try {
            assert.equal(
                detectLanguage(path.join(dir, 'include/api/detail.h')),
                'cpp');
        } finally {
            rm(dir);
        }
    });

    it('uses declared C++ field types to separate same-named methods', () => {
        const dir = tmp({
            'service.cpp': [
                'struct Good { void run() {} };',
                'struct Bad { void run() {} };',
                'struct App {',
                '  Good service;',
                '  void go() {',
                '    this->service.run();',
                '    service.run();',
                '    Bad other;',
                '    other.run();',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('run', { className: 'Good' });
            assert.deepEqual(result.callers.map(call => call.line), [6, 7]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.excluded.byReason['receiver-type-mismatch'].count, 1);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('indexes using aliases and closes template out-of-line method identity', () => {
        const dir = tmp({
            'api.h': [
                'template <typename T> class Box {',
                ' public:',
                '  using value_type = T;',
                '  void run(int value);',
                '  void call() { run(1); }',
                '};',
                'template <typename T>',
                'void Box<T>::run(int value) {}',
                'using BoxInt = Box<int>;',
                'void invoke(BoxInt box) { box.run(2); }',
            ].join('\n'),
            'main.cpp': '#include "api.h"\n',
        });
        try {
            const index = idx(dir);
            assert.equal(index.symbols.get('value_type')?.[0]?.aliasOf, 'T');
            const outOfLine = index.symbols.get('run')
                .find(symbol => symbol.startLine === 8);
            const result = index.context('run', {
                file: 'api.h',
                line: outOfLine.startLine,
            });
            assert.deepEqual(
                result.callers.map(call => [
                    call.relativePath,
                    call.line,
                    call.tier,
                ]),
                [
                    ['api.h', 5, 'confirmed'],
                    ['api.h', 10, 'confirmed'],
                ],
            );
            assert.equal(result.unverifiedCallers.length, 0);
        } finally {
            rm(dir);
        }
    });

    it('retains lexical and qualified C++ member ownership in test references', () => {
        const dir = tmp({
            'test/native_test.cpp': [
                'template <typename T> class NativeArray {',
                ' public:',
                '  NativeArray() { InitCopy(); }',
                ' private:',
                '  void InitCopy() {',
                '    auto clone = &NativeArray::InitCopy;',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.tests('InitCopy', {
                file: 'test/native_test.cpp',
                className: 'NativeArray',
            });
            assert.deepEqual(
                result.flatMap(file => file.matches.map(match => match.line)),
                [3, 6],
            );
        } finally {
            rm(dir);
        }
    });

    it('canonicalizes C++ operators and records multiline identifier lines', () => {
        const code = [
            'template <typename T>',
            'inline auto',
            'reserve(T value) -> T { return value; }',
            'template <typename T> class Box {};',
            'class Matcher {',
            ' public:',
            '  Matcher& operator <<(bool value);',
            '  template <typename T>',
            '  operator Box<T>() const { return {}; }',
            '};',
        ].join('\n');
        const result = parse(code, 'cpp');
        const reserve = result.functions.find(item => item.name === 'reserve');
        assert.equal(reserve?.startLine, 2);
        assert.equal(reserve?.nameLine, 3);
        const matcher = result.classes.find(item => item.name === 'Matcher');
        assert.ok(matcher.members.some(item => item.name === 'operator<<'));
        const conversion = matcher.members.find(item =>
            item.name === 'operator Box');
        assert.equal(conversion?.returnType, 'Box');
    });

    it('canonicalizes increment, logical, comma, allocation, and literal operators', () => {
        // fix: `operator++` fell through the symbolic-token set into the
        // conversion branch ("operator ++"), so fmt's 16 operator++
        // definitions were unfindable and the eval's command-surface gate
        // caught `find operator+@test/scan.h:96` as missing on the first
        // Linux release dry run.
        const code = [
            'struct iterator {',
            '  int v;',
            '  auto operator++() -> iterator& { return *this; }',
            '  iterator operator++(int) { return *this; }',
            '  auto operator--() -> iterator& { return *this; }',
            '  bool operator&&(const iterator& o) const { return v && o.v; }',
            '  bool operator||(const iterator& o) const { return v || o.v; }',
            '  int operator,(const iterator& o) const { return o.v; }',
            '  int operator*() const { return v; }',
            '  void* operator new(unsigned long n);',
            '  void* operator new[](unsigned long n);',
            '  void operator delete(void* p);',
            '};',
            'long operator""_px(unsigned long long v) { return (long) v; }',
        ].join('\n');
        const result = parse(code, 'cpp');
        const iterator = result.classes.find(item => item.name === 'iterator');
        const memberNames = iterator.members.map(item => item.name);
        for (const expected of ['operator++', 'operator--', 'operator&&',
            'operator||', 'operator,', 'operator*', 'operator new',
            'operator new[]', 'operator delete']) {
            assert.ok(memberNames.includes(expected),
                `${expected} missing from ${JSON.stringify(memberNames)}`);
        }
        assert.equal(memberNames.filter(name => name === 'operator++').length, 2,
            'both increment overloads must keep the full token');
        assert.ok(result.functions.some(item => item.name === 'operator""_px'));
    });

    it('keeps the oracle operator canon in lockstep with the engine canon', () => {
        // The eval pins UCN definitions by oracle-listed name, so the two
        // canonicalizers must produce identical names. The oracle side is a
        // PREFIX match over clangd documentSymbol names (parameter lists
        // attached); `operator++(int)` used to truncate to "operator+".
        const { canonicalOperatorName } = require('../eval/oracles/clangd-oracle');
        const cases = [
            ['operator++(int)', 'operator++'],
            ['operator++()', 'operator++'],
            ['operator--()', 'operator--'],
            ['operator+(const uint128&, const uint128&)', 'operator+'],
            ['operator+=(int)', 'operator+='],
            ['operator&&(const iterator&)', 'operator&&'],
            ['operator||(const iterator&)', 'operator||'],
            ['operator,(const iterator&)', 'operator,'],
            ['operator<=>(const iterator&)', 'operator<=>'],
            ['operator<<(std::ostream&, int)', 'operator<<'],
            ['operator->()', 'operator->'],
            ['operator()(int)', 'operator()'],
            ['operator[](int)', 'operator[]'],
            ['operator new(unsigned long)', 'operator new'],
            ['operator new[](unsigned long)', 'operator new[]'],
            ['operator delete(void *)', 'operator delete'],
            ['operator""_px(unsigned long long)', 'operator""_px'],
            ['operator bool()', 'operator bool'],
        ];
        for (const [clangdName, expected] of cases) {
            assert.equal(canonicalOperatorName(clangdName), expected, clangdName);
        }
    });

    it('extracts namespace-qualified template function calls by base name', () => {
        const code = [
            'namespace detail { template <typename T> int limit(); }',
            'template <typename T> int use() {',
            '  return detail::limit<T>();',
            '}',
        ].join('\n');
        const calls = getLanguageAdapter('cpp')
            .findCalls(code, getParser('cpp'));
        assert.deepEqual(
            calls.filter(call => call.name === 'limit').map(call => ({
                line: call.line,
                receiver: call.receiver,
                isPathCall: call.isPathCall,
            })),
            [{ line: 3, receiver: 'detail', isPathCall: true }],
        );
    });

    it('parses parenthesized template callables and keeps specialization identity', () => {
        const code = [
            'template <typename T> struct UniversalPrinter;',
            'template <typename T> struct UniversalPrinter<T&> {',
            '  static void Print(T& value) {}',
            '};',
            'template <typename T> void use(T& value) {',
            '  (UniversalPrinter<T&>::Print)(value);',
            '}',
        ].join('\n');
        const parsed = parse(code, 'cpp');
        const specialization = parsed.classes.find(item =>
            item.specialization === 'UniversalPrinter<T&>');
        assert.equal(specialization?.name, 'UniversalPrinter');
        assert.ok(specialization.members.some(member =>
            member.name === 'Print' &&
            member.className === 'UniversalPrinter<T&>'));
        const calls = getLanguageAdapter('cpp')
            .findCalls(code, getParser('cpp'));
        assert.ok(calls.some(call =>
            call.name === 'Print' &&
            call.receiver === 'UniversalPrinter<T&>' &&
            call.isPathCall));
    });

    it('resolves declared receiver types by lexical scope and source position', () => {
        const code = [
            'struct format_specs { void sign(); };',
            'void first(format_specs specs) { specs.sign(); }',
            'void second() { auto specs = make_specs(); }',
        ].join('\n');
        const calls = getLanguageAdapter('cpp')
            .findCalls(code, getParser('cpp'));
        const sign = calls.find(call => call.name === 'sign');
        assert.equal(sign?.receiverType, 'format_specs');
    });

    it('keeps the outer type of nested generic receiver declarations', () => {
        const code = [
            'namespace fmt { template <typename T> struct context; }',
            'template <typename T> struct dynamic_store { void clear(); };',
            'void use(dynamic_store<fmt::context<char>> store) {',
            '  store.clear();',
            '}',
        ].join('\n');
        const calls = getLanguageAdapter('cpp')
            .findCalls(code, getParser('cpp'));
        assert.equal(
            calls.find(call => call.name === 'clear')?.receiverType,
            'dynamic_store',
        );
    });

    it('resolves implicit-this C++ overloads by arity', () => {
        const dir = tmp({
            'clock.cpp': [
                'struct Clock {',
                '  void write2(int value) {}',
                '  void write2(int value, int pad) {}',
                '  void run() {',
                '    write2(1);',
                '    write2(1, 2);',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const one = index.context('write2', {
                file: 'clock.cpp',
                line: 2,
            });
            assert.deepEqual(one.callers.map(caller => caller.line), [5]);
            assert.equal(one.unverifiedCallers.length, 0);
            assert.equal(one.meta.account.conserved, true);
            const two = index.context('write2', {
                file: 'clock.cpp',
                line: 3,
            });
            assert.deepEqual(two.callers.map(caller => caller.line), [6]);
            assert.equal(two.unverifiedCallers.length, 0);
            assert.equal(two.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('folds C++ out-of-line definitions into their overload slot', () => {
        const dir = tmp({
            'file.cpp': [
                'struct File {',
                '  void dup2(int fd);',
                '  void dup2(int fd, int mode);',
                '};',
                'void File::dup2(int fd) {}',
                'void File::dup2(int fd, int mode) {}',
                'void use(File f) {',
                '  f.dup2(1);',
                '  f.dup2(1, 2);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const one = index.context('dup2', {
                file: 'file.cpp',
                line: 2,
            });
            assert.deepEqual(one.callers.map(caller => caller.line), [8]);
            assert.equal(one.unverifiedCallers.length, 0);
            assert.equal(one.meta.account.conserved, true);
            const two = index.context('dup2', {
                file: 'file.cpp',
                line: 3,
            });
            assert.deepEqual(two.callers.map(caller => caller.line), [9]);
            assert.equal(two.unverifiedCallers.length, 0);
            assert.equal(two.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('types fields used by an out-of-line C++ member definition', () => {
        const dir = tmp({
            'redirect.h': [
                'struct File { void dup2(int fd); };',
                'struct Redirect {',
                '  File original;',
                '  void restore();',
                '};',
            ].join('\n'),
            'redirect.cpp': [
                '#include "redirect.h"',
                'void Redirect::restore() {',
                '  original.dup2(1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('dup2', {
                file: 'redirect.h',
                line: 1,
            });
            assert.deepEqual(result.callers.map(caller => [
                caller.relativePath, caller.line,
            ]), [['redirect.cpp', 3]]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('does not treat a wider global C++ call as recursive member dispatch', () => {
        const dir = tmp({
            'write.cpp': [
                'void write(int fd, const void* data, int size) {}',
                '#define SYS_CALL(call) ::call',
                'struct File {',
                '  void write(const void* data, int size) {',
                '    SYS_CALL(write(1, data, size));',
                '    ::write(1, data, size);',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const member = index.context('write', {
                className: 'File',
                file: 'write.cpp',
                line: 4,
            });
            assert.equal(member.callers.length, 0);
            assert.equal(member.unverifiedCallers.length, 0);
            assert.equal(
                member.meta.account.excluded.byReason['macro-requalified'].count,
                1,
            );
            assert.equal(
                member.meta.account.excluded.byReason['other-definition'].count,
                1,
            );
            assert.equal(member.meta.account.conserved, true);
            const global = index.context('write', {
                file: 'write.cpp',
                line: 1,
            });
            assert.deepEqual(global.callers.map(caller => caller.line), [5, 6]);
            assert.equal(global.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('flows a qualified C++ constructor through a declared field path', () => {
        const dir = tmp({
            'include/fmt/os.h': [
                'namespace fmt {',
                'struct file { void fdopen(const char* mode); };',
                'struct pipe { file write_end; };',
                '}',
            ].join('\n'),
            'use.cpp': [
                '#include "fmt/os.h"',
                'void use() {',
                '  auto p = fmt::pipe();',
                '  p.write_end.fdopen("w");',
                '}',
                'void fdopen(int fd, const char* mode);',
                'void system_call() { fdopen(1, "w"); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('fdopen', {
                file: 'include/fmt/os.h',
                line: 2,
            });
            assert.deepEqual(
                result.callers.map(call => [
                    call.relativePath,
                    call.line,
                    call.tier,
                ]),
                [['use.cpp', 4, 'confirmed']],
            );
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason['method-kind-mismatch'].count,
                1,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('uses C++ declaration order, include visibility, and arity for return flow', () => {
        const dir = tmp({
            'api.h': [
                'struct buffered_file { int descriptor(); };',
                'struct file { int descriptor(); };',
                'buffered_file open_buffered_file(void** fp = nullptr);',
            ].join('\n'),
            'use.cpp': [
                '#include "api.h"',
                'void use() {',
                '  auto f = open_buffered_file();',
                '  f.descriptor();',
                '}',
                'file open_buffered_file(int& fd) { return {}; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const buffered = index.context('descriptor', {
                file: 'api.h',
                line: 1,
            });
            assert.deepEqual(
                buffered.callers.map(call => [
                    call.relativePath,
                    call.line,
                    call.tier,
                ]),
                [['use.cpp', 4, 'confirmed']],
            );
            assert.equal(buffered.meta.account.conserved, true);

            const plain = index.context('descriptor', {
                file: 'api.h',
                line: 2,
            });
            assert.equal(plain.callers.length, 0);
            assert.equal(
                plain.meta.account.excluded.byReason[
                    'receiver-type-mismatch'
                ].count,
                1,
            );
            assert.equal(plain.meta.account.conserved, true);

            const use = index.symbols.get('use')[0];
            const callees = index.findCallees(use, {
                includeMethods: true,
                collectAccount: true,
            });
            const selected = callees.find(callee =>
                callee.name === 'open_buffered_file');
            assert.equal(selected?.relativePath, 'api.h');
            assert.equal(selected?.startLine, 3);
            assert.equal(callees.unverifiedCallees?.length || 0, 0);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('preserves C++ namespace identity and qualified return flow', () => {
        const dir = tmp({
            'include/fmt/api.hpp': [
                'namespace fmt {',
                'struct buffered_file { int descriptor(); };',
                '}',
                'fmt::buffered_file open_buffered_file();',
            ].join('\n'),
            'use.cpp': [
                '#include "fmt/api.hpp"',
                'void use() {',
                '  auto file = open_buffered_file();',
                '  file.descriptor();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const type = index.symbols.get('buffered_file')
                .find(definition => definition.type === 'struct');
            assert.equal(type.namespace, 'fmt');
            const result = index.context('descriptor', {
                file: 'include/fmt/api.hpp',
                line: 2,
            });
            assert.deepEqual(result.callers.map(call => [
                call.relativePath, call.line, call.tier,
            ]), [['use.cpp', 4, 'confirmed']]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('connects namespace-qualified C++ template base classes', () => {
        const dir = tmp({
            'qualified.cpp': [
                'namespace detail {',
                'template <typename T> struct buffer {',
                '  void try_reserve(int size);',
                '};',
                '}',
                'template <typename T>',
                'struct memory_buffer : public detail::buffer<T> {};',
                'void use(memory_buffer<int> value) {',
                '  value.try_reserve(20);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(
                index._getInheritanceParents(
                    'memory_buffer', path.join(dir, 'qualified.cpp')),
                ['buffer'],
            );
            const result = index.context('try_reserve', {
                file: 'qualified.cpp',
                line: 3,
            });
            assert.deepEqual(result.callers.map(call => [
                call.relativePath, call.line, call.tier,
            ]), [['qualified.cpp', 9, 'confirmed']]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('types use-proven C++ direct initializers without inventing free calls', () => {
        const dir = tmp({
            'direct.cpp': [
                'struct file { int descriptor(); };',
                'file make_file();',
                'void use() {',
                '  file value(make_file());',
                '  value.descriptor();',
                '}',
                'void wrapped(std::unique_ptr<file> pointer, file value) {',
                '  pointer->descriptor();',
                '  (value.descriptor)();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('descriptor', {
                file: 'direct.cpp',
                line: 1,
            });
            assert.deepEqual(result.callers.map(call => [
                call.relativePath, call.line, call.tier,
            ]), [
                ['direct.cpp', 5, 'confirmed'],
                ['direct.cpp', 8, 'confirmed'],
                ['direct.cpp', 9, 'confirmed'],
            ]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('folds C++ call receivers through declared producer return types', () => {
        const dir = tmp({
            'chain.cpp': [
                'struct Allocator { int get(); };',
                'struct Buffer { Allocator get_allocator(); };',
                'struct buffered_file { void* get(); };',
                'namespace fmt {',
                'struct file { buffered_file fdopen(const char* mode); };',
                'struct pipe { file read_end; };',
                '}',
                'void use(Buffer buffer, buffered_file file) {',
                '  buffer.get_allocator().get();',
                '  file.get();',
                '}',
                'void use_pipe() {',
                '  auto value = fmt::pipe();',
                '  value.read_end.fdopen("r").get();',
                '}',
            ].join('\n'),
        });
        try {
            const adapter = getLanguageAdapter('cpp');
            const calls = adapter.findCalls(
                fs.readFileSync(path.join(dir, 'chain.cpp'), 'utf8'),
                getParser('cpp'));
            const chained = calls.find(call =>
                call.name === 'get' && call.line === 9);
            assert.equal(chained?.receiverCall, 'get_allocator');
            assert.equal(chained?.receiverCallIsMethod, true);
            assert.equal(chained?.receiverIsChainRoot, true);

            const index = idx(dir);
            const result = index.context('get', {
                file: 'chain.cpp',
                line: 3,
            });
            assert.deepEqual(result.callers.map(call => call.line), [10, 14]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason[
                    'receiver-type-mismatch'
                ].count,
                1,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('types C++ functional construction and preserves std return ownership', () => {
        const dir = tmp({
            'flow.cpp': [
                'namespace local {',
                'struct utf8_to_utf16 {',
                '  utf8_to_utf16();',
                '  const char* c_str();',
                '};',
                '}',
                'std::string make_external();',
                'namespace factory { std::string make_external(); }',
                'void use() {',
                '  auto local_text = local::utf8_to_utf16();',
                '  local_text.c_str();',
                '  auto direct_std = std::string();',
                '  direct_std.c_str();',
                '  auto returned_std = make_external();',
                '  returned_std.c_str();',
                '  auto qualified_std = factory::make_external();',
                '  qualified_std.c_str();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('c_str', {
                file: 'flow.cpp',
                line: 4,
            });
            assert.deepEqual(result.callers.map(call => [
                call.relativePath, call.line, call.tier,
            ]), [['flow.cpp', 11, 'confirmed']]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.total,
                3,
            );
            assert.equal(
                result.meta.account.excluded.byReason[
                    'external-package'
                ].count,
                1,
            );
            assert.equal(
                result.meta.account.excluded.byReason[
                    'receiver-type-mismatch'
                ].count,
                2,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('classifies a C++ member receiver as a reference, not a call', () => {
        const code = [
            'void copy();',
            'struct file { int descriptor(); };',
            'void use(file copy) {',
            '  copy.descriptor();',
            '  copy();',
            '}',
        ].join('\n');
        const usages = getLanguageAdapter('cpp')
            .findUsages(code, 'copy', getParser('cpp'));
        assert.deepEqual(usages.map(usage => [
            usage.line, usage.usageType,
        ]), [
            [1, 'definition'],
            [3, 'definition'],
            [4, 'reference'],
            [5, 'call'],
        ]);
    });

    it('keeps same-arity C++ free-function overloads visibly ambiguous', () => {
        const dir = tmp({
            'api.h': [
                'void pick(int value);',
                'void pick(long value);',
                'void use() { pick(1); }',
                'struct Other {',
                '  void pick(int value);',
                '  void use() { pick(2); }',
                '};',
            ].join('\n'),
            'main.cpp': '#include "api.h"\n',
        });
        try {
            const index = idx(dir);
            const result = index.context('pick', {
                file: 'api.h',
                line: 1,
            });
            assert.equal(result.callers.length, 0);
            assert.deepEqual(
                result.unverifiedCallers.map(call => [
                    call.line,
                    call.reason,
                ]),
                [[3, 'overload-ambiguous']],
            );
            assert.equal(
                result.meta.account.excluded.byReason['other-definition'].count,
                1,
            );
        } finally {
            rm(dir);
        }
    });

    it('groups untyped C++ member dispatch without hiding raw sites', () => {
        const dir = tmp({
            'methods.cpp': [
                'struct Left { void begin(); };',
                'struct Right { void begin(); };',
                'void use() { value.begin(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('begin', {
                file: 'methods.cpp',
                line: 1,
            });
            assert.equal(result.callers.length, 0);
            assert.deepEqual(result.unverifiedCallers.map(call => [
                call.line,
                call.reason,
                call.uncertaintyClass,
                call.dispatchFamily,
            ]), [[
                3,
                'method-ambiguous',
                'compile-time-dispatch',
                'begin C++ method dispatch set',
            ]]);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('labels constrained C++ template overloads as compile-time dispatch', () => {
        const dir = tmp({
            'templates.cpp': [
                'template <typename T, typename = decltype(T::first)>',
                'void select(T value) {}',
                'template <typename T, typename = decltype(T::second), int = 0>',
                'void select(T value) {}',
                'template <typename T>',
                'void invoke(T value) { select(value); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const definitions = index.symbols.get('select');
            assert.equal(definitions.length, 2);
            assert.ok(definitions.every(definition =>
                definition.templateDependent === true));

            const result = index.context('select', {
                file: 'templates.cpp',
                line: 2,
            });
            assert.equal(result.callers.length, 0);
            assert.equal(result.unverifiedCallers.length, 1);
            assert.equal(
                result.unverifiedCallers[0].uncertaintyClass,
                'compile-time-dispatch',
            );
            assert.equal(
                result.unverifiedCallers[0].dispatchFamily,
                'select template overload set',
            );
            assert.equal(
                result.unverifiedCallers[0].dispatchCandidates,
                2,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('does not infer C++ user-defined conversions from library-like type names', () => {
        const dir = tmp({
            'include/fmt/format.hpp': [
                'namespace fmt {',
                'template <typename... T> struct format_string { format_string(const char*); };',
                'template <typename... T> struct wformat_string { wformat_string(const wchar_t*); };',
                'struct locale_ref {};',
                'struct text_style {};',
                'template <typename... T>',
                'void format(format_string<> value, T&&... args);',
                'void format(locale_ref value);',
                'void format(text_style value);',
                'template <typename... T>',
                'void format(wformat_string<> value, T&&... args);',
                '}',
            ].join('\n'),
            'use.cpp': [
                '#include "fmt/format.hpp"',
                'void use() {',
                '  fmt::format("answer {}");',
                '  fmt::format(fmt::text_style{});',
                '  fmt::format(L"wide {}");',
                '}',
            ].join('\n'),
        });
        try {
            const calls = getLanguageAdapter('cpp').findCalls(
                fs.readFileSync(path.join(dir, 'use.cpp'), 'utf8'),
                getParser('cpp'),
            ).filter(call => call.name === 'format');
            assert.deepEqual(calls.map(call => call.argKinds[0]), [
                'string:char',
                'type:fmt::text_style',
                'string:wchar_t',
            ]);

            const index = idx(dir);
            const result = index.context('format', {
                file: 'include/fmt/format.hpp',
                line: 7,
            });
            assert.deepEqual(
                result.callers.map(call => [
                    call.relativePath,
                    call.line,
                    call.tier,
                ]),
                [['use.cpp', 3, 'confirmed']],
            );
            assert.deepEqual(result.unverifiedCallers.map(call => [call.line, call.reason]),
                []);
            assert.equal(
                result.meta.account.excluded.byReason['overload-mismatch'].count,
                2,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('includes caller-local namespace overloads in qualified lookup', () => {
        const dir = tmp({
            'include/fmt/core.hpp': [
                'namespace detail {',
                'struct buffer {}; struct string_view {}; struct args {}; struct locale {};',
                'void render(buffer value, string_view text, args values, locale loc);',
                '}',
            ].join('\n'),
            'include/fmt/color.hpp': [
                '#include "core.hpp"',
                'namespace detail {',
                'struct style {};',
                'void render(buffer value, style colors, string_view text, args values);',
                'void use(buffer value, style colors, string_view text, args values) {',
                '  detail::render(value, colors, text, values);',
                '}',
                '}',
            ].join('\n'),
            'include/fmt/public.hpp': [
                '#include "core.hpp"',
                'namespace fmt {',
                'void render(int out, int loc, int text, int values);',
                'void use() { fmt::render(1, 2, 3, 4); }',
                '}',
            ].join('\n'),
            'main.cpp': [
                '#include "fmt/color.hpp"',
                '#include "fmt/public.hpp"',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('render', {
                file: 'include/fmt/core.hpp',
                line: 3,
            });
            assert.equal(result.callers.length, 0,
                `both calls bind caller-local siblings: ${JSON.stringify(result.callers)}`);
            assert.equal(result.unverifiedCallers.length, 0,
                JSON.stringify(result.unverifiedCallers));
            assert.equal(
                result.meta.account.excluded.byReason['overload-mismatch'].count,
                2,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('preserves C++ array shape without inferring a class conversion from its name', () => {
        const dir = tmp({
            'wide.cpp': [
                'struct string_view { string_view(const char*); };',
                'struct wstring_view { wstring_view(const wchar_t*); };',
                'void runtime(string_view value);',
                'void runtime(wstring_view value);',
                'void use() {',
                '  wchar_t format_str[] = { L\'{\', L\'}\', 0 };',
                '  runtime(format_str);',
                '}',
            ].join('\n'),
        });
        try {
            const adapter = getLanguageAdapter('cpp');
            const calls = adapter.findCalls(
                fs.readFileSync(path.join(dir, 'wide.cpp'), 'utf8'),
                getParser('cpp'),
            ).filter(call => call.name === 'runtime');
            assert.deepEqual(calls.map(call => call.argKinds),
                [['type:wchar_t[]']]);

            const index = idx(dir);
            const narrow = index.context('runtime', {
                file: 'wide.cpp', line: 3,
            });
            assert.equal(narrow.callers.length, 0);
            assert.deepEqual(narrow.unverifiedCallers.map(call => [call.line, call.reason]),
                []);
            const wide = index.context('runtime', {
                file: 'wide.cpp', line: 4,
            });
            assert.deepEqual(wide.callers.map(call => call.line), [7]);
            assert.deepEqual(wide.unverifiedCallers.map(call => [call.line, call.reason]),
                []);
            assert.equal(wide.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('follows macro parameter requalification before assigning call identity', () => {
        const dir = tmp({
            'macro.cpp': [
                '#define SYSTEM_CALL(call) ::_##call',
                '#define POSIX_CALL(call) SYSTEM_CALL(call)',
                'struct file {',
                '  void dup2(int from, int to) {',
                '    POSIX_CALL(dup2(from, to));',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const adapter = getLanguageAdapter('cpp');
            const parsed = adapter.analyze(
                fs.readFileSync(path.join(dir, 'macro.cpp'), 'utf8'),
                getParser('cpp'), path.join(dir, 'macro.cpp'));
            const call = parsed.calls.find(candidate =>
                candidate.name === 'dup2');
            assert.deepEqual(call.macroArguments, [
                { name: 'POSIX_CALL', argIndex: 0 },
            ]);
            const effects = new Map(parsed.symbols
                .filter(symbol => symbol.kind === 'macro')
                .map(macro => [
                macro.name, macro.macroParamEffects,
                ]));
            assert.deepEqual(effects.get('SYSTEM_CALL'), [{
                paramIndex: 0, kind: 'qualified', qualifier: 'global',
            }]);
            assert.deepEqual(effects.get('POSIX_CALL'), [{
                paramIndex: 0, kind: 'forwarded', macro: 'SYSTEM_CALL',
                argIndex: 0,
            }]);

            const index = idx(dir);
            const target = index.context('dup2', {
                className: 'file', file: 'macro.cpp', line: 4,
            });
            assert.equal(target.callers.length, 0);
            assert.equal(target.unverifiedCallers.length, 0);
            assert.equal(
                target.meta.account.excluded.byReason['macro-requalified'].count,
                1,
            );
            assert.equal(target.meta.account.conserved, true);

            const definition = index.symbols.get('dup2').find(symbol =>
                symbol.startLine === 4);
            const callees = index.findCallees(definition, {
                collectAccount: true,
            });
            assert.deepEqual(callees.map(callee => callee.name),
                ['POSIX_CALL']);
            assert.equal(callees.calleeAccount.excluded.byReason[
                'macro-requalified'], 1);
            assert.equal(callees.calleeAccount.conserved, true);

            index.saveCache();
            const reloaded = new index.constructor(dir);
            assert.equal(reloaded.loadCache(), true);
            const cachedTarget = reloaded.context('dup2', {
                className: 'file', file: 'macro.cpp', line: 4,
            });
            assert.equal(cachedTarget.callers.length, 0);
            assert.equal(cachedTarget.unverifiedCallers.length, 0);
            assert.equal(cachedTarget.meta.account.excluded.byReason[
                'macro-requalified'].count, 1);
            assert.deepEqual(
                reloaded.symbols.get('POSIX_CALL')[0].macroParamEffects,
                [{
                    paramIndex: 0,
                    kind: 'forwarded',
                    macro: 'SYSTEM_CALL',
                    argIndex: 0,
                }],
            );
        } finally {
            rm(dir);
        }
    });

    it('routes conditional macro identity disagreement to visible uncertainty', () => {
        const dir = tmp({
            'conditional-macro.cpp': [
                'void dup2(int from, int to);',
                '#if USE_SYSTEM',
                '#define ROUTE(call) ::call',
                '#else',
                '#define ROUTE(call) call',
                '#endif',
                'struct file {',
                '  void dup2(int from, int to) {',
                '    ROUTE(dup2(from, to));',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const global = index.context('dup2', {
                file: 'conditional-macro.cpp', line: 1,
            });
            assert.equal(global.callers.length, 0);
            assert.deepEqual(global.unverifiedCallers.map(call => ({
                line: call.line,
                reason: call.reason,
            })), [{ line: 9, reason: 'macro-expansion' }]);
            assert.equal(global.meta.account.conserved, true);

            const member = index.context('dup2', {
                className: 'file', file: 'conditional-macro.cpp', line: 8,
            });
            assert.equal(member.callers.length, 0);
            assert.deepEqual(member.unverifiedCallers.map(call => ({
                line: call.line,
                reason: call.reason,
            })), [{ line: 9, reason: 'macro-expansion' }]);
            assert.equal(member.meta.account.conserved, true);

            const definition = index.symbols.get('dup2').find(symbol =>
                symbol.startLine === 8);
            const callees = index.findCallees(definition, {
                collectAccount: true,
            });
            assert.deepEqual(callees.unverifiedCallees
                .filter(call => call.name === 'dup2')
                .map(call => ({
                line: call.sites[0],
                reason: call.reason,
                })), [{ line: 9, reason: 'macro-expansion' }]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('invalidates macro identity outcomes after an incremental rebuild', () => {
        const before = [
            '#define ROUTE(call) ::call',
            'struct file {',
            '  void dup2(int from, int to) {',
            '    ROUTE(dup2(from, to));',
            '  }',
            '};',
        ].join('\n');
        const after = before.replace('::call', 'call');
        const dir = tmp({ 'incremental.cpp': before });
        try {
            const index = idx(dir);
            const target = () => index.context('dup2', {
                className: 'file', file: 'incremental.cpp', line: 3,
            });
            const qualified = target();
            assert.equal(qualified.callers.length, 0);
            assert.equal(qualified.meta.account.excluded.byReason[
                'macro-requalified'].count, 1);

            fs.writeFileSync(path.join(dir, 'incremental.cpp'), after);
            index.build(null, { quiet: true, forceRebuild: true });
            const preserved = target();
            assert.deepEqual(preserved.callers.map(call => call.line), [4]);
            assert.equal(preserved.unverifiedCallers.length, 0);
            assert.equal(preserved.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('does not attribute type-qualified methods to namespace free functions', () => {
        const dir = tmp({
            'include/fmt/api.hpp': [
                'namespace fmt {',
                'void format(const char* value);',
                'template <typename T> struct formatter {',
                '  void format(T value);',
                '};',
                '}',
            ].join('\n'),
            'use.cpp': [
                '#include "fmt/api.hpp"',
                'void use() {',
                '  fmt::format("ok");',
                '  fmt::formatter<int>::format(1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('format', {
                file: 'include/fmt/api.hpp',
                line: 2,
            });
            assert.deepEqual(result.callers.map(call => call.line), [3]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason['method-kind-mismatch'].count,
                1,
            );
        } finally {
            rm(dir);
        }
    });

    it('does not attribute namespace or unrelated bare calls to a C++ member', () => {
        const dir = tmp({
            'scope.cpp': [
                'struct File { void write(int value); };',
                'void write(int value) {}',
                'namespace detail { void write(int value) {} }',
                'struct Other { void run() { write(1); } };',
                'void free_run() { write(1); }',
                'void use(File f) {',
                '  detail::write(1);',
                '  f.write(1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('write', {
                className: 'File',
                file: 'scope.cpp',
                line: 1,
            });
            assert.deepEqual(result.callers.map(caller => caller.line), [8]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason[
                    'method-kind-mismatch'].count,
                3,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('uses a complete include closure to reject invisible C++ overloads', () => {
        const dir = tmp({
            'include/fmt/a.hpp': [
                'namespace fmt { void choose(int value); }',
            ].join('\n'),
            'include/fmt/b.hpp': [
                'namespace fmt { void choose(const char* value); }',
            ].join('\n'),
            'use.cpp': [
                '#include "fmt/b.hpp"',
                'void use() { fmt::choose("visible"); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.context('choose', {
                file: 'include/fmt/a.hpp',
                line: 1,
            });
            assert.equal(result.callers.length, 0);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason['target-not-visible'].count,
                1,
            );
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('keeps extern-C link variants visible as one dispatch family', () => {
        const dir = tmp({
            'driver.cpp': [
                'extern "C" int fuzz(const unsigned char* data, int size);',
                'int main() { return fuzz(nullptr, 0); }',
            ].join('\n'),
            'variant-a.cpp': [
                'extern "C" int fuzz(const unsigned char*, int) { return 1; }',
            ].join('\n'),
            'variant-b.cpp': [
                'extern "C" int fuzz(const unsigned char*, int) { return 2; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('fuzz').find(definition =>
                definition.file.endsWith('variant-a.cpp'));
            assert.equal(target.linkage, 'c');
            const result = index.context('fuzz', {
                file: 'variant-a.cpp',
                line: 1,
            });
            assert.equal(result.callers.length, 0);
            assert.deepEqual(result.unverifiedCallers.map(call => [
                call.relativePath,
                call.line,
                call.reason,
                call.uncertaintyClass,
                call.dispatchFamily,
            ]), [[
                'driver.cpp',
                2,
                'link-variant',
                'compile-time-dispatch',
                'fuzz external-linkage implementations',
            ]]);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });
});

describe('C# language support', () => {
    it('extracts attributes, async methods, fields, constructors, and calls', () => {
        const code = [
            'using System.Threading.Tasks;',
            'public class Controller {',
            '  private readonly IService service;',
            '  public Controller(IService service) { this.service = service; }',
            '  [HttpGet("/items/{id}")]',
            '  public async Task<int> Get(int id) { return await service.Load(id); }',
            '}',
        ].join('\n');
        const result = parse(code, 'csharp');
        const controller = result.classes.find(item => item.name === 'Controller');
        const get = controller.members.find(member => member.name === 'Get');
        assert.equal(get.isAsync, true);
        assert.deepEqual(get.attributesWithArgs[0], {
            name: 'HttpGet',
            arg: '/items/{id}',
            interp: false,
        });
        assert.ok(controller.members.some(member =>
            member.name === 'service' && member.fieldType === 'IService'));
        const calls = getLanguageAdapter('csharp').findCalls(code, getParser('csharp'));
        assert.ok(calls.some(call => call.name === 'Load' &&
            call.receiverField === 'service' &&
            call.receiverRootType === 'Controller'));
    });

    it('indexes properties distinctly and reports typed property impact', () => {
        const dir = tmp({
            'Fixture.cs': [
                'class Client {',
                '  public int Value { get; set; }',
                '  public int Read() { return this.Value; }',
                '}',
                'class Consumer {',
                '  int Read(Client client) { return client.Value; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const property = index.symbols.get('Value')[0];
            assert.equal(property.type, 'property');
            assert.equal(property.memberType, 'property');
            const impact = index.impact('Value', {
                file: 'Fixture.cs', line: 2,
            });
            assert.equal(impact.propertyAccesses.confirmedCount, 2,
                'same-class and parameter-typed reads are proven dependencies');
            assert.equal(impact.propertyAccesses.unverifiedCount, 0);
            const source = execute(index, 'source', {
                name: 'Value', file: 'Fixture.cs', line: 2,
            });
            assert.equal(source.ok, true,
                'stable property handles must round-trip through source');
            assert.match(source.result.entries[0].code,
                /public int Value \{ get; set; \}/);
        } finally { rm(dir); }
    });

    it('preserves C# casts, null-forgiving fields, and nested receiver paths', () => {
        const code = [
            'using System.Collections;',
            'class Holder {',
            '  ICollection<int>? _items;',
            '  Resolver _resolver;',
            '  void Run(object value) {',
            '    ((IList)value).CopyTo(null, 0);',
            '    _items!.Add(1);',
            '    _resolver.Loaded.Items.Add(value);',
            '    _items?.Clear();',
            '  }',
            '}',
        ].join('\n');
        const calls = getLanguageAdapter('csharp').findCalls(
            code, getParser('csharp'));
        const castCall = calls.find(call => call.line === 6);
        assert.equal(castCall.receiverTypeSource, 'cast');
        assert.equal(castCall.receiverTypeEvidence.nodeType, 'cast_expression');
        const { receiverTypeSource, receiverTypeEvidence, callSite, ...shape } = castCall;
        assert.equal(code.slice(callSite.start, callSite.end), 'CopyTo');
        assert.equal(callSite.column, 19);
        assert.deepEqual(shape, {
            name: 'CopyTo',
            line: 6,
            isMethod: true,
            receiver: '((IList)value)',
            receiverType: 'IList',
            argCount: 2,
            argKinds: ['null', 'int'],
            enclosingFunction: { name: 'Run', startLine: 5, endLine: 10 },
        });
        assert.deepEqual(calls.find(call => call.line === 7).receiverFields,
            ['_items']);
        assert.deepEqual(calls.find(call => call.line === 8).receiverFields,
            ['_resolver', 'Loaded', 'Items']);
        assert.deepEqual(calls.find(call => call.line === 9).receiverFields,
            ['_items']);
    });

    it('types a local property receiver from the property, not its root object', () => {
        const dir = tmp({
            'Fixture.cs': [
                'namespace Demo;',
                'abstract class Token { internal abstract bool Same(Token other); }',
                'class Property : Token {',
                '  public Token Value { get; set; }',
                '  internal override bool Same(Token other) => true;',
                '}',
                'class Compare {',
                '  bool Run(Property left, Property right) {',
                '    return left.Value.Same(right.Value);',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const target = index.context('Same', {
                className: 'Property', file: 'Fixture.cs', line: 5,
            });
            assert.equal(target.callers.length, 0,
                `a Token-typed property cannot exactly select the override: ${JSON.stringify(target.callers)}`);
            assert.deepEqual(target.unverifiedCallers.map(call => [
                call.line, call.reason, call.dispatchVia,
            ]), [[9, 'possible-dispatch', 'Token']]);
            assert.equal(target.meta.account.conserved, true);

            const calls = getLanguageAdapter('csharp').findCalls(
                fs.readFileSync(path.join(dir, 'Fixture.cs'), 'utf8'),
                getParser('csharp'));
            const same = calls.find(call => call.line === 9 && call.name === 'Same');
            assert.equal(same.receiverType, undefined);
            assert.equal(same.receiverRoot, 'left');
            assert.deepEqual(same.receiverFields, ['Value']);
            assert.equal(same.receiverRootType, 'Property');
        } finally {
            rm(dir);
        }
    });

    it('does not expose a hidden base overload through an inapplicable sibling', () => {
        const dir = tmp({
            'Fixture.cs': [
                'namespace Demo;',
                'class Reader {}',
                'class Settings {}',
                'class Token {',
                '  public static Token Load(Reader reader, Settings? settings) => new Token();',
                '}',
                'class ArrayToken : Token {',
                '  public new static ArrayToken Load(Reader reader) => Load(reader, null);',
                '  public new static ArrayToken Load(Reader reader, Settings? settings) => new ArrayToken();',
                '  public static ArrayToken Parse(Reader reader, Settings? settings) => Load(reader, settings);',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const base = index.context('Load', {
                className: 'Token', file: 'Fixture.cs', line: 5,
            });
            assert.equal(base.callers.length, 0,
                `derived overloads own both calls: ${JSON.stringify(base.callers)}`);
            assert.equal(base.meta.account.excluded.byReason['other-definition'].count, 2);
            assert.equal(base.meta.account.conserved, true);

            const derived = index.context('Load', {
                className: 'ArrayToken', file: 'Fixture.cs', line: 9,
            });
            assert.deepEqual(derived.callers.map(call => call.line), [8, 10]);
            assert.equal(derived.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('uses C# platform field ownership and enclosing-class lookup as exclusions', () => {
        const dir = tmp({
            'Fixture.cs': [
                'using System.Collections.Generic;',
                'class Target {',
                '  public void CopyTo(int[] values, int offset) {}',
                '  public static string GetType(object value) => "target";',
                '}',
                'class Holder {',
                '  ICollection<int>? _items;',
                '  void GetType() {}',
                '  void Run(int[] values) {',
                '    _items!.CopyTo(values, 0);',
                '    GetType();',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            for (const [name, line] of [['CopyTo', 3], ['GetType', 4]]) {
                const result = index.context(name, { file: 'Fixture.cs', line });
                assert.equal(result.callers.length, 0);
                assert.equal(result.unverifiedCallers.length, 0);
                assert.equal(result.meta.account.conserved, true);
            }
        } finally {
            rm(dir);
        }
    });

    it('keeps C# explicit-this casts and interface receivers unverified for implementations', () => {
        const dir = tmp({
            'Fixture.cs': [
                'interface ISink { void Add(Token item); }',
                'class Token {}',
                'class Container : ISink {',
                '  void ISink.Add(Token item) {}',
                '  void Exact(Token item) { ((ISink)this).Add(item); }',
                '  void Dynamic(ISink sink, Token item) { sink.Add(item); }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const result = index.context('Add', {
                file: 'Fixture.cs',
                line: 4,
            });
            assert.deepEqual(result.callers.map(call => call.line), []);
            assert.deepEqual(result.unverifiedCallers.map(call => [
                call.line, call.reason, call.dispatchVia,
            ]), [[5, 'provenance-incomplete', undefined], [6, 'possible-dispatch', 'ISink']]);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('recognizes Main and test attributes as runtime entry points', () => {
        const adapter = getLanguageAdapter('csharp');
        assert.equal(adapter.getEntryPointKind({
            name: 'Main',
            modifiers: ['public', 'static'],
        }), 'main');
        assert.equal(adapter.getEntryPointKind({
            name: 'Works',
            decorators: ['Fact'],
        }), 'test');
    });

    it('links namespace imports and indexes top-level programs', () => {
        const dir = tmp({
            'Services/Worker.cs': [
                'namespace Demo.Services;',
                'public class Worker { public int Run() => 1; }',
            ].join('\n'),
            'Program.cs': [
                'using Demo.Services;',
                'var worker = new Worker();',
                'System.Console.WriteLine(worker.Run());',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const main = index.symbols.get('Main')?.find(symbol =>
                symbol.relativePath === 'Program.cs');
            assert.ok(main?.modifiers.includes('top-level'));
            assert.equal(index.symbols.get('Worker')?.[0]?.namespace, 'Demo.Services');
            assert.ok(index.importGraph.get(path.join(dir, 'Program.cs'))
                .has(path.join(dir, 'Services/Worker.cs')));
        } finally {
            rm(dir);
        }
    });

    it('detects ASP.NET controller/minimal routes and HttpClient bridges', () => {
        const dir = tmp({
            'Api.cs': [
                'using System.Threading.Tasks;',
                '[ApiController]',
                '[Route("/api/items")]',
                'public class ItemsController {',
                '  [HttpGet("{id}")]',
                '  public async Task<int> Get(int id) { await Task.Delay(1); return id; }',
                '}',
                'public static class Handlers {',
                '  public static int Health() => 1;',
                '}',
            ].join('\n'),
            'Program.cs': [
                'app.MapGet("/health", Handlers.Health);',
                'var client = new System.Net.Http.HttpClient();',
                'await client.GetAsync("/health");',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'endpoints', { bridge: true });
            assert.equal(result.ok, true);
            assert.ok(result.result.routes.some(route =>
                route.framework === 'aspnet' &&
                route.method === 'GET' &&
                route.path === '/api/items/{id}'));
            assert.ok(result.result.routes.some(route =>
                route.framework === 'aspnet-minimal' &&
                route.path === '/health'));
            assert.ok(result.result.bridges.some(bridge =>
                bridge.route.path === '/health' &&
                bridge.request.framework === 'dotnet-httpclient'));
            const entries = execute(index, 'entrypoints', {
                framework: 'aspnet-minimal',
            });
            assert.ok(entries.result.some(entry => entry.name === 'Health'));
        } finally {
            rm(dir);
        }
    });

    it('audits missing await and resolves .NET/native stack frames', () => {
        const dir = tmp({
            'Worker.cs': [
                'using System.Threading.Tasks;',
                'public class Worker {',
                '  public async Task SaveAsync() { await Task.Delay(1); }',
                '  public async Task RunAsync() {',
                '    SaveAsync();',
                '    await SaveAsync();',
                '  }',
                '}',
            ].join('\n'),
            'native.cpp': [
                'int helper() { return 1; }',
                'int main() { return helper(); }',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const audit = index.auditAsync();
            assert.equal(audit.totalIssues, 1);
            assert.equal(audit.issues[0].calleeName, 'SaveAsync');
            assert.equal(audit.issues[0].line, 5);

            const dotnet = index.parseStackTrace(
                `at Demo.Worker.RunAsync() in ${path.join(dir, 'Worker.cs')}:line 5`);
            assert.equal(dotnet.frames[0].found, true);
            assert.equal(dotnet.frames[0].functionInfo.name, 'RunAsync');

            const native = index.parseStackTrace(
                '#0 0x123 in main ' + path.join(dir, 'native.cpp') + ':2:5');
            assert.equal(native.frames[0].found, true);
            assert.equal(native.frames[0].functionInfo.name, 'main');
        } finally {
            rm(dir);
        }
    });

    it('keeps same-named C# types distinct by namespace', () => {
        const dir = tmp({
            'A.cs': [
                'namespace A {',
                '  public class Worker { public void Run() {} }',
                '  public class Use {',
                '    void Go(Worker worker) { worker.Run(); }',
                '  }',
                '}',
            ].join('\n'),
            'B.cs': [
                'namespace B {',
                '  public class Worker { public void Run() {} }',
                '  public class Use {',
                '    void Go(Worker worker) { worker.Run(); }',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const result = index.context('Run', {
                className: 'Worker',
                file: 'A.cs',
            });
            assert.deepEqual(result.callers.map(call => call.relativePath), ['A.cs']);
            assert.equal(result.meta.account.excluded.byReason['receiver-type-mismatch'].count, 1);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('flows C# factory return types through assignments and await', () => {
        const dir = tmp({
            'Flow.cs': [
                'using System.Threading.Tasks;',
                'public class Product { public void Save() {} }',
                'public class Other { public void Save() {} }',
                'public class Factory {',
                '  public static Product Create() => new Product();',
                '  public static Task<Product> CreateAsync() => Task.FromResult(new Product());',
                '}',
                'public class Use {',
                '  public async Task Go() {',
                '    var direct = Factory.Create();',
                '    direct.Save();',
                '    var awaited = await Factory.CreateAsync();',
                '    awaited.Save();',
                '    Other other = new Other();',
                '    other.Save();',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const result = index.context('Save', { className: 'Product' });
            assert.deepEqual(result.callers.map(call => call.line), [11, 13]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.excluded.byReason['receiver-type-mismatch'].count, 1);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('resolves C# extension methods in caller and callee directions', () => {
        const dir = tmp({
            'Extensions.cs': [
                'namespace Demo.Extensions;',
                'public static class StringExtensions {',
                '  public static string Wrap(this string value, int count) => value;',
                '  public static string Wrap(this string value, int count, string suffix) => value;',
                '}',
            ].join('\n'),
            'Use.cs': [
                'using Demo.Extensions;',
                'namespace Demo;',
                'public class Use {',
                '  public string Run() {',
                '    return "x".Wrap(1);',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const result = index.context('Wrap', {
                className: 'StringExtensions',
                file: 'Extensions.cs',
                line: 3,
            });
            assert.deepEqual(result.callers.map(call => call.line), [5]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);

            const run = index.symbols.get('Run')[0];
            const callees = index.findCallees(run, {
                includeMethods: true,
                collectAccount: true,
            });
            const wrap = callees.find(callee => callee.name === 'Wrap');
            const oneArg = index.symbols.get('Wrap').find(symbol => symbol.startLine === 3);
            assert.equal(wrap?.bindingId, oneArg.bindingId);
            assert.equal(callees.unverifiedCallees?.length || 0, 0);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('uses C# static argument types before falling back to inherited overloads', () => {
        const dir = tmp({
            'Overloads.cs': [
                'namespace Demo;',
                'public enum TokenKind { None }',
                'public class Token {}',
                'public class Reader {',
                '  protected void SetToken(TokenKind token) {}',
                '  protected virtual void SetToken(Token token) {}',
                '}',
                'public class TokenReader : Reader {',
                '  protected override void SetToken(Token token) {}',
                '  public void Run() {',
                '    SetToken(TokenKind.None);',
                '    SetToken(new Token());',
                '  }',
                '  public void ReadNullable(TokenKind? endToken) {',
                '    SetToken(endToken.GetValueOrDefault());',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const inherited = index.context('SetToken', {
                className: 'Reader',
                file: 'Overloads.cs',
                line: 5,
            });
            assert.deepEqual(inherited.callers.map(call => call.line), [11, 15]);
            assert.equal(inherited.meta.account.conserved, true);

            const local = index.context('SetToken', {
                className: 'TokenReader',
                file: 'Overloads.cs',
                line: 9,
            });
            assert.deepEqual(local.callers.map(call => call.line), [12]);
            assert.equal(local.meta.account.conserved, true);

            const run = index.symbols.get('Run')[0];
            const callees = index.findCallees(run, {
                includeMethods: true,
                collectAccount: true,
            });
            const selected = callees.filter(callee => callee.name === 'SetToken')
                .map(callee => index.symbols.get('SetToken')
                    .find(symbol => symbol.bindingId === callee.bindingId)?.startLine)
                .sort((a, b) => a - b);
            assert.deepEqual(selected, [5, 9]);
            assert.equal(callees.calleeAccount.conserved, true);

            const readNullable = index.symbols.get('ReadNullable')[0];
            const nullableCallees = index.findCallees(readNullable, {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(nullableCallees.find(callee =>
                callee.name === 'SetToken')?.startLine, 5);
            assert.equal(nullableCallees.calleeAccount.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('types C# literal receivers without inventing a field hop', () => {
        const adapter = getLanguageAdapter('csharp');
        const calls = adapter.findCalls(
            'class Use { string Run() => "x".Trim(); }',
            getParser('csharp'));
        const trim = calls.find(call => call.name === 'Trim');
        assert.equal(trim.receiverType, 'string');
        assert.equal(trim.receiverField, undefined);
        assert.equal(trim.argCount, 0);
    });

    it('keeps C# parameter receiver types scoped to their overload', () => {
        const adapter = getLanguageAdapter('csharp');
        const calls = adapter.findCalls([
            'class Use {',
            '  void Parse(StringReference value) { value.ToString(); }',
            '  void Parse(string value, int mode) { value.ToString(); }',
            '}',
        ].join('\n'), getParser('csharp')).filter(call => call.name === 'ToString');
        assert.deepEqual(calls.map(call => call.receiverType), [
            'StringReference',
            'string',
        ]);
    });

    it('recovers C# declarations across preprocessor branches and explicit interfaces', () => {
        const result = parse([
            'namespace Demo {',
            '  public class Service : System.IConvertible {',
            '#if FEATURE',
            '    public void Enabled() {}',
            '#else',
            '    public void Fallback() {}',
            '#endif',
            '    bool System.IConvertible.ToBoolean(System.IFormatProvider provider) => true;',
            '    public void After() {}',
            '  }',
            '}',
        ].join('\n'), 'csharp');
        const service = result.classes.find(item => item.name === 'Service');
        assert.deepEqual(service.members.map(member => member.name), [
            'Enabled',
            'Fallback',
            'ToBoolean',
            'After',
        ]);
        assert.equal(service.members.find(member =>
            member.name === 'ToBoolean').explicitInterface,
        'System.IConvertible');
    });

    it('rejects zero-width C# property fragments after conditional attributes', () => {
        const result = parse([
            'class Service {',
            '  public static bool Enabled {',
            '#if SAFE',
            '    [System.Security.SecuritySafeCritical]',
            '#endif',
            '    get { return true; }',
            '  }',
            '}',
        ].join('\n'), 'csharp');
        const service = result.classes.find(item => item.name === 'Service');
        assert.deepEqual(service.members.map(member => member.name), ['Enabled']);
        assert.ok(service.members.every(member => member.name.length > 0));
    });

    it('recovers following C# methods after a conditional block distorts the AST', () => {
        const result = parse([
            'namespace Demo {',
            '  class Reader {',
            '    void Run() {',
            '#if FEATURE',
            '      if (true) {',
            '#else',
            '      if (false) {',
            '#endif',
            '      }',
            '    }',
            '    private void ShiftBufferIfNeeded() {}',
            '  }',
            '}',
        ].join('\n'), 'csharp');
        const reader = result.classes.find(item => item.name === 'Reader');
        const shift = reader.members.find(member =>
            member.name === 'ShiftBufferIfNeeded');
        assert.equal(shift.startLine, 11);
        assert.equal(shift.className, 'Reader');
    });

    it('recovers calls from preprocessor else-if parser artifacts', () => {
        const code = [
            'class Helper { public static bool Check(object value, System.Type type, out System.Type found) { found = type; return true; } }',
            'class Reader {',
            '  Reader(object value) {',
            '    System.Type found;',
            '    if (value == null) {}',
            '#if FEATURE',
            '    else if (Helper.Check(value, typeof(string), out found)) {}',
            '#endif',
            '  }',
            '}',
        ].join('\n');
        const parsed = parse(code, 'csharp');
        assert.equal(parsed.functions.some(func => func.name === 'if'), false);
        const calls = getLanguageAdapter('csharp').findCalls(
            code, getParser('csharp'));
        const check = calls.find(call => call.name === 'Check');
        assert.equal(check.line, 7);
        assert.equal(check.argCount, 3);
        assert.equal(check.receiver, 'Helper');
        assert.equal(check.receiverIsTypeQualified, true);
        assert.equal(check.enclosingFunction.name, 'Reader');
    });

    it('recovers C# pattern variable types from preprocessor else-if artifacts', () => {
        const code = [
            'using System.Numerics;',
            'class Writer { public void WriteValue(object value) {} }',
            'class Reader {',
            '  void Run(object value, Writer writer) {',
            '    if (value == null) {}',
            '#if FEATURE',
            '    else if (value is BigInteger integer) {',
            '      writer.WriteValue(integer);',
            '    }',
            '#endif',
            '  }',
            '}',
        ].join('\n');
        const calls = getLanguageAdapter('csharp').findCalls(
            code, getParser('csharp'));
        const write = calls.find(call =>
            call.name === 'WriteValue' && call.line === 8);
        assert.deepEqual(write?.argKinds, ['type:BigInteger']);
    });

    it('resolves C# static type qualifiers and rejects external lookalikes', () => {
        const dir = tmp({
            'Qualified.cs': [
                'using System.Diagnostics;',
                'namespace Demo;',
                'class Misc {',
                '  static void Assert(bool value) {}',
                '  public void Run() { Debug.Assert(true); }',
                '}',
                'class Helper { public static void Assert(bool value) {} }',
                'class Use { public void Go() { Helper.Assert(true); } }',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const misc = index.context('Assert', {
                className: 'Misc',
                file: 'Qualified.cs',
                line: 4,
            });
            assert.equal(misc.callers.length, 0);
            assert.equal(misc.unverifiedCallers.length, 0);
            assert.equal(misc.meta.account.excluded.byReason['external-package'].count, 1);

            const helper = index.context('Assert', {
                className: 'Helper',
                file: 'Qualified.cs',
                line: 7,
            });
            assert.deepEqual(helper.callers.map(call => call.line), [8]);
            const helperType = index.context('Helper', {
                file: 'Qualified.cs',
                line: 7,
            });
            const qualifierUse = helperType.callers.find(call =>
                call.line === 8 && call.isTypeReference);
            assert.equal(qualifierUse?.resolution, 'receiver-hint');
            assert.equal(helperType.meta.account.conserved, true);

            const runCallees = index.findCallees(index.symbols.get('Run')[0], {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(runCallees.length, 0);
            assert.equal(runCallees.calleeAccount.external.count, 1);
            assert.equal(runCallees.calleeAccount.conserved, true);

            const goCallees = index.findCallees(index.symbols.get('Go')[0], {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(goCallees[0]?.className, 'Helper');
            assert.equal(goCallees.calleeAccount.conserved, true);
        } finally {
            rm(dir);
        }
    });

    it('selects a C# params overload in normal array form', () => {
        const dir = tmp({
            'Extensions.cs': [
                'namespace Demo;',
                'public static class Ext {',
                '  public static string FormatWith(this string format, object? arg0)',
                '    => format.FormatWith(new object?[] { arg0 });',
                '  private static string FormatWith(this string format, params object?[] args)',
                '    => format;',
                '}',
                'public class Use {',
                '  private string message = "x";',
                '  public string Run(object value) => message.FormatWith(value);',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const overloads = index.symbols.get('FormatWith');
            const ordinary = overloads.find(symbol => symbol.startLine === 3);
            const paramsArray = overloads.find(symbol => symbol.startLine === 5);
            assert.equal(paramsArray.paramsStructured.at(-1).rest, true);
            assert.equal(paramsArray.paramsStructured.at(-1).type, 'object?[]');

            const ordinaryContext = index.context('FormatWith', {
                className: 'Ext',
                file: 'Extensions.cs',
                line: 3,
            });
            assert.deepEqual(ordinaryContext.callers.map(call => call.line), [10]);
            const paramsContext = index.context('FormatWith', {
                className: 'Ext',
                file: 'Extensions.cs',
                line: 5,
            });
            assert.deepEqual(paramsContext.callers.map(call => call.line), [4]);

            const wrapperCallees = index.findCallees(ordinary, {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(wrapperCallees[0]?.bindingId, paramsArray.bindingId);
            const runCallees = index.findCallees(index.symbols.get('Run')[0], {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(runCallees[0]?.bindingId, ordinary.bindingId);
        } finally {
            rm(dir);
        }
    });

    it('keeps explicit C# interface implementations out of ordinary overload lookup', () => {
        const dir = tmp({
            'Container.cs': [
                'namespace Demo;',
                'interface ISink { void Add(Token item); }',
                'class Token {}',
                'class Container : ISink {',
                '  public virtual void Add(object content) {}',
                '  void ISink.Add(Token item) { Add(item); }',
                '  public void Forward(object content) { Add(content); }',
                '}',
                'class Child : Container {',
                '  public void Add(Token item) { Add((object)item); }',
                '  public Child(object content) { Add(content); }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const overloads = index.symbols.get('Add');
            const ordinary = overloads.find(symbol => symbol.startLine === 5);
            const explicit = overloads.find(symbol => symbol.startLine === 6);
            assert.equal(explicit.explicitInterface, 'ISink');

            const context = index.context('Add', {
                className: 'Container',
                file: 'Container.cs',
                line: 5,
            });
            assert.deepEqual(context.callers.map(call => call.line), [6, 7, 10, 11]);
            assert.equal(context.meta.account.conserved, true);

            for (const methodName of ['Forward', 'Child']) {
                const owner = index.symbols.get(methodName).find(symbol =>
                    symbol.startLine === (methodName === 'Forward' ? 7 : 11));
                const callees = index.findCallees(owner, {
                    includeMethods: true,
                    collectAccount: true,
                });
                assert.equal(callees[0]?.bindingId, ordinary.bindingId,
                    `${methodName} should select Add(object), not the interface-only Add(Token)`);
                assert.equal(callees.calleeAccount.conserved, true);
            }
        } finally {
            rm(dir);
        }
    });

    it('uses nullable and cast argument kinds for C# overload selection', () => {
        const dir = tmp({
            'Writer.cs': [
                'using System;',
                'namespace Demo;',
                'class Writer {',
                '  void WriteValue(Guid? value) {}',
                '  void WriteValue(string value) {}',
                '  public void Run(Guid value, bool nullable) {',
                '    WriteValue(nullable ? (Guid?)value : value);',
                '    WriteValue((string)"x");',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const callees = index.findCallees(index.symbols.get('Run')[0], {
                includeMethods: true,
                collectAccount: true,
            }).filter(callee => callee.name === 'WriteValue');
            assert.deepEqual(callees.map(callee => callee.startLine), [4, 5]);
            assert.deepEqual(callees.map(callee => callee.sites[0]), [7, 8]);
        } finally {
            rm(dir);
        }
    });

    it('keeps inherited C# overload slots distinct by parameter signature', () => {
        const dir = tmp({
            'Slots.cs': [
                'using System;',
                'namespace Demo;',
                'class BaseWriter {',
                '  public virtual void WriteValue(object? value) {}',
                '  public virtual void WriteValue(Guid? value) {}',
                '}',
                'class DerivedWriter : BaseWriter {',
                '  public override void WriteValue(object? value) {}',
                '  public void CallBase(Guid? value) { base.WriteValue(value); }',
                '}',
                'class Use {',
                '  void Run(DerivedWriter writer, Guid? value) {',
                '    writer.WriteValue(value);',
                '  }',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const inherited = index.context('WriteValue', {
                className: 'BaseWriter',
                file: 'Slots.cs',
                line: 5,
            });
            assert.deepEqual(inherited.callers.map(call => call.line), [9, 13]);
            const callees = index.findCallees(index.symbols.get('Run')[0], {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(callees[0]?.className, 'BaseWriter');
            assert.equal(callees[0]?.startLine, 5);
            const baseCallees = index.findCallees(index.symbols.get('CallBase')[0], {
                includeMethods: true,
                collectAccount: true,
            });
            assert.equal(baseCallees[0]?.className, 'BaseWriter');
            assert.equal(baseCallees[0]?.startLine, 5);
            assert.equal(baseCallees.unverifiedCallees?.length || 0, 0);
        } finally {
            rm(dir);
        }
    });

    it('treats same-namespace C# partial declarations as one class identity', () => {
        const dir = tmp({
            'JValue.cs': 'namespace Demo; public partial class JValue {}',
            'JValue.Async.cs': [
                'namespace Demo;',
                'public partial class JValue { public int Value => 1; }',
            ].join('\n'),
            'Use.cs': [
                'namespace Demo;',
                'class Use { JValue Make() => new JValue(); }',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            for (const definition of index.symbols.get('JValue')) {
                const result = index.context('JValue', {
                    file: definition.relativePath,
                    line: definition.startLine,
                });
                assert.deepEqual(result.callers.map(call => [
                    call.relativePath,
                    call.line,
                ]), [['Use.cs', 2]]);
                assert.equal(result.meta.account.conserved, true);
            }
        } finally {
            rm(dir);
        }
    });

    it('confirms C# constructor type identity from a nested namespace', () => {
        const dir = tmp({
            'Value.cs': [
                'namespace Demo.Model;',
                'public class Value { public Value(object value) {} }',
            ].join('\n'),
            'Parser.cs': [
                'namespace Demo.Model.Parsing;',
                'public class Parser {',
                '  public Value Parse(object input) => new Value(input);',
                '}',
            ].join('\n'),
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        });
        try {
            const index = idx(dir);
            const result = index.context('Value', {
                file: 'Value.cs',
                line: 2,
            });
            assert.deepEqual(result.callers.map(call => [
                call.relativePath,
                call.line,
                call.tier,
            ]), [['Parser.cs', 3, 'confirmed']]);
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally {
            rm(dir);
        }
    });
});

describe('fix: attribute-macro parse recovery (C/C++)', () => {
    // Export/visibility macros (TS_PUBLIC, API) used to be consumed as the
    // declaration's TYPE: `TS_PUBLIC extern void (*fp)(void *)` indexed a
    // phantom symbol named "void" (the real name buried as a parameter type),
    // and `TS_PUBLIC int f(...)` rendered the macro as the return type.
    it('C: macro-attributed function pointer keeps its real name and return type', () => {
        const code = [
            '#define TS_PUBLIC __attribute__((visibility("default")))',
            'TS_PUBLIC extern void  (*with_macro_void)(void *);',
            'TS_PUBLIC extern void *(*with_macro_ptr)(size_t);',
            'extern     void  (*no_macro_void)(void *);',
        ].join('\n');
        const result = parse(code, 'c');
        const names = result.functions.map(fn => fn.name);
        assert.ok(names.includes('with_macro_void'), `expected with_macro_void, got: ${names}`);
        assert.ok(names.includes('with_macro_ptr'));
        assert.ok(names.includes('no_macro_void'));
        assert.ok(!names.includes('void'), 'phantom "void" symbol must not exist');
        const withMacro = result.functions.find(fn => fn.name === 'with_macro_void');
        assert.equal(withMacro.returnType, 'void');
        assert.equal(withMacro.startLine, 2);
        const ptr = result.functions.find(fn => fn.name === 'with_macro_ptr');
        assert.notEqual(ptr.returnType, 'TS_PUBLIC', 'macro must not become the return type');
        assert.ok(!result.parseRecovery, 'recovered parse must not carry the parseRecovery flag');
    });

    it('C: macro before a plain function no longer leaks into the return type', () => {
        const code = [
            '#define TS_PUBLIC __attribute__((visibility("default")))',
            'TS_PUBLIC int plain_fn(int a) { return a; }',
        ].join('\n');
        const result = parse(code, 'c');
        const fn = result.functions.find(item => item.name === 'plain_fn');
        assert.ok(fn, 'plain_fn must be indexed');
        assert.equal(fn.returnType, 'int');
    });

    it('C++: API macro on functions and class members recovers', () => {
        const code = [
            '#define API __attribute__((visibility("default")))',
            'API int exported_fn(int a) { return a; }',
            'class Widget {',
            'public:',
            '    API int compute(int x);',
            '};',
        ].join('\n');
        const result = parse(code, 'cpp');
        const fn = result.functions.find(item => item.name === 'exported_fn');
        assert.equal(fn?.returnType, 'int');
        const widget = result.classes.find(item => item.name === 'Widget');
        const member = widget?.members.find(item => item.name === 'compute');
        assert.equal(member?.returnType, 'int');
    });

    it('C++: API macro between class keyword and name preserves member ownership', () => {
        const code = [
            '#define API __attribute__((visibility("default")))',
            'class API Widget {',
            ' public:',
            '  static Widget* GetInstance();',
            '};',
            'struct API Pipe {',
            '  int read_end;',
            '  void open();',
            '};',
        ].join('\n');
        const result = parse(code, 'cpp');
        const widget = result.classes.find(item => item.name === 'Widget');
        assert.ok(widget, 'Widget must be recovered as a class');
        const member = widget.members.find(item => item.name === 'GetInstance');
        assert.equal(member?.className, 'Widget');
        assert.equal(member?.isSignature, true);
        assert.ok(member?.modifiers.includes('static'));
        assert.ok(!result.functions.some(item =>
            item.name === 'GetInstance' && !item.className));
        const pipe = result.classes.find(item => item.name === 'Pipe');
        assert.equal(
            pipe?.members.find(item => item.name === 'open')?.className,
            'Pipe',
        );
    });

    it('C++: declaration macros around templates and classes recover together', () => {
        const code = [
            'FMT_BEGIN_NAMESPACE',
            'namespace detail {',
            'template <typename T> class helper {',
            ' public:',
            '  FMT_CONSTEXPR helper(T value) {}',
            '};',
            '}',
            'FMT_EXPORT template <typename Context> class dynamic_store {',
            ' public:',
            '  void clear() {}',
            '};',
            'FMT_PRAGMA_CLANG(diagnostic ignored "-Wweak-vtables")',
            'class FMT_SO_VISIBILITY("default") format_error {',
            ' public:',
            '  void report() {}',
            '};',
            'FMT_END_NAMESPACE',
        ].join('\n');
        const result = parse(code, 'cpp');
        const store = result.classes.find(item =>
            item.name === 'dynamic_store');
        assert.equal(
            store?.members.find(member => member.name === 'clear')?.className,
            'dynamic_store',
        );
        const error = result.classes.find(item =>
            item.name === 'format_error');
        assert.equal(
            error?.members.find(member => member.name === 'report')?.className,
            'format_error',
        );
        assert.ok(!result.functions.some(item =>
            ['clear', 'report'].includes(item.name) && !item.className));
    });

    it('C++: declaration recovery preserves nested calls in statement macros', () => {
        const code = [
            'FMT_BEGIN_NAMESPACE',
            'void target() {}',
            'void use() {',
            '  EXPECT_THROW_MSG(target(), error_type, "message");',
            '}',
            'FMT_END_NAMESPACE',
        ].join('\n');
        const calls = getLanguageAdapter('cpp')
            .findCalls(code, getParser('cpp'));
        assert.ok(calls.some(call =>
            call.name === 'target' && call.line === 4));
    });

    it('C: usages classification sees the recovered parse, not the broken one', () => {
        const dir = tmp({
            'lib.c': [
                '#define TS_PUBLIC __attribute__((visibility("default")))',
                'TS_PUBLIC extern void (*with_macro_void)(void *);',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const usages = index.usages('with_macro_void');
            assert.ok(usages.some(u => u.line === 2),
                'the declaration line must appear in usages');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: C typedefs and unnamed parameters', () => {
    it('indexes function-pointer and plain typedefs as type symbols', () => {
        const code = [
            'typedef void (*callback_t)(int);',
            'typedef int myint;',
            'typedef struct Foo_s Foo;',
            'typedef struct { int x; } Point;',
        ].join('\n');
        const result = parse(code, 'c');
        const byName = new Map(result.classes.map(cls => [cls.name, cls]));
        assert.equal(byName.get('callback_t')?.type, 'type');
        assert.ok(!byName.get('callback_t')?.aliasOf,
            'a function-pointer typedef is not an alias of its return type');
        assert.equal(byName.get('myint')?.type, 'type');
        assert.equal(byName.get('myint')?.aliasOf, 'int');
        assert.equal(byName.get('Foo')?.aliasOf, 'Foo_s');
        // Anonymous struct named through the typedef fallback: exactly one entry.
        assert.equal(result.classes.filter(cls => cls.name === 'Point').length, 1);
    });

    it('records the identifier line for multiline anonymous typedefs', () => {
        const code = [
            'typedef enum',
            '{',
            '    FIRST = 0,',
            '    SECOND',
            '} FLAGS_T;',
        ].join('\n');
        const result = parse(code, 'c');
        const flags = result.classes.find(cls => cls.name === 'FLAGS_T');
        assert.equal(flags?.startLine, 1);
        assert.equal(flags?.nameLine, 5);
    });

    it('classifies bodyless struct tags in value declarations as references', () => {
        const code = [
            'struct Item { int value; };',
            'struct Item *current;',
            'struct Forward;',
        ].join('\n');
        const itemUsages = getLanguageAdapter('c')
            .findUsages(code, 'Item', getParser('c'));
        assert.deepEqual(itemUsages.map(usage => [
            usage.line, usage.usageType,
        ]), [[1, 'definition'], [2, 'reference']]);
        const forwardUsages = getLanguageAdapter('c')
            .findUsages(code, 'Forward', getParser('c'));
        assert.deepEqual(forwardUsages.map(usage => [
            usage.line, usage.usageType,
        ]), [[3, 'definition']]);
    });

    it('renders unnamed parameters as their type alone', () => {
        const code = 'int unnamed(size_t, int b) { return b; }\nvoid takes_ptr(void *) {}\n';
        const result = parse(code, 'c');
        const fn = result.functions.find(item => item.name === 'unnamed');
        assert.deepEqual(fn.paramsStructured, [{ name: 'size_t', unnamed: true }, { name: 'b', type: 'int' }]);
        const ptr = result.functions.find(item => item.name === 'takes_ptr');
        assert.deepEqual(ptr.paramsStructured, [{ name: 'void *', unnamed: true }],
            'an unnamed void* parameter must not collapse into the zero-param (void) form');
    });
});

describe('fix: C# delegates, operators, indexers, and base classification', () => {
    it('indexes delegate declarations as types', () => {
        const code = 'public delegate int Transformer(int x);\n';
        const result = parse(code, 'csharp');
        const delegateEntry = result.classes.find(cls => cls.name === 'Transformer');
        assert.equal(delegateEntry?.type, 'type');
        assert.ok(delegateEntry?.modifiers.includes('public'));
    });

    it('indexes operator overloads, conversion operators, and indexers', () => {
        const code = [
            'public class Money {',
            '    public int Amount { get; set; }',
            '    public static Money operator +(Money a, Money b) => new Money();',
            '    public static bool operator ==(Money a, Money b) => true;',
            '    public static implicit operator int(Money m) => m.Amount;',
            '    public int this[int i] { get { return i; } set {} }',
            '}',
        ].join('\n');
        const result = parse(code, 'csharp');
        const money = result.classes.find(cls => cls.name === 'Money');
        const memberNames = money.members.map(member => member.name);
        assert.ok(memberNames.includes('operator+'), `got: ${memberNames}`);
        assert.ok(memberNames.includes('operator=='));
        assert.ok(memberNames.includes('operator int'));
        assert.ok(memberNames.includes('this[]'));
        const conversion = money.members.find(member => member.name === 'operator int');
        assert.ok(conversion.modifiers.includes('implicit'));
        const indexer = money.members.find(member => member.name === 'this[]');
        assert.equal(indexer.memberType, 'property');
        assert.equal(indexer.returnType, 'int');
        assert.deepEqual(indexer.paramsStructured, [{ name: 'i', type: 'int' }]);
    });

    it('classifies interface bases as implements, class bases as extends', () => {
        const code = [
            'public interface ISvc { void Run(); }',
            'public interface IExtra : ISvc { void More(); }',
            'public class Svc : ISvc, IDisposable { public void Run() {} public void Dispose() {} }',
            'public class Money : BaseMoney { }',
            'public struct Pair : ISvc { public void Run() {} }',
            'public class Odd : IFoo { }',
            'public class IFoo { }',
        ].join('\n');
        const result = parse(code, 'csharp');
        const byName = new Map(result.classes.map(cls => [cls.name, cls]));
        assert.equal(byName.get('Svc').extends, undefined,
            'a class with only interface bases has no extends');
        assert.deepEqual(byName.get('Svc').implements, ['ISvc', 'IDisposable']);
        assert.equal(byName.get('Money').extends, 'BaseMoney');
        assert.equal(byName.get('Money').implements, undefined);
        assert.deepEqual(byName.get('Pair').implements, ['ISvc'],
            'struct bases are always interfaces');
        assert.equal(byName.get('IExtra').extends, 'ISvc',
            'interfaces extend, never implement');
        assert.equal(byName.get('Odd').extends, 'IFoo',
            'a same-file CLASS named IFoo overrides the I-prefix convention');
    });
});

describe('fix: C pointer types survive in signatures', () => {
    it('named pointer params keep qualifiers and stars; returns keep stars', () => {
        const code = [
            'int a(void *p) { return 0; }',
            'int d(int **pp) { return 0; }',
            'char *strdup2(const char *s) { return 0; }',
            'extern void *(*ts_current_malloc)(size_t);',
            'void reg(void (*cb)(int)) {}',
        ].join('\n');
        const result = parse(code, 'c');
        const byName = new Map(result.functions.map(fn => [fn.name, fn]));
        assert.deepEqual(byName.get('a').paramsStructured, [{ name: 'p', type: 'void *' }]);
        assert.deepEqual(byName.get('d').paramsStructured, [{ name: 'pp', type: 'int **' }]);
        assert.deepEqual(byName.get('strdup2').paramsStructured, [{ name: 's', type: 'const char *' }]);
        assert.equal(byName.get('strdup2').returnType, 'char *');
        assert.equal(byName.get('ts_current_malloc').returnType, 'void *');
        assert.deepEqual(byName.get('reg').paramsStructured, [{ name: 'cb', type: 'void (*)(int)' }]);
    });

    it('C++ default values are cut before name removal', () => {
        const result = parse('int f(int x = 5) { return x; }', 'cpp');
        assert.deepEqual(result.functions[0].paramsStructured,
            [{ name: 'x', type: 'int', optional: true }]);
    });
});

describe('fix: bodyless struct specifiers are not duplicate definitions', () => {
    it('one entry per type: definition wins, references and forward decls fold in', () => {
        const code = [
            'struct S;',
            'void f(struct S *s);',
            'struct S { int x; };',
            'struct Fwd;',
            'struct Fwd;',
        ].join('\n');
        const result = parse(code, 'c');
        const s = result.classes.filter(cls => cls.name === 'S');
        assert.equal(s.length, 1, `S indexed once, got lines ${s.map(c => c.startLine)}`);
        assert.equal(s[0].startLine, 3, 'the bodied definition is the indexed one');
        assert.equal(result.classes.filter(cls => cls.name === 'Fwd').length, 1,
            'an opaque forward-declared type keeps exactly one entry');
    });
});

describe('fix: stacked attribute macros recover fully', () => {
    it('recovers the symbol, indexes no phantom state, and clears the recovery flag', () => {
        const code = [
            '#define A __attribute__((x))',
            '#define B __attribute__((y))',
            'A B extern void (*ab)(void *);',
            'int plain(void) { return 1; }',
        ].join('\n');
        const result = parse(code, 'c');
        assert.ok(result.functions.some(fn => fn.name === 'ab'), 'fn-pointer recovered');
        assert.ok(result.functions.some(fn => fn.name === 'plain'));
        assert.ok(!(result.stateObjects || []).some(s => s.name === 'B'),
            'the macro fragment must not index a phantom state var');
        assert.ok(!result.parseRecovery, 'a fully recovered parse carries no recovery flag');
    });

    it('keeps the recovery flag when a genuine syntax error remains', () => {
        const code = '#define API __attribute__((x))\nAPI int good(void) { return 1; }\nint broken( { \n';
        const result = parse(code, 'c');
        assert.ok(result.functions.some(fn => fn.name === 'good'), 'macro part still recovers');
        assert.equal(result.parseRecovery, true);
    });
});

describe('C/C++ preprocessor configuration conservation', () => {
    it('indexes and resolves AST-proven calls from both conditional branches', () => {
        const dir = tmp({
            'branches.c': [
                'void target(void) {}',
                '#ifdef MODE',
                'void branch_a(void) { target(); }',
                '#else',
                'void branch_b(void) { target(); }',
                '#endif',
                'void use(int x) {',
                '  if (x) {',
                '#ifdef FEATURE',
                '    if (x > 1) {',
                '#endif',
                '      target();',
                '#ifdef FEATURE',
                '    }',
                '#endif',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.equal(index.find('branch_a', { skipCounts: true }).length, 1);
            assert.equal(index.find('branch_b', { skipCounts: true }).length, 1);
            const context = index.context('target');
            assert.deepEqual(context.callers.map(call => call.line), [3, 5, 12]);
            assert.deepEqual(context.unverifiedCallers, []);
            assert.equal(context.meta.account.conserved, true);
            assert.equal(context.meta.account.unaccounted, 0);
        } finally {
            rm(dir);
        }
    });

    it('retains recovery metadata after the source memo turns over', () => {
        const adapter = getLanguageAdapter('c');
        const parser = getParser('c');
        const source = suffix => [
            `/* ${suffix} */`,
            'void target(void) {}',
            '#ifdef MODE',
            'void branch_a(void) { target(); }',
            '#else',
            'void branch_b(void) { target(); }',
            '#endif',
            'void use(int x) {',
            '  if (x) {',
            '#ifdef FEATURE',
            '    if (x > 1) {',
            '#endif',
            '      target();',
            '#ifdef FEATURE',
            '    }',
            '#endif',
            '  }',
            '}',
        ].join('\n');
        const first = source(0);
        for (let i = 0; i < 12; i++) adapter.parse(source(i), parser);
        assert.deepEqual(
            adapter.findUsages(first, 'target', parser)
                .filter(usage => usage.usageType === 'call')
                .map(usage => usage.line)
                .sort((a, b) => a - b),
            [4, 6, 13],
        );
    });
});

describe('v5 C++ compile-time call identity', () => {
    it('recovers explicit call-operator template syntax from the AST', () => {
        const code = [
            'template <typename T> class Converter {',
            '  void operator()(bool value) { operator()<bool>(value); }',
            '  template <typename U> void operator()(U value) {}',
            '};',
        ].join('\n');
        const calls = getLanguageAdapter('cpp').findCallsInCode(
            code, getParser('cpp'));
        const call = calls.find(candidate =>
            candidate.name === 'operator()' && candidate.line === 2);
        assert.ok(call, JSON.stringify(calls));
        assert.equal(call.explicitTemplateCall, true);
        assert.equal(call.argCount, 1);
        assert.deepEqual(call.argKinds, ['type:bool']);
        assert.ok(!calls.some(candidate => candidate.name === 'operator'),
            'the parser-recovery fragment must not leak a phantom callee');
    });

    it('keeps decltype dependencies visible but outside runtime callers', () => {
        const dir = tmp({
            'sample.cpp': [
                'template <typename T> T probe(T value);',
                'template <typename T> struct Box {',
                '  decltype(probe<T>(T{})) value;',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('probe')[0];
            const result = index.findCallers('probe', {
                targetDefinitions: [target],
                collectAccount: true,
                includeMethods: true,
            });
            assert.equal(result.length, 0);
            assert.deepEqual(result.unverifiedEntries.map(entry => ({
                line: entry.line,
                reason: entry.reason,
                uncertaintyClass: entry.uncertaintyClass,
            })), [{
                line: 3,
                reason: 'compile-time-only',
                uncertaintyClass: 'compile-time-dispatch',
            }]);
            const context = index.context('probe', {
                file: target.file,
                line: target.startLine,
            });
            assert.equal(context.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #299: C++ overload-ambiguous promotion by static shape', () => {
    // (A) A `template <>` full specialization is the SAME function as its
    // primary template — name lookup finds the template, specialization
    // choice is instantiation, not overload resolution. Pinning either
    // member must confirm call sites instead of routing overload-ambiguous.
    it('closes a full specialization into the primary template identity', () => {
        const dir = tmp({
            'spec.h': [
                'template <class Item> inline Item read_item(const unsigned char* data) {',
                '  Item item{};',
                '  return item;',
                '}',
                'template <> inline bool read_item<bool>(const unsigned char* data) {',
                '  return *data != 0;',
                '}',
            ].join('\n'),
            'user.cc': [
                '#include "spec.h"',
                'int use(const unsigned char* d) {',
                '  auto f = read_item<float>(d);',
                '  auto b = read_item<bool>(d);',
                '  return int(f) + int(b);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('read_item');
            assert.equal(defs.length, 2);
            const primary = defs.find(d => d.startLine === 1);
            const specialization = defs.find(d => d.startLine === 5);
            assert.ok(primary && specialization);
            assert.equal(specialization.isSpecialization, true);
            assert.ok(!primary.isSpecialization);
            for (const pin of [primary, specialization]) {
                const result = index.findCallers('read_item', {
                    targetDefinitions: [pin],
                    collectAccount: true,
                    includeMethods: true,
                });
                const lines = result.map(c => c.line).sort();
                assert.deepEqual(lines, [3, 4],
                    `pin @${pin.startLine}: both sites confirm — got ` +
                    JSON.stringify(result.map(c => `${c.line}:${c.resolution}`)) +
                    ` unverified=` + JSON.stringify(
                        (result.account?.unverifiedEntries || []).map(e => e.line)));
            }
        } finally { rm(dir); }
    });

    // (C) Exact-concrete-type most-specific: when every argument position
    // carries a concrete static type and exactly one NON-template overload
    // matches all of them exactly, the compiler picks it (identity conversion
    // beats integral conversion; non-template beats template on ties).
    it('selects the exact-type overload and excludes the sibling', () => {
        const dir = tmp({
            'digits.hpp': [
                'inline int span_of(unsigned long long n) { return 20; }',
                'inline int span_of(unsigned int n) { return 10; }',
                'template <typename T>',
                'int span_of(const T& n) { return 0; }',
                'inline int wide_user() {',
                '  unsigned long long big = 9000000000ULL;',
                '  return span_of(big);',
                '}',
                'inline int narrow_user() {',
                '  unsigned int small = 42;',
                '  return span_of(small);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const widePin = index.symbols.get('span_of').find(d => d.startLine === 1);
            const result = index.findCallers('span_of', {
                targetDefinitions: [widePin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepEqual(result.map(c => c.line), [7],
                'only the unsigned long long site confirms: ' +
                JSON.stringify(result.map(c => c.line)));
            assert.ok(result.accountRaw.excludedEntries.some(e =>
                e.line === 11 && e.reason === 'overload-mismatch'),
                'the unsigned int site binds the sibling exactly: ' +
                JSON.stringify(result.accountRaw.excludedEntries));
        } finally { rm(dir); }
    });

    it('refuses exact-type selection for caller template params and literals', () => {
        const dir = tmp({
            'refuse.hpp': [
                'inline int span_of(unsigned long long n) { return 20; }',
                'inline int span_of(unsigned int n) { return 10; }',
                'template <typename UInt> int generic_user(UInt value) {',
                '  return span_of(value);',
                '}',
                'inline int literal_user() {',
                '  return span_of(42);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const widePin = index.symbols.get('span_of').find(d => d.startLine === 1);
            const result = index.findCallers('span_of', {
                targetDefinitions: [widePin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepEqual(result.map(c => c.line), [],
                'neither site is statically decidable: ' +
                JSON.stringify(result.map(c => c.line)));
            const unverifiedLines = (result.unverifiedEntries || [])
                .map(e => e.line).sort();
            assert.deepEqual(unverifiedLines, [4, 7],
                'both sites stay visible: ' + JSON.stringify(unverifiedLines));
        } finally { rm(dir); }
    });

    // (B) Producer-return argument typing: `paint(tint(3))` types the
    // argument from tint's declared return type — composing with the exact
    // winner to decide the overload. Local callables shadowing the producer
    // name and disagreeing producer overloads both refuse.
    it('types arguments from a unique agreed producer return type', () => {
        const dir = tmp({
            'paint.hpp': [
                'struct style { int v; };',
                'inline style tint(int c) { return style{c}; }',
                'inline int paint(style s) { return 1; }',
                'inline int paint(unsigned int width) { return 2; }',
                'inline int producer_user() { return paint(tint(3)); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const stylePin = index.symbols.get('paint').find(d => d.startLine === 3);
            const widthPin = index.symbols.get('paint').find(d => d.startLine === 4);
            const styleResult = index.findCallers('paint', {
                targetDefinitions: [stylePin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepEqual(styleResult.map(c => c.line), [5],
                'the tint-producing site binds paint(style): ' +
                JSON.stringify(styleResult.map(c => c.line)));
            const widthResult = index.findCallers('paint', {
                targetDefinitions: [widthPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepEqual(widthResult.map(c => c.line), [],
                'the site never confirms the width overload');
            assert.ok(widthResult.accountRaw.excludedEntries.some(e =>
                e.line === 5 && e.reason === 'overload-mismatch'),
                'excluded with reason: ' +
                JSON.stringify(widthResult.accountRaw.excludedEntries));
        } finally { rm(dir); }
    });

    it('local callables shadowing the producer name refuse the typing', () => {
        const dir = tmp({
            'shadow.hpp': [
                'struct style { int v; };',
                'inline style tint(int c) { return style{c}; }',
                'inline int paint(style s) { return 1; }',
                'inline int paint(unsigned int width) { return 2; }',
                'inline int shadow_user(unsigned int (*tint)(int)) {',
                '  return paint(tint(4));',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const widthPin = index.symbols.get('paint').find(d => d.startLine === 4);
            const result = index.findCallers('paint', {
                targetDefinitions: [widthPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.ok(!result.accountRaw.excludedEntries.some(e => e.line === 6),
                'the shadowed producer must never exclude the true caller: ' +
                JSON.stringify(result.accountRaw.excludedEntries));
        } finally { rm(dir); }
    });

    it('disagreeing producer overload returns refuse the typing', () => {
        const dir = tmp({
            'mixed.hpp': [
                'struct style { int v; };',
                'inline style mixed(int c) { return style{c}; }',
                'inline unsigned int mixed(long c) { return 2u; }',
                'inline int paint(style s) { return 1; }',
                'inline int paint(unsigned int width) { return 2; }',
                'inline int mixed_user() { return paint(mixed(3)); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const widthPin = index.symbols.get('paint').find(d => d.startLine === 5);
            const result = index.findCallers('paint', {
                targetDefinitions: [widthPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepEqual(result.map(c => c.line), [],
                'no confirmation without agreement');
            assert.ok(!result.accountRaw.excludedEntries.some(e => e.line === 6),
                'no exclusion without agreement: ' +
                JSON.stringify(result.accountRaw.excludedEntries));
            assert.ok((result.unverifiedEntries || []).some(e => e.line === 6),
                'the site stays visible');
        } finally { rm(dir); }
    });

    it('refuses specialization closure when several primaries could own it', () => {
        const dir = tmp({
            'multi.h': [
                'template <class A> int pick(const unsigned char* data) { return 1; }',
                'template <class A, class B> int pick(const unsigned char* data) { return 2; }',
                'template <> inline int pick<bool>(const unsigned char* data) { return 3; }',
            ].join('\n'),
            'muser.cc': [
                '#include "multi.h"',
                'int muse(const unsigned char* d) {',
                '  return pick<char>(d);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('pick');
            const first = defs.find(d => d.startLine === 1);
            const result = index.findCallers('pick', {
                targetDefinitions: [first],
                collectAccount: true,
                includeMethods: true,
            });
            assert.equal(result.length, 0,
                'ambiguous primary ownership must not confirm: ' +
                JSON.stringify(result.map(c => c.line)));
        } finally { rm(dir); }
    });
});

describe('fix #361: C/C++ qualifier resolution and include-closure evidence', () => {
    const answer = (index, name, pin) => {
        const result = index.findCallers(name, {
            targetDefinitions: [pin], collectAccount: true, includeMethods: true,
        });
        const site = entry => `${path.basename(entry.file)}:${entry.line}`;
        return {
            confirmed: result.map(site).sort(),
            unverified: (result.unverifiedEntries || [])
                .map(entry => `${site(entry)}:${entry.reason}`).sort(),
            excluded: (result.accountRaw?.excludedEntries || [])
                .map(entry => `${site(entry)}:${entry.reason}`).sort(),
            result,
        };
    };
    const pinOf = (index, name, file, className) => index.symbols.get(name).find(d =>
        d.relativePath === file && (className === undefined || d.className === className));

    const namespaceMacroProject = () => tmp({
        'include/lib/macros.hpp': [
            '#ifndef LIB_MACROS_HPP',
            '#define LIB_MACROS_HPP',
            '#define LIB_BEGIN namespace lib { \\',
            '    inline namespace LIB_CONCAT(v, 1) {',
            '#define LIB_END \\',
            '    }  /* inline */ \\',
            '    }  // namespace lib',
            '#define LIB_TRY try',
            '#endif',
        ].join('\n'),
        'include/lib/fwd.hpp': [
            '#ifndef LIB_FWD_HPP',
            '#define LIB_FWD_HPP',
            '#include <lib/macros.hpp>',
            'LIB_BEGIN',
            'template<typename T = int> class basic_doc;',
            'using doc = basic_doc<>;',
            'LIB_END',
            '#endif',
        ].join('\n'),
        'include/lib/doc.hpp': [
            '#ifndef LIB_DOC_HPP',
            '#define LIB_DOC_HPP',
            '#include <lib/fwd.hpp>',
            'LIB_BEGIN',
            'template<typename T>',
            'class basic_doc {',
            '  LIB_PRIVATE_UNLESS_TESTED:',
            '    int state = 0;',
            '  public:',
            '    static basic_doc parse(const char* text) {',
            '        LIB_TRY',
            '        {',
            '            return basic_doc();',
            '        }',
            '        LIB_CATCH (int&)',
            '        {',
            '            return basic_doc();',
            '        }',
            '    }',
            '};',
            'struct formatter {',
            '    int parse(int context) { return context; }',
            '};',
            'LIB_END',
            '#endif',
        ].join('\n'),
        'src/alias_user.cpp': [
            '#include <lib/doc.hpp>',
            'using doc = lib::doc;',
            'int main() {',
            '    auto d = doc::parse("x");',
            '    return 0;',
            '}',
        ].join('\n'),
        'src/using_user.cpp': [
            '#include <lib/doc.hpp>',
            'using lib::doc;',
            'int run() {',
            '    auto d = doc::parse("y");',
            '    return 0;',
            '}',
        ].join('\n'),
        'src/generic_user.cpp': [
            '#include <lib/doc.hpp>',
            'template<typename T> int generic() {',
            '    auto d = T::parse("z");',
            '    return 0;',
            '}',
            'int external() {',
            '    auto e = vendor::widget::parse("w");',
            '    return 0;',
            '}',
        ].join('\n'),
    });

    it('recovers class bodies through guard, access-specifier and statement macros', () => {
        const dir = namespaceMacroProject();
        try {
            const index = idx(dir);
            const parse = pinOf(index, 'parse', 'include/lib/doc.hpp', 'basic_doc');
            assert.ok(parse, JSON.stringify(index.symbols.get('parse')));
            assert.equal(parse.className, 'basic_doc');
            assert.ok(!index.symbols.get('parse').some(d =>
                d.relativePath === 'include/lib/doc.hpp' && !d.className),
                'the member is not also indexed as a free function');
        } finally { rm(dir); }
    });

    it('never selects the configuration that skips an include-guarded body', () => {
        const code = [
            '#ifndef LIB_DOC_HPP',
            '#define LIB_DOC_HPP',
            'LIB_BEGIN',
            'class basic_doc',
            '{',
            '  public:',
            '#if defined(LIB_HAS_X)',
            '    void a() {',
            '#else',
            '    void a(int x) {',
            '#endif',
            '    }',
            '    static basic_doc parse(const char* text) { return basic_doc(); }',
            '};',
            'LIB_END',
            '#endif',
        ].join('\n');
        for (const source of conditionalRecoverySources(code)) {
            assert.ok(source.includes('static basic_doc parse'),
                'the guard macro is undefined on the parsed inclusion');
        }
        const parsed = getLanguageAdapter('cpp').parse(code, getParser('cpp'));
        const owner = parsed.classes.find(cls => cls.name === 'basic_doc');
        assert.ok(owner, JSON.stringify(parsed.classes));
        assert.ok(owner.members.some(member => member.name === 'parse'),
            JSON.stringify(owner.members));
    });

    it('decides __cplusplus blocks by language before recovery', () => {
        const code = [
            '#ifndef API_H',
            '#define API_H',
            '#ifdef __cplusplus',
            'extern "C" {',
            '#endif',
            '#define XX(name) int name;',
            'union any_handle {',
            '  HANDLE_MAP(XX)',
            '};',
            'struct loop { int flags; LOOP_PRIVATE_FIELDS };',
            'API_EXTERN int api_length(const char* text, long size);',
            '#ifdef __cplusplus',
            '}',
            '#endif',
            '#endif',
        ].join('\n');
        const parsed = getLanguageAdapter('c').parse(code, getParser('c'));
        const decl = parsed.functions.find(fn => fn.name === 'api_length');
        assert.ok(decl, JSON.stringify(parsed.functions));
        assert.equal(decl.className, undefined);
        assert.ok(!parsed.classes.some(cls => (cls.members || [])
            .some(member => member.name === 'api_length')), JSON.stringify(parsed.classes));
    });

    it('resolves aliases through macro-opened namespaces and confirms the member', () => {
        const dir = namespaceMacroProject();
        try {
            const index = idx(dir);
            const pin = pinOf(index, 'parse', 'include/lib/doc.hpp', 'basic_doc');
            const got = answer(index, 'parse', pin);
            assert.deepEqual(got.confirmed, ['alias_user.cpp:4', 'using_user.cpp:4'],
                JSON.stringify(got));
            assert.deepEqual(got.unverified, [
                'generic_user.cpp:3:dependent-qualifier',
                'generic_user.cpp:7:unresolved-qualifier',
            ], JSON.stringify(got));
        } finally { rm(dir); }
    });

    it('excludes a qualifier that resolves to an unrelated class', () => {
        const dir = namespaceMacroProject();
        try {
            const index = idx(dir);
            const pin = pinOf(index, 'parse', 'include/lib/doc.hpp', 'formatter');
            const got = answer(index, 'parse', pin);
            assert.deepEqual(got.confirmed, [], JSON.stringify(got));
            assert.ok(got.excluded.includes('alias_user.cpp:4:receiver-type-mismatch') &&
                got.excluded.includes('using_user.cpp:4:receiver-type-mismatch'),
                JSON.stringify(got));
            assert.ok(got.unverified.includes('generic_user.cpp:3:dependent-qualifier'),
                JSON.stringify(got));
        } finally { rm(dir); }
    });

    it('records namespace effects of macros and standalone macro markers', () => {
        const adapter = getLanguageAdapter('cpp');
        const parsed = adapter.parse([
            '#define OPEN namespace outer { inline namespace v2 {',
            '#define CLOSE } }',
            'OPEN',
            'class widget {};',
            'CLOSE',
            'const char* s = "OPEN";',
        ].join('\n'), getParser('cpp'));
        const effects = Object.fromEntries(parsed.macros
            .filter(macro => macro.namespaceScope)
            .map(macro => [macro.name, macro.namespaceScope]));
        assert.deepEqual(effects, {
            OPEN: { opens: [['outer'], []], closes: 0 },
            CLOSE: { opens: [], closes: 2 },
        });
        assert.deepEqual(parsed.macroScopeMarkers.map(marker => `${marker.name}:${marker.line}`),
            ['OPEN:3', 'CLOSE:5']);
    });

    it('follows transitive quoted includes, resolving an -I-only header by unique basename', () => {
        const dir = tmp({
            'src/common.h': 'void lib_free(void* p);\n',
            'src/common.c': [
                '#include "common.h"',
                'void lib_free(void* p) { (void)p; }',
            ].join('\n'),
            'src/unix/internal.h': '#include "common.h"\n',
            'src/unix/core.c': [
                '#include "internal.h"',
                'void release(void* p) {',
                '    lib_free(p);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const pin = pinOf(index, 'lib_free', 'src/common.c');
            const got = answer(index, 'lib_free', pin);
            assert.deepEqual(got.confirmed, ['core.c:3'], JSON.stringify(got));
            const site = got.result.find(entry => entry.line === 3);
            assert.equal(site.provenance?.rule, 'include-basename', JSON.stringify(site));
        } finally { rm(dir); }
    });

    it('treats compile-database include paths as proven include edges', () => {
        const dir = tmp({
            'src/common.h': 'void lib_free(void* p);\n',
            'src/common.c': '#include "common.h"\nvoid lib_free(void* p) { (void)p; }\n',
            'src/unix/internal.h': '#include "common.h"\n',
            'src/unix/core.c': '#include "internal.h"\nvoid release(void* p) {\n    lib_free(p);\n}\n',
        });
        try {
            fs.writeFileSync(path.join(dir, 'compile_commands.json'), JSON.stringify([
                { directory: dir, file: 'src/common.c', arguments: ['cc', '-Isrc', '-c', 'src/common.c'] },
                { directory: dir, file: 'src/unix/core.c', arguments: ['cc', '-Isrc', '-c', 'src/unix/core.c'] },
            ]));
            const index = idx(dir);
            const pin = pinOf(index, 'lib_free', 'src/common.c');
            const got = answer(index, 'lib_free', pin);
            assert.deepEqual(got.confirmed, ['core.c:3'], JSON.stringify(got));
            assert.equal(got.result[0].provenance?.rule, 'import-supported');
        } finally { rm(dir); }
    });

    it('keeps platform-variant definitions link-ambiguous unless the unit separates them', () => {
        const files = {
            'include/api.h': 'int translate(int code);\n',
            'src/unix/core.c': [
                '#include "../../include/api.h"',
                'int translate(int code) { return code; }',
                'int unix_user(void) { return translate(1); }',
            ].join('\n'),
            'src/win/error.c': [
                '#include "../../include/api.h"',
                'int translate(int code) { return -code; }',
            ].join('\n'),
            'src/common.c': [
                '#include "../include/api.h"',
                'int shared_user(void) { return translate(2); }',
            ].join('\n'),
        };
        let dir = tmp(files);
        try {
            const index = idx(dir);
            const winPin = pinOf(index, 'translate', 'src/win/error.c');
            const got = answer(index, 'translate', winPin);
            assert.deepEqual(got.confirmed, [], JSON.stringify(got));
            assert.deepEqual(got.unverified, ['common.c:2:link-ambiguous'], JSON.stringify(got));
            assert.ok(got.excluded.includes('core.c:3:other-definition'), JSON.stringify(got));
            const unixPin = pinOf(index, 'translate', 'src/unix/core.c');
            const unix = answer(index, 'translate', unixPin);
            assert.deepEqual(unix.confirmed, ['core.c:3'], JSON.stringify(unix));
            assert.deepEqual(unix.unverified, ['common.c:2:link-ambiguous'], JSON.stringify(unix));
        } finally { rm(dir); }
        dir = tmp(files);
        try {
            fs.writeFileSync(path.join(dir, 'compile_commands.json'), JSON.stringify(
                ['src/unix/core.c', 'src/common.c'].map(file => ({
                    directory: dir, file, arguments: ['cc', '-c', file],
                }))));
            const index = idx(dir);
            const unix = answer(index, 'translate', pinOf(index, 'translate', 'src/unix/core.c'));
            assert.deepEqual(unix.confirmed, ['common.c:2', 'core.c:3'], JSON.stringify(unix));
            const win = answer(index, 'translate', pinOf(index, 'translate', 'src/win/error.c'));
            assert.ok(win.excluded.includes('common.c:2:other-definition'), JSON.stringify(win));
        } finally { rm(dir); }
    });

    it('resolves angle-bracket project includes through include directories', () => {
        const dir = tmp({ 'include/pkg/api.h': 'int f(void);\n', 'src/a.c': '#include <pkg/api.h>\n' });
        try {
            assert.equal(resolveImport('pkg/api.h', path.join(dir, 'src/a.c'),
                { language: 'c', root: dir }), path.join(dir, 'include/pkg/api.h'));
            assert.equal(resolveImport('stdio.h', path.join(dir, 'src/a.c'),
                { language: 'c', root: dir }), null);
        } finally { rm(dir); }
    });

    it('gives every resolution-tiered unverified caller a reason', () => {
        const dir = tmp({
            'lib/lib.c': 'int helper(int x) { return x; }\n',
            'app/user.c': 'int use(void) { return helper(1); }\n',
        });
        try {
            const index = idx(dir);
            const got = answer(index, 'helper', pinOf(index, 'helper', 'lib/lib.c'));
            const unverified = [...got.result, ...(got.result.unverifiedEntries || [])]
                .filter(entry => entry.tier === 'unverified');
            assert.ok(unverified.length > 0, JSON.stringify(got));
            assert.deepEqual(unverified.map(entry => entry.reason), ['no-scope-evidence']);
        } finally { rm(dir); }
    });
});

describe('fix #362: token-pasting macro dispatch', () => {
    const callersOf = (index, name) => {
        const pin = index.symbols.get(name).find(d => d.type === 'function');
        const result = index.findCallers(name, {
            targetDefinitions: [pin], collectAccount: true,
        });
        const site = entry => `${path.basename(entry.file)}:${entry.line}`;
        return {
            confirmed: result.map(site).sort(),
            rules: result.map(entry => entry.provenance?.rule),
            macros: result.map(entry => entry.macroExpansion?.macro),
            unverified: (result.unverifiedEntries || [])
                .map(entry => `${site(entry)}:${entry.reason}`).sort(),
        };
    };
    const deadNames = index => {
        const response = execute(index, 'deadcode', {});
        assert.ok(response.ok, response.error);
        return { names: response.result.map(item => item.name).sort(), result: response.result };
    };

    it('pasted call targets in a switch dispatch are callers; the unreferenced sibling stays dead', () => {
        const dir = tmp({
            'fs.c': [
                'typedef struct { int type; } req_t;',
                'static void fs__rmdir(req_t* req) { (void)req; }',
                'static void fs__stat(req_t* req) { (void)req; }',
                'static void fs__orphan(req_t* req) { (void)req; }',
                '#define XX(uc, lc)  case UV_FS_##uc: fs__##lc(req); break;',
                'enum { UV_FS_RMDIR, UV_FS_STAT };',
                'static void dispatch(req_t* req) {',
                '  switch (req->type) {',
                '    XX(RMDIR, rmdir)',
                '    XX(STAT, stat)',
                '    default: break;',
                '  }',
                '}',
                '#undef XX',
                'int main(void) { req_t r = {0}; dispatch(&r); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const stat = callersOf(index, 'fs__stat');
            assert.deepEqual(stat.confirmed, ['fs.c:10']);
            assert.deepEqual(stat.rules, ['macro-expansion']);
            assert.deepEqual(stat.macros, ['XX']);
            assert.deepEqual(callersOf(index, 'fs__rmdir').confirmed, ['fs.c:9']);
            assert.deepEqual(deadNames(index).names, ['fs__orphan']);
            const callees = index.findCallees(index.symbols.get('dispatch')[0])
                .map(callee => callee.name).sort();
            assert.ok(callees.includes('fs__stat') && callees.includes('fs__rmdir'));
        } finally { rm(dir); }
    });

    it('X-macro tables through a header list and an unindexed .def list keep handlers alive', () => {
        const dir = tmp({
            'list.h': [
                '#ifndef LIST_H',
                '#define LIST_H',
                '#define HANDLERS(X) X(open) X(close)',
                '#endif',
            ].join('\n'),
            'cmds.def': 'CMD(start)\nCMD(stop)\n',
            'table.c': [
                '#include "list.h"',
                'typedef void (*fn)(void);',
                'struct entry { const char* name; fn handler; };',
                'void handle_open(void) {}',
                'void handle_close(void) {}',
                'static void handle_unused(void) {}',
                'static void cmd_start(void) {}',
                'static void cmd_stop(void) {}',
                'static void cmd_dead(void) {}',
                '#define X(n) { #n, handle_##n },',
                'static const struct entry table[] = { HANDLERS(X) };',
                '#undef X',
                '#define CMD(n) { #n, cmd_##n },',
                'static const struct entry cmds[] = {',
                '#include "cmds.def"',
                '};',
                '#undef CMD',
                'int main(void) { return (int)(table[0].handler == 0) + (int)(cmds[0].handler == 0); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = deadNames(index).names;
            assert.ok(dead.includes('handle_unused'), dead.join(','));
            assert.ok(dead.includes('cmd_dead'), dead.join(','));
            for (const live of ['handle_open', 'handle_close', 'cmd_start', 'cmd_stop']) {
                assert.ok(!dead.includes(live), `${live} must not be dead: ${dead.join(',')}`);
            }
        } finally { rm(dir); }
    });

    it('higher-order and nested pasting macros produce calls at the argument spelling', () => {
        const dir = tmp({
            'run.c': [
                'static int work(int x) { return x; }',
                'static int do_task(void) { return 1; }',
                '#define CALL(f, x) f(x)',
                '#define CAT(a, b) a##b',
                '#define MK(n) CAT(do_, n)()',
                'int main(void) {',
                '  int r = CALL(work, 2);',
                '  return r + MK(task);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const work = index.findCallers('work', { collectAccount: true });
            assert.deepEqual(work.map(c => `${c.line}:${c.column}`), ['7:15']);
            assert.equal(work[0].macroExpansion.origin, 'argument');
            const task = callersOf(index, 'do_task');
            assert.deepEqual(task.confirmed, ['run.c:8']);
            assert.deepEqual(task.macros, ['MK']);
        } finally { rm(dir); }
    });

    it('conditional macro definitions that disagree route the produced call unverified', () => {
        const dir = tmp({
            'cfg.c': [
                'static void impl_safe(void) {}',
                'static void impl_safe_fast(void) {}',
                'static void log_safe(void) {}',
                '#ifdef FAST',
                '#define RUN(k) impl_##k##_fast(); log_##k()',
                '#else',
                '#define RUN(k) impl_##k(); log_##k()',
                '#endif',
                'int main(void) { RUN(safe); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // Every alternative produces log_safe: one answer.
            assert.deepEqual(callersOf(index, 'log_safe').confirmed, ['cfg.c:9']);
            for (const name of ['impl_safe', 'impl_safe_fast']) {
                const answer = callersOf(index, name);
                assert.deepEqual(answer.confirmed, []);
                assert.deepEqual(answer.unverified, ['cfg.c:9:macro-definition-ambiguous']);
            }
        } finally { rm(dir); }
    });

    it('C++ pasted qualified calls resolve like written ones', () => {
        const dir = tmp({
            'h.cpp': [
                'namespace ns {',
                'void handle_a() {}',
                'void handle_b() {}',
                '}',
                '#define DISPATCH(n) ns::handle_##n()',
                'int main() { DISPATCH(a); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(callersOf(index, 'handle_a').confirmed, ['h.cpp:6']);
            assert.deepEqual(callersOf(index, 'handle_b').confirmed, []);
        } finally { rm(dir); }
    });

    it('a pasting macro that is never expanded withholds names it could spell and discloses blind sites', () => {
        const dir = tmp({
            'api.h': [
                '#define ON(n) on_##n',
                '#define PREFIX uv_',
                '#ifdef ALT',
                '#define PFX alt_',
                '#else',
                '#define PFX std_',
                '#endif',
                '#define CAT(a, b) a##b',
                '#define XCAT(a, b) CAT(a, b)',
            ].join('\n'),
            'impl.c': [
                '#include "api.h"',
                'static void on_click(void) {}',
                'static void other_dead(void) {}',
                'static void uv_run(void) {}',
                'static void std_stop(void) {}',
                'int main(void) { XCAT(PREFIX, run)(); XCAT(PFX, stop)(); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // An object-like argument is pre-expanded before the paste.
            assert.deepEqual(callersOf(index, 'uv_run').confirmed, ['impl.c:6']);
            const { names, result } = deadNames(index);
            assert.ok(!names.includes('on_click'), names.join(','));
            assert.ok(!names.includes('uv_run'), names.join(','));
            assert.ok(names.includes('other_dead'), names.join(','));
            // Disagreeing configurations of PFX: the paste is not computed.
            assert.ok(names.includes('std_stop'), names.join(','));
            assert.equal(result.macroPaste.withheld, 1);
            assert.equal(result.macroPaste.blind.count, 1);
            assert.equal(result.macroPaste.blind.sample[0].reason, 'opaque-paste-operand');
            const { formatDeadcode } = require('../core/output');
            const text = formatDeadcode(result);
            assert.match(text, /1 candidate\(s\) withheld: a token-pasting macro/);
            assert.match(text, /WARNING: 1 token-pasting macro dispatch invocation/);
            const health = execute(index, 'doctor', { deep: true });
            assert.ok(health.ok, health.error);
            assert.equal(health.result.blindSpots.macroPasteDispatch.count, 1);
        } finally { rm(dir); }
    });

    it('expansion edges follow edits to the invoking file without a stale cache', () => {
        const dir = tmp({
            'd.c': [
                'static void op_a(void) {}',
                'static void op_b(void) {}',
                '#define OP(n) op_##n();',
                'int main(void) { OP(a) OP(b) return 0; }',
            ].join('\n'),
        });
        try {
            let index = idx(dir);
            assert.deepEqual(deadNames(index).names, []);
            index.saveCache();
            const file = path.join(dir, 'd.c');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf-8')
                .replace('OP(a) OP(b)', 'OP(a)'));
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(file, future, future);
            index = idx(dir);
            assert.deepEqual(deadNames(index).names, ['op_b']);
        } finally { rm(dir); }
    });

    it('persisted expansions are reused warm and revalidated against include targets', () => {
        const { ProjectIndex } = require('../core/project');
        const dir = tmp({
            'cmds.def': 'CMD(start)\n',
            'table.c': [
                'static void cmd_start(void) {}',
                'static void cmd_later(void) {}',
                'struct e { const char* n; void (*f)(void); };',
                '#define CMD(n) { #n, cmd_##n },',
                'static const struct e cmds[] = {',
                '#include "cmds.def"',
                '};',
                'int main(void) { return cmds[0].f == 0; }',
            ].join('\n'),
        });
        try {
            const cold = idx(dir);
            assert.deepEqual(deadNames(cold).names, ['cmd_later']);
            cold.saveCache();

            const warm = new ProjectIndex(dir);
            assert.equal(warm.loadCache(), true);
            assert.deepEqual(deadNames(warm).names, ['cmd_later']);
            assert.equal(warm.macroExpansionDirty, false, 'warm run reuses persisted expansions');

            fs.writeFileSync(path.join(dir, 'cmds.def'), 'CMD(start)\nCMD(later)\n');
            const edited = new ProjectIndex(dir);
            assert.equal(edited.loadCache(), true);
            assert.deepEqual(deadNames(edited).names, []);
            assert.equal(edited.macroExpansionDirty, true, 'changed include target recomputes');
        } finally { rm(dir); }
    });

    it('#define inside an enumerator list is an indexed macro definition', () => {
        const dir = tmp({
            'e.h': [
                '#define ERRS(XX) XX(EIO) XX(EAGAIN)',
                'typedef enum {',
                '#define XX(code) E_##code,',
                '  ERRS(XX)',
                '#undef XX',
                '  E_MAX',
                '} err_t;',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const xx = (index.symbols.get('XX') || []).map(d => [d.startLine, d.functionLike, d.ppBody]);
            assert.deepEqual(xx, [[3, true, 'E_ ## code ,']]);
        } finally { rm(dir); }
    });
});

describe('fix #364: audit-async classifies C# async producers by what a call returns', () => {
    it('async iterators feed await foreach, async void has nothing to await, Task calls must be awaited', () => {
        const dir = tmp({
            'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
            'Worker.cs': [
                'using System.Collections.Generic;',                         // 1
                'using System.Threading.Tasks;',                             // 2
                'class Worker {',                                            // 3
                '    async IAsyncEnumerable<int> Items() {',                 // 4
                '        await Task.Yield();',                               // 5
                '        yield return 1;',                                   // 6
                '    }',                                                     // 7
                '    async void Fire() { await Task.Yield(); }',             // 8
                '    async Task SaveAsync() { await Task.Yield(); }',        // 9
                '    async Task Run() {',                                    // 10
                '        await foreach (var i in Items()) { }',              // 11
                '        Fire();',                                           // 12
                '        SaveAsync();',                                      // 13
                '        Items();',                                          // 14
                '        await SaveAsync();',                                // 15
                '    }',                                                     // 16
                '}',
            ].join('\n'),
        });
        try {
            const audit = idx(dir).auditAsync();
            assert.deepEqual(audit.issues.map(i => [i.line, i.calleeName, i.reason || null]), [
                [13, 'SaveAsync', null],
                [14, 'Items', 'async-iterator-discarded'],
            ]);
        } finally { rm(dir); }
    });
});

describe('fix #367: C# audit-async flow and C/C++ language-conditional header branches', () => {
    it('#367c C#: tasks passed on or explicitly discarded are not findings; a discarded or unread task is', () => {
        const dir = tmp({
            'App.cs': [
                'using System.Threading.Tasks;',                       // 1
                'public class App {',                                  // 2
                '  async Task<int> Load() { return 1; }',              // 3
                '  async Task Use(Task<int> t) { await t; }',          // 4
                '  async Task Run() {',                                // 5
                '    await Use(Load());',                              // 6 flow
                '    _ = Load();',                                     // 7 explicit discard
                '    Load();',                                         // 8 discarded
                '    var unused = Load();',                            // 9 never read
                '    var kept = Load();',                              // 10
                '    await kept;',                                     // 11
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const lines = idx(dir).auditAsync({}).issues.map(i => i.line).sort((a, b) => a - b);
            assert.deepStrictEqual(lines, [8, 9]);
        } finally { rm(dir); }
    });

    it('#367b a C header keeps its `#ifdef __cplusplus` overload, visible only to C++ translation units', () => {
        const dir = tmp({
            'include/api.h': [
                '#ifndef API_H',                                                  // 1
                '#define API_H',                                                  // 2
                '#ifdef __cplusplus',                                             // 3
                'extern "C" {',                                                   // 4
                '#endif',                                                         // 5
                'typedef enum { MODE_A, MODE_B } mode_t2;',                       // 6
                'int set_mode(int fd, mode_t2 mode);',                            // 7
                '#ifdef __cplusplus',                                             // 8
                '}',                                                              // 9
                'inline int set_mode(int fd, int mode) {',                        // 10
                '  return set_mode(fd, static_cast<mode_t2>(mode));',             // 11
                '}',                                                              // 12
                '#endif',                                                         // 13
                '#endif',                                                         // 14
            ].join('\n'),
            'src/impl.c': '#include "../include/api.h"\nint set_mode(int fd, mode_t2 mode) { return fd + (int)mode; }\n',
            'src/use.c': '#include "../include/api.h"\nint use_c(void) { return set_mode(1, MODE_A); }\n',
            'src/user.cpp': '#include "../include/api.h"\nint use_cpp() { return set_mode(1, 0); }\n',
        });
        try {
            const index = idx(dir);
            const defs = (index.symbols.get('set_mode') || []).map(d => `${d.relativePath}:${d.startLine}:${d.languageBranch || ''}`);
            assert.ok(defs.includes('include/api.h:10:cpp'), JSON.stringify(defs));
            assert.ok(defs.includes('include/api.h:7:'), JSON.stringify(defs));
            const r = execute(index, 'show', { name: 'include/api.h:10:set_mode' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const lines = [...r.result.context.callers, ...r.result.context.unverifiedCallers]
                .map(c => `${path.basename(c.file)}:${c.line}`);
            assert.ok(!lines.includes('use.c:2'), `C translation unit never sees the C++ overload: ${JSON.stringify(lines)}`);
            assert.strictEqual(r.result.context.meta.account.conserved, true);
            const c = execute(index, 'show', { name: 'include/api.h:7:set_mode' });
            const cLines = c.result.context.callers.map(x => `${path.basename(x.file)}:${x.line}`);
            assert.ok(cLines.includes('use.c:2'), JSON.stringify(cLines));
        } finally { rm(dir); }
    });
});

describe('fix #369: bare calls to local function values (C/C++)', () => {
    it('a local lambda or function-pointer parameter named like a project function is the callee', () => {
        const dir = tmp({
            'a.cpp': [
                'void run() {}',
                'void cb() {}',
                'void decl() {}',
                'void go(int p, void (*cb)(void)) {',
                '    auto run = []() {};',
                '    run();',
                '    cb();',
                '    void decl();',
                '    decl();',
                '    for (auto &f : std::vector<int>{}) {}',
                '}',
                'void other() { run(); }',
            ].join('\n') + '\n',
            'b.c': [
                'void tick(void) {}',
                'void loop(void (*tick)(void)) { tick(); }',
                'void main_loop(void) { tick(); }',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const lines = entries => (entries || []).map(entry => `${entry.relativePath}:${entry.line}`);
            assert.deepStrictEqual(lines(index.context('run', { file: 'a.cpp', line: 1 }).callers), ['a.cpp:12']);
            assert.deepStrictEqual(lines(index.context('cb', { file: 'a.cpp', line: 2 }).callers), []);
            // A block-scope function declaration is not a value: decl() is the function.
            assert.deepStrictEqual(lines(index.context('decl', { file: 'a.cpp', line: 3 }).callers), ['a.cpp:9']);
            assert.deepStrictEqual(lines(index.context('tick', { file: 'b.c', line: 1 }).callers), ['b.c:3']);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #377: a call spelled NAME( under #define NAME is the macro (C/C++)', () => {
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();
    const reasonOf = (ctx, reason) => ((ctx.meta.account.excluded.byReason[reason] || {}).sample || [])
        .map(site => `${site.file}:${site.line}`).sort();

    it('C: an included function-like macro shadows the function; conditional and wrapper macros do not decide', () => {
        const dir = tmp({
            't.h': 'int twice(int x);\nint helper(int x);\n',
            'm.h': '#ifndef M_H\n#define M_H\n#define twice(x) ((x) << 1)\n#endif\n',
            'a.c': '#include "t.h"\nint twice(int x) { return x + x; }\nint helper(int x) { return x; }\n',
            'e.c': '#include "t.h"\n#include "m.h"\nint use_e(void) { return twice(4); }\n',
            'f.c': '#include "t.h"\nint use_f(void) { return twice(6); }\n',
            'g.c': '#include "t.h"\n#ifdef FAST\n#define helper(x) ((x) + 1)\n#endif\nint use_g(void) { return helper(7); }\n',
            'h.c': '#include "t.h"\nint use_h(void) { return helper(8); }\n',
            'alt.h': '#ifdef HAVE_IO\nint io_close(int fd);\n#else\n#define io_close(fd) 0\n#endif\n',
            'io.c': '#include "alt.h"\nint io_close(int fd) { return fd; }\n',
            'k.c': '#include "alt.h"\nint use_k(void) { return io_close(3); }\n',
        });
        try {
            const index = idx(dir);
            const twice = index.context('twice', { file: 'a.c', line: 2 });
            assert.deepEqual(at(twice.callers), ['f.c:2']);
            assert.deepEqual(reasonOf(twice, 'macro-namespace'), ['e.c:3']);
            const helper = index.context('helper', { file: 'a.c', line: 3 });
            assert.deepEqual(at(helper.callers), ['h.c:2']);
            assert.deepEqual(at(helper.unverifiedCallers), ['g.c:5']);
            assert.equal(helper.unverifiedCallers[0].reason, 'macro-namespace');
            // Declaration and macro in one header are configuration alternatives.
            const close = index.context('io_close', { file: 'io.c', line: 2 });
            assert.deepEqual(at(close.callers), ['k.c:2']);
            // Callee side: the macro in effect is the callee.
            const useE = index.context('use_e', { file: 'e.c', line: 3 });
            assert.deepEqual(useE.callees.map(c => `${c.relativePath}:${c.startLine}:${c.type}`), ['m.h:3:macro']);
            const useF = index.context('use_f', { file: 'f.c', line: 2 });
            assert.deepEqual(useF.callees.map(c => `${c.relativePath}:${c.startLine}:${c.type}`), ['a.c:2:function']);
        } finally {
            rm(dir);
        }
    });

    it('C++: a function-like macro in effect shadows member and qualified calls of the name', () => {
        const dir = tmp({
            'box.hpp': 'struct Box {\n    int grow(int x) { return x + 1; }\n};\n',
            'shim.hpp': '#pragma once\n#define grow(x) (x)\n',
            'a.cpp': '#include "box.hpp"\nint use_a(Box& b) { return b.grow(1); }\n',
            'b.cpp': '#include "box.hpp"\n#include "shim.hpp"\nint use_b(Box& b, int v) { return b.grow(v); }\n',
        });
        try {
            const index = idx(dir);
            const grow = index.context('grow', { file: 'box.hpp', line: 2 });
            assert.deepEqual(at(grow.callers), ['a.cpp:2']);
            assert.deepEqual(reasonOf(grow, 'macro-namespace'), ['b.cpp:3']);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #379: C/C++ linkage identity, decoration macros, macro access, configuration variants', () => {
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();
    const symbolsOf = (index, name) => (index.symbols.get(name) || [])
        .map(d => `${d.relativePath}:${d.startLine}:${d.className || ''}:${d.type}`).sort();
    const planSites = (index, params) => {
        const response = execute(index, 'plan', params);
        assert.ok(response.ok, response.error);
        return response.result.changes.map(change => `${change.file}:${change.line}`).sort();
    };

    it('C: a local forward declaration denotes the external definition (callers, callees, plan)', () => {
        const dir = tmp({
            'a.c': 'static int unused_local(void){return 0;}\nint helper(int x) { return x + 1; }\n',
            'b.c': 'int helper(int x);\nint main(void) { return helper(2); }\n',
            'c.c': 'int helper(int);\nint other(void) { return helper(3); }\n',
            's.c': 'static int twice(int x);\nint run(void) { return twice(2); }\nstatic int twice(int x) { return x * 2; }\n',
            't.c': 'static int twice(int x) { return x; }\nint run2(void) { return twice(5); }\n',
        });
        try {
            const index = idx(dir);
            const fromDefinition = index.context('helper', { file: 'a.c', line: 2 });
            assert.deepEqual(at(fromDefinition.callers), ['b.c:2', 'c.c:2']);
            assert.equal(fromDefinition.meta.account.excluded.total, 0);
            // Pinning a prototype gives the same answer: declarations are not
            // call targets of their own.
            const fromPrototype = index.context('helper', { file: 'b.c', line: 1 });
            assert.deepEqual(at(fromPrototype.callers), ['b.c:2', 'c.c:2']);
            const main = index.findCallees(index.symbols.get('main')[0], { collectAccount: true });
            assert.deepEqual(main.map(c => `${c.relativePath}:${c.startLine}`), ['a.c:2']);
            assert.deepEqual(planSites(index, { name: 'helper', file: 'a.c', line: 2, renameTo: 'zz' }),
                ['a.c:2', 'b.c:1', 'b.c:2', 'c.c:1', 'c.c:2']);
            // Internal linkage: a static forward declaration announces its own
            // file's definition; another file's static namesake stays apart.
            const twice = index.context('twice', { file: 's.c', line: 3 });
            assert.deepEqual(at(twice.callers), ['s.c:2']);
            assert.deepEqual(planSites(index, { name: 'twice', file: 's.c', line: 3, renameTo: 'tw' }),
                ['s.c:1', 's.c:2', 's.c:3']);
        } finally {
            rm(dir);
        }
    });

    it('C: definitions in complementary preprocessor branches stay link-ambiguous on both sides', () => {
        const dir = tmp({
            'alloc.h': [
                '#ifndef ALLOC_H', '#define ALLOC_H', '#ifndef _WIN32',
                'static inline void *hi_realloc(void *p, int n) { return p; }',
                '#else', 'void *hi_realloc(void *p, int n);', '#endif', '#endif', '',
            ].join('\n'),
            'alloc.c': '#include "alloc.h"\n#ifdef _WIN32\nvoid *hi_realloc(void *p, int n) { return p; }\n#endif\n',
            'read.c': '#include "alloc.h"\nvoid *grow(void *p) { return hi_realloc(p, 2); }\n',
            'solo.h': '#ifdef FEATURE\nint only_here(int x) { return x; }\n#endif\n',
            'use.c': '#include "solo.h"\nint use(void) { return only_here(1); }\n',
        });
        try {
            const index = idx(dir);
            for (const [file, line] of [['alloc.h', 4], ['alloc.c', 3]]) {
                const ctx = index.context('hi_realloc', { file, line });
                assert.deepEqual(at(ctx.callers), [], `${file}:${line}`);
                assert.deepEqual(at(ctx.unverifiedCallers), ['read.c:2']);
                assert.equal(ctx.unverifiedCallers[0].reason, 'link-ambiguous');
            }
            const grow = index.findCallees(index.symbols.get('grow')[0], { collectAccount: true });
            assert.deepEqual(grow.map(c => c.name), []);
            assert.deepEqual(grow.unverifiedCallees.map(c => `${c.name}:${c.reason}`), ['hi_realloc:link-ambiguous']);
            // A conditional definition without alternatives still confirms.
            const only = index.context('only_here', { file: 'solo.h', line: 2 });
            assert.deepEqual(at(only.callers), ['use.c:2']);
        } finally {
            rm(dir);
        }
    });

    it('C++: a decoration macro before a qualified return type keeps names and classes intact', () => {
        const dir = tmp({
            'f.hpp': [
                '#pragma once', '#include <string>', '#define MY_INLINE inline',
                '#define MY_NODISCARD [[nodiscard]]',
                'namespace sinks { template <typename M> struct Sink { void flush(); Sink(); }; }',
                'class Fmt {', 'public:', '    std::string make(int x) const;', '    std::string other() const;',
                '    MY_NODISCARD std::size_t count() const { return 1; }',
                '    MY_NODISCARD bool empty() const { return true; }',
                '    Fmt *flag(bool v = true) { return this; }', '};',
                'MY_INLINE std::string Fmt::make(int x) const { return other(); }',
                'MY_INLINE std::string Fmt::other() const { return "a"; }',
                'template <typename M>', 'void MY_INLINE sinks::Sink<M>::flush() {}',
                'template <typename M>', 'MY_INLINE sinks::Sink<M>::Sink() {}',
                'inline std::string use(const Fmt &f, Fmt *o) { o->flag(); return f.make(1); }', '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(symbolsOf(index, 'make'), ['f.hpp:14:Fmt:function', 'f.hpp:8:Fmt:method']);
            assert.deepEqual(symbolsOf(index, 'flag'), ['f.hpp:12:Fmt:method']);
            assert.deepEqual(symbolsOf(index, 'count'), ['f.hpp:10:Fmt:method']);
            assert.deepEqual(symbolsOf(index, 'flush'), ['f.hpp:17:Sink<M>:function', 'f.hpp:5:Sink:method']);
            const sink = (index.symbols.get('Sink') || []).find(d => d.startLine === 19);
            assert.ok(sink && sink.type === 'constructor' && sink.namespace === 'sinks', JSON.stringify(sink));
            const flag = index.context('flag', { file: 'f.hpp', line: 12 });
            assert.deepEqual(at(flag.callers), ['f.hpp:20']);
            const other = index.context('other', { file: 'f.hpp', line: 9 });
            assert.deepEqual(at(other.callers), ['f.hpp:14']);
            assert.deepEqual(planSites(index, { name: 'make', file: 'f.hpp', line: 8, renameTo: 'mk' }),
                ['f.hpp:14', 'f.hpp:20', 'f.hpp:8']);
        } finally {
            rm(dir);
        }
    });

    it('C++: an export macro in a class head with a templated base keeps the class and its dispatch', () => {
        const dir = tmp({
            'a.h': [
                '#pragma once', '#include <memory>', '#define X_API',
                'class Base {', 'public:', '    virtual ~Base() = default;', '    void flush() { flush_(); }',
                'protected:', '    virtual void flush_();', '};',
                'class X_API Derived : public std::enable_shared_from_this<Derived>, public Base {',
                'protected:', '    void flush_() override;', '};',
                'class X_API Final final : public Base {', 'protected:', '    void flush_() override;', '};', '',
            ].join('\n'),
            'a.cpp': '#include "a.h"\nvoid Base::flush_() {}\nvoid Derived::flush_() {}\nvoid Final::flush_() {}\n',
        });
        try {
            const index = idx(dir);
            const derived = (index.symbols.get('Derived') || []).find(d => d.type === 'class');
            assert.ok(derived, 'Derived is a class');
            assert.match(derived.extends || '', /\bBase\b/);
            assert.ok((index.symbols.get('Final') || []).some(d => d.type === 'class'));
            assert.ok(!index.symbols.has('X_API') ||
                index.symbols.get('X_API').every(d => d.type === 'macro'));
            const ctx = index.context('flush_', { file: 'a.cpp', line: 3 });
            assert.deepEqual([...at(ctx.callers), ...at(ctx.unverifiedCallers)], ['a.h:7']);
            assert.equal(ctx.meta.account.excluded.total, 0);
        } finally {
            rm(dir);
        }
    });

    it('C++: access after a member-list macro follows its body; unknown access is never claimed dead', () => {
        const dir = tmp({
            'm.hpp': '#pragma once\n#define DECLARE_IMPL(n) void n##_impl();\n#define OPEN_UP() public:\n',
            'a.hpp': [
                '#pragma once', '#include <string>', '#include "m.hpp"',
                '#define ERR_DEF(parent, name) \\', '  protected: \\', '    name(int code) : parent(code) {} \\', '  public:',
                'class Base { public: Base(int) {} };',
                'class Err : public Base {', '    ERR_DEF(Base, Err)', '    static Err Make(std::string n) { return Err(1); }', '};',
                'class Other {', '    UNKNOWN_MACRO(Other)', '    static int Hidden() { return 1; }',
                '  private:', '    static int Secret() { return 2; }', '};',
                'class Third {', '    DECLARE_IMPL(Third)', '    static int Mine() { return 3; }',
                '    OPEN_UP()', '    static int Opened() { return 4; }', '};', '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const make = index.symbols.get('Make')[0];
            assert.ok(make.modifiers.includes('public'), JSON.stringify(make.modifiers));
            const response = execute(index, 'deadcode', {});
            assert.ok(response.ok, response.error);
            const dead = response.result.map(item => item.name).sort();
            // Hidden: access unknown after an external macro; Opened: the
            // project macro body spells public:; Make: same-file body.
            assert.deepEqual(dead, ['Mine', 'Secret']);
        } finally {
            rm(dir);
        }
    });

    it('C++: a block-scope type alias shadows a member alias of the same name, and template owners reach implicit-this calls', () => {
        const dir = tmp({
            'a.hpp': [
                '#pragma once',
                'template <typename C> struct field { using char_type = C; };',
                'template <typename S> int parse() {',
                '  using char_type = typename S::char_type;',
                '  char_type c = char_type();',
                '  return 0;',
                '}',
                'namespace sp { namespace sinks {',
                'template <typename M> class base_sink {', 'public:', '    void flush();',
                'protected:', '    virtual void flush_() = 0;', '};', '} }', '',
            ].join('\n'),
            'a-inl.hpp': '#pragma once\n#include "a.hpp"\nnamespace sp {\ntemplate <typename M>\nvoid sinks::base_sink<M>::flush() {\n    flush_();\n}\n}\n',
        });
        try {
            const index = idx(dir);
            const alias = index.context('char_type', { file: 'a.hpp', line: 2 });
            assert.deepEqual(at(alias.callers), []);
            const flush = index.context('flush_', { file: 'a.hpp', line: 13 });
            assert.deepEqual([...at(flush.callers), ...at(flush.unverifiedCallers)], ['a-inl.hpp:6']);
        } finally {
            rm(dir);
        }
    });

    it('C++: plan renames the out-of-line definitions of overrides in the slot', () => {
        const dir = tmp({
            'b.hpp': '#pragma once\nclass Base {\npublic:\n    virtual ~Base() = default;\n    void run() { step_(); }\nprotected:\n    virtual void step_();\n};\n',
            'b.cpp': '#include "b.hpp"\nvoid Base::step_() {}\n',
            'd.hpp': '#pragma once\n#include "b.hpp"\n#define API\n#define NS_BEGIN namespace ns {\n#define NS_END }\nNS_BEGIN\nclass API Derived final : public Base {\nprotected:\n    void step_() override;\n};\nNS_END\n#ifdef HEADER_ONLY\n#include "d-inl.hpp"\n#endif\n',
            'd-inl.hpp': '#pragma once\n#ifndef HEADER_ONLY\n#include "d.hpp"\n#endif\n#define INL inline\nNS_BEGIN\nINL void Derived::step_() {}\nNS_END\n',
        });
        try {
            const index = idx(dir);
            assert.deepEqual(planSites(index, { name: 'step_', file: 'b.hpp', line: 7, renameTo: 'st' }),
                ['b.cpp:2', 'b.hpp:5', 'b.hpp:7', 'd-inl.hpp:7', 'd.hpp:9']);
        } finally {
            rm(dir);
        }
    });

    it('C++: implicit this reaches inherited members; ->m() through an object goes through operator->', () => {
        const dir = tmp({
            'f.hpp': [
                '#pragma once', '#include <memory>',
                'class Base { public: bool enabled() const { return true; } };',
                'class Fmt : public Base { public: int make(); };',
                'class Option { public: Option *def_fn(int f) { return this; } };',
                'using Option_p = std::unique_ptr<Option>;', '',
            ].join('\n'),
            'f.cpp': [
                '#include "f.hpp"',
                'int Fmt::make() { return enabled() ? 1 : 0; }',
                'void add(Option_p &option) { option->def_fn(1); }', '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const enabled = index.context('enabled', { file: 'f.hpp', line: 3 });
            assert.deepEqual([...at(enabled.callers), ...at(enabled.unverifiedCallers)], ['f.cpp:2']);
            const defFn = index.context('def_fn', { file: 'f.hpp', line: 5 });
            assert.deepEqual([...at(defFn.callers), ...at(defFn.unverifiedCallers)], ['f.cpp:3']);
            assert.equal(defFn.meta.account.excluded.total, 0);
        } finally {
            rm(dir);
        }
    });

    it('C++: members that escaped an early-closed class body sit in a disclosed recovery region', () => {
        const dir = tmp({
            'o.hpp': [
                '#pragma once', 'class Option {', '  public:', '    int a() const { return 1; }',
                '    X x = {1, 2; int y; }', '    Option *flag(bool v = true) { return this; }',
                '    int tail() { return 2; }', '};', 'inline int use() { return 0; }', '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'show', { name: 'tail' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const recovered = r.result.context.meta.account.recovered;
            assert.ok(recovered && recovered.sites.some(site => site.line === 7), JSON.stringify(recovered));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #385: configuration alternatives, preprocessor-model macro bindings, misread macro invocations', () => {
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();
    const reasonOf = (ctx, reason) => ((ctx.meta.account.excluded.byReason[reason] || {}).sample || [])
        .map(site => `${site.file}:${site.line}`).sort();
    const symbolsOf = (index, name) => (index.symbols.get(name) || [])
        .map(d => `${d.relativePath}:${d.startLine}:${d.className || ''}:${d.type}`).sort();
    const planSites = (index, params) => {
        const response = execute(index, 'plan', params);
        assert.ok(response.ok, response.error);
        return response.result.changes.map(change => `${change.file}:${change.line}`).sort();
    };

    it('C: a binding to one #if variant binds every variant of the item', () => {
        const dir = tmp({
            'thread.h': 'int do_set_name(const char* name);\n',
            'thread.c': [
                '#include "thread.h"',
                'int set_name(const char* name) { return do_set_name(name); }',
                '#if defined(_AIX)',
                'int do_set_name(const char* name) { return -2; }',
                '#elif defined(__APPLE__)',
                'int do_set_name(const char* name) { return 0; }',
                'int apple_name(void) { return do_set_name("a"); }',
                '#else',
                'int do_set_name(const char* name) { return 1; }',
                '#endif',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const line of [4, 6, 9]) {
                const ctx = index.context('do_set_name', { file: 'thread.c', line });
                const shown = [...at(ctx.callers), ...at(ctx.unverifiedCallers)];
                // A call inside one variant's branch is compiled with that
                // variant only.
                assert.deepEqual(shown, line === 6 ? ['thread.c:2', 'thread.c:7'] : ['thread.c:2'],
                    `variant at line ${line}`);
                assert.deepEqual(reasonOf(ctx, 'other-definition'), line === 6 ? [] : ['thread.c:7'],
                    `variant at line ${line}`);
            }
        } finally {
            rm(dir);
        }
    });

    it('C++: #ifdef members of one class body are indexed, bound as one item, renamed together', () => {
        const dir = tmp({
            'client.h': [
                '#pragma once',
                'class client {',
                'public:',
                '#ifdef _WIN32',
                '    bool is_connected() const { return sock_ != 0; }',
                '    void shutdown_socket() { sock_ = 0; }',
                '#else',
                '    bool is_connected() const { return sock_ != -1; }',
                '#endif',
                '    void close() { if (is_connected()) { sock_ = -1; } }',
                '    int sock_ = -1;',
                '};',
                '',
            ].join('\n'),
            'sink.cpp': '#include "client.h"\nbool check(client& c) { return c.is_connected(); }\n',
        });
        try {
            const index = idx(dir);
            assert.deepEqual(symbolsOf(index, 'is_connected'),
                ['client.h:5:client:method', 'client.h:8:client:method']);
            assert.deepEqual(symbolsOf(index, 'shutdown_socket'), ['client.h:6:client:method']);
            const members = index.symbols.get('is_connected');
            assert.ok(members.every(member => Array.isArray(member.ppBranch)));
            for (const line of [5, 8]) {
                const ctx = index.context('is_connected', { file: 'client.h', line });
                assert.deepEqual(at(ctx.callers), ['client.h:10', 'sink.cpp:2'], `member at line ${line}`);
            }
            assert.deepEqual(planSites(index, { name: 'is_connected', file: 'client.h', line: 5, renameTo: 'is_open' }),
                ['client.h:10', 'client.h:5', 'client.h:8', 'sink.cpp:2']);
        } finally {
            rm(dir);
        }
    });

    it('Rust and C#: a caller of a later configuration variant is not excluded', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "cfgs"\nversion = "0.1.0"\n',
            'src/lib.rs': [
                '#[cfg(unix)]',
                'fn set_name(name: &str) -> i32 {',
                '    name.len() as i32',
                '}',
                '',
                '#[cfg(windows)]',
                'fn set_name(name: &str) -> i32 {',
                '    -1',
                '}',
                '',
                'pub fn run() -> i32 {',
                '    set_name("x")',
                '}',
                '',
            ].join('\n'),
            'Thread.cs': [
                'namespace Demo {',
                'public static class Threads {',
                '#if WINDOWS',
                '    static int SetName(string name) { return 1; }',
                '#else',
                '    static int SetName(string name) { return 0; }',
                '#endif',
                '    public static int Run() { return SetName("x"); }',
                '}',
                '}',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const line of [2, 7]) {
                const ctx = index.context('set_name', { file: 'src/lib.rs', line });
                assert.deepEqual(at(ctx.callers), ['src/lib.rs:12'], `rust variant at line ${line}`);
            }
            for (const line of [4, 6]) {
                const ctx = index.context('SetName', { file: 'Thread.cs', line });
                assert.deepEqual(at(ctx.callers), ['Thread.cs:8'], `C# variant at line ${line}`);
                assert.deepEqual(at(ctx.unverifiedCallers), []);
            }
        } finally {
            rm(dir);
        }
    });

    it('C++: an implicit-this call reaches its own class definition, not a same-name class elsewhere', () => {
        const dir = tmp({
            'tcp_client.h': [
                '#pragma once',
                'namespace details {',
                'class tcp_client {',
                '    int socket_ = -1;',
                'public:',
                '    bool is_connected() const { return socket_ != -1; }',
                '    void close() { if (is_connected()) { socket_ = -1; } }',
                '};',
                '}',
                '',
            ].join('\n'),
            'tcp_client-windows.h': [
                '#pragma once',
                'namespace details {',
                'class tcp_client {',
                '    unsigned socket_ = 0;',
                'public:',
                '    bool is_connected() const { return socket_ != 0; }',
                '    void connect() { if (is_connected()) { return; } }',
                '};',
                '}',
                '',
            ].join('\n'),
            'sink.h': [
                '#pragma once',
                '#ifdef _WIN32',
                '#include "tcp_client-windows.h"',
                '#else',
                '#include "tcp_client.h"',
                '#endif',
                'struct sink { details::tcp_client client_; bool ok() { return client_.is_connected(); } };',
                '',
            ].join('\n'),
            'main.cpp': '#include "sink.h"\nint main() { sink s; return s.ok() ? 0 : 1; }\n',
        });
        try {
            const index = idx(dir);
            const unix = index.context('is_connected', { file: 'tcp_client.h', line: 6 });
            assert.deepEqual(at(unix.callers), ['tcp_client.h:7']);
            // The two headers are included in complementary branches: the
            // other class body's own call is the same member in the other
            // configuration, shown but never confirmed for this body.
            assert.deepEqual(at(unix.unverifiedCallers), ['sink.h:7', 'tcp_client-windows.h:7']);
            assert.equal(unix.unverifiedCallers.find(c => c.line === 7 &&
                c.relativePath === 'tcp_client-windows.h').reason, 'configuration-alternative');
            const windows = index.context('is_connected', { file: 'tcp_client-windows.h', line: 6 });
            assert.deepEqual(at(windows.callers), ['tcp_client-windows.h:7']);
            assert.deepEqual(at(windows.unverifiedCallers), ['sink.h:7', 'tcp_client.h:7']);
            // A rename keeps every configuration compiling.
            const plan = execute(index, 'plan', { name: 'is_connected', file: 'tcp_client.h', line: 6, renameTo: 'is_open' });
            assert.ok(plan.ok, plan.error);
            assert.deepEqual(plan.result.changes.map(c => `${c.file}:${c.line}:${c.needsReview ? 'review' : 'edit'}`).sort(),
                ['sink.h:7:edit', 'tcp_client-windows.h:6:edit', 'tcp_client-windows.h:7:edit',
                    'tcp_client.h:6:edit', 'tcp_client.h:7:edit']);
        } finally {
            rm(dir);
        }
    });

    it('C: a same-name wrapper macro (#define f(x) f(x)) calls the function; a spelled-only name stays review', () => {
        const dir = tmp({
            'impl.c': '#include <stdlib.h>\nvoid *track_alloc(size_t n) { return malloc(n); }\nint count(int n) { return n; }\n',
            'api.h': '#include <stddef.h>\nvoid *track_alloc(size_t n);\nint count(int n);\n',
            'user.c': [
                '#include "api.h"',
                '#define track_alloc(n) track_alloc(n)',
                '#define count(n) apply(count, n)',
                'int apply(int (*f)(int), int n);',
                'void *use_alloc(void) { return track_alloc(64); }',
                'int use_count(void) { return count(3); }',
                '',
            ].join('\n'),
            'alt.c': [
                '#ifdef __linux__',
                '#define init_once() 0',
                '#else',
                'static int init_once(void) { return 1; }',
                '#endif',
                'int start(void) { return init_once(); }',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const alloc = index.context('track_alloc', { file: 'impl.c', line: 2 });
            assert.ok(at(alloc.callers).includes('user.c:5'), JSON.stringify(at(alloc.callers)));
            assert.equal(alloc.meta.account.excluded.total, 0);
            const callees = index.findCallees(index.symbols.get('use_alloc')[0], { collectAccount: true });
            assert.deepEqual(callees.map(c => `${c.relativePath}:${c.startLine}:${c.type}`), ['impl.c:2:function']);
            const count = index.context('count', { file: 'impl.c', line: 3 });
            assert.deepEqual(at(count.callers), []);
            assert.deepEqual(at(count.unverifiedCallers), ['user.c:6']);
            assert.equal(count.unverifiedCallers[0].reason, 'macro-namespace');
            // Macro and function as configuration alternatives in one file.
            const once = index.context('init_once', { file: 'alt.c', line: 4 });
            assert.deepEqual(at(once.callers), ['alt.c:6']);
            assert.deepEqual(reasonOf(once, 'other-definition'), []);
            // The rename edits the call once, not also as a review site the
            // macro alternative's sweep found.
            const plan = execute(index, 'plan', { name: 'init_once', file: 'alt.c', line: 4, renameTo: 'start_once' });
            assert.ok(plan.ok, plan.error);
            assert.deepEqual(plan.result.changes.map(c => `${c.file}:${c.line}:${c.needsReview ? 'review' : 'edit'}`).sort(),
                ['alt.c:2:edit', 'alt.c:4:edit', 'alt.c:6:edit']);
        } finally {
            rm(dir);
        }
    });

    it('C++: a member-list invocation of the file\'s own macro keeps the class and declares its members', () => {
        const dir = tmp({
            'error.hpp': [
                '#include <string>',
                'enum class ExitCodes : int { Success = 0, BaseClass = 127 };',
                '#define ERROR_DEF(parent, name) \\',
                '  protected: \\',
                '    name(std::string ename, std::string msg, int exit_code) : parent(ename, msg, exit_code) {} \\',
                '  public: \\',
                '    name(std::string msg, ExitCodes exit_code) : parent(#name, msg, exit_code) {}',
                '#define ERROR_SIMPLE(name) \\',
                '    explicit name(std::string msg) : name(#name, msg, ExitCodes::BaseClass) {}',
                'class Error {',
                'public:',
                '  Error(std::string name, std::string msg, int exit_code) {}',
                '  Error(std::string name, std::string msg, ExitCodes exit_code) {}',
                '};',
                'class ConstructionError : public Error {',
                '    ERROR_DEF(Error, ConstructionError)',
                '};',
                'class BadName : public ConstructionError {',
                '    ERROR_DEF(ConstructionError, BadName)',
                '    ERROR_SIMPLE(BadName)',
                '    static BadName Missing(std::string name) { return BadName("missing " + name); }',
                '};',
                '#undef ERROR_DEF',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(symbolsOf(index, 'ERROR_DEF'), ['error.hpp:3::macro']);
            assert.deepEqual(symbolsOf(index, 'ERROR_SIMPLE'), ['error.hpp:8::macro']);
            assert.deepEqual(symbolsOf(index, 'ConstructionError').filter(s => s.endsWith(':class')),
                ['error.hpp:15::class']);
            const ctors = (index.symbols.get('ConstructionError') || []).filter(d => d.type === 'constructor');
            assert.deepEqual(ctors.map(d => `${d.startLine}:${d.params}:${d.modifiers.includes('public') ? 'public' : 'protected'}`),
                ['16:std::string ename, std::string msg, int exit_code:protected',
                    '16:std::string msg, ExitCodes exit_code:public']);
            assert.ok(ctors.every(d => d.generatedByMacro?.name === 'ERROR_DEF'));
            assert.equal(new Set(ctors.map(d => d.bindingId)).size, 2);
            const badName = (index.symbols.get('BadName') || []).filter(d => d.type === 'constructor');
            assert.equal(badName.length, 3);
            // The access the expansion leaves in effect (public) applies after it.
            const missing = index.symbols.get('Missing')[0];
            assert.equal(missing.className, 'BadName');
            assert.ok(missing.modifiers.includes('public'));
            // Renaming the class renames the argument that declares its
            // constructors through the macro.
            const plan = execute(index, 'plan', { name: 'ConstructionError', file: 'error.hpp', line: 15, renameTo: 'BuildError' });
            assert.ok(plan.ok, plan.error);
            const edits = plan.result.changes.map(c => `${c.line}:${c.editKind}:${c.newExpression?.trim()}`);
            assert.ok(edits.includes('15:definition:class BuildError : public Error {'), JSON.stringify(edits));
            assert.ok(edits.includes('16:reference:ERROR_DEF(Error, BuildError)'), JSON.stringify(edits));
        } finally {
            rm(dir);
        }
    });

    it('C++: plan renames the using-declarations that name the renamed function', () => {
        const dir = tmp({
            'os.h': [
                '#pragma once',
                '#define NS_BEGIN namespace app {',
                '#define NS_END }',
                'NS_BEGIN',
                'namespace details { namespace os {',
                'int remove_if_exists(const char *name);',
                '} }',
                'NS_END',
                '',
            ].join('\n'),
            'os.cpp': '#include "os.h"\nnamespace app { namespace details { namespace os {\nint remove_if_exists(const char *name) { return name ? 0 : 1; }\n} } }\n',
            'sink.h': [
                '#pragma once',
                '#include "os.h"',
                'namespace app { namespace sinks {',
                'inline int clean(const char *name) {',
                '    using details::os::remove_if_exists;',
                '    return remove_if_exists(name);',
                '}',
                '} }',
                'namespace other { namespace os { int remove_if_exists(const char *name); } }',
                'inline int drop(const char *name) { using other::os::remove_if_exists; return remove_if_exists(name); }',
                '',
            ].join('\n'),
            'main.cpp': '#include "sink.h"\nint main() { return app::sinks::clean("x"); }\n',
        });
        try {
            const index = idx(dir);
            const plan = execute(index, 'plan', { name: 'remove_if_exists', file: 'os.cpp', line: 3, renameTo: 'remove_file' });
            assert.ok(plan.ok, plan.error);
            const edits = plan.result.changes.map(c => `${c.file}:${c.line}:${c.editKind}`);
            assert.ok(edits.includes('sink.h:5:reference'), JSON.stringify(edits));
            assert.ok(!edits.some(edit => edit.startsWith('sink.h:10')), JSON.stringify(edits));
        } finally {
            rm(dir);
        }
    });

    it('C/C++: macro invocations read as declarations are calls or nothing, never functions', () => {
        const dir = tmp({
            'task.h': '#define CHECK_LOOP(loop) do { close_loop(loop); } while (0)\nvoid close_loop(void *loop);\nvoid *default_loop(void);\n',
            'test_addr.c': [
                '#include "task.h"',
                'int parse_addr(const char *s);',
                '#define GOOD_LIST(X) X("::") X("::1")',
                '#define TEST_GOOD(ADDR) parse_addr(ADDR);',
                'int run_addr(void) {',
                '  int addr;',
                '  GOOD_LIST(TEST_GOOD)',
                '  CHECK_LOOP(default_loop());',
                '  return 0;',
                '}',
                '',
            ].join('\n'),
            'suite.cpp': [
                'int helper(int x);',
                'TEST(suite_one, adds) {',
                '  helper(1);',
                '}',
                'REGISTER_HANDLER(on_start);',
                'int helper(int x) { return x; }',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(symbolsOf(index, 'default_loop'), ['task.h:3::function']);
            const loop = index.context('default_loop', { file: 'task.h', line: 3 });
            assert.deepEqual([...at(loop.callers), ...at(loop.unverifiedCallers)], ['test_addr.c:8']);
            // C++ has no implicit int: TEST(...) { } and REGISTER_HANDLER(x);
            // are invocations, not functions named after the macro.
            assert.deepEqual(symbolsOf(index, 'TEST'), []);
            assert.deepEqual(symbolsOf(index, 'REGISTER_HANDLER'), []);
            const helper = index.context('helper', { file: 'suite.cpp', line: 6 });
            assert.deepEqual(at(helper.callers), ['suite.cpp:3']);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #386: renaming a type edits every reference to it', () => {
    const { applyRenamePlan } = require('./helpers');
    const files = {
        'include/widget.h': [
            '#pragma once',
            'namespace app {',
            'class Base {};',
            'class Widget : public Base {',
            'public:',
            '    static const int SIZE = 3;',
            '    Widget();',
            '    explicit Widget(int n);',
            '    ~Widget();',
            '    Widget* next;',
            '    static Widget make();',
            '    Widget copy(const Widget& other) const;',
            '};',
            'typedef Widget WidgetT;',
            'using WidgetAlias = Widget;',
            '}',
        ].join('\n'),
        'include/fwd.h': '#pragma once\nnamespace app { class Widget; }\n',
        'widget.cpp': [
            '#include "include/widget.h"',
            'namespace app {',
            'Widget::Widget() : Base(), next(nullptr) {}',
            'Widget::Widget(int n) : Widget() { (void)n; }',
            'Widget::~Widget() {}',
            'Widget Widget::make() { return Widget(); }',
            'Widget Widget::copy(const Widget& other) const {',
            '    Widget w = static_cast<Widget>(other);',
            '    (void)sizeof(Widget);',
            '    int s = Widget::SIZE;',
            '    (void)s;',
            '    return w;',
            '}',
            '}',
        ].join('\n'),
        'user.cpp': [
            '#include "include/widget.h"',
            '#include "include/fwd.h"',
            'namespace other { class Widget {}; }',
            'class Sub : public app::Widget {',
            'public:',
            '    Sub() : app::Widget(1) {}',
            '    Sub(int) : Widget() {}',
            '};',
            'template <typename T = app::Widget> T mk() { return T(); }',
            'app::Widget build() { return app::Widget::make(); }',
            'other::Widget ow;',
        ].join('\n'),
    };

    it('C++: constructors, destructors, out-of-line members, member initializers, casts, aliases, forward declarations and injected base names', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Widget', file: 'include/widget.h', line: 4, renameTo: 'Gadget' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            const renamed = text => text.replace(/\bWidget\b/g, 'Gadget');
            assert.strictEqual(contents['include/widget.h'], renamed(files['include/widget.h']));
            assert.strictEqual(contents['include/fwd.h'], renamed(files['include/fwd.h']));
            assert.strictEqual(contents['widget.cpp'], renamed(files['widget.cpp']));
            assert.strictEqual(contents['user.cpp'], renamed(files['user.cpp'])
                .replace('class Gadget {}', 'class Widget {}').replace('other::Gadget ow', 'other::Widget ow'),
                'other::Widget is another class');
        } finally { rm(dir); }
    });

    it('C++: a macro argument the replacement list also uses as another scope\'s member is reviewed', () => {
        const dir = tmp({
            'err.hpp': [
                'enum class Codes : int { Ok = 0, BadName };',
                '#define ERROR_SIMPLE(name) explicit name(int m) : name(m, Codes::name) {}',
                'class BadName {',
                '  public:',
                '    BadName(int m, Codes c) {}',
                '    ERROR_SIMPLE(BadName)',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'BadName', file: 'err.hpp', line: 3, renameTo: 'Renamed' });
            assert.ok(r.ok, r.error);
            const change = (r.result.changes || []).find(c => c.line === 6);
            assert.ok(change && change.needsReview && change.newExpression === undefined, JSON.stringify(r.result.changes));
            assert.ok(!(r.result.changes || []).some(c => c.line === 1 && c.newExpression),
                'the enumerator is another entity');
        } finally { rm(dir); }
    });

    it('C: a struct tag rename edits tag references; a typedef of the same spelling is another name', () => {
        const dir = tmp({
            'w.h': 'struct Widget { int n; struct Widget *next; };\ntypedef struct Widget Widget;\nstruct Widget *widget_new(void);\n',
            'w.c': '#include "w.h"\nWidget *make(void) { struct Widget *w = 0; return w; }\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Widget', file: 'w.h', line: 1, renameTo: 'Gadget' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            assert.strictEqual(contents['w.h'],
                'struct Gadget { int n; struct Gadget *next; };\ntypedef struct Gadget Widget;\nstruct Gadget *widget_new(void);\n');
            assert.strictEqual(contents['w.c'], '#include "w.h"\nWidget *make(void) { struct Gadget *w = 0; return w; }\n');
        } finally { rm(dir); }
    });
});

describe('fix #386: C++ type spellings keep names that start like a keyword', () => {
    it('stripTemplateArguments removes a leading keyword token, never the start of a name', () => {
        const { stripTemplateArguments } = require('../core/cpp-scope');
        assert.strictEqual(stripTemplateArguments('classify_object<T>'), 'classify_object');
        assert.strictEqual(stripTemplateArguments('structure::inner'), 'structure::inner');
        assert.strictEqual(stripTemplateArguments('constant_t'), 'constant_t');
        assert.strictEqual(stripTemplateArguments('typename T::value_type'), 'T::value_type');
        assert.strictEqual(stripTemplateArguments('struct S'), 'S');
    });
});

describe('fix #387: macro recovery blanks decoration only, never the tokens around it', () => {
    const fns = result => result.functions.map(fn => `${fn.startLine}:${fn.className || ''}:${fn.name}:${fn.returnType}`);

    it('C++: the type after a stacked specifier macro stays the return type (qualifier and constructor intact)', () => {
        const result = parse([
            'namespace CLI {',
            'CLI11_INLINE App::App(std::string description, App *parent)',
            '    : name_(std::move(description)), parent_(parent) {',
            '    set_help_flag("-h");',
            '}',
            'CLI11_INLINE App *App::callback(std::function<void()> fn) {',
            '    callback_ = std::move(fn);',
            '    return this;',
            '}',
            'CLI11_NODISCARD CLI11_INLINE CLI::App *App::get_option_group(std::string name) const {',
            '    return nullptr;',
            '}',
            'CLI11_INLINE Option *App::add_flag(std::string name) {',
            '    return add_option(name);',
            '}',
            'CLI11_INLINE bool App::remove_option(Option *opt) {',
            '    return opt != nullptr;',
            '}',
            '}',
        ].join('\n'), 'cpp');
        assert.deepEqual(fns(result), [
            '2:App:App:null', '6:App:callback:App *', '10:App:get_option_group:CLI::App *',
            '13:App:add_flag:Option *', '16:App:remove_option:bool',
        ]);
        assert.ok(!result.parseRecovery);
    });

    it('C++: reserved words are never blanked; a macro before `explicit` or `auto` is the decoration', () => {
        const result = parse([
            'FMT_CONSTEXPR inline auto parse_align(char c) -> int {',
            '  return c;',
            '}',
            'class dynamic_arg_list {',
            '  friend class basic_format_args;',
            ' public:',
            '  FMT_CONSTEXPR explicit dynamic_arg_list(int n) : n_(n) {}',
            '  FMT_CONSTEXPR20 ~dynamic_arg_list() = default;',
            '  FMT_NO_UNIQUE_ADDRESS locale_ref loc_;',
            '  int n_;',
            '};',
        ].join('\n'), 'cpp');
        assert.deepEqual(fns(result), ['1::parse_align:int']);
        const cls = result.classes.find(item => item.name === 'dynamic_arg_list');
        assert.deepEqual(cls.members.map(member => `${member.startLine}:${member.name}`),
            ['7:dynamic_arg_list', '8:~dynamic_arg_list', '9:loc_', '10:n_']);
    });

    it('C: a calling-convention macro after a typedef return type keeps the typedef', () => {
        const result = parse([
            'typedef int BOOL;',
            'typedef unsigned long DWORD;',
            'static DWORD counter;',
            'BOOL WINAPI CtrlHandler(DWORD type) {',
            '  return type != 0;',
            '}',
            'static DWORD WINAPI thread_proc(void* arg) {',
            '  return 0;',
            '}',
        ].join('\n'), 'c');
        assert.deepEqual(fns(result), ['4::CtrlHandler:BOOL', '7::thread_proc:DWORD']);
    });

    it('C++: a trailing specifier macro after a declarator is not a declaration of its own', () => {
        const result = parse([
            'namespace os {',
            'SPDLOG_API int pid() SPDLOG_NOEXCEPT;',
            'SPDLOG_API bool is_color_terminal() SPDLOG_NOEXCEPT;',
            'SPDLOG_INLINE int remove(const filename_t &filename) SPDLOG_NOEXCEPT {',
            '  return 0;',
            '}',
            'static const char *names[] LEVEL_NAMES;',
            '}',
        ].join('\n'), 'cpp');
        assert.deepEqual(fns(result), ['2::pid:int', '3::is_color_terminal:bool', '4::remove:int']);
        assert.deepEqual((result.stateObjects || []).map(state => state.name), ['names']);
    });

    it('C: member-list macros alone on their line leave the members and later enums intact', () => {
        const result = parse([
            '#define UV_HANDLE_FIELDS void* data; int flags;',
            'struct uv_timer_s {',
            '  UV_HANDLE_FIELDS',
            '  int timeout;',
            '  UV_TIMER_PRIVATE_FIELDS',
            '};',
            'typedef enum {',
            '  UV_TTY_MODE_NORMAL,',
            '  UV_TTY_MODE_RAW',
            '} uv_tty_mode_t;',
        ].join('\n'), 'c');
        const timer = result.classes.find(item => item.name === 'uv_timer_s');
        assert.deepEqual(timer.members.map(member => member.name), ['timeout']);
        const mode = result.classes.find(item => item.name === 'uv_tty_mode_t');
        assert.deepEqual(mode?.members.map(member => member.name), ['UV_TTY_MODE_NORMAL', 'UV_TTY_MODE_RAW']);
    });

    it('C++: a blanked multi-line invocation keeps every later line number', () => {
        const result = parse([
            'void test_one() {',
            '  CHECK_THROWS_WITH_AS(it1 < it1,',
            '                       "message one",',
            '                       invalid_iterator&)',
            '  int x = 1',
            '}',
            'int after_invocation(int v) {',
            '  return v;',
            '}',
        ].join('\n'), 'cpp');
        assert.ok(result.functions.some(fn => fn.name === 'after_invocation' && fn.startLine === 7),
            JSON.stringify(fns(result)));
    });

    it('C++: the out-of-line definition keeps its return type, so a chained call flows through it', () => {
        const dir = tmp({
            'include/Macros.hpp': '#pragma once\n#ifdef LIB_HEADER_ONLY\n#define LIB_INLINE inline\n#else\n#define LIB_INLINE\n#endif\n',
            'include/App.hpp': [
                '#pragma once', '#include "Macros.hpp"', '#include <functional>', '#include <string>',
                'namespace lib {', 'class App {', '  public:', '    App *callback(std::function<void()> fn);',
                '    App *name(std::string value);', '    std::string name_;', '};', '}',
            ].join('\n'),
            'include/App_inl.hpp': [
                '#pragma once', '#include "App.hpp"', 'namespace lib {',
                'LIB_INLINE App *App::callback(std::function<void()> fn) {', '    return this;', '}',
                'LIB_INLINE App *App::name(std::string value) {', '    name_ = value;', '    return this;', '}', '}',
            ].join('\n'),
            'main.cpp': [
                '#include "include/App_inl.hpp"', 'int main() {', '    lib::App app;',
                '    app.callback([] {})->name("renamed");', '    return 0;', '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const inline = (index.symbols.get('callback') || []).find(def => def.relativePath === 'include/App_inl.hpp');
            assert.strictEqual(inline?.returnType, 'App *');
            const result = index.context('name', { file: 'include/App.hpp', line: 9 });
            assert.deepEqual(result.callers.map(call => `${call.relativePath}:${call.line}`), ['main.cpp:4']);
        } finally {
            rm(dir);
        }
    });

    it('C/C++: a name joined by ## in a macro body the grammar misread is not a function', () => {
        const result = parse([
            '#define RB_GENERATE_INSERT(name, type) \\',
            '  /* insert */ \\',
            'type *name##_RB_INSERT(type *elm) { \\',
            '  name##_RB_INSERT_COLOR(elm); \\',
            '  return (0); \\',
            '}',
            'int real(void) { return 1; }',
        ].join('\n'), 'c');
        assert.ok(!result.functions.some(fn => /_RB_INSERT/.test(fn.name)), JSON.stringify(fns(result)));
        assert.ok(result.functions.some(fn => fn.name === 'real'));
    });
});

describe('fix #387: a dependent using-declaration leaves the overload to instantiation', () => {
    it('C++: an unqualified call through `using Base<T>::name` is compile-time dispatch; a concrete base confirms', () => {
        const dir = tmp({
            'buf.hpp': [
                'namespace detail {',
                'template <typename T> class buffer {',
                ' public:',
                '  template <typename U> void append(const U* begin, const U* end) { (void)begin; (void)end; }',
                '};',
                'class plain {',
                ' public:',
                '  void put(const char* begin, const char* end) { (void)begin; (void)end; }',
                '};',
                '}',
                'template <typename T> class memory_buffer : public detail::buffer<T> {',
                ' public:',
                '  using detail::buffer<T>::append;',
                '  template <typename Range> void append(const Range& range) {',
                '    append(range.data(), range.data() + range.size());',
                '  }',
                '};',
                'class writer : public detail::plain {',
                ' public:',
                '  using detail::plain::put;',
                '  void put(const char* text) {',
                '    put(text, text + 1);',
                '  }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const append = index.context('append', { file: 'buf.hpp', line: 4 });
            assert.deepEqual((append.callers || []).map(call => call.line), []);
            const site = (append.unverifiedCallers || []).find(call => call.line === 15);
            assert.ok(site, JSON.stringify(append.unverifiedCallers));
            assert.strictEqual(site.uncertaintyClass, 'compile-time-dispatch');
            const put = index.context('put', { file: 'buf.hpp', line: 8 });
            assert.deepEqual((put.callers || []).map(call => call.line), [22]);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #387: C++ type renames through template-qualified constructors and member types', () => {
    const { applyRenamePlan } = require('./helpers');

    it('C++: `Sink<M>::Sink()` and `Sink<M>::~Sink()` rename the constructor names too', () => {
        const dir = tmp({
            'sink.hpp': [
                'template <typename M> class Sink {',
                ' public:',
                '  Sink();',
                '  ~Sink();',
                '};',
                'template <typename M> Sink<M>::Sink() {}',
                'template <typename M> Sink<M>::~Sink() {}',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Sink', file: 'sink.hpp', line: 1, renameTo: 'Drain' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.strictEqual(contents['sink.hpp'], [
                'template <typename M> class Drain {',
                ' public:',
                '  Drain();',
                '  ~Drain();',
                '};',
                'template <typename M> Drain<M>::Drain() {}',
                'template <typename M> Drain<M>::~Drain() {}',
                '',
            ].join('\n'));
        } finally {
            rm(dir);
        }
    });

    it('C++: a member type alias is found in the class body that holds the site, not in a sibling specialization', () => {
        const dir = tmp({
            'fmt.hpp': [
                'template <typename R, typename E = void> struct formatter;',
                'template <typename R> struct formatter<R, int> {',
                '  using range_type = const R;',
                '  range_type *first = nullptr;',
                '  void format(range_type &range) const { (void)range; }',
                '};',
                'template <typename R> struct formatter<R, long> {',
                '  using range_type = R;',
                '  void format(range_type &range) const { (void)range; }',
                '};',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'range_type', file: 'fmt.hpp', line: 3, renameTo: 'span_type' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            const lines = contents['fmt.hpp'].split('\n');
            assert.deepStrictEqual(lines.slice(2, 5), [
                '  using span_type = const R;',
                '  span_type *first = nullptr;',
                '  void format(span_type &range) const { (void)range; }',
            ]);
            assert.deepStrictEqual(lines.slice(7, 9), [
                '  using range_type = R;',
                '  void format(range_type &range) const { (void)range; }',
            ]);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #389: C++ function-local classes', () => {
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();

    it('a class declared in a function body is not its namespace-scope namesake (callers, callees, plans)', () => {
        const dir = tmp({
            'mod.cpp': [
                'struct Widget {',
                '    int render() { return 1; }',
                '};',
                '',
                'int build() {',
                '    struct Widget {',
                '        int render() { return 2; }',
                '    };',
                '    Widget w;',
                '    return w.render();',
                '}',
                '',
                'int use_top() {',
                '    Widget w;',
                '    return w.render();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const local = index.symbols.get('Widget').find(d => d.startLine === 6);
            assert.strictEqual(local.lexicalScopeStartLine, 6);
            assert.strictEqual(local.lexicalScopeEndLine, 11);
            assert.deepStrictEqual(at(index.context('render', { file: 'mod.cpp', line: 2 }).callers), ['mod.cpp:15']);
            assert.deepStrictEqual(at(index.context('render', { file: 'mod.cpp', line: 7 }).callers), ['mod.cpp:10']);
            // `Widget w;` default-constructs the local class (fix #421).
            assert.deepStrictEqual(index.context('build', { file: 'mod.cpp' }).callees
                .map(c => `${c.name}:${c.startLine}`).sort(), ['Widget:6', 'render:7']);
            const fn = execute(index, 'plan', { name: 'render', file: 'mod.cpp', line: 7, renameTo: 'draw' });
            assert.deepStrictEqual(fn.result.changes.map(c => c.line).sort((a, b) => a - b), [7, 10]);
            const type = execute(index, 'plan', { name: 'Widget', file: 'mod.cpp', line: 1, renameTo: 'Gadget' });
            assert.deepStrictEqual(type.result.changes.map(c => `${c.line}:${!!c.needsReview}`)
                .sort(), ['14:false', '1:false']);
        } finally { rm(dir); }
    });
});

describe('fix #390: C++ class template bases substitute their parameters in override slots', () => {
    const { applyRenamePlan } = require('./helpers');
    it('an override below `: public Base<std::string>` joins the slot; a non-overriding overload does not', () => {
        const dir = tmp({
            'base.hpp': [
                '#pragma once',
                '#include <string>',
                'template <typename S, int N>',
                'class Base {',
                'public:',
                '    virtual ~Base() {}',
                '    virtual void visit(S s, int x) = 0;',
                '    void run(S s) { visit(s, N); }',
                '};',
                'class Impl : public Base<std::string, 3> {',
                'public:',
                '    void visit(std::string s, int x) override {}',
                '    void visit(long s, int x) {}',
                '};',
            ].join('\n'),
            'main.cpp': '#include "base.hpp"\nint main() { Impl i; i.run(std::string("a")); return 0; }\n',
        });
        try {
            const index = idx(dir);
            assert.equal(index.symbols.get('Base').find(d => d.type === 'class').generics, '<S, N>');
            const lines = line => {
                const r = execute(index, 'plan', { name: 'visit', file: 'base.hpp', line, renameTo: 'visitZq' });
                assert.ok(r.ok, r.error);
                const { contents } = applyRenamePlan(dir, r.result);
                return (contents['base.hpp'] || '').split('\n').map((row, i) => (row.includes('visitZq') ? i + 1 : null))
                    .filter(Boolean);
            };
            assert.deepEqual(lines(7), [7, 8, 12]);
            assert.deepEqual(lines(12), [7, 8, 12]);
            // The overload that overrides nothing renames alone.
            assert.deepEqual(lines(13), [13]);
        } finally { rm(dir); }
    });
});

describe('fix #391: C++ friend functions are namespace-scope functions', () => {
    const { applyRenamePlan } = require('./helpers');
    const output = require('../core/output');
    const callersOf = (index, handle) => {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, r.error);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
        };
    };
    const FILES = {
        'vec.hpp': [
            'namespace ns {',
            'class Vec {',
            '  public:',
            '    int x;',
            '    friend Vec operator+(const Vec& a, const Vec& b) { return add(a, b); }',
            '    friend bool equal(const Vec& a, const Vec& b) { return a.x == b.x; }',
            '    friend inline long hash_value(const Vec& v) noexcept { return v.x; }',
            '    friend void swap(Vec& a, Vec& b);',
            '    friend class Other;',
            '    friend void Other::touch();',
            '    template <typename U> friend bool same(const Vec& a, const U& b) { return true; }',
            '    static Vec add(const Vec& a, const Vec& b) { Vec r; r.x = a.x + b.x; return r; }',
            '    bool member(const Vec& o) const { return equal(*this, o); }',
            '};',
            'void swap(Vec& a, Vec& b) { int t = a.x; a.x = b.x; b.x = t; }',
            '}',
        ].join('\n'),
        'main.cpp': [
            '#include "vec.hpp"',
            'int use() { ns::Vec a, b; bool e = equal(a, b); swap(a, b); return e ? 1 : 0; }',
        ].join('\n'),
    };

    it('a friend is indexed in its namespace with its return type, never as a member', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const fn = name => (index.symbols.get(name) || []).map(d =>
                `${d.type}:${d.className || ''}:${d.namespace || ''}:${d.returnType || ''}:${d.friendOf || ''}:${d.startLine}`);
            assert.deepEqual(fn('equal'), ['function::ns:bool:Vec:6']);
            assert.deepEqual(fn('hash_value'), ['function::ns:long:Vec:7']);
            assert.deepEqual(fn('operator+'), ['function::ns:Vec:Vec:5']);
            assert.deepEqual(fn('same'), ['function::ns:bool:Vec:11']);
            assert.deepEqual(fn('swap').sort(), ['function::ns:void::15', 'function::ns:void:Vec:8']);
            // `friend class` and a friend naming another class's member declare nothing.
            assert.equal(index.symbols.get('touch'), undefined);
            const members = index.symbols.get('Vec').find(d => d.type === 'class');
            assert.ok(members);
            assert.ok(!(index.symbols.get('equal') || []).some(d => d.className === 'Vec'));
        } finally { rm(dir); }
    });

    it('argument-dependent and in-class calls reach the friend; its body sees the class scope', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const equal = callersOf(index, 'vec.hpp:6:equal');
            assert.ok(equal.confirmed.includes('main.cpp:2'), JSON.stringify(equal));
            assert.ok(equal.confirmed.includes('vec.hpp:13'), JSON.stringify(equal));
            // `add(a, b)` in the friend body is the class's static member.
            const add = callersOf(index, 'vec.hpp:12:add');
            assert.ok(add.confirmed.includes('vec.hpp:5'), JSON.stringify(add));
        } finally { rm(dir); }
    });

    it('renaming the function renames the friend declaration with the definition and calls', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'swap', file: 'vec.hpp', line: 15, renameTo: 'swap2' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.match(contents['vec.hpp'], /friend void swap2\(Vec& a, Vec& b\);/);
            assert.match(contents['vec.hpp'], /void swap2\(Vec& a, Vec& b\) \{/);
            assert.match(contents['main.cpp'], /swap2\(a, b\)/);
        } finally { rm(dir); }
    });

    it('a friend declaration and its definition are one producer for a call receiver', () => {
        const dir = tmp({
            'style.hpp': [
                'class style {',
                '  public:',
                '    bool has_bold() const { return bits != 0; }',
                '    friend auto make_style(int b) -> style;',
                '  private:',
                '    int bits = 0;',
                '};',
                'inline auto make_style(int b) -> style { style s; return s; }',
                'class other {',
                '  public:',
                '    static bool has_bold(int mask, int bit) { return (mask & bit) != 0; }',
                '};',
            ].join('\n'),
            'use.cpp': [
                '#include "style.hpp"',
                'bool check() { return make_style(1).has_bold(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const hasBold = callersOf(index, 'style.hpp:3:has_bold');
            assert.ok(hasBold.confirmed.includes('use.cpp:2'), JSON.stringify(hasBold));
        } finally { rm(dir); }
    });

    it('member templates keep their return type', () => {
        const result = parse([
            'class W {',
            '  public:',
            '    template <typename T> static T make(int x) { return T(x); }',
            '    template <typename T> T get() const;',
            '};',
        ].join('\n'), 'cpp');
        const members = result.classes.find(cls => cls.name === 'W').members;
        assert.deepEqual(members.map(m => `${m.name}:${m.returnType}`), ['make:T', 'get:T']);
    });
});

describe('fix #391: a macro invocation with a body at namespace scope defines a callable', () => {
    const output = require('../core/output');
    const callersOf = (index, handle) => {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, r.error);
        const json = JSON.parse(output.formatContextJson(r.result));
        return (json.data.callers || []).map(c => `${c.file}:${c.line}:${c.callerName || ''}`);
    };
    const FILES = {
        'lib.h': 'int add(int a, int b);\nvoid run_fixture();\n',
        'lib.cc': '#include "lib.h"\nint add(int a, int b) { return a + b; }\nvoid run_fixture() {}\n',
        'tests/lib_test.cc': [
            '#include "gtest/gtest.h"',
            '#include "lib.h"',
            'TEST(MathSuite, Adds) {',
            '  EXPECT_EQ(add(1, 2), 3);',
            '}',
            '// a fixture test',
            'TEST_F(Fixture, Works) {',
            '  run_fixture();',
            '}',
            'TEST_CASE("vector can be sized", "[vector]") {',
            '  add(2, 3);',
            '}',
            'namespace ns {',
            'TEST(Inner, Case) { add(4, 5); }',
            '}',
        ].join('\n'),
        'tests/annotated.cc': [
            '#include "lib.h"',
            'struct Mutex {};',
            'Mutex mu;',
            'int locked_add()',
            '    LOCKS_EXCLUDED(mu) {',
            '  return add(6, 7);',
            '}',
            '#define DECLARE_TABLE(name) struct name##_table { int size; };',
            'DECLARE_TABLE(fruit) { }',
        ].join('\n'),
    };

    it('bodies of TEST(...)/TEST_CASE("...") are callables owning their calls', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const generated = [];
            for (const [, defs] of index.symbols) {
                for (const d of defs) {
                    if (d.generatedByMacro && !d.className) {
                        generated.push(`${d.relativePath}:${d.startLine}-${d.endLine}:${d.name}:${d.generatedByMacro.name}`);
                    }
                }
            }
            assert.deepEqual(generated.sort(), [
                'tests/lib_test.cc:10-12:vector_can_be_sized_vector:TEST_CASE',
                'tests/lib_test.cc:14-14:Inner_Case:TEST',
                'tests/lib_test.cc:3-5:MathSuite_Adds:TEST',
                'tests/lib_test.cc:7-9:Fixture_Works:TEST_F',
            ]);
            const add = callersOf(index, 'lib.cc:2:add');
            for (const site of ['tests/lib_test.cc:4:MathSuite_Adds', 'tests/lib_test.cc:11:vector_can_be_sized_vector',
                'tests/lib_test.cc:14:Inner_Case']) {
                assert.ok(add.includes(site), `${site} in ${JSON.stringify(add)}`);
            }
        } finally { rm(dir); }
    });

    it('an annotation after an open function head and a non-function macro expansion define nothing', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const generated = [];
            for (const [, defs] of index.symbols) {
                for (const d of defs) {
                    if (d.generatedByMacro && d.relativePath === 'tests/annotated.cc') generated.push(d.name);
                }
            }
            assert.deepEqual(generated, []);
        } finally { rm(dir); }
    });

    it('the generated callable is an entry point and its rename is blocked', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const dead = execute(index, 'deadcode', { includeExported: true, includeTests: true });
            assert.ok(dead.ok, dead.error);
            assert.ok(!JSON.stringify(dead.result).includes('MathSuite_Adds'));
            const plan = execute(index, 'plan', { name: 'MathSuite_Adds', renameTo: 'Other' });
            assert.ok(plan.ok, plan.error);
            assert.equal(plan.result.contract?.blocked, true);
            assert.equal(plan.result.contract.external[0].reason, 'macro-generated-name');
            assert.ok(plan.result.changes.every(change => change.newExpression === undefined));
        } finally { rm(dir); }
    });
});

describe('fix #391: large C/C++ files resolve the conditionals the grammar could not place', () => {
    it('a member-initializer list split by #if keeps its constructor and class', () => {
        const filler = [];
        for (let i = 0; i < 5200; i++) filler.push(`inline int filler_${i}(int v) { return v + ${i}; }`);
        const source = [
            '#pragma once',
            ...filler,
            'namespace lib {',
            'class Json {',
            '  public:',
            '    int start_position = 0;',
            '    Json(const Json& other)',
            '#if DIAGNOSTIC_POSITIONS',
            '        : start_position(other.start_pos()),',
            '          end_position(other.start_pos())',
            '#endif',
            '    {',
            '        switch (other.kind()) {',
            '            case 1: copy_structured(other); break;',
            '        }',
            '        assert_invariant();',
            '    }',
            '    int kind() const { return 1; }',
            '    int end_position = 0;',
            '    int start_pos() const { return start_position; }',
            '    void copy_structured(const Json& o) {}',
            '    void assert_invariant() const {}',
            '  private:',
            '    int base_;',
            '#ifdef NO_THREAD_LOCAL',
            '    int depth() const { return 0; }',
            '#else',
            '    int depth() const { return nesting(); }',
            '#endif',
            '    static int nesting() { return 1; }',
            '};',
            '}',
        ].join('\n');
        assert.ok(Buffer.byteLength(source) > 256 * 1024);
        const offset = filler.length + 1;
        const result = parse(source, 'cpp');
        const json = result.classes.find(cls => cls.name === 'Json');
        assert.ok(json, 'the class survives the split initializer list');
        const ctor = json.members.find(m => m.name === 'Json');
        assert.equal(ctor?.startLine, offset + 5);
        assert.ok(!result.functions.some(fn => ['start_pos', 'kind'].includes(fn.name) && !fn.className),
            'no phantom free functions from the split list');
        const calls = getLanguageAdapter('cpp').findCallsInCode(source, getParser('cpp'))
            .filter(call => call.line > offset && call.line < offset + 20 &&
                ['copy_structured', 'assert_invariant', 'start_pos', 'kind'].includes(call.name));
        assert.deepEqual(calls.map(call => `${call.name}@${call.line}:${call.enclosingFunction?.name}`).sort(), [
            `assert_invariant@${offset + 14}:Json`,
            `copy_structured@${offset + 12}:Json`,
            `kind@${offset + 11}:Json`,
            `start_pos@${offset + 7}:Json`,
            `start_pos@${offset + 8}:Json`,
        ]);
    });
});

describe('fix #391: C++ nested classes see their enclosing class; member templates are templates', () => {
    it('a member type alias used by bare name belongs to the class scope chain of the use', () => {
        const dir = tmp({
            'a.hpp': [
                '#include <string>',
                'template <typename B> struct Sax {',
                '    using text_t = typename B::text_t;',
                '};',
                'template <typename B> class Reader {',
                '    using text_t = typename B::text_t;',
                '    text_t read(const char* s) { return text_t(s); }',
                '};',
                'template <typename B> class Writer {',
                '    using text_t = typename B::text_t;',
                '    void write(const char* s) { auto t = text_t(s); (void)t; }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const shown = line => {
                const ctx = index.context('text_t', { file: 'a.hpp', line });
                return [...(ctx.callers || []), ...(ctx.unverifiedCallers || [])].map(c => c.line);
            };
            assert.deepStrictEqual(shown(3), []);
            assert.deepStrictEqual(shown(6), [7]);
            assert.deepStrictEqual(shown(10), [11]);
        } finally { rm(dir); }
    });

    it('a nested class member calls the enclosing class static template by bare name', () => {
        const dir = tmp({
            'j.hpp': [
                'namespace lib {',
                'class Json {',
                '  public:',
                '    template <typename T, typename... Args>',
                '    static T* create(Args&&... args) { return new T(args...); }',
                '    union Value {',
                '        int* number;',
                '        Value(int v) : number(create<int>(v)) {}',
                '    };',
                '    void reset() { Value v(create<int>(1) ? 1 : 0); }',
                '};',
                'class Other {',
                '    void f() { create<int>(2); }',
                '};',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const create = index.symbols.get('create').find(d => d.className === 'Json');
            assert.equal(create.templateDependent, true);
            assert.equal(create.returnType, 'T *');
            const ctx = index.context('create', { file: 'j.hpp', line: create.startLine });
            const shown = [...(ctx.callers || []), ...(ctx.unverifiedCallers || [])].map(c => c.line).sort((a, b) => a - b);
            assert.deepStrictEqual(shown, [8, 10]);
        } finally { rm(dir); }
    });
});

describe('fix #393: C/C++ rename and caller identity leftovers', () => {
    const { applyRenamePlan } = require('./helpers');
    const output = require('../core/output');
    const shownOf = (index, name, file, line) => {
        const r = execute(index, 'context', { name, file, line });
        assert.ok(r.ok, r.error);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`).sort(),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}:${c.reason}`).sort(),
            excluded: Object.keys(json.data.account?.excluded?.byReason || r.result.meta?.account?.excluded?.byReason || {}),
        };
    };

    it('an unnamed prototype parameter keeps its type, joining the out-of-line definition and its calls', () => {
        const dir = tmp({
            'fmt.hpp': [
                'class Option;',
                'class Formatter {',
                '  public:',
                '    virtual int describe(const Option *) const;',
                '    int text(const Option *opt) const { return describe(opt); }',
                '};',
            ].join('\n'),
            'fmt_inl.hpp': [
                '#include "fmt.hpp"',
                'inline int Formatter::describe(const Option *opt) const { return 1; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const decl = index.symbols.get('describe').find(d => d.isSignature);
            assert.deepEqual(decl.paramsStructured, [{ name: 'const Option *', unnamed: true }]);
            const r = execute(index, 'plan', { name: 'describe', file: 'fmt.hpp', line: 4, renameTo: 'describe2' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.match(contents['fmt.hpp'], /virtual int describe2\(const Option \*\) const;/);
            assert.match(contents['fmt.hpp'], /return describe2\(opt\);/);
            assert.match(contents['fmt_inl.hpp'], /Formatter::describe2\(const Option \*opt\)/);
        } finally { rm(dir); }
    });

    it('v->m() reaches the pointee: smart pointers behind aliases, auto locals, operator->', () => {
        const dir = tmp({
            'app.hpp': [
                '#include <memory>',
                'namespace N {',
                'class App;',
                'using App_p = std::shared_ptr<App>;',
                'class App {',
                '  public:',
                '    App_p ptr();',
                '    App *raw();',
                '    void remove();',
                '};',
                'struct Handle { App *operator->() const; };',
                'class Other { public: void remove(); };',
                'std::shared_ptr<App> make_app();',
                'std::unique_ptr<Other> make_other();',
                'inline void use(App *a) {',
                '    App_p declared = a->ptr();',
                '    declared->remove();',
                '    auto flowed = a->ptr();',
                '    flowed->remove();',
                '    auto pointer = a->raw();',
                '    pointer->remove();',
                '    Handle handle;',
                '    handle->remove();',
                '    App_p made = std::make_shared<App>();',
                '    made->remove();',
                '    auto shared = make_app();',
                '    shared->remove();',
                '    auto other = make_other();',
                '    other->remove();',
                '}',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const shown = shownOf(index, 'remove', 'app.hpp', 9);
            // Every line reaching App::remove is shown; Other's is excluded.
            assert.deepEqual(shown.confirmed,
                ['app.hpp:17', 'app.hpp:19', 'app.hpp:21', 'app.hpp:23', 'app.hpp:25', 'app.hpp:27']);
            assert.deepEqual(shown.unverified, []);
            const r = execute(index, 'context', { name: 'remove', file: 'app.hpp', line: 9 });
            assert.equal(r.result.meta.account.excluded.total, 1);
        } finally { rm(dir); }
    });

    it('a receiver typed by a template parameter or an alias of a dependent type is never excluded', () => {
        const dir = tmp({
            'j.hpp': [
                '#include <type_traits>',
                'namespace N {',
                'template<bool B, class T, class F>',
                'using conditional_t = typename std::conditional<B, T, F>::type;',
                'class context { public: int arg_id(int) const; };',
                'template<typename C> class generic_context { public: int arg_id(int) const; };',
                'template<typename T>',
                'using buffered_context = conditional_t<std::is_same<T, char>::value, context, generic_context<T>>;',
                'template<typename Char> struct handler {',
                '    buffered_context<Char> ctx;',
                '    int on(int id) { return ctx.arg_id(id); }',
                '};',
                'template<typename BasicJsonType>',
                'int from_json(const BasicJsonType &j) { return j.arg_id(0); }',
                'struct holder {',
                '    template<typename ThisType>',
                '    static int ref(ThisType &obj) { return obj.arg_id(1); }',
                '};',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const fn = index.symbols.get('from_json')[0];
            assert.equal(fn.templateParams, '<BasicJsonType>');
            const shown = shownOf(index, 'arg_id', 'j.hpp', 5);
            assert.deepEqual(shown.confirmed, []);
            assert.deepEqual(shown.unverified.map(s => s.split(':').slice(0, 2).join(':')),
                ['j.hpp:11', 'j.hpp:14', 'j.hpp:17']);
            const r = execute(index, 'context', { name: 'arg_id', file: 'j.hpp', line: 5 });
            assert.equal(r.result.meta.account.excluded.total || 0, 0);
        } finally { rm(dir); }
    });

    it('::f() names the global namespace: a namespace member is not it without a global using', () => {
        const dir = tmp({
            'os.hpp': [
                '#include <unistd.h>',
                'namespace spd { namespace os {',
                'inline bool fsync(FILE *fp) { return ::fsync(fileno(fp)) == 0; }',
                '} }',
            ].join('\n'),
            'user.cpp': [
                '#include "os.hpp"',
                'namespace spd { namespace os { bool helper(); } }',
                'using namespace spd::os;',
                'bool run(FILE *fp) { return ::fsync(fp); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'fsync', file: 'os.hpp', line: 3 });
            assert.ok(r.ok, r.error);
            const account = r.result.meta.account;
            assert.equal(account.excluded.byReason['global-qualified']?.count, 1);
            const unverified = (r.result.unverifiedCallers || []).map(c => `${c.relativePath}:${c.line}:${c.reason}`);
            assert.deepEqual(unverified, ['user.cpp:4:global-qualified-using']);
            assert.deepEqual((r.result.callers || []).map(c => c.line), []);
            const callees = execute(index, 'context', { name: 'fsync', file: 'os.hpp', line: 3 }).result.callees || [];
            assert.ok(!callees.some(c => c.name === 'fsync'), 'the POSIX ::fsync is not a project callee');
        } finally { rm(dir); }
    });

    it('members a class declares only in a skipped configuration branch are indexed', () => {
        const dir = tmp({
            'chrono.hpp': [
                '#if FMT_A',
                'int broken( {',
                '#endif',
                'inline bool gm(int t) {',
                '  struct dispatcher {',
                '    bool fallback(int res) { return res == 0; }',
                '#if FMT_A',
                '    bool fallback(double) { return true; }',
                '#endif',
                '    bool run() { return fallback(1); }',
                '  };',
                '  return dispatcher().run();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const lines = (index.symbols.get('fallback') || []).map(d => `${d.className}:${d.startLine}`).sort();
            assert.deepEqual(lines, ['dispatcher:6', 'dispatcher:8']);
        } finally { rm(dir); }
    });

    it('a large file whose conditionals split braces keeps its namespaces and declarations', () => {
        const pad = `// ${'x'.repeat(78)}\n`.repeat(3400);
        const dir = tmp({
            'big.hpp': [
                '#ifndef GUARD_H',
                '#define GUARD_H',
                'namespace nl {',
                'namespace detail {',
                'struct from_json_fn { int operator()(int v) const { return v; } };',
                '}',
                '#ifndef HAS_CPP_17',
                'namespace',
                '{',
                '#endif',
                'constexpr const auto& from_json = detail::from_json_fn{};',
                '#ifndef HAS_CPP_17',
                '}  // namespace',
                '#endif',
                'namespace detail {',
                'enum class tag_t { error, store };',
                'class reader {',
                '  public:',
                '    bool get_number(int format, int& result) { return format == result; }',
                '};',
                '}',
                'class basic_json {',
                '  public:',
                '    using tag_t = detail::tag_t;',
                '};',
                '}',
                '#endif',
                pad,
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const ns = name => (index.symbols.get(name) || []).map(d => `${d.startLine}:${d.namespace || ''}`);
            assert.deepEqual(ns('tag_t'), ['16:nl::detail', '24:nl']);
            assert.deepEqual(ns('reader'), ['17:nl::detail']);
            const r = execute(index, 'plan', { name: 'tag_t', file: 'big.hpp', line: 16, renameTo: 'tag2_t' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.match(contents['big.hpp'], /using tag_t = detail::tag2_t;/);
        } finally { rm(dir); }
    });

    it('a qualified reference (an explicit instantiation) is renamed when its qualifier names the renamed function\'s namespace', () => {
        const dir = tmp({
            'fmt.hpp': [
                'namespace fmt { namespace detail { namespace dragonbox {',
                'template <typename T> T to_decimal(T x) { return x; }',
                '} } }',
            ].join('\n'),
            'inst.cpp': [
                '#include "fmt.hpp"',
                'namespace fmt { namespace detail {',
                'template float dragonbox::to_decimal(float x);',
                '} }',
                'namespace other { namespace dragonbox { template <typename T> T to_decimal(T x) { return x; } } }',
                'namespace other {',
                'template double dragonbox::to_decimal(double x);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'to_decimal', file: 'fmt.hpp', line: 2, renameTo: 'td2' });
            assert.ok(r.ok, r.error);
            const { contents } = applyRenamePlan(dir, r.result);
            assert.match(contents['inst.cpp'], /template float dragonbox::td2\(float x\);/);
            assert.match(contents['inst.cpp'], /template double dragonbox::to_decimal\(double x\);/);
        } finally { rm(dir); }
    });

    it('a globally qualified type (`::ns::T<X>`, also behind a member alias) is the type', () => {
        const dir = tmp({
            'p.hpp': [
                'namespace nl {',
                'template<typename S> class json_pointer {',
                '  public:',
                '    json_pointer<S> convert() const& { return *this; }',
                '};',
                'template<typename S> class basic_json {',
                '  public:',
                '    using json_pointer = ::nl::json_pointer<S>;',
                '    int value(const ::nl::json_pointer<S>& ptr) const { ptr.convert(); return 0; }',
                '    int other(const json_pointer& ptr) const { ptr.convert(); return 1; }',
                '};',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const shown = shownOf(index, 'convert', 'p.hpp', 4);
            assert.deepEqual(shown.confirmed, ['p.hpp:10', 'p.hpp:9']);
        } finally { rm(dir); }
    });

    it('a namespace the parse left as loose tokens of an ERROR still scopes what it encloses', () => {
        const dir = tmp({
            'e.hpp': [
                '#ifndef G',
                '#define G',
                'namespace outer {',
                'struct S { int x; }',
                '}',
                ')',
                'namespace detail',
                '{',
                'enum class tag_t { a, b };',
                '}',
                '#endif',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.equal(index.symbols.get('S')[0].namespace, 'outer');
        } finally { rm(dir); }
    });

    it('a pointer argument keeps its pointer level and pointee const in overload choice', () => {
        const dir = tmp({
            'emit.hpp': [
                '#include <string_view>',
                'namespace lib {',
                'void emit(std::string_view text);',
                'void emit(char c);',
                'void put(const char* text);',
                'void put(char* text);',
                '}',
            ].join('\n'),
            'run.cpp': [
                '#include "emit.hpp"',
                'void run(const char* text, char* buffer) {',
                '    lib::emit(text);',
                '    lib::put(text);',
                '    lib::put(buffer);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const callersOf = line => {
                const r = execute(index, 'context', { name: line < 5 ? 'emit' : 'put', file: 'emit.hpp', line });
                assert.ok(r.ok, r.error);
                return {
                    confirmed: (r.result.callers || []).map(c => c.line),
                    unverified: (r.result.unverifiedCallers || []).map(c => c.line),
                };
            };
            assert.deepEqual(callersOf(3), { confirmed: [3], unverified: [] });
            assert.deepEqual(callersOf(4), { confirmed: [], unverified: [] });
            assert.deepEqual(callersOf(5), { confirmed: [4], unverified: [] });
            assert.deepEqual(callersOf(6), { confirmed: [5], unverified: [] });
        } finally { rm(dir); }
    });

    it('a namespace whose closing brace the parse gave to an earlier declaration still scopes what follows', () => {
        const dir = tmp({
            'lib.hpp': [
                '#include <utility>',
                '',
                'namespace lib {',
                'namespace detail {',
                '',
                'class type_error {',
                '  public:',
                '    static type_error create(int id) { return type_error(); }',
                '};',
                '',
                'template<typename BasicJsonType, typename ArrayType>',
                'auto fill(const BasicJsonType& j, ArrayType& arr)',
                '-> decltype(',
                '    arr.reserve(std::declval<typename ArrayType::size_type>()),',
                '    j.template get<typename ArrayType::value_type>(),',
                '    void())',
                '{',
                '    ArrayType ret;',
                '    ret.reserve(j.size());',
                '    arr = std::move(ret);',
                '}',
                '',
                'template<typename BasicJsonType>',
                'void check(const BasicJsonType& j)',
                '{',
                '    if (!j.is_array())',
                '    {',
                '        throw type_error::create(302);',
                '    }',
                '}',
                '',
                '}  // namespace detail',
                'namespace other {',
                'class type_error { public: static type_error create(int id) { return type_error(); } };',
                '}',
                '}  // namespace lib',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.equal(index.symbols.get('check')[0].namespace, 'lib::detail');
            assert.deepEqual(index.symbols.get('type_error').map(d => d.namespace).sort(), ['lib::detail', 'lib::other']);
            const r = execute(index, 'context', { name: 'create', file: 'lib.hpp', line: 8 });
            assert.ok(r.ok, r.error);
            assert.deepEqual((r.result.callers || []).map(c => c.line), [28]);
            assert.deepEqual((r.result.unverifiedCallers || []).map(c => c.line), []);
            const other = execute(index, 'context', { name: 'create', file: 'lib.hpp', line: 34 });
            assert.deepEqual((other.result.callers || []).map(c => c.line), []);
            assert.deepEqual((other.result.unverifiedCallers || []).map(c => c.line), []);
        } finally { rm(dir); }
    });
});

describe('fix #396: C and C++ name lookup, preprocessor model and recovery leftovers', () => {
    const { applyRenamePlan } = require('./helpers');
    const output = require('../core/output');
    const shownOf = (index, name, file, line) => {
        const r = execute(index, 'context', { name, file, line });
        assert.ok(r.ok, r.error);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`).sort(),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}:${c.reason}`).sort(),
            excluded: Object.keys(r.result.meta?.account?.excluded?.byReason || {}).sort(),
        };
    };
    const planOf = (index, params) => {
        const r = execute(index, 'plan', params);
        assert.ok(r.ok, r.error);
        return r.result;
    };
    const reviewLines = plan => (plan.reviewItems || []).map(item => `${item.file}:${item.line}`).sort();

    it('an implicit-this call names the enclosing class member; an override below it is runtime dispatch only when virtual', () => {
        const header = virtual => [
            '#pragma once',
            'class Shape {',
            ' public:',
            `  ${virtual ? 'virtual ' : ''}double Area() const${virtual ? ' = 0' : ''};`,
            '  double Twice() const;',
            '};',
            'class Circle : public Shape {',
            ' public:',
            `  double Area() const${virtual ? ' override' : ''};`,
            '};',
        ].join('\n');
        const source = virtual => [
            '#include "shape.h"',
            virtual ? '' : 'double Shape::Area() const { return 1.0; }',
            'double Shape::Twice() const { return 2 * Area(); }',
            'double Circle::Area() const { return 3.14; }',
        ].join('\n');
        for (const virtual of [true, false]) {
            const dir = tmp({ 'shape.h': header(virtual), 'shape.cc': source(virtual) });
            try {
                const index = idx(dir);
                const base = shownOf(index, 'Area', 'shape.h', 4);
                assert.deepEqual(base.confirmed, ['shape.cc:3'], `virtual=${virtual}`);
                const override = shownOf(index, 'Area', 'shape.h', 9);
                assert.deepEqual(override.confirmed, [], `virtual=${virtual}`);
                if (virtual) {
                    assert.deepEqual(override.unverified, ['shape.cc:3:possible-dispatch']);
                } else {
                    assert.deepEqual(override.unverified, []);
                    assert.deepEqual(override.excluded, ['other-definition']);
                }
            } finally { rm(dir); }
        }
    });

    it('a type rename of an anonymous struct typedef edits every use of the typedef name (C)', () => {
        const dir = tmp({
            'a.c': [
                'typedef struct {',
                '    int pos;',
                '} stream_t, *stream_p;',
                'typedef struct lex_s {',
                '    stream_t stream;',
                '} lex_t;',
                'static int stream_get(stream_t *stream) { return stream->pos; }',
                'static int stream_peek(stream_p s) { return s->pos; }',
                'int lex_get(lex_t *lex) { return stream_get(&lex->stream); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('stream_t').find(d => d.type === 'struct');
            assert.equal(def.typedefName, true);
            assert.equal(index.symbols.get('stream_p')[0].aliasOf, 'stream_t');
            const plan = planOf(index, { name: 'stream_t', file: 'a.c', line: 1, renameTo: 'stream_z' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['a.c'], /\} stream_z, \*stream_p;/);
            assert.match(contents['a.c'], /stream_z stream;/);
            assert.match(contents['a.c'], /stream_get\(stream_z \*stream\)/);
            assert.deepEqual(reviewLines(plan), []);
        } finally { rm(dir); }
    });

    it('value references to a C function reach it through its forward declaration and the include closure', () => {
        const dir = tmp({
            'a.c': [
                'typedef void (*cb_t)(int);',
                'static void on_event(int x);',
                'static void set_cb(cb_t f) { f(1); }',
                'static void use_int(int v) { (void)v; }',
                'void run(void) {',
                '    set_cb(on_event);',
                '    cb_t g = on_event;',
                '    g(2);',
                '}',
                'void shadow(int on_event) { use_int(on_event); }',
                'void local(void) { int on_event = 1; use_int(on_event); }',
                'static cb_t table[] = { on_event };',
                'static void on_event(int x) { (void)x; }',
            ].join('\n'),
            'h.h': 'void handler(int x);',
            'b.c': '#include "h.h"\nvoid handler(int x) { (void)x; }',
            'c.c': [
                '#include "h.h"',
                'typedef void (*cb_t)(int);',
                'static void set(cb_t f) { f(1); }',
                'void go(void) { set(handler); handler(3); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'on_event', file: 'a.c', line: 13, renameTo: 'on_evt' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['a.c'], /static void on_evt\(int x\);/);
            assert.match(contents['a.c'], /set_cb\(on_evt\);/);
            assert.match(contents['a.c'], /cb_t g = on_evt;/);
            assert.match(contents['a.c'], /\{ on_evt \};/);
            assert.match(contents['a.c'], /void shadow\(int on_event\) \{ use_int\(on_event\); \}/);
            assert.match(contents['a.c'], /int on_event = 1; use_int\(on_event\);/);
            assert.deepEqual(reviewLines(plan), []);
            const cross = planOf(index, { name: 'handler', file: 'b.c', line: 2, renameTo: 'handle' });
            const crossApplied = applyRenamePlan(dir, cross).contents;
            assert.match(crossApplied['c.c'], /set\(handle\); handle\(3\);/);
            assert.match(crossApplied['h.h'], /void handle\(int x\);/);
        } finally { rm(dir); }
    });

    it('an out-of-class nested type definition joins its owner: members, calls, qualified and unqualified spellings', () => {
        const dir = tmp({
            'sk.hpp': [
                '#pragma once',
                'namespace ns {',
                'template <typename Key, class Comparator>',
                'class SkipList {',
                ' public:',
                '  void Insert(const Key& key);',
                ' private:',
                '  struct Node;',
                '  Node* NewNode(const Key& key);',
                '  Node* head_;',
                '};',
                'template <typename Key, class Comparator>',
                'struct SkipList<Key, Comparator>::Node {',
                '  explicit Node(const Key& k) : key(k) {}',
                '  void SetNext(int n, Node* x) { next_ = x; }',
                '  Key const key;',
                '  Node* next_;',
                '};',
                'template <typename Key, class Comparator>',
                'typename SkipList<Key, Comparator>::Node* SkipList<Key, Comparator>::NewNode(const Key& key) {',
                '  return new Node(key);',
                '}',
                'template <typename Key, class Comparator>',
                'void SkipList<Key, Comparator>::Insert(const Key& key) {',
                '  Node* x = NewNode(key);',
                '  x->SetNext(0, head_);',
                '  head_ = x;',
                '}',
                '}  // namespace ns',
            ].join('\n'),
            'list.hpp': [
                '#pragma once',
                'template <typename Key>',
                'class List {',
                '  struct Node;',
                '  Node* head_;',
                ' public:',
                '  void Push(const Key& key);',
                '};',
                'template <typename Key>',
                'struct List<Key>::Node {',
                '  void SetNext(int n, Node* x) { next = x; }',
                '  Node* next;',
                '};',
                'template <typename Key>',
                'void List<Key>::Push(const Key& key) { Node* n = nullptr; n->SetNext(1, head_); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const node = index.symbols.get('Node').find(d => d.type === 'struct' && d.file.endsWith('sk.hpp'));
            assert.equal(node.enclosingType, 'SkipList');
            assert.equal(node.namespace, 'ns');
            const setNext = index.symbols.get('SetNext').find(d => d.file.endsWith('sk.hpp'));
            assert.equal(setNext.className, 'Node');
            assert.deepEqual(shownOf(index, 'SetNext', 'sk.hpp', 15).confirmed, ['sk.hpp:26']);
            assert.deepEqual(shownOf(index, 'SetNext', 'list.hpp', 11).confirmed, ['list.hpp:15']);
            const plan = planOf(index, { name: 'Node', file: 'sk.hpp', line: 13, renameTo: 'Cell' });
            const { contents } = applyRenamePlan(dir, plan);
            const text = contents['sk.hpp'];
            assert.match(text, /struct Cell;/);
            assert.match(text, /struct SkipList<Key, Comparator>::Cell \{/);
            assert.match(text, /explicit Cell\(const Key& k\)/);
            assert.match(text, /typename SkipList<Key, Comparator>::Cell\* SkipList<Key, Comparator>::NewNode/);
            assert.match(text, /return new Cell\(key\);/);
            assert.match(text, /Cell\* x = NewNode\(key\);/);
            assert.equal(contents['list.hpp'], undefined);
            assert.deepEqual(reviewLines(plan), []);
        } finally { rm(dir); }
    });

    it('a nested type spelled through its enclosing class in another file is renamed', () => {
        const dir = tmp({
            'vs.h': [
                '#pragma once',
                'namespace ns {',
                'class VersionSet {',
                ' public:',
                '  struct Storage { char buffer[100]; };',
                '  const char* Summary(Storage* s) const;',
                '};',
                '}  // namespace ns',
            ].join('\n'),
            'vs.cc': '#include "vs.h"\nnamespace ns {\nconst char* VersionSet::Summary(Storage* s) const { return s->buffer; }\n}',
            'impl.cc': '#include "vs.h"\nnamespace ns {\nvoid Log(const VersionSet* v) {\n  VersionSet::Storage tmp;\n  v->Summary(&tmp);\n}\n}',
        });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'Storage', file: 'vs.h', line: 5, renameTo: 'Store' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['impl.cc'], /VersionSet::Store tmp;/);
            assert.match(contents['vs.cc'], /Summary\(Store\* s\)/);
            assert.match(contents['vs.h'], /struct Store \{/);
        } finally { rm(dir); }
    });

    it('a call in a macro replacement list binds at the macro expansion sites, through nested macros', () => {
        const dir = tmp({
            'reader.hpp': [
                '#define CHECK(x) (void)(x)',
                '#define ERROR_NORETURN(c) \\',
                '    CHECK(!HasErr()); /* once */ \\',
                '    SetErr(c);',
                '#define ERROR(c) do { ERROR_NORETURN(c); return; } while (0)',
                'class Reader {',
                ' public:',
                '  bool HasErr() const { return err_ != 0; }',
                '  void SetErr(int c) { err_ = c; }',
                '  void Parse(int x) {',
                '    if (x < 0) ERROR(1);',
                '    if (x > 9) ERROR_NORETURN(2);',
                '  }',
                ' private:',
                '  int err_ = 0;',
                '};',
                'class Other {',
                ' public:',
                '  void SetErr(int c) { e = c; }',
                '  int e;',
                '};',
                '#define MIXED(c) Touch(c)',
                'class A { public: void Touch(int) {} void Run() { MIXED(1); } };',
                'class B { public: void Touch(int) {} };',
                'inline void run_free() { MIXED(2); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepEqual(shownOf(index, 'SetErr', 'reader.hpp', 9).confirmed, ['reader.hpp:4']);
            assert.deepEqual(shownOf(index, 'HasErr', 'reader.hpp', 8).confirmed, ['reader.hpp:3']);
            const other = shownOf(index, 'SetErr', 'reader.hpp', 19);
            assert.deepEqual([other.confirmed, other.unverified], [[], []]);
            // One site in A's member, one in a free function: A's Touch is
            // unverified, B's is reached by no expansion.
            assert.deepEqual(shownOf(index, 'Touch', 'reader.hpp', 23).unverified,
                ['reader.hpp:22:macro-body-context']);
            const b = shownOf(index, 'Touch', 'reader.hpp', 24);
            assert.deepEqual([b.confirmed, b.unverified], [[], []]);
            const plan = planOf(index, { name: 'SetErr', file: 'reader.hpp', line: 9, renameTo: 'SetError' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['reader.hpp'], /^ {4}SetError\(c\);$/m);
            assert.match(contents['reader.hpp'], /void SetError\(int c\) \{ err_ = c; \}/);
            assert.match(contents['reader.hpp'], /void SetErr\(int c\) \{ e = c; \}/);
        } finally { rm(dir); }
    });

    it('a decoration macro before a return type and a parenthesized name (`API int (f)(..)`) names the function', () => {
        const dir = tmp({
            'conf.h': '#define LUA_API extern\n#define LUALIB_API LUA_API',
            'lua.h': [
                '#include "conf.h"',
                'typedef struct lua_State lua_State;',
                'typedef void * (*lua_Alloc) (void *ud, void *ptr, unsigned osize);',
                'LUA_API int   (lua_gettop) (lua_State *L);',
                'LUA_API lua_Alloc (lua_getallocf) (lua_State *L, void **ud);',
                'LUALIB_API void (luaL_buffinit) (lua_State *L, lua_Alloc f);',
            ].join('\n'),
            'api.c': [
                '#include "lua.h"',
                'LUA_API int lua_gettop (lua_State *L) { return 0; }',
                'int use(lua_State *L) { return lua_gettop(L); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const garbage of ['int', 'void', 'lua_Alloc']) {
                assert.ok(!(index.symbols.get(garbage) || []).some(d => d.type === 'function'), garbage);
            }
            const getallocf = index.symbols.get('lua_getallocf')[0];
            assert.equal(getallocf.returnType, 'lua_Alloc');
            assert.ok(index.symbols.get('luaL_buffinit'));
            const plan = planOf(index, { name: 'lua_Alloc', file: 'lua.h', line: 3, renameTo: 'lua_Allocator' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['lua.h'], /LUA_API lua_Allocator \(lua_getallocf\)/);
            assert.match(contents['lua.h'], /luaL_buffinit\) \(lua_State \*L, lua_Allocator f\)/);
            const fn = planOf(index, { name: 'lua_gettop', file: 'api.c', line: 2, renameTo: 'lua_top' });
            assert.match(applyRenamePlan(dir, fn).contents['lua.h'], /LUA_API int {3}\(lua_top\)/);
        } finally { rm(dir); }
    });

    it('a type name a macro spells by token pasting lists the pasting macro and each invocation producing it', () => {
        const dir = tmp({
            'sds.h': [
                'struct sdshdr8 { unsigned char len; };',
                'struct sdshdr16 { unsigned short len; };',
                '#define SDS_HDR_VAR(T,s) struct sdshdr##T *sh = (void*)((s)-(sizeof(struct sdshdr##T)));',
                '#define SDS_HDR(T,s) ((struct sdshdr##T *)((s)-(sizeof(struct sdshdr##T))))',
                '#define CAT(a, b) a##b',
            ].join('\n'),
            'sds.c': [
                '#include "sds.h"',
                'int len8(char *s) { SDS_HDR_VAR(8,s); return sh->len; }',
                'int len16(char *s) { return SDS_HDR(16,s)->len; }',
                'int alloc8(char *s) { return SDS_HDR(8,s)->len; }',
                'int size(void) { return sizeof(struct CAT(sdshdr, 8)); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'sdshdr8', file: 'sds.h', line: 1, renameTo: 'sdshdr8x' });
            assert.deepEqual(reviewLines(plan), ['sds.c:2', 'sds.c:4', 'sds.c:5', 'sds.h:3', 'sds.h:4']);
        } finally { rm(dir); }
    });

    it('a body a namespace-scope macro invocation wraps reaches members of a class its argument names, unverified', () => {
        const dir = tmp({
            'fixture.h': [
                '#pragma once',
                'class Base { public: int Helper() { return 1; } void Check(int) {} };',
                'class Other { public: void Unrelated() {} int CreateFile(int n) { return n; } };',
            ].join('\n'),
            'fixture_test.cc': [
                '#include "fixture.h"',
                'class VersionTest : public Base {',
                ' public:',
                '  int CreateFile(int n) { return n + Helper(); }',
                '};',
                'TEST_F(VersionTest, Empty) {',
                '  int f = CreateFile(3);',
                '  Check(f);',
                '  Unrelated();',
                '}',
                'TEST(Plain, Case) {',
                '  CreateFile(1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const generated = index.symbols.get('VersionTest_Empty')[0];
            assert.deepEqual(generated.generatedByMacro, { name: 'TEST_F', args: ['VersionTest', 'Empty'] });
            assert.deepEqual(shownOf(index, 'CreateFile', 'fixture_test.cc', 4).unverified,
                ['fixture_test.cc:7:macro-generated-scope']);
            assert.deepEqual(shownOf(index, 'Check', 'fixture.h', 2).unverified,
                ['fixture_test.cc:8:macro-generated-scope']);
            const unrelated = shownOf(index, 'Unrelated', 'fixture.h', 3);
            assert.deepEqual([unrelated.confirmed, unrelated.unverified], [[], []]);
        } finally { rm(dir); }
    });

    it('a member a member-list macro builds by token pasting is not renamed, and a return-type macro keeps the function', () => {
        const dir = tmp({
            'schema.hpp': [
                '#define STRING_(name, ...) \\',
                '    static const int& Get##name##String() { static const int v = 0; return v; }',
                '#define DISABLEIF_RETURN(cond, rt) rt',
                'class Schema {',
                ' public:',
                '    STRING_(MinProperties, 1, 2)',
                '    STRING_(MaxProperties, 3, 4)',
                '#undef STRING_',
                '    int Use() { return GetMinPropertiesString(); }',
                '    template <typename T>',
                '    DISABLEIF_RETURN((IsPointer<T>), (Schema&))',
                '    AddMember(Schema& name, T value, int& allocator) {',
                '        return AddMember(name, value, allocator);',
                '    }',
                '    template <typename T>',
                '    DISABLEIF_RETURN((NotExpr<IsSame<T, char> >),(Schema&)) operator[](T* name) {',
                '        return *this;',
                '    }',
                '    int Size() const { return 1; }',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const generated = index.symbols.get('GetMinPropertiesString')[0];
            assert.equal(generated.generatedByMacro.unspelled, true);
            const r = execute(index, 'plan', { name: 'GetMinPropertiesString', file: 'schema.hpp', line: 6, renameTo: 'GetMin' });
            assert.match(JSON.stringify(r.result), /macro-generated-name/);
            assert.ok(r.ok, r.error);
            assert.equal((r.result.changes || []).filter(change => change.newExpression !== undefined &&
                !change.needsReview).length, 0);
            const addMember = index.symbols.get('AddMember');
            assert.equal(addMember.length, 1);
            assert.equal(addMember[0].className, 'Schema');
            assert.equal(index.symbols.get('operator[]')?.[0]?.className, 'Schema');
            assert.equal(index.symbols.get('Size')?.[0]?.className, 'Schema');
            for (const symbols of index.symbols.values()) {
                assert.ok(!symbols.some(d => d.generatedByMacro && !d.className), symbols[0].name);
            }
        } finally { rm(dir); }
    });

    it('other external definitions of a declared C function are renamed with it; one no declaration reaches is a review item', () => {
        const files = {
            'net.h': '#ifndef NET_H\n#define NET_H\nint net_open(const char *host);\n#endif',
            'net.c': '#include "net.h"\n#ifdef _WIN32\nint net_open(const char *host) { return 1; }\n#else\nint net_open(const char *host) { return 2; }\n#endif',
            'net_win.c': '#include "net.h"\n#if defined(_WIN32) && defined(ALT)\nint net_open(const char *host) { return 3; }\n#endif',
            'main.c': '#include "net.h"\nint main(void) { return net_open("x"); }',
        };
        let dir = tmp(files);
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'net_open', file: 'net.c', line: 3, renameTo: 'net_connect' });
            const { contents } = applyRenamePlan(dir, plan);
            assert.match(contents['net_win.c'], /int net_connect\(const char \*host\)/);
            assert.match(contents['main.c'], /return net_connect\("x"\);/);
            assert.equal((contents['net.c'].match(/net_connect/g) || []).length, 2);
            assert.deepEqual(reviewLines(plan), []);
        } finally { rm(dir); }
        dir = tmp({ ...files, 'tool/other.c': 'int net_open(const char *host) { return 4; }' });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'net_open', file: 'net.c', line: 3, renameTo: 'net_connect' });
            assert.ok(reviewLines(plan).includes('tool/other.c:1'), JSON.stringify(reviewLines(plan)));
            assert.match(applyRenamePlan(dir, plan).contents['net_win.c'], /net_connect/);
        } finally { rm(dir); }
    });

    it('a call in a header to a static function it declares binds each including unit, unverified', () => {
        const dir = tmp({
            'util.h': '#ifndef UTIL_H\n#define UTIL_H\nstatic void run_tests();\nint main() {\n    run_tests();\n    return 0;\n}\n#endif',
            'test_a.c': '#include "util.h"\nstatic void run_tests() { }',
            'test_b.c': '#include "util.h"\nstatic void run_tests() { }',
        });
        try {
            const index = idx(dir);
            assert.deepEqual(shownOf(index, 'run_tests', 'test_a.c', 2).unverified, ['util.h:5:translation-unit-binding']);
            assert.deepEqual(shownOf(index, 'run_tests', 'test_b.c', 2).unverified, ['util.h:5:translation-unit-binding']);
        } finally { rm(dir); }
    });

    it('a receiver whose class overloads the name excludes an unrelated target even when the arguments choose no overload', () => {
        const dir = tmp({
            'writer.hpp': '#include <string>\nclass Writer {\npublic:\n    bool Key(const char* s, unsigned n, bool copy = false) { return true; }\n    bool Key(const std::string& s) { return true; }\n    bool Key(const char* const& s) { return true; }\n};',
            'doc.hpp': 'class Document {\npublic:\n    bool Key(const char* s, unsigned n, bool copy) { return true; }\n};',
            'main.cc': '#include "writer.hpp"\n#include "doc.hpp"\nint main() {\n    Writer writer;\n    writer.Key("hello");\n    Document d;\n    d.Key("k", 1, false);\n    return 0;\n}',
        });
        try {
            const index = idx(dir);
            const doc = shownOf(index, 'Key', 'doc.hpp', 3);
            assert.deepEqual(doc.confirmed, ['main.cc:7']);
            assert.deepEqual(doc.unverified, []);
            // Counter-probe: for Writer's own overloads the site stays open.
            const writer = shownOf(index, 'Key', 'writer.hpp', 6);
            assert.deepEqual(writer.confirmed, []);
            assert.deepEqual(writer.unverified.map(site => site.split(':').slice(0, 2).join(':')), ['main.cc:5']);
        } finally { rm(dir); }
    });

    it('a receiver a replacement list declares with a macro parameter as its type takes the type each invocation passes', () => {
        const dir = tmp({
            'v.hpp': 'class Validator {\npublic:\n    void SetFlags(unsigned f) { }\n};\nclass Other {\npublic:\n    void SetFlags(unsigned f) { }\n};',
            't.cc': '#include "v.hpp"\n#define CHECK(Validator, \\\n    flags) \\\n{ \\\n    Validator validator; \\\n    validator.SetFlags(flags); \\\n}\nvoid run() {\n    CHECK(Other, 1);\n}',
            'u.cc': '#include "v.hpp"\n#define BOTH(T) { T t; t.SetFlags(0); }\nvoid a() { BOTH(Other); }\nvoid b() { BOTH(Validator); }',
        });
        try {
            const index = idx(dir);
            // The parameter is spelled like Validator; the one invocation
            // passes Other (fix #401: typed per invocation).
            assert.deepEqual(shownOf(index, 'SetFlags', 'v.hpp', 7).confirmed.map(site =>
                site.split(':').slice(0, 2).join(':')).filter(site => site.startsWith('t.cc')), ['t.cc:6']);
            const validator = shownOf(index, 'SetFlags', 'v.hpp', 3);
            assert.ok(!validator.confirmed.some(site => site.startsWith('t.cc')));
            assert.ok(!validator.unverified.some(site => site.startsWith('t.cc')));
            // Invocations passing different types leave the call untyped.
            for (const line of [3, 7]) {
                const shown = shownOf(index, 'SetFlags', 'v.hpp', line);
                assert.ok(!shown.confirmed.some(site => site.startsWith('u.cc')));
                assert.deepEqual(shown.unverified.map(site => site.split(':').slice(0, 2).join(':'))
                    .filter(site => site.startsWith('u.cc')), ['u.cc:2']);
            }
        } finally { rm(dir); }
    });

    it('a namespace an object-like macro names is the namespace it expands to; a C++ alias is looked up where it is written', () => {
        const dir = tmp({
            'config.hpp': '#ifndef CONFIG_HPP\n#define CONFIG_HPP\n#ifndef LIB_NAMESPACE\n#define LIB_NAMESPACE lib\n#endif\n#define LIB_NAMESPACE_BEGIN namespace LIB_NAMESPACE {\n#define LIB_NAMESPACE_END }\n#endif',
            'value.hpp': '#ifndef VALUE_HPP\n#define VALUE_HPP\n#include "config.hpp"\nLIB_NAMESPACE_BEGIN\nclass GenericValue {\npublic:\n    bool IsString() const { return true; }\n};\ntypedef GenericValue Value;\nLIB_NAMESPACE_END\n#endif',
            'other.hpp': 'namespace other {\nclass Doc {\npublic:\n    bool IsString() const { return false; }\n};\ntypedef Doc Value;\n}',
            'use.cpp': '#include "value.hpp"\nusing namespace lib;\nbool check() {\n    Value v;\n    return v.IsString();\n}',
            'use2.cpp': '#include "other.hpp"\nbool other_check() { other::Value d; return d.IsString(); }',
            'use3.cpp': '#include "value.hpp"\nLIB_NAMESPACE::GenericValue make();\nusing namespace LIB_NAMESPACE;\nGenericValue make2();',
        });
        try {
            const index = idx(dir);
            // `Value` in use.cpp is lib::Value (a typedef of GenericValue);
            // other::Value is not visible there.
            assert.deepEqual(shownOf(index, 'IsString', 'value.hpp', 7).confirmed, ['use.cpp:5']);
            const other = shownOf(index, 'IsString', 'other.hpp', 4);
            assert.ok(!other.confirmed.includes('use.cpp:5') &&
                !other.unverified.some(site => site.startsWith('use.cpp:5')));
            // Qualifiers and using-directives spelled with the macro name the
            // same namespace.
            const plan = planOf(index, { name: 'GenericValue', file: 'value.hpp', line: 5, renameTo: 'GV2' });
            assert.deepEqual((plan.changes || []).map(change =>
                `${change.file}:${change.line}:${change.needsReview ? 'review' : 'edit'}`).sort(),
            ['use3.cpp:2:edit', 'use3.cpp:4:edit', 'value.hpp:5:edit', 'value.hpp:9:edit']);
        } finally { rm(dir); }
    });

    it('a class the grammar closed early is no return type: the next member keeps its declared type', () => {
        const dir = tmp({
            'config.hpp': '#ifndef CONFIG_HPP\n#define CONFIG_HPP\n#if __cplusplus >= 201703L\n#define LIB_IF_CONSTEXPR if constexpr\n#else\n#define LIB_IF_CONSTEXPR if\n#endif\n#endif',
            'pointer.hpp': [
                '#ifndef POINTER_HPP', '#define POINTER_HPP', '#include "config.hpp"', 'namespace lib {',
                'template <typename ValueType, typename Allocator>', 'class Pointer {', 'public:',
                '    typedef typename ValueType::Ch Ch;',
                '    Pointer Append(const Ch* name, int length) const {', '        return *this;', '    }',
                '    Pointer Append(int index) const {', '        char buffer[21];',
                '        LIB_IF_CONSTEXPR (sizeof(Ch) == 1) {', '            return Append(buffer, index);', '        }',
                '        else {', '            Ch name[21];', '            return Append(name, index);', '        }', '    }',
                '    Pointer Append(const ValueType& token) const {', '        if (token.IsString())',
                '            return Append(token.GetString(), 1);', '        return Append(0);', '    }',
                '};', '}', '#endif',
            ].join('\n'),
            'value.hpp': 'namespace lib {\nclass Value {\npublic:\n    typedef char Ch;\n    bool IsString() const { return true; }\n    const char* GetString() const { return ""; }\n};\n}',
            'main.cpp': '#include "pointer.hpp"\n#include "value.hpp"\nint main() { return 0; }',
        });
        try {
            const index = idx(dir);
            const appends = (index.symbols.get('Append') || []).map(d => `${d.startLine}:${d.type}:${d.className || ''}`).sort();
            assert.deepEqual(appends, ['12:method:Pointer', '22:method:Pointer', '9:method:Pointer']);
        } finally { rm(dir); }
    });

    it('a nested type used in a class body the literal parse split is renamed through the recovered owners', () => {
        const dir = tmp({
            // A conditional whose branches split the braces: the literal
            // tree reads `union Data` outside every class.
            'value.hpp': [
                '#ifndef VALUE_HPP', '#define VALUE_HPP', 'class Value {', '#if LIB_LITTLE_ENDIAN', '        struct I {', '#endif',
                '    struct ArrayData {', '    };', '    union Data {', '        ArrayData a;', '    }',
                '    void AddMember(Value& name) {', '    }', '#if LIB_HAS_RVALUE_REFS', '    }', '#endif', '#endif',
            ].join('\n'),
            'main.cpp': '#include "value.hpp"\nint main() { return 0; }',
        });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'ArrayData', file: 'value.hpp', line: 7, renameTo: 'AD2' });
            assert.deepEqual(reviewLines(plan), []);
            const edits = (plan.changes || []).map(change =>
                `${change.file}:${change.line}:${change.needsReview ? 'review' : 'edit'}`).sort();
            assert.deepEqual(edits, ['value.hpp:10:edit', 'value.hpp:7:edit']);
        } finally { rm(dir); }
    });

    it('a member type spelled through a dependent specialization stays a review item when the template has explicit specializations', () => {
        const dir = tmp({
            'acc.hpp': [
                'namespace ns {', 'template <typename T> struct Acc;', 'template <> struct Acc<float> {',
                '    struct Result { bool parity; };', '    static auto compute() -> Result { return {true}; }', '};',
                'template <> struct Acc<double> {', '    struct Result { bool parity; };',
                '    static auto compute() -> Result { return {false}; }', '};',
                'template <typename T> bool use() {', '    const typename Acc<T>::Result r = Acc<T>::compute();',
                '    return r.parity;', '}', '}',
            ].join('\n'),
            'main.cpp': '#include "acc.hpp"\nint main() { return ns::use<float>() ? 0 : 1; }',
        });
        try {
            const index = idx(dir);
            const plan = planOf(index, { name: 'Result', file: 'acc.hpp', line: 4, renameTo: 'Result2' });
            const changes = (plan.changes || []).map(change =>
                `${change.line}:${change.needsReview ? 'review' : 'edit'}`).sort();
            assert.deepEqual(changes, ['12:review', '4:edit', '5:edit']);
        } finally { rm(dir); }
    });

    it('a call excluded inside a parse-recovery region is a plan review item', () => {
        const dir = tmp({
            'pool.cpp': [
                '#include <lib/common.h>',
                'class Pool {',
                ' public:',
                '  void Stop();',
                '  bool Next();',
                '  int n_ = 0;',
                '};',
                'void Pool::Stop() {',
                '    LIB_TRY {',
                '        for (int i = 0; i < n_; i++) {',
                '            while (Next()) {}',
                '        }',
                '    }',
                '    LIB_CATCH',
                '}',
                'bool Pool::Next() { return false; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.ok(index.files.get(path.join(dir, 'pool.cpp')).parseErrorRegions?.length > 0);
            const plan = planOf(index, { name: 'Next', file: 'pool.cpp', line: 5, renameTo: 'Advance' });
            assert.ok(reviewLines(plan).includes('pool.cpp:11'), JSON.stringify(plan.reviewItems));
        } finally { rm(dir); }
    });

    it('decoration, statement and attribute macros another header defines are read by the recovery of its includers', () => {
        const files = {
            'lib/common.hpp': [
                '#pragma once',
                '#ifdef LIB_HEADER_ONLY',
                '#define LIB_INLINE inline',
                '#else',
                '#define LIB_INLINE',
                '#endif',
                '#ifdef LIB_NO_EXCEPTIONS',
                '#define LIB_TRY',
                '#define LIB_CATCH',
                '#else',
                '#define LIB_TRY try',
                '#define LIB_CATCH catch (...) {}',
                '#endif',
                '#define LIB_NONNULL(...) __attribute__((__nonnull__(__VA_ARGS__)))',
                '#if __cplusplus >= 201703L',
                '#define LIB_IF_CONSTEXPR if constexpr',
                '#else',
                '#define LIB_IF_CONSTEXPR if',
                '#endif',
            ].join('\n'),
            'lib/pool.hpp': [
                '#pragma once',
                '#include "common.hpp"',
                'class Pool {',
                ' public:',
                '  void Stop();',
                '  bool Next();',
                '  LIB_NONNULL(2)',
                '  bool Put(int a, const char *b);',
                '  int Size() const;',
                '  int n_ = 0;',
                '};',
            ].join('\n'),
            'lib/pool-inl.hpp': [
                '#pragma once',
                '#include "pool.hpp"',
                'void LIB_INLINE Pool::Stop() {',
                '    LIB_TRY {',
                '        for (int i = 0; i < n_; i++) {',
                '            while (Next()) {}',
                '        }',
                '    }',
                '    LIB_CATCH',
                '}',
                'LIB_INLINE bool Pool::Next() { return Size() > 0; }',
                'LIB_INLINE int Pool::Size() const {',
                '    LIB_IF_CONSTEXPR (sizeof(int) == 4) {',
                '        return n_;',
                '    }',
                '    else {',
                '        return 0;',
                '    }',
                '}',
            ].join('\n'),
            // Spells the names without including the header that defines them.
            'other/unrelated.cpp': [
                'class Other { public: void Stop(); bool Next(); };',
                'void Other::Stop() {',
                '    LIB_TRY {',
                '        for (int i = 0; i < 3; i++) {',
                '            while (Next()) {}',
                '        }',
                '    }',
                '    LIB_CATCH',
                '}',
            ].join('\n'),
        };
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const inl = index.files.get(path.join(dir, 'lib/pool-inl.hpp'));
            assert.equal(inl.parseErrorRegions, undefined, JSON.stringify(inl.parseErrorRegions));
            assert.deepEqual(inl.externalMacroNames, ['LIB_CATCH', 'LIB_IF_CONSTEXPR', 'LIB_INLINE', 'LIB_TRY']);
            // The keyword a macro stands for is kept in the persisted
            // recovery, which rebuilds the same clean tree.
            assert.ok(inl.recoveryBlanks.some(range => range.length === 3 && range[2].trim() === 'if'));
            const { getParser } = require('../languages');
            const cpp = require('../languages/cpp');
            const rebuilt = cpp.recoveredTree(fs.readFileSync(path.join(dir, 'lib/pool-inl.hpp'), 'utf-8'),
                getParser('cpp'), inl.recoveryBlanks);
            assert.equal(rebuilt.rootNode.hasError, false);
            assert.equal(index.symbols.get('Size').find(d => d.file.endsWith('pool-inl.hpp'))?.className, 'Pool');
            const header = index.files.get(path.join(dir, 'lib/pool.hpp'));
            assert.equal(header.parseErrorRegions, undefined, JSON.stringify(header.parseErrorRegions));
            const stop = index.symbols.get('Stop').find(d => d.file.endsWith('pool-inl.hpp'));
            assert.equal(stop.className, 'Pool');
            assert.deepEqual(shownOf(index, 'Next', 'lib/pool.hpp', 6).confirmed, ['lib/pool-inl.hpp:6']);
            // A file whose includes never define the names is read without them.
            const other = index.files.get(path.join(dir, 'other/unrelated.cpp'));
            assert.ok(other.parseErrorRegions?.length > 0);
            assert.equal(other.externalMacroNames, undefined);
        } finally { rm(dir); }
    });

    it('a typedef declared in a block does not make a project alias ambiguous elsewhere', () => {
        const dir = tmp({
            'fwd.hpp': '#pragma once\ntemplate <typename E, typename A> class GenericBuffer;\ntypedef GenericBuffer<char, int> Buffer;',
            'buffer.hpp': [
                '#pragma once',
                '#include "fwd.hpp"',
                'template <typename E, typename A = int>',
                'class GenericBuffer {',
                ' public:',
                '  const E* Get() const { return 0; }',
                '};',
                'typedef GenericBuffer<char> Buffer;',
                'class Other { public: const char* Get() const { return 0; } };',
            ].join('\n'),
            'use.cpp': '#include "buffer.hpp"\nconst char* use() { Buffer sb; return sb.Get(); }',
            'test.cpp': [
                '#include "buffer.hpp"',
                'void check() {',
                '    typedef ::Buffer Buffer;',
                '    Buffer local;',
                '    local.Get();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const local = index.symbols.get('Buffer').find(d => d.file.endsWith('test.cpp'));
            assert.equal(local.lexicalScopeStartLine, 3);
            const shown = shownOf(index, 'Get', 'buffer.hpp', 6);
            assert.ok(shown.confirmed.includes('use.cpp:2'), JSON.stringify(shown));
            assert.deepEqual(shownOf(index, 'Get', 'buffer.hpp', 9).confirmed, []);
        } finally { rm(dir); }
    });

    it('a string literal may bind a pointer to an aliased character type, never one to a project class', () => {
        const dir = tmp({
            're.hpp': [
                'struct Utf8 { typedef char Ch; };',
                'struct Widget { int w; };',
                'template <typename Encoding>',
                'class Search {',
                ' public:',
                '    typedef typename Encoding::Ch Ch;',
                '    bool Find(const Ch* s) { return s != 0; }',
                '    bool Put(const Widget* w) { return w != 0; }',
                '    bool Put(const char* n) { return n != 0; }',
                '};',
                'inline bool use(Search<Utf8>& rs) { return rs.Find("abc") && rs.Put("x"); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const find = shownOf(index, 'Find', 're.hpp', 7);
            assert.deepEqual([...find.confirmed, ...find.unverified.map(u => u.split(':').slice(0, 2).join(':'))], ['re.hpp:11']);
            const put = shownOf(index, 'Put', 're.hpp', 8);
            assert.deepEqual([put.confirmed, put.unverified], [[], []]);
            assert.deepEqual(shownOf(index, 'Put', 're.hpp', 9).confirmed, ['re.hpp:11']);
        } finally { rm(dir); }
    });

    it('a conditional that splits a block\'s braces is repaired in a small file, then misread macros around it', () => {
        const dir = tmp({
            'macros.hpp': '#pragma once\n#define LIB_NON_NULL(...) __attribute__((__nonnull__(__VA_ARGS__)))\n#define LIB_INLINE_VAR inline\n',
            'reader.hpp': [
                '#pragma once',
                '#include "macros.hpp"',
                'namespace detail {',
                'LIB_INLINE_VAR constexpr int max_size = 1 << 20;',
                'class reader {',
                '  public:',
                '    LIB_NON_NULL(3)',
                '    bool parse(int format, int strict, const char* sax);',
                '    template<class N>',
                '    static void swap(N& number) {',
                '        constexpr int sz = sizeof(number);',
                '#ifdef HAVE_BYTESWAP',
                '        if constexpr (sz == 1) {',
                '            return;',
                '        } else {',
                '#endif',
                '            number = number;',
                '#ifdef HAVE_BYTESWAP',
                '        }',
                '#endif',
                '    }',
                '    LIB_NON_NULL(2)',
                '    bool eof(int format, const char* context) const;',
                '    int get() { return eof(1, "x") ? 0 : 1; }',
                '};',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const entry = index.files.get(path.join(dir, 'reader.hpp'));
            assert.equal(entry.parseErrorRegions, undefined, JSON.stringify(entry.parseErrorRegions));
            for (const member of ['parse', 'swap', 'eof', 'get']) {
                assert.equal(index.symbols.get(member)?.[0]?.className, 'reader', member);
            }
            assert.deepEqual(shownOf(index, 'eof', 'reader.hpp', 23).confirmed, ['reader.hpp:24']);
        } finally { rm(dir); }
    });

    it('a file read with another header\'s macro definitions is read again when they change', () => {
        const { ProjectIndex } = require('../core/project');
        const { indexSnapshot } = require('./helpers');
        const dir = tmp({
            'common.hpp': '#pragma once\n#define LIB_TRY try\n#define LIB_CATCH catch (...) {}',
            'pool.cpp': [
                '#include "common.hpp"',
                'class Pool { public: void Stop(); bool Next(); int n_ = 0; };',
                'void Pool::Stop() {',
                '    LIB_TRY {',
                '        for (int i = 0; i < n_; i++) {',
                '            while (Next()) {}',
                '        }',
                '    }',
                '    LIB_CATCH',
                '}',
                'bool Pool::Next() { return false; }',
            ].join('\n'),
        });
        try {
            const first = new ProjectIndex(dir);
            first.build(null, { quiet: true });
            first.saveCache();
            const pool = path.join(dir, 'pool.cpp');
            assert.equal(first.files.get(pool).parseErrorRegions, undefined);
            // The definition changes to something that is not a statement
            // fragment: the unchanged includer is read again.
            fs.writeFileSync(path.join(dir, 'common.hpp'), '#pragma once\n#define LIB_TRY if (x) + \n#define LIB_CATCH catch (...) {}');
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            loaded.build(null, { quiet: true, forceRebuild: true });
            const fresh = new ProjectIndex(dir);
            fresh.build(null, { quiet: true });
            assert.ok(loaded.files.get(pool).parseErrorRegions?.length > 0);
            assert.equal(indexSnapshot(loaded), indexSnapshot(fresh));
        } finally { rm(dir); }
    });
});

describe('fix #401: C++ name hiding, using-declarations, subscript receivers', () => {
    const lines = (entries) => (entries || []).map(c => c.line).sort((a, b) => a - b);
    const callersOf = (index, name, file, line) => {
        const def = index.symbols.get(name).find(d => d.relativePath === file && d.startLine === line);
        return index.findCallers(name, { targetDefinitions: [def], collectAccount: true, includeMethods: true });
    };

    it('a derived member hides every base member of its name unless a using-declaration brings them in', () => {
        const dir = tmp({
            'hide.cpp': [
                'struct Base {',                                   // 1
                '  int ping() { return 1; }',                      // 2
                '  int both() { return 0; }',                      // 3
                '};',                                              // 4
                'struct Derived : Base {',                         // 5
                '  int ping(int extra = 0) { return extra; }',     // 6
                '  using Base::both;',                             // 7
                '  int both(int x) { return x; }',                 // 8
                '};',                                              // 9
                'int use1(Derived& d) {',                          // 10
                '  return d.ping();',                              // 11
                '}',                                               // 12
                'int use2(Derived& d) {',                          // 13
                '  return d.both();',                              // 14
                '}',                                               // 15
                'int third() {',                                   // 16
                '  struct Local : Base { static int ping(int extra = 0) { return 3; } };', // 17
                '  return Local::ping();',                         // 18
                '}',                                               // 19
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const derivedPing = callersOf(index, 'ping', 'hide.cpp', 6);
            assert.deepStrictEqual(lines(derivedPing), [11], 'the default argument makes the derived member the only candidate');
            assert.deepStrictEqual((derivedPing.unverifiedEntries || []).map(c => c.line), []);
            const localPing = callersOf(index, 'ping', 'hide.cpp', 17);
            assert.deepStrictEqual(lines(localPing), [18]);
            const baseBoth = callersOf(index, 'both', 'hide.cpp', 3);
            assert.ok([...lines(baseBoth), ...(baseBoth.unverifiedEntries || []).map(c => c.line)].includes(14),
                'the using-declaration keeps the base member a candidate');
            assert.ok(!(baseBoth.accountRaw?.excludedEntries || []).some(e => e.line === 14 && e.reason !== 'arity-mismatch'),
                JSON.stringify(baseBoth.accountRaw));
        } finally { rm(dir); }
    });

    it('a bare call in a derived class keeps its inherited base member over a free function', () => {
        const dir = tmp({
            'scan.cpp': [
                'int set(int t) { return t; }',                         // 1
                'struct Base {',                                        // 2
                ' protected:',                                          // 3
                '  void set(const char* b) { }',                        // 4
                '};',                                                   // 5
                'struct Derived : Base {',                              // 6
                '  void fill() { set("x"); }',                          // 7
                '};',                                                   // 8
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const member = callersOf(index, 'set', 'scan.cpp', 4);
            assert.deepStrictEqual([...lines(member), ...lines(member.unverifiedEntries)], [7]);
            assert.deepStrictEqual(lines(callersOf(index, 'set', 'scan.cpp', 1)), [], 'never confirmed for the free function');
        } finally { rm(dir); }
    });

    it('a declaration read from a function-like macro invocation is never renamed as a function', () => {
        const dir = tmp({
            'annot.h': [
                '#if defined(__clang__)',
                '#define THREAD_ANNOTATION_ATTRIBUTE__(x) __attribute__((x))',
                '#else',
                '#define THREAD_ANNOTATION_ATTRIBUTE__(x)',
                '#endif',
                '#ifndef GUARDED_BY',
                '#define GUARDED_BY(x) THREAD_ANNOTATION_ATTRIBUTE__(guarded_by(x))',
                '#endif',
            ].join('\n') + '\n',
            'db.cc': '#include "db.h"\nint f() { return 0; }\n',
            'db.h': [
                '#include "annot.h"',                          // 1
                'struct Mutex { };',                           // 2
                'class DB {',                                  // 3
                '  Mutex mu_;',                                // 4
                '  int seed_ GUARDED_BY(mu_);',                // 5
                '  int count_ GUARDED_BY(mu_);',               // 6
                '};',                                          // 7
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const def = (index.symbols.get('GUARDED_BY') || []).find(d => d.type !== 'macro');
            assert.ok(def, 'the conditional attribute macro is read as a member declaration');
            const plan = execute(index, 'plan', { name: `db.h:${def.startLine}:GUARDED_BY`, renameTo: 'GB2' });
            assert.ok(plan.ok, JSON.stringify(plan.error));
            assert.ok((plan.result.changes || []).every(change => change.needsReview),
                JSON.stringify(plan.result.changes));
        } finally { rm(dir); }
    });

    it('`v[k].m()` on a class object takes the type its operator[] returns', () => {
        const dir = tmp({
            'sub.cpp': [
                'namespace js {',                                                      // 1
                'struct Value {',                                                      // 2
                '  const char* GetString() const { return ""; }',                      // 3
                '  Value& operator[](const char* key) { return *this; }',             // 4
                '};',                                                                  // 5
                'struct Str { const char* GetString() const { return "s"; } };',       // 6
                'template <class T> struct Vec { T& operator[](int i); };',            // 7
                '}',                                                                   // 8
                'const char* use(js::Value& v, js::Vec<js::Str>& w) {',                // 9
                '  const char* a = v["x"].GetString();',                               // 10
                '  const char* b = w[0].GetString();',                                 // 11
                '  return a ? a : b;',                                                 // 12
                '}',                                                                   // 13
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const value = callersOf(index, 'GetString', 'sub.cpp', 3);
            assert.deepStrictEqual(lines(value), [10]);
            const str = callersOf(index, 'GetString', 'sub.cpp', 6);
            assert.ok(!lines(str).includes(10), 'the Value subscript never reaches Str');
            assert.ok(!(value.accountRaw?.excludedEntries || []).some(e => e.line === 11),
                'a template parameter return types nothing: never excluded');
        } finally { rm(dir); }
    });
});

describe('fix #402: a typename functional cast in a body keeps the members after it', () => {
    it('blanks the disambiguator the grammar cannot read in an expression', () => {
        const dir = tmp({
            'json.hpp': [
                'template<typename object_t>',                 // 1
                'class basic_json {',                          // 2
                '  public:',                                   // 3
                '    void push_back(initializer_list_t init)', // 4
                '    {',                                       // 5
                '        if (is_object() && init.size() == 2 && (*init.begin())->is_string())', // 6
                '        {',                                   // 7
                '            basic_json&& key = init.begin()->moved_or_copied();', // 8
                '            push_back(typename object_t::value_type(', // 9
                '                          std::move(key.get_ref<string_t&>()), (init.begin() + 1)->moved_or_copied()));', // 10
                '        }',                                   // 11
                '        else',                                // 12
                '        {',                                   // 13
                '            push_back(basic_json(init));',    // 14
                '        }',                                   // 15
                '    }',                                       // 16
                '',                                            // 17
                '    reference operator+=(initializer_list_t init)', // 18
                '    {',                                       // 19
                '        push_back(init);',                    // 20
                '        return *this;',                       // 21
                '    }',                                       // 22
                '',                                            // 23
                '    void update(int j, bool merge = false)',  // 24
                '    {',                                       // 25
                '        update(j);',                          // 26
                '    }',                                       // 27
                '};',                                          // 28
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'find', { name: 'update', exact: true, file: 'json.hpp' });
            assert.ok(r.ok, JSON.stringify(r.error));
            assert.deepStrictEqual(r.result.map(d => `${d.startLine}:${d.className}`), ['24:basic_json']);
            const pushBack = index.symbols.get('push_back');
            assert.deepStrictEqual(pushBack.map(d => `${d.startLine}-${d.endLine}`), ['4-16']);
        } finally { rm(dir); }
    });
});

describe('fix #418: the constructor-owner proof is consulted only for members named like a project type', () => {
    it('a method whose return type a macro writes keeps its ordinary rename', () => {
        const dir = tmp({ 'main.cpp': '#define RET(t) t\nstruct Store {\n  int count();\n};\nRET(int) Store::count() { return 1; }\nint use(Store& s) { return s.count(); }\n' });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'main.cpp:5:count', renameTo: 'total' });
            assert.strictEqual(result.ok, true, result.error);
            assert.deepStrictEqual(result.result.changes.filter(c => c.newExpression && !c.needsReview).map(c => c.line).sort(),
                [3, 5, 6]);
        } finally { rm(dir); }
    });
    it('an alias-qualified constructor still plans its declaring type rename', () => {
        const dir = tmp({ 'main.cpp': 'struct Node {\n explicit Node(int);\n};\nusing Alias = Node;\nAlias::Node(int) {}\nint main(){Alias n(1);}\n' });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'main.cpp:5:Node', renameTo: 'Renamed' });
            assert.strictEqual(result.ok, true, result.error);
            assert.ok(result.result.changes.some(c => c.line === 1 && c.newExpression?.includes('struct Renamed')));
        } finally { rm(dir); }
    });
});

describe('fix #419: configuration alternatives as one rename closure; other translation units; delegation', () => {
    const arms = [
        '#include <algorithm>', 'namespace util {', '#if defined(USE_STD)', 'using std::clamp;',
        'int inStd() { return clamp(0, 0, 0); }', '#elif defined(FAST)', 'int clamp(int v, int lo, int hi) { return v; }',
        'int inFast() { return clamp(1, 1, 1); }', 'int (*fast)(int, int, int) = &clamp;', '#else',
        'int clamp(int v, int lo, int hi) { return lo; }', 'int inSlow() { return clamp(2, 2, 2); }', '#endif',
        'int outside() { return clamp(3, 3, 3); }', '}', ''].join('\n');
    const plan = (dir, handle) => {
        const r = execute(idx(dir), 'plan', { name: handle, renameTo: 'clamp2' });
        assert.ok(r.ok, r.error);
        return r.result;
    };
    const edits = result => result.changes.filter(change => change.newExpression !== undefined && !change.needsReview)
        .map(change => change.line).sort((a, b) => a - b);
    const reviews = result => result.changes.filter(change => change.needsReview).map(change => change.line).sort((a, b) => a - b);
    it('a call in another alternative\'s arm is renamed with that alternative', () => {
        const dir = tmp({ 'a.cpp': arms });
        try {
            for (const handle of ['a.cpp:7:clamp', 'a.cpp:11:clamp']) {
                const result = plan(dir, handle);
                assert.deepStrictEqual(edits(result), [7, 8, 11, 12], handle);
                // The import arm's call keeps its spelling and is reported as
                // another target; the reference in the FAST arm and the call
                // after the group are reviews.
                assert.deepStrictEqual(reviews(result), [4, 9, 14], handle);
                assert.strictEqual(result.account.excluded.total, 1, JSON.stringify(result.account));
                assert.ok(result.account.conserved);
            }
        } finally { rm(dir); }
    });
    it('a translation unit that cannot include the definition binds it by linkage alone', () => {
        const dir = tmp({
            'a.cpp': '#include <algorithm>\nnamespace util {\n#if USE_STD\nusing std::clamp;\n#else\n' +
                'int clamp(int v, int lo, int hi) { return v; }\n#endif\nint outside() { return clamp(7, 8, 9); }\n}\n',
            'b.cpp': 'namespace util { int clamp(int v, int lo, int hi); }\nint other() { return util::clamp(1, 1, 1); }\n',
        });
        try {
            const index = idx(dir);
            const context = execute(index, 'context', { name: 'a.cpp:6:clamp' });
            assert.ok(context.ok, context.error);
            assert.ok(context.result.callers.some(site => site.relativePath === 'b.cpp' && site.line === 2));
            assert.deepStrictEqual(context.result.unverifiedCallers.map(site => `${site.relativePath}:${site.line} ${site.reason}`),
                ['a.cpp:8 configuration-alternative']);
            const result = plan(dir, 'a.cpp:6:clamp');
            assert.ok(result.changes.some(change => change.file === 'b.cpp' && change.line === 2 &&
                change.newExpression === 'int other() { return util::clamp2(1, 1, 1); }' && !change.needsReview));
        } finally { rm(dir); }
    });
    it('C++: a delegating constructor is never its own caller', () => {
        const dir = tmp({ 'a.cpp': 'struct W {\n    W(int x) {}\n    W(const char* s) : W(1) {}\n    W(long d) : W(static_cast<int>(d)) {}\n};\nW a() { return W(2); }\n' });
        try {
            const index = idx(dir);
            for (const [line, own] of [[3, 3], [4, 4]]) {
                const target = index.symbols.get('W').find(def => def.type === 'constructor' && def.startLine === line);
                const callers = index.findCallers('W', { targetDefinitions: [target], collectAccount: true });
                const all = [...callers, ...callers.unverifiedEntries].map(site => site.line);
                assert.ok(!all.includes(own), `${line}: ${all}`);
                assert.ok(callers.accountRaw.excludedEntries.some(entry => entry.line === own &&
                    entry.reason === 'constructor-delegation-self'), JSON.stringify(callers.accountRaw.excludedEntries));
            }
        } finally { rm(dir); }
    });
});

describe('fix #420: C/C++ value references by linkage, global qualification and local bindings', () => {
    const plan = (index, name, renameTo = 'cap') => {
        const result = execute(index, 'plan', { name, renameTo });
        assert.equal(result.ok, true, result.error);
        const edits = new Map(), reviews = new Set();
        for (const change of result.result.changes) {
            if (change.needsReview || change.newExpression === undefined) reviews.add(`${change.file}:${change.line}`);
            else edits.set(`${change.file}:${change.line}`, change.newExpression);
        }
        return { edits, reviews };
    };
    it('an extern declaration and the external definition are one object', () => {
        const dir = tmp({
            'g.h': 'extern int g_count;\nint a_get(void);\n',
            'a.c': '#include "g.h"\nint g_count = 0;\nstatic int s_val = 1;\nint a_get(void) { return g_count + s_val; }\n',
            'b.c': '#include "g.h"\nstatic int s_val = 2;\nint b_get(void) { g_count++; return s_val; }\n',
        });
        try {
            const index = idx(dir);
            const expected = {
                'g.h:1': 'extern int cap;', 'a.c:2': 'int cap = 0;',
                'a.c:4': 'int a_get(void) { return cap + s_val; }', 'b.c:3': 'int b_get(void) { cap++; return s_val; }',
            };
            for (const handle of ['a.c:2:g_count', 'g.h:1:g_count']) {
                const { edits, reviews } = plan(index, handle);
                assert.deepEqual(Object.fromEntries(edits), expected, handle);
                assert.equal(reviews.size, 0, handle);
            }
            // Internal linkage stays per translation unit.
            assert.deepEqual(Object.fromEntries(plan(index, 'a.c:3:s_val').edits), {
                'a.c:3': 'static int cap = 1;', 'a.c:4': 'int a_get(void) { return g_count + cap; }',
            });
        } finally { rm(dir); }
    });
    it('external definitions in several programs leave the shared declaration for review', () => {
        const dir = tmp({
            'g.h': 'extern int g_count;\n',
            'one.c': '#include "g.h"\nint g_count = 1;\nint main(void) { return g_count; }\n',
            'two.c': '#include "g.h"\nint g_count = 2;\n',
            'use.c': '#include "g.h"\nint use(void) { return g_count; }\n',
        });
        try {
            const { edits, reviews } = plan(idx(dir), 'one.c:2:g_count');
            assert.ok(edits.has('one.c:2'));
            assert.ok(reviews.has('g.h:1') && reviews.has('use.c:2'), JSON.stringify([...reviews]));
            assert.ok(!edits.has('two.c:2'));
        } finally { rm(dir); }
    });
    it('`::name` names the global namespace only; structured bindings are locals', () => {
        const dir = tmp({ 'a.cpp': [
            'namespace ns { int limit = 1; }',
            'int limit = 2;',
            'struct Box {',
            '    int limit = 3;',
            '    int get() const { return limit + this->limit + ::limit + ns::limit; }',
            '    int pair(int (&p)[2]) const { auto [limit, other] = p; return limit + other + this->limit; }',
            '};',
            '',
        ].join('\n') });
        try {
            const index = idx(dir);
            assert.deepEqual(Object.fromEntries(plan(index, 'a.cpp:4:limit').edits), {
                'a.cpp:4': 'int cap = 3;', 'a.cpp:5': 'int get() const { return cap + this->cap + ::limit + ns::limit; }',
                'a.cpp:6': 'int pair(int (&p)[2]) const { auto [limit, other] = p; return limit + other + this->cap; }',
            });
            assert.deepEqual(Object.fromEntries(plan(index, 'a.cpp:2:limit').edits), {
                'a.cpp:2': 'int cap = 2;', 'a.cpp:5': 'int get() const { return limit + this->limit + ::cap + ns::limit; }',
            });
        } finally { rm(dir); }
    });
});

describe('fix #421: C++ constructors defined outside their class', () => {
    const files = {
        'w.h': [
            'struct Widget {',                                   // 1
            '  Widget(const char* name, int size);',             // 2
            '  explicit Widget(int size);',                       // 3
            '  int size_;',                                       // 4
            '};',                                                 // 5
            'struct Fancy : Widget {',                            // 6
            '  Fancy();',                                         // 7
            '  Fancy(int a);',                                    // 8
            '};',                                                 // 9
            'struct Bare : Widget {',                             // 10
            '  Bare(int q);',                                     // 11
            '};',                                                 // 12
            'struct Dflt { Dflt(); };',                           // 13
            'struct Kid : Dflt { Kid(int k); };',                 // 14
        ].join('\n') + '\n',
        'w.cpp': [
            '#include "w.h"',                                                     // 1
            'Widget::Widget(const char* name, int size) : size_(size) { (void)name; }', // 2
            'Widget::Widget(int size) : Widget("anon", size) {}',                 // 3
            'Fancy::Fancy() : Widget("fancy", 3) {}',                             // 4
            'Fancy::Fancy(int a) : Fancy() { (void)a; }',                         // 5
            'Bare::Bare(int q) : Widget(q) {}',                                    // 6
            'Dflt::Dflt() {}',                                                    // 7
            'Kid::Kid(int k) { (void)k; }',                                       // 8
        ].join('\n') + '\n',
    };
    const callersOf = (index, file, line, name) => {
        const target = index.symbols.get(name).find(def => def.relativePath === file && def.startLine === line && def.type === 'constructor');
        return index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
    };
    it('delegations and base initializers bind the declarations their definitions select', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            for (const [file, line] of [['w.h', 2], ['w.cpp', 2]]) {
                assert.deepStrictEqual(callersOf(index, file, line, 'Widget').map(site => `${site.relativePath}:${site.line}`),
                    ['w.cpp:3', 'w.cpp:4']);
            }
            assert.deepStrictEqual(callersOf(index, 'w.h', 3, 'Widget').map(site => `${site.relativePath}:${site.line}`), ['w.cpp:6']);
            assert.deepStrictEqual(callersOf(index, 'w.h', 7, 'Fancy').map(site => `${site.relativePath}:${site.line}`), ['w.cpp:5']);
            // A delegation never targets the constructor it runs in.
            assert.deepStrictEqual(callersOf(index, 'w.h', 8, 'Fancy').map(site => site.line), []);
            const { validateConfirmation, declarationIdentity } = require('../core/provenance');
            const delegation = callersOf(index, 'w.h', 7, 'Fancy')[0];
            const target = index.symbols.get('Fancy').find(def => def.relativePath === 'w.h' && def.startLine === 7);
            const proof = JSON.parse(JSON.stringify(delegation.provenance));
            assert.strictEqual(validateConfirmation(proof, declarationIdentity(target)).verdict, 'establishes-target');
            proof.facts.constructorCall.delegatingDefinition.signature = 'double';
            assert.strictEqual(validateConfirmation(proof, declarationIdentity(target)).verdict, 'inconsistent');
            // The member initializer `size_(size)` is no call.
            const body = index.symbols.get('Widget').find(def => def.relativePath === 'w.cpp' && def.startLine === 2);
            const callees = index.findCallees(body, { collectAccount: true });
            assert.strictEqual(callees.calleeAccount.totalSites, 0);
            // The delegation's edge names the definition holding the body.
            const fancy = index.symbols.get('Fancy').find(def => def.relativePath === 'w.cpp' && def.startLine === 5);
            assert.deepStrictEqual(index.findCallees(fancy, { collectAccount: true }).map(def => `${def.relativePath}:${def.startLine}`),
                ['w.cpp:4']);
        } finally { rm(dir); }
    });
    it('an omitted base initializer is an unverified candidate on both sides', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const callers = callersOf(index, 'w.h', 13, 'Dflt');
            assert.strictEqual(callers.length, 0);
            assert.deepStrictEqual(callers.unverifiedEntries.map(entry => [entry.relativePath, entry.line, entry.reason]),
                [['w.cpp', 8, 'constructor-implicit-base-unproven']]);
            const kid = index.symbols.get('Kid').find(def => def.relativePath === 'w.cpp');
            const callees = index.findCallees(kid, { collectAccount: true });
            assert.deepStrictEqual(callees.unverifiedCallees.map(entry => [entry.name, entry.reason]),
                [['Dflt', 'constructor-implicit-base-unproven']]);
            assert.strictEqual(callees.calleeAccount.conserved, true);
            // A definition that initializes the base, or delegates, constructs none implicitly.
            for (const [name, line] of [['Bare', 6], ['Fancy', 5]]) {
                const def = index.symbols.get(name).find(d => d.relativePath === 'w.cpp' && d.startLine === line);
                assert.ok(!index.findCallees(def, { collectAccount: true }).unverifiedCallees
                    .some(entry => entry.reason === 'constructor-implicit-base-unproven'));
            }
        } finally { rm(dir); }
    });
    it('check reports the out-of-class initializers a signature change breaks', () => {
        const { execFileSync } = require('child_process');
        const dir = tmp(files);
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
        try {
            git('init', '-q'); git('add', '.'); git('commit', '-qm', 'initial');
            for (const file of ['w.h', 'w.cpp']) {
                const full = path.join(dir, file);
                fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('const char* name, int size)', 'const char* name, int size, int extra)'));
            }
            const answer = execute(idx(dir), 'check', { name: 'w.h:2:Widget' });
            assert.ok(answer.ok, answer.error);
            assert.deepStrictEqual(answer.result.mismatchDetails.map(site => `${site.file}:${site.line}`), ['w.cpp:3', 'w.cpp:4']);
        } finally { rm(dir); }
    });
    it('a data member initialized in an out-of-class definition is no call site of a field rename', () => {
        const dir = tmp(files);
        try {
            const answer = execute(idx(dir), 'plan', { name: 'w.h:4:size_', renameTo: 'count_' });
            assert.ok(answer.ok, answer.error);
            assert.ok(!(answer.result.unverifiedSites || []).some(site => site.reason === 'call-not-resolved'),
                JSON.stringify(answer.result.unverifiedSites));
            assert.strictEqual(answer.result.account.unverified, 0);
        } finally { rm(dir); }
    });
    it('sequential, two-worker and cache builds record the same initializer calls', () => {
        const { ProjectIndex } = require('../core/project');
        const dir = tmp(files);
        try {
            const records = index => [...index.files.keys()].sort().map(file => JSON.stringify(index.getCachedCalls(file)));
            const sequential = new ProjectIndex(dir); sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir); parallel.build(null, { quiet: true, workers: 2 });
            assert.deepStrictEqual(records(parallel), records(sequential));
            assert.ok(records(sequential).some(text => text.includes('"memberInitializer":true')));
            const { saveCache, loadCache } = require('../core/cache');
            const cachePath = path.join(dir, '.cache-421', 'index.json');
            saveCache(sequential, cachePath);
            const loaded = new ProjectIndex(dir);
            assert.ok(loadCache(loaded, cachePath));
            assert.deepStrictEqual(records(loaded), records(sequential));
        } finally { rm(dir); }
    });
});

describe('fix #421: C++ default initialization constructs a class', () => {
    const code = [
        '#include <initializer_list>',                 // 1
        'struct Box {',                                // 2
        '  Box(int v) : v(v) {}',                      // 3
        '  Box() : v(0) {}',                           // 4
        '  Box(std::initializer_list<int> l) : v(1) {}', // 5
        '  int v;',                                    // 6
        '};',                                          // 7
        'typedef int MyInt;',                          // 8
        'enum Color { Red };',                         // 9
        'Box global;',                                 // 10
        'int use() {',                                 // 11
        '  Box b;',                                    // 12
        '  static Box s;',                             // 13
        '  Box c{};',                                  // 14
        '  Box *p = new Box;',                         // 15
        '  Box arr[2];',                               // 16
        '  MyInt i = 0;',                              // 17
        '  Color col = Red;',                          // 18
        '  extern Box e;',                             // 19
        '  Box f();',                                  // 20
        '  return b.v + s.v + c.v + p->v + arr[0].v + i + col;', // 21
        '}',                                           // 22
    ].join('\n') + '\n';
    it('the default constructor receives every default-initialized object and an empty list', () => {
        const dir = tmp({ 'a.cpp': code });
        try {
            const index = idx(dir);
            const target = index.symbols.get('Box').find(def => def.type === 'constructor' && def.startLine === 4);
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.deepStrictEqual(callers.map(site => site.line), [10, 12, 13, 14, 15, 16]);
            assert.ok(callers.every(site => site.tier === 'confirmed'));
            const callees = index.findCallees(index.symbols.get('use')[0], { collectAccount: true });
            assert.deepStrictEqual(callees.filter(def => def.type === 'constructor').map(def => [def.startLine, def.callCount]), [[4, 5]]);
            assert.ok(!callees.some(def => ['MyInt', 'Color'].includes(def.name)));
            assert.strictEqual(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #421: constructions of a specialized class template stay unverified', () => {
    it('a template-id construction names no single member of a specialization family', () => {
        const dir = tmp({ 'a.hpp': [
            'namespace fmt {',                                                        // 1
            'template <typename T, typename Char = char> struct formatter { formatter() {} };', // 2
            'struct weekday {};',                                                     // 3
            'template <typename Char> struct formatter<weekday, Char> { formatter() {} };',    // 4
            'struct plain { plain() {} };',                                           // 5
            'template <typename Char, typename T> int write_alt(const T& v) {',       // 6
            '  formatter<T, Char> underlying;',                                       // 7
            '  plain p;',                                                             // 8
            '  return 0;',                                                            // 9
            '}',                                                                      // 10
            '}',                                                                      // 11
        ].join('\n') + '\n' });
        try {
            const index = idx(dir);
            for (const target of index.symbols.get('formatter').filter(def => def.type === 'struct')) {
                const callers = index.findCallers('formatter', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, 0, `${target.startLine}`);
                assert.deepEqual(callers.unverifiedEntries.map(entry => [entry.line, entry.reason]), [[7, 'template-specialization']]);
            }
            const callees = index.findCallees(index.symbols.get('write_alt')[0], { collectAccount: true });
            assert.ok(!callees.some(def => def.name === 'formatter'));
            assert.ok(callees.some(def => def.name === 'plain' && def.type === 'struct'));
            assert.ok(callees.unverifiedCallees.some(entry => entry.name === 'formatter'));
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #426: C++ template overloads of one parameter list are no configuration alternatives', () => {
    it('a template and a non-template get(int) are two members; an #if pair stays one item', () => {
        const dir = tmp({
            'a.hpp': [
                '#pragma once',
                'struct Row {',
                '    const char* get(int index) const { return nullptr; }',
                '    template <class T> T get(int index) const { return T(); }',
                '    template <class T, class C> T get(int index) const { return T(); }',
                '#ifdef WIDE',
                '    long put(int v) const { return v; }',
                '#else',
                '    long put(int v) const { return v + 1; }',
                '#endif',
                '};',
                'inline int use(const Row& r) { return r.get<int>(1) + (r.get(2) ? 1 : 0) + (int)r.put(3); }',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const edits = (line, name) => {
                const result = execute(index, 'plan', { name, file: 'a.hpp', line, renameTo: `${name}Z` });
                assert.ok(result.ok, result.error);
                return result.result.changes.filter(c => !c.needsReview && c.isDefinition).map(c => c.line).sort((a, b) => a - b);
            };
            assert.deepStrictEqual(edits(4, 'get'), [4]);
            assert.deepStrictEqual(edits(3, 'get'), [3]);
            assert.deepStrictEqual(edits(7, 'put'), [7, 9]);
        } finally { rm(dir); }
    });
});

describe('fix #427: C/C++ names, declarations and receivers by the languages own rules', () => {
    const callerLines = result => result.callers.map(c => `${c.relativePath}:${c.line}`).sort();
    const unverifiedLines = result => result.unverifiedCallers.map(c => `${c.relativePath}:${c.line}:${c.reason}`).sort();
    const calleesOf = (index, name, file) => {
        const def = index.symbols.get(name).find(d => d.relativePath === file);
        return index.findCallees(def, { includeMethods: true, collectAccount: true });
    };

    it('a capitalized namespace qualifier names a namespace, on both sides', () => {
        const dir = tmp({
            'a.hpp': [
                '#pragma once',
                'namespace Aa { inline int One(int x) { return x; } }',
                'namespace Bb { inline int One(int x) { return x + 1; } }',
                'struct Cc { static int One(int x) { return x + 2; } };',
                'namespace Y { namespace Exp { inline int Escape(int x) { return x; } } }',
            ].join('\n'),
            'main.cpp': [
                '#include "a.hpp"',
                'namespace Y { int scan(int v) { return Exp::Escape(v); } }',
                'int main() {',
                '    int r = Aa::One(1);',
                '    r += Bb::One(2);',
                '    r += Cc::One(3);',
                '    return r + Y::Exp::Escape(4);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const one = index.context('One', { file: 'a.hpp', line: 2 });
            assert.deepEqual(callerLines(one), ['main.cpp:4']);
            assert.equal(one.meta.account.conserved, true);
            const escape = index.context('Escape', { file: 'a.hpp', line: 5 });
            assert.deepEqual(callerLines(escape), ['main.cpp:2', 'main.cpp:7']);
            const member = index.context('One', { file: 'a.hpp', line: 4 });
            assert.deepEqual(callerLines(member), ['main.cpp:6']);
            const callees = calleesOf(index, 'main', 'main.cpp');
            assert.deepEqual(callees.map(c => `${c.relativePath}:${c.startLine}`).sort(),
                ['a.hpp:2', 'a.hpp:3', 'a.hpp:4', 'a.hpp:5']);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });

    it('a forward-declared class reached through a smart-pointer field is its definition', () => {
        const dir = tmp({
            'include/emitter.h': '#pragma once\n#include <memory>\nnamespace Y {\nclass State;\nclass Emitter {\n public:\n  void Doc();\n private:\n  std::unique_ptr<State> m_pState;\n  State* m_raw;\n};\n}',
            'src/state.h': '#pragma once\nnamespace Y {\nclass State {\n public:\n  void StartedDoc();\n};\n}',
            'src/state.cpp': '#include "state.h"\nnamespace Y {\nvoid State::StartedDoc() {}\n}',
            'src/emitter.cpp': '#include "emitter.h"\n#include "state.h"\nnamespace Y {\nvoid Emitter::Doc() {\n  m_pState->StartedDoc();\n  m_raw->StartedDoc();\n}\n}',
        });
        try {
            const index = idx(dir);
            const result = index.context('StartedDoc', { file: 'src/state.h', line: 5 });
            assert.deepEqual(callerLines(result), ['src/emitter.cpp:5', 'src/emitter.cpp:6']);
            assert.equal(result.meta.account.conserved, true);
            const callees = calleesOf(index, 'Doc', 'src/emitter.cpp');
            assert.deepEqual([...new Set(callees.map(c => `${c.name}:${c.relativePath}`))], ['StartedDoc:src/state.h']);
            assert.equal(callees.unverifiedCallees?.length || 0, 0);
        } finally { rm(dir); }
    });

    it('a field declared as a pointer to an external class reaches that class through ->', () => {
        const dir = tmp({
            'a.hpp': '#pragma once\n#include <map>\n#include <string>\ntypedef std::map<std::string, std::string> KVMap;\nstruct List { bool empty() const { return true; } };\nstruct Iter {\n    const KVMap* const map_;\n    bool done() const { return map_->empty(); }\n};',
        });
        try {
            const index = idx(dir);
            const result = index.context('empty', { file: 'a.hpp', line: 5 });
            assert.equal(result.callers.length + result.unverifiedCallers.length, 0);
            assert.equal(result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('a member declared in its class and defined outside it is one callee', () => {
        const dir = tmp({
            's.h': '#pragma once\nclass S { public: void f(); int g(int); };',
            's.cpp': '#include "s.h"\nvoid S::f() {}\nint S::g(int x) { return x; }',
            'm.cpp': '#include "s.h"\nvoid run(S* p) {\n    S s;\n    s.f();\n    p->g(1);\n}',
        });
        try {
            const index = idx(dir);
            const callees = calleesOf(index, 'run', 'm.cpp');
            assert.deepEqual(callees.filter(c => c.name !== 'S').map(c => `${c.name}:${c.relativePath}`).sort(),
                ['f:s.h', 'g:s.h']);
            assert.equal(callees.unverifiedCallees?.length || 0, 0);
            assert.equal(callees.calleeAccount.excluded.total || 0, 0);
        } finally { rm(dir); }
    });

    for (const extension of ['c', 'cpp']) {
        it(`${extension}: a definition after a static declaration has internal linkage`, () => {
            const dir = tmp({
                [`a.${extension}`]: 'static void expression(int x);\n\nstatic void statement(int y) {\n    expression(y);\n}\n\nvoid expression(int x) {\n    if (x > 0) statement(x - 1);\n}\n\nint main(void) { statement(3); return 0; }\n',
                [`b.${extension}`]: 'void expression(int x) { (void)x; }\n',
            });
            try {
                const index = idx(dir);
                const definition = index.symbols.get('expression').find(d => d.relativePath === `a.${extension}` && d.startLine === 7);
                assert.ok(definition.modifiers.includes('static'));
                const result = index.context('expression', { file: `a.${extension}`, line: 7 });
                assert.deepEqual(callerLines(result), [`a.${extension}:4`]);
                const plan = execute(index, 'plan', { name: `a.${extension}:7:expression`, renameTo: 'expressionZ' });
                assert.ok(plan.ok, plan.error);
                assert.deepEqual(plan.result.changes.map(c => `${c.file}:${c.line}`).sort(),
                    [`a.${extension}:1`, `a.${extension}:4`, `a.${extension}:7`]);
            } finally { rm(dir); }
        });
    }

    it('a decoration macro whose definitions name another decoration macro is decoration', () => {
        const dir = tmp({
            'api.h': [
                '#ifndef API_H',
                '#define API_H',
                '#ifndef LIB_VISIBILITY',
                '#  if defined(__GNUC__) && (__GNUC__ >= 4)',
                '#    define LIB_VISIBILITY __attribute__ ((visibility ("default")))',
                '#  else',
                '#    define LIB_VISIBILITY',
                '#  endif',
                '#endif',
                '#if defined(LIB_DLL_EXPORT) && (LIB_DLL_EXPORT==1)',
                '#  define LIB_API __declspec(dllexport) LIB_VISIBILITY',
                '#else',
                '#  define LIB_API LIB_VISIBILITY',
                '#endif',
                'typedef union stream_u stream_t;',
                '#if !defined(RC_INVOKED)',
                'LIB_API stream_t* create_stream(void);',
                'LIB_API int free_stream(stream_t* s);',
                '#endif',
                '#endif',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const create = index.symbols.get('create_stream')[0];
            assert.equal(create.returnType, 'stream_t *');
            const plan = execute(index, 'plan', { name: 'api.h:15:stream_t', renameTo: 'flow_t' });
            assert.ok(plan.ok, plan.error);
            const edited = plan.result.changes.filter(c => !c.needsReview).map(c => c.line).sort((a, b) => a - b);
            assert.deepEqual(edited, [15, 17, 18]);
        } finally { rm(dir); }
    });

    it('out-of-class conversion operators are members; their bare calls reach the class', () => {
        const dir = tmp({
            't.hpp': '#pragma once\nclass Text {\n    typedef void (*bool_type)(Text***);\npublic:\n    operator bool_type() const;\n    bool operator!() const;\n    explicit operator int() const;\nprivate:\n    int* _data() const;\n    int* _root = nullptr;\n};',
            't.cpp': '#include "t.hpp"\nstatic void bool_text(Text***) {}\nint* Text::_data() const { return _root; }\nText::operator Text::bool_type() const { return _data() ? bool_text : nullptr; }\nbool Text::operator!() const { return !_data(); }\nText::operator int() const { return _data() ? 1 : 0; }',
        });
        try {
            const index = idx(dir);
            const conversions = (index.symbols.get('operator bool_type') || []).map(d => `${d.relativePath}:${d.startLine}:${d.className}`).sort();
            assert.deepEqual(conversions, ['t.cpp:4:Text', 't.hpp:5:Text']);
            const result = index.context('_data', { file: 't.cpp', line: 3 });
            assert.deepEqual(callerLines(result), ['t.cpp:4', 't.cpp:5', 't.cpp:6']);
            assert.equal(result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('a class template deriving from its template parameter routes its receivers unverified', () => {
        const dir = tmp({
            'a.hpp': '#pragma once\ntemplate <class Derived>\nstruct Countable {\n    int bump() { return ++count_; }\n    int count_ = 0;\n};\ntemplate <class T>\nstruct Holder : T {\n    int twice() { return 2; }\n};\nstruct Widget : Countable<Widget> {};\ninline int run(Widget& w, Holder<Widget>& h) {\n    int a = h.bump();\n    return a + w.bump();\n}',
        });
        try {
            const index = idx(dir);
            const result = index.context('bump', { file: 'a.hpp', line: 4 });
            assert.deepEqual(callerLines(result), ['a.hpp:14']);
            assert.deepEqual(unverifiedLines(result), ['a.hpp:13:template-parameter-base']);
            assert.equal(result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('a class template that declares the member itself never reaches it through its parameter base', () => {
        const dir = tmp({
            'a.hpp': '#pragma once\nstruct Plain {};\ntemplate <class Traits>\nstruct Buffer : Traits {\n    int out() { return 1; }\n};\nstruct Ctx { int out() { return 2; } };\ninline int run(Buffer<Plain>& b) { return b.out(); }',
        });
        try {
            const index = idx(dir);
            const result = index.context('out', { file: 'a.hpp', line: 7 });
            assert.equal(result.callers.length + result.unverifiedCallers.length, 0);
        } finally { rm(dir); }
    });

    it('member types the standard library reads by name block their rename', () => {
        const dir = tmp({
            'it.hpp': '#pragma once\n#include <cstddef>\nclass node_iterator {\npublic:\n    typedef std::ptrdiff_t difference_type;\n    typedef int value_type;\n    typedef int& reference;\n    node_iterator(int* p) : p_(p) {}\n    reference operator*() const { return *p_; }\n    int& reference_of() { return *p_; }\nprivate:\n    int* p_;\n};',
        });
        try {
            const index = idx(dir);
            const blocked = execute(index, 'plan', { name: 'it.hpp:7:reference', renameTo: 'refZ' });
            assert.ok(blocked.ok, blocked.error);
            assert.equal(blocked.result.changes.filter(c => !c.needsReview).length, 0);
            assert.ok(blocked.result.changes.some(c => c.needsReview && c.reviewReason === 'language-protocol-member'));
            const ordinary = execute(index, 'plan', { name: 'it.hpp:10:reference_of', renameTo: 'refOf' });
            assert.ok(ordinary.ok, ordinary.error);
            assert.ok(ordinary.result.changes.some(c => !c.needsReview && c.isDefinition));
        } finally { rm(dir); }
    });

    it('a deduction guide is no function; the class rename edits its name', () => {
        const dir = tmp({
            'a.hpp': '#pragma once\ntemplate<typename... Func>\nstruct overloaded: Func... {\n    using Func::operator()...;\n};\ntemplate<typename... Func>\noverloaded(Func...) -> overloaded<Func...>;\ntemplate<typename T>\nstruct Box {\n    Box(T v) : value(v) {}\n    T value;\n};\nBox(const char *) -> Box<int>;',
            'main.cpp': '#include "a.hpp"\nint main() {\n    overloaded func{[](int) {}, [](double) {}};\n    func(1);\n    Box b{3};\n    return b.value;\n}',
        });
        try {
            const index = idx(dir);
            assert.deepEqual((index.symbols.get('overloaded') || []).map(d => d.type), ['struct']);
            assert.ok(!(index.symbols.get('Box') || []).some(d => d.type === 'function'));
            for (const [handle, line, renamed] of [['a.hpp:3:overloaded', 7, 'ovZ(Func...) -> ovZ<Func...>;'],
                ['a.hpp:9:Box', 13, 'BoxZ(const char *) -> BoxZ<int>;']]) {
                const plan = execute(index, 'plan', { name: handle, renameTo: renamed.match(/^\w+/)[0] });
                assert.ok(plan.ok, plan.error);
                const guide = plan.result.changes.find(c => c.file === 'a.hpp' && c.line === line);
                assert.ok(guide && !guide.needsReview);
                assert.equal(guide.newExpression.trim(), renamed);
            }
        } finally { rm(dir); }
    });

    it('a local declared with decltype of a variable has its declared type; other decltypes stay untyped', () => {
        const dir = tmp({
            'a.hpp': 'template<typename T>\nstruct sigh {\n    void swap(sigh &other) noexcept {}\n};\nstruct other { void swap(other &o) {} };\ninline sigh<int> make();',
            't.cpp': '#include "a.hpp"\nvoid run() {\n    sigh<int> s{};\n    decltype(s) copy{s};\n    decltype(s) move{};\n    copy.swap(move);\n    decltype(auto) alias = s;\n    alias.swap(move);\n    decltype(make()) made;\n    made.swap(move);\n    other o1, o2;\n    o1.swap(o2);\n}',
        });
        try {
            const index = idx(dir);
            const result = index.context('swap', { file: 'a.hpp', line: 3 });
            assert.deepEqual(callerLines(result), ['t.cpp:6']);
            assert.deepEqual(result.unverifiedCallers.map(c => c.line).sort((a, b) => a - b), [8, 10]);
            assert.equal(result.meta.account.excluded.byReason['receiver-type-mismatch']?.count || 0, 1);
            assert.equal(result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('a pointer-to-member parameter declares no callable of the return type', () => {
        const dir = tmp({
            'b.hpp': '\ntemplate<typename Ret, typename... Args>\nauto function_pointer(Ret (*)(Args...)) -> Ret (*)(Args...);\n\ntemplate<typename Class, typename Ret, typename... Args, typename... Other>\nauto function_pointer(Ret (Class::*)(Args...), Other &&...) -> Ret (*)(Args...);\n\ntemplate<typename Class, typename Ret, typename... Args, typename... Other>\nauto function_pointer(Ret (Class::*)(Args...) const, Other &&...) -> Ret (*)(Args...);\n\ntemplate<typename Class, typename Ret, typename... Args>\nstruct picker { static int pick_up(Ret (Class::*)(Args...)); };',
        });
        try {
            const index = idx(dir);
            assert.equal((index.symbols.get('Ret') || []).filter(d => d.type === 'function').length, 0);
            const overloads = (index.symbols.get('function_pointer') || []).map(d => `${d.startLine}:${d.params}`);
            assert.deepEqual(overloads, ['2:Ret (*)(Args...)', '5:Ret (Class::*)(Args...), Other &&...',
                '8:Ret (Class::*)(Args...) const, Other &&...']);
            assert.deepEqual(index.symbols.get('pick_up').map(d => d.paramsStructured.map(p => p.name)),
                [['Ret (Class::*)(Args...)']]);
        } finally { rm(dir); }
    });

    it('C: a macro invocation followed by a body defines the function its expansion names', () => {
        const dir = tmp({
            'p.h': '#ifndef P_H\n#define P_H\n#include <stdbool.h>\n#define DEF_PRIMITIVE(name) static bool prim_##name(int* vm, int* args)\nbool validate(int* vm);\n#endif',
            'core.c': '#include "p.h"\nbool validate(int* vm) { return vm != 0; }\nDEF_PRIMITIVE(object_not)\n{\n  return validate(vm);\n}\nDEF_PRIMITIVE(object_eq) { return validate(args); }\nUNKNOWN_WRAPPER(object_ne) { return validate(args); }',
        });
        try {
            const index = idx(dir);
            const generated = index.symbols.get('prim_object_not')?.[0];
            assert.ok(generated, 'the expansion names the function');
            assert.deepEqual(generated.paramsStructured.map(p => p.name), ['vm', 'args']);
            assert.ok(generated.modifiers.includes('static'));
            assert.ok(index.symbols.get('prim_object_eq'));
            assert.ok(index.symbols.get('object_ne'), 'an unknown macro names the body from its arguments');
            const result = index.context('validate', { file: 'core.c', line: 2 });
            assert.deepEqual(result.callers.map(c => `${c.line}:${c.callerName}`).sort(),
                ['5:prim_object_not', '7:prim_object_eq', '8:object_ne']);
            const plan = execute(index, 'plan', { name: 'core.c:3:prim_object_not', renameTo: 'prim_negate' });
            assert.ok(plan.ok, plan.error);
            assert.equal(plan.result.changes.filter(c => !c.needsReview).length, 0);
        } finally { rm(dir); }
    });

    it('statement macros a configuration reads as try/catch and another as if keep the class body', () => {
        const dir = tmp({
            'src/config.h': '#pragma once\n#if defined(__cpp_exceptions) && !defined(LIB_NO_EXCEPTION)\n#    define LIB_THROW throw\n#    define LIB_TRY try\n#    define LIB_CATCH catch(...)\n#else\n#    define LIB_THROW\n#    define LIB_TRY if(true)\n#    define LIB_CATCH if(false)\n#endif',
            'src/storage.hpp': '#pragma once\n#include "config.h"\ntemplate<typename Type>\nclass basic_storage {\npublic:\n    void shrink(int sz) {\n        LIB_TRY {\n            grow(sz);\n        }\n        LIB_CATCH {\n            reset();\n            LIB_THROW;\n        }\n    }\n    void grow(int) {}\n    void reset() {}\n    int emplace(int v) { return v; }\n};',
        });
        try {
            const index = idx(dir);
            const emplace = index.symbols.get('emplace')[0];
            assert.equal(emplace.className, 'basic_storage');
            const result = index.context('grow', { file: 'src/storage.hpp', line: 15 });
            assert.deepEqual(callerLines(result), ['src/storage.hpp:8']);
        } finally { rm(dir); }
    });

    it('a parenthesized typedef name before a parenthesized operand is a cast, not a call', () => {
        const dir = tmp({
            'a.c': 'typedef unsigned char BYTE;\nint twice(int x) { return 2 * x; }\nint use(int v) {\n    BYTE b = (BYTE)(v << 2);\n    BYTE* p = (BYTE*)(&b);\n    return b + *p + (twice)(v);\n}',
            'b.c': '#include "a.c"\nint use2(int v) { return (BYTE)(v >> 1); }\n#define LOW(v) ((BYTE)(v))',
        });
        try {
            const index = idx(dir);
            const byte = index.context('BYTE', { file: 'a.c', line: 1 });
            assert.equal(byte.callers.length + byte.unverifiedCallers.length, 0);
            assert.equal(byte.meta.account.conserved, true);
            const twice = index.context('twice', { file: 'a.c', line: 2 });
            assert.deepEqual(callerLines(twice), ['a.c:6']);
            const callees = calleesOf(index, 'use', 'a.c');
            assert.deepEqual(callees.map(c => c.name), ['twice']);
            // A cast in a replacement list is renamed with the type.
            const plan = execute(index, 'plan', { name: 'a.c:1:BYTE', renameTo: 'OCTET' });
            assert.ok(plan.ok, plan.error);
            const macro = plan.result.changes.find(c => c.file === 'b.c' && c.line === 3);
            assert.ok(macro && !macro.needsReview, 'the replacement-list cast is an edit');
        } finally { rm(dir); }
    });

    it('const and non-const member overloads are chosen by the object\'s constness', () => {
        const dir = tmp({
            'v.hpp': '#pragma once\nstruct Vec {\n    int& at(int i) { return data[i]; }\n    const int& at(int i) const { return data[i]; }\n    int sum() const { return at(0) + this->at(1); }\n    void bump() { at(0)++; }\n    int& get() & { return data[0]; }\n    int get() && { return data[0]; }\n    int data[4];\n};',
            'main.cpp': '#include "v.hpp"\nint use(Vec& v, const Vec& cv, Vec* pv, const Vec* pcv, auto& unknown) {\n    v.at(0) = 1;\n    pv->at(2) = 3;\n    int r = cv.at(0);\n    r += pcv->at(1);\n    r += unknown.at(2);\n    return r + v.get();\n}',
        });
        try {
            const index = idx(dir);
            const mutable = index.context('at', { file: 'v.hpp', line: 3 });
            assert.deepEqual(callerLines(mutable), ['main.cpp:3', 'main.cpp:4', 'v.hpp:6']);
            const constant = index.context('at', { file: 'v.hpp', line: 4 });
            assert.deepEqual(callerLines(constant), ['main.cpp:5', 'main.cpp:6', 'v.hpp:5', 'v.hpp:5']);
            assert.ok(unverifiedLines(constant).some(line => line.startsWith('main.cpp:7:')), 'an undecided object stays a review');
            const getter = index.context('get', { file: 'v.hpp', line: 7 });
            assert.ok(unverifiedLines(getter).some(line => line.startsWith('main.cpp:8:')), 'ref-qualified overloads stay undecided');
            const callees = calleesOf(index, 'sum', 'v.hpp');
            assert.deepEqual(callees.map(c => `${c.name}:${c.startLine}`), ['at:4']);
        } finally { rm(dir); }
    });

    it('a typedef of a function type renames its declaration with its uses', () => {
        const dir = tmp({
            'api.h': 'typedef int read_handler_t(void *data, unsigned char *buffer);\nstruct parser { read_handler_t *handler; };\nvoid set_input(struct parser *p, read_handler_t *handler);',
        });
        try {
            const index = idx(dir);
            const plan = execute(index, 'plan', { name: 'api.h:1:read_handler_t', renameTo: 'input_handler_t' });
            assert.ok(plan.ok, plan.error);
            assert.deepEqual(plan.result.changes.filter(c => !c.needsReview).map(c => c.line).sort((a, b) => a - b), [1, 2, 3]);
        } finally { rm(dir); }
    });

    it('a local variable hides a type name in a declaration that passes it', () => {
        const dir = tmp({
            'a.hpp': '#pragma once\ntemplate <typename... T> struct store {};\ntemplate <typename... T>\nusing vargs = store<T...>;\nstruct ctx_t { ctx_t(int, const store<int>&) {} };\ninline int use(int out) {\n    const auto& vargs = store<int>{};\n    ctx_t ctx(out, vargs);\n    return 0;\n}\ninline vargs<int> make(int out) { ctx_t ctx(out, vargs<int>{}); return {}; }',
        });
        try {
            const index = idx(dir);
            const plan = execute(index, 'plan', { name: 'a.hpp:4:vargs', renameTo: 'args_t' });
            assert.ok(plan.ok, plan.error);
            assert.deepEqual(plan.result.changes.filter(c => !c.needsReview).map(c => c.line).sort((a, b) => a - b), [4, 11]);
        } finally { rm(dir); }
    });

    it('sequential, two-worker and cache builds record the same declarations and receivers', () => {
        const { ProjectIndex } = require('../core/project');
        const dir = tmp({
            'p.h': '#ifndef P_H\n#define P_H\n#define DEF_PRIMITIVE(name) static int prim_##name(int* vm)\n#endif',
            'core.c': '#include "p.h"\ntypedef int I;\nDEF_PRIMITIVE(object_not) { return *vm; }\nstatic int helper(int);\nint helper(int x) { return (I)(x); }',
            'v.hpp': '#pragma once\n#include <memory>\nstruct Vec { int& at(int i); const int& at(int i) const; int get() &; };\nstruct Holder { std::unique_ptr<Vec> p; int run() { return p->at(1); } };\ntemplate<typename C, typename R> int pick(R (C::*)(int));',
            'use.cpp': '#include "v.hpp"\nint use(const Vec& cv) { decltype(cv) copy = cv; return copy.at(0) + cv.at(1); }',
        });
        try {
            const symbols = index => [...index.files.values()].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
                .map(entry => JSON.stringify(entry.symbols.map(sym => [sym.name, sym.type, sym.startLine, sym.params,
                    sym.modifiers, sym.memberConst, sym.refQualifier, sym.generatedByMacro])));
            const records = index => [...index.files.keys()].sort().map(file => JSON.stringify(index.getCachedCalls(file)));
            const sequential = new ProjectIndex(dir); sequential.build(null, { quiet: true, workers: 0 });
            const parallel = new ProjectIndex(dir); parallel.build(null, { quiet: true, workers: 2 });
            assert.deepStrictEqual(symbols(parallel), symbols(sequential));
            assert.deepStrictEqual(records(parallel), records(sequential));
            const all = symbols(sequential).join('\n') + records(sequential).join('\n');
            for (const fact of ['prim_object_not', '"receiverFieldArrow":true', '"receiverConst":true',
                '"parenthesizedCallee":true', 'R (C::*)(int)']) {
                assert.ok(all.includes(fact), fact);
            }
            const { saveCache, loadCache } = require('../core/cache');
            const cachePath = path.join(dir, '.cache-427', 'index.json');
            saveCache(sequential, cachePath);
            const loaded = new ProjectIndex(dir);
            assert.ok(loadCache(loaded, cachePath));
            assert.deepStrictEqual(symbols(loaded), symbols(sequential));
            assert.deepStrictEqual(records(loaded), records(sequential));
        } finally { rm(dir); }
    });
});

describe('fix #431: C++ accesses in macro-generated scopes and qualified template-ids', () => {
    it('keeps bare names of a fixture macro body visible for the fixture class an argument names', () => {
        const dir = tmp({
            'fixture.cc': [
                '#define TEST_F(fixture, name) void fixture##_##name##_Test()',
                'class Base {',
                ' protected:',
                '  static int n4_;',
                '};',
                'int Base::n4_;',
                'class Other {',
                ' protected:',
                '  static int n4_;',
                '};',
                'typedef Base BaseTest;',
                'TEST_F(BaseTest, Counts) {',
                '  ++n4_;',
                '}',
                'TEST_F(Other, Counts) {',
                '  ++n4_;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const band = index.impact('n4_', { file: 'fixture.cc', line: 4 }).valueAccesses;
            assert.deepStrictEqual(band.unverifiedSites.filter(site => site.line > 6)
                .map(site => `${site.line}:${site.reason}`), ['13:macro-generated-scope']);
            assert.ok(!band.byFile.some(group => group.sites.some(site => site.line === 16)));
        } finally { rm(dir); }
    });

    it('qualifies a template-id by its scope: `ns::v<T>` reads `ns::v`', () => {
        const dir = tmp({
            'v.hpp': [
                'namespace app {',
                'namespace internal {',
                'template<typename... T>',
                'inline constexpr bool check_v = sizeof...(T) == 1;',
                '}',
                'template<typename... T>',
                'bool run() {',
                '  if (internal::check_v<T...> || false) return true;',
                '  return false;',
                '}',
                '}',
                'namespace other { template<typename T> inline constexpr bool check_v = false; }',
                'bool g() { return other::check_v<int>; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const band = index.impact('check_v', { file: 'v.hpp', line: 4 }).valueAccesses;
            assert.deepStrictEqual(band.byFile.flatMap(group => group.sites.map(site => site.line)), [8]);
            assert.ok(!band.unverifiedSites.some(site => site.line === 13), JSON.stringify(band.unverifiedSites));
        } finally { rm(dir); }
    });
});

describe('fix #437: generic C# constructor delegations keep type identity', () => {
    it('retains nested generic constructions as review and nested annotation test links', () => {
        const dir = tmp({
            'Nested.cs': 'namespace N {\n public class Outer<T> { public class Inner<V> { public Inner() {} } }\n}\nnamespace Other {\n public class Outer { public class Inner<V> { public Inner() {} } }\n}\n',
            'NestedTests.cs': 'using Other;\nclass NestedTests {\n object Make() => new N.Outer<int>.Inner<string>();\n void Accept(N.Outer<int>.Inner<string> value) {}\n}\n',
        });
        try {
            const index = idx(dir);
            const calls = index.getCachedCalls(path.join(dir, 'NestedTests.cs'));
            const construction = calls.find(call => call.isConstructor);
            assert.strictEqual(construction.name, 'Inner');
            assert.strictEqual(construction.constructorQualifier, 'N.Outer<int>');
            assert.strictEqual(construction.typeArgs, 1);
            for (const line of [2, 5]) {
                const context = index.context('Inner', { file: 'Nested.cs', line });
                assert.deepStrictEqual(context.callers, []);
                assert.ok(context.unverifiedCallers.some(call => call.relativePath === 'NestedTests.cs' && call.line === 3));
            }
            const { execute } = require('../core/execute');
            const tests = execute(index, 'tests', { name: 'Nested.cs:2:Inner' });
            assert.strictEqual(tests.ok, true);
            assert.ok(tests.result.some(file => file.file === 'NestedTests.cs' && file.matches.some(match => match.line === 4)));
        } finally { rm(dir); }
    });

    it('this and base initializers reach the right arity across partial declarations and cache histories', () => {
        const files = {
            'A.cs': 'namespace N;\npublic partial class Box<T> {\n public Box() : this(1) {}\n public Box(int n) {}\n}\n',
            'B.cs': 'namespace N;\npublic partial class Box<T> { public int Value => 1; }\n',
            'C.cs': 'namespace N;\npublic class Box { public Box(int n) {} }\n',
            'D.cs': 'namespace N;\npublic class Child : Box<int> {\n public Child() : base(2) {}\n}\n',
            'E.cs': 'namespace Other;\npublic class Box<T> { public Box(int n) {} }\n',
        };
        for (let n = 0; n < 101; n++) files[`padding/${n}.cs`] = `class Padding${n} {}`;
        const dir = tmp(files);
        try {
            const { ProjectIndex } = require('../core/project');
            const check = index => {
                for (const file of ['A.cs', 'B.cs']) {
                    const result = index.context('Box', { file, line: 2 });
                    assert.deepStrictEqual(result.callers.map(call => [call.relativePath, call.line]),
                        [['A.cs', 3], ['D.cs', 3]]);
                    assert.strictEqual(result.meta.account.conserved, true);
                }
                for (const file of ['C.cs', 'E.cs']) {
                    const result = index.context('Box', { file, line: 2 });
                    assert.deepStrictEqual(result.callers, []);
                }
                return ['A.cs', 'D.cs'].map(file => index.getCachedCalls(path.join(dir, file))
                    .filter(call => call.constructorSyntax === 'delegation'));
            };
            const sequential = new ProjectIndex(dir);
            sequential.build(null, { quiet: true, workers: 0 });
            const records = check(sequential);
            assert.deepStrictEqual(records.map(calls => calls.map(call => call.typeArgs)), [[1], [1]]);
            const parallel = new ProjectIndex(dir);
            parallel.build(null, { quiet: true, workers: 2 });
            assert.deepStrictEqual(check(parallel), records);
            parallel.saveCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(check(loaded), records);
        } finally { rm(dir); }
    });
});

describe('C# enclosing namespace receivers and nested generic locals', () => {
    it('looks up the first namespace segment from the nearest scope and respects member shadows', () => {
        const dir = tmp({
            'Types.cs': [
                'namespace N.Tools { public class Helper { public static void Make() {} public static void Build() {} } }',
                'namespace Tools { public class Helper { public static void Make() {} } }',
                'namespace N.Inner.Tools { public class Helper { public static void Make() {} } }',
                'namespace N.Types { public class Holder { public Helper Helper; }',
                'public class Helper { public void Make() {} } }',
            ].join('\n'),
            'Calls.cs': [
                'namespace N.Tests { class Client { void Run() { Tools.Helper.Make(); Tools.Helper.Build(); } } }',
                'namespace N.Inner.Tests { class Client { void Run() { Tools.Helper.Make(); } } }',
                'namespace N.Tests { class Shadow { N.Types.Holder Tools;',
                'void Run() { Tools.Helper.Make(); }',
                'void Explicit() { this.Tools.Helper.Make(); } } }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const [line, expected] of [[1, [1]], [2, []], [3, [2]], [5, [4, 5]]]) {
                const result = index.context('Make', { file: 'Types.cs', line });
                if (line === 5) assert.deepStrictEqual(result.callers.map(call => call.line), expected);
                else {
                    // Competing same-named owners can remain undecided, but
                    // cannot confirm one another or lose the actual call.
                    assert.ok(result.callers.every(call => expected.includes(call.line)));
                    const visible = [...result.callers, ...result.unverifiedCallers].map(call => call.line);
                    assert.ok(expected.every(site => visible.includes(site)));
                }
                assert.ok(result.meta.account.conserved);
            }
            assert.deepStrictEqual(index.context('Build', { file: 'Types.cs', line: 1 }).callers.map(call => call.line), [1]);
        } finally { rm(dir); }
    });

    it('retains the terminal declared type for parameters, casts, locals and out declarations', () => {
        const dir = tmp({
            'Types.cs': 'namespace N;\nclass Outer<T> { public class Inner { public void Run() {} } }\n' +
                'class Outer { public class Inner { public void Run() {} } }\n',
            'Calls.cs': [
                'namespace N;',
                'class Client {',
                'void Make(out Outer<int>.Inner value) { value = new Outer<int>.Inner(); }',
                'void Use(Outer<int>.Inner parameter, object obj) {',
                ' parameter.Run();',
                ' Make(out Outer<int>.Inner super);',
                ' super.Run();',
                ' ((Outer<int>.Inner)obj).Run();',
                ' Outer<int>.Inner assigned = parameter;',
                ' assigned.Run();',
                '} }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const line of [2, 3]) {
                const result = index.context('Run', { file: 'Types.cs', line });
                assert.deepStrictEqual(result.callers, []);
                assert.deepStrictEqual(result.unverifiedCallers.map(call => call.line), [5, 7, 8, 10]);
                assert.ok(result.meta.account.conserved);
            }
            const records = index.getCachedCalls(path.join(dir, 'Calls.cs')).filter(call => call.name === 'Run');
            assert.ok(records.every(call => call.receiverType === 'Inner' &&
                call.receiverTypeNamespace === 'Outer<int>' && !call.receiverFields));
        } finally { rm(dir); }
    });
});

describe('ordinary variables named super use their declared receiver type', () => {
    for (const [file, source] of [
        ['a.cs', 'class Target { public void Run() {} }\nclass Client { void Use(Target super) { super.Run(); } }'],
        ['a.cpp', 'struct Target { void Run() {} };\nstruct Client { void Use(Target super) { super.Run(); } };'],
        ['a.go', 'package main\ntype Target struct{}\nfunc (t Target) Run() {}\nfunc Use(super Target) { super.Run() }'],
    ]) {
        it(file, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir);
                const result = index.context('Run');
                const line = source.split('\n').length;
                assert.ok([...result.callers, ...result.unverifiedCallers].some(call => call.line === line));
                const down = index.context('Use');
                assert.ok(down.callees.some(call => call.name === 'Run') ||
                    down.unverifiedCallees?.some(call => call.name === 'Run'));
                assert.ok(result.meta.account.conserved);
            } finally { rm(dir); }
        });
    }
});

describe('fix #434: C++ auto locals deduce the type of the object they copy, reference or point at', () => {
    it('types auto copies, references and &object pointers as receivers', () => {
        const dir = tmp({
            'a.cpp': [
                'struct A { int m() { return 1; } };',
                'struct B { int m() { return 2; } };',
                '',
                'int f() {',
                '    B b;',
                '    auto x = b;',
                '    auto &r = b;',
                '    const auto *p = &b;',
                '    return x.m() + r.m() + p->m();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'show', { name: 'a.cpp:2:m', sections: 'callers' });
            assert.ok(r.ok, r.error);
            const ctx = r.result.context || r.result;
            assert.strictEqual((ctx.callers || []).filter(c => c.line === 9).length, 3, JSON.stringify(ctx.unverifiedCallers));
            const other = execute(index, 'show', { name: 'a.cpp:1:m', sections: 'callers' });
            const otherCtx = other.result.context || other.result;
            assert.strictEqual((otherCtx.callers || []).length, 0);
        } finally { rm(dir); }
    });
});

describe('fix #436: a header\'s grammar is its indexed language, whatever the process directory', () => {
    const { execFileSync } = require('child_process');
    const cli = path.join(__dirname, '..', 'cli', 'index.js');
    const header = 'namespace geo {\nclass Box {\npublic:\n' +
        '    int total(const std::vector<int>& values) const {\n        int sum = 0;\n' +
        '        for (auto v : values) {\n            if (v > 0) { sum += v; }\n        }\n' +
        '        try { check(sum); } catch (...) { return -1; }\n        return sum;\n    }\n' +
        '    void check(int) const;\n};\n}\n';
    const source = '#include "box.h"\nvoid geo::Box::check(int) const {}\n' +
        'int main() { geo::Box b; return b.total({1, 2}); }\n';
    const showFrom = (cwd, root, handle) => execFileSync('node',
        [cli, root, 'show', handle, '--no-cache', '--json'],
        { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

    it('cpp: show answers the same from the project root and from another directory', () => {
        // lib/box.cpp beside the header decides C++; a header elsewhere is
        // decided by the project's translation units. Both are C++ in the index.
        const dir = tmp({ 'lib/box.h': header, 'lib/box.cpp': source,
            'include/geo/box.h': header, 'src/use.cpp': source.replace('"box.h"', '"geo/box.h"') });
        const elsewhere = tmp({ 'README.md': 'unrelated\n' });
        try {
            for (const handle of ['lib/box.h:4:total', 'include/geo/box.h:4:total']) {
                const inside = showFrom(dir, dir, handle);
                const outside = showFrom(elsewhere, dir, handle);
                assert.strictEqual(outside, inside, `${handle}: identical output from both directories`);
                const summary = JSON.parse(inside).data.summary;
                assert.strictEqual(summary.symbol.language, 'cpp', handle);
                assert.strictEqual(summary.complexity.measuredBy, 'tree-sitter-ast', handle);
                assert.strictEqual(summary.complexity.branches, 3, handle);
            }
            // In process, from this test's own directory (outside the project).
            const index = idx(dir);
            assert.strictEqual(index.languageOf('include/geo/box.h'), 'cpp');
            assert.strictEqual(index.languageOf(path.join(dir, 'lib/box.h')), 'cpp');
            const { brief } = require('../core/brief');
            assert.strictEqual(brief(index, 'total', { file: 'include/geo/box.h' }).symbol.language, 'cpp');
        } finally { rm(dir); rm(elsewhere); }
    });

    it('c: a C header keeps the C grammar from every directory', () => {
        const dir = tmp({ 'lib/sum.h': 'static int sum(int a, int b) {\n    if (a > b) { return a; }\n    return a + b;\n}\n',
            'lib/sum.c': '#include "sum.h"\nint main(void) { return sum(1, 2); }\n' });
        const elsewhere = tmp({ 'README.md': 'unrelated\n' });
        try {
            const inside = showFrom(dir, dir, 'lib/sum.h:1:sum');
            assert.strictEqual(showFrom(elsewhere, dir, 'lib/sum.h:1:sum'), inside);
            assert.strictEqual(JSON.parse(inside).data.summary.symbol.language, 'c');
        } finally { rm(dir); rm(elsewhere); }
    });
});

describe('fix #476: template calls inside ambiguous direct initializers', () => {
    for (const argument of ['int', 'Pair<int, int>']) {
        it(`retains factory<${argument}>() on both sides of a call graph`, () => {
            const dir = tmp({
                'factory.h': 'template<class A, class B> struct Pair {};\ntemplate<class T> int factory() { return 1; }\n',
                'use.cpp': '#include "factory.h"\nstruct Box { explicit Box(int); };\nvoid use() {\n Box value(factory<' + argument + '>());\n}\n',
            });
            try {
                const index = idx(dir);
                const callers = index.context('factory', { file: 'factory.h' });
                assert.ok([...callers.callers, ...callers.unverifiedCallers].some(call => call.line === 4 && path.basename(call.file) === 'use.cpp'));
                const body = index.context('use', { file: 'use.cpp' });
                assert.ok([...body.callees, ...body.unverifiedCallees].some(call => call.name === 'factory'));
            } finally { rm(dir); }
        });
    }

    it('a class-template parameter declares a function instead of invoking the type', () => {
        const dir = tmp({ 'use.cpp': 'template<class T> struct Tag {};\nstruct Box {};\nvoid use() {\n Box declaration(Tag<int>());\n}\n' });
        try {
            const index = idx(dir), body = index.context('use', { file: 'use.cpp' });
            assert.ok(![...body.callees, ...body.unverifiedCallees].some(call => call.name === 'Tag'));
        } finally { rm(dir); }
    });

    it('an enclosing template-template parameter does not invoke a same-named project function', () => {
        const dir = tmp({ 'use.cpp': 'template<class T> int factory() { return 1; }\nstruct Box {};\ntemplate<template<class> class factory> void use() {\n Box declaration(factory<int>());\n}\n' });
        try {
            const index = idx(dir), callers = index.context('factory', { file: 'use.cpp', line: 1 });
            assert.ok(![...callers.callers, ...callers.unverifiedCallers].some(call => call.line === 4));
        } finally { rm(dir); }
    });
});
