/**
 * core/rust-modules.js - Rust module tree (fix #377).
 *
 * Every Rust source file belongs to exactly one module of one crate: crate
 * roots are the files no `mod` declaration loads, and a declared file's
 * module path is its parent's path plus the enclosing inline modules plus
 * the declared name. Inline `mod NAME { ... }` blocks are modules too.
 *
 * `rustPathModule` resolves the qualifier of a path call (`crate::a::b`,
 * `super::super`, `self::inner`, `net::conn`) from the call site's own
 * module to the module entries (file + inline chain) that hold its items;
 * `rustModuleItems` lists the definitions of a name declared directly in
 * those modules. Anything the tree cannot prove (a `use` alias, an extern
 * crate, a type, a re-export) resolves to null: the caller keeps its other
 * evidence rules.
 */

'use strict';

const { rustModDeclarationFiles, rustInlineModules, rustInlineChainAt } = require('./imports');

const FUNCTION_KINDS = new Set(['function', 'method', 'constructor', 'static']);

function isRustEntry(entry) {
    return entry?.language === 'rust';
}

function moduleTree(index) {
    const memo = index._rustScopeMemo || (index._rustScopeMemo = new Map());
    const cached = memo.get('\x01rustModuleTree');
    if (cached) return cached;
    const parents = new Map(); // child file -> { file, chain, name }
    const inlineByFile = new Map();
    const exists = candidate => isRustEntry(index.files.get(candidate));
    for (const [file, entry] of index.files) {
        if (!isRustEntry(entry)) continue;
        const inline = rustInlineModules(entry);
        inlineByFile.set(file, inline);
        const declared = rustModDeclarationFiles(file, entry, exists, inline);
        if (declared.size === 0) continue;
        for (const detail of entry.importDetails || []) {
            if (detail.type !== 'mod' || !declared.has(detail.module)) continue;
            const chain = rustInlineChainAt(inline, detail.line);
            for (const child of declared.get(detail.module)) {
                if (child === file || parents.has(child)) continue;
                parents.set(child, { file, chain, name: detail.module });
            }
        }
    }
    const fileModules = new Map(); // file -> { root, segs }
    const moduleOf = (file, seen = new Set()) => {
        const hit = fileModules.get(file);
        if (hit) return hit;
        const parent = parents.get(file);
        let result;
        if (!parent || seen.has(file)) {
            result = { root: file, segs: [] };
        } else {
            seen.add(file);
            const up = moduleOf(parent.file, seen);
            result = { root: up.root, segs: [...up.segs, ...parent.chain, parent.name] };
        }
        fileModules.set(file, result);
        return result;
    };
    const entries = new Map(); // root \0 path -> [{ file, chain }]
    const add = (root, segs, file, chain) => {
        const key = `${root}\0${segs.join('::')}`;
        if (!entries.has(key)) entries.set(key, []);
        entries.get(key).push({ file, chain });
    };
    for (const [file, inline] of inlineByFile) {
        const own = moduleOf(file);
        add(own.root, own.segs, file, []);
        for (const mod of inline) {
            const chain = rustInlineChainAt(inline, mod.startLine);
            add(own.root, [...own.segs, ...chain], file, chain);
        }
    }
    const tree = { moduleOf, entries, inlineByFile };
    memo.set('\x01rustModuleTree', tree);
    return tree;
}

/**
 * Module entries a path qualifier names from (filePath, line), or null when
 * the qualifier is not provably a module path of this crate.
 * @returns {{ root: string, segs: string[], entries: Array<{file: string, chain: string[]}> }|null}
 */
function rustPathModule(index, filePath, line, qualifier) {
    if (!isRustEntry(index.files.get(filePath)) || !qualifier) return null;
    const segments = String(qualifier).split('::');
    if (segments.some(segment => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) return null;
    const tree = moduleTree(index);
    const own = tree.moduleOf(filePath);
    const current = [...own.segs, ...rustInlineChainAt(tree.inlineByFile.get(filePath) || [], line)];
    const has = segs => tree.entries.has(`${own.root}\0${segs.join('::')}`);
    let segs;
    let i = 0;
    if (segments[0] === 'crate') {
        segs = [];
        i = 1;
    } else if (segments[0] === 'self' || segments[0] === 'super') {
        segs = current;
        if (segments[0] === 'self') i = 1;
        while (segments[i] === 'super') {
            if (segs.length === 0) return null;
            segs = segs.slice(0, -1);
            i++;
        }
    } else {
        // A leading plain name is a child module of the current module; a
        // `use` binding, extern crate, or type is not the tree's to prove.
        segs = current;
    }
    for (; i < segments.length; i++) {
        const next = [...segs, segments[i]];
        if (!has(next)) return null;
        segs = next;
    }
    return { root: own.root, segs, entries: tree.entries.get(`${own.root}\0${segs.join('::')}`) || [] };
}

/**
 * Definitions of `name` declared as items directly in the resolved module
 * (not inside an impl, trait, nested inline module, or function body).
 */
function rustModuleItems(index, resolved, name) {
    if (!resolved?.entries?.length) return [];
    const tree = moduleTree(index);
    const out = [];
    for (const def of index.symbols.get(name) || []) {
        if (def.className || def.receiver || def.type === 'module' || def.type === 'field' ||
            def.type === 'macro' || def.type === 'impl') continue;
        const entry = resolved.entries.find(candidate => candidate.file === def.file);
        if (!entry) continue;
        const chain = rustInlineChainAt(tree.inlineByFile.get(def.file) || [], def.startLine);
        if (chain.length !== entry.chain.length || chain.some((part, k) => part !== entry.chain[k])) continue;
        const fileEntry = index.files.get(def.file);
        const nested = (fileEntry?.symbols || []).some(symbol => symbol !== def &&
            FUNCTION_KINDS.has(symbol.type) && symbol.startLine <= def.startLine &&
            symbol.endLine >= def.endLine && !(symbol.startLine === def.startLine && symbol.name === def.name));
        if (nested) continue;
        out.push(def);
    }
    return out;
}

module.exports = { rustPathModule, rustModuleItems };
