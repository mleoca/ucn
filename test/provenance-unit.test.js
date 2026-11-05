'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfirmation, declarationIdentity: identity } = require('../core/provenance');
const { ReceiverTypeMap } = require('../languages/type-evidence');
const { dedupeOccurrences, addRuleStat, finishRuleStats, ruleTable } = require('../eval/provenance-report');

describe('fix #417: type lookup records only observed file facts', () => {
    const { factIndex } = require('../core/provenance-overload');
    it('file observations and local writes stay in their own views', () => {
        const fields = ['language', 'symbols'];
        const live = { files: new Map([
            ['a', { language: 'java', symbols: [{ name: 'A' }] }],
            ['b', { language: 'cpp', symbols: [{ name: 'B' }] }],
        ]) };
        const reads = {}, view = factIndex(reads, live, fields);
        const a = view.files.get('a'), b = view.files.get('b');
        assert.deepEqual(Object.keys(a), fields);
        assert.equal(a.language, 'java');
        assert.equal(b.language, 'cpp');
        assert.equal(a.symbols[0].name, 'A');
        b.symbols = [{ name: 'local' }];
        a.language = 'local';
        assert.equal(b.language, 'cpp');
        assert.equal(live.files.get('a').language, 'java');
        assert.equal(live.files.get('b').symbols[0].name, 'B');
        const replay = factIndex(JSON.parse(JSON.stringify(reads)), undefined, fields);
        assert.equal(replay.files.get('a').language, 'java');
        assert.equal(replay.files.get('a').symbols[0].name, 'A');
        assert.throws(() => replay.files.get('b').symbols, /Missing provenance fact/);
        assert.equal(replay.hasMissingProvenanceFacts, true);
        delete a.symbols;
        assert.equal(Object.hasOwn(a, 'symbols'), false);
        assert.equal(replay.files.get('a').symbols[0].name, 'A');
    });
    it('a language read avoids unrelated declarations and refuses an uncaptured field during replay', () => {
        const entry = { language: 'cpp' };
        Object.defineProperty(entry, 'symbols', {
            get() { throw new Error('unrelated declarations were read'); },
        });
        const live = { files: new Map([['unit.cpp', entry]]) }, reads = {};
        const view = factIndex(reads, live, ['language', 'symbols']);
        assert.equal(view.files.get('unit.cpp').language, 'cpp');
        const replay = factIndex(JSON.parse(JSON.stringify(reads)), undefined, ['language', 'symbols']);
        live.files.clear();
        assert.equal(replay.files.get('unit.cpp').language, 'cpp');
        assert.equal(replay.hasMissingProvenanceFacts, false);
        assert.throws(() => replay.files.get('unit.cpp').symbols, /Missing provenance fact/);
        assert.equal(replay.hasMissingProvenanceFacts, true);
    });
    it('observed arrays keep map identity within a view and isolate replay mutations', () => {
        const live = { files: new Map([['unit.cpp', { language: 'cpp', symbols: [{ name: 'Box' }] }]]) };
        const reads = {}, view = factIndex(reads, live, ['language', 'symbols']);
        const file = view.files.get('unit.cpp');
        assert.equal(file.language, 'cpp');
        assert.equal(file.symbols[0].name, 'Box');
        assert.equal(view.files.get('unit.cpp'), file);
        assert.equal(file.symbols, file.symbols);
        file.symbols[0].name = 'local'; file.language = 'local';
        assert.equal(live.files.get('unit.cpp').symbols[0].name, 'Box');
        const saved = JSON.parse(JSON.stringify(reads));
        const first = factIndex(saved, undefined, ['language', 'symbols']);
        first.files.get('unit.cpp').symbols[0].name = 'changed';
        const second = factIndex(saved, undefined, ['language', 'symbols']);
        assert.equal(second.files.get('unit.cpp').symbols[0].name, 'Box');
        assert.equal(second.files.get('unit.cpp').language, 'cpp');
    });
    it('a missing file is captured as absent even if it appears before replay', () => {
        const reads = {}, live = { files: new Map() };
        const view = factIndex(reads, live, ['language', 'symbols']);
        assert.equal(view.files.get('missing.cpp'), undefined);
        live.files.set('missing.cpp', { language: 'cpp', symbols: [] });
        const replay = factIndex(JSON.parse(JSON.stringify(reads)), undefined, ['language', 'symbols']);
        assert.equal(replay.files.get('missing.cpp'), undefined);
        assert.equal(replay.hasMissingProvenanceFacts, false);
    });
});

describe('fix #417: overload witnesses record only observed file fields', () => {
    it('reading the language does not copy unrelated declarations into an overload witness', () => {
        const { captureOverload } = require('../core/provenance-overload');
        const entry = { language: 'java', relativePath: 'Unit.java' };
        Object.defineProperty(entry, 'symbols', {
            get() { throw new Error('unread declarations were copied'); },
        });
        const live = { files: new Map([['Unit.java', entry]]) };
        const candidate = { file: 'Unit.java', relativePath: 'Unit.java', name: 'run',
            type: 'method', startLine: 2, endLine: 2, params: '', paramsStructured: [] };
        const witness = captureOverload(live, { line: 4 }, [candidate], 'java', index => {
            assert.equal(index.files.get('Unit.java').language, 'java');
            return { match: candidate };
        });
        assert.ok(witness);
        assert.equal(witness.fileFields, true);
        assert.equal(witness.reads['files.get:"Unit.java"."language"'], 'java');
        assert.equal(Object.hasOwn(witness.reads, 'files.get:"Unit.java"."symbols"'), false);
    });
});

describe('fix #417: type lookup witnesses contain source facts', () => {
    it('reused bindings isolate witness edits and temporary index views', () => {
        const path = require('path');
        const { tmp, rm, idx } = require('./helpers');
        const { captureTypeLookup, validateTypeLookup } = require('../core/provenance-type');
        const dir = tmp({
            'box.js': 'export class Box {}\n',
            'use.js': "import { Box } from './box.js';\nconst b = new Box();\n",
        });
        try {
            const index = idx(dir), owner = index.symbols.get('Box').find(def => def.type === 'class');
            const file = path.join(dir, 'use.js'), query = { file, relativePath: 'use.js',
                line: 2, column: 14, name: 'Box', construction: true };
            index._beginOp();
            try {
                const first = captureTypeLookup(index, query, owner);
                assert.ok(first);
                first.owner.name = 'Other'; first.query.name = 'Other';
                const second = captureTypeLookup(index, { ...query, name: 'Box' }, owner);
                assert.ok(second);
                assert.equal(second.owner.name, 'Box');
                assert.equal(second.query.name, 'Box');
                assert.equal(validateTypeLookup(second, identity(owner), { file: 'use.js', line: 2, column: 14 }), true);
                second.owner.name = 'Other'; second.query.name = 'Other';
                const entry = index.files.get(file), bindings = entry.importBindings, details = entry.importDetails;
                index._isolatedOperation(() => {
                    try {
                        entry.importBindings = []; entry.importDetails = [];
                        assert.equal(captureTypeLookup(index, { ...query, name: 'Box' }, owner), null);
                    } finally { entry.importBindings = bindings; entry.importDetails = details; }
                });
                const third = captureTypeLookup(index, { ...query, name: 'Box' }, owner);
                assert.equal(third.owner.name, 'Box');
                assert.equal(third.query.name, 'Box');
            } finally { index._endOp(); }
        } finally { rm(dir); }
    });

    it('captures project using text and replays after the project file is removed', () => {
        const fs = require('fs'), path = require('path');
        const { tmp, rm, idx } = require('./helpers');
        const { captureTypeLookup, validateTypeLookup } = require('../core/provenance-type');
        const projectText = '<Project><ItemGroup><Using Include="P" /></ItemGroup></Project>';
        const dir = tmp({
            'p/Node.cs': 'namespace P {public class Node {public Node(int v){}}}\n',
            'q/Use.cs': 'namespace Q {class Use {static Node build(){return new Node(1);}}}\n',
            'n.csproj': projectText,
        });
        try {
            const index = idx(dir), target = index.symbols.get('Node').find(def => def.type === 'class');
            const query = { file: path.join(dir, 'q/Use.cs'), relativePath: 'q/Use.cs', line: 1, column: 53,
                name: 'Node', qualifier: null };
            const proof = captureTypeLookup(index, query, target);
            assert.ok(proof);
            assert.ok(JSON.stringify(proof.reads).includes('<Project>'), 'the witness contains the project source');
            assert.ok(!Object.hasOwn(proof.reads, 'property:_typeDenotation'), 'a live lookup memo is not source evidence');
            fs.unlinkSync(path.join(dir, 'n.csproj'));
            const raw = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, existsSync: fs.existsSync };
            try {
                for (const name of Object.keys(raw)) fs[name] = () => { throw new Error('live filesystem read during replay'); };
                assert.equal(validateTypeLookup(proof, identity(target), { file: 'q/Use.cs', line: 1, column: 53 }), true);
            } finally { Object.assign(fs, raw); }
            const missing = JSON.parse(JSON.stringify(proof));
            const sourceKey = Object.keys(missing.reads).find(key => JSON.stringify(missing.reads[key]).includes('<Project>'));
            delete missing.reads[sourceKey];
            assert.equal(validateTypeLookup(missing, identity(target), { file: 'q/Use.cs', line: 1, column: 53 }), false);
        } finally { rm(dir); }
    });
});

const owner = identity({ file: 'm.ts', startLine: 1, endLine: 8, name: 'Local', type: 'class' });
const method = identity({ file: 'm.ts', startLine: 2, endLine: 3, name: 'run', type: 'method', className: 'Local' });
function witness() {
    return { facts: {
        language: 'typescript', receiverTypeSource: 'annotation',
        receiverOrigin: { source: 'annotation', type: 'Local', line: 10 },
        receiverResolvedIn: owner,
        lookup: { receiver: owner, selected: method,
            steps: [{ owner, members: [method], parents: [] }] },
    } };
}

describe('confirmation witnesses', () => {
    it('distinguishes unsupported collection from missing facts on a supported lookup', () => {
        assert.equal(validateConfirmation({ facts: {} }, method).verdict, 'unsupported');
        const proof = witness();
        delete proof.facts.lookup;
        assert.equal(validateConfirmation(proof, method).verdict, 'incomplete');
        proof.facts.lookupUnsupported = 'external-parent-member';
        assert.equal(validateConfirmation(proof, method).verdict, 'unsupported');
    });
    it('validates an exact declaration and independently proves another one', () => {
        assert.equal(validateConfirmation(witness(), method).verdict, 'establishes-target');
        const other = { ...method, startLine: 12, className: 'Other' };
        assert.equal(validateConfirmation(witness(), other).verdict, 'establishes-other');
    });
    it('rejects file agreement when the alleged member belongs to another owner', () => {
        const proof = witness();
        const wrong = { ...method, className: 'Other', startLine: 12 };
        proof.facts.lookup.selected = wrong;
        proof.facts.lookup.steps[0].members = [wrong];
        assert.equal(validateConfirmation(proof, wrong).verdict, 'inconsistent');
    });
    it('cannot skip an override or an unresolved overload', () => {
        const proof = witness();
        const base = { ...owner, name: 'Base', startLine: 20 };
        const inherited = { ...method, className: 'Base', startLine: 21 };
        proof.facts.lookup.selected = inherited;
        proof.facts.lookup.steps[0].parents = [base];
        proof.facts.lookup.steps.push({ owner: base, members: [inherited], parents: [] });
        assert.equal(validateConfirmation(proof, inherited).diagnostic, 'overriding-member-before-target');
        proof.facts.lookup.steps[0].members = [];
        assert.equal(validateConfirmation(proof, inherited).verdict, 'establishes-target');
        proof.facts.lookup.steps[1].members.push({ ...inherited, startLine: 25 });
        assert.equal(validateConfirmation(proof, inherited).verdict, 'incomplete');
    });
    it('fix #396: a member-set witness proves only that a target outside the members is not the callee', () => {
        const overloadB = { ...method, startLine: 4, endLine: 5 };
        const proof = witness();
        proof.facts.lookup.memberSet = true;
        proof.facts.lookup.steps[0].members = [method, overloadB];
        const other = { ...method, startLine: 12, className: 'Other' };
        assert.equal(validateConfirmation(proof, other).verdict, 'establishes-other');
        // A target among the members stays undecided, never confirmed.
        assert.equal(validateConfirmation(proof, method).verdict, 'incomplete');
        assert.equal(validateConfirmation(proof, overloadB).verdict, 'incomplete');
        // A set of one member is no member-set witness.
        proof.facts.lookup.steps[0].members = [method];
        assert.equal(validateConfirmation(proof, other).verdict, 'inconsistent');
    });
    it('does not turn unknown or inconsistent receiver origins into exclusions', () => {
        const proof = witness();
        proof.facts.receiverTypeSource = 'unknown';
        assert.equal(validateConfirmation(proof, method).verdict, 'incomplete');
        proof.facts.receiverTypeSource = 'constructor';
        assert.equal(validateConfirmation(proof, method).verdict, 'inconsistent');
    });
    it('checks binding and import names, including alias hops', () => {
        const fn = { ...method, className: null, kind: 'function', bindingId: 'm.ts:2' };
        const binding = { facts: { binding: { referenceId: fn.bindingId, declaration: fn } } };
        assert.equal(validateConfirmation(binding, fn).verdict, 'establishes-target');
        binding.facts.binding.referenceId = 'm.ts:12';
        assert.equal(validateConfirmation(binding, fn).verdict, 'incomplete');
        const imported = { facts: { importChain: [
            { fromFile: 'app.ts', toFile: 'barrel.ts', localName: 'as_posix', importedName: 'publicRun' },
            { fromFile: 'barrel.ts', toFile: 'm.ts', localName: 'publicRun', importedName: 'run', declaration: fn },
        ] } };
        assert.equal(validateConfirmation(imported, fn).verdict, 'establishes-target');
        imported.facts.importChain[1].localName = 'other';
        assert.equal(validateConfirmation(imported, fn).verdict, 'inconsistent');
    });
});

it('public provenance stays compact while engine and oracle witnesses remain complete', () => {
    const { formatPublicJson } = require('../core/output/public');
    const { formatContextJson, formatAboutJson, formatImpactJson } = require('../core/output/analysis');
    const { unverifiedReasonLabel } = require('../core/output/shared');
    const proof = witness();
    Object.assign(proof, { rule: 'receiver-annotation', rules: ['receiver-annotation'],
        validation: 'incomplete', diagnostic: 'missing-receiver-origin' });
    proof.facts.lookup.steps[0].members = Array.from({ length: 1000 }, () => method);
    const site = { name: 'run', file: 'app.ts', line: 11, provenance: proof,
        reason: 'provenance-incomplete', siteProvenance: [{ siteId: 1, provenance: proof }] };
    const context = { callers: [site], unverifiedCallers: [site], callees: [site],
        meta: { account: { excluded: { evidence: [site] } } } };
    const before = JSON.stringify(context);
    for (const text of [formatPublicJson('show', context), formatContextJson(context),
        formatAboutJson(context), formatImpactJson(context)]) {
        assert.ok(text.length < 10000, `compact result was ${text.length} chars`);
        assert.ok(!text.includes('lookup'), 'public output must not contain the member inventory');
        assert.ok(!text.includes('"facts"'));
        assert.match(text, /receiver-annotation/);
        assert.match(text, /originLine/);
        assert.match(text, /missing-receiver-origin/);
    }
    assert.equal(JSON.stringify(context), before, 'formatting cannot strip evaluation witnesses in place');
    assert.equal(unverifiedReasonLabel(site), 'provenance-incomplete: missing-receiver-origin');
});

it('type origins follow scope restoration and reassignment atomically', () => {
    const types = new ReceiverTypeMap();
    types.set('value', 'Local', 'constructor');
    const outer = new ReceiverTypeMap(types);
    types.set('value', 'Other', 'annotation');
    assert.equal(types.fields('value').receiverTypeSource, 'annotation');
    types.restore(outer);
    assert.equal(types.fields('value').receiverTypeSource, 'constructor');
    types.set('value', 'Unknown');
    assert.equal(types.fields('value').receiverTypeSource, 'unknown');
    types.delete('value');
    assert.equal(types.origins.has('value'), false);
});

it('an imported rename proves the exported declaration, not another function in the same module', () => {
    const { tmp, rm, idx } = require('./helpers');
    const { confirmationFacts } = require('../core/provenance-facts');
    const { getCachedCalls } = require('../core/callers');
    const dir = tmp({
        'm.py': 'def alpha(): return "alpha"\ndef as_posix(): return "other"\n',
        'app.py': 'from m import alpha as as_posix\ndef invoke(): return as_posix()\n',
    });
    try {
        const index = idx(dir), invoke = index.symbols.get('invoke')[0];
        const target = index.symbols.get('as_posix').find(d => d.relativePath === 'm.py');
        const alpha = index.symbols.get('alpha')[0];
        const call = getCachedCalls(index, invoke.file).find(c => c.name === 'as_posix');
        assert.ok(call);
        const facts = confirmationFacts(index, invoke.file, call, [target]);
        assert.equal(facts.importChain.at(-1).declaration.name, 'alpha');
        assert.equal(validateConfirmation({ facts }, identity(alpha)).verdict, 'establishes-target');
        assert.equal(validateConfirmation({ facts }, identity(target)).verdict, 'establishes-other');
        assert.equal(facts.importChain.at(-1).declaration.file, target.relativePath);
    } finally { rm(dir); }
});

it('qualified Java nested receivers outrank a same-named local nested type in both directions', () => {
    const { tmp, rm, idx } = require('./helpers');
    const dir = tmp({
        'A.java': 'class A {\n static class Builder {\n A build() { return new A(); }\n }\n Builder toBuilder() { return new Builder(); }\n}',
        'B.java': 'class B {\n A field;\n static class Builder { B build() { return new B(); } }\n Builder toBuilder() { return new Builder(); }\n A use() {\n A.Builder value = field.toBuilder();\n return value.build();\n }\n}',
    });
    try {
        const index = idx(dir);
        const result = index.context('build', { file: 'A.java', line: 3 });
        const edge = result.callers.find(c => c.line === 7 && c.relativePath === 'B.java');
        assert.ok(edge, 'A.Builder call must remain confirmed');
        assert.equal(edge.provenance.facts.receiverResolvedIn.enclosingType, 'A');
        assert.equal(edge.provenance.validation, 'establishes-target');
        const changed = structuredClone(edge.provenance);
        changed.facts.receiverTypeQualifier = 'B';
        assert.equal(validateConfirmation(changed, changed.facts.targets).diagnostic, 'receiver-qualifier-mismatch');
        const use = index.context('use', { file: 'B.java', line: 5 });
        const callee = use.callees.find(c => c.name === 'build');
        assert.equal(callee?.relativePath, 'A.java');
        assert.equal(callee?.siteProvenance[0].provenance.validation, 'establishes-target');
    } finally { rm(dir); }
});

it('rule precision counts distinct occurrences and excludes abstentions', () => {
    const edge = { file: 'app.ts', line: 1, target: method,
        provenance: { rule: 'constructor-typed', facts: { site: { start: 1, end: 10 } } } };
    const other = { ...edge, provenance: { ...edge.provenance, facts: { site: { start: 20, end: 29 } } } };
    assert.equal(dedupeOccurrences([edge, edge, other]).length, 2);
    const stats = {};
    for (const verdict of [{ hit: true, scorable: true }, { hit: false, scorable: false }, { hit: false, scorable: true }]) {
        addRuleStat(stats, 'constructor-typed', verdict);
    }
    const rows = finishRuleStats(stats);
    assert.equal(rows['constructor-typed'].precision, 0.5);
    assert.equal(rows['constructor-typed'].falseCandidates, 1);
    const table = ruleTable([{ summary: { language: 'typescript', confirmedRules: rows } },
        { summary: { language: 'python', confirmedRules: {} } }]).join('\n');
    assert.match(table, /1\/2.*1.*50\.00%.*low sample/);
    assert.match(table, /python.*unmeasured/);
    assert.match(table, /single-owner \| typescript \| 0\/0 \| 0 \| 0 \| unavailable \| unmeasured/);
    const empty = ruleTable([{ summary: { language: 'rust', confirmedRules: {
        binding: { candidates: 3, hits: 0, unscored: 3 },
    } } }, { summary: { language: 'java' } }]).join('\n');
    assert.match(empty, /binding \| rust \| 0\/0 \| 3 \| 0 \| unavailable \| low sample/);
    assert.match(empty, /binding \| java .*older report/);
});

it('oracle replay freezes baseline eligibility and detects changed occurrence identities', () => {
    const { referencePopulation, deferredReferenceShown } = require('../eval/run-manifest');
    const first = { file: 'a.js', line: 2, column: 5, kind: 'call', oracleResolution: 'unresolved' };
    const second = { ...first, column: 20 };
    assert.deepEqual(referencePopulation([first, second]), referencePopulation([second, first]));
    assert.notDeepEqual(referencePopulation([first]), referencePopulation([second]));
    assert.equal(deferredReferenceShown(first, new Set(['a.js:2'])), true);
    assert.equal(deferredReferenceShown(first, new Set(), { deferredShown: ['a.js:2'] }), true);
    assert.equal(deferredReferenceShown(first, new Set(['a.js:2']), { deferredShown: [] }), false);
});

for (const [file, code] of Object.entries({
    'X.java': 'class Local { void run() {} }\nclass Use { void use(Local value) { value.run(); value.run(); } }',
    'x.py': 'class Local:\n def run(self): pass\ndef use(value: Local): value.run(); value.run()',
    'x.cs': 'class Local { public void run() {} }\nclass Use { void use(Local value) { value.run(); value.run(); } }',
})) it(`${file}: repeated calls on one line remain two measured occurrences`, () => {
    const { tmp, rm, idx } = require('./helpers');
    const dir = tmp({ [file]: code });
    try {
        const index = idx(dir), target = index.symbols.get('run')[0];
        const callers = index.findCallers('run', {
            collectAccount: true, includeMethods: true, targetDefinitions: [target],
        });
        assert.equal(callers.length, 2);
        assert.equal(dedupeOccurrences(callers.map(c => ({
            file: c.relativePath, line: c.line, provenance: c.provenance,
            target: c.provenance.facts.targets[0],
        }))).length, 2);
        const callee = index.findCallees(index.symbols.get('use')[0], {
            collectAccount: true, includeMethods: true,
        }).find(c => c.name === 'run');
        assert.equal(new Set(callee.siteProvenance.map(s => s.column)).size, 2);
        assert.deepEqual(callee.siteProvenance.map(s => s.column),
            callers.map(c => c.provenance.facts.site.column));
    } finally { rm(dir); }
});

it('a Rust module export cannot lend its identity to a same-named method in the same file', () => {
    const { tmp, rm, idx } = require('./helpers');
    const dir = tmp({
        'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n',
        'lib.rs': 'mod adapter;\npub use adapter::peek_nth;\nmod usage;',
        'adapter.rs': 'pub struct PeekNth;\npub fn peek_nth() -> PeekNth { PeekNth }\nimpl PeekNth {\n pub fn peek_nth(&self) {}\n}',
        'usage.rs': 'use crate::adapter::peek_nth;\nfn run() {\n let value = peek_nth();\n value.peek_nth();\n let _other = crate::adapter::peek_nth();\n}',
    });
    try {
        const index = idx(dir);
        const caller = index.context('peek_nth', { file: 'adapter.rs', line: 4 });
        assert.ok(!caller.callers.some(c => c.relativePath === 'usage.rs' && [3, 5].includes(c.line)));
        const def = index.symbols.get('run')[0];
        const callees = index.findCallees(def, { collectAccount: true, includeMethods: true });
        const method = callees.find(c => c.name === 'peek_nth' && c.className === 'PeekNth');
        assert.ok(!method || method.sites.every(line => line === 4));
        assert.ok(callees.some(c => c.name === 'peek_nth' && c.type === 'function' && c.sites.includes(3)));
        assert.equal(callees.calleeAccount.conserved, true);
    } finally { rm(dir); }
});


it('replays overload facts and rejects a changed argument witness', () => {
    const { tmp, rm, idx } = require('./helpers');
    const dir = tmp({ 'Fixture.java': [
        'class Local {',
        ' int choose(String value) { return 1; }',
        ' int choose(int value) { return 2; }',
        '}',
        'class Use { int run(Local value) { return value.choose(1); } }',
    ].join('\n') });
    try {
        const index = idx(dir);
        const result = index.context('choose', { file: 'Fixture.java', line: 3 });
        const proof = result.callers[0].provenance;
        const target = proof.facts.targets[0];
        assert.equal(validateConfirmation(proof, target).verdict, 'establishes-target');
        const changed = structuredClone(proof);
        changed.facts.lookup.overload.call.argKinds = ['string'];
        assert.notEqual(validateConfirmation(changed, target).verdict, 'establishes-target');
        const dropped = structuredClone(proof);
        delete dropped.facts.lookup.steps[0].memberDefinitions;
        assert.equal(validateConfirmation(dropped, target).verdict, 'incomplete');
    } finally { rm(dir); }
});

it('an invalid overload call remains visible while verify reports its signature error', () => {
    const { tmp, rm, idx } = require('./helpers');
    const { validateCallMismatch } = require('../core/provenance');
    const dir = tmp({ 'Fixture.java': [
        'class Local {',
        ' int choose(int value) { return 1; }',
        ' int choose(int first, int second) { return 2; }',
        '}',
        'class Use { int run(Local value) { return value.choose(1, 2, 3); } }',
    ].join('\n') });
    try {
        const index = idx(dir);
        const result = index.context('choose', { file: 'Fixture.java', line: 2 });
        assert.equal(result.callers.length, 0);
        const site = result.unverifiedCallers[0];
        assert.equal(site.reason, 'provenance-incomplete');
        const target = site.provenance.facts.targets[0];
        assert.equal(validateCallMismatch(site.provenance, target), true);
        assert.equal(index.verify('choose', { file: 'Fixture.java', line: 2 }).mismatches, 1);
        const changed = structuredClone(site.provenance);
        changed.facts.lookup.overload.call.argCount = 1;
        changed.facts.lookup.overload.call.argKinds = ['int'];
        assert.equal(validateCallMismatch(changed, target), false);
    } finally { rm(dir); }
});

it('receiver import aliases must end at the recorded owner declaration', () => {
    const proof = witness();
    proof.facts.receiverTypeDeclaration = owner;
    proof.facts.receiverImportChain = [{ fromFile: 'app.ts', toFile: 'm.ts',
        localName: 'Alias', importedName: 'Local', declaration: owner }];
    assert.equal(validateConfirmation(proof, method).verdict, 'establishes-target');
    proof.facts.receiverImportChain[0].importedName = 'Other';
    assert.equal(validateConfirmation(proof, method).verdict, 'inconsistent');
});

describe('fix #421: witness captures refuse only what they cannot prove', () => {
    const { captureOverload, ProvenanceRefusal } = require('../core/provenance-overload');
    const { tmp, rm, idx } = require('./helpers');
    it('a refusal yields no witness; an internal error propagates', () => {
        const dir = tmp({ 'A.java': 'class A {\n void f(int v) { }\n void f(String s) { }\n void g() { f(1); }\n}\n' });
        try {
            const index = idx(dir), candidates = index.symbols.get('f');
            const call = { name: 'f', line: 4, argCount: 1, argKinds: ['int'] };
            assert.strictEqual(captureOverload(index, call, candidates, 'java', () => {
                throw new ProvenanceRefusal('Missing provenance fact: x');
            }), null);
            assert.strictEqual(captureOverload(index, call, candidates, 'java', () => {
                throw Object.assign(new Error('unreadable'), { code: 'ENOENT', syscall: 'open' });
            }), null);
            assert.throws(() => captureOverload(index, call, candidates, 'java', () => {
                throw new TypeError('defect');
            }), /defect/);
            const { captureTypeLookup } = require('../core/provenance-type');
            const owner = index.symbols.get('A')[0];
            const original = index.files.get(owner.file).language;
            // A defect inside the type lookup surfaces as one.
            const broken = Object.create(index, { _readFile: { value: () => { throw new TypeError('lookup defect'); } } });
            assert.throws(() => captureTypeLookup(broken, { file: owner.file, relativePath: 'A.java', line: 4, column: 0,
                name: 'A', construction: true }, owner), /lookup defect/);
            assert.strictEqual(index.files.get(owner.file).language, original);
        } finally { rm(dir); }
    });
});
