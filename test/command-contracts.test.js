'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_COMMANDS } = require('../core/registry');
const { COMMAND_CONTRACTS, validateCommandContracts } = require('../core/command-contracts');
const { validatePublicParams } = require('../core/execute');
const { SCENARIOS } = require('./agent-public-surface-benchmark');

describe('v5 command contracts', () => {
    it('classifies every public command with a complete normative contract', () => {
        assert.deepEqual(validateCommandContracts(), []);
        assert.deepEqual(
            Object.keys(COMMAND_CONTRACTS).sort(),
            [...CANONICAL_COMMANDS].sort());
    });

    it('links every contract to its public-surface benchmark task', () => {
        const benchmarkById = new Map(SCENARIOS.map(scenario => [scenario.id, scenario]));
        for (const [command, contract] of Object.entries(COMMAND_CONTRACTS)) {
            assert.equal(benchmarkById.get(contract.benchmark)?.command, command,
                `${command} benchmark mapping`);
        }
    });

    it('keeps contracts machine-readable without a second documentation source', () => {
        const serialized = JSON.parse(JSON.stringify(COMMAND_CONTRACTS));
        assert.deepEqual(Object.keys(serialized).sort(), [...CANONICAL_COMMANDS].sort());
        for (const contract of Object.values(serialized)) {
            assert.equal(typeof contract.primaryQuestion, 'string');
            assert.ok(contract.modes.length > 0);
            assert.ok(contract.examples.length > 0);
        }
    });

    it('rejects ambiguous mode combinations before any surface dispatches', () => {
        const invalid = [
            ['impact', { name: 'save', staged: true }, /symbol target or Git diff scope/],
            ['check', { base: 'main', staged: true }, /either staged=true or base/],
            ['source', { range: '1-2' }, /requires file/],
            ['source', { name: 'save', file: 'src/a.js', range: '1-2' }, /either a symbol target or a file range/],
            ['search', { receiver: 'db', type: 'class' }, /type=call/],
            ['trace', { name: 'save', to: 'entrypoints' }, /direction=callers/],
            ['deps', { cycles: true, file: 'src/a.js' }, /cycles mode/],
            ['deps', { cycles: true, all: true }, /cycles mode/],
            ['tests', { name: 'save', depth: 2, callsOnly: true }, /direct mode/],
            ['entrypoints', { includeTests: true, excludeTests: true }, /cannot both/],
            ['endpoints', { serverOnly: true, clientOnly: true }, /cannot both/],
            ['plan', { name: 'save' }, /exactly one operation/],
            ['plan', { name: 'save', renameTo: 'store', removeParam: 'x' }, /exactly one operation/],
            ['plan', { name: 'save', renameTo: 'store', defaultValue: '0' }, /only with addParam/],
        ];
        for (const [command, params, expected] of invalid) {
            assert.match(validatePublicParams(command, params), expected, command);
        }
        assert.equal(validatePublicParams('impact', { staged: true }), null);
        assert.equal(validatePublicParams('plan', { name: 'save', renameTo: 'store' }), null);
    });
});
