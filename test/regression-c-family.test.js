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

describe('C-family recovery resource and ordering contracts', () => {
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
                member.meta.account.excluded.byReason['arity-mismatch'].count,
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
            assert.deepEqual(global.callers.map(caller => caller.line), [6]);
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

    it('uses C++ literal kinds to select namespace-qualified free overloads', () => {
        const dir = tmp({
            'include/fmt/format.hpp': [
                'namespace fmt {',
                'template <typename... T> struct format_string {};',
                'template <typename... T> struct wformat_string {};',
                'struct locale_ref {};',
                'struct text_style {};',
                'template <typename... T>',
                'void format(format_string<T...> value, T&&... args);',
                'void format(locale_ref value);',
                'void format(text_style value);',
                'template <typename... T>',
                'void format(wformat_string<T...> value, T&&... args);',
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
                'type:text_style',
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
            assert.equal(result.unverifiedCallers.length, 0);
            assert.equal(
                result.meta.account.excluded.byReason['overload-mismatch'].count,
                2,
            );
            assert.equal(result.meta.account.conserved, true);
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
        assert.deepEqual(calls.find(call => call.line === 6), {
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

    it('distinguishes exact C# explicit-this casts from interface dispatch', () => {
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
            assert.deepEqual(result.callers.map(call => call.line), [5]);
            assert.deepEqual(result.unverifiedCallers.map(call => [
                call.line, call.reason, call.dispatchVia,
            ]), [[6, 'possible-dispatch', 'ISink']]);
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
        assert.deepEqual(fn.paramsStructured, [{ name: 'size_t' }, { name: 'b', type: 'int' }]);
        const ptr = result.functions.find(item => item.name === 'takes_ptr');
        assert.deepEqual(ptr.paramsStructured, [{ name: 'void *' }],
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
