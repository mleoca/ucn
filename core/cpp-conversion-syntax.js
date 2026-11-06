'use strict';

const { getParser, safeParse } = require('../languages');
const { SourceMemo, parsedSource } = require('./source-memo');
const { projectFact } = require('./provenance-overload');
const { ownConstructors } = require('./constructor-calls');
const { expandDeclaration } = require('./macro-expansion');
const { ownerDefinitionOf } = require('./class-identity');
const { declarationIdentity, sameDeclaration } = require('./provenance');

const snippets = new SourceMemo();
const CLASSES = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);
const DECLARATIONS = new Set([...CLASSES, 'alias_declaration', 'type_definition', 'function_definition',
    'field_declaration', 'declaration', 'template_declaration']);

function definitionNode(tree, definition) {
    const start = definition.sourceSpan?.start;
    if (!Number.isInteger(start)) return null;
    let node = tree.rootNode.descendantForIndex(start, start + 1);
    while (node && !DECLARATIONS.has(node.type)) node = node.parent;
    if (node?.type === 'template_declaration') return node.namedChildren.find(child =>
        DECLARATIONS.has(child.type) && child.type !== 'template_declaration') || node;
    return node;
}

function headerNodes(node, result = []) {
    if (!node || node.type === 'compound_statement') return result;
    result.push(node);
    for (const child of node.namedChildren) headerNodes(child, result);
    return result;
}

function inPreprocessorCondition(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (!parent.type.startsWith('preproc_')) continue;
        const condition = parent.childForFieldName('condition') || parent.childForFieldName('name');
        if (condition && condition.startIndex <= node.startIndex && node.endIndex <= condition.endIndex) return true;
    }
    return false;
}

function templateParameters(node) {
    if (!node) return [];
    return node.namedChildren.filter(child => !child.type.endsWith('comment')).map(child => {
        const name = child.childForFieldName('name') || child.childForFieldName('declarator') ||
            child.namedChildren.find(item => ['type_identifier', 'identifier'].includes(item.type));
        const value = child.childForFieldName('default_type') || child.childForFieldName('default_value');
        return { name: name?.text || null, default: value?.text || null,
            variadic: child.type.startsWith('variadic_'), type: child.type };
    });
}

function templateSyntax(text) {
    let result = snippets.get('cpp-template-parameters', text);
    if (result) return result;
    const source = `template ${text} struct Probe {};`;
    const tree = parsedSource('cpp', source);
    const template = tree?.rootNode.namedChildren.find(node => node.type === 'template_declaration');
    const parameters = template?.childForFieldName('parameters');
    const errors = tree?.rootNode.descendantsOfType('ERROR') || [];
    const trailingComma = parameters?.namedChildren.at(-1);
    result = { complete: !!parameters && !tree.rootNode.hasError,
        impossible: errors.length === 1 && trailingComma?.type === 'ERROR' && trailingComma.text.trim() === ',',
        parameters: templateParameters(parameters), text };
    return snippets.set('cpp-template-parameters', text, result);
}

function sourceView(index, definition) {
    const source = index._readFile(definition.file);
    const entry = index.files.get(definition.file);
    const rawTree = parsedSource('cpp', source);
    const rawNode = definitionNode(rawTree, definition);
    const rawExtent = rawNode?.parent?.type === 'template_declaration' ? rawNode.parent : rawNode;
    const matches = candidate => candidate && candidate.startPosition.row + 1 === definition.startLine &&
        candidate.endPosition.row + 1 <= definition.endLine;
    if (!['class', 'struct', 'union', 'enum'].includes(definition.type) && rawNode && !CLASSES.has(rawNode.type) && matches(rawExtent)) {
        return { source, tree: rawTree, blanks: entry?.recoveryBlanks || [], node: rawNode };
    }
    const tree = require('../languages/cpp').recoveredTree(source, getParser('cpp'), entry?.recoveryBlanks) ||
        safeParse(getParser('cpp'), source);
    const node = definitionNode(tree, definition);
    const extent = node?.parent?.type === 'template_declaration' ? node.parent : node;
    return { source, tree, blanks: entry?.recoveryBlanks || [],
        rawNode: CLASSES.has(rawNode?.type) ? rawNode : null,
        node: ['class', 'struct', 'union', 'enum'].includes(definition.type) || matches(extent) ? node : null };
}

function declarationSyntax(index, definition) {
    const key = `cpp-conversion-declaration:${definition.file}:${definition.sourceSpan?.start}:${definition.name}`;
    return projectFact(index, key, live => {
        const memo = require('./cpp-scope').conversionSyntaxMemo(live);
        if (memo?.has(key)) return memo.get(key);
        const { source, node } = sourceView(live, definition);
        const template = node?.parent?.type === 'template_declaration' ? node.parent : null;
        const parameters = template?.childForFieldName('parameters');
        const expanded = parameters ? expandDeclaration(live, definition.file, parameters.startPosition.row + 1,
            source.slice(parameters.startIndex, parameters.endIndex)) : null;
        const variants = expanded?.variants.map(variant => ({ ...templateSyntax(variant.text),
            expansionComplete: variant.complete })) || [];
        const valid = variants.filter(variant => variant.complete);
        const syntax = valid[0] || variants[0] || null;
        const headers = CLASSES.has(node?.type) ? [] : headerNodes(template || node);
        const requires = headers.filter(child => child.type === 'requires_clause')
            .map(child => expandDeclaration(live, definition.file, child.startPosition.row + 1,
                source.slice(child.startIndex, child.endIndex)));
        const explicit = headers.find(child => child.type === 'explicit_function_specifier');
        const conversion = headers.find(child => child.type === 'operator_cast');
        const conversionKeyword = conversion?.children.find(child => child.type === 'operator');
        const conversionParameters = conversion && headerNodes(conversion).find(child =>
            child.type === 'abstract_function_declarator')?.childForFieldName('parameters');
        const parameterList = headers.find(child => child.type === 'function_declarator')?.childForFieldName('parameters');
        const parameterTypes = (parameterList?.namedChildren || []).map(parameter => {
            const declarator = parameter.childForFieldName('declarator');
            if (declarator && !declarator.type.startsWith('abstract_')) return null;
            const equals = parameter.children.find(child => child.type === '=');
            return source.slice(parameter.startIndex, equals?.startIndex ?? parameter.endIndex).trim();
        });
        const result = { template: syntax, templateAlternatives: valid,
            templateComplete: !!node && (!expanded || valid.length > 0 && variants.every(variant =>
                variant.expansionComplete && (variant.complete || variant.impossible))),
            requires, explicit: explicit?.text || null,
            isConversion: !!conversion,
            // The type field excludes pointer/reference declarators and cv
            // qualifiers. The conversion-type-id ends at the function's
            // parameter list, before its own cv/ref qualifiers.
            conversionType: conversionKeyword && conversionParameters
                ? source.slice(conversionKeyword.endIndex, conversionParameters.startIndex).trim() : null,
            parameterTypes,
            nodeType: node?.type || null, complete: !!node && !node.hasError,
            ...(parameters && { templateRange: [parameters.startIndex, parameters.endIndex] }) };
        memo?.set(key, result);
        return result;
    });
}

function classSyntax(index, owner) {
    const key = `cpp-conversion-class:${owner.file}:${owner.sourceSpan?.start}:${owner.name}`;
    return projectFact(index, key, live => {
        const memo = require('./cpp-scope').conversionSyntaxMemo(live);
        if (memo?.has(key)) return memo.get(key);
        const { source, node, blanks, rawNode } = sourceView(live, owner);
        const body = node?.childForFieldName('body');
        if (!body || !CLASSES.has(node.type)) return { complete: false, constructors: [], operators: [], bases: [], members: [] };
        const constructors = ownConstructors(live, owner).map(definition => ({
            definition, syntax: declarationSyntax(live, definition),
        }));
        const nodes = headerNodes(body);
        const functions = nodes.filter(child => child.type === 'function_definition');
        const bodies = functions.map(child => child.childForFieldName('body')).filter(Boolean);
        const contains = (range, start, end) => range[0] <= start && end <= range[1];
        const repairedTemplates = constructors.filter(ctor => ctor.syntax.templateComplete)
            .map(ctor => ctor.syntax.templateRange).filter(Boolean);
        const inBody = (start, end) => bodies.some(child => child.startIndex <= start && end <= child.endIndex);
        let complete = !nodes.some(child => (child.type === 'ERROR' || child.isMissing) &&
            !repairedTemplates.some(range => contains(range, child.startIndex, child.endIndex)));
        // A using-declaration can inherit constructors. A recovered member
        // may hide another constructor, unless its constraint was rebuilt
        // from the actual macro expansion or the change is inside a body.
        if (nodes.some(child => child.type === 'using_declaration')) complete = false;
        for (const [start, end] of blanks) {
            if (end <= body.startIndex || start >= body.endIndex || inBody(start, end) ||
                repairedTemplates.some(range => contains(range, start, end))) continue;
            const fragment = require('../languages/c-family').conditionalHeaderText(source.slice(start, end));
            const expanded = expandDeclaration(live, owner.file,
                source.slice(0, start).split('\n').length, fragment);
            if (!expanded.variants.every(variant => variant.complete) || require('../languages/c-family')
                .objectMacroReading(getParser('cpp'), expanded.variants.map(variant => variant.text)) !== 'decoration') complete = false;
        }
        const rawBody = rawNode?.childForFieldName('body');
        const rawHeaders = rawBody ? headerNodes(rawBody) : [];
        // A conditional parse view may omit an otherwise complete member
        // branch. Its literal AST still supplies that inventory when every
        // damaged header was reconstructed from its macro definitions.
        if (!complete && rawBody && !rawHeaders.some(child => child.type === 'using_declaration' ||
            (child.type === 'ERROR' || child.isMissing) &&
            !repairedTemplates.some(range => contains(range, child.startIndex, child.endIndex)))) {
            const declarations = rawHeaders.filter(child => ['declaration', 'field_declaration', 'function_definition'].includes(child.type));
            const unknownMacro = declarations.some(declaration => {
                const function_ = declaration.childForFieldName('declarator');
                const name = function_?.type === 'function_declarator' && function_.childForFieldName('declarator');
                return name?.type === 'identifier' && (live.symbols.get(name.text) || []).some(def => def.type === 'macro');
            });
            const constructorHeaders = rawHeaders.filter(child => child.type === 'function_declarator' &&
                child.childForFieldName('declarator')?.text === owner.name);
            const allRecorded = constructorHeaders.every(header => constructors.some(ctor =>
                ctor.definition.startLine <= header.startPosition.row + 1 &&
                header.endPosition.row + 1 <= ctor.definition.endLine));
            const macroTokens = rawHeaders.filter(child => ['identifier', 'type_identifier'].includes(child.type) &&
                !inPreprocessorCondition(child) &&
                !repairedTemplates.some(range => contains(range, child.startIndex, child.endIndex)) &&
                (live.symbols.get(child.text) || []).some(def => def.type === 'macro'));
            const macrosDecorative = macroTokens.every(token => {
                const expanded = expandDeclaration(live, owner.file, token.startPosition.row + 1, token.text);
                return expanded.variants.every(variant => variant.complete) && require('../languages/c-family')
                    .objectMacroReading(getParser('cpp'), expanded.variants.map(variant => variant.text)) === 'decoration';
            });
            if (!unknownMacro && allRecorded && macrosDecorative) complete = true;
        }
        const identity = declarationIdentity(owner);
        const members = (live.files.get(owner.file)?.symbols || []).filter(definition =>
            sameDeclaration(declarationIdentity(ownerDefinitionOf(live, definition)), identity) ||
            definition.enclosingType === owner.name && definition.lexicalScopeStartLine === owner.startLine &&
            definition.lexicalScopeEndLine === owner.endLine);
        const operators = members.filter(definition => definition.name.startsWith('operator '))
            .map(definition => ({ definition, syntax: declarationSyntax(live, definition) }))
            .filter(operator => operator.syntax.isConversion);
        const result = { complete, constructors, operators,
            template: declarationSyntax(live, owner).template,
            bases: require('./graph-build').splitParentList(owner.extends || ''),
            members: members.filter(definition => ['type', 'class', 'struct', 'enum', 'union'].includes(definition.type)) };
        memo?.set(key, result);
        return result;
    });
}

module.exports = { declarationSyntax, classSyntax, templateSyntax, definitionNode };
