'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmp, rm, idx } = require('./helpers');
const { RECEIVER_FIXTURES } = require('./helpers/evidence-fixtures');
const { execute } = require('../core/execute');
const { formatContextJson } = require('../core/output');

function targetOf(index, fixture) {
    const target = (index.symbols.get(fixture.method) || []).find(d =>
        d.relativePath === fixture.file && d.className === fixture.owner && (fixture.traitTarget || !d.traitImpl));
    assert.ok(target, `fixture target missing: ${fixture.file}:${fixture.owner}.${fixture.method}`);
    return target;
}

function contextOf(index, target) {
    const result = execute(index, 'context', {
        name: `${target.relativePath}:${target.startLine}:${target.name}`,
    });
    assert.ok(result.ok, result.error);
    return JSON.parse(formatContextJson(result.result));
}

describe('fix #355 review: validation coverage is distinct from a failed proof', () => {
    it('keeps a constructor typed through Python wildcard re-exports report-only', () => {
        const dir = tmp({
            'package/__init__.py': 'from .model import *\n',
            'package/model.py': 'class URL:\n    def join(self, other): return other\n',
            'app.py': 'import package\ndef render():\n    url = package.URL()\n    return url.join("other")\n',
        });
        try {
            const index = idx(dir), target = index.symbols.get('join')[0];
            const callers = index.findCallers('join', { targetDefinitions: [target], collectAccount: true });
            const site = callers.find(c => c.relativePath === 'app.py');
            assert.ok(site, 'unsupported import witness collection cannot demote a typed control');
            assert.equal(site.provenance.validation, 'unsupported');
            assert.equal(site.provenance.rule, 'constructor-typed');
            const callees = index.findCallees(index.symbols.get('render')[0], { collectAccount: true });
            assert.ok(callees.find(c => c.name === 'join'), 'callee placement must also stay report-only');
        } finally { rm(dir); }
    });

    it('keeps external and externally inherited Java mismatch exclusions report-only', () => {
        const dir = tmp({
            'App.java': `import java.util.ArrayList;
class Elements extends ArrayList<String> {}
class Local {
    int size() { return 0; }
    void append(String value) {}
}
class App {
    int sizes(Elements elements) { return elements.size(); }
    void text() { StringBuilder output = new StringBuilder(); output.append("text"); }
}
`,
        });
        try {
            const index = idx(dir);
            for (const name of ['size', 'append']) {
                const target = index.symbols.get(name).find(d => d.className === 'Local');
                const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, 0);
                assert.equal(callers.unverifiedEntries.length, 0, name);
                const excluded = callers.accountRaw.excludedEntries.find(e => e.reason === 'receiver-type-mismatch');
                assert.ok(excluded, `${name} must retain its pre-validator mismatch classification`);
                assert.equal(excluded.provenance.validation, 'unsupported', 'do not label a report-only exclusion proven');
            }
        } finally { rm(dir); }
    });
});

describe('fix #355: receiver-to-target evidence', () => {
    for (const [language, fixture] of Object.entries(RECEIVER_FIXTURES)) {
        it(`${language}: unresolved receiver stays visible in both directions`, () => {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir);
                const target = targetOf(index, fixture);
                const context = contextOf(index, target);
                const unknown = site => fixture.unknownFiles.includes(site.file) &&
                    (!fixture.unknownFunctions || fixture.unknownFunctions.includes(site.callerName));
                const confirmed = context.data.callers.filter(unknown);
                assert.equal(confirmed.length, 0,
                    `unresolved receiver was confirmed: ${JSON.stringify(confirmed)}`);
                const unverified = context.data.unverifiedCallers.filter(unknown);
                assert.ok(unverified.length > 0, 'unresolved call must remain visible');
                if (fixture.singleOwner) {
                    assert.ok(unverified.every(site => site.reason === 'single-owner'));
                }
                assert.equal(context.meta.account.conserved, true);
                const legacy = index.findCallers(target.name, {
                    targetDefinitions: [target], includeMethods: true,
                });
                assert.ok(!legacy.some(site => unknown({ ...site, file: site.relativePath })),
                    'legacy callers cannot promote a site that lacks receiver evidence');
                const render = index.symbols.get('render')?.find(d =>
                    fixture.unknownFiles.includes(d.relativePath));
                assert.ok(render, 'render fixture missing');
                const callees = index.findCallees(render, { collectAccount: true, includeMethods: true });
                assert.ok(!callees.some(d => d.name === target.name &&
                    d.file === target.file && d.startLine === target.startLine),
                'unresolved receiver must not manufacture an exact callee binding');
                assert.ok(callees.unverifiedCallees.some(d => d.name === target.name),
                    'callee direction must retain the unresolved site');
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });

        it(`${language}: constructed and declared receiver controls retain confirmation`, () => {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir);
                const target = targetOf(index, fixture);
                const context = contextOf(index, target);
                const constructed = context.data.callers.find(d => d.callerName === 'constructed');
                assert.ok(constructed, 'constructor-typed call should remain confirmed');
                assert.ok(constructed.provenance, 'confirmed edge must retain provenance');
                assert.equal(constructed.provenance.rule, 'constructor-typed');
                const def = index.symbols.get('constructed')[0];
                const callees = index.findCallees(def, { collectAccount: true, includeMethods: true });
                const edge = callees.find(d => d.name === target.name && d.file === target.file);
                assert.ok(edge, 'constructed receiver must retain a confirmed callee');
                assert.ok(edge.siteProvenance?.length, 'callee must retain occurrence evidence');
            } finally { rm(dir); }
        });

        if (fixture.singleOwner && fixture.other) {
            it(`${language}: unrelated second owner changes the reason, not visibility`, () => {
                const dir = tmp({ ...fixture.files, ...fixture.other });
                try {
                    const index = idx(dir);
                    const context = contextOf(index, targetOf(index, fixture));
                    assert.ok(!context.data.callers.some(d => fixture.unknownFiles.includes(d.file)));
                    for (const file of fixture.unknownFiles) {
                        assert.ok(context.data.unverifiedCallers.some(d =>
                            d.file === file && d.reason === 'method-ambiguous'), file);
                    }
                    assert.equal(context.meta.account.conserved, true);
                } finally { rm(dir); }
            });
        }
    }

    it('same-line typed and unresolved calls keep separate occurrence evidence', () => {
        const dir = tmp({
            'app.ts': 'class Local {\n as_posix() { return "local"; }\n}\nfunction mixed(typed: Local, unknown: any) { return typed.as_posix() + unknown.as_posix(); }\n',
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('as_posix')[0];
            const callers = index.findCallers('as_posix', {
                collectAccount: true, includeMethods: true, targetDefinitions: [target],
            });
            const confirmed = callers.filter(d => d.relativePath === 'app.ts' && d.line === 4);
            const unverified = callers.unverifiedEntries.filter(d => d.relativePath === 'app.ts' && d.line === 4);
            assert.equal(confirmed.length, 1);
            assert.equal(unverified.length, 1);
            assert.ok(Number.isInteger(confirmed[0].provenance.facts.site.start));
            assert.notEqual(confirmed[0].provenance.facts.site.start,
                unverified[0].provenance.facts.site.start);
            const callees = index.findCallees(index.symbols.get('mixed')[0], { collectAccount: true, includeMethods: true });
            const edge = callees.find(d => d.name === 'as_posix');
            assert.equal(edge.siteProvenance.length, 1);
            assert.equal(callees.unverifiedCallees.filter(d => d.name === 'as_posix').length, 1);
            assert.equal(path.basename(edge.file), 'app.ts');
        } finally { rm(dir); }
    });
});


it('callee JSON retains each occurrence and derives its summary from the weakest site', () => {
    const dir = tmp({ 'app.ts': [
        'class Local {',
        ' run() {}',
        ' mixed(typed: Local) {',
        '  this.run();',
        '  typed.run();',
        '  const value = new Local();',
        '  value.run();',
        ' }',
        '}',
    ].join('\n') });
    try {
        const index = idx(dir);
        const mixed = index.symbols.get('mixed')[0];
        const json = contextOf(index, mixed);
        const edge = json.data.callees.find(c => c.name === 'run');
        assert.equal(edge.siteProvenance.length, 3);
        assert.equal(edge.provenance.rule, 'receiver-annotation');
        assert.equal(edge.resolution, 'receiver-hint');
        assert.deepEqual(edge.siteProvenance.map(s => s.provenance.rule),
            ['same-class', 'receiver-annotation', 'constructor-typed']);
        assert.deepEqual(edge.siteProvenance.map(s => s.tier),
            ['confirmed', 'confirmed', 'confirmed']);
        assert.deepEqual(edge.sites, [4, 5, 7]);
    } finally { rm(dir); }
});
