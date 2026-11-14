/** Positive, deliberately bounded argument-fit proofs for changed calls. */
'use strict';

const { langTraits } = require('../languages');
const { argumentProvablyConverts, cppArgumentProvablyConverts } = require('./callers');

function literalKind(argument) {
    if (argument?.kind === 'number_literal' && /^\d+$/.test(argument.text || '') &&
        Number(argument.text) <= 127) return 'smallInteger';
    // Prefixes can change the type (Python bytes, C++ encoded strings).
    // Only plain quoted strings belong to this bounded proof domain.
    if (argument?.kind === 'string_literal' && ['"', "'"].includes(argument.text?.[0])) return 'string';
    if (['true', 'false', 'boolean_literal'].includes(argument?.nodeType)) return 'boolean';
    return null;
}

/** A written builtin type cannot borrow a project or imported namesake. */
function unshadowed(index, definition, type) {
    const simple = String(type || '').replace(/^&/, '').trim();
    if ((index.symbols.get(simple) || []).length) return false;
    const entry = index.files.get(definition.file);
    if ((entry?.importDetails || []).some(detail => detail.type === 'from' && detail.names?.includes('*'))) return false;
    return !(entry?.importBindings || []).some(binding => binding.name === '*' || binding.kind === 'wildcard' ||
        binding.name === simple || binding.local === simple || binding.alias === simple);
}

function unavailableSurface(index, definition, caller) {
    const sameOwner = caller.file === definition.file && caller.className && caller.className === definition.className &&
        (caller.namespace || null) === (definition.namespace || null) &&
        (caller.enclosingType || null) === (definition.enclosingType || null);
    const uncertain = member => member.isAbstract || (member.modifiers || []).includes('abstract') || (member.decorators || []).length > 0 ||
        !sameOwner && (member.modifiers || []).some(modifier => ['private', 'protected'].includes(modifier));
    if (uncertain(definition)) return true;
    if (definition.initializerOf) {
        const owners = (index.symbols.get(definition.initializerOf) || []).filter(owner => owner.type === 'class');
        if (owners.length !== 1 || uncertain(owners[0])) return true;
    }
    if (definition.type !== 'class') return false;
    const entry = index.files.get(definition.file);
    return (entry?.symbols || []).some(member => member.className === definition.name &&
        member.startLine >= definition.startLine && member.startLine <= definition.endLine &&
        (member.type === 'constructor' || member.isConstructor ||
            ['constructor', '__init__'].includes(member.name)) && uncertain(member));
}

/** A visible checked-JS/JSDoc contract withdraws the dynamic-only proof. */
function typedComments(index, file) {
    const trait = langTraits(index.files.get(file)?.language)?.checkTypedComment;
    if (!trait) return false;
    const memo = index._opMemo?.('checkTypedComments', () => new Map());
    if (memo?.has(file)) return memo.get(file);
    let found = true;
    try {
        const source = index._readFile(file);
        const root = index._getParsedTree(file, source, index.files.get(file)?.language)?.rootNode;
        if (root) found = root.descendantsOfType('comment').some(comment => trait(comment.text));
    } catch (_) { /* unread checking context stays unknown */ }
    memo?.set(file, found);
    return found;
}

/** True is a proof for this small domain; false means review, not mismatch. */
function positivelyFits(index, definition, caller, record, result, stableInvocation = false) {
    // A changed call may reuse its baseline availability only under an
    // unchanged invocation context. Count/type fit alone cannot prove a
    // new invocation, a receiver/generic/passing-mode change, or its result
    // use valid. Constructors and their implementation projections are
    // outside this proof: the public overload interface is not the body.
    if (!stableInvocation || definition.initializerOf || definition.isConstructor ||
        ['class', 'struct', 'record', 'constructor'].includes(definition.type)) return false;
    if (unavailableSurface(index, definition, caller) || (definition.decorators || []).length) return false;
    // A literal may select a different overload with different access,
    // exception or passing-mode requirements even when both return the
    // same type. Family completeness is not proved here: only a unique
    // project declaration belongs to this small positive domain.
    if ((index.symbols.get(definition.name) || []).length !== 1) return false;
    if (definition.className) {
        // A receiver or an inherited outside overload can choose a method
        // absent from the project family. Only a static member of a
        // non-derived owner belongs to this bounded preservation proof.
        if (!(definition.modifiers || []).includes('static')) return false;
        const owners = (index.symbols.get(definition.className) || []).filter(owner => owner.file === definition.file &&
            owner.startLine <= definition.startLine && owner.endLine >= definition.endLine);
        if (owners.length !== 1 || owners[0].extends?.length || owners[0].implements?.length) return false;
    }
    const traits = langTraits(index.files.get(definition.file)?.language);
    if ((definition.modifiers || []).some(modifier => (traits.compileTimeCallableMarkers || []).includes(modifier))) return false;
    const callerTraits = langTraits(index.files.get(caller.file)?.language);
    // Written TS declarations do not make ordinary JS arguments checked.
    if (callerTraits.lenientCallArity) return !typedComments(index, caller.file) && !typedComments(index, definition.file);
    const shape = result.callShapes?.[0];
    if (!shape || shape.hasSpread || shape.indirectKind) return false;
    const arguments_ = shape.argumentFacts || [];
    if (arguments_.length === 0) return false;
    if (arguments_.length !== shape.argCount) return false;
    const lists = result.parameterLists || [];
    if (lists.length !== 1) return false;
    const language = index.files.get(definition.file)?.language;
    return lists.some(parameters => {
        let positional = 0;
        return arguments_.every((argument, at) => {
            const parameter = argument.keyword ? parameters.find(p => p.name === argument.keyword)
                : parameters[positional++];
            if (!parameter || parameter.rest || !parameter.type) return false;
            // The nominal conversion helpers classify values, not C++
            // lvalue/rvalue reference binding or language passing modes.
            if (/[&*]/.test(parameter.type) && parameter.type !== '&str') return false;
            const kind = literalKind(argument);
            if (!kind) return false;
            if (traits.checkLiteralArguments) {
                const accepted = traits.checkLiteralArguments[kind] || [];
                return accepted.includes(parameter.type) && unshadowed(index, definition, parameter.type);
            }
            // Reuse the nominal overload engine's positive conversion
            // facts, never its weaker "not disproved" applicability test.
            if (!traits.hasArityOverloads || parameter.type.includes('.') ||
                !unshadowed(index, definition, parameter.type)) return false;
            const argumentKind = record.argKinds?.[at];
            if (!argumentKind) return false;
            if (traits.userDefinedConversions === 'constructors-and-operators') {
                return cppArgumentProvablyConverts(index, argumentKind, parameter, definition,
                    { ...record, argumentFile: caller.file }, at);
            }
            return argumentProvablyConverts(index, argumentKind, parameter, language, definition,
                { file: caller.file });
        });
    });
}

module.exports = { positivelyFits };
