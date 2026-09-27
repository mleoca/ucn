'use strict';

/**
 * Function-like macro invocations the C/C++ grammar misreads as declarations
 * (fix #385).
 *
 * A function-like macro name followed by `(` is an invocation wherever the
 * definition is in effect (C11 6.10.3p10). tree-sitter knows no macros, so an
 * invocation in declaration or statement position is parsed as a
 * declaration: `ERROR_DEF(Base, Name)` in a class body became a method named
 * ERROR_DEF (and, without a trailing `;`, swallowed the class head),
 * `LOG_ONCE(init());` in a function body declared a function `init`
 * returning LOG_ONCE, `CATCH_ALL(...) { }` a nested function definition.
 *
 * This module reads the file's own `#define NAME(...)` / `#undef NAME`
 * directives (the preprocessor's line grammar), finds the invocations of
 * macros in effect that the tree holds in those declaration shapes, and
 * gives recovery the byte ranges to blank:
 *
 *   statement position   the macro name only when a `;` follows, so its
 *                        arguments stay expressions (their calls stay
 *                        calls); the whole invocation otherwise
 *   declaration/member   the whole invocation; its declarations are derived
 *                        from the expansion (the replacement list is known)
 *   file-scope with body `NAME(args) { ... }` is left as parsed (the body
 *                        belongs to whatever the expansion declares); the
 *                        definition is marked as a macro invocation
 *
 * Invocations of macros defined in other files are recognized at index time
 * from the same shapes (see the `macroInvocation` fact).
 */

const { lexPP, splitArguments, functionMacroTemplate } = require('./c-preprocessor');

const DECLARATION_CONTAINERS = new Set(['declaration', 'field_declaration', 'function_definition']);
const SCOPE_BOUNDARIES = new Set([
    'translation_unit', 'field_declaration_list', 'declaration_list', 'compound_statement',
]);
const MAX_EXPANSION_CHARS = 64 * 1024;
const EXPRESSION_CONTINUATION = new Set(['=', '(', ',', '?', '!', '&', '|', '+', '-', '*', '/', '%',
    '<', '>', '[', '^', '~', '.']);

/**
 * Function-like macro definitions and #undef lines of a file, read from its
 * directive lines. Returns null when the file defines no function-like macro.
 */
function directiveFunctionMacros(code) {
    if (!code.includes('define')) return null;
    const defs = new Map();
    const undefs = new Map();
    const directive = /^[ \t]*#[ \t]*(define|undef)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let row = 1;
    let counted = 0;
    const rowAt = offset => {
        for (let i = code.indexOf('\n', counted); i !== -1 && i < offset; i = code.indexOf('\n', i + 1)) row++;
        counted = offset;
        return row;
    };
    for (let match = directive.exec(code); match; match = directive.exec(code)) {
        const line = rowAt(match.index);
        const name = match[2];
        if (match[1] === 'undef') {
            if (!undefs.has(name)) undefs.set(name, []);
            undefs.get(name).push(line);
            continue;
        }
        const afterName = match.index + match[0].length;
        if (code[afterName] !== '(') continue;
        // The directive with its continuation lines.
        let end = code.indexOf('\n', afterName);
        let endLine = line;
        while (end !== -1 && /\\[ \t\r]*$/.test(code.slice(Math.max(afterName, end - 64), end))) {
            const next = code.indexOf('\n', end + 1);
            endLine++;
            end = next;
        }
        const text = code.slice(afterName, end === -1 ? code.length : end)
            .replace(/\\[ \t\r]*\n/g, ' \n');
        const template = functionMacroTemplate(text);
        if (!template) continue;
        if (!defs.has(name)) defs.set(name, []);
        defs.get(name).push({ name, line, endLine, ...template });
    }
    return defs.size > 0 ? { defs, undefs } : null;
}

/** The definition of `name` in effect at `line` (nearest above, no #undef between). */
function definitionInEffect(macros, name, line) {
    const defs = macros.defs.get(name);
    if (!defs) return null;
    let best = null;
    for (const def of defs) {
        if (def.endLine < line && (!best || def.line > best.line)) best = def;
    }
    if (!best) return null;
    const undone = (macros.undefs.get(name) || []).some(undef => undef > best.endLine && undef < line);
    return undone ? null : best;
}

function isWordChar(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || code === 95;
}

function lineOfOffset(lineStarts, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

/**
 * Offset after the parenthesis closing the one at `open` (string and
 * character literals and comments skipped), or -1.
 */
function closingParenthesis(code, open) {
    const limit = Math.min(code.length, open + MAX_EXPANSION_CHARS);
    let depth = 0;
    for (let i = open; i < limit; i++) {
        const ch = code[i];
        if (ch === '"' || ch === '\'') {
            for (i++; i < limit && code[i] !== ch; i++) if (code[i] === '\\') i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            while (i < limit && code[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            const close = code.indexOf('*/', i + 2);
            if (close < 0) return -1;
            i = close + 1;
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i + 1;
    }
    return -1;
}

/** End offset (after the closing parenthesis) and arguments of the list at `open`. */
function argumentListEnd(code, open) {
    const end = closingParenthesis(code, open);
    if (end < 0) return null;
    const tokens = lexPP(code.slice(open, end));
    const split = splitArguments(tokens, 0);
    if (!split) return null;
    return { end: open + tokens[split.close].start + 1, args: split.args };
}

function sameNode(a, b) {
    return !!a && !!b && (a === b || a.id === b.id);
}

/** Scope of a declaration container: 'statement', 'member' or 'declaration'. */
function scopeOf(container) {
    for (let up = container.parent; up; up = up.parent) {
        if (!SCOPE_BOUNDARIES.has(up.type)) continue;
        if (up.type === 'compound_statement') return 'statement';
        if (up.type === 'field_declaration_list') return 'member';
        return 'declaration';
    }
    return 'declaration';
}

/**
 * The declaration a macro-name node was read into, and how: 'typeless' when
 * it is the name of a function declarator in a declaration with no type
 * (`NAME(args);`, `NAME(args) { }`), 'typed' when it is the type of a
 * declaration (`NAME(x());` read as a function x returning NAME),
 * 'type-specifier' for `NAME(args) value;` read as a macro type specifier,
 * 'error' for any other non-call reading inside a syntax error.
 */
function misreadShape(node) {
    const parent = node.parent;
    if (!parent) return null;
    if ((node.type === 'identifier' || node.type === 'field_identifier') &&
        parent.type === 'function_declarator' &&
        sameNode(parent.childForFieldName('declarator'), node)) {
        const container = parent.parent;
        if (container && DECLARATION_CONTAINERS.has(container.type) &&
            sameNode(container.childForFieldName('declarator'), parent) &&
            !container.childForFieldName('type')) {
            return { shape: 'typeless', container };
        }
    }
    if (node.type === 'type_identifier' && DECLARATION_CONTAINERS.has(parent.type) &&
        sameNode(parent.childForFieldName('type'), node)) {
        return { shape: 'typed', container: parent };
    }
    // `NAME(args)` read as a macro type specifier in a declaration's type:
    // right only when the expansion is a type (checked by the caller).
    if (parent.type === 'macro_type_specifier' && sameNode(parent.childForFieldName('name'), node) &&
        parent.parent && DECLARATION_CONTAINERS.has(parent.parent.type) &&
        sameNode(parent.parent.childForFieldName('type'), parent)) {
        return { shape: 'type-specifier', container: parent.parent };
    }
    // Inside a syntax error the grammar already failed around the
    // invocation: any reading of the name other than a call's function
    // (`LIST(X)` statements with no `;`, read as a macro type specifier or
    // a stray declarator) is the misread invocation.
    if (parent.type === 'call_expression' && sameNode(parent.childForFieldName('function'), node)) {
        return null;
    }
    for (let up = parent; up; up = up.parent) {
        if (up.type === 'ERROR') return { shape: 'error', container: up };
        if (SCOPE_BOUNDARIES.has(up.type)) break;
    }
    return null;
}

/** Does this invocation's expansion read as a type (`TYPE(x) value;`)? */
function expandsToType(parser, definition, args) {
    const text = substituteInvocation(definition, args);
    if (text == null || !parser) return true;
    const probe = parser.parse(`typedef ${text} __ucn_type_probe__;\n`);
    return !probe.rootNode.hasError;
}

/**
 * Invocations of the file's own function-like macros that the tree holds in
 * a declaration shape. Each: { name, definition, line, start, nameEnd, end,
 * args, scope, hasBody, blank: [start, end] | null }.
 */
function misreadMacroInvocations(tree, code, macros, parser = null) {
    const invocations = [];
    if (!macros) return invocations;
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
    // Directive lines with their continuations: a macro body is never
    // blanked, even where the grammar read it as code.
    const directive = new Uint8Array(lineStarts.length + 1);
    for (let row = 0; row < lineStarts.length; row++) {
        let k = lineStarts[row];
        while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k++;
        if (code[k] !== '#') continue;
        for (;;) {
            directive[row + 1] = 1;
            const end = row + 1 < lineStarts.length ? lineStarts[row + 1] - 1 : code.length;
            if (!/\\\s*$/.test(code.slice(lineStarts[row], end)) || row + 1 >= lineStarts.length) break;
            row++;
        }
    }
    const directiveRow = row => directive[row] === 1;
    const root = tree.rootNode;
    // One scan for identifiers followed by `(` (a prefilter: every hit is
    // checked against the tree), instead of one text search per macro.
    const candidate = /[A-Za-z_][A-Za-z0-9_]*[ \t]*\(/g;
    for (let match = candidate.exec(code); match; match = candidate.exec(code)) {
        const at = match.index;
        if (at > 0 && isWordChar(code.charCodeAt(at - 1))) continue;
        let nameEnd = at;
        while (nameEnd < code.length && isWordChar(code.charCodeAt(nameEnd))) nameEnd++;
        const name = code.slice(at, nameEnd);
        if (!macros.defs.has(name)) continue;
        // An invocation continuing an expression or a parameter list
        // (`= M(x)`, `(M(x)`, `, M(x)`, `->M(x)`) is never read as a
        // declaration of its own; skip the tree lookup.
        let before = at - 1;
        while (before >= 0 && (code[before] === ' ' || code[before] === '\t')) before--;
        if (before >= 0 && EXPRESSION_CONTINUATION.has(code[before])) continue;
        const open = match.index + match[0].length - 1;
        {
            const line = lineOfOffset(lineStarts, at);
            if (directiveRow(line)) continue;
            const definition = definitionInEffect(macros, name, line);
            if (!definition) continue;
            const node = root.descendantForIndex(at, nameEnd);
            if (!node || node.startIndex !== at || node.endIndex !== nameEnd) continue;
            const misread = misreadShape(node);
            if (!misread) continue;
            // Inside a syntax error only an invocation that begins its line
            // stands in statement or declaration position (`LIST(X)` lines);
            // one inside an expression (`if (LIKELY(x))`) is not misread.
            if (misread.shape === 'error' &&
                code.slice(lineStarts[line - 1], at).trim() !== '') continue;
            const extent = argumentListEnd(code, open);
            if (!extent) continue;
            if (misread.shape === 'type-specifier' && expandsToType(parser, definition, extent.args)) continue;
            const scope = scopeOf(misread.container);
            const hasBody = misread.container.type === 'function_definition';
            let after = extent.end;
            while (after < code.length && (code[after] === ' ' || code[after] === '\t')) after++;
            // A `typed` reading makes the invocation a prefix of the real
            // declaration that follows (an attribute macro before a member,
            // `M(x());` in a body); a `typeless` one with a body is a
            // definition the expansion declares (`TEST(a, b) { }`), left as
            // parsed and marked.
            // Blanking never removes call syntax the source spells: an
            // invocation whose arguments hold a parenthesis (a call,
            // `f<T>(x)`, a cast) keeps them (only its name is blanked where
            // a `;` makes the rest an expression statement, otherwise it is
            // left as parsed).
            const argumentsCall = extent.args.some(arg => arg.some(token => token.v === '('));
            let blank = null;
            if (scope === 'statement' && code[after] === ';' &&
                !(hasBody && misread.shape === 'typeless')) {
                blank = [at, nameEnd];
            } else if (!argumentsCall && (scope === 'statement' || !hasBody || misread.shape !== 'typeless')) {
                blank = [at, extent.end];
            }
            invocations.push({
                name, definition, line, start: at, nameEnd, end: extent.end,
                args: extent.args, scope, hasBody, blank,
            });
        }
    }
    return invocations.sort((a, b) => a.start - b.start);
}

/**
 * The replacement of one invocation of a same-file macro: parameters
 * substituted (arguments as written), `#param` stringized, `##` pasted.
 * Macros the replacement invokes are not expanded again here; a nested
 * invocation stays as written. Returns null when the arguments do not fit.
 */
function substituteInvocation(definition, args) {
    const params = definition.params || [];
    let actual = args;
    if (params.length === 0 && actual.length === 1 && actual[0].length === 0) actual = [];
    if (definition.variadic) {
        const named = params.length - 1;
        if (actual.length < named) return null;
        const rest = [];
        actual.slice(named).forEach((arg, i) => {
            if (i > 0) rest.push({ v: ',', k: 'punct' });
            rest.push(...arg);
        });
        actual = [...actual.slice(0, named), rest];
    } else if (actual.length !== params.length) {
        return null;
    }
    const index = new Map(params.map((param, i) => [param, i]));
    const body = lexPP(definition.body || '');
    const out = [];
    for (let i = 0; i < body.length; i++) {
        const token = body[i];
        if (token.v === '#' && body[i + 1]?.k === 'id' && index.has(body[i + 1].v)) {
            out.push({ v: JSON.stringify(actual[index.get(body[i + 1].v)].map(t => t.v).join(' ')), k: 'str' });
            i++;
            continue;
        }
        if (token.k === 'id' && index.has(token.v)) {
            out.push(...actual[index.get(token.v)]);
            continue;
        }
        out.push(token);
    }
    const pasted = [];
    for (let i = 0; i < out.length; i++) {
        if (out[i].v === '##' && pasted.length > 0 && out[i + 1]) {
            const left = pasted.pop();
            pasted.push({ v: left.v + out[i + 1].v, k: 'id' });
            i++;
            continue;
        }
        pasted.push(out[i]);
    }
    // Spaces only where two tokens would otherwise merge (two words, two
    // punctuators), so types read as written (`std::string`, `T*`).
    let text = '';
    for (let i = 0; i < pasted.length; i++) {
        const word = pasted[i].k !== 'punct';
        if (i > 0 && word === (pasted[i - 1].k !== 'punct')) text += ' ';
        else if (i > 0 && pasted[i - 1].v === ',') text += ' ';
        text += pasted[i].v;
    }
    return text.length > MAX_EXPANSION_CHARS ? null : text;
}

module.exports = {
    directiveFunctionMacros,
    definitionInEffect,
    misreadMacroInvocations,
    substituteInvocation,
};
