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

describe('fix #355 release recovery: external factory fields', () => {
    it('keeps external factory values visible and replays their import and assignment evidence', () => {
        const source = require('fs').readFileSync(path.join(__dirname, 'fixtures/python/external-field-flow.py'), 'utf8');
        for (const shadow of [false, true]) {
            const dir = tmp({ 'app.py': source, ...(shadow ? { 'codecs.py':
                'def getincrementaldecoder(name): return lambda **kwargs: None\n' } : {}) });
            try {
                const index = idx(dir), target = index.symbols.get('decode').find(d => d.className === 'Local');
                const calls = index.findCallers('decode', { targetDefinitions: [target], collectAccount: true });
                assert.ok(calls.some(c => c.callerName === 'positive'));
                const classes = ['ExternalField', 'AliasedField', 'ReplacedField', 'ShadowedField'];
                for (const owner of classes) {
                    const method = index.symbols.get('read').find(d => d.className === owner);
                    const line = method.endLine;
                    assert.ok(!calls.some(c => c.line === line), owner);
                    assert.ok(!calls.accountRaw.excludedEntries.some(c => c.line === line), owner);
                    const unverified = calls.unverifiedEntries.find(c => c.line === line);
                    assert.ok(unverified, owner);
                    const established = !shadow && ['ExternalField', 'AliasedField'].includes(owner);
                    if (!established) {
                        assert.notEqual(unverified.provenance.validation, 'establishes-dispatch', owner);
                        assert.ok(!unverified.provenance.facts.receiverOrigin?.externalFactory, owner);
                        continue;
                    }
                    assert.equal(unverified.reason, 'possible-dispatch');
                    assert.equal(unverified.provenance.validation, 'establishes-dispatch');
                    const facts = unverified.provenance.facts;
                    assert.equal(facts.receiverOrigin.externalFactory.assignments[0].depth, 2);
                    for (const change of [
                        f => { f.field = 'different'; },
                        f => { f.assignments[0].binding.module = 'fake'; },
                        f => { f.assignments[0].resolvedModule = 'codecs.py'; },
                        f => { f.assignments[0].depth = 0; },
                        f => { f.assignments[0].projectDeclarations.push({ name: 'codecs' }); },
                    ]) {
                        const tampered = structuredClone(facts);
                        change(tampered.receiverOrigin.externalFactory);
                        assert.equal(require('../core/provenance').validateConfirmation({ facts: tampered }, facts.targets).verdict,
                            'incomplete');
                    }
                    const callees = index.findCallees(method, { collectAccount: true });
                    assert.ok(!callees.some(c => c.name === 'decode'));
                    const entry = callees.unverifiedCallees.find(c => c.name === 'decode');
                    assert.equal(entry.reason, 'possible-dispatch');
                    assert.deepEqual(entry.siteProvenance[0].provenance.facts.receiverOrigin, facts.receiverOrigin);
                }
                assert.ok(calls.unverifiedEntries.some(c => c.callerName === 'unresolved'));
                index.saveCache();
                const cached = new (require('../core/project').ProjectIndex)(dir);
                assert.ok(cached.loadCache());
                const again = cached.findCallers('decode', { targetDefinitions: [target], collectAccount: true });
                assert.deepEqual(again.unverifiedEntries.map(c => c.provenance.facts),
                    calls.unverifiedEntries.map(c => c.provenance.facts));
            } finally { rm(dir); }
        }
    });
});

describe('fix #355 release recovery: pytest declaration bindings', () => {
    it('requires a closed export list for every competing wildcard source', () => {
        for (const variant of ['closed', 'conflicting', 'dynamic']) {
            const dir = tmp({
                'model.py': '__all__ = ["Address"]\nclass Address:\n    @property\n    def value(self) -> bytes: return b"x"\n',
                'other.py': `__all__ = ["${variant === 'conflicting' ? 'Address' : 'Other'}"]\n` +
                    (variant === 'dynamic' ? '__all__.append("Address")\n' : '') +
                    'class Address:\n    def decode(self): return "other"\nclass Other: pass\n',
                'public/__init__.py': 'from model import *\nfrom other import *\n',
                'conftest.py': 'import pytest\nimport public\nclass Server:\n    @property\n' +
                    '    def url(self) -> public.Address: return public.Address()\n' +
                    '@pytest.fixture\ndef server() -> Server: return Server()\n',
                'test_flow.py': 'def test_value(server):\n    return server.url.value.decode()\n',
            });
            try {
                const index = idx(dir), target = index.symbols.get('decode')[0];
                const calls = index.findCallers('decode', { targetDefinitions: [target], collectAccount: true });
                const excluded = calls.accountRaw.excludedEntries.find(c => c.file.endsWith('test_flow.py'));
                if (variant !== 'closed') {
                    assert.ok(!excluded, variant);
                    assert.ok(calls.unverifiedEntries.some(c => c.line === 2), variant);
                    continue;
                }
                assert.equal(excluded?.provenance.validation, 'establishes-other');
                const facts = structuredClone(excluded.provenance.facts);
                const wildcard = facts.receiverOrigin.fixtureBinding.fields[0].importChain.find(h => h.wildcards);
                assert.equal(wildcard.wildcards.length, 2);
                wildcard.wildcards[1].exports.literals[0].value = 'Address';
                assert.equal(require('../core/provenance').validateConfirmation({ facts }, facts.targets).verdict, 'incomplete');
            } finally { rm(dir); }
        }
    });
    it('replays fixture overrides and property annotations while preserving unresolved and shadowed parameters', () => {
        const files = Object.fromEntries(['conftest.py', 'model.py', 'test_flow.py',
            'nested/conftest.py', 'nested/test_override.py'].map(name => [name,
            require('fs').readFileSync(path.join(__dirname, 'fixtures/python/pytest-flow', name), 'utf8')]));
        for (const shadow of [false, true]) {
            const dir = tmp({ ...files, ...(shadow ? { 'pytest.py': 'def fixture(value): return value\n' } : {}) });
            try {
                const index = idx(dir);
                const target = index.symbols.get('ping').find(d => d.className === 'Local');
                const callers = index.findCallers('ping', { targetDefinitions: [target], collectAccount: true });
                const positive = callers.find(c => c.callerName === 'test_direct');
                if (shadow) {
                    assert.ok(!positive, 'a project pytest module cannot establish fixture injection');
                    assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'test_direct'));
                    continue;
                }
                assert.ok(positive);
                assert.equal(positive.provenance.validation, 'establishes-target');
                assert.equal(positive.provenance.rule, 'pytest-fixture');
                for (const name of ['ordinary', 'test_parametrized', 'unknown_fixture']) {
                    assert.ok(!callers.some(c => c.callerName === name), name);
                    assert.ok(callers.unverifiedEntries.some(c => c.callerName === name), name);
                }
                assert.ok(!callers.some(c => c.callerName === 'test_replaced'));
                const overridden = callers.accountRaw.excludedEntries.find(c => c.file.endsWith('nested/test_override.py'));
                assert.equal(overridden?.provenance.validation, 'establishes-other');
                assert.equal(overridden.provenance.facts.receiverOrigin.fixtureBinding.fixture.file, 'nested/conftest.py');
                const decode = index.symbols.get('decode').find(d => d.className === 'Local');
                const decoders = index.findCallers('decode', { targetDefinitions: [decode], collectAccount: true });
                const property = decoders.accountRaw.excludedEntries.find(c => c.file.endsWith('test_flow.py'));
                assert.equal(property?.provenance.validation, 'establishes-other');
                assert.equal(property.provenance.facts.receiverOrigin.fixtureBinding.fields.length, 2);
                const validate = require('../core/provenance').validateConfirmation;
                for (const change of [
                    p => { p.parameter.unchanged = false; },
                    p => { p.decorator.binding.module = 'fake'; },
                    p => { p.fixture.returnType = 'Iterator[Local]'; },
                    p => { p.iteratorBinding.module = 'fake'; },
                    p => { p.searchFiles[0] = 'unrelated/test.py'; },
                    p => { p.fields[0].importChain = []; },
                    p => { p.fields[1].member.className = 'Local'; },
                    p => { p.fields[1].annotation = 'Local'; },
                ]) {
                    const facts = structuredClone(property.provenance.facts);
                    change(facts.receiverOrigin.fixtureBinding);
                    assert.equal(validate({ facts }, facts.targets).verdict, 'incomplete');
                }
                const callee = index.findCallees(index.symbols.get('test_direct')[0], { collectAccount: true })
                    .find(c => c.name === 'ping' && c.className === 'Local');
                assert.ok(callee?.siteProvenance.every(p => p.provenance.validation === 'establishes-target'));
                index.saveCache();
                const cached = new (require('../core/project').ProjectIndex)(dir);
                assert.ok(cached.loadCache());
                const again = cached.findCallers('ping', { targetDefinitions: [target], collectAccount: true });
                assert.deepEqual(again.map(c => c.provenance.facts), callers.map(c => c.provenance.facts));
            } finally { rm(dir); }
        }
    });
});

describe('fix #355 release recovery: Python field assignment contracts', () => {
    it('checks every field write and the exact imported function, retaining unknown and shadow controls', () => {
        const code = require('fs').readFileSync(path.join(__dirname, 'fixtures/python/field-contracts.py'), 'utf8');
        for (const projectShadow of [false, true]) {
            const dir = tmp({ 'app.py': code, ...(projectShadow ? {
                'urllib/__init__.py': '', 'urllib/parse.py': 'def parse_qs(value): return value\n',
            } : {}) });
            try {
                const index = idx(dir), target = index.symbols.get('get').find(d => d.className === 'Local');
                const callers = index.findCallers('get', { targetDefinitions: [target], collectAccount: true });
                assert.deepEqual(callers.map(c => c.callerName), ['positive']);
                for (const name of ['replaced', 'shadow', ...(projectShadow ? ['query'] : [])]) {
                    assert.ok(callers.unverifiedEntries.some(c => c.callerName === name), name);
                }
                for (const name of ['comprehension', ...(!projectShadow ? ['query'] : [])]) {
                    const definition = index.symbols.get(name)[0];
                    const excluded = callers.accountRaw.excludedEntries.find(c =>
                        c.line > definition.startLine && c.line <= definition.endLine);
                    assert.equal(excluded?.provenance.validation, 'establishes-other', name);
                    const facts = excluded.provenance.facts;
                    assert.ok(facts.receiverOrigin.assignments.length > 0);
                    const damaged = structuredClone(facts);
                    damaged.receiverOrigin.assignments[0].type = 'Local';
                    assert.notEqual(require('../core/provenance').validateConfirmation({ facts: damaged }, facts.targets).verdict,
                        'establishes-other');
                }
            } finally { rm(dir); }
        }
    });
});

describe('fix #355 release recovery: indexed array declarations', () => {
    it('types array elements from the nearest annotation and retains foreign, union and shadow controls', () => {
        const fs = require('fs');
        const code = fs.readFileSync(path.join(__dirname, 'fixtures/typescript/indexed-receiver.ts'), 'utf8');
        const dir = tmp({ 'app.ts': code });
        try {
            const index = idx(dir), target = index.symbols.get('ping').find(d => d.className === 'Local');
            const callers = index.findCallers('ping', { targetDefinitions: [target], collectAccount: true });
            assert.deepEqual(callers.map(c => c.callerName).sort(), ['numericIndex', 'parameter', 'visit']);
            for (const caller of callers) {
                assert.equal(caller.provenance.validation, 'establishes-target');
                assert.equal(caller.provenance.facts.receiverOrigin.projection, 'array-element');
                const callee = index.findCallees(index.symbols.get(caller.callerName)[0], { collectAccount: true })
                    .find(c => c.name === 'ping' && c.className === 'Local');
                assert.ok(callee, caller.callerName);
                assert.ok(callee.siteProvenance.every(s => s.provenance.validation === 'establishes-target'));
            }
            for (const name of ['union', 'unknown', 'generic', 'dynamicIndex', 'namedProperty', 'untyped', 'indexShadow']) {
                assert.ok(callers.unverifiedEntries.some(c => c.callerName === name), name);
            }
            const other = index.symbols.get('ping').find(d => d.className === 'Other');
            const foreign = index.findCallers('ping', { targetDefinitions: [other], collectAccount: true });
            assert.deepEqual(foreign.map(c => c.callerName).sort(), ['foreign', 'outer', 'shadow']);
            index.saveCache();
            const cached = new (require('../core/project').ProjectIndex)(dir);
            assert.ok(cached.loadCache());
            assert.deepEqual(cached.findCallers('ping', { targetDefinitions: [target], collectAccount: true })
                .map(c => c.provenance.facts), callers.map(c => c.provenance.facts));
        } finally { rm(dir); }
    });
});

describe('fix #355 release recovery: Rust result payload evidence', () => {
    it('follows standard wrappers and alias arguments, preserving shadows and unresolved controls', () => {
        const fs = require('fs');
        const fixture = path.join(__dirname, 'fixtures/rust/result-flow');
        const files = Object.fromEntries(['lib.rs', 'contracts.rs', 'fake.rs', 'error.rs', 'caller.rs', 'Cargo.toml'].map(file =>
            [file, fs.readFileSync(path.join(fixture, file), 'utf8')]));
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const target = index.symbols.get('ping').find(d => d.className === 'Local');
            const callers = index.findCallers('ping', { targetDefinitions: [target], collectAccount: true });
            const expected = ['standard_result', 'standard_option', 'imported_alias', 'builder_chain', 'visit_loop',
                'module_factory', 'module_chain', 'pattern_option', 'pattern_tuple', 'pattern_while', 'pattern_let_else', 'closure_chain', 'receiver_alias', 'reborrowed'];
            assert.deepEqual(callers.map(c => c.callerName).sort(), expected.sort());
            for (const site of callers) {
                assert.equal(site.provenance.validation, 'establishes-target');
                const origin = site.provenance.facts.receiverOrigin;
                assert.equal(origin.source, 'flow');
                if (['receiver_alias', 'reborrowed'].includes(site.callerName)) {
                    assert.equal(origin.aliasBinding.type, 'Local');
                } else if (site.callerName.startsWith('module_')) {
                    assert.equal(origin.moduleProducer.declaration.file, 'contracts.rs');
                    assert.equal(origin.moduleProducer.binding.alias || origin.moduleProducer.binding.name, 'factories');
                } else if (site.callerName.startsWith('pattern_')) {
                    assert.equal(origin.wrapperPattern.contract.type, 'Local');
                } else if (!['visit_loop', 'closure_chain'].includes(site.callerName)) assert.equal(origin.wrapperUnwrap.contract.type, 'Local');
                const fn = index.symbols.get(site.callerName)[0];
                const callees = index.findCallees(fn, { collectAccount: true });
                const edge = callees.find(c => c.name === 'ping' && c.className === 'Local');
                assert.ok(edge, site.callerName + ' callee');
                assert.ok(edge.siteProvenance.every(s => s.provenance.validation === 'establishes-target'));
            }
            assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'unresolved'));
            assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'module_unresolved'));
            assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'pattern_unknown'));
            assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'alias_unknown'));
            const ready = index.symbols.get('ready').find(d => d.className === 'Local');
            const readyCallers = index.findCallers('ready', { targetDefinitions: [ready], collectAccount: true });
            assert.deepEqual(readyCallers.map(c => c.callerName).sort(), ['field_in_macro', 'pattern_macro', 'qualified_macro']);
            assert.equal(readyCallers[0].provenance.validation, 'establishes-target');
            const message = index.symbols.get('message')[0];
            const messages = index.findCallers('message', { targetDefinitions: [message], collectAccount: true });
            assert.deepEqual(messages.map(c => c.callerName), ['crate_alias']);
            assert.equal(messages[0].provenance.validation, 'establishes-target');
            const { resolveRustImport } = require('../core/imports');
            assert.equal(resolveRustImport('crate::Error', path.join(dir, 'error.rs'), dir), path.join(dir, 'lib.rs'),
                'the Error type in the crate root is distinct from the error module');
            const alias = index.symbols.get('Outcome')[0];
            assert.deepEqual(alias.aliasTypeParameters, ['T', 'E']);
            assert.deepEqual(alias.aliasTypeDefaults, [null, '()']);
            const proof = callers.find(c => c.callerName === 'imported_alias').provenance.facts.receiverOrigin;
            assert.ok(proof.wrapperUnwrap.contract.chain.some(h => h.declaration?.name === 'Outcome'));
            const { validateRustWrapperContract } = require('../core/rust-result-flow');
            const { validateConfirmation } = require('../core/provenance');
            const aliasBindingFacts = structuredClone(callers.find(c => c.callerName === 'receiver_alias').provenance.facts);
            aliasBindingFacts.receiverOrigin.aliasBinding.origin.type = 'Other';
            assert.notEqual(validateConfirmation({ facts: aliasBindingFacts }, aliasBindingFacts.targets).verdict, 'establishes-target');
            const patternFacts = structuredClone(callers.find(c => c.callerName === 'pattern_tuple').provenance.facts);
            assert.deepEqual(patternFacts.receiverOrigin.wrapperPattern.contract.payload.projection, [1]);
            patternFacts.receiverOrigin.wrapperPattern.contract.payload.projection = [0];
            assert.notEqual(validateConfirmation({ facts: patternFacts }, patternFacts.targets).verdict, 'establishes-target');
            const moduleFacts = structuredClone(callers.find(c => c.callerName === 'module_factory').provenance.facts);
            moduleFacts.receiverOrigin.moduleProducer.binding.module = 'crate::fake';
            assert.notEqual(validateConfirmation({ facts: moduleFacts }, moduleFacts.targets).verdict, 'establishes-target');
            const aliasFacts = callers.find(c => c.callerName === 'imported_alias').provenance.facts;
            assert.equal(validateRustWrapperContract(proof.wrapperUnwrap.contract), true);
            for (const damage of [
                contract => { contract.producer.returnType = 'AppResult<Other>'; },
                contract => { contract.chain.find(h => h.declaration).type = 'Standard<E, T>'; },
                contract => { contract.chain.find(h => h.declaration).arguments[0].text = 'Other'; },
                contract => { contract.chain.splice(contract.chain.findIndex(h => h.binding), 1); },
                contract => { contract.payload.declaration.name = 'Other'; },
                contract => { contract.chain.find(h => h.standard).rootBindings = [{ name: 'std', module: 'fake' }]; },
            ]) {
                const facts = structuredClone(aliasFacts);
                damage(facts.receiverOrigin.wrapperUnwrap.contract);
                assert.equal(validateRustWrapperContract(facts.receiverOrigin.wrapperUnwrap.contract), false);
                assert.notEqual(validateConfirmation({ facts }, facts.targets).verdict, 'establishes-target');
            }
            const projectUnwrap = index.symbols.get('unwrap').find(d => d.relativePath === 'fake.rs');
            const unwrapCallers = index.findCallers('unwrap', { targetDefinitions: [projectUnwrap], collectAccount: true });
            assert.ok(!unwrapCallers.some(c => c.callerName === 'unresolved'),
                'an unknown payload still belongs to the standard wrapper, not a same-name project class');
            const genericSite = index.getCachedCalls(path.join(dir, 'lib.rs'))
                .find(c => c.name === 'unwrap' && c.enclosingFunction?.name === 'unresolved');
            const genericExclusion = unwrapCallers.accountRaw.excludedEntries.find(c => c.line === genericSite.line);
            assert.equal(genericExclusion.provenance.validation, 'establishes-other');
            const shadowedFacts = structuredClone(genericExclusion.provenance.facts);
            shadowedFacts.standardWrapper.annotationReceiver.bindings = [{ name: 'Result', module: 'fake::Result' }];
            assert.notEqual(validateConfirmation({ facts: shadowedFacts }, shadowedFacts.targets).verdict, 'establishes-other');
            index.saveCache();
            const cached = new (require('../core/project').ProjectIndex)(dir);
            assert.ok(cached.loadCache());
            assert.deepEqual(cached.symbols.get('Outcome')[0].aliasTypeDefaults, [null, '()']);
            const again = cached.findCallers('ping', { targetDefinitions: [target], collectAccount: true });
            assert.deepEqual(again.map(c => c.provenance.facts), callers.map(c => c.provenance.facts));
        } finally { rm(dir); }
    });
});

describe('fix #355 release recovery: Go var declaration witnesses', () => {
    it('validates package, local and grouped declarations without promoting a shadow or unknown receiver', () => {
        const code = `package sample
type Local struct {}
func (*Local) Ping() {}
type Other struct {}
func (*Other) Ping() {}
func forwardDeclared() { shared.Ping() }
func forwardConstructed() { built.Ping() }
var shared *Local
var built = &Local{}
var (
    grouped *Local
    groupedBuilt = &Local{}
)
func packageDeclared() { shared.Ping() }
func packageConstructed() { built.Ping() }
func packageGrouped() { grouped.Ping(); groupedBuilt.Ping() }
func declared() { var x *Local; x = &Local{}; x.Ping() }
func constructed() { var x = &Local{}; x.Ping() }
func localGrouped() { var (
    x *Local
    y = &Local{}
); x.Ping(); y.Ping() }
func shadowed(shared *Other) { shared.Ping() }
func wrong() { var x = &Other{}; x.Ping() }
func unresolved(x interface { Ping() }) { x.Ping() }
`;
        const dir = tmp({ 'sample.go': code, 'go.mod': 'module sample\n\ngo 1.22\n' });
        try {
            const index = idx(dir);
            const target = index.symbols.get('Ping').find(d => d.className === 'Local');
            const callers = index.findCallers('Ping', { targetDefinitions: [target], collectAccount: true });
            const expected = { forwardDeclared: ['annotation'], forwardConstructed: ['constructor'],
                packageDeclared: ['annotation'], packageConstructed: ['constructor'],
                packageGrouped: ['annotation', 'constructor'], declared: ['annotation'],
                constructed: ['constructor'], localGrouped: ['annotation', 'constructor'] };
            for (const [name, sources] of Object.entries(expected)) {
                const sites = callers.filter(c => c.callerName === name);
                assert.equal(sites.length, sources.length, name);
                assert.deepEqual(sites.map(c => c.provenance.facts.receiverTypeSource).sort(), sources.sort());
                for (const site of sites) {
                    assert.equal(site.provenance.validation, 'establishes-target');
                    const origin = site.provenance.facts.receiverOrigin;
                    assert.match(code.slice(origin.start, origin.end), /Local/);
                }
                const callees = index.findCallees(index.symbols.get(name)[0], { collectAccount: true });
                const edge = callees.find(c => c.name === 'Ping' && c.className === 'Local');
                assert.ok(edge, name + ' must also resolve the callee');
                assert.ok(edge.siteProvenance.every(s => s.provenance.validation === 'establishes-target'));
                assert.equal(callees.calleeAccount.conserved, true);
            }
            for (const name of ['shadowed', 'wrong', 'unresolved']) {
                assert.ok(!callers.some(c => c.callerName === name), name);
            }
            assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'unresolved'));
            // Excluded entries need not retain caller names; pin their source lines instead.
            for (const name of ['shadowed', 'wrong']) {
                const line = code.split('\n').findIndex(s => s.startsWith('func ' + name + '(')) + 1;
                const entry = callers.accountRaw.excludedEntries.find(c => c.line === line);
                assert.ok(entry, name);
                assert.equal(entry.provenance.validation, 'establishes-other');
            }
            index.saveCache();
            const cached = new (require('../core/project').ProjectIndex)(dir);
            assert.ok(cached.loadCache());
            const again = cached.findCallers('Ping', { targetDefinitions: [target], collectAccount: true });
            const origins = sites => sites.map(c => [c.line, c.provenance.validation,
                c.provenance.facts.receiverOrigin]);
            assert.deepEqual(origins(again), origins(callers), 'persisted calls retain origin witnesses');
        } finally { rm(dir); }
    });
});

describe('fix #355 review: validation coverage is distinct from a failed proof', () => {
    it('Python property reads select the getter while retaining foreign and unresolved controls', () => {
        const dir = tmp({ 'app.py': `class Base:
    @property
    def value(self): return 1
    @value.setter
    def value(self, item): pass
class Child(Base): pass
class Other:
    @property
    def value(self): return 2
def consume(value): pass
def typed(item: Child): consume(item.value)
def wrong(item: Other): consume(item.value)
def unknown(item): consume(item.value)
` });
        try {
            const index = idx(dir);
            const target = index.symbols.get('value').find(d => d.className === 'Base' && d.type === 'property');
            const callers = index.findCallers('value', { targetDefinitions: [target], collectAccount: true });
            assert.deepEqual(callers.map(c => c.callerName), ['typed']);
            assert.equal(callers[0].provenance.validation, 'establishes-target');
            assert.equal(callers[0].provenance.facts.lookup.steps.at(-1).propertyRead, true);
            assert.ok(!callers.unverifiedEntries.some(c => c.callerName === 'unknown'),
                'an untyped property value belongs to the property-access inventory, not the caller band');
            assert.ok(callers.accountRaw.excludedEntries.some(c => c.line === 12));
            const facts = structuredClone(callers[0].provenance.facts);
            delete facts.valueReference;
            assert.notEqual(require('../core/provenance').validateConfirmation({ facts }, facts.targets).verdict,
                'establishes-target', 'an accessor pair cannot establish an ordinary method call');
        } finally { rm(dir); }
    });

    it('Python builtin contracts retain their import and producer facts, and refuse project shadows', () => {
        const files = {
            'app.py': `import os
from base64 import b64encode
class Local:
    def decode(self): return "local"
    def update(self, values): pass
def known():
    b64encode(b"text").decode()
    os.environ.update({})
def positive():
    x = Local()
    x.decode()
def unknown(x): x.decode()
`,
        };
        for (const shadow of [false, true]) {
            const dir = tmp({ ...files, ...(shadow ? {
                'base64.py': 'def b64encode(data): return data\n',
                'os.py': 'environ = {}\n',
            } : {}) });
            try {
                const index = idx(dir);
                for (const name of ['decode', 'update']) {
                    const target = index.symbols.get(name).find(d => d.className === 'Local');
                    const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
                    const line = name === 'decode' ? 7 : 8;
                    const excluded = callers.accountRaw.excludedEntries.find(c => c.line === line);
                    if (shadow) assert.ok(!excluded, 'project module must disable the stdlib contract');
                    else {
                        assert.ok(excluded);
                        assert.equal(excluded.provenance.validation, 'establishes-other');
                        const origin = excluded.provenance.facts.receiverOrigin;
                        assert.ok(origin.bindings?.length || origin.producers?.[0].bindings?.length);
                    }
                    if (name === 'decode') {
                        assert.ok(callers.some(c => c.callerName === 'positive'));
                        assert.ok(callers.unverifiedEntries.some(c => c.callerName === 'unknown'));
                    }
                }
            } finally { rm(dir); }
        }
    });

    it('Python assignment RHS keeps the previous receiver origin before the returned value replaces it', () => {
        const dir = tmp({ 'app.py': `class Other:
    def reset(self): return self
class Local:
    def reset(self) -> Other: return Other()
def render():
    x = Local()
    x = x.reset()
    x.reset()
` });
        try {
            const index = idx(dir);
            const target = index.symbols.get('reset').find(d => d.className === 'Local');
            const callers = index.findCallers('reset', { targetDefinitions: [target], collectAccount: true });
            assert.deepEqual(callers.map(c => c.line), [7]);
            assert.equal(callers[0].provenance.validation, 'establishes-target');
            assert.equal(callers[0].provenance.facts.receiverOrigin.line, 6);
            assert.ok(callers.accountRaw.excludedEntries.some(c => c.line === 8));
        } finally { rm(dir); }
    });
    for (const language of ['java', 'csharp']) {
        it(`${language}: an unresolved overload family excludes only targets outside the family`, () => {
            const source = language === 'java' ? `class Writer {
    void emit(String value) {}
    void emit(int value) {}
}
class Other { void emit(String value) {} }
class Child extends Writer { @Override void emit(String value) {} }
class Use {
    void chosen(Writer w) { w.emit(1); }
    void unresolved(Writer w, String a, String b) { w.emit(a + b); }
}` : `class Writer {
    public virtual void emit(string value) {}
    public void emit(int value) {}
}
class Other { public void emit(string value) {} }
class Child : Writer { public override void emit(string value) {} }
class Use {
    void chosen(Writer w) { w.emit(1); }
    void unresolved(Writer w, string a, string b) { w.emit(a + b); }
}`;
            const dir = tmp({ [language === 'java' ? 'Use.java' : 'Use.cs']: source });
            try {
                const index = idx(dir), definitions = index.symbols.get('emit');
                const other = definitions.find(d => d.className === 'Other');
                const calls = target => index.findCallers('emit', { targetDefinitions: [target], collectAccount: true });
                const excluded = calls(other);
                assert.equal(excluded.length, 0);
                assert.equal(excluded.unverifiedEntries.length, 0);
                const entry = excluded.accountRaw.excludedEntries.find(c => c.line === 9);
                assert.ok(entry);
                assert.equal(entry.provenance.validation, 'establishes-other');
                assert.equal(entry.provenance.facts.lookup.overload.outcome, 'ambiguous');
                const integers = calls(definitions.find(d => d.className === 'Writer' && d.params.includes('int ')));
                assert.ok(integers.some(c => c.callerName === 'chosen'));
                assert.ok(integers.unverifiedEntries.some(c => c.callerName === 'unresolved'));
                const child = calls(definitions.find(d => d.className === 'Child'));
                assert.ok(child.unverifiedEntries.some(c => c.callerName === 'unresolved'),
                    'a base-typed receiver must retain possible overriding dispatch');
                // A captured member group must also fail closed if its declarations are altered.
                const facts = structuredClone(entry.provenance.facts);
                facts.lookup.steps[0].members.pop();
                const checked = require('../core/provenance').validateConfirmation({ facts }, facts.targets);
                assert.notEqual(checked.verdict, 'establishes-other');
            } finally { rm(dir); }
        });
    }
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
