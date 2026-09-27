'use strict';

/**
 * Project-local Rust `macro_rules!` expansion (fix #374).
 *
 * A project macro invocation generates code the AST never shows: impl blocks
 * (`delegate_iterator! { Iter<'a, K, V> => .., impl<..> }`), test functions
 * (`quickcheck! { fn prop(a: Iter<u16>) -> bool { .. } }`), forwarding
 * methods (`deref_forward_buf!();` inside an impl) and calls whose receivers
 * only get a type once the arguments sit in their expanded context. This
 * module expands such invocations at build time and makes what they generate
 * ordinary index facts:
 *
 *   1. Invocations are the grammar's `macro_invocation` nodes whose macro
 *      resolves to a project `macro_rules!` by Rust's own scoping: textual
 *      scope (earlier in the file, `#[macro_use] mod` children, the parent
 *      module up to the `mod` declaration), then path scope
 *      (`#[macro_export]` macros through `crate::`/`$crate::`/package paths,
 *      `use` bindings, globs, `#[macro_use] extern crate`).
 *   2. languages/rust-macro-rules.js matches the invocation's token trees
 *      against the rules and transcribes; project macros invoked by the
 *      transcription expand recursively (bounded depth and output), locals
 *      the transcriber introduces are renamed apart (hygiene) and `$crate`
 *      names the defining crate.
 *   3. The file is re-analyzed with every expansion spliced in place of its
 *      invocation, laid out on the invocation's own lines (argument tokens
 *      keep their line), so the full Rust parser extracts functions, impls,
 *      calls and receiver facts in their real context. The file's symbols
 *      and call records become those of the expanded file: facts produced
 *      inside an invocation carry `macroExpansion {macro, definition, origin,
 *      line}` (origin 'argument' when the token was written in the
 *      invocation, 'template' when it came from the transcriber).
 *
 * An invocation whose rules do not match, whose expansion exceeds the bounds
 * or does not parse in its context stays as written (the parser's token-tree
 * view) and is recorded as blind, disclosed by `repo --sections=health
 * --deep` and deadcode. Macros from dependencies (`vec!`, `println!`, a
 * crate's `quickcheck!`) are never expanded: their definitions are not in the
 * project. Results are persisted with the file entry and revalidated against
 * the file, every macro definition it used and its module ancestry.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getParser, safeParse, PARSE_OPTIONS } = require('../languages');
const { addIRSymbol } = require('./index-ir');
const { findCargoRoot } = require('./imports');
const {
    MacroBlind, argTokensOf, compileMacro, expandWithRules, isPostfixChain, tokenCount,
} = require('../languages/rust-macro-rules');
const { codeUnitCompare } = require('./shared');

const MAX_DEPTH = 64;
const MAX_OUTPUT_TOKENS = 20000;
const BLIND_SAMPLE = 20;

function isRust(fileEntry) {
    return fileEntry?.language === 'rust';
}

/** name -> Rust macro_rules! definitions. */
function macroInventory(index) {
    const inventory = new Map();
    for (const [name, defs] of index.symbols) {
        for (const def of defs) {
            if (def.type !== 'macro') continue;
            if (!isRust(index.files.get(def.file))) continue;
            if (!inventory.has(name)) inventory.set(name, []);
            inventory.get(name).push(def);
        }
    }
    return inventory;
}

function defKey(def) {
    return `${def.relativePath}:${def.startLine}`;
}

// ── Per-pass state ────────────────────────────────────────────────────────

function createState(index, inventory = null) {
    return {
        index,
        parser: getParser('rust'),
        inventory: inventory || macroInventory(index),
        contents: new Map(),
        trees: new Map(),
        compiled: new Map(),
        parents: null,
        packages: new Map(),     // file dir -> cargo info
        crateNames: null,        // crate name -> package root dir
        roots: new Map(),        // file -> crate root file
        macroUseCrates: new Map(), // crate root file -> Set<crate name>
        lineStarts: new Map(),
        textualMemo: new Map(),
        productive: new Map(),
        hygieneSeq: 0,
    };
}

function readContent(state, file) {
    let content = state.contents.get(file);
    if (content === undefined) {
        try {
            content = state.index._readFile(file);
        } catch {
            content = null;
        }
        state.contents.set(file, content);
    }
    return content;
}

function treeOf(state, file) {
    if (state.trees.has(file)) return state.trees.get(file);
    const content = readContent(state, file);
    const tree = content === null ? null : safeParse(state.parser, content, undefined, PARSE_OPTIONS);
    state.trees.set(file, tree);
    return tree;
}

/** child module file -> { file, line, macroUse } from `mod x;` declarations. */
function moduleParents(state) {
    if (state.parents) return state.parents;
    const parents = new Map();
    const index = state.index;
    for (const [file, entry] of index.files) {
        if (!isRust(entry) || !entry.moduleResolved) continue;
        for (const detail of entry.importDetails || []) {
            if (detail.type !== 'mod') continue;
            const rel = entry.moduleResolved[detail.module];
            if (!rel) continue;
            const child = path.join(index.root, rel);
            if (child === file || parents.has(child)) continue;
            const decl = (entry.symbols || []).find(symbol => symbol.type === 'module' &&
                symbol.name === detail.module && symbol.startLine === detail.line);
            parents.set(child, {
                file, line: detail.line,
                macroUse: !!decl?.modifiers?.includes('macro_use'),
            });
        }
    }
    state.parents = parents;
    return parents;
}

function crateRoot(state, file) {
    if (state.roots.has(file)) return state.roots.get(file);
    const parents = moduleParents(state);
    let current = file;
    const seen = new Set();
    while (parents.has(current) && !seen.has(current)) {
        seen.add(current);
        current = parents.get(current).file;
    }
    state.roots.set(file, current);
    return current;
}

function packageOf(state, file) {
    const dir = path.dirname(file);
    if (!state.packages.has(dir)) state.packages.set(dir, findCargoRoot(dir) || null);
    return state.packages.get(dir);
}

function packageByCrateName(state, name) {
    if (!state.crateNames) {
        state.crateNames = new Map();
        for (const [file, entry] of state.index.files) {
            if (!isRust(entry)) continue;
            const info = packageOf(state, file);
            if (info?.packageName && !state.crateNames.has(info.packageName)) {
                state.crateNames.set(info.packageName, info.root);
            }
        }
    }
    return state.crateNames.get(name) || null;
}

function isLibRoot(state, rootFile) {
    const info = packageOf(state, rootFile);
    return !!info && rootFile === path.join(info.srcDir, 'lib.rs');
}

/** Tokens `$crate` becomes for a definition expanded at `siteFile`. */
function crateTokensFor(state, def, siteFile) {
    const defRoot = crateRoot(state, def.file);
    if (defRoot === crateRoot(state, siteFile) || !isLibRoot(state, defRoot)) {
        return [{ k: 'ident', v: 'crate' }];
    }
    const name = packageOf(state, def.file)?.packageName;
    return [{ k: 'ident', v: name || 'crate' }];
}

// ── Definitions ───────────────────────────────────────────────────────────

function attributeNames(node) {
    const names = [];
    for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
        if (sibling.type === 'line_comment' || sibling.type === 'block_comment') continue;
        if (sibling.type !== 'attribute_item') break;
        const attribute = sibling.namedChildren.find(child => child.type === 'attribute');
        const head = attribute?.namedChildren.find(child =>
            child.type === 'identifier' || child.type === 'scoped_identifier');
        if (head) names.push(head.text);
    }
    return names;
}

/** Compiled definition + lexical scope, memoized per pass. */
function compiledDef(state, def) {
    const key = defKey(def);
    if (state.compiled.has(key)) return state.compiled.get(key);
    // Attributes and textual scope are parser facts of the definition; the
    // rules are compiled from the definition's own text, parsed alone with
    // its lines kept (no re-parse of the defining file).
    const attrs = def.modifiers || [];
    const start = lineOffset(state, def.file, def.startLine);
    const end = lineOffset(state, def.file, def.endLine + 1);
    const scope = def.macroScope ? {
        kind: def.macroScope.kind,
        start: lineOffset(state, def.file, def.macroScope.startLine),
        end: lineOffset(state, def.file, def.macroScope.endLine + 1),
        ...(def.macroScope.macroUse && { macroUse: true }),
    } : null;
    const base = { start, end, exported: attrs.includes('macro_export'), cfg: attrs.includes('cfg'), scope };
    let result;
    const content = readContent(state, def.file);
    const text = content === null ? null
        : '\n'.repeat(def.startLine - 1) + content.slice(start, end);
    const tree = text === null ? null : safeParse(state.parser, text, undefined, PARSE_OPTIONS);
    const node = tree && tree.rootNode.descendantsOfType('macro_definition').find(candidate =>
        candidate.startPosition.row + 1 === def.startLine &&
        candidate.childForFieldName('name')?.text === def.name);
    if (!node) {
        result = { ...base, error: 'definition-unavailable' };
    } else {
        try {
            result = { ...base, compiled: compileMacro(node) };
        } catch (error) {
            if (!(error instanceof MacroBlind)) throw error;
            result = { ...base, error: error.reason };
        }
    }
    state.compiled.set(key, result);
    return result;
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Definitions of `name` in textual scope at (file, offset); `offset`
 * Infinity asks what a module exports to its parent through #[macro_use].
 * Returns [{def, pos}] candidates of the innermost scope that has any.
 */
function textualCandidates(state, file, offset, line, name, walkParents, seen = new Set()) {
    if (seen.has(file)) return [];
    seen.add(file);
    const candidates = [];
    for (const def of state.inventory.get(name) || []) {
        if (def.file !== file) continue;
        const info = compiledDef(state, def);
        if (info.start === undefined) continue;
        if (offset !== Infinity && info.end > offset) continue;
        const scope = info.scope;
        if (scope) {
            const inside = offset >= scope.start && offset <= scope.end;
            const after = scope.kind === 'mod' && scope.macroUse && offset >= scope.end;
            if (offset === Infinity ? !(scope.kind === 'mod' && scope.macroUse) : !(inside || after)) continue;
        }
        candidates.push({ def, pos: info.start, info });
    }
    // `#[macro_use] mod child;` before this point brings the child's macros.
    const entry = state.index.files.get(file);
    const parents = moduleParents(state);
    for (const detail of entry?.importDetails || []) {
        if (detail.type !== 'mod' || !(detail.line < line || line === Infinity)) continue;
        const rel = entry.moduleResolved?.[detail.module];
        if (!rel) continue;
        const child = path.join(state.index.root, rel);
        const link = parents.get(child);
        if (!link || link.file !== file || !link.macroUse) continue;
        const exported = textualCandidates(state, child, Infinity, Infinity, name, false, seen);
        // Position: the declaration line (same-line declarations are not
        // idiomatic), keeping the child's own order among its definitions
        // so its cfg alternatives stay together.
        const declared = lineOffset(state, file, detail.line);
        for (const candidate of exported) {
            candidates.push({ ...candidate, pos: declared + candidate.pos / 1e12 });
        }
    }
    if (candidates.length > 0) return candidates;
    if (!walkParents) return [];
    const parent = parents.get(file);
    if (!parent) return [];
    // What the parent sees at the child's `mod` declaration does not depend
    // on where in the child the invocation is.
    const key = `${parent.file}\0${parent.line}\0${name}`;
    if (!state.textualMemo.has(key)) {
        state.textualMemo.set(key, textualCandidates(state, parent.file,
            lineOffset(state, parent.file, parent.line), parent.line, name, true, new Set(seen)));
    }
    return state.textualMemo.get(key);
}

function lineOffset(state, file, line) {
    let starts = state.lineStarts.get(file);
    if (!starts) {
        const content = readContent(state, file);
        starts = [0];
        if (content !== null) {
            for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
        }
        state.lineStarts.set(file, starts);
    }
    return starts[Math.min(Math.max(line - 1, 0), starts.length - 1)];
}

function pickLatest(candidates) {
    return candidates.reduce((best, candidate) => (!best || candidate.pos > best.pos ? candidate : best), null);
}

/**
 * Definitions a bare or path invocation of `name` resolves to at
 * (file, offset). Returns { defs, ambiguous } or null (not a project macro
 * in scope).
 */
function resolveMacro(state, file, offset, line, name, qualifier, dollarCratePackage) {
    const all = state.inventory.get(name);
    if (!all || all.length === 0) return null;
    const inPackage = pkgRoot => all.filter(def => packageOf(state, def.file)?.root === pkgRoot);
    const preferExported = defs => {
        const exported = defs.filter(def => compiledDef(state, def).exported);
        return exported.length > 0 ? exported : defs;
    };
    const finish = defs => {
        if (defs.length === 0) return null;
        return { defs: defs.slice(0, 4), ambiguous: defs.length > 1 };
    };
    if (qualifier) {
        const first = qualifier.split('::')[0];
        const pkgRoot = dollarCratePackage ||
            (['crate', 'self', 'super', '$crate'].includes(first) ? packageOf(state, file)?.root
                : packageByCrateName(state, first));
        if (!pkgRoot) return null;
        return finish(preferExported(inPackage(pkgRoot)));
    }
    const textual = textualCandidates(state, file, offset, line, name, true);
    if (textual.length > 0) {
        const best = pickLatest(textual);
        // Configuration alternatives: several cfg-gated definitions visible
        // from the same scope.
        const alternatives = best.info?.cfg
            ? textual.filter(candidate => candidate.info?.cfg && candidate.def.file === best.def.file)
            : [best];
        // Every configuration's definition expands: cfg-gated code is code.
        return {
            defs: alternatives.map(candidate => candidate.def).slice(0, 4),
            alternatives: alternatives.length > 1,
            ambiguous: false,
        };
    }
    const own = packageOf(state, file);
    const root = crateRoot(state, file);
    const entry = state.index.files.get(file);
    // #[macro_export] macros live in their crate root's namespace.
    if (own && root === file) {
        const exported = inPackage(own.root).filter(def => compiledDef(state, def).exported &&
            crateRoot(state, def.file) === root);
        if (exported.length > 0) return finish(exported);
    }
    // `use crate::m;` / `use pkg::m;` / `use pkg::path::m as n;`
    for (const binding of entry?.importBindings || []) {
        const local = binding.alias || binding.name;
        if (local !== name) continue;
        const first = String(binding.module || '').split('::')[0];
        const pkgRoot = ['crate', 'self', 'super'].includes(first) ? own?.root
            : packageByCrateName(state, first);
        if (!pkgRoot) continue;
        const found = finish(preferExported(inPackage(pkgRoot)));
        if (found) return found;
    }
    // `use pkg::*;` and `#[macro_use] extern crate pkg;`
    const crates = new Set();
    for (const detail of entry?.importDetails || []) {
        if (detail.type === 'use-glob' && !String(detail.module).includes('::')) crates.add(detail.module);
    }
    for (const crate of macroUseCrates(state, root)) crates.add(crate);
    for (const crate of crates) {
        const pkgRoot = crate === 'crate' ? own?.root : packageByCrateName(state, crate);
        if (!pkgRoot) continue;
        const exported = inPackage(pkgRoot).filter(def => compiledDef(state, def).exported);
        const found = finish(exported);
        if (found) return found;
    }
    return null;
}

/** Crates whose macros a crate root imports with `#[macro_use] extern crate`. */
function macroUseCrates(state, rootFile) {
    if (state.macroUseCrates.has(rootFile)) return state.macroUseCrates.get(rootFile);
    const crates = new Set();
    const content = readContent(state, rootFile);
    if (content !== null && content.includes('macro_use')) {
        const tree = treeOf(state, rootFile);
        for (const node of tree?.rootNode.namedChildren || []) {
            if (node.type !== 'extern_crate_declaration') continue;
            if (!attributeNames(node).includes('macro_use')) continue;
            const name = node.childForFieldName('name')?.text;
            if (name) crates.add(name);
        }
    }
    state.macroUseCrates.set(rootFile, crates);
    return crates;
}

// ── Productivity ──────────────────────────────────────────────────────────

/**
 * Whether expanding a macro can change the facts of the code it expands to
 * beyond the parser's token-tree view of the invocation (whose argument
 * calls are already recorded and typed in scope, and whose template calls
 * are already visible at the definition): it declares items, binds argument
 * fragments as locals or parameters, places an argument in callee position
 * (`$f(..)`, `x.$m(..)`), or invokes a project macro that does.
 * Other macros (logging, `try!`-style matches, assertions) are not expanded.
 */
/**
 * true (always worth expanding), 'callee' (only where an argument names a
 * project callable) or false.
 */
function productivity(state, def, visiting = new Set()) {
    const key = defKey(def);
    if (state.productive.has(key)) return state.productive.get(key);
    if (visiting.has(key)) return false;
    visiting.add(key);
    const info = compiledDef(state, def);
    let productive;
    if (info.compiled) {
        productive = info.compiled.declares || info.compiled.bindsArgs ? true
            : info.compiled.callsArgs ? 'callee' : false;
        for (const name of info.compiled.invokes) {
            if (productive === true) break;
            for (const other of state.inventory.get(name) || []) {
                const nested = productivity(state, other, visiting);
                if (nested === true) productive = true;
                else if (nested === 'callee' && !productive) productive = 'callee';
            }
        }
    } else {
        // A definition the engine cannot model is expanded (and disclosed).
        productive = true;
    }
    state.productive.set(key, productive);
    return productive;
}

/**
 * Whether an invocation of `defs` is worth expanding given its source text:
 * a macro that only moves arguments into callee position is expanded where
 * an argument word names a project callable (a word scan of the invocation
 * is only a prefilter; the expansion decides what is a call).
 */
function worthExpanding(state, defs, text, expressionContext) {
    let calleeOnly = false;
    for (const def of defs) {
        const level = productivity(state, def);
        if (level === true) return true;
        if (level === 'callee') calleeOnly = true;
    }
    if (expressionContext && forwardsValue(state, defs)) return true;
    if (!calleeOnly || !text) return false;
    for (const word of new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])) {
        if (namesCallable(state.index, word)) return true;
    }
    return false;
}

const NON_CALLABLE_DEF_TYPES = new Set(['macro', 'struct', 'enum', 'trait', 'module', 'type', 'impl', 'field']);

/** Whether a project definition named `word` can be called. */
function namesCallable(index, word) {
    if (index.callableNames) return index.callableNames.has(word);
    const defs = index.symbols.get(word);
    return !!defs && defs.some(def => !NON_CALLABLE_DEF_TYPES.has(def.type));
}

/** An expression-position invocation whose value is one of its arguments. */
function forwardsValue(state, defs) {
    return defs.some(def => compiledDef(state, def).compiled?.forwardsValue);
}

/**
 * Whether any recorded invocation of the file can need expanding, decided
 * from call records before the file is parsed again.
 */
function fileMayExpand(state, filePath) {
    const calls = state.index.callsCache.get(filePath)?.calls || [];
    let memberRanges = null;
    const inImplOrTrait = line => {
        memberRanges ||= (state.index.files.get(filePath)?.symbols || [])
            .filter(symbol => symbol.type === 'impl' || symbol.type === 'trait')
            .map(symbol => [symbol.startLine, symbol.endLine]);
        return memberRanges.some(([start, end]) => line >= start && line <= end);
    };
    for (const call of calls) {
        if (!call.isMacro || call.inMacro || call.macroExpansion || !state.inventory.has(call.name)) continue;
        if (!Number.isInteger(call.callStart)) return true;
        const qualifier = call.isPathMacro ? call.receiver : null;
        const resolved = resolveMacro(state, filePath, call.callStart, call.line, call.name, qualifier, null);
        if (!resolved) continue;
        // Item wrappers (`cfg_x! { items }`) at module level declare what the
        // parser already recovers from their token trees.
        if (resolved.defs.every(def => compiledDef(state, def).compiled?.passThroughItems) &&
            !call.enclosingFunction && !inImplOrTrait(call.line)) continue;
        const content = readContent(state, filePath);
        const text = content === null ? null : content.slice(call.callStart, call.callEnd || call.callStart);
        // Expression position is a parser fact of the invocation record.
        if (worthExpanding(state, resolved.defs, text, call.macroExpr === true)) return true;
    }
    return false;
}

// ── Expansion ─────────────────────────────────────────────────────────────

function invocationName(node) {
    const macroNode = node.childForFieldName('macro');
    if (!macroNode) return null;
    const parts = macroNode.text.split('::').filter(Boolean);
    const name = parts.pop();
    if (!name) return null;
    return { name, qualifier: parts.length > 0 ? parts.join('::') : null };
}

/** Syntactic context the invocation's expansion is parsed in. */
function invocationContext(node) {
    return require('../languages/rust').rustMacroInvocationContext(node);
}

function itemRecoveryPosition(node) {
    if (node.parent?.type === 'source_file') return true;
    return node.parent?.type === 'declaration_list' && node.parent.parent?.type === 'mod_item';
}

function isTok(tok, v) {
    return tok && tok.k !== 'group' && tok.v === v;
}

/**
 * Expand `toks` (an invocation's token list) with one definition, then every
 * project macro the transcription invokes. `site` carries the budgets, the
 * used definitions and blind records of this top-level invocation.
 */
function expandTokens(state, site, def, toks, depth) {
    if (depth > MAX_DEPTH) throw new MacroBlind('recursion-depth');
    const info = compiledDef(state, def);
    if (info.error) throw new MacroBlind(info.error);
    site.used.set(defKey(def), def);
    const ctx = {
        macro: def.name,
        hygiene: ++state.hygieneSeq,
        crateTokens: crateTokensFor(state, def, site.file),
        budget: site.budget,
    };
    const { tokens } = expandWithRules(info.compiled, toks, ctx);
    site.budget -= tokenCount(tokens);
    if (site.budget < 0) throw new MacroBlind('output-budget');
    return expandNested(state, site, def, tokens, depth);
}

function expandNested(state, site, def, tokens, depth) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.k === 'group') {
            out.push({ ...tok, c: expandNested(state, site, def, tok.c, depth) });
            continue;
        }
        if (tok.k !== 'ident' || isTok(tokens[i - 1], '::') || tok.v === 'macro_rules') {
            out.push(tok);
            continue;
        }
        let k = i;
        const segments = [tok.v];
        while (isTok(tokens[k + 1], '::') && tokens[k + 2]?.k === 'ident') {
            k += 2;
            segments.push(tokens[k].v);
        }
        const group = tokens[k + 2];
        if (!isTok(tokens[k + 1], '!') || group?.k !== 'group') {
            out.push(tok);
            continue;
        }
        const name = segments.pop();
        const qualifier = segments.length > 0 ? segments.join('::') : null;
        const dollarCratePackage = tok.dollarCrate ? packageOf(state, def.file)?.root : null;
        let resolved = resolveMacro(state, site.file, site.offset, site.line, name, qualifier, dollarCratePackage);
        if (!resolved && !qualifier) {
            const info = compiledDef(state, def);
            resolved = resolveMacro(state, def.file, info.start ?? 0, def.startLine, name, null, null);
        }
        if (!resolved) {
            out.push(tok);
            continue;
        }
        const prev = out[out.length - 1];
        const following = tokens[k + 3];
        // Statement/item position: at the start of a token list or after a
        // statement, as a braced invocation or one ending its statement.
        const statementPosition = (!prev || isTok(prev, ';') || (prev.k === 'group' && prev.d === '{')) &&
            (group.d === '{' || !following || isTok(following, ';'));
        let inner;
        try {
            inner = expandAlternatives(state, site, resolved, group.c, depth + 1,
                statementPosition ? 'stmts' : 'expr');
            if (resolved.ambiguous) site.ambiguous = true;
        } catch (error) {
            if (!(error instanceof MacroBlind)) throw error;
            if (error.reason === 'output-budget') throw error;
            site.nestedBlind.push({ macro: name, reason: error.reason });
            out.push(tok);
            continue;
        }
        out.push(...(statementPosition ? inner : wrapExpression(inner)));
        i = k + 2;
    }
    return out;
}

/**
 * Expand with every configuration alternative of a macro. Items and
 * statements of each alternative are all kept (each is real code under its
 * configuration); differing expression values become the arms of one
 * `match`, so no configuration's calls are lost. Throws MacroBlind when no
 * alternative expands.
 */
function expandAlternatives(state, site, resolved, toks, depth, context) {
    const outputs = [];
    const texts = new Set();
    let failure = null;
    for (const def of resolved.defs) {
        try {
            const tokens = expandTokens(state, site, def, cloneTree(toks), depth);
            if (resolved.defs.length > 1) {
                const text = tokenText(tokens);
                if (texts.has(text)) continue;
                texts.add(text);
            }
            outputs.push(tokens);
        } catch (error) {
            if (!(error instanceof MacroBlind) || error.reason === 'output-budget') throw error;
            failure = failure || error;
        }
    }
    if (outputs.length === 0) throw failure || new MacroBlind('no-matching-rule');
    if (failure) site.nestedBlind.push({ macro: resolved.defs[0].name, reason: `alternative:${failure.reason}` });
    if (outputs.length === 1) return outputs[0];
    if (context !== 'expr') return outputs.flat();
    const arms = [];
    outputs.forEach((tokens, i) => {
        if (i > 0) arms.push({ k: 'punct', v: ',', src: 'tpl' });
        arms.push(i === outputs.length - 1 ? { k: 'ident', v: '_', src: 'tpl' } : { k: 'lit', v: String(i), src: 'tpl' },
            { k: 'punct', v: '=>', src: 'tpl' }, ...wrapExpression(tokens));
    });
    return [{ k: 'group', v: '(', d: '(', src: 'tpl', synthetic: true, c: [
        { k: 'ident', v: 'match', src: 'tpl' }, { k: 'lit', v: '0', src: 'tpl' },
        { k: 'group', v: '{', d: '{', src: 'tpl', synthetic: true, c: arms },
    ] }];
}

function cloneTree(tokens) {
    return tokens.map(tok => (tok.k === 'group' ? { ...tok, c: cloneTree(tok.c) } : { ...tok }));
}

/**
 * An expansion used as an expression: a block holding a single expression
 * (`{{ Command::new() }}`) is that expression; anything that is not one
 * postfix operand keeps its precedence in parentheses, statements in a block.
 */
function wrapExpression(input) {
    let tokens = input;
    while (tokens.length === 1 && tokens[0].k === 'group' && tokens[0].d === '{' &&
        tokens[0].c.length > 0 && !tokens[0].c.some(tok => isTok(tok, ';') || isTok(tok, 'let'))) {
        tokens = tokens[0].c;
    }
    if (tokens.length === 1 && tokens[0].k === 'group') return tokens;
    if (isPostfixChain(tokens)) return tokens;
    const hasStatement = tokens.some(tok => isTok(tok, ';'));
    const d = hasStatement ? '{' : '(';
    return [{ k: 'group', v: d, d, c: tokens, src: 'tpl', synthetic: true }];
}

// Hygiene: locals a transcriber introduces (`let x`, closure parameters,
// `for x in`) live in that expansion step's syntax context and never bind
// the invocation's tokens of the same spelling (or vice versa).
const RUST_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while', '_',
]);

function renameHygienicLocals(tokens) {
    const binders = new Set();
    const collect = list => {
        for (let i = 0; i < list.length; i++) {
            const tok = list[i];
            if (tok.k === 'group') {
                collect(tok.c);
                if (isTok(list[i - 1], 'let') || (isTok(list[i - 1], 'mut') && isTok(list[i - 2], 'let'))) {
                    for (const inner of tok.c) {
                        if (inner.k === 'ident' && inner.src === 'tpl' && !RUST_KEYWORDS.has(inner.v) &&
                            !/^[A-Z]/.test(inner.v)) {
                            binders.add(`${inner.ctx}\0${inner.v}`);
                        }
                    }
                }
                continue;
            }
            if (tok.src !== 'tpl' || tok.k !== 'ident' || RUST_KEYWORDS.has(tok.v)) continue;
            const prev = list[i - 1];
            const prev2 = list[i - 2];
            const next = list[i + 1];
            // `let Some(x)` / `let Point { x, .. }` / `let a::B`: a path,
            // not a binding (the bindings sit in the pattern's group).
            const pathHead = (next?.k === 'group' && next.d !== '[') || isTok(next, '::');
            if (pathHead && (isTok(prev, 'let') || (isTok(prev, 'mut') && isTok(prev2, 'let')))) {
                for (const inner of next.c || []) {
                    if (inner.k === 'ident' && inner.src === 'tpl' && !RUST_KEYWORDS.has(inner.v) &&
                        !/^[A-Z]/.test(inner.v)) binders.add(`${inner.ctx}\0${inner.v}`);
                }
                continue;
            }
            if (isTok(prev, 'let') || (isTok(prev, 'mut') && isTok(prev2, 'let')) ||
                (isTok(prev, 'for') && isTok(next, 'in'))) {
                binders.add(`${tok.ctx}\0${tok.v}`);
            }
        }
        // closure parameters: `|a, mut b: T|`
        for (let i = 0; i < list.length; i++) {
            if (!isTok(list[i], '|') || list[i].src !== 'tpl') continue;
            const prev = list[i - 1];
            if (prev && prev.k !== 'group' && !['(', ',', '=', 'move', '=>', ';'].includes(prev.v) &&
                prev.k !== 'punct') continue;
            let j = i + 1;
            let expectName = true;
            while (j < list.length && !isTok(list[j], '|')) {
                const tok = list[j];
                if (isTok(tok, ',')) expectName = true;
                else if (expectName && tok.k === 'ident' && !RUST_KEYWORDS.has(tok.v)) {
                    if (tok.src === 'tpl') binders.add(`${tok.ctx}\0${tok.v}`);
                    expectName = false;
                } else if (!isTok(tok, 'mut') && !isTok(tok, 'ref') && !isTok(tok, '&')) {
                    expectName = false;
                }
                j++;
            }
            i = j;
        }
    };
    collect(tokens);
    if (binders.size === 0) return tokens;
    const rename = list => {
        for (let i = 0; i < list.length; i++) {
            const tok = list[i];
            if (tok.k === 'group') {
                rename(tok.c);
                continue;
            }
            if (tok.k !== 'ident' || tok.src !== 'tpl' || RUST_KEYWORDS.has(tok.v) ||
                !binders.has(`${tok.ctx}\0${tok.v}`)) continue;
            if (isTok(list[i - 1], '.') || isTok(list[i - 1], '::') ||
                isTok(list[i + 1], '::') || isTok(list[i + 1], '!')) continue;
            tok.v = `${tok.v}__ucn_h${tok.ctx}`;
        }
    };
    rename(tokens);
    return tokens;
}

// ── Layout ────────────────────────────────────────────────────────────────

const CLOSE = { '(': ')', '[': ']', '{': '}' };

function flatten(tokens, out = []) {
    for (const tok of tokens) {
        if (tok.k === 'group') {
            out.push({ v: tok.d, src: tok.src, line: tok.line, col: tok.col, s: tok.s, e: tok.s !== undefined ? tok.s + 1 : undefined });
            flatten(tok.c, out);
            const close = tok.closeOrigin;
            out.push(close && tok.src === 'arg'
                ? { v: CLOSE[tok.d], src: 'arg', line: close.line, col: close.col, s: close.s, e: close.e, closer: true }
                : { v: CLOSE[tok.d], src: 'tpl', closer: true });
        } else {
            out.push(tok);
        }
    }
    return out;
}

const MULTI_PUNCT = ['::', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=',
    '%=', '^=', '&=', '|=', '<<', '>>', '..', '//', '/*', '*/'];
const SPACE_AFTER = new Set([',', ';', ':', '=>', '->', '=', '+', '|', '&&', '||', '==', '!=']);
const SPACE_BEFORE = new Set(['=>', '->', '=', '+', '{', '==', '!=', '&&', '||']);
// ASCII letters, digits, '_', quotes (and '#' at a word's end): a leaf that
// ends / starts with one lexes into its neighbor without a space.
function isWordCode(code) {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) ||
        code === 95 || code === 39 || code === 34;
}
const isWordEnd = leaf => {
    const v = typeof leaf.v === 'string' ? leaf.v : String(leaf.v);
    if (v.length === 0) return false;
    const code = v.charCodeAt(v.length - 1);
    return isWordCode(code) || code === 35;
};
const isWordStart = leaf => {
    const v = typeof leaf.v === 'string' ? leaf.v : String(leaf.v);
    return v.length > 0 && isWordCode(v.charCodeAt(0));
};

/**
 * Whether two adjacent leaves need a space: when they would lex as one
 * token, plus conventional spacing so text-derived facts (parameter lists,
 * generics, paths) read like source.
 */
function needsSpace(prev, leaf) {
    if (!prev) return false;
    const wordEnd = isWordEnd(prev);
    const wordStart = isWordStart(leaf);
    if (wordEnd && wordStart) return true;
    const a = prev.v;
    const b = leaf.v;
    if (b === '.' && /^[0-9]/.test(a)) return true;
    if (!wordEnd && !wordStart) {
        const joint = a.slice(-1) + b[0];
        if (MULTI_PUNCT.some(p => p.startsWith(joint)) && !(a === '::' || b === '::')) return true;
    }
    if (a === ':' && b === ':') return true;
    if (SPACE_AFTER.has(a) && a !== '::') return !(a === '|' && prev.closer);
    if ((a === '>' || a === '}') && wordStart) return true;
    if (SPACE_BEFORE.has(b)) return true;
    return false;
}

/**
 * Text of an expansion laid out on the invocation's lines [startLine,
 * endLine]: argument tokens move to their own line when it is ahead, leading
 * template tokens join the next argument token's line, nothing ever passes
 * endLine. Returns { text, marks: [{s, e, leaf}] } (offsets relative).
 */
function layout(tokens, startLine, startCol, endLine) {
    const leaves = flatten(tokens);
    const nextArgLine = new Array(leaves.length + 1).fill(0);
    for (let i = leaves.length - 1; i >= 0; i--) {
        nextArgLine[i] = leaves[i].src === 'arg' ? leaves[i].line : nextArgLine[i + 1];
    }
    let line = startLine;
    let col = startCol;
    let text = '';
    const marks = [];
    let first = true;
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        let target = 0;
        if (leaf.src === 'arg' && leaf.line > line) target = leaf.line;
        else if (leaf.src !== 'arg' && !leaf.closer && nextArgLine[i + 1] > line) target = nextArgLine[i + 1];
        if (target > line && target <= endLine) {
            text += '\n'.repeat(target - line);
            line = target;
            col = 0;
            if (leaf.src === 'arg' && leaf.col > col) {
                text += ' '.repeat(leaf.col);
                col = leaf.col;
            }
        } else if (!first && needsSpace(leaves[i - 1], leaf)) {
            text += ' ';
            col++;
        }
        first = false;
        let value = leaf.v;
        if (value.includes('\n')) {
            const breaks = value.split('\n').length - 1;
            if (leaf.src === 'arg' && line + breaks <= endLine) {
                line += breaks;
                col = value.length - value.lastIndexOf('\n') - 1;
            } else {
                value = /^b?r?#*"|^b?"/.test(value) ? '""' : ' ';
                col += value.length;
            }
        } else {
            col += value.length;
        }
        marks.push({ s: text.length, e: text.length + value.length, leaf, line });
        text += value;
    }
    if (line < endLine) text += '\n'.repeat(endLine - line);
    return { text, marks };
}

// ── Per-file expansion ────────────────────────────────────────────────────

function collectErrorRanges(node, out) {
    if (node.type === 'ERROR' || node.isMissing) {
        out.push([node.startIndex, node.endIndex]);
        return out;
    }
    if (!node.hasError) return out;
    for (let i = 0; i < node.childCount; i++) collectErrorRanges(node.child(i), out);
    return out;
}

/**
 * The expanded file as analyzed: only the kept ranges (units holding an
 * invocation and their ancestors' headers) are text; everything else is
 * blanked with its line breaks kept, so every line keeps its number and the
 * parser only walks what it must re-derive. Expansions replace their
 * invocation's span.
 */
function buildSynthetic(content, regions, keep) {
    let text = '';
    let cursor = 0;
    const spans = []; // synthetic [start, end) of text that is not blank
    const blank = (from, to) => content.slice(from, to).replace(/[^\r\n]/g, ' ');
    const addSpan = (start, end) => {
        if (end <= start) return;
        const last = spans[spans.length - 1];
        if (last && last[1] >= start) last[1] = Math.max(last[1], end);
        else spans.push([start, end]);
    };
    const copy = (from, to) => {
        // Kept ranges are sorted and disjoint.
        let at = from;
        for (const [start, end] of keep) {
            if (end <= at) continue;
            if (start >= to) break;
            if (start > at) text += blank(at, start);
            const stop = Math.min(end, to);
            const synthStart = text.length;
            text += content.slice(Math.max(start, at), stop);
            addSpan(synthStart, text.length);
            at = stop;
        }
        if (at < to) text += blank(at, to);
    };
    for (const region of regions) {
        copy(cursor, region.start);
        region.synthStart = text.length;
        text += region.layout.text;
        region.synthEnd = text.length;
        addSpan(region.synthStart, region.synthEnd);
        cursor = region.end;
    }
    copy(cursor, content.length);
    return { text, spans };
}

/**
 * Parse only the non-blank spans of the synthetic file (tree-sitter
 * included ranges): positions stay absolute, blank text costs nothing. The
 * tree lands in safeParse's cache, so the adapter's analysis reuses it.
 */
function parseSynthetic(parser, text, spans) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const position = offset => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return { row: lo, column: offset - starts[lo] };
    };
    const includedRanges = spans.map(([start, end]) => ({
        startIndex: start, endIndex: end, startPosition: position(start), endPosition: position(end),
    }));
    if (includedRanges.length === 0) return safeParse(parser, text, undefined, PARSE_OPTIONS);
    return safeParse(parser, text, undefined, { ...PARSE_OPTIONS, includedRanges });
}

const UNIT_TYPES = new Set(['function_item', 'const_item', 'static_item']);
const HEADER_TYPES = new Set(['function_item', 'impl_item', 'trait_item', 'mod_item', 'foreign_mod_item']);

/** The node plus its preceding attributes and comments. */
function withLeadingTrivia(node) {
    let start = node.startIndex;
    let startRow = node.startPosition.row;
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.type !== 'attribute_item' && sibling.type !== 'line_comment' &&
            sibling.type !== 'block_comment') break;
        start = sibling.startIndex;
        startRow = sibling.startPosition.row;
    }
    return { start, startLine: startRow + 1 };
}

/**
 * Units re-derived from the expanded file: the innermost function (or
 * const/static item) holding each invocation, else the item-position
 * invocation itself, with leading attributes; plus, kept as text, the
 * headers and associated types of every enclosing impl/trait/mod/fn so the
 * unit parses in its real context (Self type, trait, enclosing fn).
 */
function analysisUnits(regions, mode = 'calls') {
    const units = [];
    const keep = [];
    const headers = new Set();
    const keepHeader = parent => {
        if (headers.has(parent.startIndex)) return;
        headers.add(parent.startIndex);
        const body = parent.childForFieldName('body');
        if (!body) return;
        keep.push([parent.startIndex, body.startIndex + 1], [body.endIndex - 1, body.endIndex]);
        // Associated types of an enclosing impl/trait.
        if (parent.type === 'impl_item' || parent.type === 'trait_item') {
            for (const member of body.namedChildren) {
                if (member.type === 'type_item' || member.type === 'associated_type') {
                    keep.push([member.startIndex, member.endIndex]);
                }
            }
        }
        const { start: headStart } = withLeadingTrivia(parent);
        if (headStart < parent.startIndex) keep.push([headStart, parent.startIndex]);
    };
    for (const region of regions) {
        let unitNode = null;
        for (let parent = region.node.parent; parent; parent = parent.parent) {
            if (UNIT_TYPES.has(parent.type)) { unitNode = parent; break; }
        }
        let start;
        let startLine;
        let end;
        let endLine;
        if (unitNode) {
            ({ start, startLine } = withLeadingTrivia(unitNode));
            end = unitNode.endIndex;
            endLine = unitNode.endPosition.row + 1;
        } else {
            ({ start, startLine } = withLeadingTrivia(region.node));
            const next = region.node.nextSibling;
            const last = next && next.type === ';' ? next : region.node;
            end = last.endIndex;
            endLine = last.endPosition.row + 1;
        }
        units.push({ start, end, startLine, endLine });
        if (mode === 'symbols' && unitNode) {
            // Declarations need only the invocation in its enclosing
            // function's frame, not the rest of the body.
            if (unitNode.type === 'function_item') keepHeader(unitNode);
            else keep.push([start, end]);
            const next = region.node.nextSibling;
            keep.push([region.start, next && next.type === ';' ? next.endIndex : region.end]);
        } else {
            keep.push([start, end]);
        }
        for (let parent = (unitNode || region.node).parent; parent; parent = parent.parent) {
            if (HEADER_TYPES.has(parent.type)) keepHeader(parent);
        }
    }
    const merge = ranges => {
        ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const out = [];
        for (const range of ranges) {
            const last = out[out.length - 1];
            if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
            else out.push([...range]);
        }
        return out;
    };
    units.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const unit of units) {
        const last = merged[merged.length - 1];
        if (last && unit.start <= last.end) {
            if (unit.end > last.end) { last.end = unit.end; last.endLine = unit.endLine; }
        } else merged.push({ ...unit });
    }
    return { units: merged, keep: merge(keep) };
}

function regionAt(regions, synth) {
    let lo = 0;
    let hi = regions.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const region = regions[mid];
        if (synth < region.synthStart) hi = mid - 1;
        else if (synth >= region.synthEnd) lo = mid + 1;
        else return region;
    }
    return null;
}

/**
 * Mark of the leaf at relative offset `rel`: the leaf containing it, else
 * (whitespace) the next leaf for a start offset, the previous for an end.
 */
function markAt(marks, rel, forEnd) {
    const probe = forEnd ? rel - 1 : rel;
    let lo = 0;
    let hi = marks.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const mark = marks[mid];
        if (probe < mark.s) hi = mid - 1;
        else if (probe >= mark.e) lo = mid + 1;
        else return mark;
    }
    // lo = first mark starting after probe, hi = last mark ending before it
    return forEnd ? (marks[hi] || marks[lo] || null) : (marks[lo] || marks[hi] || null);
}

/** Maps synthetic offsets back to the source file. */
function offsetMapper(regions) {
    // Length change accumulated after each region.
    let delta = 0;
    for (const region of regions) {
        delta += (region.synthEnd - region.synthStart) - (region.end - region.start);
        region.deltaAfter = delta;
    }
    const map = (synth, forEnd) => {
        const region = regionAt(regions, forEnd ? synth - 1 : synth);
        if (!region) {
            // Copied text: shift by every region before it.
            let lo = 0;
            let hi = regions.length - 1;
            let before = null;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (regions[mid].synthEnd <= synth) { before = regions[mid]; lo = mid + 1; } else hi = mid - 1;
            }
            return synth - (before ? before.deltaAfter : 0);
        }
        const rel = synth - region.synthStart;
        const mark = markAt(region.layout.marks, rel, forEnd);
        if (mark && mark.leaf.src === 'arg' && Number.isInteger(mark.leaf.s)) {
            return mark.leaf.s + Math.min(Math.max(rel - mark.s, 0), mark.e - mark.s);
        }
        return fraction(region, synth);
    };
    // Template text has no source offset: a stable fraction inside the
    // invocation's first byte keeps order and receiver links.
    const fraction = (region, synth) =>
        region.start + (synth - region.synthStart + 1) / (region.synthEnd - region.synthStart + 2);
    const templateOffset = synth => {
        const region = regionAt(regions, synth) || regionAt(regions, synth - 1);
        return region ? fraction(region, Math.min(synth, region.synthEnd)) : map(synth, false);
    };
    return { map, templateOffset, regionAt: synth => regionAt(regions, synth) };
}

const OFFSET_FIELD = /(?:Start|End|^start|^end)$/;

/**
 * Remap every `<x>Start`/`<x>End` offset field. A span keeps source offsets
 * only when both ends were written in the source (outside expansions, or
 * both inside argument tokens); otherwise both ends take the invocation's
 * fractional template offsets, so a span never inverts.
 */
function remapOffsets(record, mapper, depth = 0) {
    const pairs = new Map();
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (value && typeof value === 'object' && depth < 4) {
            // Nested evidence (receiverTypeEvidence, origins) carries offsets too.
            if (Array.isArray(value)) {
                record[key] = value.map(item => {
                    if (!item || typeof item !== 'object') return item;
                    const copy = { ...item };
                    remapOffsets(copy, mapper, depth + 1);
                    return copy;
                });
            } else {
                const copy = { ...value };
                remapOffsets(copy, mapper, depth + 1);
                record[key] = copy;
            }
            continue;
        }
        if (typeof value !== 'number' || !OFFSET_FIELD.test(key)) continue;
        const stem = key.replace(OFFSET_FIELD, '');
        if (!pairs.has(stem)) pairs.set(stem, {});
        pairs.get(stem)[/end$/i.test(key) ? 'end' : 'start'] = key;
    }
    for (const { start, end } of pairs.values()) {
        const mappedStart = start ? mapper.map(record[start], false) : null;
        const mappedEnd = end ? mapper.map(record[end], true) : null;
        const mixed = start && end &&
            (Number.isInteger(mappedStart) !== Number.isInteger(mappedEnd) || mappedEnd < mappedStart);
        if (mixed) {
            record[start] = mapper.templateOffset(record[start]);
            record[end] = mapper.templateOffset(record[end]);
            continue;
        }
        if (start) record[start] = mappedStart;
        if (end) record[end] = mappedEnd;
    }
}

const DECLARATION_TYPES = [
    'function_item', 'function_signature_item', 'impl_item', 'struct_item', 'enum_item', 'union_item',
    'trait_item', 'mod_item', 'type_item', 'const_item', 'static_item', 'macro_definition',
    'field_declaration', 'enum_variant', 'associated_type',
];

/** (startLine\0name) keys of declarations whose name was produced inside a region. */
function generatedDeclarations(root, regions) {
    const out = new Map();
    if (regions.length === 0) return out;
    for (const node of root.descendantsOfType(DECLARATION_TYPES)) {
        const nameNode = node.type === 'impl_item' ? node.childForFieldName('type')
            : node.childForFieldName('name');
        if (!nameNode) continue;
        const region = regionAt(regions, nameNode.startIndex);
        if (!region || nameNode.endIndex > region.synthEnd) continue;
        const mark = markAt(region.layout.marks, nameNode.startIndex - region.synthStart, false);
        const origin = mark?.leaf.src === 'arg' ? 'argument' : 'template';
        const text = node.type === 'impl_item' ? typeNameOf(nameNode) : nameNode.text;
        out.set(`${node.startPosition.row + 1}\0${text}`, {
            region, origin,
            ...(origin === 'argument' && { nameLine: mark.leaf.line }),
        });
    }
    return out;
}

function typeNameOf(node) {
    if (node.type === 'generic_type') return typeNameOf(node.childForFieldName('type'));
    if (node.type === 'scoped_type_identifier') return node.childForFieldName('name')?.text || node.text;
    if (node.type === 'reference_type') return typeNameOf(node.childForFieldName('type'));
    return node.text;
}

function macroFact(region, origin) {
    return {
        macro: region.macro,
        definition: region.definition,
        origin,
        line: region.startLine,
        ...(region.ambiguous && { ambiguous: true }),
    };
}

/**
 * Expand the project macro invocations of one file. Returns the expansion
 * record, or null when the file invokes no project macro in scope.
 */
function expandFile(state, filePath, mode = 'symbols') {
    // Hygiene contexts are numbered per file, so an expansion's renamed
    // locals do not depend on what else this state expanded before.
    state.hygieneSeq = 0;
    const index = state.index;
    const fileEntry = index.files.get(filePath);
    const content = readContent(state, filePath);
    if (!fileEntry || content === null) return null;
    if (!fileMayExpand(state, filePath)) return { sites: 0, blind: [], used: new Map(), expanded: false };
    const tree = safeParse(state.parser, content, undefined, PARSE_OPTIONS);
    const rec = { sites: 0, blind: [], used: new Map(), expanded: false };
    const regions = [];
    let lineStarts = null;
    const invocations = tree.rootNode.descendantsOfType('macro_invocation');
    for (const node of invocations) {
        const id = invocationName(node);
        if (!id || !state.inventory.has(id.name)) continue;
        let inDefinition = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === 'macro_definition') { inDefinition = true; break; }
        }
        if (inDefinition) continue;
        const line = node.startPosition.row + 1;
        const resolved = resolveMacro(state, filePath, node.startIndex, line, id.name, id.qualifier, null);
        if (!resolved) continue;
        const def = resolved.defs[0];
        const info = compiledDef(state, def);
        const context = invocationContext(node);
        if (!worthExpanding(state, resolved.defs, content.slice(node.startIndex, node.endIndex),
            context === 'expr')) continue;
        const tokenTree = node.namedChildren.find(child => child.type === 'token_tree');
        if (info.compiled?.passThroughItems && context === 'items' && itemRecoveryPosition(node)) continue;
        const blind = reason => rec.blind.push({ line, macro: id.name, reason });
        if (!context) { blind('context'); continue; }
        if (!tokenTree) { blind('token-error'); continue; }
        const site = {
            file: filePath, offset: node.startIndex, line, budget: MAX_OUTPUT_TOKENS,
            used: rec.used, nestedBlind: [], ambiguous: resolved.ambiguous,
        };
        let tokens;
        try {
            if (!lineStarts) {
                lineOffset(state, filePath, 1);
                lineStarts = state.lineStarts.get(filePath);
            }
            const toks = argTokensOf(tokenTree, content, lineStarts);
            tokens = resolved.alternatives
                ? expandAlternatives(state, site, resolved, toks, 0, context)
                : expandTokens(state, site, def, toks, 0);
        } catch (error) {
            if (!(error instanceof MacroBlind)) throw error;
            blind(error.reason);
            continue;
        }
        for (const nested of site.nestedBlind) rec.blind.push({ line, macro: nested.macro, reason: `nested:${nested.reason}` });
        renameHygienicLocals(tokens);
        let body = tokens;
        if (context === 'expr') body = wrapExpression(tokens);
        const startLine = line;
        const endLine = node.endPosition.row + 1;
        const ancestors = new Set();
        for (let parent = node.parent; parent; parent = parent.parent) {
            const nameNode = parent.type === 'impl_item' ? parent.childForFieldName('type')
                : DECLARATION_TYPES.includes(parent.type) ? parent.childForFieldName('name') : null;
            if (nameNode) {
                ancestors.add(`${parent.startPosition.row + 1}\0${parent.type === 'impl_item' ? typeNameOf(nameNode) : nameNode.text}`);
            }
        }
        regions.push({
            start: node.startIndex, end: node.endIndex, startLine, endLine,
            macro: id.name, definition: defKey(def), ambiguous: site.ambiguous, ancestors,
            node, layout: layout(body, startLine, node.startPosition.column, endLine),
        });
    }
    rec.sites = regions.length;
    if (regions.length === 0) return rec;
    regions.sort((a, b) => a.start - b.start);
    // Every word the expanded text of the calls pass can hold (fix #375).
    const words = mode === 'symbols' ? expansionWords(content, regions) : null;

    // Parse the expanded file; an expansion that does not parse in its
    // context stays as written (blind), and the rest are parsed again.
    let synthetic;
    let synthTree;
    let units;
    for (let attempt = 0; attempt <= regions.length && regions.length > 0; attempt++) {
        const scope = analysisUnits(regions, mode);
        units = scope.units;
        const built = buildSynthetic(content, regions, scope.keep);
        synthetic = built.text;
        synthTree = parseSynthetic(state.parser, synthetic, built.spans);
        const errors = collectErrorRanges(synthTree.rootNode, []);
        const bad = new Set();
        for (const [start, end] of errors) {
            for (const region of regions) {
                if (start < region.synthEnd && end > region.synthStart) bad.add(region);
                else if (start === end && start >= region.synthStart && start <= region.synthEnd) bad.add(region);
            }
        }
        if (bad.size === 0) break;
        for (const region of bad) {
            rec.blind.push({ line: region.startLine, macro: region.macro, reason: 'parse-error' });
            regions.splice(regions.indexOf(region), 1);
        }
    }
    rec.sites = regions.length;
    if (regions.length === 0) return rec;

    const rust = require('../languages/rust');
    // The expanded file holds no unexpanded item bodies worth recovering
    // inside its units; the extractors share the included-ranges tree.
    rust.primeDeclarationTrees(synthetic, state.parser, synthTree);
    const mapper = offsetMapper(regions);

    // Units are re-derived; everything outside them keeps its parse.
    // (Sorted and disjoint: binary searches.)
    const unitAtOffset = offset => {
        let lo = 0;
        let hi = units.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (offset < units[mid].start) hi = mid - 1;
            else if (offset >= units[mid].end) lo = mid + 1;
            else return units[mid];
        }
        return null;
    };
    const byLine = (list, line) => {
        let lo = 0;
        let hi = list.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (line < list[mid].startLine) hi = mid - 1;
            else if (line > list[mid].endLine) lo = mid + 1;
            else return list[mid];
        }
        return null;
    };
    const unitAtLine = line => byLine(units, line);
    const inUnit = record => (Number.isFinite(record.callStart) ? !!unitAtOffset(record.callStart)
        : !!unitAtLine(record.line));
    rec.expanded = true;

    if (mode === 'symbols') {
        // Declarations of the regions only: the smallest nodes spanning each.
        const spanning = regions.map(region => (region.synthEnd > region.synthStart
            ? synthTree.rootNode.descendantForIndex(region.synthStart, region.synthEnd - 1) : null))
            .filter(Boolean).sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
        const roots = [];
        for (const node of spanning) {
            const last = roots[roots.length - 1];
            if (last && node.startIndex >= last.startIndex && node.endIndex <= last.endIndex) continue;
            roots.push(node);
        }
        rec.symbols = generatedSymbols(filePath, rust.parseDeclarationsIn(synthetic, roots), {
            regions, mapper, generated: generatedDeclarations(synthTree.rootNode, regions),
        });
        rec.calleeNames = callableNames(regions);
        rec.words = words;
        rec.callsPending = true;
        return rec;
    }

    // Calls: records of the units from the expanded file, the rest as parsed,
    // plus the invocations themselves.
    const cached = index.callsCache.get(filePath);
    const original = cached?.calls || [];
    const invocationStarts = new Set(regions.map(region => region.start));
    const calls = original.filter(record => !inUnit(record));
    const seen = new Set();
    // Records without a source span (struct-literal constructors) are placed
    // by line: one the unexpanded parse also has on that line is ordinary
    // code, any other one on an invocation's lines was generated.
    const spanless = record => `${record.name}\0${record.line}\0${record.isConstructor ? 1 : 0}`;
    const originalSpanless = new Map();
    for (const record of original) {
        if (Number.isFinite(record.callStart) || !unitAtLine(record.line)) continue;
        const key = spanless(record);
        originalSpanless.set(key, (originalSpanless.get(key) || 0) + 1);
    }
    const regionOnLine = line => byLine(regions, line);
    const synthCalls = rust.findCallsInCode(synthetic, state.parser);
    for (const record of synthCalls) {
        const synthStart = record.callStart;
        if (Number.isFinite(synthStart)) {
            const mapped = mapper.map(synthStart, false);
            if (!unitAtOffset(Math.floor(mapped))) continue;
        } else if (!unitAtLine(record.line)) continue;
        const call = { ...record };
        let region = Number.isFinite(synthStart) ? mapper.regionAt(synthStart) : null;
        if (!Number.isFinite(synthStart) && regionOnLine(record.line)) {
            const key = spanless(record);
            const left = originalSpanless.get(key) || 0;
            if (left > 0) originalSpanless.set(key, left - 1);
            else region = regionOnLine(record.line);
        }
        remapOffsets(call, mapper);
        if (region) {
            // Origin of the NAME token: `v.iter().collect()` written with a
            // receiver from the arguments still calls a template `collect`.
            const nameMark = Number.isFinite(synthStart) ? nameMarkOf(synthTree.rootNode, region, record)
                : region.layout.marks.find(mark => mark.leaf.v === record.name && mark.leaf.src === 'arg' &&
                    mark.line === record.line) || null;
            const origin = nameMark?.leaf.src === 'arg' ? 'argument' : 'template';
            // An argument token the layout could not keep on its own line
            // (repeated or reordered by the transcriber) reports its own.
            if (origin === 'argument' && nameMark.line !== nameMark.leaf.line) call.line = nameMark.leaf.line;
            call.macroExpansion = macroFact(region, origin);
            // Repeated argument tokens are one call; template calls at one
            // line are told apart only by what the engine can see of them
            // (a transcriber repetition emits the same call per iteration).
            const key = origin === 'argument'
                ? `a\0${call.name}\0${call.line}\0${call.callStart}\0${call.callEnd}\0${call.receiver || ''}`
                : `t\0${call.name}\0${call.line}\0${call.isMethod ? 1 : 0}\0${call.receiver || ''}\0` +
                    `${call.receiverType || ''}\0${call.receiverRootType || ''}\0${call.receiverField || ''}\0` +
                    `${call.enclosingFunction?.name || ''}\0${call.argCount ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
        }
        calls.push(call);
    }
    // The invocation stays a call of the macro; the value it produces is
    // the expansion's, so its own value-flow facts are dropped.
    for (const record of original) {
        if (!record.isMacro || !invocationStarts.has(record.callStart)) continue;
        calls.push({
            name: record.name, line: record.line, callStart: record.callStart, callEnd: record.callEnd,
            isMethod: false, isMacro: true,
            ...(record.receiver && { receiver: record.receiver, isPathMacro: true }),
            ...(record.macroExpr && { macroExpr: true }),
            enclosingFunction: record.enclosingFunction,
            macroExpanded: true,
        });
    }
    // Shapes of generated calls whose value may be lost (audit-async).
    const { openCallShape } = require('../languages/rust-value-flow');
    const shapes = calls.filter(call => call.macroExpansion && call.name && !call.inMacro && !call.valueConsumed)
        .map(openCallShape);
    if (shapes.length > 0) {
        fileEntry.openCalls = [...new Set([...(fileEntry.openCalls || []), ...shapes])].sort(codeUnitCompare);
    }
    // Stable by line: records keep document order within a line.
    calls.sort((a, b) => a.line - b.line);
    if (cached) {
        if (index.calleeIndex) index._removeFromCalleeIndex(filePath, original);
        cached.calls = calls;
        if (index.calleeIndex) index._addToCalleeIndex(filePath, calls);
    } else {
        index.callsCache.set(filePath, { mtime: fileEntry.mtime, hash: fileEntry.hash, calls });
    }
    index.callsCacheDirty = true;
    rec.expanded = true;
    return rec;
}

const CALL_NODES = new Set(['call_expression', 'macro_invocation', 'struct_expression', 'generic_function']);

/** Layout mark of the name token of a call record inside a region. */
function nameMarkOf(root, region, record) {
    const start = record.callStart;
    const end = record.callEnd;
    let node = Number.isFinite(start) && Number.isFinite(end) && end > start
        ? root.descendantForIndex(start, end - 1) : null;
    while (node && !(CALL_NODES.has(node.type) && node.startIndex === start && node.endIndex === end)) {
        node = node.parent;
    }
    let nameNode = null;
    if (node?.type === 'macro_invocation') {
        nameNode = node.childForFieldName('macro');
    } else if (node) {
        let fn = node.childForFieldName('function') || node.childForFieldName('name');
        if (fn?.type === 'generic_function') fn = fn.childForFieldName('function');
        if (fn?.type === 'field_expression') nameNode = fn.childForFieldName('field');
        else if (fn?.type === 'scoped_identifier' || fn?.type === 'scoped_type_identifier') nameNode = fn.childForFieldName('name');
        else nameNode = fn;
    }
    if (nameNode && nameNode.startIndex >= region.synthStart && nameNode.endIndex <= region.synthEnd) {
        const rel = nameNode.type === 'scoped_identifier' || nameNode.type === 'macro_invocation'
            ? nameNode.endIndex - 1 - region.synthStart : nameNode.startIndex - region.synthStart;
        return markAt(region.layout.marks, rel, false);
    }
    // No node at that span: the first leaf spelling the name.
    const marks = region.layout.marks;
    return marks.find(mark => mark.leaf.v === record.name &&
        mark.s >= start - region.synthStart && mark.e <= end - region.synthStart) || null;
}

/**
 * The declarations the expansions generate (IR items carrying
 * `macroExpansion`), and the invocation spans whose recovered declarations
 * they replace. Pure: computed in a build worker or in place.
 */
function generatedSymbols(filePath, parsed, { regions, mapper, generated }) {
    const { createFileIR } = require('./ir');
    const ir = createFileIR({ language: 'rust', file: filePath, parsed, calls: [] });
    const symbols = [];
    const seen = new Set();
    let ordinal = 0;
    for (const item of ir.symbols) {
        const origin = generated.get(`${item.startLine}\0${item.name}`);
        if (!origin) continue;
        // Declarations a repetition generates identically at one line.
        const key = `${item.kind}\0${item.name}\0${item.owner || ''}\0${item.startLine}\0${item.traitName || ''}\0` +
            `${item.params || ''}\0${item.returnType || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const symbol = { ...item };
        remapOffsets(symbol, mapper);
        symbol.macroExpansion = macroFact(origin.region, origin.origin);
        if (origin.nameLine && origin.nameLine !== symbol.startLine) symbol.nameLine = origin.nameLine;
        symbol.id = `macro:${symbol.startLine}:${symbol.kind}:${symbol.owner || ''}:${symbol.name}:${ordinal++}`;
        symbols.push(symbol);
    }
    return {
        symbols,
        spans: regions.map(region => ({
            startLine: region.startLine, endLine: region.endLine, ancestors: [...region.ancestors],
        })),
    };
}

/** Apply generatedSymbols() to the index (main thread). */
function applyGeneratedSymbols(index, filePath, result) {
    const fileEntry = index.files.get(filePath);
    if (!fileEntry || !result) return;
    for (const symbol of fileEntry.symbols) {
        const entries = index.symbols.get(symbol.name);
        if (!entries) continue;
        const kept = entries.filter(entry => entry.file !== filePath);
        if (kept.length > 0) index.symbols.set(symbol.name, kept);
        else index.symbols.delete(symbol.name);
    }
    const previous = fileEntry.symbols;
    fileEntry.symbols = [];
    fileEntry.bindings = [];
    // An invocation's token trees held only what the parser recovered from
    // them (item bodies): those give way to what the expansion declares.
    // The declarations enclosing an invocation stay.
    const spans = result.spans.map(span => ({ ...span, ancestors: new Set(span.ancestors) }));
    const insideSpan = symbol => spans.some(span => symbol.startLine >= span.startLine &&
        symbol.endLine <= span.endLine && !span.ancestors.has(`${symbol.startLine}\0${symbol.name}`));
    for (const symbol of previous) {
        if (insideSpan(symbol)) continue;
        fileEntry.symbols.push(symbol);
        if (!index.symbols.has(symbol.name)) index.symbols.set(symbol.name, []);
        index.symbols.get(symbol.name).push(symbol);
        if (symbol.memberAssigned || symbol.bodyScopedName || symbol.exportedAlias || symbol.type === 'impl') continue;
        fileEntry.bindings.push({
            id: symbol.bindingId, name: symbol.name, type: symbol.type, startLine: symbol.startLine,
        });
    }
    for (const item of result.symbols) {
        const symbol = addIRSymbol(fileEntry, item, index.symbols);
        // A generated trait impl for a type declared in this file joins the
        // type's `implements` (the parser does this for impls it sees).
        if (symbol.type !== 'impl' || !symbol.traitName) continue;
        const owner = fileEntry.symbols.find(candidate => (candidate.type === 'struct' || candidate.type === 'enum') &&
            candidate.name === symbol.name && !candidate.macroExpansion);
        if (owner && !(owner.implements || []).includes(symbol.traitName)) {
            owner.implements = [...(owner.implements || []), symbol.traitName];
        }
    }
}

/**
 * Names the calls of the expansions can bear (callee position, method,
 * macro, struct literal): the callee index lists the file under them until
 * its calls are expanded.
 */
function callableNames(regions) {
    const names = new Set();
    for (const region of regions) {
        const marks = region.layout.marks;
        for (let i = 0; i < marks.length - 1; i++) {
            const leaf = marks[i].leaf;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(leaf.v) || RUST_KEYWORDS.has(leaf.v)) continue;
            const next = marks[i + 1].leaf.v;
            if (next === '(' || next === '!' || next === '{' ||
                (next === '::' && marks[i + 2]?.leaf.v === '<')) names.add(leaf.v);
        }
    }
    return [...names].sort(codeUnitCompare);
}

const WORD = /[\p{L}\p{N}_]+/gu;
const WHOLE_WORD = /^[\p{L}\p{N}_]+$/u;

/**
 * The words (identifier-like runs) of the text the calls pass analyzes for
 * these regions: the kept source around them (units and their headers) and
 * every expansion's tokens. A call record derived from that text can bear no
 * other name, so a file whose calls are not derived yet needs deriving only
 * for a name among them (fix #375). Space-separated, sorted.
 */
function expansionWords(content, regions) {
    const words = new Set();
    for (const [start, end] of analysisUnits(regions, 'calls').keep) {
        for (const word of content.slice(start, end).match(WORD) || []) words.add(word);
    }
    // A record's name is an identifier token (string contents never are;
    // a non-ASCII identifier is a 'punct' leaf).
    for (const region of regions) {
        for (const mark of region.layout.marks) {
            const leaf = mark.leaf;
            if (leaf.k === 'ident' || (leaf.k === 'punct' && WHOLE_WORD.test(leaf.v))) words.add(leaf.v);
        }
    }
    return [...words].sort(codeUnitCompare).join(' ');
}

/** Whether the derived calls of a file pending derivation can bear `name`. */
const pendingWordSets = new WeakMap();
function rustPendingMayBear(fileEntry, name) {
    const rec = fileEntry?.rustMacroExpansion;
    if (!rec?.callsPending) return false;
    if (typeof rec.words !== 'string') return true;
    let words = pendingWordSets.get(rec);
    if (!words) pendingWordSets.set(rec, words = new Set(rec.words.split(' ')));
    // A raw identifier's token is `r#name`; source text holds both parts.
    return words.has(name) || words.has(String(name).replace(/^r#/, '')) || words.has(`r#${name}`);
}

function tokenText(tokens) {
    return flatten(tokens).map(leaf => leaf.v).join(' ');
}

// ── Build pass ────────────────────────────────────────────────────────────

/** Project macro names a file's call records invoke. */
function invokedMacroNames(index, filePath, inventory) {
    const calls = index.callsCache.get(filePath)?.calls;
    if (!Array.isArray(calls)) return [];
    const names = new Set();
    for (const call of calls) {
        if (call.isMacro && !call.macroExpansion && inventory.has(call.name)) names.add(call.name);
    }
    return [...names].sort(codeUnitCompare);
}

function signatureFor(state, filePath, names) {
    const index = state.index;
    const hash = crypto.createHash('md5');
    hash.update(index.files.get(filePath)?.hash || '');
    for (const name of names) {
        for (const def of state.inventory.get(name) || []) {
            const entry = index.files.get(def.file);
            hash.update(`\n${name}\0${def.relativePath}\0${def.startLine}\0${def.endLine}\0${entry?.hash || ''}`);
        }
    }
    // Module ancestry decides textual scope; crate roots decide path scope.
    const parents = moduleParents(state);
    let current = filePath;
    const seen = new Set();
    while (parents.has(current) && !seen.has(current)) {
        seen.add(current);
        const link = parents.get(current);
        current = link.file;
        hash.update(`\n^${path.relative(index.root, current)}\0${link.line}\0${link.macroUse ? 1 : 0}\0` +
            `${index.files.get(current)?.hash || ''}`);
    }
    return hash.digest('hex');
}

/**
 * Build-time pass, phase 1 (before the import graph): Rust files whose
 * persisted expansion is missing or stale. An expanded file is re-parsed
 * (`reindex`) so phase 2 starts from its parser facts.
 */
function planRustMacroExpansion(index, { reindex = null, files = null } = {}) {
    const rustFiles = [];
    for (const [file, entry] of index.files) {
        if (isRust(entry) && (!files || files.includes(file))) rustFiles.push(file);
    }
    if (rustFiles.length === 0) return [];
    const state = createState(index);
    const pending = [];
    for (const file of rustFiles) {
        const entry = index.files.get(file);
        const rec = entry.rustMacroExpansion;
        const names = state.inventory.size > 0 ? invokedMacroNames(index, file, state.inventory) : [];
        if (names.length === 0 && !rec) continue;
        if (rec && names.length > 0 && names.join(',') === (rec.callNames || []).join(',') &&
            signatureFor(state, file, mergedNames(names, rec.nested)) === rec.signature) continue;
        pending.push(file);
    }
    for (const file of pending) {
        const rec = index.files.get(file)?.rustMacroExpansion;
        if (rec?.expanded && reindex) reindex(file);
        const entry = index.files.get(file);
        if (entry) delete entry.rustMacroExpansion;
    }
    return pending;
}

function mergedNames(names, nested) {
    return [...new Set([...names, ...(nested || [])])].sort(codeUnitCompare);
}

/** Planned files that invoke a project macro (from their call records). */
function invokingFiles(index, pending, inventory, names) {
    return pending.filter(file => {
        if (!index.files.has(file)) return false;
        const invoked = invokedMacroNames(index, file, inventory);
        names.set(file, invoked);
        return invoked.length > 0;
    });
}

/**
 * Build-time pass, phase 2a (fix #375): start expanding the planned files in
 * worker threads while the caller builds the import graph. The workers
 * resolve module ancestry from the `mod` declarations alone (the only import
 * facts expansion reads), so their records equal an in-place expansion after
 * the graph. Returns a handle for applyRustMacroExpansion (null when there is
 * nothing to expand; `results` null when the files expand in place).
 */
function startRustMacroExpansion(index, pending, options = {}) {
    if (!pending || pending.length === 0) return null;
    const inventory = macroInventory(index);
    if (inventory.size === 0) return { inventory, files: [], results: null };
    const names = new Map();
    const files = invokingFiles(index, pending, inventory, names);
    let bytes = 0;
    for (const file of files) bytes += index.files.get(file)?.size || 0;
    const run = files.length >= PARALLEL_MIN_FILES && bytes >= PARALLEL_MIN_BYTES
        ? startWorkers(index, files, { ...options, inventory }) : null;
    return { inventory, files, names, results: run };
}

/**
 * Build-time pass, phase 2b (after the import graph resolved `mod`
 * declarations): apply the expansions of the planned files, expanding in
 * place what no worker returned. Returns false when nothing expanded, else
 * { files, names }: the files whose symbols were replaced and the symbol
 * names involved.
 */
function applyRustMacroExpansion(index, pending, options = {}, started = undefined) {
    const run = started === undefined ? startRustMacroExpansion(index, pending, options) : started;
    if (!run) return false;
    let results;
    try {
        results = run.results ? run.results.collect() : null;
    } finally {
        run.results?.dispose();
    }
    if (run.files.length === 0) return false;
    const state = createState(index, run.inventory);
    // What the expansions changed: the files whose symbols were replaced and
    // the symbol names involved (the caller re-canonicalizes only those).
    let touched = null;
    for (const file of run.files) {
        const entry = index.files.get(file);
        // Symbols-mode expansion never changes call records.
        const callNames = run.names?.get(file) || invokedMacroNames(index, file, state.inventory);
        let rec = results?.get(file);
        if (!rec) {
            rec = expandFile(state, file) || { sites: 0, blind: [], used: new Map(), expanded: false };
            rec = { ...rec, usedNames: [...rec.used.values()].map(def => def.name) };
        }
        if (rec.symbols) {
            touched ||= { files: new Set(), names: new Set() };
            touched.files.add(file);
            for (const symbol of entry.symbols) touched.names.add(symbol.name);
            applyGeneratedSymbols(index, file, rec.symbols);
            for (const symbol of entry.symbols) touched.names.add(symbol.name);
        }
        if (rec.expanded && !touched) touched = { files: new Set(), names: new Set() };
        const nested = [...new Set(rec.usedNames || [])]
            .filter(name => !callNames.includes(name)).sort(codeUnitCompare);
        entry.rustMacroExpansion = {
            signature: signatureFor(state, file, mergedNames(callNames, nested)),
            callNames,
            ...(nested.length > 0 && { nested }),
            sites: rec.sites,
            ...(rec.blind.length > 0 && { blind: rec.blind.sort((a, b) => a.line - b.line ||
                codeUnitCompare(a.macro, b.macro) || codeUnitCompare(a.reason, b.reason)) }),
            ...(rec.expanded && { expanded: true }),
            ...(rec.callsPending && { callsPending: true, calleeNames: rec.calleeNames || [], words: rec.words }),
        };
    }
    return touched || false;
}

// Parse workers kept for expansion pay for themselves from a few files of
// expansion work; the job is posted while the import graph builds.
const PARALLEL_MIN_FILES = 2;
const PARALLEL_MIN_BYTES = 32 * 1024;
// Parse workers a parallel build keeps for expansion (fix #388). Their parser
// code is already optimized, so a few of them finish the largest invoking
// files about as fast as more fresh threads would, at a fraction of the CPU
// (measured on ripgrep, tokio, rayon, axum, hyper, cargo, clap).
const EXPANSION_WORKERS = 3;

/**
 * What a worker needs to expand `workload` without the index: the module
 * tree (every Rust file's `mod` declarations, resolved, and module symbols),
 * the macro definitions (their text is read from disk), and for the files
 * to expand their import facts, impl/trait spans and macro invocation
 * records. Also every name a project callable bears.
 */
function workerSnapshot(index, workload, inventory) {
    const expanding = new Set(workload);
    // Invocations resolve at the invoking file, and nested ones also at the
    // defining file.
    const resolving = new Set(workload);
    for (const defs of inventory.values()) for (const def of defs) resolving.add(def.file);
    const files = [];
    const macros = [];
    for (const [file, entry] of index.files) {
        if (!isRust(entry)) continue;
        const full = expanding.has(file);
        const resolves = resolving.has(file);
        // Module ancestry reads `mod` declarations (and the module symbols'
        // attributes); resolution at a file also reads its glob imports and
        // the `use` bindings that can name a macro; expansion reads the
        // invoking file's impl/trait spans and project macro invocations.
        const record = {
            path: file, relativePath: entry.relativePath, language: 'rust',
            importDetails: (entry.importDetails || []).filter(detail => detail.type === 'mod' ||
                (resolves && detail.type === 'use-glob')),
            symbols: (entry.symbols || []).filter(symbol => symbol.type === 'module' ||
                (full && (symbol.type === 'impl' || symbol.type === 'trait')))
                .map(symbol => ({
                    name: symbol.name, type: symbol.type, startLine: symbol.startLine, endLine: symbol.endLine,
                    modifiers: symbol.modifiers || [],
                })),
        };
        if (resolves) {
            record.importBindings = (entry.importBindings || [])
                .filter(binding => inventory.has(binding.alias || binding.name));
        }
        if (full) {
            record.calls = (index.callsCache.get(file)?.calls || [])
                .filter(call => call.isMacro && !call.macroExpansion && inventory.has(call.name))
                .map(call => ({
                    name: call.name, line: call.line, callStart: call.callStart, callEnd: call.callEnd,
                    isMacro: true,
                    ...(call.inMacro && { inMacro: true }),
                    ...(call.macroExpr && { macroExpr: true }),
                    ...(call.isPathMacro && { isPathMacro: true, receiver: call.receiver }),
                    ...(call.enclosingFunction && { enclosingFunction: { name: call.enclosingFunction.name } }),
                }));
        }
        files.push(record);
        for (const symbol of entry.symbols || []) {
            if (symbol.type === 'macro') {
                macros.push({ name: symbol.name, type: 'macro', file, relativePath: symbol.relativePath,
                    startLine: symbol.startLine, endLine: symbol.endLine, modifiers: symbol.modifiers || [],
                    ...(symbol.macroScope && { macroScope: symbol.macroScope }) });
            }
        }
    }
    // Callee-position macros expand where an argument word names a project
    // callable: the workers see every such name.
    const callable = [];
    for (const [name, defs] of index.symbols) {
        if (defs.some(def => !NON_CALLABLE_DEF_TYPES.has(def.type))) callable.push(name);
    }
    return {
        root: index.root, files, macros, callableNames: callable,
        // `mod` declarations resolve in the worker, with this build's view
        // of the workspace manifests.
        config: { aliases: index.config?.aliases, includePaths: index.config?.includePaths },
        cargoManifests: Array.isArray(index.cargoManifests) ? index.cargoManifests : null,
    };
}

/** An index-shaped view of a worker snapshot (what createState reads). */
function snapshotIndex(snapshot) {
    const { rustModuleDeclarationsResolved, seedWorkspaceManifests } = require('./imports');
    if (snapshot.cargoManifests) seedWorkspaceManifests(snapshot.root, snapshot.cargoManifests);
    const files = new Map();
    const callsCache = new Map();
    const view = { root: snapshot.root, config: snapshot.config || {}, files };
    for (const file of snapshot.files) {
        files.set(file.path, file);
        if (file.calls) callsCache.set(file.path, { calls: file.calls });
        let resolved = null;
        Object.defineProperty(file, 'moduleResolved', {
            get: () => (resolved ||= rustModuleDeclarationsResolved(view, file.path, file)),
        });
    }
    const symbols = new Map();
    for (const def of snapshot.macros) {
        if (!symbols.has(def.name)) symbols.set(def.name, []);
        symbols.get(def.name).push(def);
    }
    let callable = null;
    return {
        root: snapshot.root, files, callsCache, symbols,
        callableNames: {
            has: word => (callable ||= new Set(snapshot.callableNames || [])).has(word),
        },
        _readFile: file => fs.readFileSync(file, 'utf-8'),
    };
}

/**
 * Worker-side: expand the files of a shared queue (`files`, next index at
 * `signal[queueIndex]`), posting each record to `port`; `signal[workerIndex]`
 * is set when this worker is done.
 */
function runExpansionQueue({ snapshot, files, signal, workerIndex, queueIndex }, port) {
    const signalArray = new Int32Array(signal);
    try {
        const state = createState(snapshotIndex(JSON.parse(Buffer.from(snapshot).toString('utf8'))));
        for (;;) {
            const next = Atomics.add(signalArray, queueIndex, 1);
            if (next >= files.length) break;
            const file = files[next];
            let result;
            try {
                result = { file, record: expandForWorker(state, file) };
            } catch (error) {
                result = { file, error: error.message };
            }
            port.postMessage([result]);
        }
    } finally {
        Atomics.store(signalArray, workerIndex, 1);
        Atomics.notify(signalArray, workerIndex);
    }
}

/** Worker-side: symbols-mode expansion of one file, as plain records. */
function expandForWorker(state, filePath) {
    const rec = expandFile(state, filePath) || { sites: 0, blind: [], used: new Map(), expanded: false };
    return {
        sites: rec.sites, blind: rec.blind, expanded: rec.expanded,
        usedNames: [...rec.used.values()].map(def => def.name),
        ...(rec.symbols && { symbols: rec.symbols }),
        ...(rec.callsPending && { callsPending: true, calleeNames: rec.calleeNames, words: rec.words }),
    };
}

/**
 * Start expanding `files` in the parse workers the build kept for it
 * (largest first from a shared queue). Returns { collect(), dispose() }, or
 * null without kept workers (a sequential build expands in place, where the
 * parser is already optimized); collect() blocks until the workers finish
 * and returns Map<file, record> (files a worker failed on are expanded in
 * place by the caller).
 */
function startWorkers(index, files, options = {}) {
    const pool = options.pool?.available.length > 0 ? options.pool : null;
    if (!pool) return null;
    const { receiveMessageOnPort } = require('worker_threads');
    const count = Math.min(pool.available.length, EXPANSION_WORKERS, Math.ceil(files.length / 2));
    if (count < 1) return null;
    const ordered = [...files].sort((a, b) => (index.files.get(b)?.size || 0) - (index.files.get(a)?.size || 0) ||
        codeUnitCompare(a, b));
    // One serialization shared by every worker (a structured clone per
    // worker cost more than the expansion on large workspaces).
    const encoded = Buffer.from(JSON.stringify(workerSnapshot(index, files, options.inventory)), 'utf8');
    const snapshot = new SharedArrayBuffer(encoded.length);
    encoded.copy(Buffer.from(snapshot));
    const sab = new SharedArrayBuffer(4 * (count + 1));
    const signal = new Int32Array(sab);
    const ports = [];
    for (let i = 0; i < count; i++) {
        const worker = pool.available[i];
        ports.push(pool.ports[worker]);
        pool.post(worker, { snapshot, files: ordered, signal: sab, workerIndex: i, queueIndex: count });
    }
    // Kept workers this job does not need end now.
    for (const worker of pool.available.slice(count)) pool.retire(worker);
    // The kept workers belong to the build, which ends them.
    const dispose = () => {};
    const collect = () => {
        const deadline = Date.now() + 300000;
        let timedOut = false;
        for (let i = 0; i < count; i++) {
            while (Atomics.load(signal, i) === 0) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) { timedOut = true; break; }
                Atomics.wait(signal, i, 0, Math.min(remaining, 5000));
            }
            if (timedOut) break;
        }
        const results = new Map();
        for (const port of ports) {
            for (let msg = receiveMessageOnPort(port); msg; msg = receiveMessageOnPort(port)) {
                for (const result of msg.message) {
                    if (!result.error) results.set(result.file, result.record);
                }
            }
        }
        return results;
    };
    return { collect, dispose, usesPool: true, workerCount: count };
}

/**
 * Call records of a Rust file whose expansions' calls are not derived yet
 * (the build derives generated declarations; calls follow on first use and
 * are then persisted). `materialize: false` (callee index upkeep) returns the
 * parsed records plus name-only entries for every name the expansions can
 * call, without expanding.
 */
function rustExpandedCalls(index, filePath, rawCalls, { materialize = true } = {}) {
    const rec = index.files.get(filePath)?.rustMacroExpansion;
    if (!rec?.callsPending || !Array.isArray(rawCalls)) return rawCalls;
    const hints = (rec.calleeNames || []).map(name => ({ name, line: 0, calleeHint: true }));
    if (!materialize) return hints.length > 0 ? rawCalls.concat(hints) : rawCalls;
    if (!index._rustMacroState) index._rustMacroState = createState(index);
    if (index.calleeIndex && hints.length > 0) index._removeFromCalleeIndex(filePath, hints);
    rec.callsPending = false;
    try {
        expandFile(index._rustMacroState, filePath, 'calls');
    } catch (error) {
        rec.callsPending = true;
        throw error;
    }
    delete rec.words;
    index.macroExpansionDirty = true;
    return index.callsCache.get(filePath)?.calls || rawCalls;
}

/** Derive every pending file's expansion calls (whole-program consumers). */
function materializeRustMacroCalls(index) {
    for (const [filePath, entry] of index.files) {
        if (!entry.rustMacroExpansion?.callsPending) continue;
        const cached = index.callsCache.get(filePath);
        if (cached) rustExpandedCalls(index, filePath, cached.calls);
    }
}

/** Expanded and blind invocation sites, for health and deadcode disclosure. */
function rustMacroExpansionSummary(index) {
    const summary = { sites: 0, files: 0, blind: { count: 0, fileCount: 0, files: [], sample: [], reasons: {} } };
    const files = [...index.files.values()].filter(entry => entry.rustMacroExpansion)
        .sort((a, b) => codeUnitCompare(a.relativePath, b.relativePath));
    for (const entry of files) {
        const rec = entry.rustMacroExpansion;
        summary.sites += rec.sites || 0;
        if (rec.expanded) summary.files++;
        const blind = rec.blind || [];
        if (blind.length === 0) continue;
        summary.blind.count += blind.length;
        summary.blind.fileCount++;
        if (summary.blind.files.length < 10) summary.blind.files.push(entry.relativePath);
        for (const site of blind) {
            const reason = site.reason.startsWith('nested:') ? 'nested' : site.reason;
            summary.blind.reasons[reason] = (summary.blind.reasons[reason] || 0) + 1;
            if (summary.blind.sample.length < BLIND_SAMPLE) {
                summary.blind.sample.push({ file: entry.relativePath, ...site });
            }
        }
    }
    return summary;
}

module.exports = {
    EXPANSION_WORKERS,
    planRustMacroExpansion,
    startRustMacroExpansion,
    // worker-side (core/build-worker.js)
    runExpansionQueue,
    applyRustMacroExpansion,
    rustExpandedCalls,
    materializeRustMacroCalls,
    rustMacroExpansionSummary,
    rustPendingMayBear,
};
