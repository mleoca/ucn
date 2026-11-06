'use strict';

const { parsedSource } = require('./source-memo');

const INVALID = Symbol('substitution-failure');

/** Three-valued constraint evaluation; INVALID is a failed substitution. */
function constraintResult(index, syntax, context, bindings, convertible) {
    if (!syntax.templateComplete || syntax.requires.some(clause => !clause.complete)) return null;
    if (syntax.templateAlternatives?.length > 1) {
        const results = syntax.templateAlternatives.map(template => constraintResult(index,
            { ...syntax, template, templateAlternatives: [] }, context, bindings, convertible));
        return results.every(result => result === false) ? false : results.every(result => result === true) ? true : null;
    }
    const { resolveType, sameType } = require('./cpp-conversions');
    const type = text => resolveType(index, text, context, bindings);
    const expression = text => {
        const tree = parsedSource('cpp', `constexpr bool probe = ${text};`);
        if (!tree || tree.rootNode.hasError) return null;
        const declaration = tree.rootNode.namedChildren.find(node => node.type === 'declaration');
        const init = declaration?.namedChildren.find(node => node.type === 'init_declarator');
        return evaluate(init?.childForFieldName('value'));
    };
    const traitValue = resolved => {
        if (resolved.kind === 'invalid') return INVALID;
        if (resolved.kind !== 'external') return null;
        const args = resolved.arguments || [];
        if (['std::is_same::value', 'std::is_same_v'].includes(resolved.qualified) && args.length === 2) {
            const a = type(args[0]), b = type(args[1]);
            return a.kind === 'invalid' || b.kind === 'invalid' ? INVALID : sameType(a, b);
        }
        if (['std::is_convertible::value', 'std::is_convertible_v'].includes(resolved.qualified) && args.length === 2) {
            const a = type(args[0]), b = type(args[1]);
            return a.kind === 'invalid' || b.kind === 'invalid' ? INVALID : convertible(a, b);
        }
        return null;
    };
    const validType = node => {
        if (!node) return null;
        const typeSyntax = ['primitive_type', 'type_identifier', 'qualified_identifier', 'template_type',
            'type_descriptor', 'dependent_type', 'sized_type_specifier'].includes(node.type);
        const resolved = typeSyntax ? type(node.text) : { kind: 'unknown' };
        if (resolved.kind === 'invalid') return INVALID;
        for (const child of node.namedChildren) {
            if (child.type === 'requires_expression') continue;
            if (validType(child) === INVALID) return INVALID;
        }
        if (resolved.kind === 'external' && ['std::enable_if::type', 'std::enable_if_t'].includes(resolved.qualified)) {
            const condition = expression(resolved.arguments[0]);
            return condition === false || condition === INVALID ? INVALID : condition;
        }
        return ['builtin', 'project', 'enum', 'standard'].includes(resolved.kind) ? true : null;
    };
    const evaluate = node => {
        if (!node) return null;
        if (node.type === 'true') return true;
        if (node.type === 'false') return false;
        if (node.type === 'number_literal' && /^[01]$/.test(node.text)) return node.text === '1';
        if (node.type === 'parenthesized_expression') return evaluate(node.namedChildren[0]);
        if (node.type === 'requires_expression') {
            const requirements = node.childForFieldName('requirements');
            for (const requirement of requirements?.namedChildren || []) {
                if (validType(requirement) === INVALID) return false;
            }
            return null;
        }
        if (['binary_expression', 'constraint_conjunction', 'constraint_disjunction'].includes(node.type)) {
            const a = evaluate(node.childForFieldName('left') || node.namedChildren[0]);
            const b = evaluate(node.childForFieldName('right') || node.namedChildren.at(-1));
            const operator = node.childForFieldName('operator')?.text ||
                (node.type === 'constraint_conjunction' ? '&&' : node.type === 'constraint_disjunction' ? '||' : null);
            if (operator === '&&' || operator === 'and') {
                if (a === false || b === false) return false;
                if (a === INVALID || b === INVALID) return INVALID;
                return a === true && b === true ? true : null;
            }
            if (operator === '||' || operator === 'or') {
                // A nested requires-expression can fail without invalidating
                // its enclosing disjunction. An undecidable substitution
                // outside it never supplies a negative proof here.
                if ((a === true || b === true) && a !== INVALID && b !== INVALID) return true;
                return a === false && b === false ? false : null;
            }
            if (a === INVALID || b === INVALID) return INVALID;
            if (typeof a === 'boolean' && typeof b === 'boolean' && ['==', '!='].includes(operator)) {
                return operator === '==' ? a === b : a !== b;
            }
            return null;
        }
        if (node.type === 'unary_expression') {
            const value = evaluate(node.childForFieldName('argument'));
            if (value === INVALID) return INVALID;
            return node.childForFieldName('operator')?.text === '!' && typeof value === 'boolean' ? !value : null;
        }
        const trait = traitValue(type(node.text));
        if (trait !== null) return trait;
        return validType(node) === INVALID ? INVALID : null;
    };
    let uncertain = false;
    if (syntax.template) {
        const tree = parsedSource('cpp', `template ${syntax.template.text} struct Probe {};`);
        const template = tree?.rootNode.namedChildren.find(node => node.type === 'template_declaration');
        for (const parameter of template?.childForFieldName('parameters')?.namedChildren || []) {
            const constrainedType = parameter.childForFieldName('default_type') ||
                (parameter.type === 'optional_parameter_declaration' ? parameter.childForFieldName('type') : null);
            if (!constrainedType) continue;
            const valid = validType(constrainedType);
            if (valid === INVALID) return false;
            if (valid !== true) uncertain = true;
        }
    }
    for (const clause of syntax.requires) {
        const tree = parsedSource('cpp', `template<class Probe> ${clause.text} void probe();`);
        if (!tree || tree.rootNode.hasError) return null;
        const requires = tree.rootNode.descendantsOfType('requires_clause')[0];
        const result = evaluate(requires?.childForFieldName('constraint') || requires?.namedChildren[0]);
        if (result === false || result === INVALID) return false;
        if (result !== true) uncertain = true;
    }
    return uncertain ? null : true;
}

module.exports = { constraintResult };
