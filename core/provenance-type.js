'use strict';

const { declarationIdentity, sameDeclaration } = require('./provenance');
const { symbolsSpanning } = require('./shared');
const { factIndex, sealFacts, replayed, seedReplay, refusedProof } = require('./provenance-overload');
const { BoundedMap, SourceMemo, parsedSource, typeNamesCanonical } = require('./source-memo');

// Type lookup replays the same package, namespace and include rules as a
// type reference. The witness holds declarations and scope facts, rather
// than a recorded resolution verdict or access to the live filesystem.
const FILE_FIELDS = ['language', 'relativePath', 'symbols', 'importBindings', 'moduleResolved',
    'importDetails', 'importAliases', 'exportDetails', 'cppUsings', 'macroScopeMarkers',
    'moduleAssignedNames', 'moduleValueAliases', 'packageName', 'bindings', 'typeParameterNames'];

// Type-parameter scopes of a source, and the name tokens of each line a
// query asked about, by language. Lines are read from the shared parse on
// demand (fix #418: a token map of the whole file was built for one site).
const nameScopes = new SourceMemo({ maxEntries: 256, maxWeight: 32 * 1024 * 1024,
    weigh: facts => (facts.lines.size * 4 + facts.parameters.length) * 64 });
const LOOKUP_MEMO_MAX_ENTRIES = 16384;
const TYPE_PARAMETER_PARENTS = new Set(require('../languages/utils').TYPE_PARAMETER_PARENTS);
const NAME_TOKENS = [...require('../languages/utils').TYPE_PARAMETER_NAME_TOKENS];
const NAME_TOKEN_SET = new Set(NAME_TOKENS);
const atOrigin = point => point.row === 0 && point.column === 0;

function nameScopeFacts(language, source) {
    let facts = nameScopes.get(language, source);
    if (facts !== undefined) return facts;
    const tree = parsedSource(language, source);
    if (!tree) return null;
    const { referenceRole, referenceTypeParameterScope } = require('./type-references');
    facts = { lines: new Map(), parameters: [] };
    // A name token is a declared type parameter only under one of these
    // declaration-shaped parents; the classifier still distinguishes its
    // name from bounds and defaults. A zero-width token at the origin is not
    // a name token of the file (a whole-tree token walk starts there).
    for (const parent of tree.rootNode.descendantsOfType([...TYPE_PARAMETER_PARENTS])) {
        for (const node of parent.children) {
            if (!NAME_TOKEN_SET.has(node.type) || atOrigin(node.endPosition)) continue;
            if (!referenceRole(node, language)?.typeParam) continue;
            const scope = referenceTypeParameterScope(node);
            if (scope) facts.parameters.push({ name: node.text, start: scope.startIndex, end: scope.endIndex });
        }
    }
    nameScopes.set(language, source, facts);
    return facts;
}

/** The innermost name token starting at (line, column): its source range. */
function nameTokenAt(facts, language, source, line, column) {
    let sites = facts.lines.get(line);
    if (!sites) {
        const tree = parsedSource(language, source);
        if (!tree) return null;
        sites = new Map();
        // Every node starting on the line, in tree order: the last token at
        // a column is the innermost one.
        const from = line > 1 ? { row: line - 2, column: 0xffffffff } : { row: 0, column: 0 };
        for (const node of tree.rootNode.descendantsOfType(NAME_TOKENS, from, { row: line, column: 0 })) {
            if (node.startPosition.row === line - 1) sites.set(node.startPosition.column, [node.startIndex, node.endIndex]);
        }
        // A file queried at very many lines keeps answering without
        // retaining every line.
        if (facts.lines.size < 4096) facts.lines.set(line, sites);
    }
    return sites.get(column) || null;
}

// A type declaration's header line: its name and supertypes are read there
// (fix #421: a parse error inside a member does not reach them).
const headerLines = def => ({ startLine: def.nameLine || def.startLine, endLine: def.nameLine || def.startLine });

function constructionNameScope(index, query) {
    const entry = index.files.get(query.file);
    const language = entry?.language;
    const source = index._readFile(query.file);
    const canonical = require('../languages').langTraits(language)?.typeNameSourceCanonical;
    if (canonical && !typeNamesCanonical(index, query.file, canonical, language, { startLine: query.line, endLine: query.line })) return null;
    // A name the file declares as no type parameter anywhere names none at
    // the site (fix #421): the indexed declaration names answer without a
    // second parse of the file.
    const written = query.qualifier || '';
    const named = written ? written.split(/::|\./)[0] : query.name;
    const declared = entry?.typeParameterNames;
    if (Array.isArray(declared) && (!named || !declared.includes(named))) return true;
    const facts = nameScopeFacts(language, source);
    if (!facts) return null;
    const site = nameTokenAt(facts, language, source, query.line, query.column);
    if (!site) return null;
    const qualifier = query.qualifier || '';
    if (qualifier.startsWith('::') || qualifier.startsWith('global::')) return true;
    const root = qualifier ? qualifier.split(/::|\./)[0] : query.name;
    return !facts.parameters.some(parameter => parameter.name === root &&
        parameter.start <= site[0] && parameter.end >= site[1]);
}

function localConstructionBinding(index, query, definition, traits, language) {
    if (query.file !== definition.file || query.name !== definition.name) return false;
    const { getParser } = require('../languages');
    const config = traits.constructorInheritance;
    const source = index._readFile(query.file);
    const content = config?.source ? config.source(source, getParser(language)) : source;
    const syntax = config?.syntaxLanguage || language;
    const tree = parsedSource(syntax, content);
    if (!tree) return false;
    {
        const nodes = tree.rootNode.descendantsOfType('identifier').filter(node => node.text === query.name &&
            node.startPosition.row + 1 === query.line && node.startPosition.column === query.column);
        if (nodes.length !== 1) return false;
        const scope = require('../languages/lexical-scope').referenceScope(nodes[0], syntax, new Map(), query.name,
            { includeClasses: true });
        return !!scope?.local && scope.defRows?.includes(definition.startLine - 1);
    }
}

// Explicit construction still performs lookup in its enclosing class. The
// recorded declaration extents supply that context without building a type
// rename group. Equal or unreadable source scopes cannot select an owner.
function constructionClassAt(index, file, line, column) {
    const { containsCall } = require('./callable-scope');
    let width = Infinity;
    const owners = new Set();
    for (const definition of symbolsSpanning(index.files.get(file)?.symbols, line)) {
        const type = ['class', 'struct', 'union', 'enum', 'record'].includes(definition.type);
        const owner = type
            ? [definition.enclosingType, definition.name].filter(Boolean).join('::')
            : definition.className;
        if (!owner) continue;
        const contains = containsCall(definition, { line, column });
        if (contains === false) continue;
        if (Number.isInteger(column) && contains !== true) return undefined;
        const span = definition.sourceSpan;
        const size = span ? span.end - span.start : definition.endLine - definition.startLine;
        if (size < width) { width = size; owners.clear(); }
        if (size === width) owners.add(owner);
    }
    return owners.size === 1 ? [...owners][0] : owners.size === 0 ? null : undefined;
}

function cppConstructionClasses(index, query, resolver = null) {
    // A construction site is looked up once per operation, whichever query
    // projects it (fix #418). A witness view records its own lookup.
    const memo = !query.position && !index.isProvenanceFactIndex
        ? index._opMemo?.('cppConstructionClasses', () => new Map()) : null;
    const key = memo ? `${query.file}\0${query.line}\0${query.column ?? ''}\0${query.name}\0${query.qualifier ?? ''}` : null;
    if (memo?.has(key)) return memo.get(key);
    const classes = cppConstructionClassesUncached(index, query, resolver);
    memo?.set(key, classes);
    return classes;
}

function cppConstructionClassesUncached(index, query, resolver) {
    const { resolveQualifier, includeClosure, namespaceAt } = require('./cpp-scope');
    const { file, line, name, qualifier } = query;
    let context;
    if (query.position) context = resolver.cppSiteContext(file, line);
    else {
        const className = constructionClassAt(index, file, line, query.column);
        if (className === undefined) return [];
        context = { namespace: namespaceAt(index, file, line), className };
    }
    const found = resolveQualifier(index, { file, line, ...context },
        qualifier ? `${qualifier}::${name}` : name, includeClosure(index, file));
    return found.kind === 'type' && found.visible ? found.classes : [];
}

function constructionDenotes(index, resolver, query, definition, seen = new Set()) {
    const { file, line, name, qualifier } = query;
    const entry = index.files.get(file);
    if (!entry || seen.size >= 12) return false;
    const key = `${file}\0${qualifier || ''}\0${name}`;
    if (seen.has(key)) return false;
    const visited = new Set(seen).add(key);
    const traits = require('../languages').langTraits(entry.language);
    if (query.localShadow && !localConstructionBinding(index, query, definition, traits, entry.language)) return false;
    if (traits.constructorInheritance?.order === 'single' && definition.decorators?.length) return false;
    if (traits.functionalTypeConstruction) {
        const classes = cppConstructionClasses(index, query, resolver);
        return classes.length > 0 && classes.every(def =>
            sameDeclaration(declarationIdentity(def), declarationIdentity(definition)));
    }
    const answer = qualifier ? resolver.resolveQualified(file, line, null, qualifier, { role: 'type' })
        : resolver.resolveName(file, line, name);
    if (traits.typeNameScoping === 'namespace-usings' && answer.reason === 'using-alias') {
        const { csharpUsings } = require('./type-denotation');
        const namespace = resolver.csharpSiteNamespace(file, line);
        if (namespace === undefined) return false;
        const scope = csharpUsings(index, file, namespace);
        if (scope.ambiguousAliases.has(name)) return false;
        const syntax = scope.aliasSyntax.get(name);
        const arity = require('../languages/utils').genericArityOf(syntax);
        if (arity == null) return false;
        if (syntax.includes('<')) {
            let depth = 0, end = -1;
            for (let at = syntax.indexOf('<'); at < syntax.length; at++) {
                if (syntax[at] === '<') depth++;
                else if (syntax[at] === '>' && --depth === 0) { end = at; break; }
            }
            if (end !== syntax.length - 1) return false;
        }
        resolver.siteSyntax = { ...resolver.siteSyntax, arity };
        const target = scope.aliases.get(name);
        if (!target || target.split('.').pop() !== definition.name) return false;
        const prefix = target.split('.').slice(0, -1).join('.');
        return prefix ? resolver.resolveQualified(file, line, null, `global::${prefix}`, { role: 'type' }).verdict === 'yes'
            : resolver.resolveName(file, line, definition.name).verdict === 'yes';
    }
    if (traits.typeSystem !== 'structural') return answer.verdict === 'yes';
    // Value aliases bind the value of their initializer, in its own module.
    // Type-reference lookup intentionally keeps the alias token's identity.
    const moduleFile = module => {
        const relative = entry.moduleResolved?.[module];
        return relative && require('path').resolve(index.root, relative);
    };
    if (qualifier) {
        const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === qualifier);
        if (bindings.length !== 1) return false;
        const target = moduleFile(`${bindings[0].module}.${bindings[0].name}`) || moduleFile(bindings[0].module);
        return !!target && constructionDenotes(index, resolver, { file: target, line: 1, name }, definition, visited);
    }
    const aliases = (entry.moduleValueAliases || []).filter(alias => alias.name === name);
    if (aliases.length) {
        return aliases.every(alias => {
            const alternatives = alias.alternatives || [{ target: alias.target }];
            return alternatives.length > 0 && alternatives.every(alternative => {
                if (alternative.target) {
                    const parts = alternative.target.split('.'), targetName = parts.pop();
                    return constructionDenotes(index, resolver, { file, line: alias.line || line,
                        name: targetName, qualifier: parts.join('.') || null }, definition, visited);
                }
                const target = moduleFile(alternative.module);
                return !!target && !!alternative.imported && constructionDenotes(index, resolver,
                    { file: target, line: 1, name: alternative.imported }, definition, visited);
            });
        });
    }
    if (answer.verdict === 'yes') {
        // A value declaration sharing a type's name can replace its value.
        const shadows = (entry.symbols || []).filter(def => def.name === name && !def.className &&
            !def.lexicalScopeStartLine && !['class', 'struct', 'interface', 'type'].includes(def.type));
        return !shadows.length && !(entry.moduleAssignedNames || []).includes(name);
    }
    const links = [...(entry.importBindings || []).filter(b => (b.alias || b.name) === name &&
        b.name !== '*' && b.kind !== 'namespace'), ...(entry.exportDetails || []).filter(e =>
        e.type === 're-export' && (e.alias || e.name) === name && e.source)];
    if (links.length !== 1) return false;
    const target = moduleFile(links[0].module || links[0].source);
    return !!target && constructionDenotes(index, resolver, { file: target, line: 1,
        name: links[0].name }, definition, visited);
}

// A construction through a method's own receiver (fix #434): the class
// whose method holds the site, by its recorded name line, with the method
// and receiver binding its language gives such a construction (`cls` of a
// classmethod, `this` of a static method, `type(self)` of an instance
// method). No class declared between them holds the method.
const OWN_CLASS_KINDS = new Set(['class', 'struct', 'record']);
function ownClassDenotes(index, query, owner) {
    const own = query.ownClass;
    const entry = index.files.get(query.file);
    const ownClassMethod = require('../languages').langTraits(entry?.language)?.ownClassMethod;
    if (!own || !ownClassMethod || !entry) return false;
    const symbols = entry.symbols || [];
    const named = (def, line) => def.nameLine === line || def.startLine === line;
    const holds = (outer, inner) => outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
    const definition = symbols.find(def => OWN_CLASS_KINDS.has(def.type) &&
        sameDeclaration(declarationIdentity(def), owner));
    if (!definition || definition.name !== own.name || !named(definition, own.line)) return false;
    const method = symbols.find(def => def.className === definition.name && def.name === own.method &&
        named(def, own.methodLine) && holds(definition, def));
    if (!method || query.line < method.startLine || query.line > method.endLine) return false;
    if (symbols.some(def => def !== definition && OWN_CLASS_KINDS.has(def.type) && holds(definition, def) &&
        holds(def, method) && !(def.startLine === definition.startLine && def.endLine === definition.endLine))) return false;
    return !!ownClassMethod(method, own.binding, own.receiver);
}

function resolve(index, query, owner) {
    if (query.ownClass) return ownClassDenotes(index, query, owner) && !index.hasMissingProvenanceFacts;
    if (query.nameScopeOnly) {
        if (!constructionNameScope(index, query)) return false;
        const language = index.files.get(query.file)?.language;
        const canonical = require('../languages').langTraits(language)?.typeNameSourceCanonical;
        if (canonical) {
            const file = owner.file === query.relativePath ? query.file
                : require('path').resolve(index.root, owner.file);
            if (!typeNamesCanonical(index, file, canonical, language, headerLines(owner))) return false;
        }
        return !index.hasMissingProvenanceFacts;
    }
    index._classIdentity = null;
    index._cppScope = null;
    index._typeDenotation = null;
    const definition = (index.symbols.get(owner.name) || []).find(def =>
        sameDeclaration(declarationIdentity(def), owner));
    if (!definition) return false;
    const { langTraits } = require('../languages');
    const definitionLanguage = index.files.get(definition.file)?.language;
    const canonical = langTraits(definitionLanguage)?.typeNameSourceCanonical;
    if (canonical && (!typeNamesCanonical(index, query.file, canonical, definitionLanguage, { startLine: query.line, endLine: query.line }) ||
        !typeNamesCanonical(index, definition.file, canonical, definitionLanguage, headerLines(definition)))) return false;
    // Explicit C++ construction uses its type lookup directly. Building a
    // rename group and an unused ordinary-name answer would read unrelated
    // declarations; functional calls still need their ordinary binding proof.
    if (query.construction && langTraits(index.files.get(query.file)?.language)?.functionalTypeConstruction &&
        !query.functional && !query.position) {
        return constructionDenotes(index, null, query, definition) && !index.hasMissingProvenanceFacts;
    }
    const { TypeReferenceResolver } = require('./type-references');
    const resolver = new TypeReferenceResolver(index, definition, owner.name);
    if (Number.isInteger(query.arity)) resolver.siteSyntax = { arity: query.arity };
    if (query.position) {
        const language = index.files.get(query.file)?.language;
        const tree = parsedSource(language, index._readFile(query.file));
        const at = query.position;
        let node = tree?.rootNode.descendantForIndex(at.start);
        while (node && !(node.startIndex === at.start && node.endIndex === at.end && node.type === at.nodeType)) node = node.parent;
        if (!node || node.startPosition.row + 1 !== query.line || node.startPosition.column !== query.column) return false;
        resolver.siteNode = node; resolver.siteFile = query.file;
    }
    return resolveAt(index, query, owner, definition, resolver);
}

function resolveAt(index, query, owner, definition, resolver) {
    const answer = query.qualifier
        ? resolver.resolveQualified(query.file, query.line, null, query.qualifier, { role: 'type' })
        : resolver.resolveName(query.file, query.line, query.name);
    if ((query.construction ? !constructionDenotes(index, resolver, query, definition) : answer.verdict !== 'yes') ||
        index.hasMissingProvenanceFacts) return false;
    if (query.functional) {
        if (!require('../languages').langTraits(index.files.get(query.file)?.language)?.functionalTypeConstruction) return false;
        const visible = require('./cpp-scope').includeClosure(index, query.file);
        const named = index.symbols.get(query.name) || [];
        let boundType = false;
        for (const file of visible) {
            for (const binding of index.files.get(file)?.bindings || []) {
                if (binding.name !== query.name) continue;
                const declaration = named.find(def => def.bindingId === binding.id);
                if (!declaration) return false;
                // The construction's own scoped lookup already proved the
                // denoted class. Same-spelled aliases in other classes do
                // not compete in that lookup; ordinary value bindings still
                // require the checks below.
                if (resolver.inGroup(declaration) || declaration.type === 'type' && query.construction) {
                    boundType = true; continue;
                }
                if (declaration.type !== 'constructor' || declaration.className !== owner.name ||
                    declaration.relativePath !== owner.file) return false;
            }
        }
        if (!boundType) return false;
    }
    return !index.hasMissingProvenanceFacts;
}

// The classes a C/C++ construction at a source position names (an omitted
// base initializer's header), looked up once per operation on the live
// index. A position lookup reads the site's tree node and the index, never
// the pinned type, so every owner a query tries shares it. null when the
// recorded position no longer names a node (the lookup fails for every
// owner).
function cppPositionConstructionClasses(index, query) {
    const memo = index._opMemo?.('cppPositionConstructionClasses', () => new Map());
    const at = query.position;
    const key = `${query.file}\0${query.line}\0${query.column}\0${query.name}\0${query.qualifier ?? ''}\0` +
        `${at.start}\0${at.end}\0${at.nodeType}`;
    if (memo?.has(key)) return memo.get(key);
    const language = index.files.get(query.file)?.language;
    const tree = parsedSource(language, index._readFile(query.file));
    let node = tree?.rootNode.descendantForIndex(at.start);
    while (node && !(node.startIndex === at.start && node.endIndex === at.end && node.type === at.nodeType)) node = node.parent;
    let classes = null;
    if (node && node.startPosition.row + 1 === query.line && node.startPosition.column === query.column) {
        const { resolveQualifier, includeClosure } = require('./cpp-scope');
        const context = require('./type-references').cppSiteContextOf(index, node, query.file, query.file, query.line);
        const found = resolveQualifier(index, { file: query.file, line: query.line, ...context },
            query.qualifier ? `${query.qualifier}::${query.name}` : query.name, includeClosure(index, query.file));
        classes = found.kind === 'type' && found.visible ? found.classes : [];
    }
    memo?.set(key, classes);
    return classes;
}

// A position-based C/C++ construction lookup (`resolve`) holds only when the
// site's classes are exactly the owner; when they are not, no witness can be
// captured for this owner and none is attempted.
function cppPositionConstructionDenied(index, query, identity) {
    if (index.isProvenanceFactIndex || !query.construction || !query.position || query.functional ||
        query.ownClass || query.nameScopeOnly || query.localShadow) return false;
    if (!require('../languages').langTraits(index.files.get(query.file)?.language)?.functionalTypeConstruction) return false;
    const classes = cppPositionConstructionClasses(index, query);
    return !classes || !(classes.length > 0 && classes.every(def => sameDeclaration(declarationIdentity(def), identity)));
}

function captureTypeLookup(index, query, owner) {
    const identity = declarationIdentity(owner);
    // A rename visits one construction once for each slot member. Its type
    // binding depends on the complete query and the operation's index view.
    // Every caller owns its witness: the sealed facts are shared, the query
    // and owner are copies (fix #418: cloning the facts per hit dominated
    // constructor plans).
    let memo = index?.isProvenanceFactIndex ? null
        : index?._opMemo?.('constructionTypeLookups', () => new BoundedMap({ maxEntries: LOOKUP_MEMO_MAX_ENTRIES }));
    let key = null;
    if (memo) {
        // Key order does not change a lookup (fix #421: the class binding
        // and the constructor proof spell one site's query in two orders).
        try { key = JSON.stringify([Object.fromEntries(Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), identity]); }
        catch { memo = null; }
    }
    if (memo?.has(key)) {
        const saved = memo.get(key);
        if (!saved) return null;
        // The replay of this caller's spelling is the saved capture's.
        seedReplay(saved.reads, JSON.stringify(['type-lookup', query, identity]), true);
        return { query: globalThis.structuredClone(query), owner: { ...saved.owner }, reads: saved.reads };
    }
    if (cppPositionConstructionDenied(index, query, identity)) {
        memo?.set(key, null);
        return null;
    }
    const reads = {};
    let result = null;
    try {
        if (resolve(factIndex(reads, index, FILE_FIELDS), query, identity)) {
            result = { query, owner: identity, reads: sealFacts(reads) };
            seedReplay(result.reads, JSON.stringify(['type-lookup', query, identity]), true);
        }
    } catch (error) { refusedProof(error); /* An unprovable binding keeps its ordinary review result. */ }
    if (memo) {
        try {
            memo.set(key, result && { query: globalThis.structuredClone(query), owner: { ...identity }, reads: result.reads });
        } catch { /* A non-data extension can still use the uncached path. */ }
    }
    return result;
}

function validateTypeLookup(witness, owner, site) {
    if (!witness || !sameDeclaration(witness.owner, owner) ||
        witness.query?.relativePath !== site?.file || witness.query.line !== site?.line ||
        witness.query.column !== site?.column) return false;
    if (witness.query.position && (witness.query.position.start !== site.start || witness.query.position.end !== site.end)) return false;
    let key;
    try { key = JSON.stringify(['type-lookup', witness.query, owner]); }
    catch { return false; }
    return replayed(witness.reads, key, () => {
        try { return resolve(factIndex(witness.reads, undefined, FILE_FIELDS), witness.query, owner); }
        catch (error) { return refusedProof(error, false); }
    });
}

module.exports = { captureTypeLookup, validateTypeLookup, resolveTypeLookup: resolve,
    constructionNameScope, cppConstructionClasses, FILE_FIELDS };
