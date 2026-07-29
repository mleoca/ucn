'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    multisetDifference,
    compareMultiset,
    compareStructured,
    evaluateConsistencySummary,
} = require('../eval/consistency-gate-policy');
const {
    consistencyBoard,
    evaluateProject,
} = require('../eval/run-consistency-eval');
const { idx, tmp, rm } = require('./helpers');

describe('cross-command consistency gate policy', () => {
    it('compares repeated site claims as a multiset', () => {
        assert.deepStrictEqual(
            multisetDifference(['a:1', 'a:1', 'b:2'], ['a:1', 'b:2']),
            { onlyLeft: ['a:1'], onlyRight: [] });
        const witness = compareMultiset(
            'confirmed-callers', 'show', ['a:1', 'a:1'],
            'impact', ['a:1']);
        assert.strictEqual(witness.leftCount, 2);
        assert.deepStrictEqual(witness.onlyIn.show, ['a:1']);
    });

    it('normalizes object key order but preserves semantic value differences', () => {
        assert.strictEqual(compareStructured(
            'account', 'show', { confirmed: 1, excluded: { b: 2, a: 1 } },
            'impact', { excluded: { a: 1, b: 2 }, confirmed: 1 }), null);
        assert.ok(compareStructured(
            'account', 'show', { confirmed: 1 },
            'impact', { confirmed: 0 }));
    });

    it('fails closed on an empty, incomplete, errored, or disagreeing board', () => {
        const verdict = evaluateConsistencySummary({
            sampledSymbols: 0,
            parseFailures: 1,
            commandErrors: 2,
            disagreements: 3,
        });
        assert.strictEqual(verdict.failures.length, 4);
        assert.match(verdict.failures.join('\n'), /no symbols/);
        assert.match(verdict.failures.join('\n'), /parse failure/);
        assert.match(verdict.failures.join('\n'), /execution error/);
        assert.match(verdict.failures.join('\n'), /disagreement/);
    });
});

describe('deterministic disagreement evaluation', () => {
    it('selects the same stratified stable-handle board on every run', () => {
        const dir = tmp({
            'package.json': '{"name":"consistency-board"}',
            'src/a.js': [
                'function run() { return 1; }',
                'class A { run() { return 2; } }',
                'module.exports = { run, A };',
            ].join('\n'),
            'test/a.test.js': [
                'const { run } = require("../src/a");',
                'function testRun() { return run(); }',
                'test("run", testRun);',
            ].join('\n'),
            'pkg/main.py': 'def execute():\n    return 1\n',
        });
        try {
            const index = idx(dir);
            const first = consistencyBoard(index, 10);
            const second = consistencyBoard(index, 10);
            assert.deepStrictEqual(
                first.board.map(row => row.handle),
                second.board.map(row => row.handle));
            assert.ok(first.strata >= 3);
            assert.ok(first.board.some(row => row.stratum.startsWith('python:')));
            assert.ok(first.board.some(row => row.stratum.includes(':test')));
        } finally { rm(dir); }
    });

    it('pins same-name wrapper/module and same-file definitions', () => {
        const dir = tmp({
            'package.json': '{"name":"consistency-wrapper"}',
            'search.js': [
                'function usages(index, name) { return [index, name]; }',
                'module.exports = { usages };',
            ].join('\n'),
            'project.js': [
                'const searchModule = require("./search");',
                'function usages() { return "local"; }',
                'class ProjectIndex {',
                '  usages(name) { return searchModule.usages(this, name); }',
                '}',
                'module.exports = { ProjectIndex, usages };',
            ].join('\n'),
        });
        try {
            const result = evaluateProject(dir, { name: 'wrapper-fixture' }, 20);
            assert.ok(result.sampledSymbols >= 2);
            assert.strictEqual(result.comparisons, result.sampledSymbols * 20);
            assert.deepStrictEqual(result.failures, [],
                JSON.stringify(result.witnesses, null, 2));
            assert.strictEqual(result.disagreements, 0,
                JSON.stringify(result.witnesses, null, 2));
        } finally { rm(dir); }
    });

    it('cross-checks every supported source family', () => {
        const dir = tmp({
            'package.json': '{"name":"consistency-languages"}',
            'javascript.js': [
                'function javascriptTarget() { return 1; }',
                'function javascriptCaller() { return javascriptTarget(); }',
            ].join('\n'),
            'typescript.ts': [
                'function typescriptTarget(): number { return 1; }',
                'function typescriptCaller(): number { return typescriptTarget(); }',
            ].join('\n'),
            'component.tsx': [
                'function tsxTarget(): number { return 1; }',
                'function TsxCaller() { tsxTarget(); return <div />; }',
            ].join('\n'),
            'python.py': [
                'def python_target():',
                '    return 1',
                'def python_caller():',
                '    return python_target()',
            ].join('\n'),
            'go.go': [
                'package mixed',
                'func GoTarget() int { return 1 }',
                'func GoCaller() int { return GoTarget() }',
            ].join('\n'),
            'rust.rs': [
                'fn rust_target() -> i32 { 1 }',
                'fn rust_caller() -> i32 { rust_target() }',
            ].join('\n'),
            'JavaSample.java': [
                'class JavaSample {',
                '  static int javaTarget() { return 1; }',
                '  static int javaCaller() { return javaTarget(); }',
                '}',
            ].join('\n'),
            'c.c': [
                'int c_target(void) { return 1; }',
                'int c_caller(void) { return c_target(); }',
            ].join('\n'),
            'cpp.cpp': [
                'int cpp_target() { return 1; }',
                'int cpp_caller() { return cpp_target(); }',
            ].join('\n'),
            'CSharpSample.cs': [
                'class CSharpSample {',
                '  static int CSharpTarget() { return 1; }',
                '  static int CSharpCaller() { return CSharpTarget(); }',
                '}',
            ].join('\n'),
            'page.html': [
                '<script>',
                'function htmlTarget() { return 1; }',
                'function htmlCaller() { return htmlTarget(); }',
                '</script>',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const selection = consistencyBoard(index, 200);
            const languages = new Set(selection.board.map(row =>
                row.stratum.split(':')[0]));
            assert.deepStrictEqual([...languages].sort(), [
                'c', 'cpp', 'csharp', 'go', 'html', 'java', 'javascript',
                'python', 'rust', 'tsx', 'typescript',
            ]);
            const result = evaluateProject(dir, { name: 'language-fixture' }, 200);
            assert.strictEqual(result.parseFailures, 0);
            assert.strictEqual(result.disagreements, 0,
                JSON.stringify(result.witnesses, null, 2));
            assert.deepStrictEqual(result.failures, [],
                JSON.stringify(result.witnesses, null, 2));
        } finally { rm(dir); }
    });

    it('rejects invalid sample sizes before indexing a repository', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-consistency-eval.js');
        const result = spawnSync(process.execPath, [
            script, '--project', '.', '--sample=0',
        ], { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /positive integer/);
    });
});

describe('entrypoints ↔ endpoints agreement (the finding-4 class)', () => {
    const { execute } = require('../core/execute');

    it('every literal-path server route surfaces in entrypoints with the same framework', () => {
        const dir = tmp({
            'package.json': '{"name":"routes-agreement"}',
            'server.js': [
                "const express = require('express');",
                'const app = express();',
                "app.get('/e', (req, res) => res.send('ok'));",
                "app.post('/named', function createUser(req, res) { res.json({}); });",
                'app.listen(3000);',
            ].join('\n'),
            'api.py': [
                'from fastapi import FastAPI',
                'app = FastAPI()',
                '',
                '@app.get("/g")',
                'def read_g():',
                '    return {"g": 1}',
            ].join('\n'),
            'web.py': [
                'from flask import Flask',
                'app = Flask(__name__)',
                '',
                '@app.route("/")',
                'def home():',
                '    return "hi"',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const endpoints = execute(index, 'endpoints', {});
            const entrypoints = execute(index, 'entrypoints', {});
            assert.ok(endpoints.ok && entrypoints.ok);
            const routes = endpoints.result.routes;
            const httpEntries = entrypoints.result.filter(e => e.type === 'http');
            assert.ok(routes.length >= 4, `expected 4 routes, got ${routes.length}`);
            for (const route of routes) {
                const match = httpEntries.find(e =>
                    (e.name === route.handler || route.handler === '<anonymous>') &&
                    e.file === route.file);
                assert.ok(match,
                    `route ${route.method} ${route.path} (${route.file}) has no entrypoints entry; ` +
                    `entries: ${httpEntries.map(e => `${e.name}@${e.file}:${e.line}`).join(', ')}`);
                assert.strictEqual(match.framework, route.framework,
                    `framework labels must agree for ${route.path}: ` +
                    `endpoints=${route.framework} entrypoints=${match.framework}`);
            }
        } finally { rm(dir); }
    });
});
