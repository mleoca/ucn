'use strict';

/**
 * core/external-macros.js - C/C++ files read with the macro definitions of
 * the project (fix #396).
 *
 * A file is parsed on its own, so a decoration or statement macro defined in
 * another header (`SPDLOG_INLINE`, `JSON_INLINE_VARIABLE`, `LIB_TRY {`,
 * `ATTR(3)` before a member) is an unknown name to the recovery, and the
 * grammar's misreading can swallow a class body. The build reads the
 * `#define` directives of every C/C++ header of the project (a translation
 * unit's own definitions reach no other file; a parallel build reads them
 * while its workers parse, and a worker waits for the result only when a
 * file's recovery consults it) into a
 * dictionary of the names whose every definition reads alike: object-like
 * macros that expand to declaration specifiers (or nothing) or to a
 * removable statement fragment (`try`, a complete `catch` handler), and
 * function-like macros whose expansion reads as specifiers or a type. The
 * recovery of a file the grammar could not read consults it for names the
 * file does not define, exactly as it reads the file's own definitions, and
 * records the names it used (`externalMacroNames`).
 *
 * After the include graph is built, a file whose recovery used a name that no
 * file of its #include closure defines is read again without it (the
 * preprocessor never saw that definition), and every file records the
 * dictionary entries of the names its recovery used or could have used
 * (`externalMacroKey`), so a later build re-reads it when they change.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { langTraits, getParser, detectLanguage } = require('../languages');
const { codeUnitCompare } = require('./shared');
const { lexPP } = require('../languages/c-preprocessor');

// Translation-unit sources: what they define reaches no other file.
const TRANSLATION_UNIT_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.cp', '.m', '.mm']);

// Object-like replacement lists longer than this are declarations or
// statement blocks, never a decoration (the #362 bound).
const MAX_OBJECT_BODY_CHARS = 256;

/** Object-like `#define NAME body` directives of a file, continuations joined. */
function objectDefinitions(code) {
    const out = [];
    const directive = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_(])/gm;
    for (let match = directive.exec(code); match; match = directive.exec(code)) {
        let end = match.index + match[0].length;
        let body = '';
        for (;;) {
            const lineEnd = code.indexOf('\n', end);
            const line = code.slice(end, lineEnd < 0 ? code.length : lineEnd);
            const continued = /\\[ \t\r]*$/.test(line);
            body += ` ${continued ? line.replace(/\\[ \t\r]*$/, '') : line}`;
            if (!continued || lineEnd < 0) break;
            end = lineEnd + 1;
        }
        body = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ' ').replace(/\s+/g, ' ').trim();
        out.push({ name: match[1], body });
    }
    return out;
}

// A replacement list with each parameter replaced by a literal, pastes
// joined and stringizing made a string: what an invocation could expand to.
function substituteParams(template) {
    const params = new Set([...(template.params || []), '__VA_ARGS__']);
    const tokens = String(template.body || '').split(' ').filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '#' && params.has(tokens[i + 1])) {
            out.push('"0"');
            i++;
            continue;
        }
        if (token === '##') continue;
        out.push(params.has(token) ? '0' : token);
    }
    return out.join(' ');
}

// A replacement list that could read as declaration specifiers, a type, or
// a statement keyword: names, scopes, templates, attribute and declspec
// parentheses, pointers and references, but no statement or expression
// punctuation. Most macro bodies (numbers, strings, expressions, statement
// blocks) are set aside here without a probe parse (fix #396).
const NON_SPECIFIER_PUNCTUATION = new Set([';', '{', '}', '=', '?', '+', '-', '/', '%', '!', '|', '^', '~',
    '.', '->', '++', '--', '+=', '-=', '==', '!=', '&&', '||', '<<', '>>', '<=', '>=', '#', '##']);

function maySpecify(body) {
    const tokens = lexPP(body);
    if (tokens.length === 0) return true;
    const first = tokens[0];
    if (first.k !== 'id' && first.v !== '::' && first.v !== '[') return false;
    return !tokens.some(token => token.k === 'punct' && NON_SPECIFIER_PUNCTUATION.has(token.v));
}

// A replacement list that begins by invoking another project function-like
// macro (`#define CHECK(x) DOCTEST_CHECK(x)`) reads as whatever that macro
// expands to, which a probe of the unexpanded text cannot show: no reading,
// and no probe parse. Keywords and reserved identifiers (`__attribute__`,
// `_Alignas`, `decltype`) a project may redefine for another compiler keep
// their probe.
const KEYWORD_INTRODUCERS = new Set(['alignas', 'alignof', 'asm', 'decltype', 'noexcept', 'requires',
    'sizeof', 'static_assert', 'typeof']);
function leadsWithProjectMacro(body, perName) {
    const [first, second] = lexPP(body);
    if (!first || first.k !== 'id' || second?.v !== '(') return false;
    if (/^_[_A-Z]/.test(first.v) || KEYWORD_INTRODUCERS.has(first.v)) return false;
    return (perName.get(first.v)?.functions.size || 0) > 0;
}

// `catch (...) { }` / `try`: statement fragments are read by the probe
// even though they hold braces.
function mayBeStatementFragment(body) {
    return /^(?:try|catch|if)\b/.test(body.trim());
}

/**
 * The project's macro dictionary per language, or null: { key, byLanguage:
 * { c|cpp: { objectBodies: [[name, bodies]], functionMacros: [[name,
 * templates]] } } }. `files` are the files the build indexes.
 */
function projectMacroDictionary(index, files) {
    const { directiveFunctionMacros } = require('../languages/c-macro-invocations');
    const { objectMacroReading } = require('../languages/c-family');
    const perName = new Map(); // name -> { objects: Set<body>, functions: Map<key, template> }
    let any = false;
    for (const file of files) {
        // Headers only: a source file's definitions are its own.
        if (TRANSLATION_UNIT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
        const language = detectLanguage(file, index.root);
        if (!langTraits(language)?.textualIncludes) continue;
        let code;
        try {
            code = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        if (!code.includes('define')) continue;
        for (const { name, body } of objectDefinitions(code)) {
            if (!perName.has(name)) perName.set(name, { objects: new Set(), functions: new Map() });
            perName.get(name).objects.add(body.length > MAX_OBJECT_BODY_CHARS ? null : body);
            any = true;
        }
        const macros = directiveFunctionMacros(code);
        for (const [name, defs] of macros?.defs || []) {
            if (!perName.has(name)) perName.set(name, { objects: new Set(), functions: new Map() });
            const slot = perName.get(name);
            for (const def of defs) {
                const template = { params: def.params, variadic: !!def.variadic, body: def.body };
                slot.functions.set(JSON.stringify(template), template);
            }
            any = true;
        }
    }
    if (!any) return null;
    // One reading per replacement list, by the C++ grammar: the specifier,
    // type and statement forms read here are the same in C.
    const parser = getParser('cpp') || getParser('c');
    if (!parser) return null;
    const readingMemo = new Map();
    const read = (key, compute) => {
        if (!readingMemo.has(key)) readingMemo.set(key, compute());
        return readingMemo.get(key);
    };
    const objectBodies = [];
    const functionMacros = [];
    for (const name of [...perName.keys()].sort(codeUnitCompare)) {
        const slot = perName.get(name);
        // Every definition of the name is one kind; object bodies are short.
        if (slot.objects.size > 0 && slot.functions.size > 0) continue;
        if (slot.objects.size > 0) {
            if (slot.objects.has(null)) continue;
            const bodies = [...slot.objects].sort(codeUnitCompare);
            if (!bodies.every(body => !body || maySpecify(body) || mayBeStatementFragment(body))) continue;
            if (bodies.some(body => leadsWithProjectMacro(body, perName))) continue;
            const reading = read(`o\0${bodies.join('\u0001')}`, () => objectMacroReading(parser, bodies));
            if (reading === 'decoration' || reading === 'statement' || reading === 'if') objectBodies.push([name, bodies]);
            continue;
        }
        const templates = [...slot.functions.values()]
            .sort((a, b) => codeUnitCompare(JSON.stringify(a), JSON.stringify(b)));
        if (new Set(templates.map(template => template.params.length)).size !== 1) continue;
        // Only an attribute or return-type macro (its expansion reads as
        // specifiers or a type) can explain a misread declaration; statement
        // macros such as test assertions read as calls.
        const substituted = templates.map(substituteParams);
        if (!substituted.every(body => !body || maySpecify(body))) continue;
        if (substituted.some(body => leadsWithProjectMacro(body, perName))) continue;
        const reading = read(`f\0${substituted.join('\u0001')}`, () => {
            const readings = new Set(substituted.map(body => objectMacroReading(parser, [body])));
            return readings.size === 1 ? [...readings][0] : null;
        });
        if (reading === 'decoration' || reading === 'type') functionMacros.push([name, templates]);
    }
    const byLanguage = {};
    if (objectBodies.length > 0 || functionMacros.length > 0) {
        const entries = { objectBodies, functionMacros };
        byLanguage.c = entries;
        byLanguage.cpp = entries;
    }
    if (Object.keys(byLanguage).length === 0) return null;
    const key = crypto.createHash('sha1').update(JSON.stringify(byLanguage)).digest('base64url');
    return { key, byLanguage };
}

/**
 * The parse context of one file: the dictionary of its language, less the
 * `excluded` names. Consulted names are collected by the recovery.
 */
const CONTEXT_MAPS = new WeakMap(); // dictionary -> language -> { objectBodies, functionMacros }

function contextFor(dictionary, language, excluded = null) {
    const entry = dictionary?.byLanguage?.[language];
    if (!entry) return null;
    if (excluded && excluded.size > 0) {
        const keep = ([name]) => !excluded.has(name);
        return {
            key: `${dictionary.key}-${[...excluded].sort(codeUnitCompare).join(',')}`,
            objectBodies: new Map(entry.objectBodies.filter(keep)),
            functionMacros: new Map(entry.functionMacros.filter(keep)),
            consulted: new Set(),
        };
    }
    // The maps are shared by every file of one build (read-only).
    let byLanguage = CONTEXT_MAPS.get(dictionary);
    if (!byLanguage) {
        byLanguage = new Map();
        CONTEXT_MAPS.set(dictionary, byLanguage);
    }
    let maps = byLanguage.get(language);
    if (!maps) {
        maps = { objectBodies: new Map(entry.objectBodies), functionMacros: new Map(entry.functionMacros) };
        byLanguage.set(language, maps);
    }
    return { key: dictionary.key, ...maps, consulted: new Set() };
}

/** The dictionary entries of `names` for one language, as a stable key. */
function keyOfNames(dictionary, language, names) {
    if (!names || names.length === 0) return null;
    const entry = dictionary?.byLanguage?.[language];
    const objects = new Map(entry?.objectBodies || []);
    const functions = new Map(entry?.functionMacros || []);
    const parts = [...new Set(names)].sort(codeUnitCompare)
        .map(name => [name, objects.get(name) || null, functions.get(name) || null]);
    return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('base64url');
}

/**
 * After the include graph: a file whose recovery used a definition no file
 * of its include closure (or the file itself) holds is re-read without it;
 * a file whose recorded dictionary entries changed is re-read. Every C/C++
 * file with a recovery record gets its key. Returns { files, names } of the
 * re-indexed files, or null.
 */
function verifyExternalMacros(index, dictionary, { reindex }) {
    const { _textualIncludeClosures } = require('./callers');
    let definers = null; // name -> Set of files defining it
    const definersOf = name => {
        if (!definers) {
            definers = new Map();
            for (const defs of index.symbols.values()) {
                for (const symbol of defs) {
                    if (symbol.type !== 'macro' || !symbol.file) continue;
                    if (!definers.has(symbol.name)) definers.set(symbol.name, new Set());
                    definers.get(symbol.name).add(symbol.file);
                }
            }
        }
        return definers.get(name) || new Set();
    };
    const files = new Set();
    const names = new Set();
    const candidates = [...index.files.keys()].sort(codeUnitCompare);
    for (const file of candidates) {
        const entry = index.files.get(file);
        if (!langTraits(entry?.language)?.textualIncludes) continue;
        const used = entry.externalMacroNames || [];
        const watched = [...used, ...(entry.recoveryCandidates || [])];
        if (watched.length === 0) {
            if (entry.externalMacroKey) delete entry.externalMacroKey;
            continue;
        }
        // Names the recovery used that the file's translation unit never
        // sees defined.
        let unseen = null;
        if (used.length > 0) {
            const closure = _textualIncludeClosures(index, file).all;
            for (const name of used) {
                const where = definersOf(name);
                if ([...where].some(definer => definer === file || closure.has(definer))) continue;
                (unseen ||= new Set()).add(name);
            }
        }
        const excluded = new Set([...(entry.externalMacroExcluded || []), ...(unseen || [])]);
        const key = keyOfNames(dictionary, entry.language, watched.filter(name => !excluded.has(name)));
        const stale = entry.externalMacroKey !== undefined && entry.externalMacroKey !== key;
        if (!unseen && !stale) {
            entry.externalMacroKey = key;
            continue;
        }
        for (const symbol of entry.symbols || []) names.add(symbol.name);
        reindex(file, contextFor(dictionary, entry.language, excluded));
        const next = index.files.get(file);
        if (next) {
            if (excluded.size > 0) next.externalMacroExcluded = [...excluded].sort(codeUnitCompare);
            next.externalMacroKey = keyOfNames(dictionary, next.language,
                [...(next.externalMacroNames || []), ...(next.recoveryCandidates || [])]
                    .filter(name => !excluded.has(name)));
            for (const symbol of next.symbols || []) names.add(symbol.name);
        }
        files.add(file);
    }
    return files.size > 0 ? { files, names } : null;
}

/** Serializable form for build workers (Maps as entry arrays). */
function serializeDictionary(dictionary) {
    return dictionary ? { key: dictionary.key, byLanguage: dictionary.byLanguage } : null;
}

module.exports = { projectMacroDictionary, contextFor, verifyExternalMacros, serializeDictionary, keyOfNames };
