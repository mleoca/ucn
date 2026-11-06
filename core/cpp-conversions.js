'use strict';

const path = require('path');
const scope = require('./cpp-scope');
const { sharedRead } = require('./provenance-overload');
const { standardStringType, CHARACTERS } = require('../languages/cpp-platform');
const { declarationSyntax, classSyntax } = require('./cpp-conversion-syntax');
const { sameDeclaration, declarationIdentity } = require('./provenance');

function substituteType(text, bindings) {
    return String(text || '').replace(/\b[A-Za-z_]\w*\b/g, name => {
        const bound = bindings?.get(name);
        return typeof bound === 'string' ? bound : name;
    });
}

function qualifiedParts(text) {
    const parts = [];
    let depth = 0, from = 0;
    for (let i = 0; i < text.length; i++) {
        if ('<(['.includes(text[i])) depth++;
        else if ('>)]'.includes(text[i])) depth--;
        else if (depth === 0 && text.slice(i, i + 2) === '::') {
            parts.push(text.slice(from, i)); from = i + 2; i++;
        }
    }
    parts.push(text.slice(from));
    return parts;
}

function builtinType(text) {
    const bare = typeText(text);
    const pointer = /\*|\[/.test(scope.stripTemplateArguments(bare));
    const base = bare.replace(/\*|\[[^\]]*\]/g, '').replace(/\(\s*\)/g, '').trim();
    if (pointer) {
        const levels = (bare.match(/\*|\[/g) || []).length;
        return { kind: 'builtin', category: 'pointer', text, base, levels,
            ...(levels === 1 && CHARACTERS.has(base) && { character: base }) };
    }
    if (CHARACTERS.has(base)) return { kind: 'builtin', category: 'arithmetic', text, base };
    if (base === 'bool') return { kind: 'builtin', category: 'bool', text, base };
    if (base === 'void') return { kind: 'builtin', category: 'void', text, base };
    if (/^(?:(?:signed|unsigned)\s*)?(?:char|short|int|long(?:\s+long)?|float|double|long\s+double)?(?:\s+int)?$/.test(base) && base) {
        return { kind: 'builtin', category: 'arithmetic', text, base };
    }
    if (base === 'std::nullptr_t' || base === 'decltype(nullptr)') return { kind: 'builtin', category: 'null', text, base };
    return null;
}

function templateBindings(index, definition, arguments_, inherited, context, depth) {
    const bindings = new Map(inherited || []);
    if (!definition.templateParams && arguments_.length === 0) return bindings;
    const syntax = declarationSyntax(index, definition);
    let position = 0;
    for (const param of syntax.template?.parameters || []) {
        if (!param.name) continue;
        if (param.variadic) {
            bindings.set(param.name, null);
            break;
        }
        const actual = arguments_[position++];
        if (actual != null) {
            const head = typeText(actual);
            const bound = inherited?.get(head);
            const text = substituteType(actual, inherited);
            const isType = param.type.includes('type_parameter');
            const resolved = isType && !builtinType(text) && !(bound && typeof bound === 'object')
                ? resolveType(index, actual, context, inherited, depth + 1) : null;
            bindings.set(param.name, bound && typeof bound === 'object' ? bound : resolved
                ? resolved.kind === 'unknown' ? null : resolved : text);
        }
        else if (param.default != null) bindings.set(param.name, substituteType(param.default, bindings));
        else if (!bindings.has(param.name)) bindings.set(param.name, null);
    }
    return bindings;
}

function resolvedDeclaration(index, definition, text, context, bindings, depth) {
    const arguments_ = typeArguments(qualifiedParts(text).at(-1));
    const own = templateBindings(index, definition, arguments_, bindings, context, depth);
    if (definition.type === 'type') {
        if (!definition.aliasOf) return { kind: 'unknown', text };
        return resolveType(index, definition.aliasOf, contextOf(index, definition), own, depth + 1);
    }
    return { kind: definition.type === 'enum' ? 'enum' : 'project', definition, bindings: own, text,
        context: contextOf(index, definition) };
}

function resolveType(index, spelling, context, bindings = new Map(), depth = 0) {
    const key = `cpp-conversion-type:${JSON.stringify([spelling, context, [...bindings], depth], (_, value) => value instanceof Map ? [...value] : value)}`;
    return sharedRead(index, key, view => resolveTypeUncached(view, spelling, context, bindings, depth));
}

function resolveTypeUncached(index, spelling, context, bindings, depth) {
    const result = resolveTypeInner(index, spelling, context, bindings, depth);
    const outside = scope.stripTemplateArguments(substituteType(spelling, bindings));
    const qualifiers = new Set(result.qualifiers || []);
    for (const qualifier of outside.match(/\b(?:const|volatile)\b|&&|&/g) || []) qualifiers.add(qualifier);
    return { ...result, context: result.context || context, bindings: result.bindings || bindings,
        qualifiers: [...qualifiers].sort() };
}

function resolveTypeInner(index, spelling, context, bindings, depth) {
    if (!context || depth > 12) return { kind: 'unknown', text: spelling };
    const original = typeText(spelling);
    const first = qualifiedParts(original)[0]?.trim();
    const bound = bindings.get(first);
    if (bound && typeof bound === 'object') {
        if (qualifiedParts(original).length === 1) return bound;
        if (bound.kind === 'builtin') return { kind: 'invalid', text: spelling };
    }
    if (bindings.has(first) && bindings.get(first) === null || context.typeParameters?.includes(first) && !bindings.has(first)) {
        return { kind: 'unknown', text: spelling };
    }
    if (qualifiedParts(original).length > 1 && typeof bound === 'string' && builtinType(bound)) {
        return { kind: 'invalid', text: spelling };
    }
    const text = substituteType(original, bindings);
    const builtin = builtinType(substituteType(spelling, bindings));
    if (builtin) return builtin;
    const parts = qualifiedParts(text);
    const found = bound && typeof bound === 'object' ? { kind: 'unknown' } :
        scope.resolveQualifier(index, context, text, scope.includeClosure(index, context.file), 0,
            { declarations: true, externalTypes: true });
    if (found.kind === 'type' && found.visible && found.declarations.length === 1) {
        return resolvedDeclaration(index, found.declarations[0], text, context, bindings, depth);
    }
    // A qualifier can itself be a class alias with template arguments.
    // Resolve that class first so its member aliases inherit those bindings.
    if (parts.length > 1 && parts.at(-1) && !parts.at(-1).includes('<')) {
        const parent = resolveType(index, parts.slice(0, -1).join('::'), context, bindings, depth + 1);
        const member = parts.at(-1).trim();
        if (parent.kind === 'builtin') return { kind: 'invalid', text };
        if (parent.kind === 'project') {
            const syntax = classSyntax(index, parent.definition);
            const matches = syntax.members.filter(definition => definition.name === member &&
                ['type', 'class', 'struct', 'enum', 'union'].includes(definition.type));
            if (matches.length === 1) return resolvedDeclaration(index, matches[0], member, context,
                parent.bindings, depth + 1);
            if (matches.length === 0 && syntax.complete && !syntax.bases.length) return { kind: 'invalid', text };
        }
        if (parent.kind === 'standard' && member === 'value_type') return builtinType(parent.platform.character);
        if (parent.kind === 'external') return { ...parent, qualified: `${parent.qualified}::${member}`, text };
    }
    if (found.kind === 'external') {
        const arguments_ = typeArguments(text);
        const platform = standardStringType(found.qualified, arguments_);
        return { kind: platform ? 'standard' : 'external', qualified: found.qualified,
            arguments: arguments_, text, context, bindings, ...(platform && { platform }) };
    }
    return { kind: 'unknown', text };
}

function sameType(a, b) {
    if (['unknown', 'invalid'].includes(a.kind) || ['unknown', 'invalid'].includes(b.kind)) return null;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'builtin' && a.category !== b.category) return false;
    if (a.genericTypeUnknown || b.genericTypeUnknown) return null;
    if ([a, b].some(type => type.qualifiers?.includes('&') && type.qualifiers?.includes('&&'))) return null;
    if (JSON.stringify(a.qualifiers || []) !== JSON.stringify(b.qualifiers || [])) return false;
    if (a.kind === 'project' || a.kind === 'enum') {
        if (!sameDeclaration(declarationIdentity(a.definition), declarationIdentity(b.definition))) return false;
        const encoded = bindings => JSON.stringify([...bindings], (_, value) => value instanceof Map ? [...value] : value);
        return encoded(a.bindings) === encoded(b.bindings) ? true : null;
    }
    if (a.kind === 'standard') return a.platform.family === b.platform.family && a.platform.character === b.platform.character;
    if (a.kind === 'external') return a.qualified === b.qualified && a.text === b.text ? true : null;
    const canonical = type => type.base.replace(/^signed\s+(?=(?:short|int|long)\b)/, '').replace(/^signed$/, 'int')
        .replace(/^(unsigned)$/, '$1 int').replace(/^(short|long|long long|unsigned short|unsigned long|unsigned long long) int$/, '$1');
    if (a.category !== b.category || canonical(a) !== canonical(b)) return false;
    if (a.category === 'pointer') return a.text.replace(/\s/g, '') === b.text.replace(/\s/g, '') &&
        !a.text.includes('[') ? true : null;
    return true;
}

function argumentType(index, kind, call, position) {
    if (kind?.startsWith('string:')) return { ...builtinType(`const ${kind.slice(7)}[]`), literal: true };
    if (kind?.startsWith('char:')) return { ...builtinType(kind.slice(5)), genericTypeUnknown: kind === 'char:char' };
    if (kind === 'number:zero') return { ...builtinType('int'), zero: true, genericTypeUnknown: true };
    if (kind === 'number:integer') return { ...builtinType('int'), genericTypeUnknown: true };
    if (kind === 'number:floating') return { ...builtinType('double'), genericTypeUnknown: true };
    if (kind === 'bool') return builtinType('bool');
    if (kind === 'null') return builtinType('std::nullptr_t');
    if (kind?.startsWith('type:')) {
        const builtin = builtinType(kind.slice(5));
        const origin = call?.argTypeOrigins?.[position];
        if (call?.argumentFile && origin) return resolveType(index, kind.slice(5), {
            ...origin, file: path.resolve(index.root, call.argumentFile),
        });
        if (builtin) return builtin;
    }
    return { kind: 'unknown', text: kind };
}

function derivedFrom(index, source, target, depth) {
    if (depth > 10) return null;
    if (sameDeclaration(declarationIdentity(source.definition), declarationIdentity(target.definition))) return true;
    const syntax = classSyntax(index, source.definition);
    let unknown = !syntax.complete;
    for (const base of syntax.bases) {
        const parent = resolveType(index, base, source.context, source.bindings);
        if (parent.kind !== 'project') { unknown = true; continue; }
        const reaches = derivedFrom(index, parent, target, depth + 1);
        if (reaches === true) return true;
        if (reaches === null) unknown = true;
    }
    return unknown ? null : false;
}

function deduceConstructor(source, constructor, inherited) {
    const bindings = new Map(inherited);
    for (const parameter of constructor.syntax.template?.parameters || []) {
        if (parameter.name && !bindings.has(parameter.name)) bindings.set(parameter.name, null);
    }
    const formal = constructor.definition.paramsStructured?.[0]?.type || constructor.syntax.parameterTypes?.[0];
    const head = typeText(formal);
    if (bindings.has(head) && source.kind !== 'unknown') {
        const uncertain = source.genericTypeUnknown || source.category === 'pointer' || /&&/.test(formal);
        const qualifiers = (source.qualifiers || []).filter(qualifier => {
            if (qualifier === '&' || qualifier === '&&') return false;
            if (!formal.includes('&')) return !['const', 'volatile'].includes(qualifier);
            return !new RegExp(`\\b${qualifier}\\b`).test(formal);
        });
        bindings.set(head, { ...source, qualifiers, zero: false,
            ...(uncertain && { genericTypeUnknown: true }) });
    }
    return bindings;
}

function constraintConversion(index, source, target, depth) {
    const result = typeConversion(index, source, target, depth);
    // A type trait also tests reference binding and volatile qualification.
    // Category compatibility alone does not prove those standard conversions.
    return result === true && [source, target].some(type =>
        type.qualifiers?.some(qualifier => ['&', '&&', 'volatile'].includes(qualifier))) ? null : result;
}

function operatorPossibilities(index, source, target, depth) {
    if (source.kind !== 'project') return [];
    const syntax = classSyntax(index, source.definition), results = [];
    if (!syntax.complete) results.push(null);
    for (const operator of syntax.operators) {
        if (operator.syntax.explicit === 'explicit') continue;
        const context = contextOf(index, operator.definition);
        const bindings = new Map(source.bindings);
        for (const parameter of operator.syntax.template?.parameters || []) {
            if (parameter.name) bindings.set(parameter.name,
                typeText(operator.syntax.conversionType) === parameter.name ? target : null);
        }
        const constraints = require('./cpp-conversion-constraints').constraintResult(index, operator.syntax,
            context, bindings, (a, b) => constraintConversion(index, a, b, depth + 1));
        if (constraints === false) continue;
        const result = resolveType(index, operator.syntax.conversionType, context, bindings);
        if (typeConversion(index, result, target, depth + 1, false) !== false) results.push(null);
    }
    for (const base of syntax.bases) {
        const parent = resolveType(index, base, source.context, source.bindings);
        if (parent.kind === 'project' && depth < 10) results.push(...operatorPossibilities(index, parent, target, depth + 1));
        else results.push(null);
    }
    return results;
}

/** true: standard conversion; false: impossible; null: undecided. */
function typeConversion(index, source, target, depth = 0, userDefined = true) {
    if (depth > 10 || source.kind === 'unknown' || target.kind === 'unknown') return null;
    if (source.kind === 'invalid' || target.kind === 'invalid') return false;
    if (source.kind === 'builtin' && target.kind === 'builtin') {
        if (source.category === 'void' || target.category === 'void') return source.category === target.category;
        if (source.zero) return true;
        if (source.category === 'null') return ['pointer', 'null'].includes(target.category);
        if (target.category === 'bool') return true;
        if (source.category === 'pointer' || target.category === 'pointer') {
            if (source.category !== target.category) return false;
            if (target.base === 'void') return true;
            if (source.base === target.base) return null;
            const a = builtinType(source.base), b = builtinType(target.base);
            if (a && b) return false;
            const ap = a || resolveType(index, source.base, source.context, source.bindings);
            const bp = b || resolveType(index, target.base, target.context, target.bindings);
            if (a && ['project', 'enum', 'standard'].includes(bp.kind) ||
                b && ['project', 'enum', 'standard'].includes(ap.kind)) return false;
            return null;
        }
        if (target.category === 'null') return false;
        return true;
    }
    if (target.kind === 'standard') {
        if (source.kind === 'standard') {
            if (source.platform.character !== target.platform.character) return false;
            if (source.platform.family === target.platform.family) return true;
            return userDefined && target.platform.family === 'view';
        }
        if (source.kind === 'builtin') {
            if (!userDefined) return false;
            if (source.zero || source.category === 'null') return null;
            if (source.category !== 'pointer' || source.levels !== 1) return false;
            if (/\bvolatile\b/.test(source.text.split(/\*|\[/)[0])) return false;
            if (source.character) return source.character === target.platform.character;
            const pointee = resolveType(index, source.base, source.context, source.bindings);
            if (pointee.kind === 'builtin') return !pointee.qualifiers?.includes('volatile') &&
                CHARACTERS.has(pointee.base) && pointee.base === target.platform.character;
            return ['project', 'enum', 'standard'].includes(pointee.kind) ? false : null;
        }
    }
    if (source.kind === 'project' && target.kind === 'project') {
        const related = derivedFrom(index, source, target, depth);
        if (related !== false) return null;
    }
    if (target.kind === 'enum') {
        if (source.kind === 'enum') return sameType(source, target);
        if (source.kind === 'builtin' || source.kind === 'standard') return false;
    }
    if (source.kind === 'enum' && target.kind === 'builtin') return null;
    if (source.kind === 'enum' && target.kind === 'standard') return false;
    if (source.kind === 'external' || target.kind === 'external') return null;
    const possibilities = userDefined ? operatorPossibilities(index, source, target, depth) : [];
    if (target.kind === 'project' && userDefined) {
        const syntax = classSyntax(index, target.definition);
        if (!syntax.complete) possibilities.push(null);
        for (const constructor of syntax.constructors) {
            const params = constructor.definition.paramsStructured;
            if (!Array.isArray(params)) { possibilities.push(null); continue; }
            const required = params.filter(param => !param.optional && param.default === undefined && !param.rest).length;
            if (required > 1 || params.length === 0 || constructor.syntax.explicit === 'explicit') continue;
            const parameterType = params[0].type || constructor.syntax.parameterTypes?.[0];
            if (!parameterType || params[0].rest) { possibilities.push(null); continue; }
            const bindings = deduceConstructor(source, constructor, target.bindings);
            const context = contextOf(index, constructor.definition);
            const constraints = require('./cpp-conversion-constraints').constraintResult(index, constructor.syntax,
                context, bindings, (a, b) => constraintConversion(index, a, b, depth + 1));
            if (constraints === false) continue;
            const parameter = resolveType(index, parameterType, context, bindings);
            if (typeConversion(index, source, parameter, depth + 1, false) !== false) possibilities.push(null);
        }
    }
    return possibilities.length ? null : false;
}

function argumentConversion(index, kind, parameterType, definition, call, position) {
    const origin = kind?.startsWith('type:') ? [call?.argumentFile, call?.argTypeOrigins?.[position]] : null;
    if (!index.isProvenanceFactIndex) {
        const inventory = scope.conversionResultMemo(index);
        let memo = inventory.get(definition);
        if (!memo) inventory.set(definition, memo = new Map());
        const key = `${kind}\0${parameterType}\0${origin ? JSON.stringify(origin) : ''}`;
        if (!memo.has(key)) memo.set(key, typeConversion(index, argumentType(index, kind, call, position),
            resolveType(index, parameterType, contextOf(index, definition))));
        return memo.get(key);
    }
    const context = contextOf(index, definition);
    const key = `cpp-argument-conversion:${JSON.stringify([kind, parameterType, context, origin])}`;
    return sharedRead(index, key, view => typeConversion(view, argumentType(view, kind, call, position),
        resolveType(view, parameterType, context)));
}

function typeText(type) {
    const text = String(type || '');
    let depth = 0, result = '';
    for (let i = 0; i < text.length;) {
        const ch = text[i];
        if ('<(['.includes(ch)) depth++;
        else if ('>)]'.includes(ch)) depth--;
        if (depth === 0) {
            const qualifier = /^(?:const|volatile|typename|class|struct)\b/.exec(text.slice(i));
            if (qualifier && (i === 0 || !/\w/.test(text[i - 1]))) { i += qualifier[0].length; continue; }
            if (ch === '&') { i++; continue; }
        }
        result += ch; i++;
    }
    return result.replace(/\s*::\s*/g, '::').replace(/\s*</g, '<').replace(/\s+/g, ' ').trim();
}

function typeArguments(text) {
    const start = text.indexOf('<');
    if (start < 0) return [];
    const result = [];
    let depth = 0, from = start + 1;
    for (let i = from; i < text.length; i++) {
        const ch = text[i];
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        else if (ch === '>' && depth === 0) {
            if (i > from) result.push(text.slice(from, i).trim());
            return result;
        } else if (ch === '>' || ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) { result.push(text.slice(from, i).trim()); from = i + 1; }
    }
    return [];
}

function contextOf(index, definition) {
    if (!definition?.file) return null;
    const file = path.resolve(index.root, definition.file);
    return { file, line: definition.startLine || definition.line || 1,
        className: definition.className || definition.enclosingType || null,
        ...(definition.templateParams && { typeParameters: typeArguments(`Type${definition.templateParams}`) }),
        ...(definition.namespace != null && { namespace: scope.effectiveNamespace(index, { ...definition, file }) }) };
}

// Positive platform proofs use the same resolved types as exclusions.
function platformConversion(index, kind, parameterType, definition, call, position) {
    const target = resolveType(index, parameterType, contextOf(index, definition));
    if (target.kind !== 'standard') return null;
    const source = argumentType(index, kind, call, position);
    const qualifiers = target.qualifiers || [];
    // Constructibility does not prove reference binding or access through a
    // volatile object. Those need value-category and qualified-member facts.
    if (qualifiers.includes('&&') || qualifiers.includes('&') && !qualifiers.includes('const') ||
        [source, target].some(type => type.qualifiers?.includes('volatile'))) return null;
    return typeConversion(index, source, target);
}

module.exports = { platformConversion, typeText, typeArguments, contextOf,
    resolveType, sameType, substituteType, builtinType, qualifiedParts, argumentConversion, typeConversion };
