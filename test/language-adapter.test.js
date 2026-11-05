'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PROJECT_DIR } = require('./helpers');

const {
    LANGUAGES,
    getLanguageAdapter,
    getParser,
} = require('../languages');
const {
    createNoopLanguageAdapter,
    validateLanguageAdapter,
} = require('../languages/adapter');
const {
    IR_SCHEMA_VERSION,
    createEvidenceEdge,
    validateFileIR,
} = require('../core/ir');
const {
    createSemanticProvider,
    validateSemanticProvider,
    invokeSemanticProvider,
} = require('../core/semantic-provider');

const SAMPLES = {
    javascript: 'function alpha() { return 1; }\n',
    typescript: 'function alpha(): number { return 1; }\n',
    tsx: 'function Alpha() { return <div />; }\n',
    python: 'def alpha():\n    return 1\n',
    go: 'package main\nfunc alpha() int { return 1 }\n',
    rust: 'fn alpha() -> i32 { 1 }\n',
    java: 'class Sample { static int alpha() { return 1; } }\n',
    c: 'int alpha(void) { return 1; }\n',
    cpp: 'int alpha() { return 1; }\n',
    csharp: 'class Sample { public static int alpha() { return 1; } }\n',
    html: '<script>function alpha() { return 1; }</script>\n',
};

describe('v5 language adapter boundary', () => {
    it('only opted-in occurrence scans omit receiver facts, never lexical-scope requests', () => {
        const { createLanguageAdapter } = require('../languages/adapter');
        for (const usageKindsOnly of [undefined, false, true]) {
            const reads = [];
            const adapter = createLanguageAdapter({ name: 'sample', traits: { usageKindsOnly },
                module: () => ({ findUsagesInCode(...args) { reads.push(args); return []; } }) });
            adapter.findUsages('source', 'name', null, null, { usageKindsOnly: true });
            adapter.findUsages('source', 'name', null, null, { usageKindsOnly: true, lexicalScopes: true });
            adapter.findUsages('source', 'name', null, null);
            assert.deepEqual(reads[0].slice(4), usageKindsOnly ? [{ usageKindsOnly: true }] : []);
            assert.deepEqual(reads[1].slice(4), [{ lexicalScopes: true }]);
            assert.equal(reads[2].length, 4);
        }
    });

    it('forwards call-recovery options only to parsers of call-shaped macros', () => {
        const { createLanguageAdapter } = require('../languages/adapter');
        for (const macroInvocationSyntax of [undefined, 'marked', 'call']) {
            const reads = [];
            const adapter = createLanguageAdapter({ name: 'sample', traits: { macroInvocationSyntax },
                module: () => ({ findUsagesInCode(...args) { reads.push(args); return []; } }) });
            adapter.findUsages('source', 'name', null, null, { skipCallRecovery: true });
            adapter.findUsages('source', 'name', null, null, { skipCallRecovery: true, lexicalScopes: true });
            adapter.findUsages('source', 'name', null, null);
            assert.deepEqual(reads[0].slice(4), macroInvocationSyntax === 'call' ? [{ skipCallRecovery: true }] : []);
            assert.deepEqual(reads[1].slice(4), [{ lexicalScopes: true,
                ...(macroInvocationSyntax === 'call' && { skipCallRecovery: true }) }]);
            assert.equal(reads[2].length, 4);
        }
    });

    it('fix #415: optional query declarations match every existing parser hook', () => {
        for (const language of Object.keys(LANGUAGES)) {
            const adapter = getLanguageAdapter(language);
            assert.equal(LANGUAGES[language].traits.plainQueryTree,
                typeof adapter.queryTree !== 'function', language);
            assert.equal(LANGUAGES[language].traits.scopeAlternativeBindings,
                typeof adapter.findScopeAlternativeBindings === 'function', language);
        }
    });

    it('fix #415: literal query trees do not load analysis modules', () => {
        const script = `
            const assert=require('node:assert/strict'),path=require('node:path');
            const root=${JSON.stringify(PROJECT_DIR)},samples=${JSON.stringify(SAMPLES)};
            const {ProjectIndex}=require(root+'/core/project');
            const {LANGUAGES}=require(root+'/languages');
            for(const language of Object.keys(samples).filter(name=>name!=='csharp')){
                LANGUAGES[language].module=()=>{throw Error('analysis module was requested: '+language);};
                const index=new ProjectIndex(root),file=path.join(root,'query.'+language);
                index.files.set(file,{language,hash:'literal-query',relativePath:'query.'+language});
                index._beginOp();
                try{
                    const tree=index._getParsedTree(file,samples[language],language);
                    assert.ok(tree,language);
                    assert.equal(tree.rootNode.hasError,false,language);
                    assert.equal(index._getParsedTree(file,samples[language],language),tree,language+' cache');
                }finally{index._endOp();}
            }
        `;
        execFileSync(process.execPath, ['-e', script], { cwd: PROJECT_DIR });
    });

    it('fix #415: configured and extension query-tree hooks still run', () => {
        const script = `
            const assert=require('node:assert/strict'),path=require('node:path');
            const root=${JSON.stringify(PROJECT_DIR)};
            const {ProjectIndex}=require(root+'/core/project');
            const {LANGUAGES,safeParse}=require(root+'/languages');
            const raw=LANGUAGES.csharp.module;let csharpCalls=0,extensionCalls=0;
            LANGUAGES.csharp.module=()=>({...raw(),queryTree(...args){csharpCalls++;return raw().queryTree(...args);}});
            LANGUAGES.query_extension={name:'query_extension',extensions:[],traits:{typeSystem:'structural'},
                treeSitterLang:'javascript',treeSitterModule:()=>require(root+'/node_modules/tree-sitter-javascript'),
                module:()=>({parse:()=>({functions:[],classes:[]}),findCallsInCode:()=>[],
                    findImportsInCode:()=>[],findExportsInCode:()=>[],findUsagesInCode:()=>[],
                    isEntryPoint:()=>false,getEntryPointKind:()=>null,
                    queryTree(code,parser){extensionCalls++;return safeParse(parser,code);}})};
            for(const[language,code]of [['csharp','class Example {}'],['query_extension','const value=1;']]){
                const index=new ProjectIndex(root),file=path.join(root,'query.'+language);
                index.files.set(file,{language,hash:'custom-query',relativePath:'query.'+language});
                index._beginOp();try{assert.ok(index._getParsedTree(file,code,language),language);}finally{index._endOp();}
            }
            assert.equal(csharpCalls,1);assert.equal(extensionCalls,1);
        `;
        execFileSync(process.execPath, ['-e', script], { cwd: PROJECT_DIR });
    });

    it('fix #415: an undeclared extension scope hook is still discovered', () => {
        const script = `
            const assert=require('node:assert/strict');
            const root=${JSON.stringify(PROJECT_DIR)};
            const {ProjectIndex}=require(root+'/core/project');
            const {execute}=require(root+'/core/execute');
            const {LANGUAGES}=require(root+'/languages');
            const {tmp,rm}=require(root+'/test/helpers');
            const raw=LANGUAGES.c.module;let calls=0;
            delete LANGUAGES.c.traits.scopeAlternativeBindings;
            LANGUAGES.c.module=()=>({...raw(),findScopeAlternativeBindings(){calls++;return[];}});
            const dir=tmp({'a.c':'void alpha(void){}'});
            try{
                const index=new ProjectIndex(dir);index.build(null,{quiet:true,workers:0});
                const result=execute(index,'plan',{name:'a.c:1:alpha',renameTo:'beta'});
                assert.ok(result.ok,result.error);assert.equal(calls,1);
            }finally{rm(dir);}
        `;
        execFileSync(process.execPath, ['-e', script], { cwd: PROJECT_DIR });
    });

    it('wraps every existing language in one conforming adapter', () => {
        for (const language of Object.keys(LANGUAGES)) {
            const adapter = getLanguageAdapter(language);
            assert.deepEqual(validateLanguageAdapter(adapter), [], language);
            assert.equal(adapter.id, language);
            assert.equal(adapter, getLanguageAdapter(language), `${language} adapter cache`);
            assert.equal(adapter.capabilities.symbols, true);
            assert.equal(adapter.capabilities.calls, true);
            assert.equal(adapter.capabilities.usages, true);
        }
    });

    it('normalizes every existing parser into the same versioned file IR', () => {
        for (const [language, code] of Object.entries(SAMPLES)) {
            const adapter = getLanguageAdapter(language);
            const ir = adapter.analyze(code, getParser(language), `sample${adapter.extensions[0]}`);
            assert.equal(ir.schemaVersion, IR_SCHEMA_VERSION, language);
            assert.deepEqual(validateFileIR(ir), [], language);
            assert.equal(ir.language, language);
            assert.ok(ir.symbols.length > 0, `${language} should extract a symbol`);
            assert.ok(ir.symbols.some(symbol =>
                symbol.name === 'alpha' || symbol.name === 'Alpha'), language);
        }
    });

    it('provides a no-op conformance adapter for extension-boundary tests', () => {
        const adapter = createNoopLanguageAdapter({
            id: 'future-language',
            extensions: ['.future'],
            traits: { typeSystem: 'nominal' },
        });
        assert.deepEqual(validateLanguageAdapter(adapter, { analyzeSample: true }), []);
        const ir = adapter.analyze('placeholder\n', null, 'sample.future');
        assert.deepEqual(validateFileIR(ir), []);
        assert.deepEqual(ir.symbols, []);
        assert.equal(ir.totalLines, 2);
    });

    it('normalizes evidence without treating its ordinal tier as probability', () => {
        assert.deepEqual(createEvidenceEdge({
            from: 'caller',
            to: 'callee',
            site: { file: 'a.js', line: 1 },
            tier: 'unverified',
            resolution: 'method-ambiguous',
            reason: 'receiver type is unknown',
            evidence: { receiverKnown: false },
        }), {
            schemaVersion: IR_SCHEMA_VERSION,
            from: 'caller',
            to: 'callee',
            site: { file: 'a.js', line: 1 },
            tier: 'unverified',
            resolution: 'method-ambiguous',
            reason: 'receiver type is unknown',
            evidence: { receiverKnown: false },
        });
        assert.throws(() => createEvidenceEdge({
            tier: 'probable',
            resolution: 'guess',
        }), /Unknown evidence tier/);
    });
});

describe('v5 semantic provider boundary', () => {
    it('reports unavailable, unsupported, failed, and successful states explicitly', async () => {
        assert.equal(
            (await invokeSemanticProvider(null, 'references', {})).status,
            'unavailable');

        const provider = createSemanticProvider({
            id: 'fixture-provider',
            languages: ['typescript'],
            references: async request => [{ file: request.file, line: 1 }],
            types: async () => { throw new Error('provider crashed'); },
        });
        assert.deepEqual(validateSemanticProvider(provider), []);

        const unsupported = await invokeSemanticProvider(provider, 'callers', {});
        assert.equal(unsupported.status, 'unsupported');
        assert.match(unsupported.reason, /does not implement callers/);

        const failed = await invokeSemanticProvider(provider, 'types', {});
        assert.equal(failed.status, 'failed');
        assert.equal(failed.reason, 'provider crashed');
        assert.equal(Object.hasOwn(failed, 'data'), false,
            'failure must not carry an unlabeled AST fallback');

        const ok = await invokeSemanticProvider(provider, 'references', {
            file: 'src/a.ts',
        });
        assert.deepEqual(ok, {
            status: 'ok',
            provider: 'fixture-provider',
            operation: 'references',
            data: [{ file: 'src/a.ts', line: 1 }],
        });
    });
});
