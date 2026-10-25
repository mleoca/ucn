'use strict';

const { declarationIdentity, sameDeclaration } = require('./provenance');
const { factIndex } = require('./provenance-overload');

// Type lookup replays the same package, namespace and include rules as a
// type reference. The witness holds declarations and scope facts, rather
// than a recorded resolution verdict or access to the live filesystem.
const FILE_FIELDS = ['language', 'relativePath', 'symbols', 'importBindings', 'moduleResolved',
    'importDetails', 'importAliases', 'exportDetails', 'cppUsings', 'macroScopeMarkers',
    'moduleAssignedNames', 'moduleValueAliases', 'packageName', 'bindings'];

const nameScopes = new Map();
const NAME_SCOPE_MAX_BYTES = 32 * 1024 * 1024;
const NAME_SCOPE_MAX_ENTRIES = 256;
let nameScopeBytes = 0;
const LOOKUP_MEMO_MAX_BYTES = 32 * 1024 * 1024;
const LOOKUP_MEMO_MAX_ENTRIES = 16384;
const TYPE_PARAMETER_PARENTS = new Set(['type_parameter', 'type_parameters',
    'constrained_type_parameter', 'type_parameter_declaration',
    'optional_type_parameter_declaration', 'variadic_type_parameter_declaration']);

function constructionNameScope(index, query) {
    const { getParser, safeParse } = require('../languages');
    const { referenceRole, referenceTypeParameterScope } = require('./type-references');
    const language = index.files.get(query.file)?.language;
    const source = index._readFile(query.file), key = `${language}\0${source}`;
    const canonical = require('../languages').langTraits(language)?.typeNameSourceCanonical;
    if (canonical && !canonical(source)) return null;
    let facts = nameScopes.get(key);
    if (facts) {
        nameScopes.delete(key);
        nameScopes.set(key, facts);
    }
    if (!facts) {
        const tree = safeParse(getParser(language), source);
        if (!tree) return null;
        try {
            const tokens = tree.rootNode.descendantsOfType(['identifier', 'type_identifier', 'namespace_identifier',
                'qualified_identifier', 'scoped_type_identifier', 'qualified_name', 'alias_qualified_name']);
            facts = { sites: new Map(), parameters: [] };
            for (const node of tokens) {
                facts.sites.set(`${node.startPosition.row + 1}:${node.startPosition.column}`, [node.startIndex, node.endIndex]);
                // Only declaration-shaped parents can bind a type parameter.
                // The classifier still distinguishes its name from bounds and defaults.
                if (!TYPE_PARAMETER_PARENTS.has(node.parent?.type)) continue;
                if (!referenceRole(node, language)?.typeParam) continue;
                const scope = referenceTypeParameterScope(node);
                if (scope) facts.parameters.push({ name: node.text, start: scope.startIndex, end: scope.endIndex });
            }
        } finally { tree.delete?.(); }
        const bytes = key.length * 2 + (facts.sites.size + facts.parameters.length) * 64;
        if (bytes <= NAME_SCOPE_MAX_BYTES) {
            while (nameScopes.size >= NAME_SCOPE_MAX_ENTRIES ||
                nameScopeBytes + bytes > NAME_SCOPE_MAX_BYTES) {
                const oldest = nameScopes.keys().next().value, previous = nameScopes.get(oldest);
                nameScopes.delete(oldest);
                nameScopeBytes -= oldest.length * 2 + (previous.sites.size + previous.parameters.length) * 64;
            }
            nameScopes.set(key, facts);
            nameScopeBytes += bytes;
        }
    }
    const site = facts.sites.get(`${query.line}:${query.column}`);
    if (!site) return null;
    const qualifier = query.qualifier || '';
    if (qualifier.startsWith('::') || qualifier.startsWith('global::')) return true;
    const root = qualifier ? qualifier.split(/::|\./)[0] : query.name;
    return !facts.parameters.some(parameter => parameter.name === root &&
        parameter.start <= site[0] && parameter.end >= site[1]);
}

function localConstructionBinding(index, query, definition, traits, language) {
    if (query.file !== definition.file || query.name !== definition.name) return false;
    const { getParser, safeParse } = require('../languages');
    const config = traits.constructorInheritance;
    const source = index._readFile(query.file);
    const content = config?.source ? config.source(source, getParser(language)) : source;
    const syntax = config?.syntaxLanguage || language;
    const tree = safeParse(getParser(syntax), content);
    if (!tree) return false;
    try {
        const nodes = tree.rootNode.descendantsOfType('identifier').filter(node => node.text === query.name &&
            node.startPosition.row + 1 === query.line && node.startPosition.column === query.column);
        if (nodes.length !== 1) return false;
        const scope = require('../languages/lexical-scope').referenceScope(nodes[0], syntax, new Map(), query.name,
            { includeClasses: true });
        return !!scope?.local && scope.defRows?.includes(definition.startLine - 1);
    } finally { tree.delete?.(); }
}

// Explicit construction still performs lookup in its enclosing class. The
// recorded declaration extents supply that context without building a type
// rename group. Equal or unreadable source scopes cannot select an owner.
function constructionClassAt(index, file, line, column) {
    const { containsCall } = require('./callable-scope');
    let width = Infinity;
    const owners = new Set();
    for (const definition of index.files.get(file)?.symbols || []) {
        if (definition.startLine > line || definition.endLine < line) continue;
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

function resolve(index, query, owner) {
    if (query.nameScopeOnly) {
        if (!constructionNameScope(index, query)) return false;
        const canonical = require('../languages').langTraits(index.files.get(query.file)?.language)?.typeNameSourceCanonical;
        if (canonical) {
            const file = owner.file === query.relativePath ? query.file
                : require('path').resolve(index.root, owner.file);
            if (!canonical(index._readFile(file))) return false;
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
    const canonical = langTraits(index.files.get(definition.file)?.language)?.typeNameSourceCanonical;
    if (canonical && (!canonical(index._readFile(query.file)) || !canonical(index._readFile(definition.file)))) return false;
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
    let tree = null;
    try {
        if (query.position) {
            const { getParser, safeParse } = require('../languages');
            const language = index.files.get(query.file)?.language;
            tree = safeParse(getParser(language), index._readFile(query.file));
            const at = query.position;
            let node = tree?.rootNode.descendantForIndex(at.start);
            while (node && !(node.startIndex === at.start && node.endIndex === at.end && node.type === at.nodeType)) node = node.parent;
            if (!node || node.startPosition.row + 1 !== query.line || node.startPosition.column !== query.column) return false;
            resolver.siteNode = node; resolver.siteFile = query.file;
        }
        return resolveAt(index, query, owner, definition, resolver);
    } finally { tree?.delete?.(); }
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

function captureTypeLookup(index, query, owner) {
    const reads = {}, identity = declarationIdentity(owner);
    // A rename visits one construction once for each slot member. Its type
    // binding depends on the complete query and the operation's index view.
    // Replays never use this memo; each witness keeps its recorded raw reads.
    let memo = !index?.isProvenanceFactIndex && index?._opMemo?.('constructionTypeLookups',
        () => ({ entries: new Map(), bytes: 0 }));
    let key = null;
    if (memo) {
        try { key = JSON.stringify([query, identity]); }
        catch { memo = null; }
    }
    let repeated = false;
    if (memo?.entries.has(key)) {
        const saved = memo.entries.get(key);
        memo.entries.delete(key);
        if (!saved.pending) {
            memo.entries.set(key, saved);
            return saved.value === null ? null : globalThis.structuredClone(saved.value);
        }
        memo.bytes -= saved.bytes;
        repeated = true;
    }
    let result = null;
    try {
        if (resolve(factIndex(reads, index, FILE_FIELDS), query, identity)) result = { query, owner: identity, reads };
    } catch { /* An unsupported binding keeps its ordinary review result. */ }
    if (memo) {
        try {
            // Most queries visit a successful binding once. Admit its full
            // snapshot only when it repeats; negative lookups stay cheap.
            const pending = result !== null && !repeated;
            const bytes = key.length * 2 + (pending ? 0 : JSON.stringify(result).length * 2);
            if (bytes <= LOOKUP_MEMO_MAX_BYTES) {
                while (memo.entries.size >= LOOKUP_MEMO_MAX_ENTRIES || memo.bytes + bytes > LOOKUP_MEMO_MAX_BYTES) {
                    const oldest = memo.entries.keys().next().value;
                    memo.bytes -= memo.entries.get(oldest).bytes;
                    memo.entries.delete(oldest);
                }
                memo.entries.set(key, pending ? { pending: true, bytes }
                    : { value: globalThis.structuredClone(result), bytes });
                memo.bytes += bytes;
            }
        } catch { /* A non-data extension can still use the uncached path. */ }
    }
    return result;
}

function validateTypeLookup(witness, owner, site) {
    if (!witness || !sameDeclaration(witness.owner, owner) ||
        witness.query?.relativePath !== site?.file || witness.query.line !== site?.line ||
        witness.query.column !== site?.column) return false;
    if (witness.query.position && (witness.query.position.start !== site.start || witness.query.position.end !== site.end)) return false;
    try { return resolve(factIndex(witness.reads, undefined, FILE_FIELDS), witness.query, owner); }
    catch { return false; }
}

module.exports = { captureTypeLookup, validateTypeLookup, resolveTypeLookup: resolve,
    constructionNameScope, cppConstructionClasses, FILE_FIELDS };
