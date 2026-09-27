'use strict';

/**
 * Rust declarative macros (`macro_rules!`) as a token-tree rewriting engine
 * (fix #374).
 *
 * A `macro_rules!` rule is matcher => transcriber over token trees. The
 * grammar keeps both sides, and every invocation argument, as token trees:
 * tree-sitter never parses what an invocation expands to, so functions,
 * impls and calls a project macro generates are invisible to the AST. This
 * module performs macro-by-example the way rustc's mbe does, over the leaves
 * tree-sitter produced:
 *
 *   tokensOf(tokenTree)       - token trees of an invocation (leaf tokens +
 *                               delimited groups; comments dropped)
 *   compileMacro(definition)  - rules from a `macro_definition` node
 *   expandWithRules(...)      - first rule whose matcher accepts the input,
 *                               transcribed (fragments, nested repetitions,
 *                               separators, `$crate`)
 *
 * Fragment specifiers are recognized by the token extent the Rust grammar
 * gives them (a type stops at a top-level `=>`/`,`/`;`, an expression at
 * `,`/`;`/`=>` outside closure parameters and generic arguments, an item at
 * its body or `;`), which is what rustc's follow-set rules guarantee. The
 * caller parses the transcribed stream with tree-sitter in the invocation's
 * syntactic context; this module never classifies code.
 *
 * Tokens carry their origin: `src: 'arg'` tokens were written in the
 * invocation (their source offset, line and column survive every rewrite),
 * `src: 'tpl'` tokens came from a transcriber (`ctx` identifies the
 * expansion step for hygiene).
 */

class MacroBlind extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

const LITERAL_TYPES = new Set([
    'integer_literal', 'float_literal', 'string_literal', 'raw_string_literal',
    'char_literal', 'boolean_literal',
]);
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);
const IDENT_TEXT = /^(?:r#)?[A-Za-z_][A-Za-z0-9_]*$/;
const CLOSERS = { '(': ')', '[': ']', '{': '}' };

function leafKind(node, text) {
    if (LITERAL_TYPES.has(node.type) || text === 'true' || text === 'false') return 'lit';
    if (IDENT_TEXT.test(text)) return 'ident';
    return 'punct';
}

/**
 * Token list of one token_tree / token_tree_pattern's contents (outer
 * delimiters excluded). `origin(node)` returns the origin fields for a leaf.
 * Metavariables and repetitions (definition side) are returned as
 * {k:'meta'} / {k:'rep'} placeholders for the compilers below.
 */
function tokensOf(tree, origin) {
    const out = [];
    // One batched read of the children (per-index child() calls cross the
    // native boundary once each).
    const children = tree.children || Array.from({ length: tree.childCount }, (_, i) => tree.child(i));
    const count = children.length;
    for (let i = 1; i < count - 1; i++) {
        const child = children[i];
        const type = child.type;
        if (COMMENT_TYPES.has(type)) continue;
        if (type === 'token_tree' || type === 'token_tree_pattern') {
            out.push(groupOf(child, origin));
            continue;
        }
        if (type === 'token_repetition' || type === 'token_repetition_pattern' ||
            type === 'token_binding_pattern') {
            out.push({ k: 'meta', node: child });
            continue;
        }
        if (type === 'metavariable') {
            out.push({ k: 'meta', node: child });
            continue;
        }
        if (type === 'ERROR') throw new MacroBlind('token-error');
        const text = child.text;
        // `'a` is two grammar leaves inside token trees.
        if (text === "'" && i + 1 < count - 1) {
            const next = children[i + 1];
            if (next.type === 'identifier' && next.startIndex === child.endIndex) {
                out.push({ k: 'lifetime', v: `'${next.text}`, ...origin(child, next) });
                i++;
                continue;
            }
        }
        // Any other node (compound literal-like nodes included) is one token.
        out.push({ k: leafKind(child, text), v: text, ...origin(child) });
    }
    return out;
}

function groupOf(node, origin) {
    const open = node.firstChild;
    const close = node.lastChild;
    const d = open ? open.text : '(';
    if (!CLOSERS[d]) throw new MacroBlind('token-error');
    return {
        k: 'group', v: d, d,
        c: tokensOf(node, origin),
        ...origin(open),
        closeOrigin: close ? origin(close) : null,
    };
}

/**
 * tokensOf(tokenTree, origin) for an invocation's argument token tree, read
 * with one tree cursor (fix #375): the same tokens and origins
 * (`src: 'arg'`, source offsets, line and column) without materializing a
 * node object per leaf. `lineStarts` are the source's line start offsets
 * (tree-sitter columns are code-unit offsets within the line).
 */
function argTokensOf(tokenTree, source, lineStarts) {
    const cursor = tokenTree.walk();
    return argTokensAt(cursor, source, lineStarts);
}

function argOriginAt(s, e, lineStarts) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return { src: 'arg', s, e, line: lo + 1, col: s - lineStarts[lo] };
}

/** Children of the cursor's node, in order (the cursor is left on it). */
function cursorChildren(cursor, source, lineStarts) {
    const kids = [];
    if (!cursor.gotoFirstChild()) return kids;
    do {
        const type = cursor.nodeType;
        const kid = { type, s: cursor.startIndex, e: cursor.endIndex };
        if (type === 'token_tree' || type === 'token_tree_pattern') {
            kid.group = argGroupAt(cursor, source, lineStarts);
        } else if (type === 'token_repetition' || type === 'token_repetition_pattern' ||
            type === 'token_binding_pattern' || type === 'metavariable') {
            kid.node = cursor.currentNode;
        }
        kids.push(kid);
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
    return kids;
}

function argGroupAt(cursor, source, lineStarts) {
    const kids = cursorChildren(cursor, source, lineStarts);
    const open = kids[0];
    const close = kids[kids.length - 1];
    const d = open ? source.slice(open.s, open.e) : '(';
    if (!CLOSERS[d]) throw new MacroBlind('token-error');
    return {
        k: 'group', v: d, d,
        c: argTokenList(kids, source, lineStarts),
        ...argOriginAt(open.s, open.e, lineStarts),
        closeOrigin: close ? argOriginAt(close.s, close.e, lineStarts) : null,
    };
}

function argTokensAt(cursor, source, lineStarts) {
    return argTokenList(cursorChildren(cursor, source, lineStarts), source, lineStarts);
}

function argTokenList(kids, source, lineStarts) {
    const out = [];
    const count = kids.length;
    for (let i = 1; i < count - 1; i++) {
        const child = kids[i];
        const type = child.type;
        if (COMMENT_TYPES.has(type)) continue;
        if (child.group) {
            out.push(child.group);
            continue;
        }
        if (child.node) {
            out.push({ k: 'meta', node: child.node });
            continue;
        }
        if (type === 'ERROR') throw new MacroBlind('token-error');
        const text = source.slice(child.s, child.e);
        // `'a` is two grammar leaves inside token trees.
        if (text === "'" && i + 1 < count - 1) {
            const next = kids[i + 1];
            if (next.type === 'identifier' && next.s === child.e) {
                out.push({ k: 'lifetime', v: `'${source.slice(next.s, next.e)}`, ...argOriginAt(child.s, next.e, lineStarts) });
                i++;
                continue;
            }
        }
        out.push({ k: leafKindOf(type, text), v: text, ...argOriginAt(child.s, child.e, lineStarts) });
    }
    return out;
}

function leafKindOf(type, text) {
    if (LITERAL_TYPES.has(type) || text === 'true' || text === 'false') return 'lit';
    if (IDENT_TEXT.test(text)) return 'ident';
    return 'punct';
}

// ── Definition compilation ────────────────────────────────────────────────

const FRAGMENTS = new Set([
    'ident', 'expr', 'expr_2021', 'ty', 'path', 'tt', 'block', 'pat', 'pat_param',
    'literal', 'lifetime', 'vis', 'item', 'meta', 'stmt',
]);

/** Children of a repetition node: items between `(`…`)`, separator, op. */
function repetitionParts(node) {
    let open = -1;
    let close = -1;
    let depth = 0;
    for (let i = 0; i < node.childCount; i++) {
        const t = node.child(i).type;
        if (t === '(' && open < 0) { open = i; depth = 1; continue; }
        if (open >= 0 && close < 0) {
            if (t === '(') depth++;
            else if (t === ')') {
                depth--;
                if (depth === 0) { close = i; break; }
            }
        }
    }
    if (open < 0 || close < 0) throw new MacroBlind('definition-shape');
    const opNode = node.child(node.childCount - 1);
    const op = opNode?.text;
    if (op !== '*' && op !== '+' && op !== '?') throw new MacroBlind('definition-shape');
    // The grammar keeps the separator as a hidden token: read it from the
    // source span between `)` and the operator.
    const text = node.text;
    const base = node.startIndex;
    const sep = text.slice(node.child(close).endIndex - base, opNode.startIndex - base).trim();
    if (/\s/.test(sep)) throw new MacroBlind('definition-shape');
    return { open, close, op, sep: sep.length > 0 ? sep : null };
}

function compileMatcherTokens(tokens) {
    const items = [];
    for (const tok of tokens) {
        if (tok.k === 'group') {
            items.push({ t: 'group', d: tok.d, items: compileMatcherTokens(tok.c) });
        } else if (tok.k === 'meta') {
            const node = tok.node;
            if (node.type === 'token_binding_pattern') {
                const name = node.childForFieldName?.('name')?.text ||
                    node.namedChildren.find(c => c.type === 'metavariable')?.text;
                const kind = node.namedChildren.find(c => c.type === 'fragment_specifier')?.text;
                if (!name || !kind || !FRAGMENTS.has(kind)) throw new MacroBlind('fragment-kind');
                items.push({ t: 'frag', name: name.slice(1), kind });
            } else if (node.type === 'token_repetition_pattern') {
                const parts = repetitionParts(node);
                const inner = [];
                for (let i = parts.open + 1; i < parts.close; i++) {
                    const child = node.child(i);
                    inner.push(child);
                }
                const innerTokens = tokensOfNodes(inner);
                const sub = compileMatcherTokens(innerTokens);
                items.push({ t: 'rep', items: sub, op: parts.op, sep: parts.sep, vars: declaredVars(sub) });
            } else if (node.type === 'metavariable') {
                // `$crate` or a bare `$x` in a matcher: matches that token.
                items.push({ t: 'tok', v: node.text });
            } else {
                throw new MacroBlind('definition-shape');
            }
        } else {
            items.push({ t: 'tok', v: tok.v });
        }
    }
    return items;
}

/** Token list from a list of sibling nodes (repetition bodies). */
function tokensOfNodes(nodes) {
    return tokensOf({ children: [null, ...nodes, null] }, templateOrigin);
}

function declaredVars(items, out = new Set()) {
    for (const item of items) {
        if (item.t === 'frag') out.add(item.name);
        else if (item.t === 'group' || item.t === 'rep') declaredVars(item.items, out);
    }
    return out;
}

function templateOrigin(node, endNode) {
    return {
        line: node.startPosition.row + 1,
        col: node.startPosition.column,
        ...(endNode && { e: endNode.endIndex }),
    };
}

function compileTranscriberTokens(tokens) {
    const items = [];
    for (const tok of tokens) {
        if (tok.k === 'group') {
            items.push({
                t: 'group', d: tok.d, line: tok.line, col: tok.col,
                items: compileTranscriberTokens(tok.c),
            });
        } else if (tok.k === 'meta') {
            const node = tok.node;
            if (node.type === 'metavariable') {
                const name = node.text.slice(1);
                items.push(name === 'crate' ? { t: 'crate', line: node.startPosition.row + 1 }
                    : { t: 'var', name });
            } else if (node.type === 'token_repetition') {
                const parts = repetitionParts(node);
                const inner = [];
                for (let i = parts.open + 1; i < parts.close; i++) inner.push(node.child(i));
                const sub = compileTranscriberTokens(tokensOfNodes(inner));
                items.push({ t: 'rep', items: sub, op: parts.op, sep: parts.sep, vars: usedVars(sub) });
            } else {
                throw new MacroBlind('definition-shape');
            }
        } else {
            items.push({ t: 'tok', tok: { k: tok.k, v: tok.v, line: tok.line, col: tok.col } });
        }
    }
    return items;
}

function usedVars(items, out = new Set()) {
    for (const item of items) {
        if (item.t === 'var') out.add(item.name);
        else if (item.t === 'group' || item.t === 'rep') usedVars(item.items, out);
    }
    return out;
}

/**
 * Rules of a `macro_definition` node. Throws MacroBlind for a definition
 * whose shape the engine does not model.
 */
function compileMacro(definition) {
    const rules = [];
    for (const rule of definition.namedChildren) {
        if (rule.type !== 'macro_rule') continue;
        const left = rule.childForFieldName('left') ||
            rule.namedChildren.find(c => c.type === 'token_tree_pattern');
        const right = rule.childForFieldName('right') ||
            rule.namedChildren.find(c => c.type === 'token_tree');
        if (!left || !right) throw new MacroBlind('definition-shape');
        const matcher = compileMatcherTokens(tokensOf(left, templateOrigin));
        const transcriber = compileTranscriberTokens(tokensOf(right, templateOrigin));
        const fragments = new Map();
        collectFragmentKinds(matcher, fragments);
        rules.push({ matcher, transcriber, fragments, line: rule.startPosition.row + 1 });
    }
    if (rules.length === 0) throw new MacroBlind('definition-shape');
    const shape = transcriberShape(rules);
    return { rules, passThroughItems: rules.every(isPassThroughItems), ...shape };
}

const ITEM_KEYWORDS = new Set(['fn', 'impl', 'struct', 'enum', 'trait', 'mod', 'union']);

/**
 * What a macro's transcribers can change in the code they expand to, beyond
 * the token-tree view the parser already has of an invocation:
 *   declares     - items (functions, impls, types, modules, consts)
 *   bindsArgs    - argument fragments bound as locals or parameters
 *                  (`let $x`, `|$x|`, `fn f($($arg)*)`, `for $x in`), so
 *                  the argument code is typed in a new context
 *   forwardsValue- the value is an argument fragment (`{ ..; $e }`)
 *   invokes      - macro names the transcribers invoke
 */
function transcriberShape(rules) {
    let declares = false;
    let bindsArgs = false;
    let callsArgs = false;
    let forwardsValue = false;
    const invokes = new Set();
    const hasVar = items => items.some(item => item.t === 'var' ||
        ((item.t === 'group' || item.t === 'rep') && hasVar(item.items)));
    const flat = items => items.flatMap(item => (item.t === 'rep' ? flat(item.items) : [item]));
    const walk = (items, depth = 0) => {
        const list = flat(items);
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.t === 'group') { walk(item.items, depth + 1); continue; }
            // An argument placed where a callee's name goes (`$f(..)`,
            // `x.$m(..)`, `$m!(..)`): the invocation's text never shows it
            // as a call. (A qualifier, `$t::f(..)`, calls the template's `f`,
            // which the definition already shows.)
            if (item.t === 'var') {
                const after = list[i + 1];
                if ((after?.t === 'group' && after.d === '(') ||
                    (after?.t === 'tok' && after.tok.v === '!')) callsArgs = true;
                continue;
            }
            if (item.t !== 'tok') continue;
            const v = item.tok.v;
            const next = list[i + 1];
            const after = list[i + 2];
            const namedBy = expect => (next?.t === 'var' || (next?.t === 'tok' && next.tok.k === 'ident')) &&
                after?.t === 'tok' && expect.includes(after.tok.v);
            // (A const/static/type inside a block is local: no symbol.)
            if (ITEM_KEYWORDS.has(v)) declares = true;
            else if (depth === 0 && (v === 'const' || v === 'static') && namedBy([':'])) declares = true;
            else if (depth === 0 && v === 'type' && namedBy(['=', ';', ':'])) declares = true;
            if (v === 'let' || v === 'for') {
                // pattern tokens up to `=` / `in`
                for (let j = i + 1; j < list.length; j++) {
                    const t = list[j];
                    if (t.t === 'tok' && (t.tok.v === '=' || t.tok.v === 'in' || t.tok.v === ';')) break;
                    if (t.t === 'var' || (t.t === 'group' && hasVar(t.items))) { bindsArgs = true; break; }
                }
            }
            if (v === '|') {
                for (let j = i + 1; j < list.length; j++) {
                    const t = list[j];
                    if (t.t === 'tok' && t.tok.v === '|') break;
                    if (t.t === 'var') { bindsArgs = true; break; }
                }
            }
            if (v === '!' && list[i - 1]?.t === 'tok' && list[i - 1].tok.k === 'ident' && next?.t === 'group') {
                invokes.add(list[i - 1].tok.v);
            }
        }
    };
    const usedKinds = (items, kinds, out = new Set()) => {
        for (const item of items) {
            if (item.t === 'var' && kinds.has(item.name)) out.add(kinds.get(item.name));
            else if (item.t === 'group' || item.t === 'rep') usedKinds(item.items, kinds, out);
        }
        return out;
    };
    for (const rule of rules) {
        walk(rule.transcriber);
        // Emitted `item` fragments declare; `stmt` fragments may bind.
        const kinds = usedKinds(rule.transcriber, rule.fragments);
        if (kinds.has('item')) declares = true;
        if (kinds.has('stmt')) bindsArgs = true;
        // Tail value: unwrap `{ .. }` blocks; the last statement is a lone fragment.
        let items = rule.transcriber;
        while (items.length === 1 && items[0].t === 'group' && items[0].d === '{') items = items[0].items;
        let tail = items.length;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].t === 'tok' && items[i].tok.v === ';') { tail = i; break; }
        }
        const last = tail === items.length ? items : items.slice(tail + 1);
        if (last.length === 1 && last[0].t === 'var') forwardsValue = true;
    }
    return { declares, bindsArgs, callsArgs, forwardsValue, invokes: [...invokes] };
}

function collectFragmentKinds(items, out) {
    for (const item of items) {
        if (item.t === 'frag') out.set(item.name, item.kind);
        else if (item.t === 'group' || item.t === 'rep') collectFragmentKinds(item.items, out);
    }
}

/**
 * A rule that re-emits its `item` fragments unchanged, adding only outer
 * attributes (`#[cfg(...)] $item`): the expansion declares exactly the
 * items written in the invocation.
 */
function isPassThroughItems(rule) {
    const kinds = rule.fragments;
    if (kinds.size === 0 || [...kinds.values()].some(kind => kind !== 'item')) return false;
    const walk = items => {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.t === 'var') continue;
            if (item.t === 'rep') {
                if (!walk(item.items)) return false;
                continue;
            }
            // `#` [`!`] `[...]` attribute
            if (item.t === 'tok' && item.tok.v === '#') {
                let j = i + 1;
                if (items[j]?.t === 'tok' && items[j].tok.v === '!') j++;
                if (items[j]?.t === 'group' && items[j].d === '[') {
                    i = j;
                    continue;
                }
            }
            return false;
        }
        return true;
    };
    return walk(rule.transcriber);
}

// ── Fragment extents ──────────────────────────────────────────────────────

const BINARY_OPS = new Set([
    '+', '-', '*', '/', '%', '^', '&', '|', '&&', '||', '<<', '>>', '==', '!=',
    '<', '>', '<=', '>=', '=', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=',
    '<<=', '>>=', '..', '..=', '!', '?', 'as', 'return', 'break', 'in', 'let',
    'move', 'if', 'else', 'match', 'while', 'for', 'loop', 'unsafe', 'async', 'await',
]);

const isTok = (tok, v) => tok && tok.k !== 'group' && tok.v === v;
const isGroup = (tok, d) => tok && tok.k === 'group' && (!d || tok.d === d);

/** End index of a balanced `<...>` starting at toks[j] === '<'. */
function skipAngles(toks, j) {
    let depth = 0;
    for (let i = j; i < toks.length; i++) {
        const t = toks[i];
        if (t.k === 'group') continue;
        if (t.v === '<') depth++;
        else if (t.v === '<<') depth += 2;
        else if (t.v === '>' || t.v === '>=') depth--;
        else if (t.v === '>>' || t.v === '>>=') depth -= 2;
        else if (t.v === ';' || t.v === '{') return -1;
        if (depth <= 0) return i + 1;
    }
    return -1;
}

const PATH_START = tok => tok && tok.k === 'ident' &&
    !['as', 'fn', 'impl', 'dyn', 'for', 'where', 'mut', 'const', 'static', 'let', 'if',
        'else', 'match', 'while', 'loop', 'in', 'return', 'break', 'continue', 'move',
        'unsafe', 'async', 'await', 'pub', 'struct', 'enum', 'trait', 'type', 'use', 'mod',
        'extern', 'ref'].includes(tok.v);

function scanPath(toks, j) {
    let i = j;
    if (isTok(toks[i], '::')) i++;
    if (!PATH_START(toks[i])) return -1;
    for (;;) {
        i++;
        if (isTok(toks[i], '<')) {
            const end = skipAngles(toks, i);
            if (end < 0) return -1;
            i = end;
        } else if (isTok(toks[i], '::') && isTok(toks[i + 1], '<')) {
            const end = skipAngles(toks, i + 1);
            if (end < 0) return -1;
            i = end;
        } else if (isGroup(toks[i], '(') && j < i) {
            // Fn(A, B) -> C sugar
            i++;
            if (isTok(toks[i], '->')) {
                const end = scanType(toks, i + 1);
                if (end < 0) return -1;
                i = end;
            }
        }
        if (isTok(toks[i], '::') && PATH_START(toks[i + 1])) {
            i++;
            continue;
        }
        return i;
    }
}

function scanBounds(toks, j) {
    let i = j;
    for (;;) {
        if (isTok(toks[i], '?')) i++;
        if (toks[i]?.k === 'lifetime') i++;
        else if (isGroup(toks[i], '(')) i++;
        else {
            if (isTok(toks[i], 'for') && isTok(toks[i + 1], '<')) {
                const end = skipAngles(toks, i + 1);
                if (end < 0) return -1;
                i = end;
            }
            const end = scanPath(toks, i);
            if (end < 0) return i === j ? -1 : i;
            i = end;
        }
        if (isTok(toks[i], '+')) {
            i++;
            continue;
        }
        return i;
    }
}

function scanType(toks, j) {
    const t = toks[j];
    if (!t) return -1;
    if (t.k === 'group') return t.d === '{' ? -1 : j + 1;
    switch (t.v) {
        case '&': case '&&': {
            let i = j + 1;
            if (toks[i]?.k === 'lifetime') i++;
            if (isTok(toks[i], 'mut')) i++;
            return scanType(toks, i);
        }
        case '*': {
            if (!isTok(toks[j + 1], 'const') && !isTok(toks[j + 1], 'mut')) return -1;
            return scanType(toks, j + 2);
        }
        case '!': case '_':
            return j + 1;
        case 'impl': case 'dyn':
            return scanBounds(toks, j + 1);
        case 'for': {
            if (!isTok(toks[j + 1], '<')) return -1;
            const end = skipAngles(toks, j + 1);
            return end < 0 ? -1 : scanType(toks, end);
        }
        case 'unsafe': case 'extern': case 'fn': {
            let i = j;
            while (i < toks.length && !isTok(toks[i], 'fn')) i++;
            if (!isGroup(toks[i + 1], '(')) return -1;
            i += 2;
            if (isTok(toks[i], '->')) return scanType(toks, i + 1);
            return i;
        }
        case '<': {
            const end = skipAngles(toks, j);
            if (end < 0) return -1;
            if (!isTok(toks[end], '::')) return end;
            return scanPath(toks, end + 1) < 0 ? end : scanPath(toks, end + 1);
        }
        default: {
            const end = scanPath(toks, j);
            if (end < 0) return -1;
            // Bare trait object bounds (`Trait + Send`, edition 2015).
            if (isTok(toks[end], '+') && (toks[end + 1]?.k === 'lifetime' || PATH_START(toks[end + 1]))) {
                return scanBounds(toks, j);
            }
            return end;
        }
    }
}

/**
 * Expression extent: to the first top-level token in `stops` that is not
 * inside closure parameters, generic arguments or an `as` type.
 */
function scanExpr(toks, j, stops) {
    let i = j;
    let expectOperand = true;
    while (i < toks.length) {
        const t = toks[i];
        if (t.k !== 'group' && stops.has(t.v)) break;
        if (t.k === 'group') {
            expectOperand = false;
            i++;
            continue;
        }
        if (expectOperand && (t.v === '|' || t.v === '||')) {
            if (t.v === '|') {
                let k = i + 1;
                while (k < toks.length && !isTok(toks[k], '|')) k++;
                if (k >= toks.length) return -1;
                i = k + 1;
            } else {
                i++;
            }
            if (isTok(toks[i], '->')) {
                const end = scanType(toks, i + 1);
                if (end < 0) return -1;
                i = end;
            }
            expectOperand = true;
            continue;
        }
        if (t.v === 'as') {
            const end = scanType(toks, i + 1);
            if (end < 0) return -1;
            i = end;
            expectOperand = false;
            continue;
        }
        if (t.v === '::' && isTok(toks[i + 1], '<')) {
            const end = skipAngles(toks, i + 1);
            if (end < 0) return -1;
            i = end;
            expectOperand = false;
            continue;
        }
        expectOperand = t.k === 'punct' ? t.v !== '?' && t.v !== '.' && t.v !== '::'
            : BINARY_OPS.has(t.v);
        if (t.v === '.') expectOperand = false;
        i++;
    }
    return i > j ? i : -1;
}

const EXPR_STOPS = new Set([',', ';', '=>']);
const PAT_STOPS = new Set(['=>', ',', '=', 'if', 'in']);
const PAT_PARAM_STOPS = new Set(['=>', ',', '=', 'if', 'in', '|']);

function scanPattern(toks, j, stops) {
    let i = j;
    while (i < toks.length) {
        const t = toks[i];
        if (t.k !== 'group' && stops.has(t.v)) break;
        i++;
    }
    return i > j ? i : -1;
}

function scanAttributes(toks, j) {
    let i = j;
    while (isTok(toks[i], '#')) {
        let k = i + 1;
        if (isTok(toks[k], '!')) k++;
        if (!isGroup(toks[k], '[')) break;
        i = k + 1;
    }
    return i;
}

function scanVis(toks, j) {
    if (isTok(toks[j], 'pub')) return isGroup(toks[j + 1], '(') ? j + 2 : j + 1;
    return j;
}

function scanItem(toks, j) {
    let i = scanVis(toks, scanAttributes(toks, j));
    const head = toks[i];
    if (!head) return -1;
    // Macro invocation item: path ! [ident] group [;]
    const macroEnd = (() => {
        const p = scanPath(toks, i);
        if (p < 0 || !isTok(toks[p], '!')) return -1;
        let k = p + 1;
        if (toks[k]?.k === 'ident' && isGroup(toks[k + 1])) k++;
        if (!isGroup(toks[k])) return -1;
        if (toks[k].d !== '{') return isTok(toks[k + 1], ';') ? k + 2 : -1;
        return k + 1;
    })();
    if (macroEnd > 0) return macroEnd;
    const untilSemicolon = ['use', 'type', 'let'].includes(head.v) ||
        (head.v === 'extern' && isTok(toks[i + 1], 'crate')) ||
        ((head.v === 'const' || head.v === 'static') &&
            !isTok(toks[i + 1], 'fn') && !isTok(toks[i + 1], 'unsafe') &&
            !isTok(toks[i + 1], 'async') && !isTok(toks[i + 1], 'extern'));
    for (let k = i; k < toks.length; k++) {
        const t = toks[k];
        if (isTok(t, ';')) return k + 1;
        if (!untilSemicolon && isGroup(t, '{')) return k + 1;
    }
    return -1;
}

function scanMeta(toks, j) {
    const end = scanPath(toks, j);
    if (end < 0) return -1;
    if (isGroup(toks[end])) return end + 1;
    if (isTok(toks[end], '=')) return scanExpr(toks, end + 1, EXPR_STOPS);
    return end;
}

function scanLiteral(toks, j) {
    const t = toks[j];
    if (!t) return -1;
    if (t.k === 'lit') return j + 1;
    if (isTok(t, '-') && toks[j + 1]?.k === 'lit' && /^[0-9]/.test(toks[j + 1].v)) return j + 2;
    return -1;
}

/** End index of the fragment of `kind` starting at toks[j], or -1. */
function scanFragment(kind, toks, j, nextLiteral = null) {
    const t = toks[j];
    switch (kind) {
        case 'tt': return t ? j + 1 : -1;
        case 'ident': return t && t.k === 'ident' && t.v !== '_' ? j + 1 : -1;
        case 'lifetime': return t && t.k === 'lifetime' ? j + 1 : -1;
        case 'literal': return scanLiteral(toks, j);
        case 'block': return isGroup(t, '{') ? j + 1 : -1;
        case 'vis': return scanVis(toks, j);
        case 'path': return scanPath(toks, j);
        case 'ty': return scanType(toks, j);
        case 'expr': case 'expr_2021': case 'stmt': return scanExpr(toks, j, EXPR_STOPS);
        case 'pat':
        case 'pat_param': {
            const stops = kind === 'pat' ? PAT_STOPS : PAT_PARAM_STOPS;
            return scanPattern(toks, j, nextLiteral && !stops.has(nextLiteral)
                ? new Set([...stops, nextLiteral]) : stops);
        }
        case 'item': return scanItem(toks, j);
        case 'meta': return scanMeta(toks, j);
        default: return -1;
    }
}

// ── Matching ──────────────────────────────────────────────────────────────

const MATCH_BUDGET = 200000;

function withBinding(binds, name, value) {
    const next = new Map(binds);
    next.set(name, value);
    return next;
}

function matchItems(items, ii, toks, ti, binds, ctx, k) {
    if (--ctx.budget < 0) throw new MacroBlind('match-budget');
    if (ii === items.length) return k(ti, binds);
    const item = items[ii];
    switch (item.t) {
        case 'tok':
            if (isTok(toks[ti], item.v)) return matchItems(items, ii + 1, toks, ti + 1, binds, ctx, k);
            return null;
        case 'group': {
            const tok = toks[ti];
            if (!isGroup(tok, item.d)) return null;
            const inner = matchItems(item.items, 0, tok.c, 0, binds, ctx,
                (end, b) => (end === tok.c.length ? b : null));
            if (!inner) return null;
            return matchItems(items, ii + 1, toks, ti + 1, inner, ctx, k);
        }
        case 'frag': {
            // A pattern ends where the matcher's next literal begins
            // (`|$p:pat|` in 2018-edition macros where `pat` has no
            // top-level alternatives).
            const next = items[ii + 1];
            const end = scanFragment(item.kind, toks, ti,
                next?.t === 'tok' ? next.v : null);
            if (end < 0 || (end === ti && item.kind !== 'vis')) return null;
            return matchItems(items, ii + 1, toks, end,
                withBinding(binds, item.name, { leaf: toks.slice(ti, end), kind: item.kind }), ctx, k);
        }
        case 'rep':
            return matchRepetition(item, items, ii, toks, ti, binds, ctx, k, []);
        default:
            return null;
    }
}

function matchRepetition(rep, items, ii, toks, ti, binds, ctx, k, iterations) {
    const count = iterations.length;
    if (!(rep.op === '?' && count === 1)) {
        let start = ti;
        let ok = true;
        if (count > 0 && rep.sep !== null) {
            if (isTok(toks[ti], rep.sep)) start = ti + 1;
            else ok = false;
        }
        if (ok && start <= toks.length) {
            const more = matchItems(rep.items, 0, toks, start, new Map(), ctx, (end, b) => {
                if (end === ti) return null; // no progress
                return matchRepetition(rep, items, ii, toks, end, binds, ctx, k, [...iterations, b]);
            });
            if (more) return more;
        }
    }
    if (rep.op === '+' && count === 0) return null;
    const next = new Map(binds);
    for (const name of rep.vars) {
        next.set(name, { seq: iterations.map(b => b.get(name)) });
    }
    return matchItems(items, ii + 1, toks, ti, next, ctx, k);
}

/** Bindings of the first rule matching `toks`, or null. */
function matchRules(compiled, toks) {
    for (const rule of compiled.rules) {
        const ctx = { budget: MATCH_BUDGET };
        let binds;
        try {
            binds = matchItems(rule.matcher, 0, toks, 0, new Map(), ctx,
                (end, b) => (end === toks.length ? b : null));
        } catch (error) {
            if (error instanceof RangeError) throw new MacroBlind('match-depth');
            throw error;
        }
        if (binds) return { rule, binds };
    }
    return null;
}

// ── Transcription ─────────────────────────────────────────────────────────

function lookup(binds, name, indices) {
    let value = binds.get(name);
    for (const index of indices) {
        if (value && value.seq) value = value.seq[index];
    }
    return value;
}

function repetitionCount(rep, binds, indices) {
    let count = null;
    for (const name of rep.vars) {
        const value = lookup(binds, name, indices);
        if (!value || !value.seq) continue;
        if (count === null) count = value.seq.length;
        else if (count !== value.seq.length) throw new MacroBlind('repetition-mismatch');
    }
    if (count === null) throw new MacroBlind('repetition-without-variable');
    return count;
}

/** A postfix chain (`a`, `a.b()`, `x::y(..)?`) keeps its precedence unwrapped. */
function isPostfixChain(tokens) {
    if (tokens.length <= 1) return true;
    const first = tokens[0];
    if (first.k === 'punct' && first.v !== '::') return false;
    if (first.k === 'ident' && BINARY_OPS.has(first.v)) return false;
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.k === 'group' || t.k === 'ident' || t.k === 'lit' || t.k === 'lifetime') {
            if (t.k === 'ident' && BINARY_OPS.has(t.v)) return false;
            continue;
        }
        if (['.', '::', '?', '!'].includes(t.v)) continue;
        if (t.v === '<' || t.v === '>' || t.v === '>>') continue; // turbofish arguments
        return false;
    }
    return true;
}

function cloneTokens(tokens) {
    return tokens.map(tok => (tok.k === 'group' ? { ...tok, c: cloneTokens(tok.c) } : { ...tok }));
}

function transcribeItems(items, binds, indices, out, ctx) {
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        if (--ctx.budget < 0) throw new MacroBlind('output-budget');
        switch (item.t) {
            case 'tok':
                out.push({ ...item.tok, src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro });
                break;
            case 'group': {
                const children = [];
                transcribeItems(item.items, binds, indices, children, ctx);
                out.push({
                    k: 'group', v: item.d, d: item.d, c: children, line: item.line, col: item.col,
                    src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro,
                });
                break;
            }
            case 'crate':
                for (const tok of ctx.crateTokens) {
                    out.push({ ...tok, line: item.line, src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro, dollarCrate: true });
                }
                break;
            case 'var': {
                const value = lookup(binds, item.name, indices);
                if (!value) {
                    if (binds.has(item.name)) throw new MacroBlind('repetition-depth');
                    // Not a metavariable of this macro (a nested
                    // `macro_rules!` in the transcriber): emitted as written.
                    out.push({ k: 'punct', v: '$', src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro },
                        { k: 'ident', v: item.name, src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro });
                    break;
                }
                if (value.seq) throw new MacroBlind('repetition-depth');
                const tokens = cloneTokens(value.leaf);
                if ((value.kind === 'expr' || value.kind === 'expr_2021') && !isPostfixChain(tokens)) {
                    // rustc keeps a substituted expression one operand
                    // (an invisible group); parentheses are its source form.
                    out.push({
                        k: 'group', v: '(', d: '(', c: tokens, src: 'tpl', ctx: ctx.hygiene,
                        mac: ctx.macro, line: tokens[0]?.line, synthetic: true,
                    });
                } else {
                    out.push(...tokens);
                }
                // A `stmt` fragment is a whole statement: rustc never needs
                // the transcriber to supply its terminator.
                if (value.kind === 'stmt' && tokens.length > 0 && !isTok(tokens[tokens.length - 1], ';') &&
                    !(items[itemIndex + 1]?.t === 'tok' && items[itemIndex + 1].tok.v === ';')) {
                    out.push({ k: 'punct', v: ';', src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro });
                }
                break;
            }
            case 'rep': {
                const count = repetitionCount(item, binds, indices);
                for (let i = 0; i < count; i++) {
                    if (i > 0 && item.sep !== null) {
                        out.push({ k: 'punct', v: item.sep, src: 'tpl', ctx: ctx.hygiene, mac: ctx.macro });
                    }
                    transcribeItems(item.items, binds, [...indices, i], out, ctx);
                }
                break;
            }
            default:
                break;
        }
    }
}

const OUTPUT_BUDGET = 60000;

/**
 * Expand one invocation's token list with a compiled macro.
 * ctx: { macro, hygiene, crateTokens } -> tokens, or throws MacroBlind.
 */
function expandWithRules(compiled, toks, ctx) {
    const matched = matchRules(compiled, toks);
    if (!matched) throw new MacroBlind('no-matching-rule');
    const out = [];
    const tctx = { ...ctx, budget: ctx.budget ?? OUTPUT_BUDGET };
    transcribeItems(matched.rule.transcriber, matched.binds, [], out, tctx);
    return { tokens: out, rule: matched.rule };
}

/** Count of leaf tokens (groups count their delimiters). */
function tokenCount(tokens) {
    let n = 0;
    for (const tok of tokens) n += tok.k === 'group' ? 2 + tokenCount(tok.c) : 1;
    return n;
}

module.exports = {
    MacroBlind,
    tokensOf,
    argTokensOf,
    compileMacro,
    matchRules,
    expandWithRules,
    scanFragment,
    isPostfixChain,
    tokenCount,
    CLOSERS,
};
