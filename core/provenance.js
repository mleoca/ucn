'use strict';

const { codeUnitCompare } = require('./shared');

const TYPE_SOURCE_RULES = Object.freeze({
    annotation: 'receiver-annotation', constructor: 'constructor-typed',
    flow: 'return-flow', field: 'field-hop', literal: 'literal-receiver',
    'with-binding': 'with-binding', cast: 'receiver-cast',
    'type-assertion': 'receiver-type-assertion', guess: 'receiver-guess',
    unknown: 'receiver-type', 'type-qualified': 'type-qualified',
});

/** Declaration identity includes lexical ownership; sharing a file is not identity. */
function declarationIdentity(definition) {
    if (!definition) return null;
    return {
        file: definition.relativePath || definition.file,
        startLine: definition.startLine,
        endLine: definition.endLine,
        name: definition.name,
        kind: definition.kind || definition.type,
        className: definition.className || null,
        namespace: definition.namespace || null,
        enclosingType: definition.enclosingType || null,
        lexicalScopeStartLine: definition.lexicalScopeStartLine || null,
        lexicalScopeEndLine: definition.lexicalScopeEndLine || null,
        ...(definition.bindingId && { bindingId: definition.bindingId }),
    };
}

function identityKey(identity) {
    if (!identity || !identity.file || !Number.isInteger(identity.startLine) ||
        !identity.name || !identity.kind) return null;
    return JSON.stringify([
        identity.file, identity.startLine, identity.endLine ?? null,
        identity.name, identity.kind, identity.className || null,
        identity.namespace || null, identity.enclosingType || null,
        identity.lexicalScopeStartLine || null, identity.lexicalScopeEndLine || null,
        identity.bindingId || null,
    ]);
}

function sameDeclaration(left, right) {
    const key = identityKey(left);
    return key !== null && key === identityKey(right);
}

/**
 * Check a data-only witness, never infer a negative from a failed proof.
 * `establishes-other` requires its own complete lookup/binding witness.
 * Reports without a migrated witness remain explicitly incomplete (#356).
 */
function validateConfirmation(provenance, target, invalidCall = false) {
    const targets = (Array.isArray(target) ? target : [target]).filter(Boolean);
    const facts = provenance?.facts || {};
    const incomplete = diagnostic => ({ verdict: 'incomplete', diagnostic });
    const inconsistent = diagnostic => ({ verdict: 'inconsistent', diagnostic });
    const verdictFor = declaration => targets.some(t => sameDeclaration(t, declaration))
        ? { verdict: 'establishes-target' }
        : { verdict: 'establishes-other', declaration };
    if (!targets.length || targets.some(t => !identityKey(t))) return incomplete('missing-target-identity');
    if (facts.builtinReceiver) {
        if (!require('./receiver-types').isProvenanceBuiltinReceiver(facts.receiverType, facts.language) ||
            facts.builtinReceiver.type !== facts.receiverType ||
            facts.builtinReceiver.language !== facts.language) return inconsistent('builtin-receiver-mismatch');
        if (!facts.receiverOrigin || ['unknown', 'guess'].includes(facts.receiverTypeSource) ||
            facts.receiverOrigin.source !== facts.receiverTypeSource) return incomplete('builtin-origin-not-established');
        return { verdict: 'establishes-other', declaration: { builtin: facts.receiverType, language: facts.language } };
    }
    if (facts.lookup) {
        const { receiver, steps, selected } = facts.lookup;
        if (!identityKey(receiver) || !identityKey(selected) || !Array.isArray(steps) || !steps.length) {
            return incomplete('missing-receiver-lookup');
        }
        if (!sameDeclaration(receiver, steps[0].owner)) return inconsistent('lookup-origin-mismatch');
        if (!sameDeclaration(receiver, facts.receiverResolvedIn)) return inconsistent('receiver-identity-mismatch');
        const aliases = facts.receiverAliases || [];
        const typeDeclaration = facts.receiverTypeDeclaration || receiver;
        if (facts.receiverTypeQualifier && ['java', 'csharp'].includes(facts.language) &&
            facts.receiverTypeQualifier !== typeDeclaration.enclosingType &&
            facts.receiverTypeQualifier !== typeDeclaration.namespace) {
            return inconsistent('receiver-qualifier-mismatch');
        }
        if (facts.receiverImportChain && validateConfirmation({ facts: {
            importChain: facts.receiverImportChain,
        } }, typeDeclaration).verdict !== 'establishes-target') return inconsistent('receiver-import-chain-mismatch');
        let resolvedAlias = typeDeclaration;
        for (const alias of aliases) {
            if (!sameDeclaration(alias.declaration, resolvedAlias) ||
                !alias.aliasOf || !alias.name || !identityKey(alias.target)) return inconsistent('receiver-alias-chain-mismatch');
            const head = String(alias.aliasOf).replace(/^[*&\s]+/, '').split(/[<[]/, 1)[0].trim().split(/::|\./).pop();
            if (head !== alias.name.split(/::|\./).pop() || head !== alias.target.name) return inconsistent('receiver-alias-target-mismatch');
            resolvedAlias = alias.target;
        }
        if (!sameDeclaration(resolvedAlias, receiver)) return inconsistent('receiver-alias-end-mismatch');
        const bound = facts.receiverGenericBound;
        if (bound && (!identityKey(bound.declaration) || bound.parameter !== facts.receiverType ||
            !bound.bounds?.includes(typeDeclaration.name) || !sameDeclaration(bound.selected, typeDeclaration))) {
            return inconsistent('receiver-generic-bound-mismatch');
        }
        const castThis = facts.receiverCastThis;
        if (castThis && (!identityKey(castThis.enclosing) ||
            castThis.enclosing.className !== receiver.name || castThis.enclosing.file !== receiver.file ||
            castThis.interfaceType !== facts.receiverType)) return inconsistent('receiver-this-cast-mismatch');
        const overload = facts.lookup.overload;
        const group = overload && require('./provenance-overload').overloadMemberGroup(steps);
        if (overload && !group) return incomplete('missing-overload-declarations');
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!identityKey(step.owner) || !Array.isArray(step.members) || !Array.isArray(step.parents)) {
                return incomplete('missing-member-lookup-facts');
            }
            const named = step.members.filter(member => member.name === selected.name);
            if (named.some(member => member.className !== step.owner.name ||
                (member.namespace || null) !== (step.owner.namespace || null) ||
                (member.enclosingType || null) !== (step.owner.enclosingType || null) ||
                (facts.language !== 'go' && member.file !== step.owner.file))) {
                return inconsistent('member-owner-mismatch');
            }
            if (i + 1 < steps.length) {
                if (named.length && !overload) return inconsistent('overriding-member-before-target');
                if (!step.parents.some(parent => sameDeclaration(parent, steps[i + 1].owner))) {
                    return inconsistent('unproven-inheritance-hop');
                }
            } else if (!overload && (named.length !== 1 || !sameDeclaration(named[0], selected))) {
                if (!require('./provenance-overload').validateOverload(step.overload, named, selected)) {
                    return incomplete('ambiguous-or-missing-member');
                }
            }
        }
        if (overload && !require('./provenance-overload').validateOverload(
            overload, group.map(declarationIdentity), selected, invalidCall)) {
            return incomplete(overload.outcome === 'no-fit' ? 'no-applicable-overload' : 'ambiguous-or-missing-member');
        }
        if (facts.receiverTypeSource === 'guess' || facts.receiverTypeSource === 'unknown') {
            return incomplete('receiver-origin-not-established');
        }
        if (!facts.receiverOrigin || facts.receiverOrigin.source === 'unknown') {
            return incomplete('missing-receiver-origin');
        }
        if (facts.receiverOrigin.source !== facts.receiverTypeSource) {
            return inconsistent('receiver-source-mismatch');
        }
        return verdictFor(selected);
    }
    if (facts.binding) {
        if (!identityKey(facts.binding.declaration) || !facts.binding.referenceId ||
            facts.binding.referenceId !== facts.binding.declaration.bindingId) {
            return incomplete('missing-binding-witness');
        }
        return verdictFor(facts.binding.declaration);
    }
    if (facts.importChain) {
        const chain = facts.importChain;
        if (!chain.length) return incomplete('empty-import-chain');
        for (let i = 0; i < chain.length; i++) {
            const hop = chain[i];
            if (!hop.localName || !hop.importedName || !hop.fromFile || !hop.toFile) {
                return incomplete('missing-import-name-hop');
            }
            if (i > 0 && (chain[i - 1].toFile !== hop.fromFile ||
                chain[i - 1].importedName !== hop.localName)) {
                return inconsistent('import-name-chain-mismatch');
            }
        }
        const last = chain.at(-1);
        if (!identityKey(last.declaration) || last.declaration.file !== last.toFile ||
            last.declaration.name !== last.importedName) return incomplete('missing-import-declaration');
        return verdictFor(last.declaration);
    }
    // An unsupported rule is an instrumentation result, not a failed proof.
    // A collector that entered a supported lookup must still fail closed if
    // its witness is absent (including when a saved witness was tampered with).
    if (facts.receiverResolvedIn && !facts.lookupUnsupported) return incomplete('missing-receiver-lookup');
    return { verdict: 'unsupported', diagnostic: 'rule-not-yet-validated' };
}

/** An invalid member-family call is a diagnostic, never a confirmed edge. */
function validateCallMismatch(provenance, target) {
    const lookup = provenance?.facts?.lookup;
    if (lookup?.overload?.outcome !== 'no-fit') return false;
    const members = lookup.steps.flatMap(step => step.members || []);
    if (!members.some(member => sameDeclaration(member, target))) return false;
    return validateConfirmation(provenance, members, true).verdict === 'establishes-target';
}

function createProvenance(evidence, resolution) {
    const facts = { ...(evidence.facts || {}) };
    const source = facts.receiverTypeSource || 'unknown';
    const rules = [];
    if (evidence.possibleDispatch) rules.push('possible-dispatch');
    if (evidence.methodAmbiguous) rules.push('method-ambiguous');
    if (evidence.resolvedBySameClass) rules.push('same-class');
    if (evidence.extensionMethod) rules.push('extension-method');
    if (evidence.hasReceiverType || evidence.resolvedByReceiverHint) {
        rules.push(TYPE_SOURCE_RULES[source] || 'receiver-type');
    }
    if (evidence.typeQualifiedReceiver) rules.push('type-qualified');
    if (evidence.moduleOwnedPath) rules.push('module-owned');
    if (evidence.hasBindingId) rules.push('binding');
    if (evidence.hasSingleOwnerEvidence) rules.push('single-owner');
    if (evidence.hasImportEvidence) rules.push(facts.importChain ? 'import-chain' : 'import-supported');
    if (evidence.hasReceiverEvidence) rules.push('receiver-binding');
    if (evidence.hasSamePackageEvidence) rules.push('same-package');
    if (!rules.length) rules.push(evidence.reason || resolution || 'unknown');
    const provenance = { rule: rules[0], rules: [...new Set(rules)], facts };
    if (facts.targets?.length) {
        const checked = validateConfirmation(provenance, facts.targets);
        provenance.validation = checked.verdict;
        if (checked.diagnostic) provenance.diagnostic = checked.diagnostic;
    } else {
        provenance.validation = 'incomplete';
        provenance.diagnostic = 'missing-target-identity';
    }
    return provenance;
}

function summarizeProvenance(sites) {
    if (!sites?.length) return null;
    const provenance = sites.map(site => site.provenance || site).filter(p => p.rule);
    const rules = [...new Set(provenance.flatMap(p => p.rules || [p.rule]))].sort(codeUnitCompare);
    return {
        // Equal scores retain occurrence order; weaker evidence sets the
        // aggregate rule while every occurrence keeps its own full witness.
        rule: sites.reduce((weakest, site) =>
            (site.evidenceScore ?? Infinity) < (weakest.evidenceScore ?? Infinity) ? site : weakest
        ).provenance?.rule || provenance[0].rule,
        rules,
        validation: provenance.every(p => p.validation === 'establishes-target')
            ? 'establishes-target' : 'incomplete',
    };
}

module.exports = {
    TYPE_SOURCE_RULES, declarationIdentity, identityKey, sameDeclaration,
    validateConfirmation, validateCallMismatch, createProvenance, summarizeProvenance,
};
