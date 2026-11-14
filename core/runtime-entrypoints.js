'use strict';

const fs = require('fs');
const path = require('path');
const { pythonPossibleIdentities, pythonBoundValue, pythonSourceName } = require('./python-binding-identity');
const { entrypointToml } = require('./entrypoint-toml');
const OP_ENTRIES = new WeakMap();

/** A runtime module/member path names this declaration, including src layouts. */
function runtimeTargetReaches(index, symbol, target) {
    const spelling = target.replace(':', '.').split('[')[0].trim();
    const relative = path.relative(index.root, symbol.file).split(path.sep).join('/');
    if (!relative.endsWith('.py')) return false;
    const module = relative.slice(0, -3).replace(/\/__init__$/, '').replaceAll('/', '.');
    const mangle = (name, owner) => owner && name.startsWith('__') && !name.endsWith('__') && owner.replace(/^_+/, '')
        ? `_${owner.replace(/^_+/, '')}${name}` : name;
    let owners = symbol.runtimeOwnerPath;
    let unknownOwner = false;
    if (!Array.isArray(owners)) {
        // Old/external records may omit nesting. Reconstruct only from a unique
        // owner; when that owner is absent, preserve the possible suffix.
        const candidates = (index.symbols.get(symbol.className) || []).filter(def => def.file === symbol.file && def.type === 'class');
        if (symbol.className && candidates.length === 1) owners = [...(candidates[0].runtimeOwnerPath || []), symbol.className];
        else { owners = symbol.className ? [symbol.className] : []; unknownOwner = !!symbol.className; }
    }
    const normalizedOwners = owners.map(pythonSourceName);
    const member = [...normalizedOwners.map((name, position) => mangle(name, normalizedOwners[position - 1])),
        mangle(pythonSourceName(symbol.name), normalizedOwners[normalizedOwners.length - 1])].join('.');
    if (unknownOwner && spelling.endsWith(`.${mangle(pythonSourceName(symbol.name), pythonSourceName(symbol.className))}`)) {
        const parts = module.split('.');
        if (parts.some((_, position) => spelling.startsWith(`${parts.slice(position).join('.')}.`))) return true;
    }
    if (!spelling.endsWith(`.${member}`)) return false;
    const namedModule = spelling.slice(0, -(member.length + 1));
    return module === namedModule || module.endsWith(`.${namedModule}`);
}

function literal(node) {
    node = pythonBoundValue(node);
    if (!node || node.type !== 'string' || node.namedChildren.some(child => child.type === 'interpolation')) return null;
    const raw = node.text;
    const match = /^([rub]*)("""|'''|"|')([\s\S]*)\2$/i.exec(raw);
    if (!match) return null;
    if (/r/i.test(match[1])) return match[3];
    let valid = true;
    const value = match[3].replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/g, (whole, escape) => {
        if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
        if (/^[uUx]/.test(escape)) {
            const code = parseInt(escape.slice(1), 16);
            if (code <= 0x10ffff) return String.fromCodePoint(code);
            valid = false; return '';
        }
        const simple = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\', '\n': '' };
        if (Object.hasOwn(simple, escape)) return simple[escape];
        valid = false; return whole;
    });
    return valid ? value : null;
}

function targetOf(value) {
    const candidate = value.includes('=') ? value.slice(value.lastIndexOf('=') + 1).trim() : value.trim();
    return /^[\p{L}_][\p{L}\p{N}_.]*\s*:\s*[\p{L}_][\p{L}\p{N}_.]*(?:\s*\[[^\]]*\])?$/u.test(candidate)
        ? candidate.replace(/\s/g, '') : null;
}

/** Static packaging declarations, read as data; setup.py is never executed. */
function runtimeEntrypoints(index) {
    const operation = index._opTreeCache;
    if (operation && OP_ENTRIES.has(operation)) return OP_ENTRIES.get(operation);
    const dirs = new Set();
    for (const [file, entry] of index.files) {
        if (entry.language !== 'python') continue;
        for (let dir = path.dirname(file); dir === index.root || dir.startsWith(`${index.root}${path.sep}`); dir = path.dirname(dir)) {
            dirs.add(dir);
            if (dir === index.root) break;
        }
    }
    const entries = [];
    const add = (value, file, line) => {
        const target = targetOf(value);
        entries.push(target ? { target, file, line } : { unknown: true, file, line });
    };
    for (const dir of [...dirs].sort()) {
        for (const basename of ['pyproject.toml', 'setup.cfg']) {
            const file = path.join(dir, basename);
            let source;
            try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
            if (basename === 'pyproject.toml') {
                for (const row of entrypointToml(source)) {
                    if (row.unknown) entries.push({ unknown: true, file, line: row.line });
                    else add(row.value, file, row.line);
                }
                continue;
            }
            let section = '';
            const lines = source.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                const header = /^\[([^\]]+)\]/.exec(line);
                if (header) { section = header[1]; continue; }
                if (section === 'options.entry_points' && line && !line.startsWith('#') && !line.startsWith(';') &&
                    !/^[\w.-]+\s*=\s*$/.test(line)) add(line, file, i + 1);
            }
        }
        const setup = path.join(dir, 'setup.py');
        if (!index.files.has(setup)) continue;
        let tree;
        try { tree = index._getParsedTree(setup, index._readFile(setup), 'python'); } catch { continue; }
        for (const call of tree.rootNode.descendantsOfType('call')) {
            if (!pythonPossibleIdentities(call.childForFieldName('function')).some(name => ['setuptools.setup', 'distutils.core.setup'].includes(name))) continue;
            const unknown = () => entries.push({ unknown: true, file: setup, line: call.startPosition.row + 1 });
            const values = [];
            const expanded = (node, depth = 0) => {
                const value = pythonBoundValue(node);
                if (depth > 8 || value?.type !== 'dictionary') { unknown(); return; }
                for (const pair of value.namedChildren) {
                    if (pair.type === 'dictionary_splat') { expanded(pair.namedChild(0), depth + 1); continue; }
                    if (pair.type !== 'pair') { unknown(); continue; }
                    const key = literal(pair.childForFieldName('key'));
                    if (key == null) unknown();
                    else if (key === 'entry_points') values.push(pair.childForFieldName('value'));
                }
            };
            for (const argument of call.childForFieldName('arguments')?.namedChildren || []) {
                if (argument.type === 'keyword_argument' && pythonSourceName(argument.childForFieldName('name')?.text) === 'entry_points') values.push(argument.childForFieldName('value'));
                else if (argument.type === 'dictionary_splat') expanded(argument.namedChild(0));
            }
            for (const expression of values) {
                const value = pythonBoundValue(expression);
                if (value?.type === 'none') continue;
                // setuptools also accepts an INI string as entry_points.
                const ini = literal(value);
                if (ini != null) {
                    for (const line of ini.split('\n')) {
                        const row = line.trim();
                        if (row && !row.startsWith('[') && !row.startsWith('#')) add(row, setup, call.startPosition.row + 1);
                    }
                    continue;
                }
                if (value?.type !== 'dictionary') { unknown(); continue; }
                for (const pair of value.namedChildren) {
                    if (pair.type !== 'pair' || literal(pair.childForFieldName('key')) == null) { unknown(); continue; }
                    const group = pythonBoundValue(pair.childForFieldName('value'));
                    const rows = ['list', 'tuple'].includes(group?.type) ? group.namedChildren : [group];
                    for (const row of rows) {
                        const text = literal(row);
                        if (text != null) {
                            for (const line of text.split('\n').filter(line => line.trim())) add(line, setup, row.startPosition.row + 1);
                        } else unknown();
                    }
                }
            }
        }
    }
    if (operation) OP_ENTRIES.set(operation, entries);
    return entries;
}

module.exports = { runtimeEntrypoints, runtimeTargetReaches, pythonStringLiteral: literal };
