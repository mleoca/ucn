'use strict';

const { langTraits, getParser, safeParse } = require('../languages');
const { sameNode } = require('../languages/utils');
const { referenceScope, scopeFields, pythonBindingSites } = require('../languages/lexical-scope');
const { ownerDefinitionOf } = require('./class-identity');
const { declarationIdentity, sameDeclaration, identityKey } = require('./provenance');
const { captureTypeLookup, validateTypeLookup } = require('./provenance-type');

function ownedMembers(index, owner) {
    return (index.files.get(owner.file)?.symbols || []).filter(def =>
        sameDeclaration(declarationIdentity(ownerDefinitionOf(index, def)), declarationIdentity(owner)));
}

function builtinFacts(index, owner, node, name, language) {
    const entry = index.files.get(owner.file);
    return { name, scope: scopeFields(referenceScope(node, language)),
        imports: (entry.importBindings || []).filter(binding => (binding.alias || binding.name) === name),
        assigned: (entry.moduleAssignedNames || []).includes(name),
        declarations: (index.symbols.get(name) || []).filter(def => def.file === owner.file).map(declarationIdentity) };
}

function builtinUnbound(facts, name) {
    return facts?.name === name && facts.scope?.scopeBinding === 'module' && facts.assigned === false &&
        Array.isArray(facts.imports) && !facts.imports.length &&
        Array.isArray(facts.declarations) && !facts.declarations.length;
}

function baseName(node) {
    while (node?.type === 'subscript') node = node.childForFieldName('value');
    if (node?.type === 'identifier') return { name: node.text, qualifier: null, root: node };
    if (node?.type !== 'attribute') return null;
    const object = node.childForFieldName('object'), name = node.childForFieldName('attribute');
    let root = object;
    while (root?.type === 'attribute') root = root.childForFieldName('object');
    return root?.type === 'identifier' && name ? { name: name.text, qualifier: object.text, root } : null;
}

/** Raw class, base-binding and allocation syntax needed by the protocol replay. */
function collectConstructorProtocol(index, owner, seen = new Set()) {
    const entry = index.files.get(owner.file), language = entry?.language;
    const protocol = langTraits(language)?.constructorProtocol;
    if (!protocol) return null;
    const key = identityKey(declarationIdentity(owner));
    if (seen.has(key)) return null;
    const visited = new Set(seen).add(key);
    const content = index._readFile(owner.file);
    const shared = index._getParsedTree(owner.file, content, language);
    const tree = shared || safeParse(getParser(language), content);
    if (!tree) return null;
    try {
        // One native walk per tree and operation lists its class nodes for
        // every owner a query reads (fix #435: one walk per owner).
        const memo = typeof index._opMemo === 'function' && !index.isProvenanceFactIndex
            ? index._opMemo('protocolClassNodes', () => new WeakMap()) : null;
        let classNodes = memo?.get(tree);
        if (!classNodes) {
            classNodes = tree.rootNode.descendantsOfType(protocol.classNode);
            memo?.set(tree, classNodes);
        }
        const nodes = classNodes.filter(node =>
            node.childForFieldName('name')?.text === owner.name && node.startPosition.row + 1 >= owner.startLine &&
            node.endPosition.row + 1 === owner.endLine);
        if (nodes.length !== 1) return null;
        const node = nodes[0], members = ownedMembers(index, owner);
        const headerNode = node.childForFieldName(protocol.headerField);
        const args = headerNode?.namedChildren || [];
        const bases = args.filter(arg => arg.type !== protocol.keywordNode && !arg.type.endsWith('comment'));
        const header = { name: owner.name, startLine: node.startPosition.row + 1, endLine: owner.endLine,
            hasError: node.hasError, baseCount: bases.length,
            baseEndLine: (headerNode || node).endPosition.row + 1,
            keywords: args.filter(arg => arg.type === protocol.keywordNode).map(arg => arg.childForFieldName('name')?.text),
            decorators: node.parent?.type === 'decorated_definition'
                ? node.parent.namedChildren.filter(child => child.type === 'decorator').map(child => child.text) : [] };
        const baseFacts = bases.map(base => {
            const spelling = baseName(base);
            if (!spelling) return null;
            const site = { file: entry.relativePath, line: base.startPosition.row + 1, column: base.startPosition.column };
            if (!spelling.qualifier && spelling.name === protocol.builtinRoot) {
                return { site, builtin: builtinFacts(index, owner, spelling.root, spelling.name, language) };
            }
            const scope = scopeFields(referenceScope(spelling.root, language, new Map(), spelling.root.text,
                { includeClasses: true }));
            const parents = require('./constructor-calls').constructionTypeCandidates(index, spelling.name);
            const matches = parents.filter(parent => parent.type === 'class').map(parent => ({ parent,
                binding: captureTypeLookup(index, { file: owner.file, relativePath: entry.relativePath,
                    line: site.line, column: site.column, name: spelling.name, qualifier: spelling.qualifier,
                    construction: true }, parent) }))
                .filter(match => match.binding);
            if (matches.length !== 1) return { site, scope, binding: null, protocol: null };
            return { site, scope, binding: matches[0].binding,
                protocol: collectConstructorProtocol(index, matches[0].parent, visited) };
        });
        const allocators = members.filter(def => def.name === protocol.allocator).map(def => {
            const functions = node.childForFieldName('body')?.namedChildren.flatMap(child =>
                child.type === 'decorated_definition' ? child.namedChildren : [child]) || [];
            const fn = functions.find(child => child.type === protocol.functionNode &&
                child.childForFieldName('name')?.text === protocol.allocator &&
                child.startPosition.row + 1 >= def.startLine && child.endPosition.row + 1 === def.endLine);
            const rootName = fn?.descendantsOfType('identifier').find(token => token.text === protocol.builtinRoot &&
                token.parent?.type === 'attribute' && sameNode(token.parent.childForFieldName('object'), token));
            return { declaration: declarationIdentity(def), source: fn?.text || null,
                builtin: rootName ? builtinFacts(index, owner, rootName, protocol.builtinRoot, language) : null };
        });
        return { owner: { ...declarationIdentity(owner), decorators: owner.decorators || [] }, header,
            declarations: members.map(def => ({ ...declarationIdentity(def), decorators: def.decorators || [] })),
            bases: baseFacts, allocators };
    } finally { if (!shared) tree.delete?.(); }
}

function allocatorPreservesClass(data, language, protocol) {
    if (!data.source || !builtinUnbound(data.builtin, protocol.builtinRoot)) return false;
    const tree = safeParse(getParser(language), data.source);
    if (!tree) return false;
    try {
        const fn = tree.rootNode.namedChild(0);
        if (tree.rootNode.hasError || tree.rootNode.namedChildCount !== 1 || fn.type !== protocol.functionNode ||
            fn.childForFieldName('name')?.text !== protocol.allocator ||
            fn.endPosition.row - fn.startPosition.row !== data.declaration.endLine - data.declaration.startLine) return false;
        const parameters = fn.childForFieldName('parameters');
        const first = parameters?.namedChild(0);
        const className = first?.type === 'identifier' ? first : first?.namedChildren.find(node => node.type === 'identifier');
        if (!className) return false;
        const classBindings = pythonBindingSites(fn, className.text);
        if (classBindings.length !== 1 || !sameNode(classBindings[0], className) ||
            pythonBindingSites(fn, protocol.builtinRoot).length) return false;
        const body = fn.childForFieldName('body');
        const statements = body?.namedChildren.filter(node => !node.type.endsWith('comment')) || [];
        if (statements.at(-1)?.type !== 'return_statement') return false;
        const owns = node => {
            for (let parent = node.parent; parent; parent = parent.parent) {
                if (parent.type === protocol.functionNode) return sameNode(parent, fn);
            }
            return false;
        };
        const preserves = (value, seen = new Set()) => {
            if (!value) return false;
            if (value.type === 'call') {
                const callee = value.childForFieldName('function'), args = value.childForFieldName('arguments')?.namedChildren || [];
                return callee?.type === 'attribute' && callee.childForFieldName('object')?.type === 'identifier' &&
                    callee.childForFieldName('object').text === protocol.builtinRoot &&
                    callee.childForFieldName('attribute')?.text === protocol.allocator && args.length === 1 &&
                    args[0].type === 'identifier' && args[0].text === className.text;
            }
            if (value.type !== 'identifier' || seen.has(value.text)) return false;
            const bindings = pythonBindingSites(fn, value.text);
            const binding = bindings[0], assignment = binding?.parent;
            return bindings.length === 1 && assignment.type === 'assignment' &&
                sameNode(assignment.childForFieldName('left'), binding) && binding.startIndex < value.startIndex &&
                preserves(assignment.childForFieldName('right'), new Set(seen).add(value.text));
        };
        const returns = fn.descendantsOfType('return_statement').filter(owns);
        if (!returns.length || returns.some(node => !preserves(node.namedChild(0)))) return false;
        const protocolNames = new Set([protocol.initializer, protocol.allocator, '__class__', '__call__']);
        for (const assignment of fn.descendantsOfType(['assignment', 'augmented_assignment', 'delete_statement']).filter(owns)) {
            const left = assignment.childForFieldName('left') || assignment.namedChild(0);
            if (left?.type === 'attribute' && protocolNames.has(left.childForFieldName('attribute')?.text)) return false;
        }
        return true;
    } finally { tree.delete?.(); }
}

function validateConstructorProtocol(data, owner, members, language, allocationNeeded = true, seen = new Set()) {
    const protocol = langTraits(language)?.constructorProtocol;
    if (!protocol) return true;
    const key = identityKey(owner), header = data?.header;
    if (!data || seen.has(key) || !sameDeclaration(data.owner, owner) || !header ||
        header.name !== owner.name || header.startLine < owner.startLine || header.endLine !== owner.endLine ||
        header.hasError || data.owner.decorators?.length || !Array.isArray(header.decorators) || header.decorators.length ||
        !Array.isArray(header.keywords) || header.keywords.includes(protocol.metaclass) ||
        !Array.isArray(data.declarations) || !Array.isArray(data.bases) || data.bases.length !== header.baseCount ||
        data.declarations.some(def => def.file !== owner.file || def.className !== owner.name ||
            def.startLine < owner.startLine || def.endLine > owner.endLine ||
            (def.namespace || null) !== (owner.namespace || null)) ||
        data.declarations.some(def => members.some(member => sameDeclaration(member, def)) && def.decorators?.length)) return false;
    const allocators = data.declarations.filter(def => def.name === protocol.allocator);
    if (allocationNeeded && allocators.length && (allocators.length !== 1 || allocators[0].decorators?.length ||
        !Array.isArray(data.allocators) || data.allocators.length !== 1 ||
        !sameDeclaration(data.allocators[0].declaration, allocators[0]) ||
        !allocatorPreservesClass(data.allocators[0], language, protocol))) return false;
    const visited = new Set(seen).add(key);
    return data.bases.every(base => {
        if (!base || base.site?.file !== owner.file || base.site.line < header.startLine ||
            base.site.line > header.baseEndLine) return false;
        if (base.builtin) return builtinUnbound(base.builtin, protocol.builtinRoot);
        const parent = base.protocol?.owner;
        const scope = base.scope;
        return parent && (scope?.scopeBinding === 'module' || scope?.scopeBinding === 'local' &&
            scope.scopeDefLines?.includes(parent.startLine) && parent.file === owner.file) &&
            validateTypeLookup(base.binding, parent, base.site) &&
            validateConstructorProtocol(base.protocol, parent, members, language,
                allocationNeeded && allocators.length === 0, visited);
    });
}

module.exports = { collectConstructorProtocol, validateConstructorProtocol };
