'use strict';

const path = require('path');
const { declarationIdentity, identityKey } = require('./provenance');
const { resolveRustImport } = require('./imports');

const TYPE_KINDS = new Set(['class', 'struct', 'enum', 'type', 'trait', 'interface']);

function parseGeneric(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim(), start = text.indexOf('<');
    if (start < 1 || !text.endsWith('>')) return null;
    const args = [];
    let depth = 0, current = '';
    for (const character of text.slice(start + 1, -1)) {
        if ('<(['.includes(character)) depth++;
        else if ('>)]'.includes(character)) depth--;
        if (character === ',' && depth === 0) { args.push(current.trim()); current = ''; }
        else current += character;
        if (depth < 0) return null;
    }
    if (depth) return null;
    args.push(current.trim());
    return args.every(Boolean) ? { head: text.slice(0, start).trim(), args } : null;
}

function projectTuple(text, projection) {
    for (const position of projection) {
        text = text.trim();
        if (!Number.isInteger(position) || position < 0 || !text.startsWith('(') || !text.endsWith(')')) return null;
        const tuple = parseGeneric(`Tuple<${text.slice(1, -1)}>`);
        if (!tuple || position >= tuple.args.length) return null;
        text = tuple.args[position];
    }
    return text;
}

/** Preserve the payload of a proven standard Result/Option annotation.
 * Generic arguments retain their own declaration scope through alias hops;
 * a project type merely named Result is not a standard wrapper.
 */
function rustWrapperContract(index, text, file, options) {
    const expression = parseGeneric(text);
    if (!expression) return null;
    const seen = new Set();
    const chain = [];
    const resolve = (head, args, context) => {
        const key = `${context}:${head}`;
        if (seen.has(key) || seen.size >= 12) return null;
        seen.add(key);
        const entry = index.files.get(context);
        if (!entry) return null;
        const standard = /^(?:std|core)::(?:result::Result|option::Option)$/.test(head);
        if (standard) {
            const root = head.split('::')[0];
            if ((index.symbols.get(root) || []).some(d => d.file === context) ||
                (entry.importBindings || []).some(b => (b.alias || b.name) === root)) return null;
            const kind = head.split('::').at(-1);
            if (args.length !== (kind === 'Result' ? 2 : 1)) return null;
            chain.push({ standard: head, fromFile: entry.relativePath,
                rootDeclarations: [], rootBindings: [] });
            return { kind, item: args[0] };
        }
        if (head.includes('::')) {
            const parts = head.split('::');
            const name = parts.pop();
            const prefix = parts.join('::');
            const relative = entry.moduleResolved?.[prefix];
            const destination = relative ? path.resolve(index.root, relative)
                : resolveRustImport(prefix, context, index.root);
            if (!destination || !index.files.has(destination)) return null;
            chain.push({ fromFile: entry.relativePath, typePath: head,
                toFile: path.relative(index.root, destination) });
            return resolve(name, args, destination);
        }
        const local = (index.symbols.get(head) || []).filter(d =>
            d.file === context && TYPE_KINDS.has(d.type));
        if (local.length) {
            if (local.length !== 1) return null;
            const alias = local[0];
            if (alias.type !== 'type' || !alias.aliasTypeText ||
                !alias.aliasTypeParameters?.every(Boolean) ||
                alias.aliasTypeParameters.length < args.length) return null;
            const body = parseGeneric(alias.aliasTypeText);
            if (!body) return null;
            const parameters = new Map();
            for (const [i, name] of alias.aliasTypeParameters.entries()) {
                const fallback = alias.aliasTypeDefaults?.[i];
                const value = args[i] || (fallback && (parameters.get(fallback) || { text: fallback, file: context }));
                if (!value || (!args[i] && !parameters.has(fallback) &&
                    fallback.split(/[^\w]+/).some(token => parameters.has(token)))) return null;
                parameters.set(name, value);
            }
            const forwarded = body.args.map(text => parameters.get(text) || { text, file: context });
            // Nested generic substitution needs its own type-expression model.
            // Do not resolve an unsubstituted parameter in the alias's scope.
            if (body.args.some(text => !parameters.has(text) &&
                text.split(/[^\w]+/).some(token => parameters.has(token)))) return null;
            chain.push({ declaration: declarationIdentity(alias), type: alias.aliasTypeText,
                parameters: alias.aliasTypeParameters, defaults: alias.aliasTypeDefaults,
                arguments: args.map(argument => ({ text: argument.text, file: path.relative(index.root, argument.file) })) });
            return resolve(body.head, forwarded, context);
        }
        const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === head);
        if (bindings.length) {
            if (bindings.length !== 1) return null;
            const binding = bindings[0];
            const destination = entry.moduleResolved?.[binding.module];
            chain.push({ fromFile: entry.relativePath, binding: { ...binding }, toFile: destination || null });
            return destination
                ? resolve(binding.module.split('::').at(-1), args, path.resolve(index.root, destination))
                : resolve(binding.module, args, context);
        }
        if (head === 'Result' || head === 'Option') {
            if ((entry.importBindings || []).some(b => b.name === '*' || b.module?.endsWith('::*'))) return null;
            chain.push({ prelude: head, fromFile: entry.relativePath,
                declarations: [], bindings: [], wildcardImports: [] });
            return resolve(head === 'Result' ? 'std::result::Result' : 'std::option::Option', args, context);
        }
        return null;
    };
    const resolved = resolve(expression.head, expression.args.map(text => ({ text, file })), file);
    if (!resolved) return null;
    const wrapper = { kind: resolved.kind, annotation: { text, file: path.relative(index.root, file) }, chain };
    const projection = options.projection || [];
    const projected = projectTuple(resolved.item.text, projection);
    const item = projected && options.parseType(projected);
    if (!item) return options.allowUnknownPayload ? wrapper : null;
    const origin = options.resolveType(resolved.item.file, item.name, item.qualifier);
    const declarations = origin?.fromFile && (index.symbols.get(item.name) || []).filter(d =>
        d.file === origin.fromFile && TYPE_KINDS.has(d.type));
    if (declarations?.length !== 1) return options.allowUnknownPayload ? wrapper : null;
    return { kind: resolved.kind, type: item.name, fromFile: origin.fromFile,
        payload: { text: resolved.item.text, file: path.relative(index.root, resolved.item.file),
            ...(projection.length && { projection, projected }),
            declaration: declarationIdentity(declarations[0]) },
        annotation: { text, file: path.relative(index.root, file) }, chain };
}

/** Replay the type arguments and scope hops without consulting the resolver. */
function validateRustWrapperContract(contract, ownershipOnly = false) {
    const initial = parseGeneric(contract?.annotation?.text);
    if (!initial || !contract.annotation.file || !Array.isArray(contract.chain) ||
        contract.chain.length > 24 || !identityKey(contract.producer) ||
        contract.producer.file !== contract.annotation.file ||
        contract.producer.returnType !== contract.annotation.text) return false;
    let head = initial.head, file = contract.annotation.file;
    let args = initial.args.map(text => ({ text, file }));
    const empty = value => Array.isArray(value) && value.length === 0;
    let standard;
    for (const hop of contract.chain) {
        if (standard) return false;
        if (hop.declaration) {
            if (!identityKey(hop.declaration) || hop.declaration.name !== head || hop.declaration.file !== file ||
                hop.declaration.kind !== 'type' || !Array.isArray(hop.parameters) ||
                !hop.parameters.every(name => typeof name === 'string' && name) ||
                hop.parameters.length < args.length ||
                JSON.stringify(hop.arguments) !== JSON.stringify(args)) return false;
            const body = parseGeneric(hop.type);
            if (!body) return false;
            const parameters = new Map();
            for (const [i, name] of hop.parameters.entries()) {
                const fallback = hop.defaults?.[i];
                const value = args[i] || (fallback && (parameters.get(fallback) || { text: fallback, file }));
                if (!value || (!args[i] && !parameters.has(fallback) &&
                    fallback.split(/[^\w]+/).some(token => parameters.has(token)))) return false;
                parameters.set(name, value);
            }
            if (body.args.some(text => !parameters.has(text) &&
                text.split(/[^\w]+/).some(token => parameters.has(token)))) return false;
            args = body.args.map(text => parameters.get(text) || { text, file });
            head = body.head;
        } else if (hop.binding) {
            if (hop.fromFile !== file || (hop.binding.alias || hop.binding.name) !== head ||
                typeof hop.binding.module !== 'string') return false;
            head = hop.toFile ? hop.binding.module.split('::').at(-1) : hop.binding.module;
            file = hop.toFile || file;
        } else if (hop.typePath) {
            if (hop.fromFile !== file || hop.typePath !== head || !hop.toFile) return false;
            head = head.split('::').at(-1);
            file = hop.toFile;
        } else if (hop.prelude) {
            if (hop.fromFile !== file || hop.prelude !== head || !['Result', 'Option'].includes(head) ||
                !empty(hop.declarations) || !empty(hop.bindings) || !empty(hop.wildcardImports)) return false;
            head = head === 'Result' ? 'std::result::Result' : 'std::option::Option';
        } else if (hop.standard) {
            if (hop.fromFile !== file || hop.standard !== head ||
                !/^(std|core)::(result::Result|option::Option)$/.test(head) ||
                !empty(hop.rootDeclarations) || !empty(hop.rootBindings)) return false;
            standard = head.split('::').at(-1);
        } else return false;
    }
    if (!standard || standard !== contract.kind || args.length !== (standard === 'Result' ? 2 : 1)) return false;
    if (ownershipOnly) return true;
    if (args[0].text !== contract.payload?.text || args[0].file !== contract.payload?.file) return false;
    const projected = projectTuple(args[0].text, contract.payload.projection || []);
    if (!projected || (contract.payload.projection?.length && contract.payload.projected !== projected)) return false;
    let payloadHead = projected.replace(/^&(?:\s*'\w+)?\s*/, '').replace(/^mut\s+/, '').trim();
    payloadHead = (parseGeneric(payloadHead)?.head || payloadHead).split('::').at(-1);
    if (payloadHead === 'Self') payloadHead = contract.producer.className;
    return payloadHead === contract.type && identityKey(contract.payload.declaration) !== null &&
        contract.payload.declaration?.name === contract.type &&
        TYPE_KINDS.has(contract.payload.declaration?.kind);
}

module.exports = { rustWrapperContract, validateRustWrapperContract };
