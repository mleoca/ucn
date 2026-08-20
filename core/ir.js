'use strict';

/**
 * Normalized language-analysis boundary for v5.
 *
 * ProjectIndex and build workers consume this shape directly. Language
 * adapters must not leak tree-sitter nodes or raw parser-module objects across
 * this boundary. The shape is deliberately data-only and versioned.
 */

const IR_SCHEMA_VERSION = 1;
const EVIDENCE_TIERS = Object.freeze(['confirmed', 'unverified', 'excluded']);

function normalizeSymbol(symbol, family, language, kind, owner = null) {
    let normalizedOwner = owner || symbol.className || null;
    if (!normalizedOwner && symbol.receiver && family === 'callable') {
        // Go and some Rust parser records expose methods as top-level
        // functions with a receiver. Normalize their owning type here so
        // every index consumer sees the same method identity.
        normalizedOwner = String(symbol.receiver)
            .replace(/^[*&]\s*/, '')
            .replace(/^mut\s+/, '')
            .replace(/<.*$/, '')
            .trim();
        if (normalizedOwner === 'self' || normalizedOwner === 'Self') {
            normalizedOwner = null;
        }
    }
    const normalized = {
        id: symbol.bindingId || null,
        name: symbol.name,
        kind,
        family,
        language,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        ...(normalizedOwner && { owner: normalizedOwner }),
        ...(symbol.receiver && { receiver: symbol.receiver }),
        ...(symbol.params !== undefined && { params: symbol.params }),
        ...(symbol.paramsStructured && { paramsStructured: symbol.paramsStructured }),
        ...(symbol.returnType && { returnType: symbol.returnType }),
        modifiers: [...(symbol.modifiers || [])],
    };
    const passthrough = [
        'docstring', 'returnedFunctionResult', 'isFunctionVariable', 'paramTypes',
        'isAsync', 'isGenerator', 'generics', 'extends', 'implements', 'indent',
        'isNested', 'enclosingType', 'isMethod', 'memberType', 'fieldType',
        'aliasOf', 'derefTarget', 'decorators', 'decoratorsWithArgs',
        'annotationsWithArgs', 'attributesWithArgs', 'nameLine', 'traitImpl',
        'traitName', 'isSignature', 'memberAssigned', 'assignedReceiver', 'bodyScopedName',
        'registryMember', 'registryContainer', 'isConstructor',
        'isExtensionMethod', 'extensionReceiver', 'explicitInterface',
        'namespace', 'lexicalScopeStartLine', 'lexicalScopeEndLine',
        'returnTypeQualifier', 'macroNeverReturns', 'callbackParamTypes', 'iteratorItemType',
        'returnedConcreteType', 'returnedConstructors', 'templateDependent',
        'isSpecialization',
        'linkage', 'functionLike', 'callableAlias', 'exportedAlias',
        'aliasOwner', 'aliasMember',
    ];
    for (const field of passthrough) {
        if (symbol[field] !== undefined && symbol[field] !== null) {
            normalized[field] = Array.isArray(symbol[field])
                ? [...symbol[field]]
                : symbol[field];
        }
    }
    return normalized;
}

function createFileIR({
    language,
    file = null,
    parsed = {},
    calls = [],
    capabilities = {},
} = {}) {
    const functions = parsed.functions || [];
    const classes = parsed.classes || [];
    const stateObjects = parsed.stateObjects || [];
    const macros = parsed.macros || [];
    const normalizedSymbols = [];
    const seen = new Set();
    const append = (symbol, family, kind, owner = null) => {
        const key = `${owner || symbol.className || ''}\0${symbol.name}\0${kind}\0` +
            `${symbol.startLine}\0${symbol.endLine}`;
        if (seen.has(key)) return;
        seen.add(key);
        normalizedSymbols.push(normalizeSymbol(symbol, family, language, kind, owner));
    };
    for (const symbol of functions) {
        append(symbol, 'callable',
            symbol.type || (symbol.isConstructor ? 'constructor' : 'function'));
    }
    for (const type of classes) {
        append(type, 'type', type.type || 'class');
        for (const member of type.members || []) {
            const inherited = {
                ...member,
                ...(type.namespace && member.namespace == null && {
                    namespace: type.namespace,
                }),
                ...(type.enclosingType && member.enclosingType == null && {
                    enclosingType: type.enclosingType,
                }),
                ...(type.traitName && {
                    traitImpl: true,
                    traitName: type.traitName,
                }),
            };
            append(inherited,
                inherited.memberType === 'field' ? 'state' : 'callable',
                inherited.memberType || (inherited.isConstructor ? 'constructor' : 'method'),
                type.name);
        }
    }
    for (const symbol of stateObjects) append(symbol, 'state', 'state');
    for (const symbol of macros) append(symbol,
        symbol.functionLike ? 'callable' : 'state', 'macro');
    // An immutable module-scope member alias has the callable signature of
    // the class member it captures: `const make = Widget.create`. Materialize
    // the local value and each explicit export alias as real function symbols
    // only when its member is static and every declared return type agrees.
    // This is compiler-visible identity; mutable aliases and ambiguous
    // overload returns were rejected by the parser/agreement gate above.
    for (const alias of (parsed.callableAliases || [])) {
        const sources = normalizedSymbols.filter(symbol =>
            symbol.name === alias.member && symbol.owner === alias.owner &&
            (symbol.params !== undefined || symbol.paramsStructured) &&
            (symbol.modifiers?.includes('static') ||
                String(symbol.memberType || symbol.kind).startsWith('static')) &&
            symbol.returnType);
        if (sources.length === 0) continue;
        const sourceReturns = new Set(sources.map(source => source.returnType));
        if (sourceReturns.size !== 1) continue;
        const source = sources[0];
        const exported = (parsed.exports || []).filter(item =>
            !item.source && item.name === alias.name);
        const exposed = exported.map(item => ({
            name: item.type === 'default' ? 'default' : (item.alias || item.name),
            line: item.line || alias.startLine,
        }));
        const localIsExported = exposed.some(item => item.name === alias.name);
        const makeAlias = (name, startLine, isExported, exportedAlias = false) => ({
            bindingId: `callable-alias:${alias.owner}.${alias.member}:${name}:${startLine}`,
            name,
            startLine,
            endLine: startLine,
            params: source.params,
            ...(source.paramsStructured && { paramsStructured: source.paramsStructured }),
            returnType: source.returnType,
            modifiers: isExported ? ['export'] : [],
            callableAlias: true,
            ...(exportedAlias && { exportedAlias: true }),
            aliasOwner: alias.owner,
            aliasMember: alias.member,
        });
        append(makeAlias(alias.name, alias.startLine, localIsExported),
            'callable', 'function');
        for (const item of exposed) {
            if (item.name === alias.name) continue;
            append(makeAlias(item.name, item.line, true, true), 'callable', 'function');
        }
    }
    const imports = [...(parsed.imports || [])];
    return {
        schemaVersion: IR_SCHEMA_VERSION,
        language,
        file,
        totalLines: parsed.totalLines || 0,
        symbols: normalizedSymbols,
        calls: [...calls],
        imports,
        exports: [...(parsed.exports || [])],
        dynamicImports: imports.filter(item => item.dynamic).length,
        importAliases: parsed.imports?.aliases || null,
        moduleAssignedNames: [...(parsed.moduleAssignedNames || [])],
        diagnostics: {
            parseRecovery: !!parsed.parseRecovery,
        },
        capabilities: { ...capabilities },
    };
}

function validateFileIR(ir) {
    const failures = [];
    if (!ir || typeof ir !== 'object') return ['IR must be an object'];
    if (ir.schemaVersion !== IR_SCHEMA_VERSION) {
        failures.push(`schemaVersion must be ${IR_SCHEMA_VERSION}`);
    }
    if (typeof ir.language !== 'string' || !ir.language) failures.push('language is required');
    for (const field of ['symbols', 'calls', 'imports', 'exports']) {
        if (!Array.isArray(ir[field])) failures.push(`${field} must be an array`);
    }
    if (!Number.isInteger(ir.totalLines) || ir.totalLines < 0) {
        failures.push('totalLines must be a non-negative integer');
    }
    for (const [index, symbol] of (ir.symbols || []).entries()) {
        if (!symbol?.name) failures.push(`symbols[${index}].name is required`);
        if (!symbol?.kind) failures.push(`symbols[${index}].kind is required`);
        if (!symbol?.family) failures.push(`symbols[${index}].family is required`);
        if (!Number.isInteger(symbol?.startLine) || symbol.startLine < 1) {
            failures.push(`symbols[${index}].startLine must be a positive integer`);
        }
        if (!Number.isInteger(symbol?.endLine) || symbol.endLine < symbol.startLine) {
            failures.push(`symbols[${index}].endLine must be >= startLine`);
        }
    }
    return failures;
}

function createEvidenceEdge({
    from = null,
    to = null,
    site,
    tier,
    resolution,
    reason = null,
    evidence = {},
} = {}) {
    if (!EVIDENCE_TIERS.includes(tier)) {
        throw new Error(`Unknown evidence tier: ${tier}`);
    }
    if (!resolution) throw new Error('Evidence resolution is required');
    return {
        schemaVersion: IR_SCHEMA_VERSION,
        from,
        to,
        site,
        tier,
        resolution,
        ...(reason && { reason }),
        evidence: { ...evidence },
    };
}

module.exports = {
    IR_SCHEMA_VERSION,
    EVIDENCE_TIERS,
    createFileIR,
    validateFileIR,
    createEvidenceEdge,
};
