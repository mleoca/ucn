'use strict';

/**
 * C/C++ preprocessing tokens (C11 6.4 / C++ [lex.pptoken]).
 *
 * Tree-sitter keeps a macro replacement list as one opaque `preproc_arg`, and
 * `##` / `#` are not expression syntax, so a function-like macro that builds a
 * call target by token pasting (`fs__##lc(req)`) is invisible to the AST. The
 * preprocessor itself is defined over this token grammar, not over the AST:
 * substituting arguments and pasting operands is a token-sequence operation.
 * This module is that token layer. It never classifies code; callers parse
 * the substituted token stream with tree-sitter to decide what is a call,
 * a declaration, or a value reference.
 */

const PUNCTUATORS = [
    '%:%:', '...', '<<=', '>>=', '->*', '<=>',
    '##', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '::', '.*', '<:', ':>',
    '<%', '%>', '%:',
];

// Characters that never begin a multi-character punctuator.
const SINGLE_PUNCTUATORS = new Set(['(', ')', '{', '}', '[', ']', ';', ',', '?', '~']);

function isIdentStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' ||
        ch === '$' || ch > '\x7f';
}

function isIdentPart(ch) {
    return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * Tokenize `text` into preprocessing tokens. Comments and whitespace are
 * dropped; a line splice (`\` + newline) joins lines. Each token records its
 * offset in `text` (`start`) and its kind: 'id', 'num', 'str', 'chr', 'punct'.
 *
 * One sticky scanner handles the common token classes (identifiers,
 * whitespace, comments, numbers); literals and punctuators fall through to
 * the exact per-character rules below.
 */
const FAST_TOKEN = /([ \t\r\n\f\v]+|\\\r?\n)|(\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|([A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)(?![A-Za-z0-9_$\u0080-\uffff"'])|((?:\.?[0-9])(?:[eEpP][+-]|[A-Za-z0-9_.]|'(?=[A-Za-z0-9_]))*)/y;

function lexPP(text) {
    const tokens = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
        FAST_TOKEN.lastIndex = i;
        const match = FAST_TOKEN.exec(text);
        if (match) {
            if (match[4] !== undefined) {
                tokens.push({ v: match[4], k: 'id', start: i });
            } else if (match[5] !== undefined) {
                tokens.push({ v: match[5], k: 'num', start: i });
            }
            i = FAST_TOKEN.lastIndex;
            continue;
        }
        const ch = text[i];
        const start = i;
        if (isIdentStart(ch)) {
            // Identifier directly followed by a quote: an encoding prefix
            // (L"", u8"", R"(...)") belongs to the literal.
            while (i < n && isIdentPart(text[i])) i++;
            const prefix = text.slice(start, i);
            if (/^(?:L|u8|u|U|R|LR|u8R|uR|UR)$/.test(prefix)) {
                i = scanQuoted(text, i, prefix.endsWith('R'));
                tokens.push({ v: text.slice(start, i), k: text[start + prefix.length] === '\'' ? 'chr' : 'str', start });
            } else {
                tokens.push({ v: prefix, k: 'id', start });
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            i = scanQuoted(text, i, false);
            tokens.push({ v: text.slice(start, i), k: ch === '"' ? 'str' : 'chr', start });
            continue;
        }
        if (SINGLE_PUNCTUATORS.has(ch)) {
            tokens.push({ v: ch, k: 'punct', start });
            i++;
            continue;
        }
        let punct = null;
        for (const p of PUNCTUATORS) {
            if (text.startsWith(p, i)) {
                punct = p;
                break;
            }
        }
        if (!punct) punct = ch;
        i += punct.length;
        tokens.push({ v: punct === '%:%:' ? '##' : punct === '%:' ? '#' : punct, k: 'punct', start });
    }
    return tokens;
}

function scanQuoted(text, i, raw) {
    const quote = text[i];
    if (raw && quote === '"') {
        const open = text.indexOf('(', i);
        if (open > 0) {
            const delimiter = text.slice(i + 1, open);
            const close = text.indexOf(`)${delimiter}"`, open);
            if (close >= 0) return close + delimiter.length + 2;
        }
    }
    i++;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) return i + 1;
        if (c === '\n') return i;
        i++;
    }
    return i;
}

/**
 * Split the tokens of a macro invocation `NAME ( a , b )` (starting at
 * `openIndex`, the `(` token) into argument token lists. Returns
 * { args, close } or null when the parentheses do not balance.
 */
function splitArguments(tokens, openIndex) {
    if (tokens[openIndex]?.v !== '(') return null;
    const args = [[]];
    let depth = 0;
    for (let i = openIndex; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.k === 'punct' && t.v === '(') {
            depth++;
            if (depth === 1) continue;
        } else if (t.k === 'punct' && t.v === ')') {
            depth--;
            if (depth === 0) {
                // `F()` has one empty argument; the caller reconciles that
                // with a zero-parameter macro.
                return { args, close: i };
            }
        } else if (depth === 1 && t.k === 'punct' && t.v === ',') {
            args.push([]);
            continue;
        }
        args[args.length - 1].push(t);
    }
    return null;
}

/**
 * Replacement-list template of a function-like macro, read from its
 * logical `#define` line (text after the macro name). Returns
 * { params, variadic, body } or null. `params` lists parameter names;
 * a trailing `...` is exposed as `__VA_ARGS__`, GNU `name...` as `name`.
 * `body` is the replacement list as space-joined preprocessing tokens.
 */
function functionMacroTemplate(afterName) {
    const tokens = lexPP(afterName);
    if (tokens[0]?.v !== '(') return null;
    const params = [];
    let variadic = false;
    let i = 1;
    let expectName = true;
    for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.v === ')') break;
        if (t.v === ',') {
            expectName = true;
            continue;
        }
        if (t.v === '...') {
            variadic = true;
            if (expectName) params.push('__VA_ARGS__');
            continue;
        }
        if (t.k === 'id' && expectName) {
            params.push(t.v);
            expectName = false;
            continue;
        }
        return null;
    }
    if (tokens[i]?.v !== ')') return null;
    const body = tokens.slice(i + 1).map(t => t.v).join(' ');
    return { params, variadic, body };
}

// Object-like replacement lists longer than this are not kept (they are
// declarations or statement blocks, never a name fragment for a paste).
const MAX_OBJECT_MACRO_CHARS = 256;

/** Replacement list of an object-like macro (text after its name), or null. */
function objectMacroBody(afterName) {
    const tokens = lexPP(afterName);
    const body = tokens.map(t => t.v).join(' ');
    return body.length <= MAX_OBJECT_MACRO_CHARS ? body : null;
}

/**
 * Pasting patterns of a template: each `a ## b ## c` chain that involves a
 * parameter, as a sequence of literal strings and parameter wildcards
 * (null). A chain of only literals pastes a fixed token and is ignored.
 */
function pastePatterns(template) {
    if (!template || !template.body.includes('##')) return [];
    const tokens = lexPP(template.body);
    const params = new Set(template.params);
    const patterns = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i + 1]?.v !== '##') continue;
        const operands = [tokens[i]];
        let j = i + 1;
        while (tokens[j]?.v === '##' && tokens[j + 1]) {
            operands.push(tokens[j + 1]);
            j += 2;
        }
        i = j - 1;
        if (!operands.some(op => op.k === 'id' && params.has(op.v))) continue;
        // A chain whose operands are not identifier-shaped (`, ## __VA_ARGS__`
        // comma elision) never produces a name.
        if (operands.some(op => op.k !== 'id' && op.k !== 'num')) continue;
        patterns.push(operands.map(op => op.k === 'id' && params.has(op.v) ? null : op.v));
    }
    return patterns;
}

/** Does `name` fit a paste pattern (literal pieces in order, wildcards between)? */
function matchesPastePattern(pattern, name) {
    let position = 0;
    for (let i = 0; i < pattern.length; i++) {
        const piece = pattern[i];
        if (piece === null) continue;
        if (i === 0) {
            if (!name.startsWith(piece)) return false;
            position = piece.length;
            continue;
        }
        if (i === pattern.length - 1) {
            return name.length - piece.length >= position && name.endsWith(piece) &&
                (pattern[i - 1] !== null || name.length - piece.length === position);
        }
        const found = name.indexOf(piece, position + (pattern[i - 1] === null ? 1 : 0));
        if (found < 0 || (pattern[i - 1] !== null && found !== position)) return false;
        position = found + piece.length;
    }
    // A trailing wildcard must produce at least one character.
    return pattern[pattern.length - 1] !== null || name.length > position;
}

module.exports = {
    lexPP, splitArguments, functionMacroTemplate, objectMacroBody, pastePatterns, matchesPastePattern,
};
