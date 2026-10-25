'use strict';

const { typeOrigin } = require('./type-evidence');
const { sameNode, genericArityOf, nodeTextWithoutComments } = require('./utils');

/** A type's last AST name and its written qualifier, retaining global roots. */
function baseSpelling(node, separator) {
    if (!node) return null;
    if (['primary_constructor_base_type', 'generic_type', 'template_type', 'generic_name'].includes(node.type)) {
        return baseSpelling(node.childForFieldName('name') || node.childForFieldName('type') || node.namedChild(0), separator);
    }
    if (['identifier', 'type_identifier', 'field_identifier'].includes(node.type)) return { name: node.text, qualifier: null };
    if (['qualified_identifier', 'qualified_name', 'scoped_type_identifier', 'alias_qualified_name'].includes(node.type)) {
        const last = node.childForFieldName('name') || node.namedChildren.at(-1);
        const tail = baseSpelling(last, separator);
        if (!tail) return null;
        let prefix = node.text.slice(0, last.startIndex - node.startIndex).trim();
        if (prefix.endsWith(separator) && prefix !== separator) prefix = prefix.slice(0, -separator.length).trim();
        return { name: tail.name, qualifier: prefix || tail.qualifier };
    }
    return null;
}

const spellingKey = spelling => spelling && `${spelling.qualifier || ''}\0${spelling.name}`;

/** Calls the language supplies when a constructor omits its base initializer. */
function implicitBaseCalls(root, language, reaches, owners = null) {
    const config = require('./index').langTraits(language)?.implicitBaseConstruction;
    if (!config) return [];
    const calls = [];
    for (const owner of owners || root.descendantsOfType(config.classes)) {
        if (owner.hasError || reaches && !reaches(owner) ||
            owner.children.some(child => child.type === 'struct') && config.referenceTypesOnly) continue;
        const nameNode = owner.childForFieldName('name');
        const ownerName = baseSpelling(nameNode, config.separator)?.name;
        if (!ownerName) continue;
        const header = config.headerField ? owner.childForFieldName(config.headerField)
            : owner.namedChildren.find(child => child.type === config.headerNode);
        if (!header) continue;
        let bases = header.namedChildren.filter(child => baseSpelling(child, config.separator));
        if (config.firstBaseOnly) bases = bases.slice(0, 1);
        if (!bases.length || header.namedChildren.some(child => child.type === 'argument_list') ||
            bases.some(base => base.namedChildren.some(child => child.type === 'argument_list'))) continue;
        const scope = config.ownerScope?.(owner) || {};
        const body = owner.childForFieldName('body');
        const constructors = (body?.namedChildren || []).filter(node => config.constructors.includes(node.type))
            .map(node => {
                if (config.constructorInfo) return config.constructorInfo(node, ownerName, owner);
                const name = node.childForFieldName('name');
                if (name?.text !== ownerName || node.namedChildren.some(child => child.type === 'modifier' && child.text === 'static')) return null;
                const delegated = node.descendantsOfType(config.delegationNodes).some(call => {
                    for (let parent = call.parent; parent; parent = parent.parent) {
                        if (sameNode(parent, node)) return true;
                        if (config.classes.includes(parent.type) || config.constructors.includes(parent.type)) return false;
                    }
                    return false;
                });
                return { node, name, body: node.childForFieldName('body'), suppressed: delegated };
            }).filter(Boolean);
        const sources = constructors.length ? constructors : [{ node: owner, name: nameNode, body,
            potential: !!config.defaultPotential, generated: true }];
        for (const source of sources) {
            if (source.suppressed || !source.body || reaches && !reaches(source.node)) continue;
            const initialized = source.initialized || [];
            for (const base of bases) {
                const spelling = baseSpelling(base, config.separator);
                if (initialized.some(entry => !entry.field && spellingKey(entry) === spellingKey(spelling))) continue;
                const ambiguous = initialized.some(entry => !entry.field &&
                    !bases.some(other => spellingKey(entry) === spellingKey(baseSpelling(other, config.separator))));
                const site = source.name;
                const arity = genericArityOf(base.text);
                const parameters = source.node.childForFieldName('parameters');
                const params = source.params ?? (parameters
                    ? nodeTextWithoutComments(parameters).replace(/^\(|\)$/g, '').trim() : null);
                calls.push({ callSite: typeOrigin('call', site), name: spelling.name,
                    line: site.startPosition.row + 1, isMethod: false, isConstructor: true,
                    constructorSyntax: 'implicit', argCount: 0,
                    ...(spelling.qualifier && { constructorQualifier: spelling.qualifier }),
                    ...(arity > 0 && { typeArgs: arity }),
                    implicitBase: { owner: ownerName, ownerLine: owner.startPosition.row + 1,
                        ownerEndLine: owner.endPosition.row + 1, scope,
                        generated: !!source.generated, params,
                        header: typeOrigin('type', base), arity, potential: !!(source.potential || ambiguous) },
                    enclosingFunction: { name: ownerName, startLine: source.node.startPosition.row + 1,
                        endLine: source.node.endPosition.row + 1 } });
            }
        }
    }
    return calls;
}

module.exports = { implicitBaseCalls, baseSpelling };
