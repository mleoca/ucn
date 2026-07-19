'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CANONICAL_COMMANDS } = require('../core/registry');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { formatDoctor, formatDoctorJson } = require('../core/output');
const {
    PROOF_CATALOG,
    COMMAND_TRUST_MATRIX,
    summarizeCommandTrust,
} = require('../core/trust-matrix');

const ROOT = path.join(__dirname, '..');

describe('command trust matrix: fail-closed proof coverage', () => {
    it('classifies every canonical command exactly once', () => {
        const canonical = [...CANONICAL_COMMANDS].sort();
        const classified = Object.keys(COMMAND_TRUST_MATRIX).sort();
        assert.deepStrictEqual(classified, canonical,
            'adding/removing a command requires an explicit trust-matrix decision');
    });

    it('references only registered, existing proof artifacts', () => {
        for (const [command, spec] of Object.entries(COMMAND_TRUST_MATRIX)) {
            assert.ok(spec.claim, `${command}: claim is required`);
            assert.ok(spec.performanceClass, `${command}: performance class is required`);
            assert.ok(spec.decisionSafety, `${command}: decision safety is required`);
            assert.ok(Array.isArray(spec.proofs) && spec.proofs.length > 0,
                `${command}: at least one falsifiable proof is required`);
            assert.ok(spec.proofs.includes('surface-parity'),
                `${command}: all public commands require three-surface parity proof`);
            for (const proofId of spec.proofs) {
                const proof = PROOF_CATALOG[proofId];
                assert.ok(proof, `${command}: unknown proof ${proofId}`);
                assert.ok(fs.existsSync(path.join(ROOT, proof.artifact)),
                    `${command}: proof artifact missing: ${proof.artifact}`);
            }
        }
    });

    it('keeps high-risk semantic commands on an external oracle', () => {
        const required = [
            'about', 'context', 'impact', 'blast', 'smart', 'trace',
            'reverseTrace', 'example', 'related', 'find', 'usages', 'tests',
            'affectedTests', 'deadcode', 'fn', 'class', 'verify', 'plan',
            'diffImpact', 'check', 'typedef', 'brief',
        ];
        for (const command of required) {
            const spec = COMMAND_TRUST_MATRIX[command];
            assert.ok(spec.proofs.some(id => PROOF_CATALOG[id].kind === 'external-oracle'),
                `${command}: high-risk semantic claim must be externally oracle-backed`);
        }
    });

    it('labels destructive or heuristic outputs review-only/advisory', () => {
        for (const command of ['deadcode', 'entrypoints', 'endpoints', 'example', 'auditAsync', 'stacktrace']) {
            assert.strictEqual(COMMAND_TRUST_MATRIX[command].decisionSafety, 'advisory-only',
                `${command}: must not imply autonomous safety`);
        }
        for (const command of ['about', 'impact', 'verify', 'plan', 'diffImpact', 'check', 'api']) {
            assert.strictEqual(COMMAND_TRUST_MATRIX[command].decisionSafety, 'review-required');
        }
    });

    it('summary is explicit proof classification, never runtime accuracy', () => {
        const summary = summarizeCommandTrust();
        assert.strictEqual(summary.commands, CANONICAL_COMMANDS.length);
        assert.strictEqual(summary.classified, CANONICAL_COMMANDS.length);
        assert.strictEqual(summary.unclassified, 0);
        assert.ok(summary.oracleBacked > 0);
        assert.strictEqual(summary.contract, 'proof-classification-not-runtime-accuracy');
        assert.ok(!Object.hasOwn(summary, 'accuracy'));
    });

    it('doctor exposes the proof contract without calling it accuracy', () => {
        const dir = tmp({ 'app.js': 'export function run() { return 1; }' });
        try {
            const result = execute(idx(dir), 'doctor', {});
            assert.ok(result.ok, result.error);
            assert.deepStrictEqual(result.result.commandTrust, summarizeCommandTrust());
            assert.match(formatDoctor(result.result), /classification describes shipped proof coverage/i);
            const json = JSON.parse(formatDoctorJson(result.result));
            assert.strictEqual(json.commandTrust.contract,
                'proof-classification-not-runtime-accuracy');
            assert.ok(!Object.hasOwn(json.commandTrust, 'accuracy'));
        } finally { rm(dir); }
    });

    it('the caller engine source parses without an embedded raw NUL separator', () => {
        const source = fs.readFileSync(path.join(ROOT, 'core', 'callers.js'));
        assert.strictEqual(source.includes(0), false,
            'use a JavaScript \\0 escape; a raw NUL makes tree-sitter recover and weakens the index');
    });

    it('the packaged skill command reference lists every canonical command', () => {
        const commandRef = fs.readFileSync(path.join(
            ROOT, '.claude', 'skills', 'ucn', 'references', 'commands.md'), 'utf8');
        for (const command of CANONICAL_COMMANDS) {
            const cliName = command.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
            assert.ok(commandRef.includes('`' + cliName),
                `skill command reference must list ${cliName}`);
        }
    });

    it('release and weekly workflows execute semantic, deadcode, and performance gates', () => {
        const pkg = require('../package.json');
        assert.match(pkg.scripts['trust:gate'], /trust:gate:semantic/);
        assert.match(pkg.scripts['trust:gate'], /trust:gate:deadcode/);
        assert.match(pkg.scripts['trust:gate'], /trust:gate:performance/);
        const publish = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
        const weekly = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8');
        assert.match(publish, /npm run trust:gate/);
        assert.match(weekly, /trust:gate:performance/);
    });
});
