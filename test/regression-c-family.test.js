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
            item.paramsStructured[0].type === 'User'));
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
