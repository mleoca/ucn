'use strict';

const { codeUnitCompare } = require('./shared');

const TYPE_SOURCE_RULES = Object.freeze({
    annotation: 'receiver-annotation', constructor: 'constructor-typed',
    flow: 'return-flow', field: 'field-hop', literal: 'literal-receiver',
    'with-binding': 'with-binding', cast: 'receiver-cast',
    'type-assertion': 'receiver-type-assertion', guess: 'receiver-guess',
    fixture: 'pytest-fixture',
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

function propertyReadMember(members) {
    const readers = members.filter(member => ['getter', 'property'].includes(member.kind));
    return readers.length === 1 && members.every(member =>
        ['getter', 'property', 'setter'].includes(member.kind)) ? readers[0] : null;
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
    if (facts.receiverOrigin?.externalFactory) {
        const factory = facts.receiverOrigin.externalFactory;
        const empty = value => Array.isArray(value) && !value.length;
        const span = origin => Number.isInteger(origin?.start) && Number.isInteger(origin?.end) && origin.end > origin.start;
        if (facts.language !== 'python' || facts.receiverTypeSource !== 'flow' ||
            !identityKey(factory.owner) || !identityKey(factory.enclosing) ||
            factory.owner.file !== facts.site?.file || factory.enclosing.file !== factory.owner.file ||
            factory.enclosing.className !== factory.owner.name || !factory.field ||
            facts.site.line < factory.enclosing.startLine || facts.site.line > factory.enclosing.endLine ||
            facts.receiverPath?.length !== 2 || facts.receiverPath[0] !== 'self' || facts.receiverPath[1] !== factory.field ||
            !Array.isArray(factory.assignments) || !factory.assignments.length) return incomplete('missing-external-field-flow');
        for (const write of factory.assignments) {
            const binding = write.binding, imported = ['from', 'relative'].includes(binding?.kind);
            if (!binding || !write.module || write.module !== binding.module || !write.producer ||
                !Array.isArray(write.path) || (binding.alias || binding.name) !== write.path[0] ||
                write.path.length !== (imported ? 1 : 2) || write.producer !== (imported ? binding.name : write.path[1]) ||
                !Number.isInteger(write.depth) || write.depth < 1 || write.depth > 3 ||
                !span(write.assignment) || write.assignment.nodeType !== 'assignment' ||
                write.assignment.line < factory.owner.startLine || write.assignment.line > factory.owner.endLine ||
                !span(write.expression) || write.expression.nodeType !== 'call' ||
                !empty(write.projectDeclarations) || !empty(write.projectBindings) || write.resolvedModule !== null) {
                return incomplete('invalid-external-factory-binding');
            }
        }
        if (new Set(factory.assignments.map(w => `${w.module}.${w.producer}:${w.depth}`)).size !== 1) {
            return inconsistent('conflicting-external-field-producers');
        }
        // Source ownership establishes runtime uncertainty, never a concrete
        // project target or an exclusion: an external factory may return one.
        return { verdict: 'establishes-dispatch' };
    }
    if (facts.receiverTypeSource === 'fixture' &&
        !require('./python-fixture-flow').validatePythonFixtureBinding(facts.receiverOrigin?.fixtureBinding, facts)) {
        return incomplete('invalid-pytest-fixture-binding');
    }
    if (facts.receiverOrigin?.aliasBinding) {
        const binding = facts.receiverOrigin.aliasBinding;
        if (facts.language !== 'rust' || binding.type !== facts.receiverType || binding.origin?.type !== binding.type ||
            !binding.variable || !['copy', 'borrow', 'reassignment'].includes(binding.kind) ||
            !['annotation', 'constructor', 'flow'].includes(binding.origin?.source) ||
            (binding.referenceAnnotation && (binding.origin.source !== 'annotation' ||
                !binding.referenceAnnotation.trim().startsWith('&'))) ||
            !Number.isInteger(binding.assignment?.start) || !Number.isInteger(binding.assignment?.end)) {
            return incomplete('invalid-copied-receiver-binding');
        }
    }
    if (facts.receiverOrigin?.assignments) {
        const assignments = facts.receiverOrigin.assignments;
        if (facts.language !== 'python' || !Array.isArray(assignments) || !assignments.length) {
            return incomplete('invalid-field-assignments');
        }
        const literals = { dictionary: 'dict', dictionary_comprehension: 'dict', list: 'list',
            list_comprehension: 'list', set: 'set', set_comprehension: 'set', tuple: 'tuple' };
        for (const write of assignments) {
            if (write.type !== facts.receiverType || !Number.isInteger(write.assignment?.start) ||
                !Number.isInteger(write.assignment?.end) || !Number.isInteger(write.expression?.start) ||
                !Number.isInteger(write.expression?.end)) return incomplete('invalid-field-assignment-origin');
            if (write.literal) {
                if (write.expression.nodeType !== write.literal || literals[write.literal] !== write.type) {
                    return inconsistent('field-literal-contract-mismatch');
                }
            } else {
                const call = write.importedCall;
                const binding = call?.binding;
                if (!binding || call.externalModule !== binding.module || write.expression.nodeType !== 'call' ||
                    call.type !== write.type || require('../languages/python').getBuiltinCallReturnType(
                        binding.module, binding.name) !== write.type) return inconsistent('field-call-contract-mismatch');
            }
        }
    }
    if (facts.receiverOrigin?.moduleProducer) {
        const producer = facts.receiverOrigin.moduleProducer;
        const call = producer.call, declaration = producer.declaration;
        if (facts.language !== 'rust' || !call?.receiver || !call.name || !call.file ||
            !Number.isInteger(call.start) || !Number.isInteger(call.end) ||
            !identityKey(declaration) || declaration.className || !declaration.returnType ||
            declaration.name !== call.name || declaration.file !== producer.module?.file) {
            return incomplete('invalid-module-producer-declaration');
        }
        const segments = call.receiver.split('::');
        const binding = producer.binding;
        if (binding && (binding.alias || binding.name) !== segments[0]) {
            return inconsistent('module-producer-binding-mismatch');
        }
        const specifier = binding ? [binding.module, ...segments.slice(1)].join('::') : call.receiver;
        const fileParts = producer.module.file.split('/');
        const base = fileParts.pop().replace(/\.rs$/, '');
        if (specifier !== producer.module.specifier ||
            specifier.split('::').at(-1) !== (base === 'mod' ? fileParts.pop() : base)) {
            return inconsistent('module-producer-path-mismatch');
        }
    }
    if (facts.standardWrapper) {
        const wrapper = facts.standardWrapper;
        if (facts.language !== 'rust' || wrapper.callKind !== 'method' || !wrapper.receiver ||
            !['unwrap', 'expect'].includes(wrapper.method)) {
            return incomplete('invalid-standard-wrapper-contract');
        }
        let kind;
        if (wrapper.contract) {
            if (!require('./rust-result-flow').validateRustWrapperContract(wrapper.contract, true)) {
                return incomplete('invalid-standard-wrapper-contract');
            }
            kind = wrapper.contract.kind;
        } else {
            const annotation = wrapper.annotationReceiver;
            const empty = value => Array.isArray(value) && !value.length;
            if (!annotation || !['Result', 'Option'].includes(annotation.type) ||
                annotation.origin?.source !== 'annotation' || annotation.genericParameter !== false ||
                !empty(annotation.wildcardImports) || !empty(annotation.rootDeclarations) || !empty(annotation.rootBindings) ||
                !Array.isArray(annotation.bindings)) return incomplete('invalid-standard-wrapper-annotation');
            const module = annotation.type === 'Result' ? 'result' : 'option';
            const paths = [`std::${module}::${annotation.type}`, `core::${module}::${annotation.type}`];
            if (annotation.qualifier ? !paths.includes(`${annotation.qualifier}::${annotation.type}`)
                : !empty(annotation.localDeclarations) || annotation.bindings.some(b =>
                    (b.alias || b.name) !== annotation.type || !paths.includes(b.module))) {
                return incomplete('shadowed-standard-wrapper-annotation');
            }
            kind = annotation.type;
        }
        return { verdict: 'establishes-other', declaration: {
            builtin: kind, method: wrapper.method, language: 'rust',
        } };
    }
    if (facts.receiverOrigin?.wrapperUnwrap || facts.receiverOrigin?.wrapperPattern) {
        const pattern = facts.receiverOrigin.wrapperPattern;
        const unwrap = pattern || facts.receiverOrigin.wrapperUnwrap;
        const validProjection = pattern
            ? ['Some', 'Ok'].includes(pattern.variant) &&
                pattern.contract?.kind === (pattern.variant === 'Some' ? 'Option' : 'Result') &&
                Array.isArray(pattern.shadowDeclarations) && !pattern.shadowDeclarations.length &&
                Array.isArray(pattern.shadowBindings) && !pattern.shadowBindings.length &&
                (pattern.source?.variable || (Number.isInteger(pattern.source?.start) &&
                    Number.isInteger(pattern.source?.end) && pattern.source.end > pattern.source.start))
            : ['unwrap', 'expect'].includes(unwrap.method);
        if (facts.language !== 'rust' || !validProjection ||
            !require('./rust-result-flow').validateRustWrapperContract(unwrap.contract)) {
            return incomplete('invalid-wrapper-unwrapping-contract');
        }
        if (facts.receiverOrigin.type !== unwrap.contract.type ||
            facts.receiverTypeFlowFile !== unwrap.contract.payload.declaration.file ||
            !sameDeclaration(unwrap.contract.payload.declaration,
                facts.receiverTypeDeclaration || facts.receiverResolvedIn)) {
            return inconsistent('wrapper-payload-identity-mismatch');
        }
    }
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
        if (overload && !group.some(member => sameDeclaration(declarationIdentity(member), selected))) {
            return inconsistent('selected-member-outside-overload-group');
        }
        const ambiguousOverload = overload?.outcome === 'ambiguous';
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
                const propertyRead = facts.valueReference && step.propertyRead &&
                    sameDeclaration(propertyReadMember(named), selected);
                if (!propertyRead && !require('./provenance-overload').validateOverload(step.overload, named, selected)) {
                    return incomplete('ambiguous-or-missing-member');
                }
            }
        }
        if (overload && !require('./provenance-overload').validateOverload(
            overload, group.map(declarationIdentity), selected, invalidCall, ambiguousOverload)) {
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
        if (ambiguousOverload) {
            // Every overload is known, but the argument shape cannot choose
            // one. This proves no particular target. It can still establish
            // that an unrelated target is outside the entire member group.
            const declarations = group.map(declarationIdentity);
            if (targets.some(target => declarations.some(member => sameDeclaration(target, member)))) {
                return incomplete('ambiguous-or-missing-member');
            }
            return { verdict: 'establishes-other', declarations };
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
            if (hop.wildcards) {
                const sources = hop.wildcards;
                if (!Array.isArray(sources) || !sources.length || sources.some(source =>
                    !source.file || source.binding?.name !== '*' || !source.binding.topLevel || !source.binding.module ||
                    !Number.isInteger(source.binding.origin?.start) || source.exports?.name !== '__all__' ||
                    !Number.isInteger(source.exports.origin?.start) || !Array.isArray(source.exports.literals) ||
                    !Array.isArray(source.exports.otherReferences) || source.exports.otherReferences.length ||
                    source.exports.literals.some(literal => typeof literal.value !== 'string' ||
                        literal.origin?.nodeType !== 'string' || !Number.isInteger(literal.origin.start)))) {
                    return incomplete('missing-wildcard-export-list');
                }
                const selected = sources.filter(source => source.exports.literals.some(literal => literal.value === hop.importedName));
                if (selected.length !== 1 || selected[0].file !== hop.toFile ||
                    selected[0].binding.module !== hop.module || hop.localName !== hop.importedName) {
                    return inconsistent('wildcard-export-owner-mismatch');
                }
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
    TYPE_SOURCE_RULES, declarationIdentity, identityKey, sameDeclaration, propertyReadMember,
    validateConfirmation, validateCallMismatch, createProvenance, summarizeProvenance,
};
