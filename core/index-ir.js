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
            // A rename may be recorded under its original name (Python
            // `from m import a as b` lists 'a') or under its local alias
            // (Rust `use m::a as b` lists 'b', fix #357); both yield the
            // binding {name: original, alias: local}.
            const rename = (item.renames || []).find(candidate =>
                candidate.original === name || candidate.local === name);
            return {
                name: rename ? rename.original : name,
                module: item.module,
                ...(item.type && { kind: item.type }),
                ...(item.line != null && { line: item.line }),
                ...(rename && { alias: rename.local }),
                ...(item.defaultLike && { defaultLike: true }),
                ...(item.deferred && { deferred: true }),
                ...(item.dynamic && { dynamic: true }),
                ...(item.namespace && { namespace: item.namespace }),
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
        // Per-import detail records (fix #307, Python-only then; un-gated in
        // fix #338 so JS/TS function-local require()/import() and type-only
        // imports classify cycle edges the same way).
        importDetails: imports.map(item => ({
            module: item.module,
            names: [...(item.names || [])],
            ...(item.type && { type: item.type }),
            ...(item.line != null && { line: item.line }),
            ...(item.deferred && { deferred: true }),
            ...(item.deferredReason && { deferredReason: item.deferredReason }),
            // C# using directives (fix #395): the namespace the directive
            // sits in (its name resolves from there), `using static`, and
            // `global using`.
            ...(item.namespace && { namespace: item.namespace }),
            ...(item.static && { static: true }),
            ...(item.global && { global: true }),
        })),
        globalImports: imports.filter(item => item.global).map(item => item.module),
        importNames: imports.flatMap(item => item.names || []),
        importBindings: createImportBindings(imports),
        exports: exports.map(item => item.name),
        exportDetails: exports,
        symbols: [],
        bindings: [],
        dynamicImports: ir.dynamicImports || 0,
        ...(ir.diagnostics?.parseRecovery && { parseRecovery: true }),
        ...(ir.diagnostics?.parseErrorRegions?.length > 0 && {
            parseErrorRegions: ir.diagnostics.parseErrorRegions,
        }),
        ...(ir.importAliases && { importAliases: ir.importAliases }),
        ...(ir.moduleAssignedNames?.length > 0 && {
            moduleAssignedNames: ir.moduleAssignedNames,
        }),
        ...(ir.asyncClosureNames?.length > 0 && {
            asyncClosureNames: ir.asyncClosureNames,
        }),
        ...(Array.isArray(ir.openCalls) && { openCalls: ir.openCalls }),
        ...(ir.typeConversions?.length > 0 && {
            typeConversions: ir.typeConversions,
        }),
        ...(ir.reflectionSites?.length > 0 && {
            reflectionSites: ir.reflectionSites,
        }),
        ...(ir.macroScopeMarkers?.length > 0 && {
            macroScopeMarkers: ir.macroScopeMarkers,
        }),
        ...(ir.cppUsings?.length > 0 && {
            cppUsings: ir.cppUsings,
        }),
        ...(ir.languageFeatures?.length > 0 && {
            languageFeatures: ir.languageFeatures,
        }),
        ...(Array.isArray(ir.conditionalViews) && { conditionalViews: ir.conditionalViews }),
        ...(ir.packageName && { packageName: ir.packageName }),
        ...(ir.moduleValueAliases?.length > 0 && { moduleValueAliases: ir.moduleValueAliases }),
        ...(Array.isArray(ir.recoveryBlanks) && { recoveryBlanks: ir.recoveryBlanks }),
        ...(Array.isArray(ir.recoveryCandidates) && { recoveryCandidates: ir.recoveryCandidates }),
        ...(Array.isArray(ir.externalMacroNames) && { externalMacroNames: ir.externalMacroNames }),
        ...(isBundled && { isBundled: true }),
        ...(isGenerated && { isGenerated: true }),
    };
}

const OPTIONAL_SYMBOL_FIELDS = Object.freeze([
    'returnedFunctionResult', 'isFunctionVariable', 'paramTypes', 'isAsync',
    'isGenerator', 'generics', 'ownerGenerics', 'genericBounds', 'extends', 'implements', 'indent', 'isNested',
    'enclosingType', 'isMethod', 'receiver', 'memberType', 'fieldType', 'embedded',
    'aliasOf', 'aliasQualifier', 'aliasMembers', 'aliasTypeText', 'aliasTypeParameters', 'aliasTypeDefaults', 'derefTarget', 'decorators', 'decoratorsWithArgs',
    'annotationsWithArgs', 'attributesWithArgs', 'nameLine', 'traitImpl',
    'traitName', 'isSignature', 'memberAssigned', 'assignedReceiver', 'assignedObject', 'selfNamed', 'bodyScopedName',
    'registryMember', 'registryContainer', 'registryContainerType', 'objectLiteralLine', 'namespace',
    'isExtensionMethod', 'extensionReceiver', 'explicitInterface',
    'lexicalScopeStartLine', 'lexicalScopeEndLine',
    'returnTypeQualifier', 'returnTypeResolved', 'supertraits', 'ownerGenericBounds', 'ownerSelfArgs', 'implSelfRef', 'implSelfQualifier', 'blanketSelfBounds', 'selfParamKind', 'macroNeverReturns', 'callbackParamTypes', 'iteratorItemType', 'futureReturn',
    'returnedConcreteType', 'returnedConstructors', 'templateDependent',
    'returnedCallStart', 'returnedCallEnd',
    'returnedReceiverPath', 'valueType',
    'isSpecialization',
    'linkage', 'functionLike', 'callableAlias', 'exportedAlias',
    'aliasOwner', 'aliasMember', 'callableTarget', 'macroParamEffects',
    'namespaceScope', 'ppParams', 'ppVariadic', 'ppBody', 'ppConditional', 'languageBranch', 'macroExpansion', 'macroScope', 'accessAfterMacro', 'ppBranch',
    'generatedByMacro',
    'typeArity', 'ownerTypeArity',
    'annotationType', 'valueShape', 'friendOf', 'templateParams', 'delegateParams',
        'typedefName',
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
