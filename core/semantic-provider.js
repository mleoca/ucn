'use strict';

/**
 * Optional compiler/LSP semantic-provider contract.
 *
 * Portable AST analysis remains available without a provider. Hybrid mode
 * calls this interface explicitly and must surface `unavailable`,
 * `unsupported`, or `failed`; callers are never allowed to silently relabel
 * an AST fallback as provider-backed evidence.
 */

const PROVIDER_OPERATIONS = Object.freeze([
    'definitions',
    'references',
    'callers',
    'callees',
    'types',
    'diagnostics',
]);

function createSemanticProvider(spec) {
    if (!spec?.id) throw new Error('Semantic provider id is required');
    if (!Array.isArray(spec.languages) || spec.languages.length === 0) {
        throw new Error(`${spec.id}: at least one language is required`);
    }
    const operations = {};
    for (const operation of PROVIDER_OPERATIONS) {
        if (typeof spec[operation] === 'function') operations[operation] = spec[operation];
    }
    return Object.freeze({
        id: spec.id,
        languages: Object.freeze([...spec.languages]),
        operations: Object.freeze(Object.keys(operations)),
        prepare: typeof spec.prepare === 'function' ? spec.prepare : async () => null,
        close: typeof spec.close === 'function' ? spec.close : async () => {},
        ...operations,
    });
}

function validateSemanticProvider(provider) {
    const failures = [];
    if (!provider?.id) failures.push('provider id is required');
    if (!Array.isArray(provider?.languages) || provider.languages.length === 0) {
        failures.push(`${provider?.id || 'provider'}: languages are required`);
    }
    if (!Array.isArray(provider?.operations)) {
        failures.push(`${provider?.id || 'provider'}: operations are required`);
    } else {
        for (const operation of provider.operations) {
            if (!PROVIDER_OPERATIONS.includes(operation)) {
                failures.push(`${provider.id}: unknown operation ${operation}`);
            } else if (typeof provider[operation] !== 'function') {
                failures.push(`${provider.id}: ${operation} is not callable`);
            }
        }
    }
    if (typeof provider?.prepare !== 'function') {
        failures.push(`${provider?.id || 'provider'}: prepare() is required`);
    }
    if (typeof provider?.close !== 'function') {
        failures.push(`${provider?.id || 'provider'}: close() is required`);
    }
    return failures;
}

async function invokeSemanticProvider(provider, operation, request) {
    if (!provider) {
        return {
            status: 'unavailable',
            provider: null,
            operation,
            reason: 'no semantic provider configured',
        };
    }
    if (!PROVIDER_OPERATIONS.includes(operation)) {
        throw new Error(`Unknown semantic provider operation: ${operation}`);
    }
    if (!provider.operations.includes(operation) ||
        typeof provider[operation] !== 'function') {
        return {
            status: 'unsupported',
            provider: provider.id,
            operation,
            reason: `${provider.id} does not implement ${operation}`,
        };
    }
    try {
        const data = await provider[operation](request);
        return {
            status: 'ok',
            provider: provider.id,
            operation,
            data,
        };
    } catch (error) {
        return {
            status: 'failed',
            provider: provider.id,
            operation,
            reason: error.message || String(error),
        };
    }
}

module.exports = {
    PROVIDER_OPERATIONS,
    createSemanticProvider,
    validateSemanticProvider,
    invokeSemanticProvider,
};
