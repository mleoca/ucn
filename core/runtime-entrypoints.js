'use strict';

const fs = require('fs');
const path = require('path');
const { pythonPossibleIdentities, pythonBoundValue, pythonSourceName } = require('./python-binding-identity');
const { entrypointToml } = require('./entrypoint-toml');
const OP_ENTRIES = new WeakMap();

/**
 * A runtime module/member path names this declaration, including src
 * layouts. A target that ends with `:` names a module and no attribute: the
 * runtime imports the module and hands the module object over, and its
 * consumer may look up any name in it, so it reaches every declaration that
 * module holds (a package's `__init__`, never a submodule). An exact path
 * that does not spell the declaration where it is declared is also read the
 * way the runtime looks it up (fix #512): through the names a module
 * imports (`pkg.Klass` re-exported from `pkg/core.py`, a star import) and a
 * class's ancestors (`pkg.core.Child.run` finds `Base.run`).
 */
function runtimeTargetReaches(index, symbol, target) {
    if (spelledReaches(index, symbol, target)) return true;
    const spelling = target.replace(':', '.').split('[')[0].trim();
    if (target.endsWith(':') || spelling.includes('*') || !String(symbol.file).endsWith('.py')) return false;
    return terminalsReach(index, targetTerminals(index, spelling), symbol);
}

/** The declaration's own path spells the target (module path suffixes, globs). */
function spelledReaches(index, symbol, target) {
    const relative = path.relative(index.root, symbol.file).split(path.sep).join('/');
    if (!relative.endsWith('.py')) return false;
    const module = relative.slice(0, -3).replace(/\/__init__$/, '').replaceAll('/', '.');
    if (target.endsWith(':')) {
        const named = target.slice(0, -1);
        return module === named || module.endsWith(`.${named}`);
    }
    const spelling = target.replace(':', '.').split('[')[0].trim();
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
    if (spelling.includes('*')) {
        // A path with a runtime part (`*.name`, `pkg.*.Owner.name`): reached
        // when the glob spells this declaration under one of the module
        // paths it can be imported by. A dot never occurs in an identifier,
        // so a written `*` is only ever the runtime part.
        const { globMatches } = require('./reflection');
        const parts = module.split('.');
        const paths = parts.map((_, position) => parts.slice(position).join('.'));
        // An owner that cannot be placed keeps every path its member may have.
        if (unknownOwner) {
            return globMatches(spelling.slice(spelling.lastIndexOf('.') + 1),
                mangle(pythonSourceName(symbol.name), pythonSourceName(symbol.className)));
        }
        return paths.some(prefix => globMatches(spelling, `${prefix}.${member}`));
    }
    if (unknownOwner && spelling.endsWith(`.${mangle(pythonSourceName(symbol.name), pythonSourceName(symbol.className))}`)) {
        const parts = module.split('.');
        if (parts.some((_, position) => spelling.startsWith(`${parts.slice(position).join('.')}.`))) return true;
    }
    if (!spelling.endsWith(`.${member}`)) return false;
    const namedModule = spelling.slice(0, -(member.length + 1));
    return module === namedModule || module.endsWith(`.${namedModule}`);
}

/**
 * Python module files by dotted module path: a file is named by its path
 * from the root and by every shorter suffix of it (src layouts, roots added
 * to sys.path), as runtimeTargetReaches matches. One map per index, kept
 * with the reflection pattern index and dropped with it.
 */
function moduleFiles(index, dotted) {
    const pidx = require('./reflection').reflectionPatternIndex(index);
    if (!pidx.moduleFiles) {
        const map = new Map();
        for (const file of index.files.keys()) {
            const relative = path.relative(index.root, file).split(path.sep).join('/');
            if (!relative.endsWith('.py')) continue;
            const parts = relative.slice(0, -3).replace(/(^|\/)__init__$/, '').split('/').filter(Boolean);
            for (let start = 0; start < parts.length; start++) {
                const key = parts.slice(start).map(pythonSourceName).join('.');
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(file);
            }
        }
        for (const files of map.values()) files.sort();
        pidx.moduleFiles = map;
    }
    return pidx.moduleFiles.get(dotted) || [];
}

/**
 * The files an import of `module` in `entry` can load: its own resolution
 * and every project module the absolute path can name (the interpreter's
 * search path decides which, so both are kept). [] is a module outside the
 * project; null is one this reader cannot place (an unresolved relative
 * import).
 */
function importedFiles(index, entry, module) {
    const resolved = (entry.moduleResolved || {})[module];
    const own = resolved ? [path.join(index.root, resolved)] : [];
    if (!module || module.startsWith('.')) return resolved ? own : null;
    return modulesNamed(index, module, own);
}

/**
 * The project modules an absolute module path can name, with `own` (a
 * resolution already made). [] only when no tail of the path names a project
 * module either: a project whose root is itself a package is imported as
 * `pkg.mod` while its files are `mod.py`, so such a path is not shown to be
 * outside and is answered null (by the member's name).
 */
function modulesNamed(index, module, own = []) {
    const files = [...new Set([...own, ...moduleFiles(index, module)])].sort();
    if (files.length > 0) return files;
    const parts = module.split('.');
    for (let start = 1; start < parts.length; start++) {
        if (moduleFiles(index, parts.slice(start).join('.')).length > 0) return null;
    }
    return [];
}

const MAX_PATH_HOPS = 6;

/**
 * Where an attribute path read from a module ends: the declarations a
 * runtime lookup of `chain` in `file` can find (fix #512). Each terminal is
 * { file, owners, member }: `member` of the class path `owners` (empty: a
 * top-level name) as declared in `file`, a class member also looked up in
 * the class's ancestors; or { any, member } where the reader cannot follow
 * the module (a `__getattr__`, a star import it cannot place, too many
 * hops): only the member's name is known. Imports a module binds (named,
 * aliased, star) and a package's submodules are followed.
 */
function pathTerminals(index, file, chain, depth = 0, out = [], seen = new Set()) {
    if (chain.length === 0) return out;
    const key = `${file}\0${chain.join('.')}`;
    if (seen.has(key)) return out;
    seen.add(key);
    const member = chain[chain.length - 1];
    const entry = index.files.get(file);
    if (!entry || depth > MAX_PATH_HOPS) { out.push({ any: true, member }); return out; }
    const [head, ...rest] = chain;
    out.push({ file, owners: chain.slice(0, -1), member });
    // A segment that names a value (a module variable, a function, a class
    // attribute that is no nested class) holds an object this reader does
    // not follow: decided by the member's name.
    if (rest.length > 0) {
        const declared = (index.symbols.get(head) || []).filter(def => def.file === file && !def.className);
        if (declared.some(def => def.type !== 'class')) out.push({ any: true, member });
        else if (declared.length > 0) {
            let owner = head;
            for (const segment of rest.slice(0, -1)) {
                if (!(index.symbols.get(segment) || []).some(def => def.file === file && def.className === owner && def.type === 'class')) {
                    out.push({ any: true, member });
                    break;
                }
                owner = segment;
            }
        }
    }
    for (const binding of entry.importBindings || []) {
        if ((binding.alias || binding.name) !== head) continue;
        if (binding.kind === 'import') {
            // `import a.b as m` binds the module a.b; `import a.b` binds a.
            const module = binding.module.split('.')[0] === binding.name && !binding.alias
                ? binding.name : binding.module;
            const files = importedFiles(index, entry, module);
            if (files === null) { out.push({ any: true, member }); continue; }
            for (const target of files) pathTerminals(index, target, rest, depth + 1, out, seen);
            continue;
        }
        if (binding.kind !== 'from' && binding.kind !== 'relative') continue;
        const files = importedFiles(index, entry, binding.module);
        if (files === null) { out.push({ any: true, member }); continue; }
        // `from pkg import sub` may name a submodule of the package.
        const spelled = String(binding.module || '');
        const submodule = importedFiles(index, entry, spelled.endsWith('.') ? spelled + binding.name : `${spelled}.${binding.name}`);
        for (const target of submodule || []) pathTerminals(index, target, rest, depth + 1, out, seen);
        for (const target of files) pathTerminals(index, target, [binding.name, ...rest], depth + 1, out, seen);
    }
    for (const detail of entry.importDetails || []) {
        if (!(detail.names || []).includes('*')) continue;
        const files = importedFiles(index, entry, detail.module);
        if (files === null) { out.push({ any: true, member }); continue; }
        for (const target of files) pathTerminals(index, target, chain, depth + 1, out, seen);
    }
    // A package's submodule is an attribute of the package once imported.
    const relative = path.relative(index.root, file).split(path.sep).join('/');
    if (/(^|\/)__init__\.py$/.test(relative) && rest.length > 0) {
        const dir = path.dirname(file);
        for (const candidate of [path.join(dir, `${head}.py`), path.join(dir, head, '__init__.py')]) {
            if (index.files.has(candidate)) pathTerminals(index, candidate, rest, depth + 1, out, seen);
        }
    }
    // A module `__getattr__` answers any name.
    if ((index.symbols.get('__getattr__') || []).some(def => def.file === file && !def.className)) {
        out.push({ any: true, member });
    }
    return out;
}

/** Does one of `terminals` name this declaration (a member through its class's descendants too)? */
function terminalsReach(index, terminals, symbol) {
    const { globMatches } = require('./reflection');
    const owners = (Array.isArray(symbol.runtimeOwnerPath) ? symbol.runtimeOwnerPath
        : symbol.className ? [symbol.className] : []).map(pythonSourceName);
    const name = pythonSourceName(symbol.name);
    const spelled = mangle(name, owners[owners.length - 1]);
    for (const terminal of terminals) {
        if (!globMatches(terminal.member, spelled) && !globMatches(terminal.member, name)) continue;
        if (terminal.any) return true;
        if (terminal.file === symbol.file && terminal.owners.length === owners.length &&
            terminal.owners.every((owner, position) => owner === owners[position])) return true;
        // A class attribute is found on the class or an ancestor.
        if (terminal.owners.length === 1 && owners.length > 0 &&
            require('./reflection').classOrAncestorDeclares(index, terminal.file, terminal.owners[0], symbol, terminal.line)) return true;
    }
    return false;
}

function mangle(name, owner) {
    return owner && name.startsWith('__') && !name.endsWith('__') && owner.replace(/^_+/, '')
        ? `_${owner.replace(/^_+/, '')}${name}` : name;
}

/**
 * Does the object a patch call names its member on (`site.owner`, from
 * pythonPatchOwner) hold this declaration as that member (fix #512)? A
 * module holds its top-level names and what it imports; a class (or an
 * instance of it) its members and its ancestors' members. A module outside
 * the project holds no project declaration; an owner this reader cannot
 * follow is decided by the member's name alone.
 */
function ownerReaches(index, entry, symbol) {
    if (!String(symbol.file).endsWith('.py')) return false;
    const site = entry.site;
    const member = site.open || !entry.pattern || entry.pattern.includes('*') ? '*' : entry.pattern;
    const pidx = require('./reflection').reflectionPatternIndex(index);
    if (!pidx.ownerTerminals) pidx.ownerTerminals = new Map();
    let byMember = pidx.ownerTerminals.get(site);
    if (!byMember) pidx.ownerTerminals.set(site, byMember = new Map());
    let terminals = byMember.get(member);
    if (!terminals) byMember.set(member, terminals = ownerTerminals(index, entry, member));
    return terminalsReach(index, terminals, symbol);
}

function ownerTerminals(index, entry, member) {
    const owner = entry.site.owner;
    const tail = [...(owner.path || []), member];
    const unknown = [{ any: true, member }];
    if (owner.local) {
        return tail.length === 1 ? [{ file: entry.file, owners: [owner.local], member, line: owner.line }] : unknown;
    }
    const starts = [];
    if (owner.module) {
        const files = modulesNamed(index, owner.module);
        if (files === null) return unknown;
        for (const file of files) starts.push([file, tail]);
    } else if (owner.import) {
        const fileEntry = index.files.get(entry.file);
        const { module, name } = owner.import;
        const files = fileEntry ? importedFiles(index, fileEntry, module) : null;
        if (files === null) return unknown;
        if (name) {
            // `from pkg import sub` may name a submodule of the package.
            const spelled = String(module);
            for (const file of importedFiles(index, fileEntry, spelled.endsWith('.') ? spelled + name : `${spelled}.${name}`) || []) {
                starts.push([file, tail]);
            }
            for (const file of files) starts.push([file, [name, ...tail]]);
        } else for (const file of files) starts.push([file, tail]);
    } else return unknown;
    const out = [];
    const seen = new Set();
    for (const [file, chain] of starts) pathTerminals(index, file, chain, 0, out, seen);
    return out;
}

/** The terminals of an exact runtime path string, through every module a prefix of it can name. */
function targetTerminals(index, spelling) {
    const pidx = require('./reflection').reflectionPatternIndex(index);
    if (!pidx.targetTerminals) pidx.targetTerminals = new Map();
    let terminals = pidx.targetTerminals.get(spelling);
    if (terminals) return terminals;
    terminals = [];
    const parts = spelling.split('.');
    let placed = false;
    for (let split = 1; split < parts.length; split++) {
        for (const file of moduleFiles(index, parts.slice(0, split).join('.'))) {
            placed = true;
            pathTerminals(index, file, parts.slice(split), 0, terminals);
        }
    }
    // A path no prefix of which names a project module, while a tail of a
    // prefix does (a root that is itself a package): decided by the name.
    if (!placed && parts.length > 2 && parts.slice(1, -1).some((_, start) =>
        moduleFiles(index, parts.slice(start + 1, -1).join('.')).length > 0)) {
        terminals.push({ any: true, member: parts[parts.length - 1] });
    }
    pidx.targetTerminals.set(spelling, terminals);
    return terminals;
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

/**
 * The target an entry point value names: `module:attribute` as written, or
 * `module:` for a module with no attribute (`runtimeTargetReaches`). Null
 * for a value that is neither: its target cannot be resolved.
 */
function targetOf(value) {
    const candidate = value.includes('=') ? value.slice(value.lastIndexOf('=') + 1).trim() : value.trim();
    if (/^[\p{L}_][\p{L}\p{N}_.]*\s*:\s*[\p{L}_][\p{L}\p{N}_.]*(?:\s*\[[^\]]*\])?$/u.test(candidate)) {
        return candidate.replace(/\s/g, '');
    }
    const module = /^([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)(?:\s*\[[^\]]*\])?$/u.exec(candidate);
    return module ? `${module[1]}:` : null;
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

module.exports = { runtimeEntrypoints, runtimeTargetReaches, ownerReaches, pythonStringLiteral: literal };
