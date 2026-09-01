'use strict';

/**
 * Convert normalized language IR into the persisted ProjectIndex shape.
 *
 * This is the only translation boundary used by sequential and worker builds.
 * Keeping it data-only prevents the two build paths from silently dropping
 * parser fields or changing symbol/binding behavior.
 */

function createImportBindings(imports) {
    return imports.flatMap(item => (item.names || [])
        .filter(name => name && name !== '*' && name !== '_' && name !== '.')
        .map(name => {
            const rename = (item.renames || []).find(candidate => candidate.original === name);
            return {
                name,
                module: item.module,
                ...(item.type && { kind: item.type }),
                ...(item.line != null && { line: item.line }),
                ...(rename && { alias: rename.local }),
                ...(item.defaultLike && { defaultLike: true }),
                ...(item.deferred && { deferred: true }),
            };
        }));
}

function createFileEntryFromIR({
    ir,
    filePath,
    relativePath,
    hash,
    mtime,
    size,
    lineCount,
    isBundled = false,
    isGenerated = false,
}) {
    const imports = ir.imports || [];
    const exports = ir.exports || [];
    return {
        path: filePath,
        relativePath,
        language: ir.language,
        lines: lineCount,
        hash,
        mtime,
        size,
        imports: imports.map(item => item.module),
        ...(ir.language === 'python' && {
            importDetails: imports.map(item => ({
                module: item.module,
                names: [...(item.names || [])],
                ...(item.type && { type: item.type }),
                ...(item.line != null && { line: item.line }),
                ...(item.deferred && { deferred: true }),
            })),
        }),
        globalImports: imports.filter(item => item.global).map(item => item.module),
        importNames: imports.flatMap(item => item.names || []),
        importBindings: createImportBindings(imports),
        exports: exports.map(item => item.name),
        exportDetails: exports,
        symbols: [],
        bindings: [],
        dynamicImports: ir.dynamicImports || 0,
        ...(ir.diagnostics?.parseRecovery && { parseRecovery: true }),
        ...(ir.importAliases && { importAliases: ir.importAliases }),
        ...(ir.moduleAssignedNames?.length > 0 && {
            moduleAssignedNames: ir.moduleAssignedNames,
        }),
        ...(isBundled && { isBundled: true }),
        ...(isGenerated && { isGenerated: true }),
    };
}

const OPTIONAL_SYMBOL_FIELDS = Object.freeze([
    'returnedFunctionResult', 'isFunctionVariable', 'paramTypes', 'isAsync',
    'isGenerator', 'generics', 'ownerGenerics', 'genericBounds', 'extends', 'implements', 'indent', 'isNested',
    'enclosingType', 'isMethod', 'receiver', 'memberType', 'fieldType',
    'aliasOf', 'derefTarget', 'decorators', 'decoratorsWithArgs',
    'annotationsWithArgs', 'attributesWithArgs', 'nameLine', 'traitImpl',
    'traitName', 'isSignature', 'memberAssigned', 'assignedReceiver', 'bodyScopedName',
    'registryMember', 'registryContainer', 'namespace',
    'isExtensionMethod', 'extensionReceiver', 'explicitInterface',
    'lexicalScopeStartLine', 'lexicalScopeEndLine',
    'returnTypeQualifier', 'macroNeverReturns', 'callbackParamTypes', 'iteratorItemType',
    'returnedConcreteType', 'returnedConstructors', 'templateDependent',
    'returnedCallStart', 'returnedCallEnd',
    'returnedReceiverPath',
    'isSpecialization',
    'linkage', 'functionLike', 'callableAlias', 'exportedAlias',
    'aliasOwner', 'aliasMember', 'callableTarget', 'macroParamEffects',
]);

function materializeSymbol(fileEntry, item) {
    const symbol = {
        name: item.name,
        type: item.kind,
        file: fileEntry.path,
        relativePath: fileEntry.relativePath,
        startLine: item.startLine,
        endLine: item.endLine,
        params: item.params,
        paramsStructured: item.paramsStructured,
        returnType: item.returnType,
        modifiers: item.modifiers,
        docstring: item.docstring,
        bindingId: item.id
            ? `${fileEntry.relativePath}:${item.id}`
            : `${fileEntry.relativePath}:${item.kind}:${item.startLine}`,
        ...(item.owner && { className: item.owner }),
    };
    for (const field of OPTIONAL_SYMBOL_FIELDS) {
        if (item[field] === undefined || item[field] === null) continue;
        if (Array.isArray(item[field]) && item[field].length === 0) continue;
        // Most false feature flags are omitted for compactness, but
        // functionLike=false is the semantic distinction between an
        // object-like macro and a callable macro (UCN5-170).
        if (item[field] === false && field !== 'functionLike') continue;
        symbol[field] = item[field];
    }
    return symbol;
}

function addIRSymbol(fileEntry, item, symbolTable = null) {
    const symbol = materializeSymbol(fileEntry, item);
    fileEntry.symbols.push(symbol);
    // A Rust `impl X`/`impl Trait for X` block introduces NO name into any
    // scope (fix #286b, cursive-measured: the impl symbol stole the bare-name
    // binding of ColorPair from the cross-file struct, excluding a compiler-
    // true composite-literal caller as other-definition). The struct/enum
    // claim covers the impl — same discipline as deadcode's CLASS_AUDIT_KINDS.
    if (!item.memberAssigned && !item.bodyScopedName && !item.exportedAlias &&
        item.kind !== 'impl') {
        fileEntry.bindings.push({
            id: symbol.bindingId,
            name: symbol.name,
            type: symbol.type,
            startLine: symbol.startLine,
        });
    }
    if (symbolTable) {
        if (!symbolTable.has(symbol.name)) symbolTable.set(symbol.name, []);
        symbolTable.get(symbol.name).push(symbol);
    }
    return symbol;
}

function populateFileEntryFromIR(fileEntry, ir, symbolTable = null) {
    for (const symbol of ir.symbols) addIRSymbol(fileEntry, symbol, symbolTable);
    return fileEntry;
}

module.exports = {
    createImportBindings,
    createFileEntryFromIR,
    materializeSymbol,
    addIRSymbol,
    populateFileEntryFromIR,
};
