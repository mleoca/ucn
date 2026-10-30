/**
 * UCN Cache Tests
 *
 * Cache behavior, staleness, F-001/F-003/F-004/F-005, performance, diff-impact.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex, parseDiff } = require('../core/project');
const {
    CACHE_FORMAT_VERSION,
    getUserCacheRoot,
    getProjectCacheDir,
    getProjectCachePath,
    getLegacyProjectCacheDir,
    clearProjectCache,
} = require('../core/cache');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR } = require('./helpers');

describe('fix #415: persisted call-record names', () => {
    const plain = value => JSON.parse(JSON.stringify(value));
    const load = dir => {
        const index = new ProjectIndex(dir);
        assert.ok(index.loadCache());
        return index;
    };
    const noise = Object.fromEntries(Array.from({ length: 18 }, (_, n) => [
        `noise${n}/file.js`, `function extra${n}(){return Math.abs(${n});}`,
    ]));

    it('loads only candidate shards and preserves the native name and file order', () => {
        const dir = tmp({ ...noise,
            'lib/target.js': 'export function target(){return 1;}\nexport class Box {value=1;}',
            'use/caller.js': 'import {target} from "../lib/target.js";\nexport function use(){return target();}',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const expected = plain(index.findCallers('target', { collectAccount: true }));
            // The full record path supplies the reference iteration order.
            const native = load(dir);
            native.loadCallsCache();
            native.buildCalleeIndex();
            const expectedIndex = [...native.calleeIndex].map(([name, files]) => [name, [...files]]);
            const cached = load(dir);
            assert.strictEqual(cached.callsCache.size, 0);
            assert.deepStrictEqual(plain(cached.findCallers('target', { collectAccount: true })), expected);
            assert.ok(cached.callsCache.size > 0);
            assert.ok(cached.callsCache.size < cached.files.size, 'unrelated shards remain unread');
            assert.deepStrictEqual([...cached.calleeIndex].map(([name, files]) => [name, [...files]]), expectedIndex);
            cached.loadCallsCache();
            assert.strictEqual(cached.callsCache.size, cached.files.size);
        } finally { rm(dir); }
    });

    it('negative names avoid record reads while changed source reaches the normal parser', () => {
        const dir = tmp({ ...noise,
            'lib/target.js': 'export function target(){return 1;}\nexport class Box {value=1;}',
            'use/caller.js': 'import {target} from "../lib/target.js";\nexport function use(){return 1;}',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const absent = load(dir);
            assert.deepStrictEqual(absent.findCallers('value'), []);
            assert.strictEqual(absent.callsCache.size, 0, 'a data member has no matching call records');
            const changed = load(dir), caller = path.join(dir, 'use/caller.js');
            fs.writeFileSync(caller, 'import {target} from "../lib/target.js";\nexport function use(){return target();}');
            const time = new Date(Date.now() + 2000);
            fs.utimesSync(caller, time, time);
            const result = changed.findCallers('target', { collectAccount: true });
            assert.ok(result.some(site => site.relativePath === 'use/caller.js' && site.line === 2));
            assert.ok(changed.callsCache.has(caller));
        } finally { rm(dir); }
    });

    it('a fresh in-memory parse wins over older persisted name and call records', () => {
        const dir = tmp({ ...noise,
            'lib/target.js': 'export function target(){return 1;}',
            'use/caller.js': 'import {target} from "../lib/target.js";\nexport function use(){return 1;}',
        });
        try {
            idx(dir).saveCache();
            const index = load(dir), caller = path.join(dir, 'use/caller.js');
            fs.writeFileSync(caller, 'import {target} from "../lib/target.js";\nexport function use(){return target();}');
            const time = new Date(Date.now() + 2000);
            fs.utimesSync(caller, time, time);
            assert.ok(index.getCachedCalls(caller).some(call => call.name === 'target'));
            const fresh = index.callsCache.get(caller);
            const result = index.findCallers('target', { collectAccount: true });
            assert.strictEqual(index.callsCache.get(caller), fresh);
            assert.ok(result.some(site => site.relativePath === 'use/caller.js' && site.line === 2));
        } finally { rm(dir); }
    });

    it('missing, malformed and different-generation names fall back to full record lookup', () => {
        const dir = tmp({ ...noise,
            'lib/target.js': 'export function target(){return 1;}',
            'use/caller.js': 'import {target} from "../lib/target.js";\nexport function use(){return target();}',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const expected = plain(index.findCallers('target', { collectAccount: true }));
            const file = path.join(getProjectCacheDir(dir), 'calls/names.json');
            assert.ok(fs.existsSync(file));
            const saved = fs.readFileSync(file, 'utf8');
            const badId = JSON.parse(saved);
            badId.files[0][2] = [-1];
            const generation = JSON.parse(saved);
            generation.generation += 'different';
            for (const invalid of [null, '{', JSON.stringify(badId), JSON.stringify(generation)]) {
                if (invalid === null) fs.rmSync(file, { force: true });
                else fs.writeFileSync(file, invalid);
                assert.deepStrictEqual(plain(load(dir).findCallers('target', { collectAccount: true })), expected);
            }
        } finally { rm(dir); }
    });

    for (const extension of ['c', 'cpp']) it(`${extension}: expanded macro names survive a cache reload`, () => {
        const dir = tmp({
            'target.h': 'void target(void);\n#define JOIN(N) tar##N()\n',
            [`target.${extension}`]: '#include "target.h"\nvoid target(void) {}\n',
            [`caller.${extension}`]: '#include "target.h"\nvoid use(void) { JOIN(get); }\n',
        });
        try {
            const index = idx(dir);
            const expected = plain(index.findCallers('target', { collectAccount: true }));
            assert.ok(expected.some(site => site.relativePath === `caller.${extension}`));
            index.saveCache();
            assert.deepStrictEqual(plain(load(dir).findCallers('target', { collectAccount: true })), expected);
        } finally { rm(dir); }
    });

    it('Rust pending macro calls retain the fresh query visit set', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname="pending_names"\nversion="0.1.0"\nedition="2021"\n',
            'src/lib.rs': 'macro_rules! caller { ($f:ident) => { pub fn generated() { $f(); } }; }\npub fn target() {}\ncaller!(target);\n',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const first = load(dir), second = load(dir);
            second.loadCallsCache();
            second.buildCalleeIndex();
            const expected = plain(second.findCallers('target', { collectAccount: true }));
            assert.ok(expected.length > 0);
            assert.deepStrictEqual(plain(first.findCallers('target', { collectAccount: true })), expected);
        } finally { rm(dir); }
    });

    it('Rust materialization invalidates names captured from the previous call array', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname="materialized_names"\nversion="0.1.0"\nedition="2021"\n',
            'src/lib.rs': '#[macro_export]\nmacro_rules! relay { ($f:path) => { pub fn generated() { let saved = $f; saved(); } }; }\npub fn target() {}\npub fn direct(){target();}\nmod other;\n',
            'src/other.rs': 'crate::relay!(crate::target);\n',
        });
        try {
            const index = idx(dir), file = path.join(dir, 'src/other.rs');
            index.saveCache();
            assert.ok(index.getCalleeFiles('generated')?.has(file), 'pending expansion has a name hint');
            const raw = index.callsCache.get(file), originalCalls = raw.calls;
            index.getCachedCalls(file);
            assert.strictEqual(index.callsCache.get(file), raw, 'materialization keeps the cache entry');
            assert.notStrictEqual(raw.calls, originalCalls, 'materialization replaces its call array');
            assert.strictEqual(index.files.get(file).rustMacroExpansion.callsPending, false);
            assert.strictEqual(index.getCalleeFiles('generated'), null, 'the hint is absent from derived records');
            index.saveCache();
            const cached = load(dir);
            assert.strictEqual(cached.getCalleeFiles('generated'), null, 'a reload uses the current call array');
        } finally { rm(dir); }
    });

    it('fact indices bypass the name cache before touching its state', () => {
        const names = require('../core/call-name-cache');
        const index = { isProvenanceFactIndex: true };
        Object.defineProperty(index, '_callNameCache', { get() { throw Error('hidden name cache read'); } });
        Object.defineProperty(index, 'callsCache', { get() { throw Error('hidden record cache read'); } });
        assert.strictEqual(names.restore(index), false);
        assert.strictEqual(names.absent(index, 'unused.js', 'target'), false);
        names.capture(index, new Map(), 'unused.js', []);
        names.remember(index, new Map());
        names.save(index, 'unused');
        names.load(index, 'unused');
    });
});

describe('fix #415: rename-token syntax persistence', () => {
    it('a cached C# rename reuses positions while preserving the full plan', () => {
        const dir = tmp({ 'Account.cs': 'class Account {\n public int Run(){return 1;}\n public int Use(){return Run()+this.Run();}\n}' });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const { saveUsageCache } = require('../core/cache');
            const expected = execute(index, 'plan', { name: 'Account.cs:2:Run', renameTo: 'RunZq' });
            assert.strictEqual(expected.ok, true);
            index.saveCache();
            saveUsageCache(index);
            const script = `
                const assert=require('node:assert/strict'),root=${JSON.stringify(PROJECT_DIR)};
                const {ProjectIndex}=require(root+'/core/project'),{execute}=require(root+'/core/execute');
                const {LANGUAGES}=require(root+'/languages');
                const raw=LANGUAGES.csharp.module;let parses=0;
                LANGUAGES.csharp.module=()=>{const m=raw();return{...m,queryTree(...args){parses++;return m.queryTree(...args);}};};
                const index=new ProjectIndex(${JSON.stringify(dir)});assert.ok(index.loadCache());
                const result=execute(index,'plan',{name:'Account.cs:2:Run',renameTo:'RunZq'});
                process.stdout.write(JSON.stringify({parses,result}));
            `;
            const child = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: PROJECT_DIR }));
            assert.deepStrictEqual(child.result, JSON.parse(JSON.stringify(expected)));
            assert.strictEqual(child.parses, 0, 'saved physical positions avoid rebuilding query views');
        } finally { rm(dir); }
    });

    const languages = [
        ['a.js', '/* é😀 */function ping(){return 1;}function useit(){return ping()+ping();}'],
        ['a.ts', '/* é😀 */function ping():number{return 1;}function useit(){return ping()+ping();}'],
        ['a.tsx', '/* é😀 */function ping():number{return 1;}function useit(){return ping()+ping();}'],
        ['a.py', 'def ping():return 1\ndef useit():\n text="é😀";return ping()+ping()'],
        ['a.go', 'package p\n/* é😀 */func ping()int{return 1}\nfunc useit()int{text:="é😀";_=text;return ping()+ping()}'],
        ['a.rs', '/* é😀 */fn ping()->i32{1}fn useit()->i32{ping()+ping()}'],
        ['A.java', 'class A { /* é😀 */static int ping(){return 1;}int useit(){return ping()+ping();}}'],
        ['A.cs', 'class A { /* é😀 */static int ping(){return 1;}int useit(){return ping()+ping();}}'],
        ['a.c', '/* é😀 */int ping(void){return 1;}int useit(void){return ping()+ping();}'],
        ['a.cpp', '/* é😀 */int ping(){return 1;}int useit(){return ping()+ping();}'],
        ['a.html', '<!-- é😀 --><script>function ping(){return 1;}function useit(){return ping()+ping();}</script>'],
        ['Configured.cs', 'interface I { int ping()\n#if DEFAULT_BODY\n{return 1;}\n#else\n;\n#endif\n}\nclass A:I{public int ping(){return 1;}int useit(I other){return other.ping();}}'],
    ];
    for (const [file, source] of languages) it(`${file}: saved positions preserve Unicode, ranges and new spellings`, () => {
        const dir = tmp({ [file]: source });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const { saveUsageCache } = require('../core/cache');
            const def = index.symbols.get('ping')?.[0]; assert.ok(def);
            const name = `${file}:${def.startLine}:ping`;
            const expected = execute(index, 'plan', { name, renameTo: 'pingZq' });
            assert.strictEqual(expected.ok, true);
            index.saveCache(); saveUsageCache(index);
            const script = `
                const assert=require('node:assert/strict'),root=${JSON.stringify(PROJECT_DIR)};
                const {ProjectIndex}=require(root+'/core/project'),{execute}=require(root+'/core/execute');
                const {LANGUAGES}=require(root+'/languages'),dir=${JSON.stringify(dir)},name=${JSON.stringify(name)};
                const first=new ProjectIndex(dir);assert.ok(first.loadCache());
                const repeated=execute(first,'plan',{name,renameTo:'pingZq'});
                assert.deepEqual(JSON.parse(JSON.stringify(repeated)),JSON.parse(require('node:fs').readFileSync(0,'utf8')));
                const changed=new ProjectIndex(dir);assert.ok(changed.loadCache());
                const a=execute(changed,'plan',{name,renameTo:'anotherName'});
                for(const config of Object.values(LANGUAGES))config.traits.physicalCallTokenSyntax=false;
                const native=new ProjectIndex(dir);assert.ok(native.loadCache());
                const b=execute(native,'plan',{name,renameTo:'anotherName'});
                assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
            `;
            execFileSync(process.execPath, ['-e', script], {
                cwd: PROJECT_DIR, input: JSON.stringify(expected),
            });
        } finally { rm(dir); }
    });

    function fixture(source = 'Run();', language = 'javascript') {
        const index = new ProjectIndex(PROJECT_DIR);
        const file = path.join(PROJECT_DIR, 'syntax-fixture.' + language);
        const entry = { language, hash: crypto.createHash('md5').update(source).digest('hex') };
        index.files.set(file, entry);
        index._readFile = () => source;
        index._beginOp();
        return { index, file, entry, source, reset() { index._endOp(); index._beginOp(); } };
    }

    it('same-line call ranges retain distinct physical tokens after an operation', () => {
        const { callTokenSyntax } = require('../core/rename-token-syntax');
        const f = fixture('Run(Run());');
        let derives = 0;
        const run = (range, column) => callTokenSyntax(f.index, f.file, f.entry,
            f.source, range, 'Run', 1, () => { derives++; return column; });
        try {
            assert.strictEqual(run({ start: 0, end: 10 }, 0), 0);
            assert.strictEqual(run({ start: 4, end: 9 }, 4), 4);
            f.reset();
            assert.strictEqual(run({ start: 4, end: 9 }, 4), 4);
            assert.strictEqual(run({ start: 0, end: 10 }, 0), 0);
            assert.strictEqual(derives, 2);
        } finally { f.index._endOp(); }
    });

    it('source hashes and parse views invalidate saved call positions', () => {
        const { callTokenSyntax } = require('../core/rename-token-syntax');
        const f = fixture();
        let derives = 0;
        const run = source => callTokenSyntax(f.index, f.file, f.entry, source,
            { start: 0, end: 5 }, 'Run', 1, () => { derives++; return 0; });
        try {
            run(f.source); f.reset(); run(f.source);
            assert.strictEqual(derives, 1);
            f.reset(); f.entry.conditionalViews = [{ start: 1, end: 1 }]; run(f.source);
            assert.strictEqual(derives, 2, 'a changed source view needs its own native proof');
            f.reset(); run(f.source + '\n');
            assert.strictEqual(derives, 3, 'a mismatching source hash is never reused');
        } finally { f.index._endOp(); }
    });

    it('malformed, duplicate and misspelled saved positions fall back to native syntax', () => {
        const { callTokenSyntax } = require('../core/rename-token-syntax');
        const { storeUsageResult } = require('../core/cache');
        const f = fixture('Run();Run();'); let derives = 0;
        const run = () => callTokenSyntax(f.index, f.file, f.entry, f.source,
            { start: 6, end: 11 }, 'Run', 1, () => { derives++; return 6; });
        try {
            run();
            const key = [...f.index._usageResultCache.keys()][0];
            const mode = key.split('\0')[3];
            for (const bad of [[['bad']], [[6, 11, 1, 7]], [[6, 11, 1, 6], [6, 11, 1, 6]], [[6, 11, 1, 0]]]) {
                storeUsageResult(f.index, f.file, 'Run', mode, bad);
                f.reset(); assert.strictEqual(run(), 6);
            }
            assert.strictEqual(derives, 5);
        } finally { f.index._endOp(); }
    });

    it('declaration descriptions are canonical inputs and remain separate from new spellings', () => {
        const { declarationTokenSyntax } = require('../core/rename-token-syntax');
        const f = fixture('class C { int Run() => Run(); }', 'csharp');
        const column = f.source.indexOf('Run'); let derives = 0;
        const run = (definition, allIdentifiers = true) => {
            const syntax = declarationTokenSyntax(f.index, f.file, f.entry,
                f.source, 1, 'Run', definition, allIdentifiers);
            if (syntax?.columns) return syntax.columns;
            derives++;
            const columns = [allIdentifiers ? column : f.source.lastIndexOf('Run')];
            syntax?.save(columns);
            return columns;
        };
        try {
            assert.deepStrictEqual(run({ name: 'Run', startLine: 1, type: 'method' }), [column]);
            f.reset();
            assert.deepStrictEqual(run({ type: 'method', startLine: 1, name: 'Run' }), [column]);
            assert.strictEqual(derives, 1, 'object property order does not change identity');
            f.reset();
            assert.deepStrictEqual(run({ name: 'Run', startLine: 1, type: 'method' }, false),
                [f.source.lastIndexOf('Run')]);
            assert.strictEqual(derives, 2, 'call-only and all-identifier selections stay separate');
            f.reset(); run({ name: 'Run', startLine: 1, type: 'method', namespace: 'Other' });
            assert.strictEqual(derives, 3, 'the current declaration description is checked anew');
        } finally { f.index._endOp(); }
    });

    it('unknown adapters and provenance snapshots retain their original derivation path', () => {
        const { callTokenSyntax } = require('../core/rename-token-syntax');
        for (const [language, fact] of [['unregistered', false], ['javascript', true]]) {
            const f = fixture('Run();', language); f.index.isProvenanceFactIndex = fact;
            if (fact) Object.defineProperty(f.index, '_peekParsedTree', {
                get() { throw new Error('query cache accessed through a provenance snapshot'); },
            });
            let derives = 0;
            try {
                for (let n = 0; n < 2; n++) callTokenSyntax(f.index, f.file, f.entry,
                    f.source, { start: 0, end: 5 }, 'Run', 1, () => { derives++; return 0; });
                assert.strictEqual(derives, 2);
                assert.strictEqual(f.index._usageResultCache.size, 0);
            } finally { f.index._endOp(); }
        }
    });
});

describe('fix #415: lexical scope memos preserve declaration positions', () => {
    const { getParser, safeParse } = require('../languages');
    const { referenceScope } = require('../languages/lexical-scope');
    // Both grammars enter the common lexical API through the C adapter.
    for (const language of ['c', 'cpp']) {
        it(`${language}: reverse queries retain earlier global and later local bindings`, () => {
            const source = 'void mark(void);\nvoid use(void){\n mark();\n {\n  mark();\n  int mark=0;\n  mark;\n  {\n   void mark(void);\n   mark();\n  }\n  mark;\n }\n mark();\n}';
            const expected = ['module', 'module', { local: true, defRows: null },
                'unknown', { local: true, defRows: null }, 'module'];
            const memo = new Map();
            for (const changed of [false, true]) {
                const tree = safeParse(getParser(language), changed ? source.replace('int mark=0;', 'int other=0;') : source);
                const nodes = tree.rootNode.descendantsOfType('identifier').filter(node =>
                    node.text === 'mark' && ['call_expression', 'expression_statement'].includes(node.parent?.type));
                assert.strictEqual(nodes.length, expected.length);
                const answers = changed ? expected.map((answer, i) => i === 2 || i === 4 ? 'module' : answer) : expected;
                for (const order of [[5, 4, 3, 2, 1, 0], [0, 1, 2, 3, 4, 5], [2, 0, 5, 1, 4, 3]]) {
                    for (const i of order) assert.deepStrictEqual(referenceScope(nodes[i], 'c', memo, 'mark'), answers[i]);
                }
            }
        });
        it(`${language}: a declaration affects only the later token on the same line`, () => {
            const tree = safeParse(getParser(language), 'void mark(void); void use(void){ mark(); int mark=0; mark; }');
            const nodes = tree.rootNode.descendantsOfType('identifier').filter(node =>
                node.text === 'mark' && ['call_expression', 'expression_statement'].includes(node.parent?.type));
            assert.strictEqual(nodes.length, 2);
            const memo = new Map();
            assert.deepStrictEqual(referenceScope(nodes[1], 'c', memo, 'mark'), { local: true, defRows: null });
            assert.strictEqual(referenceScope(nodes[0], 'c', memo, 'mark'), 'module');
            assert.deepStrictEqual(referenceScope(nodes[1], 'c', memo, 'mark'), { local: true, defRows: null });
        });
    }
});

describe('fix #415: contract syntax caches retain current bindings', () => {
    const contract = require('../core/contract-membership');
    const fixtures = ['java', 'js', 'ts', 'tsx'].map(ext => ({ ext,
        base: ext === 'java' ? 'Base.java' : `base.${ext}`,
        other: ext === 'java' ? 'Other.java' : `other.${ext}`,
        use: ext === 'java' ? 'Use.java' : `use.${ext}`,
        baseSource: ext === 'java' ? 'public class Base { public void run(){} }'
            : 'export class Base { run(){} }',
        otherSource: ext === 'java' ? 'class Other {}' : 'export class Other {}',
        inherited: ext === 'java' ? 'class Other extends Base {}'
            : `import {Base} from './base'; export class Other extends Base {}`,
        ordinary: ext === 'java' ? 'class Use { void read(Base value){value.run();} }'
            : `import {Base} from './base'; const value=new Base(); value.run();`,
        anonymous: ext === 'java' ? 'class Use { Other value=new Other(){public void run(){}}; }'
            : `import {Other} from './other'; const Value=class extends Other { run(){} };`,
    }));
    const readAnonymous = (index, fixture) => {
        index._beginOp();
        try {
            const pin = (index.symbols.get('run') || []).find(d => d.relativePath === fixture.base);
            assert.ok(pin);
            const hierarchy = contract.hierarchySlotClosure(index, pin);
            return contract.anonymousSlotMembers(index, 'run',
                new Map([[path.join(index.root, fixture.use), new Set([1])]]), hierarchy, pin);
        } finally { index._endOp(); }
    };
    const save = index => { index.saveCache(); index.saveUsageCache(); };
    for (const fixture of fixtures) {
        it(`${fixture.ext}: persisted absence avoids repeating an anonymous-member parse`, () => {
            const dir = tmp({ [fixture.base]: fixture.baseSource, [fixture.use]: fixture.ordinary });
            try {
                const index = idx(dir);
                assert.deepStrictEqual(readAnonymous(index, fixture), []);
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                let parses = 0;
                const original = loaded._getParsedTree;
                loaded._getParsedTree = function(file, ...args) {
                    if (file === path.join(dir, fixture.use)) parses++;
                    return original.call(this, file, ...args);
                };
                assert.deepStrictEqual(readAnonymous(loaded, fixture), []);
                assert.strictEqual(parses, 0);
            } finally { rm(dir); }
        });
        it(`${fixture.ext}: another file can bring a source member into the slot`, () => {
            const dir = tmp({ [fixture.base]: fixture.baseSource,
                [fixture.other]: fixture.otherSource, [fixture.use]: fixture.anonymous });
            try {
                const index = idx(dir);
                assert.deepStrictEqual(readAnonymous(index, fixture), []);
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                fs.writeFileSync(path.join(dir, fixture.other), fixture.inherited);
                loaded.build(null, { quiet: true });
                const actual = readAnonymous(loaded, fixture);
                assert.ok(actual.some(site => site.verdict === 'edit'));
                const fresh = idx(dir);
                fresh._usageResultCache = null;
                assert.deepStrictEqual(actual, readAnonymous(fresh, fixture));
            } finally { rm(dir); }
        });
    }
    const macroSource = 'macro_rules! forward { () => { fn run(&self){ self.run(); } }; }\nstruct A; impl A { forward!(); }';
    const readRust = index => {
        index._beginOp();
        try { return contract.rustMacroTemplateSites(index, 'run', [path.join(index.root, 'lib.rs')]); }
        finally { index._endOp(); }
    };
    it('Rust: template syntax survives reload without aliasing returned owner objects', () => {
        const dir = tmp({ 'lib.rs': macroSource });
        try {
            const index = idx(dir), expected = readRust(index);
            assert.ok(expected.some(site => site.shape === 'definition'));
            assert.ok(expected.some(site => site.shape === 'method-call'));
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            let parses = 0;
            const original = loaded._getParsedTree;
            loaded._getParsedTree = function(...args) { parses++; return original.apply(this, args); };
            const actual = readRust(loaded);
            assert.deepStrictEqual(actual, expected);
            assert.strictEqual(parses, 0);
            actual[0].owners[0].kind = 'changed-by-consumer';
            assert.deepStrictEqual(readRust(loaded), expected);
        } finally { rm(dir); }
    });
    it('Rust: changed template source invalidates the persisted syntax', () => {
        const dir = tmp({ 'lib.rs': macroSource });
        try {
            const index = idx(dir);
            readRust(index);
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            fs.writeFileSync(path.join(dir, 'lib.rs'), macroSource.replaceAll('run', 'other'));
            loaded.build(null, { quiet: true });
            assert.deepStrictEqual(readRust(loaded), []);
        } finally { rm(dir); }
    });
    it('Rust: malformed template facts use native syntax', () => {
        const dir = tmp({ 'lib.rs': macroSource });
        try {
            const index = idx(dir), expected = readRust(index);
            save(index);
            const saved = path.join(getProjectCacheDir(dir), 'usage-results.json');
            const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
            let changed = 0;
            for (const item of payload.entries) if (item[3].startsWith('contract-syntax-v1:rust-template:')) {
                item[4] = [{ line: 'invalid' }];
                changed++;
            }
            assert.ok(changed > 0);
            fs.writeFileSync(saved, JSON.stringify(payload));
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(readRust(loaded), expected);
        } finally { rm(dir); }
    });
});

describe('fix #415: usage text classifications are source-local', () => {
    const fixtures = [
        ['sample.js', 'function needle(){}\n// needle\nconst text="needle";\nneedle();'],
        ['sample.ts', 'function needle():void{}\n// needle\nconst text:string="needle";\nneedle();'],
        ['sample.py', 'def needle(): pass\n# needle\ntext="needle"\nneedle()'],
        ['sample.go', 'package sample\nfunc needle(){}\n// needle\nvar text="needle"\nfunc read(){needle()}'],
        ['sample.rs', 'fn needle(){}\n// needle\nconst TEXT:&str="needle";\nfn read(){needle();}'],
        ['Sample.java', 'class Sample { static void needle(){}\n// needle\nString text="needle";\nvoid read(){needle();}\n}'],
        ['sample.cs', 'class Sample { static void needle(){}\n// needle\nstring text="needle";\nvoid Read(){needle();}\n}'],
        ['sample.c', 'void needle(void){}\n/* needle */\nconst char *text="needle";\nvoid read(void){needle();}'],
        ['sample.cpp', 'void needle(){}\n/* needle */\nconst char *text="needle";\nvoid read(){needle();}'],
        ['sample.html', '<div>needle</div>\n<script>function needle(){}\n// needle\nconst text="needle";\nneedle();</script>'],
    ];
    const read = (index, options = {}) => JSON.parse(JSON.stringify(index.usages('needle', options)));
    const save = index => { index.saveCache(); index.saveUsageCache(); };
    for (const [file, source] of fixtures) {
        it(`${file}: reload reuses native text decisions with both usage modes`, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir);
                const options = [{}, { internalEvidence: true, context: 2 }, { codeOnly: true }];
                const expected = options.map(option => read(index, option));
                assert.ok(expected[0].some(usage => usage.usageType === 'text'));
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                let nativeCalls = 0;
                const original = loaded.isCommentOrStringAtPosition;
                loaded.isCommentOrStringAtPosition = function(...args) {
                    nativeCalls++;
                    return original.apply(this, args);
                };
                options.forEach((option, i) => assert.deepStrictEqual(read(loaded, option), expected[i]));
                assert.strictEqual(nativeCalls, 0);
            } finally { rm(dir); }
        });
        it(`${file}: changed source invalidates saved text positions`, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir);
                read(index);
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                fs.writeFileSync(path.join(dir, file), source.replaceAll('needle', 'other'));
                loaded.build(null, { quiet: true });
                assert.deepStrictEqual(read(loaded), []);
            } finally { rm(dir); }
        });
        it(`${file}: malformed saved text facts use native classification`, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir), expected = read(index);
                save(index);
                const saved = path.join(getProjectCacheDir(dir), 'usage-results.json');
                const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
                let changed = 0;
                for (const item of payload.entries) {
                    if (item[3].startsWith('usage-text-v2:')) {
                        item[4] = [[1, 0, 'invalid-kind']];
                        changed++;
                    }
                }
                assert.ok(changed > 0);
                fs.writeFileSync(saved, JSON.stringify(payload));
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                let nativeCalls = 0;
                const original = loaded.isCommentOrStringAtPosition;
                loaded.isCommentOrStringAtPosition = function(...args) {
                    nativeCalls++;
                    return original.apply(this, args);
                };
                assert.deepStrictEqual(read(loaded), expected);
                assert.ok(nativeCalls > 0);
            } finally { rm(dir); }
        });
    }
});

describe('fix #415: cached enum syntax resolves current project bindings', () => {
    const { execute } = require('../core/execute');
    const cache = require('../core/cache');
    const fixtures = [
        { label: 'Java', pin: 'p/Mode.java', consumer: 'u/Use.java', files: {
            'p/Mode.java': 'package p; public enum Mode { Ready }',
            'q/Other.java': 'package q; public class Other {}',
            'u/Use.java': 'package u; import p.*; import q.*; class Use { int read(){return Mode.Ready.ordinal();} }',
        }, mutate(dir) {
            fs.writeFileSync(path.join(dir, 'q/Mode.java'), 'package q; public enum Mode { Ready }');
        }, review: true },
        { label: 'C#', pin: 'a.cs', consumer: 'use.cs', files: {
            'a.cs': 'namespace A { public enum Mode { Ready } }',
            'b.cs': 'namespace B { public enum Mode { Ready } }',
            'global.cs': 'global using A;',
            'use.cs': 'namespace App { class Use { int Read(){return (int)Mode.Ready;} } }',
        }, mutate(dir) {
            fs.writeFileSync(path.join(dir, 'global.cs'), 'global using B;');
        } },
        { label: 'Rust', pin: 'src/p.rs', consumer: 'src/user.rs', files: {
            'Cargo.toml': '[package]\nname="enum_syntax"\nversion="0.1.0"\nedition="2021"',
            'src/lib.rs': 'pub mod p; pub mod q; pub mod user; pub use p::Mode;',
            'src/p.rs': 'pub enum Mode { Ready }',
            'src/q.rs': 'pub enum Mode { Ready }',
            'src/user.rs': 'use crate::Mode; pub fn read()->Mode { Mode::Ready }',
        }, mutate(dir) {
            fs.writeFileSync(path.join(dir, 'src/lib.rs'), 'pub mod p; pub mod q; pub mod user; pub use q::Mode;');
        } },
    ];
    fixtures.push({ label: 'C# project imports', pin: 'a.cs', consumer: 'use.cs', files: {
        'a.cs': 'namespace A { public enum Mode { Ready } }',
        'b.cs': 'namespace B { public enum Mode { Ready } }',
        'Project.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Using Include="A"/></ItemGroup></Project>',
        'use.cs': 'namespace App { class Use { int Read(){return (int)Mode.Ready;} } }',
    }, mutate(dir) {
        fs.writeFileSync(path.join(dir, 'Project.csproj'), this.files['Project.csproj'].replace('Include="A"', 'Include="B"'));
    } });
    const read = (index, fixture) => {
        const def = (index.symbols.get('Ready') || []).find(d => d.relativePath === fixture.pin);
        assert.ok(def);
        const answer = execute(index, 'plan', { name: `${fixture.pin}:${def.startLine}:Ready`, renameTo: 'Changed' });
        assert.ok(answer.ok, answer.error);
        assert.ok(answer.result.account.conserved);
        return JSON.parse(JSON.stringify(answer.result));
    };
    const save = index => { index.saveCache(); index.saveUsageCache(); };
    const native = (dir, fixture) => {
        const index = idx(dir);
        index._usageResultCache = null;
        return read(index, fixture);
    };
    for (const fixture of fixtures) {
        it(`${fixture.label}: reload keeps every public value decision`, () => {
            const dir = tmp(fixture.files), original = cache.getUsageResult;
            try {
                const index = idx(dir), expected = read(index, fixture);
                assert.ok(expected.changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                let hits = 0;
                cache.getUsageResult = (...args) => {
                    const value = original(...args);
                    if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                        value !== undefined) hits++;
                    return value;
                };
                assert.deepStrictEqual(read(loaded, fixture), expected);
                assert.ok(hits > 0, 'the loaded query reaches the persisted syntax facts');
            } finally { cache.getUsageResult = original; rm(dir); }
        });
        it(`${fixture.label}: changed project bindings are resolved after a syntax hit`, () => {
            const dir = tmp(fixture.files), original = cache.getUsageResult;
            try {
                const index = idx(dir);
                assert.ok(read(index, fixture).changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                fixture.mutate(dir);
                loaded.build(null, { quiet: true });
                let hits = 0;
                cache.getUsageResult = (...args) => {
                    const value = original(...args);
                    if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                        value !== undefined) hits++;
                    return value;
                };
                const answer = read(loaded, fixture);
                assert.ok(hits > 0, 'unchanged consumer syntax is reused after a different file changes');
                assert.ok(!answer.changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
                if (fixture.review) assert.ok(answer.changes.some(c => c.file === fixture.consumer && c.needsReview));
                assert.deepStrictEqual(answer, native(dir, fixture));
            } finally { cache.getUsageResult = original; rm(dir); }
        });
        it(`${fixture.label}: a changed consumer's type parameter cannot borrow an enum`, () => {
            const dir = tmp(fixture.files), original = cache.getUsageResult;
            try {
                const index = idx(dir);
                read(index, fixture);
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                const shadow = fixture.label === 'Java'
                    ? 'package u; import p.*; import q.*; class Flags { static final int Ready=1; } class Use { <Mode extends Flags> int read(){return Mode.Ready;} }'
                    : fixture.label === 'Rust'
                    ? 'use crate::Mode; pub trait Flags: Sized { const Ready: Self; } pub fn read<Mode:Flags>()->Mode { Mode::Ready }'
                    : 'namespace App { interface IFlags<T> where T:IFlags<T> { static abstract int Ready {get;} } class Use { int Read<Mode>() where Mode:IFlags<Mode> {return Mode.Ready;} } }';
                fs.writeFileSync(path.join(dir, fixture.consumer), shadow);
                loaded.build(null, { quiet: true });
                let hits = 0;
                cache.getUsageResult = (...args) => {
                    const value = original(...args);
                    if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                        value !== undefined) hits++;
                    return value;
                };
                const answer = read(loaded, fixture);
                assert.strictEqual(hits, 0, 'changed source does not reuse its earlier syntax');
                assert.ok(!answer.changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
                assert.ok(answer.changes.some(c => c.file === fixture.consumer && c.needsReview));
                assert.deepStrictEqual(answer, native(dir, fixture));
                const hash = loaded.files.get(path.join(dir, fixture.consumer)).hash;
                assert.ok(![...loaded._usageResultCache.keys()].some(key => {
                    const parts = key.split('\0');
                    return parts[0] === path.join(dir, fixture.consumer) && parts[1] === hash &&
                        parts[3]?.startsWith('enum-syntax-v2:');
                }), 'a type-parameter shadow is not an eligible static enum source form');
            } finally { cache.getUsageResult = original; rm(dir); }
        });
        it(`${fixture.label}: malformed saved syntax falls back to native parsing`, () => {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir), expected = read(index, fixture);
                save(index);
                const file = path.join(getProjectCacheDir(dir), 'usage-results.json');
                const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
                let changed = 0;
                for (const item of payload.entries) {
                    if (item[0] === fixture.consumer && item[3].startsWith('enum-syntax-v2:')) {
                        item[4] = [1, [], [{}]];
                        changed++;
                    }
                }
                assert.ok(changed > 0);
                fs.writeFileSync(file, JSON.stringify(payload));
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                assert.deepStrictEqual(read(loaded, fixture), expected);
            } finally { rm(dir); }
        });
    }
    for (const fixture of fixtures.slice(0, 3)) {
        it(`${fixture.label}: cached Unicode syntax preserves exact source columns`, () => {
            const files = Object.fromEntries(Object.entries(fixture.files).map(([file, source]) =>
                [file, file.endsWith('.toml') ? source : '/*😀*/ ' + source.replaceAll('Mode', 'Möde')]));
            const dir = tmp(files);
            const { EnumReferenceSyntax } = require('../core/enum-reference-syntax');
            const original = EnumReferenceSyntax.prototype.read;
            try {
                const index = idx(dir), expected = read(index, fixture);
                assert.ok(expected.changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                let hits = 0;
                EnumReferenceSyntax.prototype.read = function(file, ...args) {
                    const result = original.call(this, file, ...args);
                    if (result && file === path.join(dir, fixture.consumer)) hits++;
                    return result;
                };
                assert.deepStrictEqual(read(loaded, fixture), expected);
                assert.ok(hits > 0);
                assert.deepStrictEqual(read(loaded, fixture), native(dir, fixture));
            } finally { EnumReferenceSyntax.prototype.read = original; rm(dir); }
        });
    }
    it('Rust: cached unresolved Self qualifiers preserve native review reasons', () => {
        const fixture = fixtures.find(f => f.label === 'Rust');
        const dir = tmp({ ...fixture.files, 'src/user.rs':
            'use crate::Mode; impl Mode { pub fn read()->Self { Self::Ready } }' });
        const { EnumReferenceSyntax } = require('../core/enum-reference-syntax');
        const original = EnumReferenceSyntax.prototype.read;
        try {
            const index = idx(dir), expected = read(index, fixture);
            assert.ok(expected.changes.some(c => c.file === fixture.consumer && c.needsReview));
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            let hits = 0;
            EnumReferenceSyntax.prototype.read = function(file, ...args) {
                const result = original.call(this, file, ...args);
                if (result && file === path.join(dir, fixture.consumer)) hits++;
                return result;
            };
            assert.deepStrictEqual(read(loaded, fixture), expected);
            assert.ok(hits > 0);
            assert.deepStrictEqual(read(loaded, fixture), native(dir, fixture));
        } finally { EnumReferenceSyntax.prototype.read = original; rm(dir); }
    });
    it('C#: cached syntax preserves the namespace of each conditional body', () => {
        const fixture = fixtures.find(f => f.label === 'C#');
        const source = '#if FIRST\nnamespace X {\n using A;\n class Use { int Read(){return (int)Mode.Ready;} }\n}\n#else\nnamespace Y {\n using B;\n class Use { int Read(){return (int)Mode.Ready;} }\n}\n#endif';
        const dir = tmp({ ...fixture.files, 'global.cs': '', 'use.cs': source }), original = cache.getUsageResult;
        try {
            const index = idx(dir), expected = read(index, fixture);
            assert.ok(expected.changes.some(c => c.file === 'use.cs' && c.line === 4 && c.newExpression && !c.needsReview));
            assert.ok(!expected.changes.some(c => c.file === 'use.cs' && c.line === 9 && c.newExpression));
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            let hits = 0;
            cache.getUsageResult = (...args) => {
                const value = original(...args);
                if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                    value !== undefined) hits++;
                return value;
            };
            assert.deepStrictEqual(read(loaded, fixture), expected);
            assert.ok(hits > 0);
            assert.deepStrictEqual(read(loaded, fixture), native(dir, fixture));
        } finally { cache.getUsageResult = original; rm(dir); }
    });
    it('Rust: cached macro syntax retains unresolved value review', () => {
        const fixture = fixtures.find(f => f.label === 'Rust');
        const files = { ...fixture.files, 'src/user.rs':
            'use crate::Mode; macro_rules! value { () => { Mode::Ready } } pub fn read()->Mode { value!() }' };
        const dir = tmp(files), original = cache.getUsageResult;
        try {
            const index = idx(dir), expected = read(index, fixture);
            assert.ok(expected.changes.some(c => c.file === fixture.consumer && c.needsReview));
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            let hits = 0;
            cache.getUsageResult = (...args) => {
                const value = original(...args);
                if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                    value !== undefined) hits++;
                return value;
            };
            assert.deepStrictEqual(read(loaded, fixture), expected);
            assert.ok(hits > 0);
            assert.deepStrictEqual(read(loaded, fixture), native(dir, fixture));
        } finally { cache.getUsageResult = original; rm(dir); }
    });
    it('C#: a field in another partial part shadows a cached type qualifier', () => {
        const fixture = fixtures.find(f => f.label === 'C#');
        const files = { ...fixture.files, 'use.cs': fixture.files['use.cs'].replace('class Use', 'partial class Use') };
        const dir = tmp(files), original = cache.getUsageResult;
        try {
            const index = idx(dir);
            read(index, fixture);
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            fs.writeFileSync(path.join(dir, 'part.cs'), 'namespace App { class Holder { public int Ready=2; } partial class Use { static Holder Mode=new Holder(); } }');
            loaded.build(null, { quiet: true });
            let hits = 0;
            cache.getUsageResult = (...args) => {
                const value = original(...args);
                if (args[1] === path.join(dir, fixture.consumer) && args[3]?.startsWith('enum-syntax-v2:') &&
                    value !== undefined) hits++;
                return value;
            };
            const answer = read(loaded, fixture);
            assert.ok(hits > 0);
            assert.ok(!answer.changes.some(c => c.file === fixture.consumer && c.newExpression && !c.needsReview));
            assert.deepStrictEqual(answer, native(dir, fixture));
        } finally { cache.getUsageResult = original; rm(dir); }
    });
});

describe('fix #415: persisted class syntax facts preserve fresh field ownership', () => {
    const { execute } = require('../core/execute');
    const { formatPublicJson } = require('../core/output/public');
    const cache = require('../core/cache');
    const base = 'class Device:\n def ping(self): return 1\nclass Other:\n def ping(self): return 2\n' +
        'class Parent:\n def __init__(self): self.worker = Device()\n';
    const child = 'from base import Parent\nclass Child(Parent):\n def run(self): return self.worker.ping()\n';
    const read = (index, name = 'base.py:2:ping') => {
        const execution = execute(index, 'context', { name });
        assert.ok(execution.ok, execution.error);
        return { result: execution.result, text: formatPublicJson('context', execution.result,
            { name }, { surface: 'cli', projectRoot: index.root }) };
    };
    const save = index => { index.saveCache(); index.saveUsageCache(); };

    it('replays class facts after reload with identical public answers', () => {
        const dir = tmp({ 'base.py': base, 'child.py': child });
        const original = cache.getUsageResult;
        try {
            const index = idx(dir), before = read(index);
            assert.strictEqual(before.result.callers.length, 1);
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            let hits = 0;
            cache.getUsageResult = (...args) => {
                const value = original(...args);
                if (args[3]?.startsWith('class-fields-v1:') && value !== undefined) hits++;
                return value;
            };
            assert.strictEqual(read(loaded).text, before.text);
            assert.ok(hits > 0, 'the loaded query reuses class syntax facts');
        } finally {
            cache.getUsageResult = original;
            rm(dir);
        }
    });

    it('invalidates member, write and dynamic-store facts after source edits', () => {
        for (const addition of [' worker = None\n', ' def change(self): self.worker = None\n',
            " def change(self): setattr(self, 'worker', None)\n"]) {
            const dir = tmp({ 'base.py': base, 'child.py': child });
            try {
                const index = idx(dir);
                assert.strictEqual(read(index).result.callers.length, 1);
                save(index);
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                fs.writeFileSync(path.join(dir, 'child.py'), child.replace(' def run', addition + ' def run'));
                loaded.build(null, { quiet: true });
                const after = read(loaded);
                assert.strictEqual(after.result.callers.length, 0, addition);
                assert.strictEqual(after.text, read(idx(dir)).text, addition);
            } finally { rm(dir); }
        }
    });

    it('reuses unchanged class syntax while resolving changed parent ownership afresh', () => {
        const dir = tmp({ 'base.py': base, 'child.py': child });
        const original = cache.getUsageResult;
        try {
            const index = idx(dir);
            assert.strictEqual(read(index).result.callers.length, 1);
            save(index);
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            fs.writeFileSync(path.join(dir, 'base.py'), base.replace('self.worker = Device()', 'self.worker = Other()'));
            loaded.build(null, { quiet: true });
            let hits = 0;
            cache.getUsageResult = (...args) => {
                const value = original(...args);
                if (args[1] === path.join(dir, 'child.py') && args[3]?.startsWith('class-fields-v1:') &&
                    value !== undefined) hits++;
                return value;
            };
            const after = read(loaded);
            assert.strictEqual(after.result.callers.length, 0);
            assert.strictEqual(after.text, read(idx(dir)).text);
            assert.ok(hits > 0, 'unchanged child syntax stays reusable after parent edits');
            assert.strictEqual(read(loaded, 'base.py:4:ping').result.callers.length, 1);
        } finally {
            cache.getUsageResult = original;
            rm(dir);
        }
    });
});

describe('fix #415: persisted local value proofs preserve fresh rename decisions', () => {
    const { execute } = require('../core/execute');
    const cache = require('../core/cache');
    const proofs = index => [...index._usageResultCache].filter(([key]) =>
        key.split('\0')[3]?.startsWith('value-local-v3:'));
    const plan = (index, name) => {
        const result = execute(index, 'plan', { name, renameTo: 'changed' });
        assert.ok(result.ok, result.error);
        assert.ok(result.result.account.conserved);
        return JSON.parse(JSON.stringify(result));
    };
    const fixtures = [
        ['JavaScript', 'a.js', 'class Counter { count=1; }',
            'b.js', 'function shadow(count) { return count; }'],
        ['TypeScript', 'a.ts', 'export class Counter { count:number=1; }',
            'b.ts', 'function shadow(count:number) { return count; }'],
        ['TSX', 'a.tsx', 'export class Counter { count:number=1; }',
            'b.tsx', 'function shadow(count:number) { return count; }'],
        ['Go', 'a.go', 'package p\nvar count int',
            'b.go', 'package p\nfunc shadow(count int) int { return count }'],
        ['Rust', 'src/lib.rs', 'pub struct Counter { pub count:i32 }\npub mod other;',
            'src/other.rs', 'pub fn shadow(count:i32)->i32 { count }'],
        ['Java', 'A.java', 'class Counter { int count; }',
            'B.java', 'class Other { int shadow(int count) { return count; } }'],
        ['C#', 'A.cs', 'class Counter { public int count; }',
            'B.cs', 'class Other { int Shadow(int count) { return count; } }'],
        ['C', 'a.c', 'int count;', 'b.c', 'int shadow(int count) { return count; }'],
        ['C++', 'a.cpp', 'int count;', 'b.cpp', 'int shadow(int count) { return count; }'],
    ];
    for (const [label, file, source, foreign, local] of fixtures) {
        it(`${label}: reloads local shadows without retaining ownership decisions`, () => {
            const dir = tmp({ [file]: source, [foreign]: local,
                ...(label === 'Rust' && { 'Cargo.toml':
                    '[package]\nname="local_proofs"\nversion="0.1.0"\nedition="2021"' }) });
            try {
                const index = idx(dir);
                const definition = index.symbols.get('count').find(def => def.relativePath === file);
                const handle = `${file}:${definition.startLine}:count`;
                const expected = plan(index, handle);
                assert.ok(expected.result.changes.some(change => change.file === file &&
                    change.newExpression?.includes('changed')));
                assert.ok(!expected.result.changes.some(change => change.file === foreign));
                const stored = proofs(index);
                assert.strictEqual(stored.length, 1);
                assert.strictEqual(stored[0][0].split('\0')[0], path.join(dir, foreign));
                assert.ok(stored[0][1].value.some(record => record[0] === 'reference' &&
                    record[4] === 'local-binding'));
                assert.ok(stored[0][1].value.every(record => ['line', 'reference'].includes(record[0])));
                index.saveCache();
                index.saveUsageCache();
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                assert.deepStrictEqual(proofs(loaded), stored);
                let hits = 0;
                const read = cache.getUsageResult;
                cache.getUsageResult = (...args) => {
                    const result = read(...args);
                    if (args[3]?.startsWith('value-local-v3:') && result) hits++;
                    return result;
                };
                try { assert.deepStrictEqual(plan(loaded, handle), expected); }
                finally { cache.getUsageResult = read; }
                assert.ok(hits > 0, 'the saved local proof must actually be replayed');
            } finally { clearProjectCache(dir); rm(dir); }
        });
    }

    it('rechecks changed files and turns a previous shadow into an actual global edit', () => {
        const dir = tmp({ 'a.go': 'package p\nvar count int',
            'b.go': 'package p\nfunc read(count int) int { return count }' });
        try {
            const index = idx(dir);
            plan(index, 'a.go:2:count');
            assert.strictEqual(proofs(index).length, 1);
            fs.writeFileSync(path.join(dir, 'b.go'), 'package p\nfunc read() int { return count }');
            index.build(null, { quiet: true });
            const changed = plan(index, 'a.go:2:count');
            assert.ok(changed.result.changes.some(change => change.file === 'b.go' && change.line === 2 &&
                change.newExpression === 'func read() int { return changed }' && !change.needsReview));
            assert.deepStrictEqual(changed, plan(idx(dir), 'a.go:2:count'));
        } finally { clearProjectCache(dir); rm(dir); }
    });

    it('reuses only the local shadow when the pinned member changes', () => {
        const dir = tmp({ 'a.ts': 'export class First { count=1; }',
            'b.ts': 'export class Second { count=2; }',
            'local.ts': 'function shadow(count:number) { return count; }' });
        try {
            const index = idx(dir);
            plan(index, 'a.ts:1:count');
            assert.strictEqual(proofs(index).length, 1);
            const other = plan(index, 'b.ts:1:count');
            assert.ok(other.result.changes.some(change => change.file === 'b.ts' &&
                change.newExpression === 'export class Second { changed=2; }'));
            assert.ok(!other.result.changes.some(change => change.file === 'a.ts' || change.file === 'local.ts'));
            assert.deepStrictEqual(other, plan(idx(dir), 'b.ts:1:count'));
        } finally { clearProjectCache(dir); rm(dir); }
    });

    it('does not cache extern declarations, global rebinding, imports or positive members as local shadows', () => {
        const cases = [
            { files: { 'a.c': 'int count;', 'b.c': 'int read(void) { extern int count; return count; }' }, pin: 'a.c:1:count' },
            { files: { 'a.py': 'count=1', 'b.py': 'from a import count\ndef read():\n global count\n count=2\n return count' }, pin: 'a.py:1:count' },
            { files: { 'A.cs': 'class Counter { public int count; }',
                'B.cs': 'class Other { int Read(Counter x) { return x.count; } }' }, pin: 'A.cs:1:count' },
            { files: { 'src/lib.rs': 'pub const COUNT:i32=1;\nmod other;',
                'src/other.rs': 'use crate::COUNT;\npub fn matches(x:i32)->bool { matches!(x, COUNT) }',
                'Cargo.toml': '[package]\nname="pattern_proofs"\nversion="0.1.0"\nedition="2021"' }, pin: 'src/lib.rs:1:COUNT' },
        ];
        for (const fixture of cases) {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir);
                plan(index, fixture.pin);
                assert.strictEqual(proofs(index).length, 0, fixture.pin);
            } finally { clearProjectCache(dir); rm(dir); }
        }
    });

    for (const fixture of [
        { label: 'Go', file: 'a.go', source: 'package p\ntype Counter struct { count int }', foreign: 'b.go',
            use: 'package p\r\nfunc noise() string { return "雪😀" }\r\nfunc read(x Counter) int { { text := "雪😀"; _ = text }; return x.count }', pin: 'a.go:2:count' },
        { label: 'Java', file: 'A.java', source: 'class Counter { int count; }', foreign: 'B.java',
            use: 'class Other {\r\n String noise() { return "雪😀"; }\r\n int read(Counter x) { { String text="雪😀"; } return x.count; }\r\n}', pin: 'A.java:1:count' },
        { label: 'C#', file: 'A.cs', source: 'class Counter { public int count; }', foreign: 'B.cs',
            use: 'class Other {\r\n string Noise() { return "雪😀"; }\r\n int Read(Counter x) { { string text="雪😀"; } return x.count; }\r\n}', pin: 'A.cs:1:count' },
        { label: 'C# configuration views', file: 'A.cs', source: 'class Counter { public int count; }', foreign: 'B.cs',
            use: 'interface Other {\n int Read(Counter x)\n#if FEATURE\n { return x.count; }\n#else\n ;\n#endif\n string Noise()\n#if FEATURE\n { return "雪😀"; }\n#else\n ;\n#endif\n}', pin: 'A.cs:1:count', conditional: true },
        { label: 'C# parse errors', file: 'A.cs', source: 'class Counter { public int count; }', foreign: 'B.cs',
            use: 'class Other { string Noise() { return "雪😀"; } int Read(Counter x) { return x.count; } }\nclass Broken { void Oops( { } }', pin: 'A.cs:1:count', errors: true },
    ]) {
        it(`${fixture.label}: reuses AST body ranges while resolving member ownership afresh`, () => {
            const dir = tmp({ [fixture.file]: fixture.source, [fixture.foreign]: fixture.use });
            try {
                const index = idx(dir);
                const expected = plan(index, fixture.pin);
                assert.ok(expected.result.changes.some(change => change.file === fixture.foreign &&
                    change.newExpression?.includes('x.changed')));
                index.saveCache();
                index.saveUsageCache();
                const loaded = new ProjectIndex(dir);
                assert.ok(loaded.loadCache());
                const file = path.join(dir, fixture.foreign), entry = loaded.files.get(file);
                if (fixture.conditional) assert.ok(entry.conditionalViews?.length);
                const { localQueryTree, isLocalNameTree } = require('../core/query-bodies');
                loaded._beginOp();
                try {
                    const tree = localQueryTree(loaded, file, entry, entry.language, 'count', fixture.use);
                    assert.ok(isLocalNameTree(tree), 'the saved AST ranges must produce a private query tree');
                    if (fixture.errors) assert.ok(tree.rootNode.hasError, 'parse damage stays visible');
                    assert.ok(tree.rootNode.text.includes('return x.count'));
                    assert.ok(!tree.rootNode.descendantsOfType(['string_literal', 'interpreted_string_literal'])
                        .some(node => node.text.includes('雪😀')));
                    assert.ok(!loaded._opTreeCache.has(file));
                    assert.ok(!loaded._parsedTreeCache.has(file));
                    const complete = loaded._getParsedTree(file, fixture.use, entry.language);
                    assert.ok(complete.rootNode.text.includes('return "雪😀"'), 'another name still reads the complete body');
                } finally { loaded._endOp(); }
                const repeated = new ProjectIndex(dir);
                assert.ok(repeated.loadCache());
                assert.deepStrictEqual(plan(repeated, fixture.pin), expected);
            } finally { clearProjectCache(dir); rm(dir); }
        });
    }

    it('keeps query-bearing comments and opaque bodies with embedded comment terminators', () => {
        const use = '/* count */\r\nclass Other { int Noise() { string text="*/"; return 123; } int Read(Counter x) { return x.count; } }';
        const dir = tmp({ 'A.cs': 'class Counter { public int count; }', 'B.cs': use });
        try {
            const index = idx(dir), expected = plan(index, 'A.cs:1:count');
            index.saveCache();
            index.saveUsageCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            const file = path.join(dir, 'B.cs'), entry = loaded.files.get(file);
            loaded._beginOp();
            try {
                const { localQueryTree, isLocalNameTree } = require('../core/query-bodies');
                const tree = localQueryTree(loaded, file, entry, entry.language, 'count', use);
                assert.ok(isLocalNameTree(tree));
                assert.ok(tree.rootNode.text.includes('/* count */'));
                assert.ok(!tree.rootNode.descendantsOfType('string_literal').some(node => node.text.includes('*/')));
            } finally { loaded._endOp(); }
            assert.deepStrictEqual(plan(loaded, 'A.cs:1:count'), expected);
        } finally { clearProjectCache(dir); rm(dir); }
    });

    it('reads changed project-file imports instead of replaying positive member ownership', () => {
        const project = namespace => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="${namespace}" /></ItemGroup></Project>`;
        const dir = tmp({ 'A.cs': 'namespace First { class Counter { public int count; } }',
            'C.cs': 'namespace Second { class Counter { public int count; } }',
            'Use.cs': 'class Use { int Read(Counter x) { return x.count; } }', 'p.csproj': project('First') });
        try {
            const index = idx(dir), before = plan(index, 'A.cs:1:count');
            assert.ok(before.result.changes.some(change => change.file === 'Use.cs' &&
                change.newExpression?.includes('x.changed')));
            index.saveCache();
            index.saveUsageCache();
            fs.writeFileSync(path.join(dir, 'p.csproj'), project('Second'));
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(), 'source files have not changed');
            const after = plan(loaded, 'A.cs:1:count');
            assert.ok(!after.result.changes.some(change => change.file === 'Use.cs' && change.newExpression));
            assert.deepStrictEqual(after, plan(idx(dir), 'A.cs:1:count'));
        } finally { clearProjectCache(dir); rm(dir); }
    });
});

describe('fix #413: conditional using facts survive index persistence', () => {
    it('round-trips the source branches and their unverified callers', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'api.hpp': '#include <cstdlib>\nnamespace library {\n#if MODE\nusing std::abs;\n#else\ninline int abs(int value) { return value; }\n#endif\n}',
            'use.cpp': '#include "api.hpp"\nint run(int value) { return library::abs(value); }',
        });
        try {
            const read = index => {
                const facts = index.files.get(path.join(dir, 'api.hpp')).cppUsings;
                assert.ok(facts.some(fact => fact.name === 'abs' && fact.ppGroups?.length));
                const result = execute(index, 'context', { name: 'api.hpp:6:abs' });
                assert.ok(result.ok, result.error);
                assert.ok(result.result.unverifiedCallers.some(site => site.relativePath === 'use.cpp'));
                return {
                    facts,
                    account: result.result.meta.account,
                    callers: result.result.callers.map(site => [site.relativePath, site.line]),
                    unverified: result.result.unverifiedCallers.map(site => [site.relativePath, site.line, site.reason]),
                };
            };
            const index = idx(dir);
            const before = JSON.parse(JSON.stringify(read(index)));
            index.saveCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(JSON.parse(JSON.stringify(read(loaded))), before);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
    it('rejects the preceding format without conditional import groups', () => {
        const dir = tmp({ 'm.cpp': 'int value() { return 1; }' });
        try {
            const index = idx(dir);
            index.saveCache();
            const cacheFile = getProjectCachePath(dir);
            const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            saved.version = 278;
            fs.writeFileSync(cacheFile, JSON.stringify(saved));
            assert.strictEqual(new ProjectIndex(dir).loadCache(), false);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('fix #412: local function lexical lookup survives cache reload', () => {
    it('rebuilds type context without persisting member ownership on the local function', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'A.cs': 'namespace Acme;\npartial class Host {\n  static int Helper(int n) => n;\n}',
            'B.cs': 'namespace Acme;\npartial class Host {\n  static int Run() {\n    return Local();\n    static int Local() { return Helper(1); }\n  }\n}',
        });
        try {
            const snapshot = index => {
                const context = execute(index, 'context', { name: 'A.cs:3:Helper' });
                const plan = execute(index, 'plan', { name: 'A.cs:3:Helper', renameTo: 'Renamed' });
                assert.ok(context.ok, context.error);
                assert.ok(plan.ok, plan.error);
                assert.ok(context.result.callers.some(site => site.relativePath === 'B.cs' && site.line === 5));
                assert.ok(!index.symbols.get('Local')[0].className);
                return {
                    callers: context.result.callers.map(site => [site.relativePath, site.line, site.tier, site.resolution]),
                    account: context.result.meta.account,
                    changes: plan.result.changes.map(site => [site.file, site.line, site.newExpression, site.needsReview]),
                };
            };
            const index = idx(dir);
            const expected = snapshot(index);
            index.saveCache();
            index.saveUsageCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(snapshot(loaded), expected);
            assert.deepStrictEqual(snapshot(loaded), expected);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('fix #411: generic usage roles invalidate older usage caches', () => {
    it('reloads terminal names and receivers instead of legacy generic references', () => {
        const dir = tmp({ 'A.cs': [
            'class Other { public T Query<T>(T n) => n; }',
            'class Host {',
            '  public int Query() => 1;',
            '  int Next(Other other) => other.Query<int>(Query());',
            '}',
        ].join('\n') });
        try {
            const file = path.join(dir, 'A.cs');
            const index = idx(dir);
            const read = target => {
                target._beginOp();
                try { return target._getCachedUsages(file, 'Query', { lexicalScopes: true }); }
                finally { target._endOp(); }
            };
            const expected = read(index);
            assert.ok(expected.some(usage => usage.line === 4 && usage.usageType === 'call' && usage.receiver === 'other'));
            const saved = index.saveCache();
            index.saveUsageCache();
            const usagePath = path.join(path.dirname(saved), 'usage-results.json');
            const legacy = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
            legacy.version = 277;
            for (const entry of legacy.entries) for (const usage of entry[4]) {
                if (usage.receiver === 'other') {
                    usage.usageType = 'reference';
                    delete usage.receiver;
                }
            }
            fs.writeFileSync(usagePath, JSON.stringify(legacy));
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.strictEqual(loaded._usageResultCache.size, 0);
            assert.deepStrictEqual(read(loaded), expected);
            loaded.saveUsageCache();
            const repeated = new ProjectIndex(dir);
            assert.ok(repeated.loadCache());
            assert.deepStrictEqual(read(repeated), expected);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('fix #410: property owner proofs survive a saved usage cache', () => {
    it('recomputes namespace and generic-alias scopes after loading the index', () => {
        const dir = tmp({
            'A.cs': 'namespace Left; class Box<T> { public int Size { get; set; } int Read() => Size; }',
            'B.cs': 'namespace Right; class Box<T> { public int Size { get; set; } }',
            'Use.cs': 'namespace Shared { using Alias = Left.Box<int>; class First { object Make() => new Alias { Size = 1 }; } }\nnamespace Shared { using Alias = Right.Box<int>; class Second { object Make() => new Alias { Size = 2 }; } }',
        });
        try {
            const { execute } = require('../core/execute');
            const read = index => ({
                plan: execute(index, 'plan', { name: 'A.cs:1:Size', renameTo: 'Renamed' }),
                impact: execute(index, 'impact', { name: 'A.cs:1:Size' }),
            });
            const index = idx(dir);
            const fresh = read(index);
            assert.ok(fresh.plan.ok && fresh.impact.ok, JSON.stringify(fresh));
            assert.ok(fresh.plan.result.changes.some(change => change.file === 'Use.cs' && change.line === 1 &&
                change.newExpression === 'namespace Shared { using Alias = Left.Box<int>; class First { object Make() => new Alias { Renamed = 1 }; } }'),
            JSON.stringify(fresh));
            assert.ok(!fresh.plan.result.changes.some(change => change.file === 'Use.cs' && change.line === 2), JSON.stringify(fresh));
            index.saveCache();
            index.saveUsageCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(read(loaded), fresh);
            assert.deepStrictEqual(read(loaded), fresh, 'repeated warm lookups keep the same scope');
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('fix #409: persisted usage facts follow their schema version', () => {
    it('rejects legacy usage records and round-trips declaration-name evidence', () => {
        const dir = tmp({ 'm.cpp': 'namespace N { int work(int v); }\nint N::work(int v) { return v; }' });
        try {
            const file = path.join(dir, 'm.cpp');
            const index = idx(dir);
            index._beginOp();
            try { index._getCachedUsages(file, 'work', { lexicalScopes: true }); }
            finally { index._endOp(); }
            const saved = index.saveCache();
            index.saveUsageCache();
            const usagePath = path.join(path.dirname(saved), 'usage-results.json');
            const legacy = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
            legacy.version = 276;
            for (const entry of legacy.entries) {
                for (const usage of entry[4]) delete usage.declarationName;
            }
            fs.writeFileSync(usagePath, JSON.stringify(legacy));

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(), 'the current index remains valid');
            assert.strictEqual(loaded._usageResultCache.size, 0,
                'older usage records lack the declaration-name evidence');
            loaded._beginOp();
            let fresh;
            try { fresh = loaded._getCachedUsages(file, 'work', { lexicalScopes: true }); }
            finally { loaded._endOp(); }
            assert.ok(fresh.some(usage => usage.line === 2 && usage.declarationName), JSON.stringify(fresh));
            loaded.saveUsageCache();

            const roundTrip = new ProjectIndex(dir);
            assert.ok(roundTrip.loadCache());
            roundTrip._beginOp();
            try {
                assert.deepStrictEqual(roundTrip._getCachedUsages(file, 'work', { lexicalScopes: true }), fresh);
            } finally { roundTrip._endOp(); }
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('Per-user cache placement', () => {
    it('stores the default cache outside the project tree', () => {
        const dir = tmp({
            'package.json': '{"name":"cache-placement"}',
            'index.js': 'function main() { return 1; }',
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            const saved = index.saveCache();

            assert.strictEqual(saved, getProjectCachePath(dir));
            assert.ok(saved.startsWith(path.resolve(process.env.UCN_CACHE_DIR) + path.sep));
            assert.ok(fs.existsSync(saved), 'per-user cache should be written');
            assert.ok(!fs.existsSync(getLegacyProjectCacheDir(dir)),
                'default cache must not create files in the project');
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });

    it('honors explicit and platform cache roots', () => {
        const homeDir = path.join(path.parse(process.cwd()).root, 'users', 'cache-test');
        assert.strictEqual(
            getUserCacheRoot({
                env: { UCN_CACHE_DIR: '~/custom-cache' },
                platform: 'linux',
                homeDir,
            }),
            path.join(homeDir, 'custom-cache'));
        assert.strictEqual(
            getUserCacheRoot({
                env: { XDG_CACHE_HOME: path.join(homeDir, 'xdg') },
                platform: 'linux',
                homeDir,
            }),
            path.join(homeDir, 'xdg', 'ucn'));
        assert.strictEqual(
            getUserCacheRoot({ env: {}, platform: 'darwin', homeDir }),
            path.join(homeDir, 'Library', 'Caches', 'ucn'));
        assert.strictEqual(
            getUserCacheRoot({ env: {}, platform: 'linux', homeDir }),
            path.join(homeDir, '.cache', 'ucn'));
    });

    it('isolates projects with the same basename', () => {
        const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-parent-a-'));
        const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-parent-b-'));
        const dirA = path.join(parentA, 'service');
        const dirB = path.join(parentB, 'service');
        fs.mkdirSync(dirA);
        fs.mkdirSync(dirB);
        try {
            assert.notStrictEqual(getProjectCacheDir(dirA), getProjectCacheDir(dirB));
            assert.strictEqual(path.basename(getProjectCacheDir(dirA)).startsWith('service-'), true);
            assert.strictEqual(path.basename(getProjectCacheDir(dirB)).startsWith('service-'), true);
        } finally {
            clearProjectCache(dirA);
            clearProjectCache(dirB);
            fs.rmSync(parentA, { recursive: true, force: true });
            fs.rmSync(parentB, { recursive: true, force: true });
        }
    });

    it('migrates a legacy project cache and removes project pollution', () => {
        const dir = tmp({
            'package.json': '{"name":"legacy-cache"}',
            'index.js': 'function migrated() { return true; }',
        });
        try {
            const legacyPath = path.join(getLegacyProjectCacheDir(dir), 'index.json');
            const initial = new ProjectIndex(dir);
            initial.build(null, { quiet: true });
            initial.saveCache(legacyPath);
            assert.ok(fs.existsSync(legacyPath));
            assert.ok(!fs.existsSync(getProjectCachePath(dir)));

            const migrated = new ProjectIndex(dir);
            assert.strictEqual(migrated.loadCache(), true);
            assert.ok(migrated.symbols.has('migrated'));
            assert.ok(fs.existsSync(getProjectCachePath(dir)));
            assert.ok(!fs.existsSync(getLegacyProjectCacheDir(dir)));
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });

    it('clears both current and legacy cache locations', () => {
        const dir = tmp({
            'package.json': '{"name":"clear-cache"}',
            'index.js': 'function cached() {}',
        });
        try {
            const index = idx(dir);
            index.saveCache();
            const legacyDir = getLegacyProjectCacheDir(dir);
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, 'legacy.json'), '{}');

            const removed = index.clearCache();
            assert.strictEqual(removed.length, 2);
            assert.ok(!fs.existsSync(getProjectCacheDir(dir)));
            assert.ok(!fs.existsSync(legacyDir));
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('Cache Behavior', () => {

    it('should save and load cache correctly', () => {
        const tmpDir = createTempDir();
        try {
            // Create a test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function hello() { return "world"; }');

            // Build index and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Verify cache file exists
            const cacheFile = getProjectCachePath(tmpDir);
            assert.ok(fs.existsSync(cacheFile), 'Cache file should exist');

            // Create new index and load cache
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // Verify symbols match
            assert.strictEqual(index2.symbols.size, index1.symbols.size, 'Symbol count should match');
            assert.ok(index2.symbols.has('hello'), 'Should have hello symbol');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('persists unsupported-source handoffs and invalidates when they change', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'export function app() {}');
            fs.writeFileSync(path.join(tmpDir, 'worker.rb'), 'def work\nend\n');

            const index1 = new ProjectIndex(tmpDir);
            index1.build(null, { quiet: true });
            assert.deepStrictEqual(
                index1.unsupportedFiles.map(file => file.relativePath),
                ['worker.rb'],
            );
            index1.saveCache();

            const index2 = new ProjectIndex(tmpDir);
            assert.strictEqual(index2.loadCache(), true);
            assert.deepStrictEqual(
                index2.unsupportedFiles.map(file => file.relativePath),
                ['worker.rb'],
            );
            assert.strictEqual(index2.isCacheStale(), false);

            fs.writeFileSync(path.join(tmpDir, 'extra.rb'), 'def extra\nend\n');
            // Clear the burst optimization because it intentionally delays
            // discovery of all newly added files, supported or unsupported.
            index2._lastFreshAt = null;
            assert.strictEqual(index2.isCacheStale(), true,
                'new unsupported source must refresh repo/health handoff data');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect modified files as stale', () => {
        const tmpDir = createTempDir();
        try {
            // Create test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function original() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Modify file
            fs.writeFileSync(testFile, 'function modified() { return 42; }');

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after file modification');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('detects a modification made inside the 2s freshness window (MCP agent edit-then-query)', () => {
        const tmpDir = createTempDir();
        try {
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function original() {}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Confirm freshness (sets _lastFreshAt — the MCP burst window)
            assert.strictEqual(index.isCacheStale(), false, 'fresh right after build');
            assert.ok(index._lastFreshAt, 'freshness timestamp recorded');

            // Agent edits the file and re-queries within 2 seconds. The stat
            // sweep must run UNCONDITIONALLY — only the new-file glob hides
            // behind the window. Pre-fix this returned false (stale answer
            // served as fresh).
            fs.writeFileSync(testFile, 'function modified() { return 42; }');
            assert.strictEqual(index.isCacheStale(), true,
                'modification inside the freshness window must be detected');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect new files added to project', () => {
        const tmpDir = createTempDir();
        try {
            // Create initial file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function first() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Add new file
            const newFile = path.join(tmpDir, 'new.js');
            fs.writeFileSync(newFile, 'function second() {}');

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after adding new file');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect deleted files', () => {
        const tmpDir = createTempDir();
        try {
            // Create two files
            fs.writeFileSync(path.join(tmpDir, 'file1.js'), 'function one() {}');
            fs.writeFileSync(path.join(tmpDir, 'file2.js'), 'function two() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Delete one file
            fs.unlinkSync(path.join(tmpDir, 'file2.js'));

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after deleting file');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should handle corrupted cache gracefully', () => {
        const tmpDir = createTempDir();
        try {
            // Create cache directory with invalid JSON
            const cacheDir = getProjectCacheDir(tmpDir);
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, 'index.json'), 'not valid json {{{');

            // loadCache should return false
            const index = new ProjectIndex(tmpDir);
            const loaded = index.loadCache();
            assert.strictEqual(loaded, false, 'Should not load corrupted cache');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should handle version mismatch gracefully', () => {
        const tmpDir = createTempDir();
        try {
            // Create cache with wrong version
            const cacheDir = getProjectCacheDir(tmpDir);
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
                version: 999,
                files: [],
                symbols: [],
                importGraph: [],
                exportGraph: []
            }));

            // loadCache should return false
            const index = new ProjectIndex(tmpDir);
            const loaded = index.loadCache();
            assert.strictEqual(loaded, false, 'Should not load cache with wrong version');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should report not stale when files unchanged', () => {
        const tmpDir = createTempDir();
        try {
            // Create test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function unchanged() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Load cache without modifications
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.strictEqual(index2.isCacheStale(), false, 'Cache should not be stale when files unchanged');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should track files that fail to index in failedFiles', () => {
        const tmpDir = createTempDir();
        try {
            // Create a normal file and a file that will fail to parse
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() { return 1; }');
            // Create a huge minified file that exceeds tree-sitter buffer
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // good.js should be indexed
            assert.ok(index.files.has(path.join(tmpDir, 'good.js')), 'good.js should be in files');
            assert.ok(index.symbols.has('hello'), 'hello should be in symbols');

            // bundle.js should be in failedFiles (too large for tree-sitter)
            assert.ok(index.failedFiles.has(path.join(tmpDir, 'bundle.js')), 'bundle.js should be in failedFiles');
            assert.ok(!index.files.has(path.join(tmpDir, 'bundle.js')), 'bundle.js should NOT be in files');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should not report failedFiles as new in isCacheStale', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() {}');
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // isCacheStale should return false (bundle.js is in failedFiles, not "new")
            assert.strictEqual(index1.isCacheStale(), false,
                'Cache should not be stale — failed files are tracked');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should persist failedFiles across save/load cache cycle', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() {}');
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            // Build and save
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            assert.ok(index1.failedFiles.size > 0, 'Should have failed files after build');
            index1.saveCache();

            // Load into new index
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // failedFiles should be restored
            assert.ok(index2.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should be in failedFiles after cache load');

            // isCacheStale should return false
            assert.strictEqual(index2.isCacheStale(), false,
                'Cache should not be stale after loading with failedFiles');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should remove from failedFiles if file later indexes successfully', () => {
        const tmpDir = createTempDir();
        try {
            // Start with a file that fails
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });
            assert.ok(index.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should fail initially');

            // Replace with valid content and rebuild
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), 'function fixed() {}');
            index.build('**/*.js', { quiet: true, forceRebuild: true });

            assert.ok(!index.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should be removed from failedFiles after successful indexing');
            assert.ok(index.files.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should now be in files');
        } finally {
            cleanup(tmpDir);
        }
    });
});

describe('Cache staleness handling', () => {
    it('should not create duplicate symbols when cache is stale', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-cache-test-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Create initial file
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 42;
}
module.exports = { myFunc };
`);

        try {
            // Build initial index
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Save cache
            const cacheDir = getProjectCacheDir(tmpDir);
            fs.mkdirSync(cacheDir, { recursive: true });
            index1.saveCache(path.join(cacheDir, 'index.json'));

            // Verify initial state - should have exactly 1 symbol
            const found1 = index1.find('myFunc');
            assert.strictEqual(found1.length, 1, 'Should find exactly 1 symbol initially');

            // Modify the file to make cache stale
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 43; // modified
}
module.exports = { myFunc };
`);

            // Create new index, load cache, detect stale, and rebuild with forceRebuild
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache(path.join(cacheDir, 'index.json'));
            assert.ok(loaded, 'Cache should load');

            const stale = index2.isCacheStale();
            assert.ok(stale, 'Cache should be stale after file modification');

            // This is the key fix: forceRebuild clears maps before rebuilding
            index2.build('**/*.js', { quiet: true, forceRebuild: true });

            // Should still have exactly 1 symbol, not duplicates
            const found2 = index2.find('myFunc');
            assert.strictEqual(found2.length, 1, 'Should still find exactly 1 symbol after stale rebuild (no duplicates)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should create duplicates WITHOUT forceRebuild (demonstrates the bug)', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-cache-bug-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function testFunc() { return 1; }
module.exports = { testFunc };
`);

        try {
            // Build and cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            const cacheDir = getProjectCacheDir(tmpDir);
            fs.mkdirSync(cacheDir, { recursive: true });
            index1.saveCache(path.join(cacheDir, 'index.json'));

            // Modify file
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function testFunc() { return 2; }
module.exports = { testFunc };
`);

            // Load cache and rebuild WITHOUT forceRebuild
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache(path.join(cacheDir, 'index.json'));
            index2.build('**/*.js', { quiet: true }); // No forceRebuild!

            // Without the fix, this would create duplicates
            const found = index2.find('testFunc');
            // This test documents the expected behavior with forceRebuild
            // Without it, duplicates could appear
            assert.ok(found.length >= 1, 'Should find at least 1 symbol');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('AST-based Comment/String Detection', () => {
    it('detects inline comments correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const x = 5; // comment mentioning myFunc
myFunc(); // this is a call
// myFunc is mentioned here
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // isCommentOrStringAtPosition should detect the comment
            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: "const x = 5; // comment mentioning myFunc"
            // Column 0 should be code, column after // should be comment
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 0, filePath),
                false,
                'Start of line 2 should be code'
            );
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 14, filePath),
                true,
                'Inside comment on line 2 should be comment'
            );

            // Line 4: "// myFunc is mentioned here" - entire line is comment
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 4, 0, filePath),
                true,
                'Comment-only line should be comment'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects string literals correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const msg = "function call()";
const real = call();
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: const msg = "function call()";
            // "function" inside the string should be detected as string
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 13, filePath),
                true,
                'Inside string literal should be string'
            );

            // Line 3: const real = call();
            // "call" should be code
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 3, 13, filePath),
                false,
                'Function call should be code'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('handles template literals with expressions', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const x = `value is ${fn()} here`;');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Inside template expression ${fn()} - "fn" should be code
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 1, 22, filePath),
                false,
                'Inside template expression should be code'
            );

            // Inside template string but outside expression - should be string
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 1, 12, filePath),
                true,
                'Inside template string should be string'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('isInsideStringAST correctly identifies names in strings vs code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const msg = "call myFunc here";
myFunc();
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');
            const lines = content.split('\n');

            // Line 2: myFunc appears inside string - should return true
            assert.strictEqual(
                index.isInsideStringAST(content, 2, lines[1], 'myFunc', filePath),
                true,
                'myFunc on line 2 is inside string'
            );

            // Line 3: myFunc appears as code - should return false
            assert.strictEqual(
                index.isInsideStringAST(content, 3, lines[2], 'myFunc', filePath),
                false,
                'myFunc on line 3 is code'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('classifyUsageAST correctly classifies calls and definitions', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function myFunc() {}
myFunc();
import { other } from './other';
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: function definition
            assert.strictEqual(
                index.classifyUsageAST(content, 2, 'myFunc', filePath),
                'definition',
                'Function declaration should be classified as definition'
            );

            // Line 3: function call
            assert.strictEqual(
                index.classifyUsageAST(content, 3, 'myFunc', filePath),
                'call',
                'Function call should be classified as call'
            );

            // Line 4: import
            assert.strictEqual(
                index.classifyUsageAST(content, 4, 'other', filePath),
                'import',
                'Import should be classified as import'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Cache Performance Optimizations', () => {
    it('getCachedCalls uses mtime for fast cache validation', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function foo() { bar(); }
function bar() { return 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            // First call - should parse
            const calls1 = index.getCachedCalls(filePath);
            assert.ok(calls1, 'First call should return calls');
            assert.ok(calls1.length > 0, 'Should find calls');

            // Check cache entry has mtime
            const cached = index.callsCache.get(filePath);
            assert.ok(cached, 'Cache entry should exist');
            assert.ok(cached.mtime, 'Cache should have mtime');
            assert.ok(cached.hash, 'Cache should have hash');

            // Second call - should use mtime cache (no reparse)
            const calls2 = index.getCachedCalls(filePath);
            assert.deepStrictEqual(calls2, calls1, 'Second call should return same result');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('getCachedCalls with includeContent avoids double file read', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function foo() { bar(); }
function bar() { return 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            // Call with includeContent
            const result = index.getCachedCalls(filePath, { includeContent: true });
            assert.ok(result, 'Should return result');
            assert.ok(result.calls, 'Should have calls');
            assert.ok(result.content, 'Should have content');
            assert.ok(result.content.includes('function foo'), 'Content should be the file');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('callsCache is persisted to disk and restored', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-persist-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function processData() {
    helper();
    console.log('done');
}
function helper() { return 42; }
`);
            // Build and populate cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Trigger callsCache population
            const filePath = path.join(tmpDir, 'test.js');
            index1.getCachedCalls(filePath);

            // Verify callsCache is populated
            assert.ok(index1.callsCache.size > 0, 'callsCache should be populated');

            // Save cache (default path)
            index1.saveCache();

            // Verify main cache file does NOT have inline callsCache
            const mainCachePath = getProjectCachePath(tmpDir);
            const cacheData = JSON.parse(fs.readFileSync(mainCachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, CACHE_FORMAT_VERSION, 'Cache version should be current');
            assert.ok(!cacheData.callsCache, 'Main cache should not have inline callsCache');

            // Verify sharded calls cache exists (calls/manifest.json)
            const callsManifest = path.join(getProjectCacheDir(tmpDir), 'calls', 'manifest.json');
            assert.ok(fs.existsSync(callsManifest), 'Calls manifest should exist');

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // callsCache is lazily loaded from shards — trigger via getCachedCalls
            const calls = index2.getCachedCalls(filePath);
            assert.ok(calls, 'Should get calls from restored cache');
            assert.ok(calls.some(c => c.name === 'helper'), 'Should find helper call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('findCallers is fast after cache load (no reparse)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            // Create multiple files
            for (let i = 0; i < 10; i++) {
                fs.writeFileSync(path.join(tmpDir, `file${i}.js`), `
function caller${i}() { helper(); }
`);
            }
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
function helper() { return 42; }
`);

            // Build and warm up cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Time first findCallers (populates callsCache)
            const start1 = Date.now();
            const callers1 = index1.findCallers('helper');
            const time1 = Date.now() - start1;

            // Save cache (default path so lazy callsCache loading works)
            index1.saveCache();

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();

            // Time findCallers after cache load
            const start2 = Date.now();
            const callers2 = index2.findCallers('helper');
            const time2 = Date.now() - start2;

            // Verify results are same
            assert.strictEqual(callers1.length, callers2.length, 'Same number of callers');
            assert.strictEqual(callers1.length, 10, 'Should find 10 callers');

            // Cache-loaded should be reasonably fast (not doing full reparse)
            // Note: First call might be faster due to mtime check, second call uses persisted data
            assert.ok(time2 < time1 * 3 || time2 < 100,
                `Cache-loaded findCallers (${time2}ms) should not be much slower than warm (${time1}ms)`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('mtime change triggers reparse but hash match skips reparse', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-mtime-'));
        try {
            const filePath = path.join(tmpDir, 'test.js');
            fs.writeFileSync(filePath, `function foo() { bar(); }`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Get initial cache
            index.getCachedCalls(filePath);
            const cached1 = index.callsCache.get(filePath);
            const originalMtime = cached1.mtime;
            const originalHash = cached1.hash;

            // Touch file (change mtime but not content)
            const now = new Date();
            fs.utimesSync(filePath, now, now);

            // Get calls again - should update mtime but not reparse (hash matches)
            index.getCachedCalls(filePath);
            const cached2 = index.callsCache.get(filePath);

            assert.notStrictEqual(cached2.mtime, originalMtime, 'mtime should be updated');
            assert.strictEqual(cached2.hash, originalHash, 'hash should be same (content unchanged)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('related() optimization', () => {
    it('sharedCallees uses reverse lookup instead of scanning all symbols', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-related-'));
        try {
            // Create a project where multiple functions share callees
            fs.writeFileSync(path.join(tmpDir, 'shared.js'), `
function helper() { return 1; }
function utility() { return 2; }
`);
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function funcA() { helper(); utility(); }
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function funcB() { helper(); utility(); }
`);
            fs.writeFileSync(path.join(tmpDir, 'c.js'), `
function funcC() { helper(); }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const result = index.related('funcA');
            assert.ok(result, 'related should return result');

            // funcB shares both callees (helper, utility), funcC shares one (helper)
            assert.ok(result.sharedCallees.length > 0, 'Should find shared callees');
            const funcBEntry = result.sharedCallees.find(s => s.name === 'funcB');
            const funcCEntry = result.sharedCallees.find(s => s.name === 'funcC');
            assert.ok(funcBEntry, 'funcB should be in shared callees');
            assert.strictEqual(funcBEntry.sharedCalleeCount, 2, 'funcB shares 2 callees');
            if (funcCEntry) {
                assert.strictEqual(funcCEntry.sharedCalleeCount, 1, 'funcC shares 1 callee');
            }
            // Should be sorted: funcB (2) before funcC (1)
            if (funcCEntry) {
                const bIdx = result.sharedCallees.indexOf(funcBEntry);
                const cIdx = result.sharedCallees.indexOf(funcCEntry);
                assert.ok(bIdx < cIdx, 'Higher shared count should come first');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Per-operation file content cache', () => {
    it('_readFile returns same content and uses cache within _beginOp/_endOp', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function a() { b(); }\n');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function b() { return 1; }\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const fileA = path.join(tmpDir, 'a.js');

            // Without op cache, _readFile works normally
            const content1 = index._readFile(fileA);
            assert.ok(content1.includes('function a'), 'Should read file content');
            assert.strictEqual(index._opContentCache, null, 'No cache active outside op');

            // With op cache, repeated reads return cached content
            index._beginOp();
            const content2 = index._readFile(fileA);
            const content3 = index._readFile(fileA);
            assert.strictEqual(content2, content3, 'Should return same cached content');
            assert.strictEqual(index._opContentCache.size, 1, 'Cache should have 1 entry');
            index._endOp();
            assert.strictEqual(index._opContentCache, null, 'Cache cleared after op');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('about() activates op cache (nested methods share reads)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            // Create files that will be read multiple times during about()
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function processData(input) {
    const result = helper(input);
    return transform(result);
}
`);
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
function helper(x) { return x * 2; }
function transform(x) { return x + 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Monkey-patch fs.readFileSync to count actual disk reads
            let diskReads = 0;
            const origRead = fs.readFileSync;
            fs.readFileSync = function(p, ...args) {
                if (typeof p === 'string' && p.startsWith(tmpDir)) diskReads++;
                return origRead.call(fs, p, ...args);
            };

            const result = index.about('processData');
            fs.readFileSync = origRead; // restore immediately

            assert.ok(result, 'about should return result');
            assert.ok(result.found, 'Should find processData');

            // about() calls usages, findCallers, findCallees, tests, detectCompleteness
            // Each iterates all files. Without cache: 2 files * 5+ methods = 10+ reads
            // With cache: significant reduction due to shared reads across sub-methods
            // Some extra reads come from getCachedCalls (mtime-based), so allow headroom
            const fileCount = index.files.size;
            assert.ok(diskReads < fileCount * 5,
                `Disk reads (${diskReads}) should be significantly less than uncached (files=${fileCount}, worst case ${fileCount * 8}+)`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('op cache survives errors in methods (try/finally)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'function foo() {}\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // about() with non-existent symbol should not leave cache dangling
            index.about('zzz_nonexistent_xyz');
            assert.strictEqual(index._opContentCache, null, 'Cache should be cleaned up even after non-match');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('nested _beginOp calls do not reset cache', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'function foo() { bar(); }\nfunction bar() {}\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            index._beginOp();
            index._readFile(filePath);
            assert.strictEqual(index._opContentCache.size, 1, 'Should have 1 entry');

            // Nested _beginOp should NOT reset the cache
            index._beginOp();
            assert.strictEqual(index._opContentCache.size, 1, 'Nested beginOp should not reset cache');
            index._endOp();
            // After first endOp, cache is cleared (outermost owns it)
            // This is acceptable — inner methods just don't call _endOp
            // The design is: only top-level method clears
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-001 stale rebuild removes deleted file symbols', () => {
    it('build with forceRebuild removes symbols from deleted files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), 'function ghost() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('ghost'), 'ghost should exist before delete');
            assert.ok(index.symbols.has('main'), 'main should exist');

            // Delete the file
            fs.unlinkSync(path.join(tmpDir, 'helper.js'));

            // Rebuild WITHOUT forceRebuild — ghost should persist (the bug)
            index.build(null, { quiet: true });
            const ghostAfterNoForce = index.symbols.has('ghost');

            // Rebuild WITH forceRebuild — ghost should be gone (the fix)
            index.build(null, { quiet: true, forceRebuild: true });
            assert.ok(!index.symbols.has('ghost'),
                'ghost symbol should be removed after forceRebuild');
            assert.ok(index.symbols.has('main'),
                'main should still exist after forceRebuild');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-003 completeness cache invalidated on rebuild', () => {
    it('detectCompleteness returns fresh result after rebuild', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f003-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'clean.js'), 'function clean() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const first = index.detectCompleteness();
            assert.ok(first.complete, 'Should be complete initially (no dynamic patterns)');

            // Add a file with eval
            fs.writeFileSync(path.join(tmpDir, 'dirty.js'), 'const x = eval("1+1");');
            index.build(null, { quiet: true, forceRebuild: true });

            const second = index.detectCompleteness();
            assert.ok(!second.complete,
                'Should NOT be complete after adding eval — cache must be invalidated on rebuild');
            assert.ok(second.warnings.some(w => w.type === 'eval'),
                'Should have eval warning after rebuild');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-004 expand scoped to last context call', () => {
    it('context for different symbols produces independent expandable items', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f004-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function alpha() { beta(); }
function beta() { gamma(); }
function gamma() {}
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function delta() { epsilon(); }
function epsilon() {}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const output = require('../core/output');

            // Call context for 'alpha'
            const ctxAlpha = index.context('alpha', {});
            const fmtAlpha = output.formatContext(ctxAlpha);

            // Call context for 'delta'
            const ctxDelta = index.context('delta', {});
            const fmtDelta = output.formatContext(ctxDelta);

            // Both should have expandable items
            assert.ok(fmtAlpha.expandable.length > 0, 'alpha context should have expandable items');
            assert.ok(fmtDelta.expandable.length > 0, 'delta context should have expandable items');

            // Items start at 1 for each context call — they overlap in numbering
            assert.strictEqual(fmtAlpha.expandable[0].num, 1);
            assert.strictEqual(fmtDelta.expandable[0].num, 1);

            // But they reference different symbols
            const alphaNames = fmtAlpha.expandable.map(e => e.name);
            const deltaNames = fmtDelta.expandable.map(e => e.name);
            assert.ok(!alphaNames.includes('epsilon'), 'alpha expandable should not include epsilon');
            assert.ok(!deltaNames.includes('beta'), 'delta expandable should not include beta');

            // Use shared ExpandCache to test last-context-wins behavior
            const { ExpandCache } = require(path.join(__dirname, '..', 'core', 'expand-cache'));
            const cache = new ExpandCache();
            const root = index.root;

            cache.save(root, 'alpha', null, fmtAlpha.expandable);
            cache.save(root, 'delta', null, fmtDelta.expandable);

            // Expand item 1 should come from delta (last context), not alpha
            const { match } = cache.lookup(root, 1);
            assert.ok(match, 'Should find item 1 in recent context');
            assert.ok(deltaNames.includes(match.name),
                `Item 1 should be from delta context (got ${match.name}), not alpha`);

            // Item beyond delta's range — lookup tries recent first, then falls back
            const maxDeltaItem = Math.max(...fmtDelta.expandable.map(i => i.num));
            const beyondRange = maxDeltaItem + 10;
            const { match: fallbackMatch } = cache.lookup(root, beyondRange);
            // If alpha doesn't have this item number either, it should be null
            const alphaHasIt = fmtAlpha.expandable.some(i => i.num === beyondRange);
            if (!alphaHasIt) {
                assert.strictEqual(fallbackMatch, null,
                    `Item ${beyondRange} should NOT be found when neither context has it`);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-005 .ucn.json exclude applied to file discovery', () => {
    it('files in excluded directories are not indexed', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f005-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, '.ucn.json'), JSON.stringify({
                exclude: ['vendor', 'generated']
            }));
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');

            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.js'), 'function vendorFn() {}');

            fs.mkdirSync(path.join(tmpDir, 'generated'));
            fs.writeFileSync(path.join(tmpDir, 'generated', 'auto.js'), 'function autoFn() {}');

            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function appFn() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('main'), 'main should be indexed');
            assert.ok(index.symbols.has('appFn'), 'appFn should be indexed');
            assert.ok(!index.symbols.has('vendorFn'),
                'vendorFn should NOT be indexed (vendor is excluded)');
            assert.ok(!index.symbols.has('autoFn'),
                'autoFn should NOT be indexed (generated is excluded)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('exclude config does not affect indexing when not set', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f005b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');

            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.js'), 'function vendorFn() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Without .ucn.json exclude, vendor IS indexed (it's not in DEFAULT_IGNORES)
            assert.ok(index.symbols.has('main'), 'main should be indexed');
            assert.ok(index.symbols.has('vendorFn'),
                'vendorFn should be indexed when no exclude config');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-001 matchesFilters boundary matching', () => {
    it('does not exclude files whose names contain test patterns as substrings', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            // Production files that contain test/spec/mock as substrings
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'spectrum.js'),
                'export function alpha() { return 1; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'inspector.js'),
                'export function inspect() { return 2; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'contest.js'),
                'export function compete() { return 3; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'mocker.js'),
                'export function mockery() { return 4; }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // With default test exclusions, these should still be found
            const exclude = ['test', 'spec', 'mock'];
            const alphaResult = index.find('alpha', { exclude });
            const inspectResult = index.find('inspect', { exclude });
            const competeResult = index.find('compete', { exclude });
            const mockeryResult = index.find('mockery', { exclude });

            assert.ok(alphaResult.length > 0,
                'alpha in spectrum.js should NOT be excluded by "spec" pattern');
            assert.ok(inspectResult.length > 0,
                'inspect in inspector.js should NOT be excluded by "spec" pattern');
            assert.ok(competeResult.length > 0,
                'compete in contest.js should NOT be excluded by "test" pattern');
            assert.ok(mockeryResult.length > 0,
                'mockery in mocker.js should NOT be excluded by "mock" pattern');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('still excludes real test directories and files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.js'),
                'export function main() {}');

            // Real test paths that SHOULD be excluded
            fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'test', 'runner.js'),
                'function runTest() {}');
            fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'tests', 'unit.js'),
                'function unitTest() {}');
            fs.mkdirSync(path.join(tmpDir, 'spec'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'spec', 'helpers.js'),
                'function specHelper() {}');
            fs.mkdirSync(path.join(tmpDir, '__tests__'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '__tests__', 'app.js'),
                'function appTest() {}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.test.js'),
                'function mainTest() {}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.spec.js'),
                'function mainSpec() {}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'test_utils'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'test_utils', 'factory.js'),
                'function testFactory() {}');
            fs.mkdirSync(path.join(tmpDir, '__mocks__'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '__mocks__', 'api.js'),
                'function mockApi() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', '__tests__', '__mocks__', 'mock'];

            assert.ok(index.find('main', { exclude }).length > 0,
                'main in src/ should be found');
            assert.strictEqual(index.find('runTest', { exclude }).length, 0,
                'runTest in test/ should be excluded');
            assert.strictEqual(index.find('unitTest', { exclude }).length, 0,
                'unitTest in tests/ should be excluded');
            assert.strictEqual(index.find('specHelper', { exclude }).length, 0,
                'specHelper in spec/ should be excluded');
            assert.strictEqual(index.find('appTest', { exclude }).length, 0,
                'appTest in __tests__/ should be excluded');
            assert.strictEqual(index.find('mainTest', { exclude }).length, 0,
                'mainTest in main.test.js should be excluded');
            assert.strictEqual(index.find('mainSpec', { exclude }).length, 0,
                'mainSpec in main.spec.js should be excluded');
            assert.strictEqual(index.find('testFactory', { exclude }).length, 0,
                'testFactory in test_utils/ should be excluded');
            assert.strictEqual(index.find('mockApi', { exclude }).length, 0,
                'mockApi in __mocks__/ should be excluded');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('handles special directory names like src/special/', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001c-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'special'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'special', 'handler.js'),
                'export function handleSpecial() {}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'fixtures_data'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'fixtures_data', 'loader.js'),
                'export function loadData() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', 'fixture'];

            assert.ok(index.find('handleSpecial', { exclude }).length > 0,
                'handleSpecial in src/special/ should NOT be excluded (special != spec)');
            // fixtures_data starts with 'fixture' + 's' at boundary — SHOULD be excluded
            assert.strictEqual(index.find('loadData', { exclude }).length, 0,
                'loadData in fixtures_data/ should be excluded (fixture + s + boundary)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('matchesFilters caches compiled regexes across calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-regex-cache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'src.js'), 'function foo() {}');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // First call should create the cache
            index.matchesFilters('src/foo.js', { exclude: ['test', 'mock'] });
            assert.ok(index._excludeRegexCache, 'Regex cache should be created');
            assert.strictEqual(index._excludeRegexCache.size, 2, 'Should cache both patterns');

            // Second call with same patterns should reuse cached regexes
            const cached1 = index._excludeRegexCache.get('test');
            index.matchesFilters('src/bar.js', { exclude: ['test', 'mock'] });
            const cached2 = index._excludeRegexCache.get('test');
            assert.strictEqual(cached1, cached2, 'Should reuse same regex object');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-003 matchesFilters boundary edge cases', () => {
    it('matchesFilters correctly handles all boundary types', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f003-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'dummy.js'), 'function x() {}');
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', 'mock', 'fixture'];

            // Should PASS filter (not excluded)
            assert.ok(index.matchesFilters('src/spectrum.js', { exclude }),
                'spectrum should not be excluded by spec');
            assert.ok(index.matchesFilters('src/inspector.js', { exclude }),
                'inspector should not be excluded by spec');
            assert.ok(index.matchesFilters('src/contest/handler.js', { exclude }),
                'contest should not be excluded by test');
            assert.ok(index.matchesFilters('src/backtester.js', { exclude }),
                'backtester should not be excluded by test');
            assert.ok(index.matchesFilters('src/mocker.js', { exclude }),
                'mocker should not be excluded by mock');
            assert.ok(index.matchesFilters('lib/distributed.js', { exclude }),
                'distributed should not be excluded by test');
            assert.ok(index.matchesFilters('src/testing.js', { exclude }),
                'testing should not be excluded by test');
            assert.ok(index.matchesFilters('src/special/handler.js', { exclude }),
                'special should not be excluded by spec');

            // Should FAIL filter (excluded)
            assert.ok(!index.matchesFilters('test/runner.js', { exclude }),
                'test/ should be excluded');
            assert.ok(!index.matchesFilters('tests/unit.js', { exclude }),
                'tests/ should be excluded');
            assert.ok(!index.matchesFilters('spec/helper.js', { exclude }),
                'spec/ should be excluded');
            assert.ok(!index.matchesFilters('specs/helper.js', { exclude }),
                'specs/ should be excluded');
            assert.ok(!index.matchesFilters('src/file.test.js', { exclude }),
                'file.test.js should be excluded');
            assert.ok(!index.matchesFilters('src/file.spec.js', { exclude }),
                'file.spec.js should be excluded');
            assert.ok(!index.matchesFilters('src/test_utils/factory.js', { exclude }),
                'test_utils/ should be excluded');
            assert.ok(!index.matchesFilters('__tests__/app.js', { exclude }),
                '__tests__/ should be excluded');
            assert.ok(!index.matchesFilters('__mocks__/api.js', { exclude: ['mock'] }),
                '__mocks__/ should be excluded by mock pattern');
            assert.ok(!index.matchesFilters('src/mock_data.js', { exclude }),
                'mock_data.js should be excluded');
            assert.ok(!index.matchesFilters('src/fixtures/data.js', { exclude }),
                'fixtures/ should be excluded by fixture pattern');
            assert.ok(!index.matchesFilters('fixture/setup.js', { exclude }),
                'fixture/ should be excluded');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Diff Impact', () => {
    // FIX 108: parseDiff correctly extracts file paths and line ranges
    it('FIX 108 — parseDiff extracts file paths and line ranges from unified diff', () => {
        const diffText = `diff --git a/src/app.js b/src/app.js
index 1234567..abcdefg 100644
--- a/src/app.js
+++ b/src/app.js
@@ -10,3 +10,5 @@ function old() {
+added line
+another added
@@ -25 +27 @@ function other() {
-old line
+new line
diff --git a/lib/utils.js b/lib/utils.js
--- a/lib/utils.js
+++ b/lib/utils.js
@@ -5,0 +6,2 @@
+new function added
+second line
@@ -20,2 +23,0 @@
`;

        const changes = parseDiff(diffText, '/project');

        assert.strictEqual(changes.length, 2);

        // First file
        assert.strictEqual(changes[0].relativePath, 'src/app.js');
        assert.strictEqual(changes[0].filePath, path.join('/project', 'src/app.js'));
        // First hunk: @@ -10,3 +10,5 @@ → deleted lines 10-12, added lines 10-14
        assert.deepStrictEqual(changes[0].deletedLines, [10, 11, 12, 25]);
        assert.deepStrictEqual(changes[0].addedLines, [10, 11, 12, 13, 14, 27]);

        // Second file
        assert.strictEqual(changes[1].relativePath, 'lib/utils.js');
        // @@ -5,0 +6,2 @@ → 0 deleted, 2 added (6-7)
        // @@ -20,2 +23,0 @@ → 2 deleted (20-21), 0 added
        assert.deepStrictEqual(changes[1].addedLines, [6, 7]);
        assert.deepStrictEqual(changes[1].deletedLines, [20, 21]);
    });

    // FIX 109: diffImpact end-to-end with temp git repo
    it('FIX 109 — diffImpact identifies changed functions and their callers', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-impact-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Initialize git repo
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            // Create initial files
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function greet(name) {
    return 'Hello ' + name;
}

function main() {
    console.log(greet('world'));
}
`);

            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Modify the greet function
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function greet(name) {
    return 'Hi ' + name + '!';
}

function main() {
    console.log(greet('world'));
}
`);

            // Run diff-impact
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            // Verify modified function detected
            assert.ok(result.functions.length >= 1, 'Should detect modified function');
            const greetFn = result.functions.find(f => f.name === 'greet');
            assert.ok(greetFn, 'Should identify greet as modified');
            assert.ok(greetFn.callers.length >= 1, 'greet should have at least one caller');
            assert.ok(greetFn.callers.some(c => c.callerName === 'main'), 'main should be a caller of greet');

            // Summary should be populated
            assert.ok(result.summary.modifiedFunctions >= 1);
            assert.ok(result.summary.totalCallSites >= 1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 110: diffImpact handles no-changes case
    it('FIX 110 — diffImpact returns empty result when no changes', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-empty-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function a() { return 1; }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            assert.strictEqual(result.functions.length, 0);
            assert.strictEqual(result.newFunctions.length, 0);
            assert.strictEqual(result.moduleLevelChanges.length, 0);
            assert.strictEqual(result.summary.totalCallSites, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 111: diffImpact works with --staged
    it('FIX 111 — diffImpact analyzes staged changes', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-staged-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function calc(x) { return x; }\nfunction run() { calc(1); }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Modify and stage
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function calc(x) { return x * 2; }\nfunction run() { calc(1); }\n');
            execSync('git add app.js', { cwd: tmpDir, stdio: 'pipe' });

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ staged: true });

            assert.ok(result.base === '(staged)');
            assert.ok(result.functions.length >= 1, 'Should detect staged change');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 112: diffImpact errors on non-git directory
    it('FIX 112 — diffImpact throws error for non-git directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-nogit-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function a() {}\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.throws(() => {
                index.diffImpact({ base: 'HEAD' });
            }, /git/i);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 113: diffImpact detects new functions
    it('FIX 113 — diffImpact detects newly added functions', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-new-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function existing() { return 1; }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Add a new function
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function existing() { return 1; }
function brandNew(x, y) {
    return x + y;
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.newFunctions.some(f => f.name === 'brandNew'), 'Should detect brandNew as a new function');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 114: Incremental rebuild preserves unchanged file symbols
    it('FIX 114 — incremental rebuild skips unchanged files and handles deletions', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-incr-rebuild-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function alpha() { return 1; }\n');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function beta() { return 2; }\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('alpha'));
            assert.ok(index.symbols.has('beta'));

            // Delete b.js and rebuild (forceRebuild simulates cache-loaded stale state)
            fs.unlinkSync(path.join(tmpDir, 'b.js'));
            index.build(null, { quiet: true, forceRebuild: true });

            assert.ok(index.symbols.has('alpha'), 'alpha should still be indexed');
            assert.ok(!index.symbols.has('beta'), 'beta should be removed after file deletion');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 115: callsCache invalidated on removeFileSymbols
    it('FIX 115 — callsCache entry cleared when file symbols are removed', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-callscache-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() { return 1; }\nfunction caller() { hello(); }\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const filePath = path.join(tmpDir, 'app.js');

            // Trigger callsCache population
            index.findCallers('hello');
            assert.ok(index.callsCache.has(filePath), 'callsCache should have entry after findCallers');

            // Remove file symbols — should also clear callsCache
            index.removeFileSymbols(filePath);
            assert.ok(!index.callsCache.has(filePath), 'callsCache entry should be cleared after removeFileSymbols');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// ExpandCache unit tests
// ============================================================================

describe('ExpandCache', () => {
    const { ExpandCache, renderExpandItem } = require(path.join(__dirname, '..', 'core', 'expand-cache'));

    it('save and lookup basic workflow', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'myFunc', null, [
            { num: 1, name: 'caller1', type: 'function' },
            { num: 2, name: 'caller2', type: 'function' },
        ]);

        const { match, itemCount } = cache.lookup(root, 1);
        assert.ok(match);
        assert.strictEqual(match.name, 'caller1');
        assert.strictEqual(itemCount, 2);
    });

    it('lookup returns null for missing item', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'myFunc', null, [
            { num: 1, name: 'caller1', type: 'function' },
        ]);

        const { match, itemCount } = cache.lookup(root, 99);
        assert.strictEqual(match, null);
        assert.strictEqual(itemCount, 1);
    });

    it('lookup returns empty when no cache exists', () => {
        const cache = new ExpandCache();
        const { match, itemCount } = cache.lookup('/nonexistent', 1);
        assert.strictEqual(match, null);
        assert.strictEqual(itemCount, 0);
    });

    it('last context wins — most recent save is preferred', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'alpha', null, [
            { num: 1, name: 'alphaItem', type: 'function' },
        ]);
        cache.save(root, 'beta', null, [
            { num: 1, name: 'betaItem', type: 'function' },
        ]);

        const { match } = cache.lookup(root, 1);
        assert.strictEqual(match.name, 'betaItem', 'should prefer most recent context (beta)');
    });

    it('fallback to older context when item not in recent', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'alpha', null, [
            { num: 1, name: 'alphaItem', type: 'function' },
            { num: 2, name: 'alphaItem2', type: 'function' },
        ]);
        cache.save(root, 'beta', null, [
            { num: 1, name: 'betaItem', type: 'function' },
        ]);

        // Item 2 only exists in alpha — should fall back
        const { match } = cache.lookup(root, 2);
        assert.ok(match);
        assert.strictEqual(match.name, 'alphaItem2');
    });

    it('LRU eviction when maxSize exceeded', () => {
        const cache = new ExpandCache({ maxSize: 2 });
        const root = '/test/project';

        cache.save(root, 'first', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root, 'second', null, [{ num: 1, name: 'b', type: 'function' }]);
        cache.save(root, 'third', null, [{ num: 1, name: 'c', type: 'function' }]);

        assert.strictEqual(cache.size, 2, 'should evict oldest entry');
    });

    it('clearForRoot removes all entries for a project', () => {
        const cache = new ExpandCache();
        const root1 = '/project1';
        const root2 = '/project2';

        cache.save(root1, 'funcA', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root2, 'funcB', null, [{ num: 1, name: 'b', type: 'function' }]);
        assert.strictEqual(cache.size, 2);

        cache.clearForRoot(root1);
        assert.strictEqual(cache.size, 1);

        const { match: match1 } = cache.lookup(root1, 1);
        assert.strictEqual(match1, null, 'root1 entries should be cleared');

        const { match: match2 } = cache.lookup(root2, 1);
        assert.ok(match2, 'root2 entries should remain');
    });

    it('save with empty items is a no-op', () => {
        const cache = new ExpandCache();
        cache.save('/test', 'func', null, []);
        assert.strictEqual(cache.size, 0);
        cache.save('/test', 'func', null, null);
        assert.strictEqual(cache.size, 0);
    });

    it('file parameter differentiates cache keys', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'parse', 'parser.js', [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root, 'parse', 'utils.js', [{ num: 1, name: 'b', type: 'function' }]);

        assert.strictEqual(cache.size, 2, 'same name with different files should create separate entries');
    });

    it('renderExpandItem produces correct output', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-expand-'));
        try {
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function hello() {\n  return "world";\n}\n');

            const match = {
                num: 1,
                name: 'hello',
                type: 'function',
                file: testFile,
                relativePath: 'test.js',
                startLine: 1,
                endLine: 3
            };

            const { ok, text } = renderExpandItem(match, tmpDir);
            assert.ok(ok);
            assert.ok(text.includes('[1] hello (function)'));
            assert.ok(text.includes('test.js:1-3'));
            assert.ok(text.includes('function hello()'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('LRU eviction cleans up stale lastKey pointing to evicted entry', () => {
        const cache = new ExpandCache({ maxSize: 2 });
        const root1 = '/project1';
        const root2 = '/project2';
        const root3 = '/project3';

        cache.save(root1, 'funcA', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root2, 'funcB', null, [{ num: 1, name: 'b', type: 'function' }]);

        // root1 is the oldest — saving root3 should evict root1
        cache.save(root3, 'funcC', null, [{ num: 1, name: 'c', type: 'function' }]);

        assert.strictEqual(cache.size, 2);

        // lastKey for root1 should be cleaned up (not pointing to evicted entry)
        const result = cache.lookup(root1, 1);
        assert.strictEqual(result.match, null, 'evicted root should not return stale lastKey match');
    });

    it('lookup only refreshes usedAt on actual hit, not miss', () => {
        const cache = new ExpandCache({ maxSize: 3 });
        const root = '/test';

        cache.save(root, 'alpha', null, [{ num: 1, name: 'a', type: 'function' }]);
        const entryKey = `${root}:alpha:`;

        // Record initial usedAt
        const initialUsedAt = cache.entries.get(entryKey).usedAt;

        // Lookup a non-existent item number — should NOT refresh usedAt
        // (need a small delay to distinguish timestamps)
        const before = Date.now();
        cache.lookup(root, 999);
        const afterMiss = cache.entries.get(entryKey).usedAt;
        assert.strictEqual(afterMiss, initialUsedAt, 'usedAt should not change on miss');

        // Now lookup a valid item — should refresh usedAt
        cache.entries.get(entryKey).usedAt = before - 1000; // force old timestamp
        cache.lookup(root, 1);
        const afterHit = cache.entries.get(entryKey).usedAt;
        assert.ok(afterHit >= before, 'usedAt should be refreshed on hit');
    });

    it('renderExpandItem validates root when requested', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-expand-'));
        try {
            // Create file outside the "project root"
            const outsideFile = path.join(os.tmpdir(), 'outside.js');
            fs.writeFileSync(outsideFile, 'function hack() {}');

            const match = {
                num: 1, name: 'hack', type: 'function',
                file: outsideFile, relativePath: '../outside.js',
                startLine: 1, endLine: 1
            };

            const { ok, error } = renderExpandItem(match, tmpDir, { validateRoot: true });
            assert.ok(!ok, 'should fail validation');
            assert.ok(error.includes('outside project root'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Performance optimization regression tests
// ============================================================================

describe('fix: callsCache persisted to disk after command execution', () => {
    it('callsCache is populated and saved after findCallers runs', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmodule.exports = { main };'
        });
        try {
            const index = idx(dir);
            // callsCache is populated during build() via buildCalleeIndex()
            assert.ok(index.callsCache.size > 0, 'callsCache populated during build');

            // findCallers uses the already-populated callsCache
            index.findCallers('helper');
            assert.ok(index.callsCache.size > 0, 'callsCache still populated after findCallers');
            assert.ok(index.callsCacheDirty, 'dirty flag set');

            // Save and reload — callsCache should persist and load lazily
            index.saveCache();
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            // callsCache is lazily loaded — trigger via getCachedCalls or buildCalleeIndex
            const calls = index2.getCachedCalls(path.join(dir, 'app.js'));
            assert.ok(calls, 'callsCache loaded lazily from shards');
            assert.ok(index2.callsCache.size > 0, 'callsCache populated after lazy load');
        } finally {
            rm(dir);
        }
    });

    it('callsCacheDirty flag set on mtime-only update', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            index.findCallers('helper');
            index.callsCacheDirty = false;

            // Touch the file that contains calls (change mtime without changing content)
            // Note: inverted callee index means only files containing calls to 'helper' are scanned
            const appPath = path.join(dir, 'app.js');
            const now = new Date();
            fs.utimesSync(appPath, now, now);

            // findCallers again — should detect mtime change and set dirty
            index.findCallers('helper');
            assert.ok(index.callsCacheDirty, 'dirty flag set after mtime change');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: skipCounts in find() avoids redundant usage counting', () => {
    it('find with skipCounts returns results without usageCount', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();'
        });
        try {
            const index = idx(dir);
            const withCounts = index.find('helper');
            const withoutCounts = index.find('helper', { skipCounts: true });

            assert.ok(withCounts.length > 0, 'find returns results');
            assert.strictEqual(withCounts.length, withoutCounts.length, 'same number of results');
            assert.ok(withCounts[0].usageCount !== undefined, 'usageCount present without skipCounts');
            assert.strictEqual(withoutCounts[0].usageCount, undefined, 'usageCount absent with skipCounts');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: _getCachedUsages string pre-check and per-op caching', () => {
    it('files without symbol name are skipped (empty array, not null)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
            'other.js': 'function unrelated() { return 2; }'
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const otherPath = path.join(dir, 'other.js');
                const result = index._getCachedUsages(otherPath, 'helper');
                assert.ok(Array.isArray(result), 'returns array, not null');
                assert.strictEqual(result.length, 0, 'empty array for file without name');

                // Verify it was cached
                const cacheKey = `${otherPath}\0helper`;
                assert.ok(index._opUsagesCache.has(cacheKey), 'result cached in _opUsagesCache');
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('per-operation cache is shared across find and usages', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();'
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                // First call populates cache
                index.find('helper', { exact: true });
                const cacheSize1 = index._opUsagesCache.size;

                // usages() should reuse cached entries
                index.usages('helper', { codeOnly: true });
                const cacheSize2 = index._opUsagesCache.size;

                // Cache may grow (usages scans all files), but shouldn't re-parse already-cached files
                assert.ok(cacheSize2 >= cacheSize1, 'cache grows or stays same');
            } finally {
                index._endOp();
            }
            // After _endOp, caches are cleared
            assert.strictEqual(index._opUsagesCache, null, 'cache cleared after endOp');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI error paths still save cache', () => {
    it('cache is saved even when command returns error', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }'
        });
        try {
            // Run a command that will fail (about with no name)
            const cliPath = path.join(__dirname, '..', 'cli', 'index.js');
            try {
                execSync(`node ${cliPath} ${dir} about`, {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) {
                // Expected to fail
            }

            // Cache should exist despite the error
            const cachePath = getProjectCachePath(dir);
            assert.ok(fs.existsSync(cachePath), 'cache file exists after failed command');
            assert.ok(!fs.existsSync(getLegacyProjectCacheDir(dir)),
                'CLI failure path must not leave a project-local cache');
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

// ============================================================================
// Performance regression baseline
// ============================================================================

describe('perf: loadCache and findCallers baseline', () => {
    it('loadCache is fast with separate callsCache file', () => {
        // Create a medium fixture (100+ files)
        const files = { 'package.json': '{"name":"perf-test"}' };
        for (let i = 0; i < 120; i++) {
            files[`mod${i}.js`] = `function fn${i}() { return run(); }\nmodule.exports = { fn${i} };`;
        }
        files['run.js'] = 'function run() { return 42; }\nmodule.exports = { run };';

        const dir = tmp(files);
        try {
            const index1 = new ProjectIndex(dir);
            index1.build('**/*.js', { quiet: true });
            // Warm up callsCache
            index1.findCallers('run');
            index1.saveCache();

            // Measure loadCache time (defers callsCache shard loading)
            const start = Date.now();
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            const loadTime = Date.now() - start;

            // loadCache is fast because callsCache shards are deferred
            assert.ok(loadTime < 500, `loadCache should be fast: ${loadTime}ms`);

            // findCallers triggers lazy callsCache load via buildCalleeIndex
            const start2 = Date.now();
            const callers = index2.findCallers('run');
            const callersTime = Date.now() - start2;

            assert.ok(callers.length >= 100, `Should find 120 callers, got ${callers.length}`);
            assert.ok(callersTime < 2000, `findCallers should complete reasonably: ${callersTime}ms`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #173: Cache v6 uses relative paths to reduce cache size
// ============================================================================
describe('Cache v6 relative paths', () => {
    it('saves relative paths and restores absolute paths correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-v6-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'),
                'function helper() { return 1; }\nmodule.exports = { helper };');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'const { helper } = require("./lib");\nfunction main() { helper(); }');

            const index1 = new ProjectIndex(tmpDir);
            index1.build(null, { quiet: true });
            index1.saveCache();

            // Check that cache uses relative paths
            const cachePath = getProjectCachePath(tmpDir);
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, CACHE_FORMAT_VERSION);

            // File keys should be relative
            for (const [key] of cacheData.files) {
                assert.ok(!path.isAbsolute(key),
                    `File key should be relative, got: ${key}`);
            }
            // Import/export graph keys should be relative
            for (const [key] of cacheData.importGraph) {
                assert.ok(!path.isAbsolute(key),
                    `ImportGraph key should be relative, got: ${key}`);
            }

            // Load into new instance and verify absolute paths are restored
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load');

            // File keys should be absolute after load
            for (const key of index2.files.keys()) {
                assert.ok(path.isAbsolute(key),
                    `File key should be absolute after load, got: ${key}`);
            }
            // Symbols should have absolute file paths
            for (const [, defs] of index2.symbols) {
                for (const s of defs) {
                    assert.ok(path.isAbsolute(s.file),
                        `Symbol file should be absolute, got: ${s.file}`);
                }
            }

            // Commands should still work
            const callers = index2.findCallers('helper', {});
            assert.ok(callers.length > 0, 'findCallers should work after v6 cache load');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('cache file is smaller with relative paths', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-v6-size-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        // Create a deep path structure to maximize savings
        const deepDir = path.join(tmpDir, 'src', 'com', 'example', 'deep', 'nested');
        fs.mkdirSync(deepDir, { recursive: true });
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(deepDir, `module${i}.js`),
                `function fn${i}() { return ${i}; }\nmodule.exports = { fn${i} };`);
        }
        fs.writeFileSync(path.join(deepDir, 'main.js'),
            'const m0 = require("./module0");\nfunction main() { m0.fn0(); }');

        try {
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            index.saveCache();

            const cachePath = getProjectCachePath(tmpDir);
            const cacheJson = fs.readFileSync(cachePath, 'utf-8');

            // Verify file keys and graph keys use relative paths.
            // The root field stores the absolute path (needed for reconstruction).
            const cacheData2 = JSON.parse(cacheJson);
            for (const [key] of cacheData2.files) {
                assert.ok(!path.isAbsolute(key),
                    `File key should be relative, got: ${key}`);
            }
            for (const [key] of cacheData2.importGraph) {
                assert.ok(!path.isAbsolute(key),
                    `ImportGraph key should be relative, got: ${key}`);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('perf: indexFile stat-first skip', () => {
    it('returns false for unchanged files (stat-only, no read)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() { return 1; }',
            'b.js': 'function b() { return 2; }'
        });
        try {
            const index = idx(dir);
            // Re-index same files — mtime+size match, should skip without reading
            assert.strictEqual(index.indexFile(path.join(dir, 'a.js')), false);
            assert.strictEqual(index.indexFile(path.join(dir, 'b.js')), false);
        } finally {
            rm(dir);
        }
    });

    it('returns true for modified files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() { return 1; }'
        });
        try {
            const index = idx(dir);
            fs.writeFileSync(path.join(dir, 'a.js'), 'function a() { return 999; }');
            assert.strictEqual(index.indexFile(path.join(dir, 'a.js')), true);
        } finally {
            rm(dir);
        }
    });

    it('updates mtime when content unchanged but file touched', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() {}'
        });
        try {
            const index = idx(dir);
            const filePath = path.join(dir, 'a.js');
            const origMtime = index.files.get(filePath).mtime;

            // Touch file — changes mtime, same content
            const futureTime = (Date.now() + 2000) / 1000;
            fs.utimesSync(filePath, futureTime, futureTime);

            const changed = index.indexFile(filePath);
            assert.strictEqual(changed, false, 'touched file should not count as changed');
            assert.notStrictEqual(index.files.get(filePath).mtime, origMtime, 'mtime should update');
        } finally {
            rm(dir);
        }
    });
});

describe('perf: skip graph rebuild on zero-change incremental', () => {
    it('preserves graphs when no files changed in forceRebuild', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            index.saveCache();

            // Load cache and forceRebuild with no changes
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            index2.build(null, { quiet: true, forceRebuild: true });

            // Graphs should be intact (from cache, not rebuilt)
            assert.ok(index2.importGraph.size > 0, 'import graph should exist');
            assert.ok(index2.symbols.has('helper'), 'symbols intact');
            assert.ok(index2.symbols.has('main'), 'symbols intact');

            // Callers should still work
            const callers = index2.findCallers('helper', {});
            assert.ok(callers.length > 0, 'callers should work');
        } finally {
            rm(dir);
        }
    });

    it('rebuilds graphs when a file changes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            index.saveCache();

            // Modify a file
            fs.writeFileSync(path.join(dir, 'app.js'),
                'const { helper } = require("./lib");\nfunction app() { helper(); helper(); }');

            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            index2.build(null, { quiet: true, forceRebuild: true });

            // New function should be indexed
            assert.ok(index2.symbols.has('app'), 'new function should be indexed');
            assert.ok(!index2.symbols.has('main'), 'old function should be gone');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Index reliability guards: the symbol table and calls cache must be
// IDENTICAL no matter how the index was produced. Catches the silent-drop
// bug class (fix #208's addSymbol passthrough: a parser field that save/load
// or incremental rebuild loses corrupts every downstream answer invisibly).
// ============================================================================

describe('index reliability: cache round-trip and incremental rebuild identity', () => {
    const { indexSnapshot } = require('./helpers');
    const FILES = {
        'package.json': '{"name":"t"}',
        'a.ts': [
            'export type AliasName = TargetType;',
            'export interface TargetType { run(): number; }',
            'export class Alpha {',
            '  override compute(x: number) { return beta(x) + 1; }',
            '  "~quoted"() { return 1; }',
            '}',
            'export function beta(y: number): number { return y * 2; }',
        ].join('\n'),
        'b.ts': [
            'import { Alpha, beta } from "./a";',
            'export function gamma() { const a = new Alpha(); return a.compute(beta(3)); }',
        ].join('\n'),
        'c.ts': 'export function gone() { return 1; }',
        // CommonJS direct-vs-property export identity must survive cache
        // round-trips (fix #286i).
        'default.js': [
            'function direct() { return 1; }',
            'function property() { return 2; }',
            'module.exports = direct;',
            'module.exports.property = property;',
        ].join('\n'),
        'inline.js': [
            'module.exports.inline = function () { return 3; };',
            'exports.arrow = () => 4;',
        ].join('\n'),
        'esm-dep.ts': 'export const named = 1; export default named;',
        'esm-imports.ts': [
            "import fallback, { named as local } from './esm-dep.js';",
            "import * as namespace from './esm-dep.js';",
            'export { fallback, local, namespace };',
        ].join('\n'),
        'callable-alias.ts': [
            'export class CachedFactory {',
            '  static create = (): CachedFactory => new CachedFactory();',
            '}',
            'const cachedFactory = CachedFactory.create;',
            'export { cachedFactory as makeCached };',
        ].join('\n'),
        'self-return.js': [
            'function Fluent() {}',
            'Fluent.prototype.next = function () { return this }',
            'function outer() { const nested = () => nested(); return nested() }',
        ].join('\n'),
        'blanket.rs': [
            'pub trait RefIter { fn par_iter(&self); }',
            'impl<I: ?Sized> RefIter for I {',
            '    fn par_iter(&self) {}',
            '}',
        ].join('\n'),
    };

    it('loadCache reproduces the exact symbol table, file entries, and calls', () => {
        const dir = tmp(FILES);
        try {
            const fresh = new ProjectIndex(dir);
            fresh.build(null, { quiet: true });
            const expected = indexSnapshot(fresh);
            fresh.saveCache();

            const reloaded = new ProjectIndex(dir);
            assert.ok(reloaded.loadCache(), 'cache should load');
            assert.strictEqual(indexSnapshot(reloaded), expected,
                'cache round-trip must not lose or alter any symbol/call field');
        } finally { rm(dir); }
    });

    it('incremental rebuild (modify+delete+add) equals a fresh build', () => {
        const dir = tmp(FILES);
        try {
            const initial = new ProjectIndex(dir);
            initial.build(null, { quiet: true });
            initial.saveCache();

            fs.unlinkSync(path.join(dir, 'c.ts'));
            fs.writeFileSync(path.join(dir, 'd.ts'),
                'import { beta } from "./a";\nexport function delta() { return beta(9); }');
            fs.writeFileSync(path.join(dir, 'b.ts'), [
                'import { Alpha } from "./a";',
                'export function gamma() { const a = new Alpha(); return a.compute(5); }',
            ].join('\n'));

            // The production incremental path (cli/index.js, mcp/server.js):
            // loadCache → stale → build with forceRebuild so deleted files are
            // swept. Plain build() after loadCache is pattern-safe by design
            // and must NOT be used for full rebuilds.
            const incremental = new ProjectIndex(dir);
            incremental.loadCache();
            incremental.build(null, { quiet: true, forceRebuild: true });

            const fresh = new ProjectIndex(dir);
            fresh.build(null, { quiet: true });

            assert.strictEqual(indexSnapshot(incremental), indexSnapshot(fresh),
                'incremental rebuild must converge to the fresh-build index');
            assert.ok(!incremental.symbols.has('gone'),
                'deleted file symbols must be swept');
        } finally { rm(dir); }
    });
});

// ============================================================================
// fix #227: index state must be CANONICAL — same repository content produces
// the same in-memory order (and therefore byte-identical command output) no
// matter how the state was reached. indexSnapshot above is normalized (sorted)
// so it cannot see these bugs; orderSnapshot is order-SENSITIVE.
//
// Two bug families this guards:
//   (a) order divergence — build filled fileEntry.symbols/bindings in parse
//       order while loadCache rebuilt them from the name map; an incremental
//       rebuild re-appended a changed file's defs at each name's array TAIL.
//       First-match resolution and account sampling then flipped between
//       consecutive runs over identical content.
//   (b) stale-calls resurrection — with shards lazily prepared, the
//       removeFileSymbols() callsCache.delete during incremental rebuild was
//       a no-op on the empty map, and the later ensureCallsCacheLoaded()
//       reinstated the PRE-EDIT call records for the changed file.
// ============================================================================

describe('fix #227: canonical index order and no stale-calls resurrection', () => {
    const { ensureCallsCacheLoaded } = require('../core/cache');
    const crypto = require('crypto');

    function orderSnapshot(index) {
        ensureCallsCacheLoaded(index);
        const rel = f => path.relative(index.root, f);
        return JSON.stringify({
            fileOrder: [...index.files.keys()].map(rel),
            perFile: [...index.files.values()].map(fe => [fe.relativePath,
                (fe.symbols || []).map(s => `${s.name}:${s.startLine}:${s.type}`),
                (fe.bindings || []).map(b => `${b.name}:${b.startLine}:${b.type}`)]),
            symbolNames: [...index.symbols.keys()],
            defs: [...index.symbols.entries()].map(([n, ds]) =>
                [n, ds.map(d => `${d.relativePath}:${d.startLine}:${d.type}`)]),
            callsMeta: [...index.callsCache.entries()].map(([f, e]) => [rel(f), e.hash]),
        });
    }

    const FILES = {
        'package.json': '{"name":"t"}',
        // class BEFORE a same-named standalone shape and interleaved members so
        // parse-emission order (functions first, then classes) differs from
        // line order — the case where canonical ordering must decide.
        'a.ts': [
            'export class Widget {',
            '  render() { return paint(1); }',
            '}',
            'export function paint(x: number) { return x; }',
            'export function render(y: number) { return paint(y); }',
        ].join('\n'),
        'b.ts': [
            'import { render } from "./a";',
            'export function screen() { return render(2); }',
        ].join('\n'),
    };

    it('loaded index state is order-identical to the freshly built one', () => {
        const dir = tmp(FILES);
        try {
            const fresh = new ProjectIndex(dir);
            fresh.build(null, { quiet: true });
            const expected = orderSnapshot(fresh);
            fresh.saveCache();

            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache(), 'cache should load');
            assert.strictEqual(orderSnapshot(loaded), expected,
                'loadCache must reproduce canonical order (fileEntry.symbols/bindings were rebuilt in name-map order before fix #227)');
        } finally { rm(dir); }
    });

    it('incremental rebuild state is order-identical to a fresh build of the same content', () => {
        const dir = tmp(FILES);
        try {
            const initial = new ProjectIndex(dir);
            initial.build(null, { quiet: true });
            initial.saveCache();

            // Modify a.ts: shift lines so defs move, keeping the same names.
            fs.writeFileSync(path.join(dir, 'a.ts'), [
                '// header comment',
                'export class Widget {',
                '  render() { return paint(1); }',
                '}',
                'export function paint(x: number) { return x + 1; }',
                'export function render(y: number) { return paint(y); }',
            ].join('\n'));

            const incremental = new ProjectIndex(dir);
            incremental.loadCache();
            incremental.build(null, { quiet: true, forceRebuild: true });
            // NO saveCache — the CLI/MCP query runs on exactly this state.

            const fresh = new ProjectIndex(dir);
            fresh.build(null, { quiet: true });

            assert.strictEqual(orderSnapshot(incremental), orderSnapshot(fresh),
                'the state a query sees after an incremental rebuild must be order-identical to a fresh build (defs were tail-appended before fix #227)');
        } finally { rm(dir); }
    });

    it('incremental rebuild refreshes the changed file\'s calls — lazy shards must not resurrect pre-edit records', () => {
        const dir = tmp(FILES);
        try {
            const initial = new ProjectIndex(dir);
            initial.build(null, { quiet: true });
            initial.saveCache();

            // New call to a NEW callee at a shifted line.
            const newB = [
                'import { render, paint } from "./a";',
                '// pushed down',
                'export function screen() { return render(2) + paint(7); }',
            ].join('\n');
            fs.writeFileSync(path.join(dir, 'b.ts'), newB);

            const incremental = new ProjectIndex(dir);
            incremental.loadCache();
            incremental.build(null, { quiet: true, forceRebuild: true });
            // NO saveCache — this is the state the command runs against.

            const entry = incremental.callsCache.get(path.join(dir, 'b.ts'));
            assert.ok(entry, 'calls entry for the changed file must exist');
            const currentHash = crypto.createHash('md5').update(newB).digest('hex');
            assert.strictEqual(entry.hash, currentHash,
                'calls entry must reflect CURRENT content (stale shard entry was resurrected before fix #227)');
            assert.ok(entry.calls.some(c => c.name === 'paint' && c.line === 3),
                'the new paint() call site must be present at its real line');
            assert.ok(incremental.calleeIndex.get('paint')?.has(path.join(dir, 'b.ts')),
                'calleeIndex must know the changed file calls paint');
        } finally { rm(dir); }
    });
});

describe('fix #342: inheritance graph is derived on load, never persisted with a path spelling', () => {
    it('a cache built through a symlinked root answers identically when loaded through the real path', () => {
        const real = fs.realpathSync(tmp({
            'go.mod': 'module example.com/embed\n\ngo 1.21\n',
            'lib/lib.go': [
                'package lib',
                '',
                'type Base struct{}',
                '',
                'func (b *Base) Close() {}',
                '',
                'type Sub struct{ Base }',
                '',
                'func (s *Sub) Close() {}',
            ].join('\n'),
            'lib/use.go': [
                'package lib',
                '',
                'func useBase() { b := &Base{}; b.Close() }',
                '',
                'func useSub() { s := &Sub{}; s.Close() }',
            ].join('\n'),
        }));
        const link = real + '-link';
        fs.symlinkSync(real, link);
        const pin = index => index.symbols.get('Close').find(d => d.relativePath === 'lib/lib.go' && d.startLine === 5);
        const confirmedLines = index => index.findCallers('Close', {
            targetDefinitions: [pin(index)], collectAccount: true, includeMethods: true, includeTests: true,
        }).filter(c => c.tier !== 'unverified').map(c => c.line).sort();
        try {
            // Build and save through the SYMLINK spelling of the root.
            const viaLink = new ProjectIndex(link, { quiet: true });
            viaLink.build(null, { quiet: true });
            viaLink.saveCache();
            const expected = confirmedLines(viaLink);
            assert.deepStrictEqual(expected, [3], 'Base.Close has one caller; Sub overrides Close');

            // Both spellings share one cache directory (the key is realpath-normalized).
            assert.strictEqual(getProjectCacheDir(link), getProjectCacheDir(real));

            // Load through the REAL spelling: every inheritance-graph file must
            // sit under index.root, and the override must still exclude s.Close().
            const viaReal = new ProjectIndex(real, { quiet: true });
            assert.ok(viaReal.loadCache(), 'cache loads under the other spelling');
            for (const entries of viaReal.extendsGraph.values()) {
                for (const entry of entries) {
                    assert.ok(entry.file.startsWith(real + path.sep), `graph file under index.root: ${entry.file}`);
                }
            }
            assert.deepStrictEqual(confirmedLines(viaReal), expected,
                'a loaded index must not confirm the overriding embed as a Base.Close caller');
        } finally {
            clearProjectCache(real);
            try { fs.unlinkSync(link); } catch { /* already gone */ }
            rm(real);
        }
    });
});

describe('fix #249: relocated project cache stays portable', () => {
    it('a cache copied to a new project identity rehydrates every path under the NEW root', () => {
        const { computeReachability } = require('../core/entrypoints');
        const dirA = tmp({
            'package.json': '{"name":"test"}',
            'cli.js': '#!/usr/bin/env node\nconst { helper } = require("./lib");\nfunction main() { helper(); }\nmain();\n',
            'lib.js': 'function helper() { return 1; }\nfunction orphan() { return 2; }\nmodule.exports = { helper };\n',
        });
        const dirB = dirA + '-copy';
        try {
            const indexA = idx(dirA);
            computeReachability(indexA);
            assert.ok(indexA._reachableSymbols && indexA._reachableSymbols.size > 0, 'reachability computed');
            indexA.saveCache();

            fs.cpSync(dirA, dirB, { recursive: true });
            fs.mkdirSync(path.dirname(getProjectCacheDir(dirB)), { recursive: true });
            fs.cpSync(getProjectCacheDir(dirA), getProjectCacheDir(dirB), { recursive: true });
            const indexB = new ProjectIndex(dirB, { quiet: true });
            const loaded = indexB.loadCache();
            assert.ok(loaded, 'copied cache loads');

            for (const abs of indexB.files.keys()) {
                assert.ok(abs.startsWith(dirB + path.sep), `file key under new root: ${abs}`);
            }
            if (indexB._reachableSymbols) {
                for (const k of indexB._reachableSymbols) {
                    assert.ok(k.startsWith(dirB + path.sep), `reachability key under new root: ${k}`);
                }
            }
            // The reachability answers must match a fresh compute in B.
            const freshB = new ProjectIndex(dirB, { quiet: true });
            freshB.build(null, { quiet: true });
            computeReachability(freshB);
            const rehydrated = computeReachability(indexB);
            const relKeys = (s, root) => [...s].map(k => path.relative(root, k)).sort();
            assert.deepStrictEqual(relKeys(rehydrated, dirB), relKeys(freshB._reachableSymbols, dirB),
                'loaded reachability answers agree with a fresh compute');
        } finally {
            clearProjectCache(dirA);
            clearProjectCache(dirB);
            rm(dirA);
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it('build() after a stale cache load drops the loaded reachability set', () => {
        const { computeReachability } = require('../core/entrypoints');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cli.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmain();\n',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };\n',
        });
        try {
            const index1 = idx(dir);
            computeReachability(index1);
            index1.saveCache();

            // Make the cache stale: add a new entry-point file.
            fs.writeFileSync(path.join(dir, 'extra.js'),
                'function fresh() { return 3; }\nfresh();\nmodule.exports = { fresh };\n');

            const index2 = new ProjectIndex(dir, { quiet: true });
            assert.ok(index2.loadCache());
            assert.ok(index2.isCacheStale(), 'new file makes the cache stale');
            index2.build(null, { quiet: true, forceRebuild: true });
            assert.ok(!index2._reachableSymbols, 'rebuild cleared the loaded set');
            const recomputed = computeReachability(index2);
            assert.ok([...recomputed].some(k => k.includes('extra.js')),
                'recomputed reachability sees the new file');
        } finally { rm(dir); }
    });
});

describe('fix: standalone --clear-cache clears the cwd project cache', () => {
    const { execFileSync } = require('child_process');
    const CLI_ENTRY = path.join(__dirname, '..', 'cli', 'index.js');

    it('clears without a target and reports the outcome', () => {
        const dir = tmp({
            'package.json': '{"name":"clear-cache-standalone"}',
            'a.js': 'function alpha() { return 1; }\nmodule.exports = { alpha };',
        });
        try {
            // Build a cache first.
            execFileSync('node', [CLI_ENTRY, dir, 'repo'],
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            assert.ok(fs.existsSync(getProjectCachePath(dir)), 'cache exists after build');

            // Standalone form, run FROM the project directory (no target arg).
            const out1 = execFileSync('node', [CLI_ENTRY, '--clear-cache'],
                { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            assert.ok(out1.includes('Cache cleared'), `expected confirmation, got: ${out1}`);
            assert.ok(!out1.includes('Usage:'), 'must not print the help banner');
            assert.ok(!fs.existsSync(getProjectCachePath(dir)), 'cache is gone');

            // Second run: nothing to clear, still exit 0 with an honest message.
            const out2 = execFileSync('node', [CLI_ENTRY, '--clear-cache'],
                { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            assert.ok(out2.includes('No cache to clear'), out2);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

describe('fix #354: cross-process build lock', () => {
    const { buildWithLock, getProjectCacheDir } = require('../core/cache');
    const { ProjectIndex } = require('../core/project');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync, spawn } = require('child_process');
    const files = {
        'package.json': '{"name":"lock-fixture"}',
        'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmodule.exports = { main };',
    };

    it('builds, saves, and removes the lock', () => {
        const dir = tmp(files);
        try {
            const index = new ProjectIndex(dir, { quiet: true });
            const out = buildWithLock(index, { quiet: true });
            assert.deepStrictEqual(out, { built: true, waited: false });
            assert.ok(!fs.existsSync(path.join(getProjectCacheDir(dir), 'build.lock')));
            const fresh = new ProjectIndex(dir, { quiet: true });
            assert.ok(fresh.loadCache(), 'cache was saved under the lock');
            assert.ok(fresh.symbols.has('helper'));
        } finally {
            rm(dir);
        }
    });

    it('breaks a lock whose holder is dead', () => {
        const dir = tmp(files);
        try {
            const cacheDir = getProjectCacheDir(dir);
            fs.mkdirSync(cacheDir, { recursive: true });
            // pid 2^22-1 is above the macOS/Linux default pid ceiling — never alive
            fs.writeFileSync(path.join(cacheDir, 'build.lock'),
                JSON.stringify({ pid: 4194303, startedAt: Date.now() }));
            const index = new ProjectIndex(dir, { quiet: true });
            const out = buildWithLock(index, { quiet: true });
            assert.strictEqual(out.built, true);
            assert.ok(!fs.existsSync(path.join(cacheDir, 'build.lock')));
        } finally {
            rm(dir);
        }
    });

    it('waits for a live holder and loads the cache it saved instead of rebuilding', async () => {
        const dir = tmp(files);
        // Own cache root: other test files wipe/prune the shared suite root
        // concurrently, which would delete the holder's live lock mid-test.
        const savedRoot = process.env.UCN_CACHE_DIR;
        const ownRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ucn-lock-'));
        process.env.UCN_CACHE_DIR = ownRoot;
        try {
            const cacheDir = getProjectCacheDir(dir);
            fs.mkdirSync(cacheDir, { recursive: true });
            // Holder: takes the lock, builds + saves after a delay, releases.
            const holderScript = `
                const fs = require('fs'); const path = require('path');
                const { ProjectIndex } = require(${JSON.stringify(path.join(__dirname, '..', 'core', 'project.js'))});
                const lock = ${JSON.stringify(path.join(cacheDir, 'build.lock'))};
                fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
                console.log('LOCKED');
                // Hold the lock until the parent says it is about to wait on
                // it (a fixed timer expires early under suite load), then a
                // little longer so the parent observably waits.
                const go = ${JSON.stringify(path.join(cacheDir, 'go'))};
                const tick = () => {
                    if (!fs.existsSync(go)) return setTimeout(tick, 25);
                    setTimeout(() => {
                        const index = new ProjectIndex(${JSON.stringify(dir)}, { quiet: true });
                        index.build(null, { quiet: true }); index.saveCache();
                        fs.unlinkSync(lock);
                    }, 600);
                };
                tick();
            `;
            const holder = spawn(process.execPath, ['-e', holderScript], {
                stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, UCN_CACHE_DIR: ownRoot },
            });
            await new Promise(resolve => holder.stdout.on('data', d => { if (String(d).includes('LOCKED')) resolve(); }));
            const index = new ProjectIndex(dir, { quiet: true });
            let waited = false;
            fs.writeFileSync(path.join(cacheDir, 'go'), '1');
            const out = buildWithLock(index, { quiet: true }, { onWait: () => { waited = true; } });
            assert.strictEqual(waited, true, 'onWait fired');
            assert.deepStrictEqual(out, { built: false, waited: true });
            assert.ok(index.symbols.has('helper'), 'loaded the holder\'s cache');
            await new Promise(resolve => holder.on('exit', resolve));
        } finally {
            process.env.UCN_CACHE_DIR = savedRoot;
            fs.rmSync(ownRoot, { recursive: true, force: true });
            rm(dir);
        }
    });

    it('CLI: concurrent cold-cache invocations share one build', async () => {
        const dir = tmp(files);
        try {
            fs.rmSync(getProjectCacheDir(dir), { recursive: true, force: true });
            const cli = path.join(__dirname, '..', 'cli', 'index.js');
            const runs = [1, 2, 3].map(() => new Promise((resolve, reject) => {
                const p = spawn(process.execPath, [cli, dir, 'find', 'helper'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = ''; let err = '';
                p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
                p.on('exit', code => code === 0 ? resolve({ out, err }) : reject(new Error(err)));
            }));
            const results = await Promise.all(runs);
            for (const r of results) assert.ok(r.out.includes('helper'), r.out);
            assert.ok(!fs.existsSync(path.join(getProjectCacheDir(dir), 'build.lock')));
            const single = execFileSync(process.execPath, [cli, dir, 'find', 'helper'], { encoding: 'utf8' });
            assert.ok(single.includes('helper'));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #419: record header constructors survive index persistence', () => {
    it('round-trips the implicit canonical parameters and the delegation answers', () => {
        const dir = tmp({
            'p/R.java': 'package p;\n\npublic record R(int x) {\n    public R(String s) { this(s.length()); }\n    public R(long l) { this(5); }\n}\n',
            'p/U.java': 'package p;\n\npublic class U {\n    static R a() { return new R(1); }\n    static R d() { return new R(7L); }\n}\n',
        });
        try {
            const read = index => {
                const record = index.symbols.get('R').find(def => def.type === 'record');
                const target = index.symbols.get('R').find(def => def.type === 'constructor' && def.params === 'long l');
                const callers = index.findCallers('R', { targetDefinitions: [target], collectAccount: true });
                return { header: record.primaryParams, callers: callers.map(site => site.line),
                    excluded: callers.accountRaw.excludedEntries.map(entry => [entry.line, entry.reason]).sort() };
            };
            const index = idx(dir);
            const before = JSON.parse(JSON.stringify(read(index)));
            assert.deepStrictEqual(before.header, [{ name: 'x', type: 'int' }]);
            index.saveCache();
            const loaded = new ProjectIndex(dir);
            assert.ok(loaded.loadCache());
            assert.deepStrictEqual(JSON.parse(JSON.stringify(read(loaded))), before);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
    it('rejects the preceding format without record header parameters', () => {
        const dir = tmp({ 'p/R.java': 'package p;\npublic record R(int x) {}\n' });
        try {
            const index = idx(dir);
            index.saveCache();
            const cacheFile = getProjectCachePath(dir);
            const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            saved.version = 307;
            fs.writeFileSync(cacheFile, JSON.stringify(saved));
            assert.strictEqual(new ProjectIndex(dir).loadCache(), false);
        } finally {
            clearProjectCache(dir);
            rm(dir);
        }
    });
});

// ============================================================================
// fix #433: test processes honor UCN_CACHE_DIR and never use the user's real
// cache root: the root is a fresh directory inside UCN_CACHE_DIR when it is
// set, else under the OS temp dir, removed when the process exits; a child
// that inherits it reuses it and leaves it to its owner.
// ============================================================================
describe('fix #433: test cache root', () => {
    const { spawnSync } = require('child_process');
    const script = `const r = require(${JSON.stringify(path.join(__dirname, 'helpers', 'cache-root.js'))});
        const fs = require('fs'); process.stdout.write(JSON.stringify({ root: r.TEST_CACHE_ROOT, exists: fs.existsSync(r.TEST_CACHE_ROOT) }));`;
    const probe = env => {
        const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
        assert.strictEqual(res.status, 0, res.stderr);
        return JSON.parse(res.stdout);
    };
    it('inside UCN_CACHE_DIR when set, removed on exit', () => {
        const parent = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ucn-433-root-'));
        const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ucn-433-home-'));
        try {
            const env = { ...process.env, HOME: home, UCN_CACHE_DIR: parent };
            delete env.UCN_TEST_CACHE_ROOT;
            const set = probe(env);
            assert.ok(set.exists && set.root.startsWith(parent + path.sep), set.root);
            assert.ok(!fs.existsSync(set.root), 'removed on exit');
            delete env.UCN_CACHE_DIR;
            delete env.XDG_CACHE_HOME;
            const unset = probe(env);
            assert.ok(unset.root.startsWith(require('os').tmpdir()), unset.root);
            assert.ok(!fs.existsSync(path.join(home, 'Library')) && !fs.existsSync(path.join(home, '.cache')),
                'the default root under HOME is never created');
            // A child of a test process shares its root and leaves it in place.
            const own = probe({ ...process.env });
            assert.strictEqual(own.root, process.env.UCN_CACHE_DIR);
            assert.ok(fs.existsSync(process.env.UCN_CACHE_DIR));
        } finally {
            fs.rmSync(parent, { recursive: true, force: true });
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// fix #433: a loaded index holds every symbol with the key order a fresh build
// gives it (saving dropped `file` and the default `bindingId` and loading
// appended them, which reordered every symbol-bearing JSON answer; they are
// saved as 0 placeholders at their built positions).
// ============================================================================
describe('fix #433: loaded symbols keep the build key order', () => {
    it('every symbol serializes identically after a cache round-trip', () => {
        const dir = tmp({
            'a.js': 'class A { m() { return 1; } }\nfunction f() { return new A().m(); }\nmodule.exports = { f, A };\n',
            'b.py': 'class B:\n    def m(self):\n        return 1\n\ndef g():\n    return B().m()\n',
            'c.go': 'package main\ntype T struct{ X int }\nfunc (t T) M() int { return t.X }\nfunc main() { _ = T{}.M() }\n',
            'd.rs': 'struct S;\nimpl S { fn m(&self) -> i32 { 1 } }\nfn f() -> i32 { S.m() }\nfn h() -> i32 { 1 } fn k() -> i32 { 2 }\n',
            'E.java': 'class E { int m() { return 1; } int n() { return m(); } }\n',
            'f.cpp': 'struct F { int m(); };\nint F::m() { return 1; }\nint use() { F f; return f.m(); }\n',
        });
        try {
            const built = idx(dir);
            const cachePath = path.join(dir, '.probe-cache', 'index.json');
            built.saveCache(cachePath);
            const loaded = new ProjectIndex(dir);
            loaded.loadCache(cachePath);
            const dump = index => [...index.symbols].map(([name, defs]) => [name, defs.map(d => JSON.stringify(d))]);
            assert.deepStrictEqual(dump(loaded), dump(built));
            const execute = require('../core/execute').execute;
            for (const handle of ['a.js:2:f', 'd.rs:3:f', 'f.cpp:3:use']) {
                assert.strictEqual(JSON.stringify(execute(loaded, 'show', { name: handle }).result),
                    JSON.stringify(execute(built, 'show', { name: handle }).result), handle);
            }
        } finally { rm(dir); }
    });
});
