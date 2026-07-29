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
            call.receiverType === 'IService'));
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
