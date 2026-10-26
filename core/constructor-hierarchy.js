'use strict';

const { langTraits, getParser } = require('../languages');
const { parsedSource } = require('./source-memo');
const { referenceScope } = require('../languages/lexical-scope');
const { declarationIdentity, sameDeclaration, identityKey } = require('./provenance');
const { factIndex, sealFacts, replayed, seedReplay, refusedProof } = require('./provenance-overload');
const { FILE_FIELDS, resolveTypeLookup } = require('./provenance-type');

function basesOf(index, owner, config) {
    const entry = index.files.get(owner.file), language = entry.language;
    const source = index._readFile(owner.file);
    const content = config.source ? config.source(source, getParser(language)) : source;
    if (content == null) return null;
    const tree = parsedSource(config.syntaxLanguage || language, content);
    if (!tree) return null;
    {
        const nodes = tree.rootNode.descendantsOfType(config.classNodes).filter(node =>
            node.childForFieldName('name')?.text === owner.name &&
            node.startPosition.row + 1 >= owner.startLine && node.endPosition.row + 1 === owner.endLine);
        if (nodes.length !== 1 || nodes[0].hasError) return null;
        const node = nodes[0];
        const header = config.headerField ? node.childForFieldName(config.headerField)
            : node.namedChildren.find(child => child.type === config.headerNode);
        let bases = (header?.namedChildren || []).filter(base => !base.type.endsWith('comment') &&
            base.type !== config.keywordNode);
        if (config.order === 'single') {
            const clause = bases.find(base => base.type === 'extends_clause');
            if (clause) bases = [clause.childForFieldName('value') || clause.namedChild(0)];
            else if (bases.some(base => base.type === 'implements_clause')) bases = [];
            if (bases.length > 1) return null;
        }
        const parents = [];
        for (let base of bases) {
            while (base?.type === 'subscript') base = base.childForFieldName('value');
            let name, qualifier = null, root = base;
            if (base?.type === 'identifier') name = base.text;
            else if (base?.type === 'attribute' || base?.type === 'member_expression') {
                const object = base.childForFieldName('object');
                name = (base.childForFieldName('attribute') || base.childForFieldName('property'))?.text;
                qualifier = object?.text;
                root = object;
                while (root?.type === 'attribute' || root?.type === 'member_expression') root = root.childForFieldName('object');
            }
            if (!name || root?.type !== 'identifier') return null;
            const scope = referenceScope(root, config.syntaxLanguage || language, new Map(), root.text, { includeClasses: true });
            const builtin = langTraits(language)?.constructorProtocol?.builtinRoot;
            if (!qualifier && name === builtin && scope === 'module' &&
                !(entry.moduleAssignedNames || []).includes(name) &&
                !(entry.importBindings || []).some(binding => (binding.alias || binding.name) === name) &&
                !(index.symbols.get(name) || []).some(def => def.file === owner.file)) continue;
            const query = { file: owner.file, relativePath: entry.relativePath,
                line: base.startPosition.row + 1, column: base.startPosition.column,
                name, qualifier, construction: true };
            const candidates = require('./constructor-calls').constructionTypeCandidates(index, name).filter(def => def.type === 'class' &&
                (scope === 'module' || scope?.local && scope.defRows?.includes(def.startLine - 1) && def.file === owner.file) &&
                resolveTypeLookup(index, query, declarationIdentity(def)));
            if (candidates.length !== 1) return null;
            parents.push(candidates[0]);
        }
        return parents;
    }
}

function selectHierarchy(index, identity) {
    index._classIdentity = null;
    index._cppScope = null;
    index._typeDenotation = null;
    const constructed = (index.symbols.get(identity.name) || []).find(def => sameDeclaration(declarationIdentity(def), identity));
    if (!constructed) return null;
    const { ownConstructors } = require('./constructor-calls');
    const config = langTraits(index.files.get(constructed.file)?.language)?.constructorInheritance;
    if (!config) return null;
    const memo = new Map(), visiting = new Set();
    const linearize = owner => {
        const key = identityKey(declarationIdentity(owner));
        if (memo.has(key)) return memo.get(key);
        if (visiting.has(key)) return null;
        visiting.add(key);
        const parents = basesOf(index, owner, config);
        if (!parents) return null;
        const lists = parents.map(linearize);
        if (lists.some(list => !list)) return null;
        lists.push([...parents]);
        const order = [owner];
        while (lists.some(list => list.length)) {
            const active = lists.filter(list => list.length);
            const head = active.map(list => list[0]).find(candidate =>
                !active.some(list => list.slice(1).some(def => sameDeclaration(declarationIdentity(def), declarationIdentity(candidate)))));
            if (!head) return null;
            order.push(head);
            for (const list of active) if (sameDeclaration(declarationIdentity(list[0]), declarationIdentity(head))) list.shift();
        }
        visiting.delete(key); memo.set(key, order);
        return order;
    };
    const order = linearize(constructed);
    if (!order || index.hasMissingProvenanceFacts) return null;
    for (const declaring of order) {
        const members = ownConstructors(index, declaring);
        if (members.length) return { constructed, declaring, members };
        const initializer = langTraits(index.files.get(declaring.file)?.language)?.constructorProtocol?.initializer;
        if (initializer && require('./constructor-calls').ownMembers(index, declaring).some(def => def.name === initializer)) return null;
    }
    // Every class of the complete order is a project class and none declares
    // a constructor: the construction runs no project constructor body (fix
    // #421). The caller still checks the allocation protocol.
    return { constructed, none: true };
}

function captureHierarchy(index, owner) {
    const reads = {}, constructed = declarationIdentity(owner);
    try {
        const result = selectHierarchy(factIndex(reads, index, FILE_FIELDS), constructed);
        if (!result) return null;
        if (result.none) return { none: true };
        // Return live definitions for the caller, keeping only source reads
        // and identities in the independently replayed witness.
        const declaring = (index.symbols.get(result.declaring.name) || []).find(def =>
            sameDeclaration(declarationIdentity(def), declarationIdentity(result.declaring)));
        if (!declaring) return null;
        const witness = { constructed, reads: sealFacts(reads) };
        seedReplay(witness.reads, JSON.stringify(['hierarchy', constructed]), {
            declaring: declarationIdentity(result.declaring), members: result.members.map(declarationIdentity) });
        return { declaring, members: require('./constructor-calls').ownConstructors(index, declaring), witness };
    } catch (error) { return refusedProof(error); }
}

function validateHierarchy(witness, constructed, declaring, members) {
    if (!witness || !sameDeclaration(witness.constructed, constructed)) return false;
    let key;
    try { key = JSON.stringify(['hierarchy', constructed]); }
    catch { return false; }
    const result = replayed(witness.reads, key, () => {
        try {
            const index = factIndex(witness.reads, undefined, FILE_FIELDS);
            const selected = selectHierarchy(index, constructed);
            return selected && !selected.none && !index.hasMissingProvenanceFacts ? { declaring: declarationIdentity(selected.declaring),
                members: selected.members.map(declarationIdentity) } : null;
        } catch (error) { return refusedProof(error); }
    });
    return !!result && sameDeclaration(result.declaring, declaring) &&
        result.members.length === members.length && result.members.every(def =>
            members.some(member => sameDeclaration(def, member)));
}

module.exports = { captureHierarchy, validateHierarchy };
