'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');

const { execute } = require('../core/execute');
const output = require('../core/output');
const {
    formatSurfaceMessage,
    getCliAcceptedFlags,
} = require('../core/registry');
const { applyOutputBudget } = require('../core/output-budget');
const {
    CLI_PATH,
    tmp,
    rm,
    idx,
} = require('./helpers');

describe('v5 release-surface adversarial regressions', () => {
    it('plan includes the selected declaration and its owned export surface', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/lib.js': [
                'function helper(a, b) { return a + b; }',
                'module.exports = { helper };',
            ].join('\n'),
            'src/main.js': [
                "const { helper } = require('./lib');",
                'helper(1, 2);',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const plan = index.plan('helper', { renameTo: 'addNumbers' });
            assert.equal(plan.found, true);
            assert.ok(plan.changes.some(change =>
                change.isDefinition &&
                change.file === 'src/lib.js' &&
                change.newExpression.includes('function addNumbers')));
            assert.ok(plan.changes.some(change =>
                change.isExport &&
                change.newExpression.includes('{ addNumbers }')));
            assert.ok(plan.changes.some(change => change.isImport));
            assert.ok(plan.changeSummary.definitions >= 1);
            assert.ok(plan.changeSummary.calls >= 1);
            assert.equal(plan.totalChanges, plan.changes.length);
        } finally {
            rm(dir);
        }
    });

    it('parameter plans count the required declaration edit separately', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'function helper(a) { return a; }\nhelper(1);',
        });
        try {
            const index = idx(dir);
            const plan = index.plan('helper', { addParam: 'context' });
            assert.equal(plan.changeSummary.definitions, 1);
            assert.equal(plan.changeSummary.calls, 1);
            assert.equal(plan.totalChanges, 2);
            const declaration = plan.changes.find(change => change.isDefinition);
            assert.equal(declaration.needsReview, true);
            assert.match(declaration.suggestion, /helper\(a, context\)/);
        } finally {
            rm(dir);
        }
    });

    it('usages exposes comments, strings, and docstrings as reachable text', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname="fixture"',
            'app.py': [
                'def build_thing():',
                '    """build_thing is the public workflow."""',
                '    return "build_thing result"',
                '',
                '# Keep build_thing compatible with old clients.',
                'build_thing()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const all = index.usages('build_thing');
            const text = all.filter(usage => usage.usageType === 'text');
            assert.deepEqual(text.map(usage => usage.line), [2, 3, 5]);
            assert.ok(text.every(usage =>
                usage.textKind === 'comment-or-string'));

            const codeOnly = index.usages('build_thing', { codeOnly: true });
            assert.equal(codeOnly.some(usage => usage.usageType === 'text'), false);
            const formatted = output.formatUsages(all, 'build_thing');
            assert.match(formatted, /OTHER TEXT/);
            assert.match(formatted, /app\.py:5/);
        } finally {
            rm(dir);
        }
    });

    it('complexity is AST-derived and invariant to strings and indentation width', () => {
        const dir = tmp({
            'package.json': '{}',
            'clean.ts': [
                'function clean(a?: string, b?: { value?: number }) {',
                '  const prose = "if (x) for (;;) while (x) case value";',
                '  // if (fake) { while (fake) {} }',
                '  return b?.value ?? a?.length ?? 0;',
                '}',
            ].join('\n'),
            'four.py': [
                'def four(xs):',
                '    if xs:',
                '        for x in xs:',
                '            print(x)',
            ].join('\n'),
            'two.py': [
                'def two(xs):',
                '  if xs:',
                '    for x in xs:',
                '      print(x)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const clean = execute(index, 'brief', { name: 'clean' }).result;
            assert.deepEqual(clean.complexity, {
                branches: 0,
                maxDepth: 0,
                lineCount: 5,
                measuredBy: 'tree-sitter-ast',
            });
            const four = execute(index, 'brief', { name: 'four' }).result.complexity;
            const two = execute(index, 'brief', { name: 'two' }).result.complexity;
            assert.equal(four.branches, 2);
            assert.equal(two.branches, 2);
            assert.equal(four.maxDepth, 2);
            assert.equal(two.maxDepth, 2);
        } finally {
            rm(dir);
        }
    });

    it('computed dispatch lowers semantic confidence and shields registry members', () => {
        const dir = tmp({
            'package.json': '{}',
            'index.js': [
                'const handlers = {',
                '  dynamicOnly() { return 1; },',
                '  computedName() { return 2; },',
                '};',
                'handlers[NAME]();',
                'handlers[currentMethod]();',
            ].join('\n'),
            'dispatch.py': [
                'handlers = {}',
                'handlers[name]()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const health = execute(index, 'doctor', { deep: true }).result;
            assert.equal(health.blindSpots.computedDispatch.count, 3);
            assert.equal(health.dimensions.semanticRecall.level, 'REVIEW');

            const candidates = index.deadcode({ includeExported: true });
            assert.equal(candidates.some(candidate =>
                ['dynamicOnly', 'computedName'].includes(candidate.name)), false);
            assert.equal(candidates.excludedDynamicDispatch, 2);
            assert.equal(candidates.computedDispatch.count, 3);
            const text = output.formatDeadcode(candidates);
            assert.match(text, /computed dispatch/i);
        } finally {
            rm(dir);
        }
    });

    it('computed-dispatch diagnostics refresh after an incremental rebuild', () => {
        const dir = tmp({
            'package.json': '{}',
            'index.js': [
                'const handlers = { hidden() {} };',
                'handlers.hidden();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const initial = execute(index, 'doctor', { deep: true }).result;
            assert.equal(initial.blindSpots.computedDispatch.count, 0);

            fs.writeFileSync(`${dir}/index.js`, [
                'const handlers = { hidden() {} };',
                'handlers[key]();',
            ].join('\n'));
            index.build(null, {
                forceRebuild: true,
                quiet: true,
                workers: 0,
            });
            const added = execute(index, 'doctor', { deep: true }).result;
            assert.equal(added.blindSpots.computedDispatch.count, 1);
            assert.equal(
                index.deadcode({ includeExported: true })
                    .some(candidate => candidate.name === 'hidden'),
                false,
            );

            fs.writeFileSync(`${dir}/index.js`, [
                'const handlers = { hidden() {} };',
                'handlers.hidden();',
            ].join('\n'));
            index.build(null, {
                forceRebuild: true,
                quiet: true,
                workers: 0,
            });
            const removed = execute(index, 'doctor', { deep: true }).result;
            assert.equal(removed.blindSpots.computedDispatch.count, 0);
        } finally {
            rm(dir);
        }
    });

    it('search defaults to literal text and requires explicit regex mode', () => {
        const dir = tmp({
            'package.json': '{}',
            'search.js': [
                'const first = "aab";',
                'const second = "ab";',
                'const exact = "a+b";',
                'const config = config.get;',
                'const lookalike = configXget;',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const literal = index.search('a+b');
            assert.equal(literal.meta.mode, 'literal');
            assert.deepEqual(literal[0].matches.map(match => match.line), [3]);

            const regex = index.search('a+b', { regex: true });
            assert.equal(regex.meta.mode, 'regex');
            assert.deepEqual(regex[0].matches.map(match => match.line), [1, 2]);

            const dotted = index.search('config.get');
            assert.deepEqual(dotted[0].matches.map(match => match.line), [4]);
        } finally {
            rm(dir);
        }
    });

    it('--help lists every accepted CLI flag from the registry', () => {
        const help = execFileSync(process.execPath, [CLI_PATH, '--help'], {
            encoding: 'utf8',
        });
        for (const flag of getCliAcceptedFlags()) {
            assert.ok(help.includes(flag), `${flag} missing from --help`);
        }
        for (const required of [
            '--rename-to', '--max-lines', '--include-exported',
            '--expand-unverified', '--hot', '--unused', '--bridge',
            '--framework', '--min-confidence', '--include-methods',
        ]) {
            assert.ok(help.includes(required), `${required} must be discoverable`);
        }
    });

    it('surface errors and JSON command identity use native spelling', () => {
        const error = 'Plan requires renameTo, add_param, or removeParam.';
        assert.equal(
            formatSurfaceMessage(error, 'cli'),
            'Plan requires --rename-to, --add-param, or --remove-param.',
        );
        assert.equal(
            formatSurfaceMessage(error, 'mcp'),
            'Plan requires rename_to, add_param, or remove_param.',
        );

        const cliJson = JSON.parse(output.formatPublicJson(
            'auditAsync', { issues: [] }, {}, { surface: 'cli' }));
        assert.equal(cliJson.meta.command, 'audit-async');
        assert.equal(cliJson.meta.canonicalCommand, 'auditAsync');
    });

    it('transport truncation never recommends an inapplicable all flag', () => {
        const text = 'x'.repeat(200);
        const search = applyOutputBudget(text, {
            command: 'search',
            maxChars: 20,
            surface: 'cli',
        }).text;
        assert.doesNotMatch(search, /--all/);
        assert.match(search, /--max-chars/);

        // usages and show both support --all (usages gained it with the
        // DEFINITIONS display cap) — the hint must recommend it.
        for (const command of ['usages', 'show']) {
            const hinted = applyOutputBudget(text, {
                command,
                maxChars: 20,
                surface: 'cli',
            }).text;
            assert.match(hinted, /--all/);
        }
    });

    it('detailed repository lists elide pathological identifiers', () => {
        const pathological = `f_${'x'.repeat(3000)}`;
        const dir = tmp({
            'package.json': '{}',
            'a-pathological.js': `function ${pathological}() { return 1; }`,
            'z-legitimate.js': [
                'function alpha() {}',
                'function beta() {}',
                'function gamma() {}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const toc = index.getToc({ detailed: true, all: true });
            const rendered = output.formatToc(toc);
            assert.match(rendered, /\[3004 chars\]/);
            assert.match(rendered, /z-legitimate\.js/);
            assert.match(rendered, /alpha\(\)/);
            assert.ok(rendered.length < 5000);
        } finally {
            rm(dir);
        }
    });

    it('find --json records carry the stable handle', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'function helper(a) { return a; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const execution = execute(index, 'find', { name: 'helper' });
            assert.equal(execution.ok, true);
            const json = JSON.parse(output.formatPublicJson(
                'find', execution.result, { name: 'helper' },
                { ...execution, surface: 'cli' }));
            assert.equal(json.data[0].handle, 'lib.js:1:helper');
        } finally {
            rm(dir);
        }
    });

    it('computed-dispatch metadata survives the public JSON envelope', () => {
        const dir = tmp({
            'package.json': '{}',
            'index.js': [
                'const handlers = { hidden() {} };',
                'handlers[key]();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const execution = execute(index, 'deadcode', {
                includeExported: true,
            });
            assert.equal(execution.ok, true);
            const json = JSON.parse(output.formatPublicJson(
                'deadcode', execution.result, {}, {
                    ...execution,
                    surface: 'cli',
                }));
            assert.equal(json.meta.computedDispatch.count, 1);
            assert.equal(json.meta.deletionSafety, 'review-required');
        } finally {
            rm(dir);
        }
    });
});
