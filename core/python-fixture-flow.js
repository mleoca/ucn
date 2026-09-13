'use strict';

const path = require('path');
const { declarationIdentity, identityKey, sameDeclaration } = require('./provenance');
const { getLanguageAdapter, getParser } = require('../languages');

const metadata = new WeakMap();
const moduleMetadata = new WeakMap();

function moduleEvidence(index, file) {
    const entry = index.files.get(file);
    if (entry?.language !== 'python') return null;
    const cached = moduleMetadata.get(entry);
    if (cached?.hash === entry.hash) return cached.value;
    const value = getLanguageAdapter('python').findPythonModuleEvidence(index._readFile(file), getParser('python'));
    moduleMetadata.set(entry, { hash: entry.hash, value });
    return value;
}

/** Wildcard hops require a closed literal __all__ on every competing source. */
function pythonFixtureType(index, file, name, accepts, seen = new Set()) {
    const key = `${file}\0${name}`;
    if (seen.has(key) || seen.size >= 8) return null;
    const visited = new Set(seen).add(key), entry = index.files.get(file);
    if (!entry || (entry.moduleAssignedNames || []).includes(name)) return null;
    const direct = require('./provenance-facts').namedDeclaration(index, file, name, accepts);
    if (direct) return direct;
    const parts = name.split('.');
    if (parts.length === 2) {
        const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === parts[0]);
        if (bindings.length !== 1 || (index.symbols.get(parts[0]) || []).some(d => d.file === file)) return null;
        const binding = bindings[0], relative = entry.moduleResolved?.[binding.module];
        const next = relative && pythonFixtureType(index, path.resolve(index.root, relative), parts[1], accepts, visited);
        return next ? { declaration: next.declaration, chain: [{ fromFile: entry.relativePath, toFile: relative,
            localName: name, importedName: parts[1], module: binding.module,
            ...(!next.chain.length && { declaration: declarationIdentity(next.declaration) }) }, ...next.chain] } : null;
    }
    if (parts.length !== 1 || (entry.importBindings || []).some(b => (b.alias || b.name) === name) ||
        (index.symbols.get(name) || []).some(d => d.file === file)) return null;
    const wildcards = moduleEvidence(index, file)?.wildcards;
    if (!wildcards?.length || wildcards.some(b => !b.topLevel || !b.module)) return null;
    const sources = [];
    for (const binding of wildcards) {
        const relative = entry.moduleResolved?.[binding.module];
        const evidence = relative && moduleEvidence(index, path.resolve(index.root, relative));
        if (!evidence?.exports) return null;
        sources.push({ binding, file: relative, exports: evidence.exports });
    }
    const candidates = sources.filter(s => s.exports.literals.some(literal => literal.value === name));
    if (candidates.length !== 1) return null;
    const selected = candidates[0], next = pythonFixtureType(index, path.resolve(index.root, selected.file), name, accepts, visited);
    return next ? { declaration: next.declaration, chain: [{ fromFile: entry.relativePath, toFile: selected.file,
        localName: name, importedName: name, module: selected.binding.module, wildcards: sources,
        ...(!next.chain.length && { declaration: declarationIdentity(next.declaration) }) }, ...next.chain] } : null;
}

function functionsIn(index, file) {
    const entry = index.files.get(file);
    if (entry?.language !== 'python') return [];
    const cached = metadata.get(entry);
    if (cached?.hash === entry.hash) return cached.functions;
    const functions = getLanguageAdapter('python').findPytestFunctions(index._readFile(file), getParser('python'));
    metadata.set(entry, { hash: entry.hash, functions });
    return functions;
}

function importedPath(index, file, parts, module, member) {
    if (!parts?.length) return null;
    const entry = index.files.get(file);
    if ((entry.moduleAssignedNames || []).includes(parts[0]) ||
        (index.symbols.get(parts[0]) || []).some(d => d.file === file)) return null;
    const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === parts[0]);
    if (bindings.length !== 1) return null;
    const binding = bindings[0];
    const resolved = binding.kind === 'from' || binding.kind === 'from-import'
        ? [binding.module, binding.name, ...parts.slice(1)].join('.')
        : [binding.module, ...parts.slice(1)].join('.');
    if (resolved !== `${module}.${member}` || entry.moduleResolved?.[binding.module]) return null;
    return { ...binding };
}

/** Resolve only the conventional, undecorated module test's unchanged
 * parameter. The nearest explicit fixture overrides parent conftest files;
 * parametrized tests, dynamic fixture names and undecidable imports abstain.
 */
function pythonFixtureReceiver(index, file, call, options) {
    const receiver = call.receiver || call.receiverRoot;
    if (!receiver || call.receiverType || call.receiverRootType ||
        call.receiverFlowInvalidated || !/^test_.*\.py$|^.*_test\.py$/.test(path.basename(file))) return null;
    const test = functionsIn(index, file).find(fn => fn.name.startsWith('test_') &&
        fn.startLine <= call.line && fn.endLine >= call.line && !fn.async && !fn.decorators.length);
    const parameter = test?.parameters.find(p => p.name === receiver && p.unchanged);
    if (!parameter || call.enclosingFunction?.name !== test.name) return null;
    const sources = [file];
    for (let dir = path.dirname(file); dir === index.root || dir.startsWith(index.root + path.sep); dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'conftest.py');
        if (candidate !== file && index.files.has(candidate)) sources.push(candidate);
        if (dir === index.root) break;
    }
    for (const source of sources) {
        const entry = index.files.get(source);
        if ((entry?.moduleAssignedNames || []).includes(receiver) ||
            (entry?.importBindings || []).some(b => (b.alias || b.name) === receiver || b.name === '*')) return null;
        const candidates = functionsIn(index, source).filter(fn => fn.decorators.length &&
            (fn.name === receiver || fn.decorators.some(d => d.alias === receiver || d.dynamicName)));
        if (!candidates.length) continue;
        if (candidates.length !== 1) return null;
        const fixture = candidates[0];
        if (fixture.async || fixture.decorators.length !== 1 || !fixture.valuePath) return null;
        const decorator = fixture.decorators[0];
        const binding = !decorator.dynamicName && importedPath(index, source, decorator.path, 'pytest', 'fixture');
        if (!binding || (decorator.alias || fixture.name) !== receiver || !options.externalModule(source, binding.module)) return null;
        let iteratorBinding;
        if (fixture.yields) {
            const container = fixture.container?.at(-1);
            if (!['Iterator', 'Generator'].includes(container)) return null;
            iteratorBinding = importedPath(index, source, fixture.container, 'typing', container) ||
                importedPath(index, source, fixture.container, 'collections.abc', container);
            if (!iteratorBinding || !options.externalModule(source, iteratorBinding.module)) return null;
        }
        const parts = [...fixture.valuePath], type = parts.pop();
        const root = options.resolveType(source, type, parts.join('.') || undefined);
        if (!root?.declaration) return null;
        const definition = (index.symbols.get(fixture.name) || []).find(d => d.file === source &&
            d.startLine === fixture.startLine && d.endLine === fixture.endLine && !d.className);
        const testDefinition = (index.symbols.get(test.name) || []).find(d => d.file === file &&
            d.startLine === test.startLine && d.endLine === test.endLine && !d.className);
        if (!definition || !testDefinition) return null;
        const proof = { parameter: { ...parameter, test: declarationIdentity(testDefinition) },
            fixture: { ...declarationIdentity(definition), returnType: fixture.returnType },
            decorator: { ...decorator, binding }, iteratorBinding: iteratorBinding || null,
            yields: fixture.yields, container: fixture.container || null, returnOrigin: fixture.returnOrigin,
            valuePath: fixture.valuePath, value: declarationIdentity(root.declaration),
            valueImportChain: root.chain || [], searchFiles: sources.slice(0, sources.indexOf(source) + 1)
                .map(f => path.relative(index.root, f)), fields: [] };
        let result = { type, fromFile: root.declaration.file };
        for (const field of call.receiverRoot ? (call.receiverFields || [call.receiverField]) : []) {
            const next = options.field(result.type, result.fromFile, field);
            if (!next) return null;
            proof.fields.push(next.fact);
            result = { type: next.type, fromFile: next.fromFile };
        }
        return { ...result, fixtureBinding: proof };
    }
    return null;
}

/** Replay fixture selection, annotation binding and every declared property hop.
 * A framework label alone cannot establish the value supplied to a parameter.
 */
function validatePythonFixtureBinding(proof, facts) {
    const empty = value => Array.isArray(value) && !value.length;
    const span = origin => Number.isInteger(origin?.start) && Number.isInteger(origin?.end) && origin.end > origin.start;
    const bindingPath = (binding, parts) => {
        if (!binding || !parts?.length || (binding.alias || binding.name) !== parts[0]) return null;
        return ['from', 'from-import'].includes(binding.kind)
            ? [binding.module, binding.name, ...parts.slice(1)].join('.')
            : [binding.module, ...parts.slice(1)].join('.');
    };
    const typed = (file, name, declaration, chain) => {
        if (!identityKey(declaration) || !Array.isArray(chain)) return false;
        if (!chain.length) return declaration.file === file && declaration.name === name;
        return chain[0].fromFile === file && chain[0].localName === name &&
            require('./provenance').validateConfirmation({ facts: { importChain: chain } }, declaration)
                .verdict === 'establishes-target';
    };
    if (facts.language !== 'python' || facts.receiverTypeSource !== 'fixture' ||
        !proof || !identityKey(proof.fixture) || !identityKey(proof.parameter?.test)) return false;
    const { parameter, fixture, decorator, searchFiles } = proof;
    if (!parameter.unchanged || !span(parameter.origin) || !parameter.name ||
        !Array.isArray(facts.receiverPath) || facts.receiverPath[0] !== parameter.name ||
        !Array.isArray(proof.fields) || proof.fields.length !== facts.receiverPath.length - 1 ||
        proof.fields.some((field, i) => field.member?.name !== facts.receiverPath[i + 1]) ||
        parameter.test.file !== facts.site?.file || !parameter.test.name.startsWith('test_') ||
        parameter.test.className || fixture.className || facts.site.line < parameter.test.startLine ||
        facts.site.line > parameter.test.endLine || !span(decorator?.origin) || decorator.dynamicName ||
        (decorator.alias || fixture.name) !== parameter.name ||
        bindingPath(decorator.binding, decorator.path) !== 'pytest.fixture' ||
        !span(proof.returnOrigin) || !Array.isArray(searchFiles) || !searchFiles.length ||
        searchFiles[0] !== parameter.test.file || searchFiles.at(-1) !== fixture.file ||
        !proof.valuePath?.length) return false;
    let dir = path.posix.dirname(parameter.test.file);
    for (const file of searchFiles.slice(1)) {
        const next = path.posix.dirname(file);
        if (path.posix.basename(file) !== 'conftest.py' ||
            !(next === dir || next === '.' || dir.startsWith(next + '/'))) return false;
        dir = next;
    }
    const valueName = proof.valuePath.join('.');
    if (proof.yields) {
        const container = proof.container?.at(-1);
        const qualified = bindingPath(proof.iteratorBinding, proof.container);
        if (!['Iterator', 'Generator'].includes(container) ||
            ![`typing.${container}`, `collections.abc.${container}`].includes(qualified) ||
            fixture.returnType.replace(/\s/g, '') !== `${proof.container.join('.')}[${valueName}${
                container === 'Generator' ? ',None,None' : ''}]`) return false;
    } else if (proof.iteratorBinding || proof.container || fixture.returnType !== valueName) return false;
    if (!typed(fixture.file, valueName, proof.value, proof.valueImportChain)) return false;
    let previous = proof.value;
    for (const field of proof.fields || []) {
        if (!sameDeclaration(field.owner, previous) || !identityKey(field.member) ||
            field.member.file !== previous.file || field.member.className !== previous.name ||
            !['property', 'getter', 'field'].includes(field.member.kind) || !field.annotation) return false;
        if (field.result?.builtin) {
            if (field.annotation !== field.result.builtin || field.result.language !== 'python' ||
                !require('./receiver-types').isProvenanceBuiltinReceiver(field.result.builtin, 'python') ||
                !empty(field.builtinShadowDeclarations) || !empty(field.builtinShadowBindings)) return false;
        } else if (!typed(field.member.file, field.annotation, field.result, field.importChain)) return false;
        previous = field.result;
    }
    return previous.builtin ? previous.builtin === facts.receiverType
        : previous.file === facts.receiverTypeFlowFile &&
            sameDeclaration(previous, facts.receiverTypeDeclaration || facts.receiverResolvedIn);
}

module.exports = { pythonFixtureReceiver, pythonFixtureType, validatePythonFixtureBinding };
