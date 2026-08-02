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
                ...(rename && { alias: rename.local }),
                ...(item.defaultLike && { defaultLike: true }),
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
    'isGenerator', 'generics', 'extends', 'implements', 'indent', 'isNested',
    'enclosingType', 'isMethod', 'receiver', 'memberType', 'fieldType',
    'aliasOf', 'derefTarget', 'decorators', 'decoratorsWithArgs',
    'annotationsWithArgs', 'attributesWithArgs', 'nameLine', 'traitImpl',
    'traitName', 'isSignature', 'memberAssigned', 'bodyScopedName',
    'registryMember', 'registryContainer', 'namespace',
    'isExtensionMethod', 'extensionReceiver', 'explicitInterface',
    'lexicalScopeStartLine', 'lexicalScopeEndLine',
    'returnTypeQualifier', 'macroNeverReturns', 'callbackParamTypes', 'iteratorItemType',
    'returnedConcreteType', 'returnedConstructors', 'templateDependent',
    'linkage',
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
        bindingId: `${fileEntry.relativePath}:${item.kind}:${item.startLine}`,
        ...(item.owner && { className: item.owner }),
    };
    for (const field of OPTIONAL_SYMBOL_FIELDS) {
        if (item[field] === undefined || item[field] === null) continue;
        if (Array.isArray(item[field]) && item[field].length === 0) continue;
        if (item[field] === false) continue;
        symbol[field] = item[field];
    }
    return symbol;
}

function addIRSymbol(fileEntry, item, symbolTable = null) {
    const symbol = materializeSymbol(fileEntry, item);
    fileEntry.symbols.push(symbol);
    if (!item.memberAssigned && !item.bodyScopedName) {
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
