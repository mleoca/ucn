'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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
