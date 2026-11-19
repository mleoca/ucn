'use strict';

/**
 * Runtime reflection by NAME PATTERN (fix #363).
 *
 * A reflective member access names its target with a string. A literal string
 * is an exact spelling; a string BUILT from literal fragments around a runtime
 * part (`"_get_%s_permissions" % src`, f"_get_{p}", `"on" + evt`,
 * `this[`handle${t}`]`, `getMethod("get" + n)`, `MethodByName("X" + y)`) is a
 * pattern: literal fragments with wildcards. Patterns come from the AST of the
 * name argument (plus one-hop local string bindings in the same scope); a name
 * the pattern can spell is a possible runtime target when the reflective
 * receiver could hold an instance of the candidate's class.
 *
 * Consumers:
 *   - deadcode withholds pattern-reachable candidates (counted per pattern);
 *   - findCallers (collectAccount) lists each reaching site as an unverified
 *     `reflection-pattern` caller, so impact/plan see the dependency.
 * A pattern whose literal part names nothing specific (`"_%s" % x`, a bare
 * parameter) stays a disclosed dynamic use, never a blanket withhold.
 *
 * A test double that replaces a member by its name is the same kind of use:
 * the member must exist for the test to run (fix #505). Python's patch APIs
 * are read by binding identity (python-binding-identity.js: unittest.mock,
 * pytest's monkeypatch, pytest-mock), and by the member the callee is
 * written with when no identity is proven; other languages name theirs in
 * the trait rule list `patches`. Such a site names an attribute by a dotted
 * runtime path (`runtime-target`, matched against a declaration's own path)
 * or by an owner object and a member name (`runtime-member`).
 *
 * Site extraction is syntax-only and runs in the same per-file parse as the
 * computed-dispatch inventory (ast-analysis.js); the per-project matcher is
 * memoized on the index and reset with it.
 */

const { langTraits, detectLanguage } = require('../languages');
const { sameNode } = require('../languages/utils');
const { pythonPossibleIdentities, pythonResolvedOrigins, pythonSourceName, pythonPatchApi, pythonPatchSpelling, pythonPatchOwner,
    pythonPossibleValues, pythonContainerNodes, pythonDecoratorsInert } = require('./python-binding-identity');

const WILD = '\u0000*';
// A parameter of the callable that holds a patch call: its value is what the
// callable's callers pass (resolved when the project is asked, fix #512).
const PARAM = '\u0001';
// Values a patch target or member may hold before the set counts as open.
const MAX_PATCH_ALTERNATIVES = 256;
const MODULE_RECEIVER = Object.freeze({ kind: 'module' });
const CALL_NODE_TYPES = ['call', 'call_expression', 'invocation_expression', 'method_invocation'];
// Computed-member keys that build a name in place (`'on' + evt`, `\`h${t}\``).
const COMPUTED_PATTERN_KEYS = new Set(['binary_expression', 'template_string']);
const MAX_ALTERNATIVES = 8;
const MAX_RESOLVE_DEPTH = 3;
const EXPRESSION_CAP = 160;
// Letters/digits a wildcard pattern must spell before it identifies anything:
// `_*`, `*s` or `*` name every member and stay disclosed dynamic uses.
const MIN_SPECIFIC_CHARS = 2;

const STRING_NODES = new Set([
    'string', 'string_literal', 'raw_string_literal', 'verbatim_string_literal',
    'interpreted_string_literal', 'template_string', 'interpolated_string_expression',
]);
const STRING_CONTENT_NODES = new Set([
    'string_content', 'string_fragment', 'string_literal_content',
    'interpreted_string_literal_content', 'raw_string_literal_content',
    'raw_string_content', 'verbatim_string_literal_content',
]);
const INTERPOLATION_NODES = new Set([
    'interpolation', 'template_substitution',
]);
const SCOPE_NODES = new Set([
    'function_declaration', 'generator_function_declaration',
    'function_expression', 'generator_function', 'arrow_function',
    'method_definition', 'function_definition', 'lambda',
    'method_declaration', 'func_literal', 'constructor_declaration',
    'lambda_expression', 'local_function_statement', 'anonymous_method_expression',
    'module', 'program', 'source_file', 'compilation_unit',
]);
const CLASS_NODES = new Set([
    'class_definition', 'class_declaration', 'class', 'class_expression',
    'abstract_class_declaration', 'struct_declaration', 'record_declaration',
    'enum_declaration', 'interface_declaration',
]);
// A non-arrow JS function rebinds `this`; arrows and class members keep it.
const THIS_REBINDING_FUNCTIONS = new Set([
    'function_declaration', 'function_expression', 'generator_function',
    'generator_function_declaration', 'function',
]);

// ---------------------------------------------------------------------------
// String patterns
// ---------------------------------------------------------------------------

function _concat(a, b, cap = MAX_ALTERNATIVES) {
    const out = [];
    for (const x of a) {
        for (const y of b) {
            out.push([...x, ...y]);
            if (out.length > cap) return [[WILD]];
        }
    }
    return out;
}

function _expandFormat(alternatives, style) {
    const re = style === 'brace'
        ? /\{\{|\}\}|\{[^{}]*\}/g
        : /%%|%(?:\([^)]*\)|\[\d+\])?[-#0 +]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[A-Za-z]/g;
    return alternatives.map(alt => {
        const out = [];
        for (const piece of alt) {
            if (piece === WILD) { out.push(WILD); continue; }
            let last = 0;
            let m;
            re.lastIndex = 0;
            while ((m = re.exec(piece)) !== null) {
                out.push(piece.slice(last, m.index));
                if (m[0] === '%%') out.push('%');
                else if (m[0] === '{{') out.push('{');
                else if (m[0] === '}}') out.push('}');
                else out.push(WILD);
                last = m.index + m[0].length;
            }
            out.push(piece.slice(last));
        }
        return out;
    });
}

function _unwrap(node) {
    let cur = node;
    for (let i = 0; cur && i < 4; i++) {
        if (cur.type === 'argument' || cur.type === 'parenthesized_expression') {
            cur = cur.namedChildren.find(c => c.type !== 'comment') || null;
        } else break;
    }
    return cur;
}

function _stringLiteral(node, ctx, depth = 0) {
    let alternatives = [[]];
    let sawContent = false;
    let sawPiece = false;
    const append = piece => { for (const alternative of alternatives) alternative.push(piece); sawPiece = true; };
    for (const child of node.children || []) {
        if (STRING_CONTENT_NODES.has(child.type)) {
            append(child.text);
            sawContent = true;
        } else if (INTERPOLATION_NODES.has(child.type)) {
            // `ctx.interpolations`: a plain `{name}` is read through the
            // context's resolver; a conversion or a format changes the text.
            const plain = ctx?.interpolations && child.namedChildCount === 1 &&
                !child.children.some(part => !part.isNamed && part.type === '=');
            const value = plain ? stringAlternatives(child.namedChild(0), ctx, depth + 1) : null;
            if (value) { alternatives = _concat(alternatives, value, ctx?.maxAlternatives); sawPiece = true; } else append(WILD);
        } else if (child.type === 'escape_sequence') {
            // An escaped character never spells an identifier fragment.
            append('\\');
        }
        // Delimiters, prefixes and quote tokens carry no name text.
    }
    if (!sawContent && !sawPiece) {
        // Grammars that keep simple literals as one token (`"abc"`, `'abc'`).
        const raw = String(node.text || '');
        const m = /^[A-Za-z@$]*(["'`])([\s\S]*)\1$/.exec(raw);
        if (m) append(m[2]);
    }
    return alternatives;
}

/**
 * Pattern alternatives of a string-valued expression, or null when the
 * expression is not string-shaped. A runtime part becomes WILD.
 * @param {object} node
 * @param {object} ctx - { formatCalls: {callee: style}, resolve(identNode) }
 */
function stringAlternatives(node, ctx, depth = 0) {
    node = _unwrap(node);
    if (!node || depth > 12) return null;
    if (STRING_NODES.has(node.type)) {
        const literal = ctx?.language === 'python'
            ? require('./runtime-entrypoints').pythonStringLiteral(node)
            : ['javascript', 'typescript', 'tsx', 'html'].includes(ctx?.language)
                ? require('../languages/static-js').jsString(node) : null;
        return literal != null ? [[literal]] : _stringLiteral(node, ctx, depth);
    }
    switch (node.type) {
        case 'concatenated_string': {
            let acc = [[]];
            for (const child of node.namedChildren) {
                const part = stringAlternatives(child, ctx, depth + 1) || [[WILD]];
                acc = _concat(acc, part, ctx?.maxAlternatives);
            }
            return acc;
        }
        case 'binary_operator':
        case 'binary_expression': {
            const op = node.childForFieldName('operator')?.text ||
                (node.children || []).find(c => !c.isNamed)?.text;
            const left = node.childForFieldName('left') || node.namedChild(0);
            const right = node.childForFieldName('right') || node.namedChild(1);
            if (op === '+') {
                const l = stringAlternatives(left, ctx, depth + 1);
                const r = stringAlternatives(right, ctx, depth + 1);
                if (!l && !r) return null;
                return _concat(l || [[WILD]], r || [[WILD]], ctx?.maxAlternatives);
            }
            if (op === '%') {
                // Python printf-style formatting: only a string left operand.
                const l = _unwrap(left);
                if (!l || !(STRING_NODES.has(l.type) || l.type === 'concatenated_string')) return null;
                return _expandFormat(stringAlternatives(l, ctx, depth + 1), 'percent');
            }
            return null;
        }
        case 'call':
        case 'call_expression':
        case 'invocation_expression':
        case 'method_invocation': {
            const fn = node.childForFieldName('function') || node.childForFieldName('name');
            const argsNode = node.childForFieldName('arguments') ||
                (node.namedChildren || []).find(c => c.type === 'argument_list' || c.type === 'arguments');
            const args = (argsNode?.namedChildren || []).filter(c => c.type !== 'comment');
            // `"lit{}".format(x)` — a format method on a string receiver.
            if (fn?.type === 'attribute' &&
                fn.childForFieldName('attribute')?.text === 'format') {
                const recv = _unwrap(fn.childForFieldName('object'));
                if (recv && (STRING_NODES.has(recv.type) || recv.type === 'concatenated_string')) {
                    return _expandFormat(stringAlternatives(recv, ctx, depth + 1), 'brace');
                }
                return null;
            }
            // Containers the patch reader closes (`ctx.containers`):
            // `".".join([..])` of a literal sequence, `d.get(key)` of a
            // literal dictionary.
            if (ctx.containers && fn?.type === 'attribute') {
                const member = fn.childForFieldName('attribute')?.text;
                const owner = fn.childForFieldName('object');
                if (member === 'join' && args.length === 1 && args[0].type !== 'keyword_argument') {
                    const separator = stringAlternatives(owner, ctx, depth + 1);
                    return separator ? _joined(separator, args[0], ctx, depth) : null;
                }
                if (member === 'get' && args.length >= 1 && args.length <= 2 &&
                    !args.some(arg => arg.type === 'keyword_argument')) {
                    const read = pythonContainerNodes(owner, ctx.memo);
                    if (read.open) return null;
                    return _lookedUp(read.nodes, args[0], args[1] || null, ctx, depth);
                }
            }
            // Formatting functions from the language vocabulary
            // (fmt.Sprintf, String.format, string.Format).
            let calleeText;
            if (node.type === 'method_invocation') {
                const obj = node.childForFieldName('object');
                calleeText = `${obj ? obj.text + '.' : ''}${node.childForFieldName('name')?.text || ''}`;
            } else {
                calleeText = fn?.text || '';
            }
            const style = ctx.formatCalls && Object.prototype.hasOwnProperty.call(ctx.formatCalls, calleeText)
                ? ctx.formatCalls[calleeText] : null;
            if (style && args[0]) {
                const fmt = stringAlternatives(args[0], ctx, depth + 1);
                return fmt ? _expandFormat(fmt, style) : null;
            }
            return null;
        }
        case 'subscript': {
            // `d[key]`, `seq[i]` of a container the patch reader closes.
            if (!ctx.containers) return null;
            const read = pythonContainerNodes(node.childForFieldName('value'), ctx.memo);
            const keys = node.childrenForFieldName?.('subscript') || [node.childForFieldName('subscript')];
            if (read.open || keys.length !== 1 || !keys[0]) return null;
            return _lookedUp(read.nodes, keys[0], null, ctx, depth);
        }
        case 'identifier': {
            if (!ctx.resolve || (ctx.resolveDepth || 0) >= MAX_RESOLVE_DEPTH) return null;
            const values = ctx.resolve(node);
            // A parameter of the enclosing callable is decided by its
            // callers when the project is asked (`ctx.parameter`).
            if (!values || values.length === 0) return ctx.parameter?.(node) ? [[PARAM]] : null;
            let out = [];
            for (const value of values) {
                const alt = stringAlternatives(value,
                    { ...ctx, resolveDepth: (ctx.resolveDepth || 0) + 1 }, depth + 1);
                if (!alt) return null; // one non-string binding: unknown
                out.push(...alt);
                if (out.length > (ctx.maxAlternatives || MAX_ALTERNATIVES)) return [[WILD]];
            }
            return out;
        }
        default:
            return null;
    }
}

/** Normalize one alternative: merged literals and wildcards; null if it
 * cannot spell an identifier. */
function _normalize(alt) {
    const out = [];
    for (const piece of alt) {
        if (piece === WILD) {
            if (out[out.length - 1] !== WILD) out.push(WILD);
        } else if (piece.length > 0) {
            if (out.length > 0 && out[out.length - 1] !== WILD) out[out.length - 1] += piece;
            else out.push(piece);
        }
    }
    if (out.length === 0) return null; // the empty string names nothing
    for (const piece of out) {
        if (piece !== WILD && !/^[A-Za-z0-9_$]+$/.test(piece)) return null;
    }
    return out;
}

/** Glob string (`_get_*_permissions`) of a normalized alternative. */
function patternText(pieces) {
    return pieces.map(p => (p === WILD ? '*' : p)).join('');
}

function _specific(pieces) {
    let chars = 0;
    for (const p of pieces) if (p !== WILD) chars += (p.match(/[A-Za-z0-9]/g) || []).length;
    return chars >= MIN_SPECIFIC_CHARS;
}

// What the owner of a patched member, and its replacement, are never written as.
const PATCH_LITERALS = new Set(['string', 'template_string', 'regex', 'number', 'true', 'false', 'null', 'undefined']);
const DOTTED_PATH = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)+$/u;
const DOTTED_FRAGMENT = /^[\p{L}\p{N}_.]+$/u;

/**
 * The runtime path one alternative of a patch target spells:
 * { name?, patterns, runtimeTarget }, or null when it names no member.
 *
 * A literal path (`pkg.module.name`) is exact. A path with a runtime part
 * (`f"{MOD}.name"`, `MOD + ".name"`, `"%s.name" % MOD`) is a glob over the
 * path, `*.name`: it names a member only when its literal fragments are path
 * text and its last segment spells something specific, so `f"{MOD}.{name}"`
 * stays an unnamed dynamic use. `patterns` are the member spellings the
 * project matcher is keyed by; `runtimeTarget` is what the owner-aware
 * matcher (runtimeTargetReaches) compares with a declaration's own path.
 * `dottedOnly`: the callee has no proven identity, so a literal target counts
 * only when it is written as a dotted path (never a URL or a file name).
 */
function _runtimeTarget(alternative, dottedOnly) {
    const pieces = [];
    for (const piece of alternative) {
        if (piece === WILD) {
            if (pieces[pieces.length - 1] !== WILD) pieces.push(WILD);
        } else if (piece.length > 0) {
            if (pieces.length > 0 && pieces[pieces.length - 1] !== WILD) pieces[pieces.length - 1] += piece;
            else pieces.push(piece);
        }
    }
    const literals = pieces.filter(piece => piece !== WILD);
    if (literals.some(piece => piece.includes('*'))) return null;
    const runtimeTarget = pieces.map(piece => (piece === WILD ? '*' : piece)).join('');
    const member = runtimeTarget.slice(runtimeTarget.lastIndexOf('.') + 1);
    if (!member) return null;
    if (!pieces.includes(WILD)) {
        if (!runtimeTarget.includes('.') || (dottedOnly && !DOTTED_PATH.test(runtimeTarget))) return null;
    } else {
        if (literals.some(piece => !DOTTED_FRAGMENT.test(piece))) return null;
        if (member.includes('*')) {
            // `*`, `_*`: the segment names every member, so it names none.
            if (!_specific(member.split('*').flatMap((part, position) => (position ? [WILD, part] : [part])))) return null;
            return { patterns: [member], runtimeTarget };
        }
    }
    // A private source member is spelled _Owner__member by runtime APIs. The
    // owner-aware matcher decides it; the project matcher must first make its
    // source spelling reachable.
    const spellings = new Set([member]);
    for (let offset = 1; offset < member.length - 1; offset++) {
        if (member[offset] === '_' && member[offset + 1] === '_') spellings.add(member.slice(offset));
    }
    return { name: member, patterns: [...spellings], runtimeTarget };
}

/**
 * The glob of a patch target whose member part is not known (fix #512), or
 * null. The literal part of the path still bounds it: `pkg.core.*` reaches
 * every declaration of `pkg.core`. With no path segment left (`*`, `*.*`)
 * the target can be any attribute of any module; that is answered `*` only
 * for a callee the file's bindings show to be a patch API (`reading`
 * 'proven'). A callee known only by the member it is written with
 * ('spelled') keeps the bounded glob; one that is a patch API only because
 * its origin could not be followed ('possible') names nothing it cannot
 * spell.
 */
function _openTarget(alternative, reading) {
    if (reading === 'possible' || !alternative.includes(WILD)) return null;
    const pieces = [];
    for (const piece of alternative) {
        if (piece === WILD) {
            if (pieces[pieces.length - 1] !== WILD) pieces.push(WILD);
        } else if (piece.length > 0) {
            if (pieces.length > 0 && pieces[pieces.length - 1] !== WILD) pieces[pieces.length - 1] += piece;
            else pieces.push(piece);
        }
    }
    const literals = pieces.filter(piece => piece !== WILD);
    if (literals.some(piece => !DOTTED_FRAGMENT.test(piece))) return null;
    const glob = pieces.map(piece => (piece === WILD ? '*' : piece)).join('');
    const anchored = glob.split(/[.*]+/).some(segment => _specific([segment]));
    if (anchored) return glob;
    return reading === 'proven' ? '*' : null;
}

/** Can an alternative be a member name this reader does not know? */
function _unknownMember(alternatives) {
    return alternatives.some(alternative => {
        const pieces = _normalize(alternative);
        return !!pieces && pieces.includes(WILD) && !_specific(pieces);
    });
}

/** Non-string literals: a value of one of these names no attribute. */
const NON_STRING_VALUES = new Set(['integer', 'float', 'true', 'false', 'none', 'null', 'undefined', 'number',
    'list', 'dictionary', 'tuple', 'set', 'array', 'object']);

function _valueAlternatives(node, ctx, depth = 0) {
    const value = _unwrap(node);
    if (value && NON_STRING_VALUES.has(value.type)) return [];
    return stringAlternatives(value, ctx, depth) || [[WILD]];
}

/** `sep.join(seq)` of a literal list or tuple the patch reader closes. */
function _joined(separator, sequenceNode, ctx, depth) {
    const read = pythonContainerNodes(sequenceNode, ctx.memo);
    if (read.open) return null;
    const cap = ctx.maxAlternatives || MAX_ALTERNATIVES;
    const out = [];
    for (const container of read.nodes) {
        // A set has no order to join in.
        if (!['list', 'tuple'].includes(container.type)) return null;
        let joined = [[]];
        const items = container.namedChildren.filter(child => child.type !== 'comment');
        for (let position = 0; position < items.length; position++) {
            if (items[position].type === 'list_splat') return null;
            if (position > 0) joined = _concat(joined, separator, cap);
            joined = _concat(joined, stringAlternatives(items[position], ctx, depth + 1) || [[WILD]], cap);
        }
        out.push(...joined);
        if (out.length > cap) return [[WILD]];
    }
    return out;
}

/**
 * `d[key]`, `seq[i]` or `d.get(key, fallback)` of literal containers: the
 * entry a literal key selects, every entry for any other key, the fallback
 * where the key may be absent. A `**spread` makes the keys unknown.
 */
function _lookedUp(containers, keyNode, fallbackNode, ctx, depth) {
    const { pythonStringLiteral } = require('./runtime-entrypoints');
    const literalKey = node => {
        const key = _unwrap(node);
        if (!key) return undefined;
        if (key.type === 'integer') return Number.isSafeInteger(Number(key.text)) ? Number(key.text) : undefined;
        if (key.type === 'unary_operator' && /^-\s*\d+$/.test(key.text)) return Number(key.text.replace(/\s+/g, ''));
        if (STRING_NODES.has(key.type)) return pythonStringLiteral(key) ?? undefined;
        return undefined;
    };
    if (_unwrap(keyNode)?.type === 'slice') return null;
    const wanted = literalKey(keyNode);
    const values = [];
    let missing = wanted === undefined;
    for (const container of containers) {
        if (container.type === 'dictionary') {
            let found = false;
            for (const pair of container.namedChildren) {
                if (pair.type === 'comment') continue;
                if (pair.type !== 'pair') return null;
                const key = literalKey(pair.childForFieldName('key'));
                if (wanted !== undefined && key !== undefined && key !== wanted) continue;
                values.push(pair.childForFieldName('value'));
                if (key === wanted) found = true;
            }
            if (!found) missing = true;
        } else if (['list', 'tuple'].includes(container.type)) {
            const items = container.namedChildren.filter(child => child.type !== 'comment');
            if (items.some(item => item.type === 'list_splat')) return null;
            if (typeof wanted === 'number') {
                const item = items[wanted < 0 ? items.length + wanted : wanted];
                if (item) values.push(item); else missing = true;
            } else if (wanted === undefined) values.push(...items);
        } else return null;
    }
    if (missing && fallbackNode) values.push(fallbackNode);
    const cap = ctx.maxAlternatives || MAX_ALTERNATIVES;
    const out = [];
    for (const value of values) {
        out.push(..._valueAlternatives(value, ctx, depth + 1));
        if (out.length > cap) return [[WILD]];
    }
    return out;
}

/**
 * Sites of a patch call that names its attribute by a dotted path, from the
 * alternatives of the path: exact or globbed targets, and an open target
 * (`_openTarget`) for an alternative whose member is not known. `dottedOnly`:
 * a literal path counts only when written as one.
 */
function _targetSites(alternatives, dottedOnly, reading) {
    const out = [];
    const seen = new Set();
    for (const alternative of alternatives) {
        const target = _runtimeTarget(alternative, dottedOnly);
        if (target) {
            if (seen.has(target.runtimeTarget)) continue;
            seen.add(target.runtimeTarget);
            out.push({ kind: 'runtime-target', ...(target.name && { name: target.name }),
                patterns: target.patterns, dynamic: false, runtimeTarget: target.runtimeTarget });
            continue;
        }
        const open = _openTarget(alternative, reading);
        if (!open || seen.has(open)) continue;
        seen.add(open);
        out.push({ kind: 'runtime-target', patterns: ['*'], dynamic: true, open: true, runtimeTarget: open });
    }
    return out;
}

/**
 * Sites of a patch call that names its attribute by an owner object and a
 * member name. An owner the file proves (`owner`, pythonPatchOwner; the
 * class of a `self` receiver) holds only its own members, so the site
 * reaches no namesake elsewhere (fix #512); a member that is not known then
 * reaches every member that owner holds. With no owner, a named member
 * withholds every declaration of that name, and an unknown one every
 * declaration, only for a callee the file's bindings show to be a patch
 * API (`reading`, see _openTarget).
 */
function _memberSites(alternatives, receiver, reading, owner = null) {
    const member = _classifyAlternatives(alternatives);
    const held = owner || (receiver?.kind === 'self' ? { receiver: true } : null);
    const out = [];
    if (member.name || member.patterns) {
        out.push({ kind: 'runtime-member', ...(member.name && { name: member.name }),
            patterns: member.patterns || [member.name], dynamic: false,
            ...(receiver && { receiver }), ...(held && { owner: held }) });
    }
    if (reading !== 'possible' && _unknownMember(alternatives)) {
        if (held) out.push({ kind: 'runtime-member', patterns: ['*'], dynamic: true, open: true, ...(receiver && { receiver }), owner: held });
        else if (reading === 'proven') out.push({ kind: 'runtime-member', patterns: ['*'], dynamic: true, open: true });
    }
    return out;
}

/** The pieces of `template` with each PARAM piece replaced by `value`. */
function _substitute(template, value) {
    const out = [];
    for (const piece of template) {
        if (piece === PARAM) out.push(...value);
        else out.push(piece);
    }
    return out;
}

/**
 * The value reader of a patch call (fix #512): names read as the language
 * reads them, containers closed where the file never changes them, a
 * parameter of the enclosing callable left as PARAM for its callers.
 */
function _patchValueCtx(language, memo, slot) {
    const api = langTraits(language)?.reflectionApi || {};
    const ctx = { formatCalls: api.formatCalls || null, language, maxAlternatives: MAX_PATCH_ALTERNATIVES };
    if (api.pythonBindingIdentity) {
        Object.assign(ctx, { resolve: identifier => pythonPossibleValues(identifier, memo), interpolations: true,
            containers: true, memo });
    } else {
        const resolve = makeResolver();
        ctx.resolve = identifier => resolve(identifier) || _eachTableValues(identifier, api.eachRunners);
    }
    if (slot) ctx.parameter = identifier => _patchParameter(identifier, language, slot, memo);
    return ctx;
}

/**
 * The values a runner's table gives a parameter of the callback it runs
 * (`test.each(table)(title, fn)`, `it.each`, `describe.each`; the runners
 * are the trait's `reflectionApi.eachRunners`): a row that is
 * an array literal spreads into the parameters, another row is the first
 * one (fix #512, the JS form of a parametrize mark). Null when the callback
 * is no such one or the table is not a literal array of literal rows.
 */
function _eachTableValues(ident, runners) {
    const fn = runners ? _parameterCallable(ident) : null;
    if (!fn || !['arrow_function', 'function_expression', 'function'].includes(fn.type)) return null;
    const position = (_parameterNames(fn) || []).indexOf(ident.text);
    const call = fn.parent?.type === 'arguments' ? fn.parent.parent : null;
    const each = call?.type === 'call_expression' ? call.childForFieldName('function') : null;
    const runner = each?.type === 'call_expression' ? each.childForFieldName('function') : null;
    if (position < 0 || runner?.type !== 'member_expression' || runner.childForFieldName('property')?.text !== 'each' ||
        !runners.test(_calleeName(runner.childForFieldName('object')))) return null;
    if (each.childForFieldName('arguments')?.type !== 'arguments') return null;
    const table = _unwrap((_callArgs(each) || [])[0]);
    if (table?.type !== 'array') return null;
    const values = [];
    for (const row of table.namedChildren) {
        if (row.type === 'comment') continue;
        if (row.type === 'spread_element') return null;
        if (row.type === 'array') {
            const cells = row.namedChildren.filter(child => child.type !== 'comment');
            if (cells.some(cell => cell.type === 'spread_element')) return null;
            if (cells[position]) values.push(cells[position]);
        } else if (position === 0) values.push(row);
    }
    return values;
}

/**
 * Is `ident` a parameter whose value the callers of its callable decide? It
 * is recorded in `slot` (one parameter per site; another one reads as
 * unknown). A Python callable a runner or a framework invokes (a `test*`
 * function, one with a decorator that may register it) is filled by them,
 * so its parameter stays unknown.
 */
function _patchParameter(ident, language, slot, memo) {
    const key = _keyParameter(ident, language);
    const fn = key ? _parameterCallable(ident) : null;
    if (!fn) return false;
    const api = langTraits(language)?.reflectionApi || {};
    if (api.pythonBindingIdentity) {
        const name = fn.childForFieldName('name')?.text || '';
        const decorated = fn.parent?.type === 'decorated_definition' ? fn.parent : null;
        if (/^test/.test(name) || (decorated && !pythonDecoratorsInert(decorated, memo))) return false;
    }
    // A callable its file hands on as a value (returned by a fixture, kept
    // in a table) is called under other names, and a member the runtime
    // invokes by protocol (`__init__` on construction, `__call__`,
    // `__enter__`) is never called by its name: its callers are not known.
    if (_callableEscapes(fn, key.name, memo)) return false;
    const protocol = langTraits(language)?.languageProtocolMember;
    if (typeof protocol === 'function' && protocol(key.name, { isMember: !!key.owner })) return false;
    const parameter = { ...key, keyword: ident.text, ..._parameterDefault(fn, ident, language, memo) };
    if (slot.parameter) {
        return slot.parameter.name === parameter.name && slot.parameter.line === parameter.line &&
            slot.parameter.keyword === parameter.keyword;
    }
    slot.parameter = parameter;
    return true;
}

// Where the name of a callable may stand without handing the callable on:
// its own declaration, an import or export of it, a parameter or keyword
// that only shares the spelling.
const NAMING_PARENTS = new Set(['function_definition', 'function_declaration', 'generator_function_declaration',
    'method_definition', 'variable_declarator', 'import_statement', 'import_from_statement', 'aliased_import',
    'dotted_name', 'import_specifier', 'export_specifier', 'import_clause', 'namespace_import', 'parameters',
    'typed_parameter', 'default_parameter', 'typed_default_parameter', 'formal_parameters', 'required_parameter',
    'optional_parameter']);

/**
 * Does the file holding `fn` use its name other than to call it? Any other
 * occurrence (returned, assigned, stored, passed) lets code call it under
 * another name, so the calls of its own name are not all of its callers.
 */
function _callableEscapes(fn, name, memo) {
    const key = `patch-callable-escapes:${name}`;
    if (memo?.has(key)) return memo.get(key);
    const IDENTIFIERS = ['identifier', 'property_identifier', 'shorthand_property_identifier'];
    let escapes = false;
    for (const occurrence of fn.tree.rootNode.descendantsOfType(IDENTIFIERS)) {
        if (occurrence.text !== name) continue;
        let node = occurrence;
        let parent = node.parent;
        if (!parent) continue;
        const field = fieldName => sameNode(parent.childForFieldName(fieldName), node);
        // A keyword of that name, a declaration or import of it, a parameter
        // sharing the spelling. A default value or an initializer reads it.
        if (parent.type === 'keyword_argument' && field('name')) continue;
        if (NAMING_PARENTS.has(parent.type) && !field('value')) continue;
        // `obj.name(..)`: the member of a call's callee.
        if (MEMBER_CALLEE_FIELDS[parent.type] && field(MEMBER_CALLEE_FIELDS[parent.type][0])) {
            node = parent;
            parent = parent.parent;
        }
        if (parent && CALL_NODE_TYPES.includes(parent.type) && sameNode(parent.childForFieldName('function'), node)) continue;
        escapes = true;
        break;
    }
    memo?.set(key, escapes);
    return escapes;
}

/** The callable whose parameter `ident` is, or null (a lambda binds it). */
function _parameterCallable(ident) {
    for (let fn = ident.parent; fn; fn = fn.parent) {
        if (CLASS_NODES.has(fn.type)) return null;
        if (fn.type === 'lambda') {
            const own = fn.childForFieldName('parameters');
            if (own && own.descendantsOfType('identifier').some(id => id.text === ident.text)) return null;
            continue;
        }
        if (!PARAMETER_OWNERS.has(fn.type)) continue;
        const names = _parameterNames(fn);
        if (!names) return null;
        if (names.includes(ident.text)) return fn;
    }
    return null;
}

/**
 * How a call that does not pass the parameter positionally gives it a value:
 * `keywordOnly` (after `*` / `*args`), and `fallback`, the alternatives of
 * its default (absent: no default, so such a call names nothing).
 */
function _parameterDefault(fn, ident, language, memo) {
    const list = fn.childForFieldName('parameters') ||
        (fn.namedChildren || []).find(child => PARAMETER_LISTS.has(child.type));
    let keywordOnly = false;
    for (const param of list?.namedChildren || []) {
        if (['keyword_separator', 'list_splat_pattern'].includes(param.type)) { keywordOnly = true; continue; }
        const named = param.type === 'identifier' ? param
            : param.childForFieldName('name') || param.childForFieldName('pattern') || param.childForFieldName('left') ||
                (param.type === 'typed_parameter' ? param.namedChild(0) : null);
        if (named?.text !== ident.text) continue;
        const value = param.childForFieldName('value') || param.childForFieldName('right') ||
            param.childForFieldName('default');
        const out = keywordOnly ? { keywordOnly: true } : {};
        if (value) out.fallback = _valueAlternatives(value, _patchValueCtx(language, memo, null));
        return out;
    }
    return {};
}

const MAX_PARAMETER_HOPS = 3;

/**
 * The values callers pass a recorded parameter: { alternatives, open }.
 * Each call of the callable's name in the language family is read from its
 * own AST: the argument at the position or under the keyword, else the
 * default. A call that spreads its arguments, a use of the callable as a
 * value, an unreadable caller or too many calls leave the set open; so does
 * a caller's own parameter past MAX_PARAMETER_HOPS, and so does a callable
 * no file of the project calls: it is called from elsewhere (a script, a
 * runner, another package) with values not known here.
 */
function _parameterValues(index, file, language, parameter, depth = 0) {
    const out = { alternatives: [], open: false };
    if (depth >= MAX_PARAMETER_HOPS) { out.open = true; return out; }
    const { getCachedCalls } = require('./callers');
    const { getParser, safeParse } = require('../languages');
    // An import that renames the callable calls it under another name.
    for (const entry of index.files.values()) {
        if ((entry.importBindings || []).some(binding => binding.name === parameter.name &&
            binding.alias && binding.alias !== parameter.name)) { out.open = true; return out; }
    }
    let seen = 0;
    for (const callerFile of [...(index.getCalleeFiles?.(parameter.name) || [])].sort()) {
        const entry = index.files.get(callerFile);
        if (!entry || _family(entry.language) !== _family(language)) continue;
        const calls = (getCachedCalls(index, callerFile) || []).filter(call => call.name === parameter.name);
        if (calls.some(call => call.isFunctionReference)) { out.open = true; return out; }
        // A method is called through a receiver, never by its bare name, and
        // not through an instance of a class that neither is nor derives from
        // the method's class.
        const relevant = calls.filter(call => !(parameter.owner && !call.isMethod) &&
            !(parameter.owner && call.receiverIsTypeQualified && call.receiver && call.receiver !== parameter.owner) &&
            !(parameter.owner && call.receiverType && !_mayBeInstanceOf(index, call.receiverType, callerFile, parameter.owner, file)));
        if (relevant.length === 0) continue;
        seen += relevant.length;
        if (seen > MAX_KEY_CALLS) { out.open = true; return out; }
        let tree;
        try {
            const content = index._readFile(callerFile);
            tree = index._getParsedTree?.(callerFile, content, entry.language) || safeParse(getParser(entry.language), content);
        } catch { tree = null; }
        if (!tree) { out.open = true; return out; }
        const memo = new Map();
        for (const call of relevant) {
            const offset = call.callStart ?? call.callSite?.start;
            let node = Number.isInteger(offset) ? tree.rootNode.descendantForIndex(offset) : null;
            for (let up = 0; node && up < 6 && !CALL_NODE_TYPES.includes(node.type); up++) node = node.parent;
            const args = node ? _callArgs(node) : null;
            if (!args || args.some(arg => /splat|spread/.test(arg.type))) { out.open = true; return out; }
            // `Other().name(..)`: an instance constructed in place of a class
            // that is not the method's.
            const callee = parameter.owner ? _calleeParts(node, true, false) : null;
            const built = callee?.object ? _calleeNode(callee.object) : null;
            const builder = built && CALL_NODE_TYPES.includes(built.type) ? _calleeNode(built.childForFieldName('function')) : null;
            if (builder?.type === 'identifier' && !_mayBeInstanceOf(index, builder.text, callerFile, parameter.owner, file)) continue;
            const positional = args.filter(arg => arg.type !== 'keyword_argument');
            const keyword = args.find(arg => arg.type === 'keyword_argument' &&
                arg.childForFieldName('name')?.text === parameter.keyword)?.childForFieldName('value');
            let argument = keyword || (!parameter.keywordOnly ? positional[parameter.index] : null);
            if (argument?.type === 'argument') argument = argument.namedChildren.find(child => child.type !== 'comment') || argument;
            let alternatives;
            if (argument) {
                const slot = {};
                alternatives = _valueAlternatives(argument, _patchValueCtx(entry.language, memo, slot));
                // The callable passing its own parameter on to itself adds no value.
                if (slot.parameter && callerFile === file && slot.parameter.name === parameter.name &&
                    slot.parameter.line === parameter.line && slot.parameter.keyword === parameter.keyword) {
                    alternatives = alternatives.filter(alternative => !alternative.includes(PARAM));
                }
                if (slot.parameter && alternatives.some(alternative => alternative.includes(PARAM))) {
                    const inner = _parameterValues(index, callerFile, entry.language, slot.parameter, depth + 1);
                    const values = inner.open ? [...inner.alternatives, [WILD]] : inner.alternatives;
                    alternatives = alternatives.flatMap(alternative => (alternative.includes(PARAM)
                        ? values.map(value => _substitute(alternative, value)) : [alternative]));
                }
            } else alternatives = parameter.fallback || [];
            out.alternatives.push(...alternatives);
            if (out.alternatives.length > MAX_PATCH_ALTERNATIVES) return { alternatives: [], open: true };
        }
    }
    if (seen === 0) out.open = true;
    return out;
}

/**
 * Can a receiver typed `typeName` (at `callerFile`) be an instance of the
 * class `owner` declared in `ownerFile`? Unknown classes can.
 */
function _mayBeInstanceOf(index, typeName, callerFile, owner, ownerFile) {
    const ci = require('./class-identity');
    const ref = ci.resolveClassRef(index, typeName, callerFile);
    if (!ref?.key) return true;
    const owners = ci.classDefsNamed(index, owner).entries;
    const own = owners.filter(entry => entry.def.file === ownerFile);
    const candidates = own.length > 0 ? own : owners;
    if (candidates.length === 0) return true;
    return candidates.some(entry => entry.key === ref.key || _reachesKey(index, ref, entry.key, owner));
}

/**
 * The sites a recorded patch site stands for once its parameter is read
 * (fix #512): the site's alternatives with each value its callers pass,
 * and an open alternative when the values cannot be closed.
 */
function _resolveDeferredSite(index, entry) {
    const site = entry.site;
    const deferred = site.deferred;
    const values = _parameterValues(index, entry.file, entry.language, deferred.parameter);
    const substitutes = values.open ? [...values.alternatives, [WILD]] : values.alternatives;
    let alternatives = [];
    for (const template of deferred.alternatives) {
        for (const value of substitutes) alternatives.push(_substitute(template, value));
        if (alternatives.length > MAX_PATCH_ALTERNATIVES) {
            alternatives = deferred.alternatives.map(own => _substitute(own, [WILD]));
            break;
        }
    }
    const reading = deferred.spelledOnly ? 'spelled' : 'proven';
    const concrete = site.kind === 'runtime-target'
        ? _targetSites(alternatives, !!deferred.dottedOnly, reading)
        : _memberSites(alternatives, site.receiver || null, reading, site.owner || null);
    return concrete.map(resolved => ({ ...resolved, line: site.line, expression: site.expression, fromParameter: true }));
}

/** Could a value of the recorded parameter make the site spell `name`? */
function _deferredCanSpell(site, name) {
    return site.deferred.alternatives.some(alternative => {
        const glob = alternative.map(piece => (piece === PARAM || piece === WILD ? '*' : piece)).join('');
        return globMatches(site.kind === 'runtime-target' ? glob.slice(glob.lastIndexOf('.') + 1) : glob, name);
    });
}

/**
 * Classify a name expression.
 * @returns {{name?: string, patterns?: string[], dynamic: boolean}}
 *   name - one exact spelling; patterns - specific glob patterns (sorted);
 *   dynamic - some alternative is unknown or names anything.
 */
function classifyNameExpression(node, ctx) {
    const alts = stringAlternatives(node, ctx);
    if (!alts) return { dynamic: true };
    return _classifyAlternatives(alts);
}

function _classifyAlternatives(alts) {
    const exact = new Set();
    const patterns = new Set();
    let dynamic = false;
    for (const raw of alts) {
        const pieces = _normalize(raw);
        if (!pieces) continue; // cannot spell a member name
        if (!pieces.includes(WILD)) exact.add(pieces[0]);
        else if (_specific(pieces)) patterns.add(patternText(pieces));
        else dynamic = true;
    }
    if (exact.size === 0 && patterns.size === 0) return { dynamic: true };
    if (exact.size === 1 && patterns.size === 0 && !dynamic) {
        return { name: [...exact][0], dynamic: false };
    }
    // Several exact spellings behave as one-literal patterns.
    return { patterns: [...exact, ...patterns].sort(), dynamic };
}

// ---------------------------------------------------------------------------
// Local string bindings (one hop, same scope)
// ---------------------------------------------------------------------------

function _enclosingScope(node) {
    let cur = node.parent;
    while (cur && !SCOPE_NODES.has(cur.type)) cur = cur.parent;
    return cur;
}

function _bindingPairs(node) {
    switch (node.type) {
        case 'assignment': // Python
        case 'assignment_expression': { // JS, C#
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            return left?.type === 'identifier' && right ? [[left.text, right]] : [];
        }
        case 'augmented_assignment':
        case 'augmented_assignment_expression':
        case 'compound_assignment_expr': {
            const left = node.childForFieldName('left');
            return left?.type === 'identifier' ? [[left.text, null]] : [];
        }
        case 'variable_declarator': { // JS, Java, C#
            const name = node.childForFieldName('name') ||
                node.namedChildren.find(c => c.type === 'identifier');
            let value = node.childForFieldName('value');
            if (!value) {
                const named = node.namedChildren.filter(c => c !== name && c.type !== 'comment');
                const clause = named.find(c => c.type === 'equals_value_clause');
                value = clause ? clause.namedChild(0) : (named.length > 0 ? named[named.length - 1] : null);
                if (value && (value.type === 'bracketed_argument_list' || value.type.endsWith('_type'))) value = null;
            }
            return name?.type === 'identifier' && value ? [[name.text, value]] : [];
        }
        case 'short_var_declaration': // Go
        case 'assignment_statement': {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            const ls = left?.namedChildren || [];
            const rs = right?.namedChildren || [];
            if (ls.length !== rs.length) {
                return ls.filter(l => l.type === 'identifier').map(l => [l.text, null]);
            }
            return ls.map((l, i) => (l.type === 'identifier' ? [l.text, rs[i]] : null)).filter(Boolean);
        }
        case 'var_spec':
        case 'const_spec': {
            const names = node.namedChildren.filter(c => c.type === 'identifier');
            const value = node.childForFieldName('value');
            const rs = value?.namedChildren || [];
            if (names.length !== rs.length) return names.map(n => [n.text, null]);
            return names.map((n, i) => [n.text, rs[i]]);
        }
        default:
            return [];
    }
}

function makeResolver() {
    const scopes = new Map();
    const bindingsOf = scope => {
        const key = `${scope.startIndex}:${scope.endIndex}`;
        let map = scopes.get(key);
        if (map) return map;
        map = new Map();
        scopes.set(key, map);
        const visit = n => {
            for (const child of n.namedChildren || []) {
                // Nested callables own their own bindings.
                if (SCOPE_NODES.has(child.type)) continue;
                for (const [name, value] of _bindingPairs(child)) {
                    if (!map.has(name)) map.set(name, []);
                    map.get(name).push(value);
                }
                visit(child);
            }
        };
        visit(scope.type === 'method_definition' || scope.type === 'function_definition' ||
            scope.type === 'method_declaration'
            ? (scope.childForFieldName('body') || scope) : scope);
        return map;
    };
    return ident => {
        const scope = _enclosingScope(ident);
        if (!scope) return null;
        const values = bindingsOf(scope).get(ident.text);
        // A parameter/captured name (no binding here) or any non-value
        // rebinding (augmented, tuple split) leaves the name unknown.
        if (!values || values.some(v => !v)) return null;
        return values;
    };
}

// ---------------------------------------------------------------------------
// Receivers
// ---------------------------------------------------------------------------

function _enclosingClass(node, stopAtThisRebinding) {
    let cur = node.parent;
    while (cur) {
        if (CLASS_NODES.has(cur.type)) return cur;
        if (stopAtThisRebinding && (THIS_REBINDING_FUNCTIONS.has(cur.type) ||
            // An object-literal method binds `this` to the literal.
            (cur.type === 'method_definition' && cur.parent?.type === 'object'))) return null;
        cur = cur.parent;
    }
    return null;
}

function _classInfo(classNode) {
    const nameNode = classNode.childForFieldName('name') ||
        classNode.namedChildren.find(c => c.type === 'identifier' || c.type === 'type_identifier');
    if (!nameNode) return null;
    return { name: nameNode.text, line: classNode.startPosition.row + 1 };
}

/** Is `ident` the self parameter of the method it appears in? */
function _selfParamClass(ident, selfNames) {
    if (!selfNames || !selfNames.includes(ident.text)) return null;
    let fn = ident.parent;
    while (fn && fn.type !== 'function_definition') fn = fn.parent;
    if (!fn) return null;
    const params = fn.childForFieldName('parameters');
    const first = params?.namedChildren?.find(c => c.type !== 'comment');
    const firstName = first?.type === 'identifier' ? first.text
        : first?.childForFieldName?.('name')?.text || null;
    if (firstName !== ident.text) return null;
    // Decorated methods sit in decorated_definition inside the class block.
    let owner = fn.parent;
    if (owner?.type === 'decorated_definition') owner = owner.parent;
    if (owner?.type !== 'block' || owner.parent?.type !== 'class_definition') return null;
    return _classInfo(owner.parent);
}

/**
 * Receiver facts of a reflective access. Returns null (untyped: any class) or
 *   { kind: 'self', className, classLine } - self/this/getClass()/GetType();
 *   { kind: 'name', name } - an identifier that may name a class (resolved
 *     against the index at query time; anything else stays untyped);
 *   { kind: 'type', name } - a class literal (`Foo.class`, `typeof(Foo)`).
 */
function classifyReceiver(node, language) {
    node = _unwrap(node);
    if (!node) return null;
    const traits = langTraits(language) || {};
    const api = traits.reflectionApi || {};
    const selfNames = Array.isArray(traits.selfParam) ? traits.selfParam : [];
    const selfOf = (anchor, stop) => {
        const cls = _enclosingClass(anchor, stop);
        const info = cls && _classInfo(cls);
        return info ? { kind: 'self', className: info.name, classLine: info.line } : null;
    };
    if (node.type === 'this' || node.type === 'this_expression' ||
        (node.type === 'identifier' && node.text === 'this' && selfNames.includes('this'))) {
        return selfOf(node, true);
    }
    if (node.type === 'identifier') {
        const info = _selfParamClass(node, selfNames);
        if (info) return { kind: 'self', className: info.name, classLine: info.line };
        return { kind: 'name', name: node.text };
    }
    // type(self) / self.__class__ / getClass() / this.GetType()
    if (node.type === 'call' || node.type === 'method_invocation' || node.type === 'invocation_expression') {
        const fn = node.childForFieldName('function') || node.childForFieldName('name');
        const obj = node.type === 'method_invocation' ? node.childForFieldName('object') : null;
        const argsNode = node.childForFieldName('arguments') ||
            node.namedChildren.find(c => c.type === 'argument_list');
        const args = (argsNode?.namedChildren || []).filter(c => c.type !== 'comment');
        const fnName = fn?.type === 'member_access_expression'
            ? fn.childForFieldName('name')?.text : fn?.text;
        const fnObj = fn?.type === 'member_access_expression' ? fn.childForFieldName('expression') : obj;
        if ((api.selfTypeCalls || []).includes(fnName) && args.length === 0 &&
            (!fnObj || fnObj.type === 'this' || fnObj.type === 'this_expression')) {
            return selfOf(node, true);
        }
        if (fnName === 'type' && args.length === 1 && args[0].type === 'identifier') {
            const info = _selfParamClass(args[0], selfNames);
            if (info) return { kind: 'self', className: info.name, classLine: info.line };
        }
        return null;
    }
    if (node.type === 'attribute' && node.childForFieldName('attribute')?.text === '__class__') {
        const obj = node.childForFieldName('object');
        const info = obj?.type === 'identifier' && _selfParamClass(obj, selfNames);
        if (info) return { kind: 'self', className: info.name, classLine: info.line };
        return null;
    }
    // Foo.class (Java) / typeof(Foo) (C#): certainly a type.
    if ((api.typeLiteralNodes || []).includes(node.type)) {
        const t = node.namedChildren.find(c => c.type !== 'comment');
        const name = t ? String(t.text).replace(/<.*$/s, '').split('.').pop() : null;
        // C# `typeof(Outcome<>)` / `typeof(Outcome<,>)`: the written arity
        // selects one of the same-name types (fix #389).
        let arity;
        if (t?.type === 'generic_name') {
            const list = t.namedChildren.find(c => c.type === 'type_argument_list');
            const args = list ? list.namedChildren.filter(c => c.type !== 'comment') : [];
            arity = args.length > 0 ? args.length
                : list ? list.children.filter(c => c.type === ',').length + 1 : 0;
        } else if (t?.type === 'identifier' && node.type === 'typeof_expression') {
            arity = 0;
        }
        return name ? { kind: 'type', name, ...(arity !== undefined && { arity }) } : null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Names one call away (fix #428)
// ---------------------------------------------------------------------------

// Callables whose parameters a reflective name can be (grammar node types).
const PARAMETER_OWNERS = new Set([
    'function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function',
    'arrow_function', 'method_definition', 'function_definition', 'method_declaration',
    'constructor_declaration', 'local_function_statement', 'func_literal',
]);
const PARAMETER_LISTS = new Set(['formal_parameters', 'parameters', 'parameter_list']);
const VARIADIC_PARAMETERS = new Set(['rest_pattern', 'list_splat_pattern', 'dictionary_splat_pattern',
    'spread_parameter', 'variadic_parameter_declaration', 'variadic_parameter']);

/** The parameter names of a callable in declaration order (null if unknown). */
function _parameterNames(fn) {
    const list = fn.childForFieldName('parameters') ||
        (fn.namedChildren || []).find(child => PARAMETER_LISTS.has(child.type));
    if (!list) {
        // `x => ..`: a single bare parameter.
        const single = fn.childForFieldName('parameter');
        return single?.type === 'identifier' ? [single.text] : null;
    }
    const names = [];
    for (const param of list.namedChildren) {
        if (param.type === 'comment') continue;
        if (param.type === 'identifier') { names.push(param.text); continue; }
        // A Go declaration may name several parameters of one type.
        if (param.type === 'parameter_declaration' || param.type === 'variadic_parameter_declaration') {
            const ids = param.namedChildren.filter(child => child.type === 'identifier');
            if (ids.length === 0) names.push(null);
            for (const id of ids) names.push(id.text);
            continue;
        }
        const named = param.childForFieldName('name') || param.childForFieldName('pattern') ||
            param.childForFieldName('left') ||
            (param.type === 'typed_parameter' ? param.namedChild(0) : null);
        names.push(named?.type === 'identifier' ? named.text : null);
    }
    return names;
}

/** The name a callable is called by: its own, or the binding it is assigned to. */
function _callableName(fn) {
    const own = fn.childForFieldName('name');
    if (own) return own.text;
    const parent = fn.parent;
    if (parent?.type === 'variable_declarator') return parent.childForFieldName('name')?.text || null;
    if (parent?.type === 'pair') return parent.childForFieldName('key')?.text?.replace(/^["']|["']$/g, '') || null;
    if (parent?.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left?.type === 'identifier') return left.text;
        if (left?.type === 'member_expression') return left.childForFieldName('property')?.text || null;
    }
    return null;
}

/** Does `body` assign the name anywhere (nested callables included)? */
function _assignsName(body, name) {
    const stack = [body];
    while (stack.length > 0) {
        const node = stack.pop();
        if (_bindingPairs(node).some(([bound]) => bound === name)) return true;
        for (const child of node.namedChildren || []) stack.push(child);
    }
    return false;
}

/**
 * A reflective name that is a parameter of an enclosing callable, never
 * rebound: { name, line, index } (the call-site argument position), else
 * null. Its value is the argument the callable's callers pass.
 */
function _keyParameter(ident, language) {
    if (ident?.type !== 'identifier') return null;
    for (let fn = ident.parent; fn; fn = fn.parent) {
        if (CLASS_NODES.has(fn.type)) return null;
        if (!PARAMETER_OWNERS.has(fn.type)) continue;
        const names = _parameterNames(fn);
        if (!names) return null;
        let position = names.indexOf(ident.text);
        if (position < 0) continue; // captured from an outer callable
        const name = _callableName(fn);
        if (!name || _assignsName(fn.childForFieldName('body') || fn, ident.text)) return null;
        // A method's receiver parameter (`self`, `cls`) is not a call
        // argument of a bound call.
        const selfNames = langTraits(language)?.selfParam || [];
        let owner = fn.parent?.type === 'decorated_definition' ? fn.parent.parent : fn.parent;
        if (fn.type === 'function_definition' && owner?.type === 'block' &&
            owner.parent?.type === 'class_definition' && selfNames.includes(names[0])) {
            if (position === 0) return null;
            position--;
        }
        // The class a method belongs to: a call naming another class as its
        // qualifier is no call of it. A C# extension's `this` parameter is
        // the receiver of an extension call (`t.M(x)`).
        const ownerClass = _enclosingClass(fn, false);
        const ownerName = ownerClass ? _classInfo(ownerClass)?.name || null : null;
        const params = (fn.childForFieldName('parameters')?.namedChildren || []).filter(child => child.type !== 'comment');
        const firstParam = params.find(child => child.type === 'parameter');
        const extension = !!firstParam?.children?.some(child => child.type === 'modifier' && child.text === 'this');
        // A call passing more arguments than a fixed parameter list takes
        // is not a call of it.
        const variadic = params.some(param => VARIADIC_PARAMETERS.has(param.type) ||
            param.children?.some(child => child.type === 'modifier' && child.text === 'params') ||
            param.namedChildren?.some(child => VARIADIC_PARAMETERS.has(child.type)));
        const maxArgs = variadic ? null : names.length - (names.length > 0 && selfNames.includes(names[0]) &&
            fn.type === 'function_definition' && owner?.type === 'block' && owner.parent?.type === 'class_definition' ? 1 : 0);
        return { name, line: fn.startPosition.row + 1, index: position,
            ...(ownerName && { owner: ownerName }), ...(extension && { extension: true }),
            ...(Number.isInteger(maxArgs) && { maxArgs }) };
    }
    return null;
}

const MAX_KEY_CALLS = 256;
// Characters after a call's name its arguments are looked for in, when the
// record keeps only the name's position.
const KEY_CALL_WINDOW = 4096;

/**
 * The names a parameter-keyed site receives (fix #428): the string-shaped
 * arguments at the parameter's position in the calls naming its callable,
 * read from each call's own AST (one hop). Null when no call passes one.
 */
function resolveKeyParameter(index, site, language, onlyFiles = null, onlyName = null) {
    const key = site.keyParameter;
    const { getCachedCalls } = require('./callers');
    const { getParser, safeParse } = require('../languages');
    const files = [...(onlyFiles || index.getCalleeFiles?.(key.name) || [])].sort();
    const exact = new Set();
    let seen = 0;
    for (const file of files) {
        const entry = index.files.get(file);
        if (!entry || _family(entry.language) !== _family(language)) continue;
        // A call qualified by another class's name never calls the method;
        // an extension call passes the `this` argument as its receiver.
        const shift = call => key.extension && call.isMethod && call.receiver && call.receiver !== key.owner ? 1 : 0;
        const position = call => key.index - shift(call);
        let calls = (getCachedCalls(index, file) || []).filter(call => call.name === key.name &&
            !call.isFunctionReference && position(call) >= 0 &&
            !(Number.isInteger(key.maxArgs) && Number.isInteger(call.argCount) && call.argCount > key.maxArgs - shift(call)) &&
            !(Number.isInteger(call.argCount) && call.argCount <= position(call)) &&
            !(key.owner && call.receiverIsTypeQualified && call.receiver && call.receiver !== key.owner));
        if (calls.length === 0) continue;
        seen += calls.length;
        if (seen > MAX_KEY_CALLS) return null;
        let content;
        try { content = index._readFile(file); } catch { continue; }
        // A literal argument lies in the call's text: a call whose text
        // spells no quoted `onlyName` cannot pass it, and needs no parse.
        if (onlyName) {
            const quoted = ['"', "'", '`'].map(quote => `${quote}${onlyName}${quote}`);
            calls = calls.filter(call => {
                const start = call.callStart ?? call.callSite?.start;
                if (!Number.isInteger(start)) return true;
                const text = content.slice(start, call.callEnd ?? start + KEY_CALL_WINDOW);
                return quoted.some(spelling => text.includes(spelling));
            });
            if (calls.length === 0) continue;
        }
        const tree = index._getParsedTree?.(file, content, entry.language) || safeParse(getParser(entry.language), content);
        if (!tree) continue;
        const api = langTraits(entry.language)?.reflectionApi || {};
        const ctx = { formatCalls: api.formatCalls || null, resolve: makeResolver() };
        for (const call of calls) {
            const offset = call.callStart ?? call.callSite?.start;
            if (!Number.isInteger(offset)) continue;
            let node = tree.rootNode.descendantForIndex(offset);
            for (let depth = 0; node && depth < 6 && !CALL_NODE_TYPES.includes(node.type); depth++) node = node.parent;
            const args = node ? _callArgs(node) : null;
            // Keyword, spread or missing arguments do not bind by position.
            if (!args || args.slice(0, position(call) + 1).some(arg =>
                /keyword_argument|spread|splat|named_argument/.test(arg.type) ||
                (arg.type === 'argument' && arg.childForFieldName('name')))) continue;
            let arg = args[position(call)];
            if (arg?.type === 'argument') arg = arg.namedChildren.find(child => child.type !== 'comment') || arg;
            if (!arg) continue;
            const cls = classifyNameExpression(arg, ctx);
            if (cls.name) exact.add(cls.name);
            for (const pattern of cls.patterns || []) if (!pattern.includes('*')) exact.add(pattern);
        }
    }
    return exact.size > 0 ? [...exact].sort() : null;
}

const QUOTED_IDENTIFIER = /(["'`])([A-Za-z_$][\w$]*)\1/g;

/**
 * Could a parameter-keyed site receive `name` (fix #428)? Only when a file
 * holding a call of its callable spells `name` as a string literal: the
 * files' quoted identifiers are read once, and the AST resolution runs only
 * for a name they hold.
 */
function _keyParameterPasses(index, pidx, entry, name) {
    const files = index.getCalleeFiles?.(entry.site.keyParameter.name);
    if (!files || files.size === 0) return false;
    const spelled = [];
    for (const file of files) {
        let quoted = pidx.quoted.get(file);
        if (!quoted) {
            quoted = new Set();
            try {
                for (const match of index._readFile(file).matchAll(QUOTED_IDENTIFIER)) quoted.add(match[2]);
            } catch { /* unreadable: no literal */ }
            pidx.quoted.set(file, quoted);
        }
        if (quoted.has(name)) spelled.push(file);
    }
    if (spelled.length === 0) return false;
    let byName = pidx.keyNames.get(entry);
    if (!byName) pidx.keyNames.set(entry, byName = new Map());
    if (!byName.has(name)) {
        byName.set(name, !!resolveKeyParameter(index, entry.site, entry.language, spelled, name)?.includes(name));
    }
    return byName.get(name);
}

// ---------------------------------------------------------------------------
// Site extraction
// ---------------------------------------------------------------------------

// Member-shaped callee node -> [member-name field, receiver field].
const MEMBER_CALLEE_FIELDS = {
    selector_expression: ['field', 'operand'], // Go
    member_expression: ['property', 'object'], // JS/TS
    member_access_expression: ['name', 'expression'], // C#
    attribute: ['attribute', 'object'], // Python
    field_access: ['field', 'object'], // Java qualified namespace
};

/** Parentheses change neither a callee nor a namespace qualifier. */
function _calleeNode(node) {
    while (node?.type === 'parenthesized_expression') {
        node = node.namedChildren.find(child => child.type !== 'comment');
    }
    return node;
}

/** A written identifier/member path, from fields rather than intervening text. */
function _calleeName(node) {
    node = _calleeNode(node);
    if (!node) return '';
    if (['identifier', 'property_identifier', 'field_identifier', 'package_identifier'].includes(node.type)) {
        return node.text;
    }
    const fields = MEMBER_CALLEE_FIELDS[node.type];
    if (!fields) return '';
    const owner = _calleeName(node.childForFieldName(fields[1]));
    const member = _calleeName(node.childForFieldName(fields[0]));
    return owner && member ? `${owner}.${member}` : '';
}

/** Callee text, member name and receiver of a call node (no arguments). */
function _calleeParts(node, wantMembers, wantQualified) {
    if (node.type === 'method_invocation') {
        if (!wantMembers) return null;
        const name = node.childForFieldName('name')?.text || '';
        return { calleeText: name, member: name, object: node.childForFieldName('object') };
    }
    const fn = _calleeNode(node.childForFieldName('function') || node.namedChild(0));
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { calleeText: fn.text || '', member: fn.text, object: null, bare: true };
    }
    if (!wantMembers) return wantQualified ? { calleeText: null, fn, member: null, object: null } : null;
    const fields = MEMBER_CALLEE_FIELDS[fn.type];
    if (!fields) return wantQualified ? { calleeText: null, fn, member: null, object: null } : null;
    return {
        calleeText: null,
        fn,
        member: fn.childForFieldName(fields[0])?.text || null,
        object: fn.childForFieldName(fields[1]),
    };
}

function _callArgs(node) {
    const argsNode = node.childForFieldName('arguments') ||
        (node.namedChildren || []).find(c =>
            c.type === 'argument_list' || c.type === 'arguments');
    return argsNode ? argsNode.namedChildren.filter(c => c.type !== 'comment') : null;
}

// Construction nodes: `new Function(..)` builds a callable from a string.
const NEW_NODE_TYPES = ['new_expression', 'object_creation_expression'];

/**
 * Local names a file's imports bind to the modules of `{ package }` rules:
 * `reflect` for `import "reflect"`, `r` for `import r "reflect"`. An import
 * that binds no qualifier (Go `.` and `_`) names none.
 * @returns {Map<string, string>} local name -> module
 */
function _packageQualifiers(rules, imports) {
    const modules = new Set(rules.filter(rule => rule.package).map(rule => rule.package));
    const qualifiers = new Map();
    if (modules.size === 0) return qualifiers;
    for (const item of imports || []) {
        if (!item || !modules.has(item.module)) continue;
        for (const name of item.names || []) {
            // The parser already supplies valid import names, including
            // Unicode identifiers. Dot and blank imports bind no qualifier.
            if (name && name !== '_' && name !== '.') qualifiers.set(name, item.module);
        }
    }
    return qualifiers;
}

/**
 * Reflection facts of one parsed file: { sites, reflectionUses, evalUses }.
 *
 * Each site: { kind, line, expression, dynamic, name?, patterns?, receiver?,
 *   membersOnly? }: a reflective access that names its member by a string.
 *
 * The two counts are how often the file uses the language's reflection and
 * code-execution vocabulary, whether or not a name can be read from the use.
 * `reflectionUses`: the call-shaped sites (a `functions` or `members` call
 * that passes its name argument) plus calls of the `unnamed` rules.
 * `evalUses`: bare calls of `namespaceLookups.calls` that pass an argument,
 * plus calls and constructions of the `codeExecution` rules. They count call
 * and construction nodes of the tree, so a spelling inside a comment or a
 * string is no use, and neither is a method or a definition that shares a
 * name with a builtin (`self.exec(..)`, `def eval(..)`), nor a same-named
 * method called without the name (`request.getMethod()`).
 *
 * `options.imports` are the file's import records: a `{ package }` rule
 * matches a call qualified by a local name they bind to that module.
 */
function reflectionFactsInTree(tree, language, code = null, options = {}) {
    const facts = { sites: [], reflectionUses: 0, evalUses: 0 };
    const traits = langTraits(language) || {};
    const api = traits.reflectionApi;
    if (!api || !tree) return facts;
    const resolve = makeResolver();
    const ctx = { formatCalls: api.formatCalls || null, resolve, language };
    const sites = facts.sites;
    const push = (node, kind, nameNode, receiverNode, receiverFact, nameCtx = ctx) => {
        const cls = classifyNameExpression(nameNode, nameCtx);
        const expression = String(node.text || '');
        // A name that is the enclosing callable's parameter is decided one
        // call away, by what its callers pass (fix #428).
        const keyParameter = cls.dynamic && !cls.patterns && _unwrap(nameNode)?.type === 'identifier'
            ? _keyParameter(_unwrap(nameNode), language) : null;
        sites.push({
            ...(keyParameter && { keyParameter }),
            kind,
            line: node.startPosition.row + 1,
            expression: expression.length > EXPRESSION_CAP
                ? expression.slice(0, EXPRESSION_CAP) + '...' : expression,
            ...(cls.name && { name: cls.name }),
            ...(cls.patterns && { patterns: cls.patterns }),
            dynamic: cls.dynamic,
            ...(receiverFact ? { receiver: receiverFact }
                : receiverNode && { receiver: classifyReceiver(receiverNode, language) }),
            ...(api.membersOnly && { membersOnly: true }),
        });
    };
    const ns = api.namespaceLookups;
    // Vocabulary that names no member: counted, never a site.
    const unnamed = api.unnamed || [];
    const codeExecution = api.codeExecution || [];
    const constructs = codeExecution.filter(rule => rule.construct);
    const qualifiers = _packageQualifiers([...unnamed, ...codeExecution, ...(api.patches || [])], options.imports);
    const scopeMemo = new Map();
    // Candidate nodes are located natively: reflective calls from the
    // vocabulary's spelling positions (descendantForIndex, walking up to the
    // enclosing call), computed member keys by node type. No JS-side walk of
    // the whole tree.
    const hintSources = [];
    if (api.hintPattern) hintSources.push(api.hintPattern.source);
    // A package's qualifier is the file's own choice (`r "reflect"`).
    if (qualifiers.size > 0) {
        const { literalNameRegex } = require('./shared');
        hintSources.push(...[...qualifiers.keys()].map(name => literalNameRegex(name).source));
    }
    // Aliases can call a reflective API without spelling that API at the call.
    // Resolve the Python call ASTs whenever its binding vocabulary is present.
    if (api.pythonBindingIdentity && code != null && !api.hintPattern.test(code.normalize('NFKC'))) return facts;
    const useHints = !api.pythonBindingIdentity && code != null && hintSources.length > 0;
    const callTypes = constructs.length > 0 ? [...CALL_NODE_TYPES, ...NEW_NODE_TYPES] : CALL_NODE_TYPES;
    const types = [];
    if (!useHints) {
        types.push(...callTypes);
        if (ns?.subscriptOf) types.push('subscript');
    }
    if (api.computedMembers) types.push('subscript_expression');
    const wantMembers = (api.members || []).length > 0 || (api.patches || []).length > 0;
    // Qualified callees (`Reflect.get`, a package's functions) need the
    // callee text of member-shaped calls; bare vocabularies (`getattr`)
    // never do.
    const wantQualified = api.pythonBindingIdentity || qualifiers.size > 0 ||
        [...(api.functions || []), ...unnamed, ...codeExecution].some(rule => rule.qualified);
    // A patch call names what it replaces by a dotted path string or by an
    // owner object and a member name (the shapes of python-binding-identity).
    // Names in it are read as Python reads them: a module constant from a
    // function body, a plain `{name}` of an f-string, every value a name is
    // written with. A runtime part leaves a pattern.
    // A name that is a parameter of the callable holding the call is kept as
    // PARAM: the site is recorded with its alternatives (`deferred`) and
    // read with what the callers pass when the project is asked (fix #512).
    const patchSites = (node, shapes, dottedOnly, reading) => {
        const args = _callArgs(node) || [];
        const positional = args.filter(arg => arg.type !== 'keyword_argument');
        const keyword = name => args.find(arg => arg.type === 'keyword_argument' &&
            pythonSourceName(arg.childForFieldName('name')?.text) === name)?.childForFieldName('value');
        const at = where => (where ? positional[where.position] || keyword(where.keyword) : null);
        const before = sites.length;
        const seen = new Set();
        const place = { line: node.startPosition.row + 1, expression: String(node.text).slice(0, EXPRESSION_CAP) };
        for (const shape of shapes) {
            // `create=True` / `raising=False`: the name may be absent.
            if (shape.optional && at(shape.optional.at)?.type === shape.optional.value) continue;
            const targetNode = at(shape.targetAt);
            const object = shape.object && (!shape.target || at(shape.objectWhen));
            const nameNode = object ? at(shape.memberAt) : targetNode;
            const key = `${object ? 'member' : 'target'}:${nameNode?.startIndex}`;
            if (!nameNode || seen.has(key)) continue;
            seen.add(key);
            // A callee that is a patch API only by an origin that could not be
            // followed reads no parameter (`reading` 'possible').
            const slot = reading === 'possible' ? null : {};
            const alternatives = _valueAlternatives(nameNode, _patchValueCtx(language, scopeMemo, slot));
            const receiver = object ? classifyReceiver(targetNode, language) : null;
            // The object the member is set on, when the file proves it.
            const owner = object && targetNode ? pythonPatchOwner(targetNode, scopeMemo) : null;
            if (slot?.parameter && alternatives.some(alternative => alternative.includes(PARAM))) {
                sites.push({ kind: object ? 'runtime-member' : 'runtime-target', dynamic: false,
                    ...(receiver && { receiver }), ...(owner && { owner }),
                    deferred: { parameter: slot.parameter, alternatives, ...(reading === 'spelled' && { spelledOnly: true }),
                        ...(dottedOnly && { dottedOnly: true }) },
                    ...place });
                continue;
            }
            const found = object ? _memberSites(alternatives, receiver, reading, owner) : _targetSites(alternatives, dottedOnly, reading);
            for (const site of found) {
                const id = site.runtimeTarget != null ? `site-target:${site.runtimeTarget}`
                    : `site-member:${site.open ? '*' : nameNode.startIndex}`;
                if (seen.has(id)) continue;
                seen.add(id);
                sites.push({ ...site, ...place });
            }
        }
        if (sites.length > before) facts.reflectionUses++;
    };
    const visitNode = node => {
        if (node.type === 'subscript_expression') {
            // obj["on" + evt] / this[`handle${t}`] (JS/TS computed member
            // access): only a key built in place from literal fragments
            // counts; opaque keys stay the computed-dispatch disclosure.
            const index = node.childForFieldName('index');
            const inner = _unwrap(index);
            const { jsStaticKey, jsConstValue } = require('../languages/static-js');
            const staticName = jsStaticKey(inner);
            if (staticName != null) {
                // This is normal member syntax. The call extractor carries
                // the exact receiver; reflection keeps value-position access live.
                if (node.parent?.type !== 'call_expression' || !sameNode(node.parent.childForFieldName('function'), node)) {
                    sites.push({ kind: 'computed', name: staticName, patterns: [staticName], dynamic: false,
                        line: node.startPosition.row + 1, expression: node.text.slice(0, EXPRESSION_CAP),
                        receiver: classifyReceiver(node.childForFieldName('object'), language), membersOnly: true });
                }
                return;
            }
            const object = node.childForFieldName('object');
            const construction = object?.type === 'new_expression' ? object : jsConstValue(object, true);
            const type = construction?.type === 'new_expression' ? construction.childForFieldName('constructor') : null;
            if (type?.type === 'identifier' && node.parent?.type === 'call_expression' &&
                sameNode(node.parent.childForFieldName('function'), node)) {
                sites.push({ kind: 'computed', dynamic: true, dynamicMember: true,
                    receiver: { kind: 'type', name: type.text }, membersOnly: true,
                    line: node.startPosition.row + 1, expression: node.text.slice(0, EXPRESSION_CAP) });
                return;
            }
            // `registry[type](..)` with `type` a parameter of the enclosing
            // callable dispatches by the name its callers pass (fix #428).
            if (inner?.type === 'identifier' && node.parent?.type === 'call_expression' &&
                sameNode(node.parent.childForFieldName('function'), node) &&
                _keyParameter(inner, language)) {
                push(node, 'computed', index, node.childForFieldName('object'));
                return;
            }
            if (!inner || !COMPUTED_PATTERN_KEYS.has(inner.type)) return;
            const cls = classifyNameExpression(index, ctx);
            if (cls.patterns && cls.patterns.length > 0) {
                push(node, 'computed', index, node.childForFieldName('object'));
            }
            return;
        }
        if (node.type === 'subscript') {
            // `globals()[name]`: a lookup in this file's module namespace.
            const value = node.childForFieldName('value');
            const key = node.childForFieldName('subscript');
            if (value && key && ns.subscriptOf.test(String(value.text || '').replace(/\s+/g, ''))) {
                push(node, 'namespace', key, null, MODULE_RECEIVER);
            }
            return;
        }
        if (NEW_NODE_TYPES.includes(node.type)) {
            // `new Function(code)`: the constructed class decides.
            const constructed = node.childForFieldName('constructor') || node.childForFieldName('type');
            const text = _calleeName(constructed);
            if (constructs.some(rule => rule.construct.test(text))) facts.evalUses++;
            return;
        }
        const call = _calleeParts(node, wantMembers, wantQualified);
        if (!call) return;
        if (api.pythonBindingIdentity) {
            const fn = _calleeNode(node.childForFieldName('function'));
            const identities = pythonPossibleIdentities(fn, scopeMemo);
            const builtins = identities.filter(identity => identity.startsWith('builtins.'));
            // Test doubles that patch an attribute by name (unittest.mock,
            // pytest's monkeypatch, pytest-mock). One shape is read once,
            // however many identities of the callee share it.
            const shapes = new Set(identities.map(pythonPatchApi).filter(Boolean));
            // How the callee is known to be a patch API (fix #512): 'proven'
            // when the file's own bindings give it a patch origin, 'possible'
            // when only an origin that could not be followed may be one.
            let reading = shapes.size > 0 && pythonResolvedOrigins(fn, scopeMemo).some(origin => pythonPatchApi(origin))
                ? 'proven' : 'possible';
            // No identity is proven for the callee: the member it is written
            // with decides, and only a dotted path or a literal member name
            // makes a site of it.
            const spelled = shapes.size === 0 && builtins.length === 0 ? pythonPatchSpelling(fn, scopeMemo) : null;
            if (spelled) shapes.add(spelled);
            if (spelled || (reading === 'possible' && shapes.size > 0 && pythonPatchSpelling(fn, scopeMemo))) reading = 'spelled';
            if (shapes.size > 0) patchSites(node, shapes, !!spelled, reading);
            call.possibleCallees = builtins.map(identity => identity.slice(9));
            call.calleeText = call.possibleCallees[0] || '';
        }
        // Match on the callee spelling first; arguments are read only for a
        // vocabulary hit (most calls in a hinted file are unrelated).
        const calleeText = () => (call.calleeText ??= _calleeName(call.fn));
        for (const rule of api.functions || []) {
            const matched = (call.possibleCallees || [calleeText()]).find(name => rule.callee.test(name));
            if (!matched) continue;
            const args = _callArgs(node);
            if (args && args[rule.nameArg]) {
                facts.reflectionUses++;
                push(node, rule.kind || matched.split('.').pop(),
                    args[rule.nameArg], args[rule.receiverArg]);
            }
            return;
        }
        if (call.member && call.object) {
            for (const rule of api.members || []) {
                if (!rule.member.test(call.member)) continue;
                const args = _callArgs(node);
                if (args && args[rule.nameArg]) {
                    facts.reflectionUses++;
                    push(node, call.member, args[rule.nameArg], call.object);
                }
                return;
            }
        }
        // Test doubles that replace a member by its name (trait `patches`):
        // the member must exist, so the call is a runtime use of it. The
        // callee is matched as written, on any receiver; the arguments must
        // have the shape of the API: an owner that is no literal, and a
        // name this reader can spell.
        for (const rule of api.patches || []) {
            const written = call.bare ? call.calleeText : call.member;
            if (!written || !rule.name.test(written)) continue;
            if (rule.package) {
                // An API known by its module: the callee, or what it is a
                // member of, is a module-scope import of that module.
                const qualifier = call.bare ? _calleeNode(node.childForFieldName('function')) : _calleeNode(call.object);
                if (qualifier?.type !== 'identifier' || qualifiers.get(qualifier.text) !== rule.package ||
                    require('../languages/lexical-scope').referenceScope(qualifier, language, scopeMemo) !== 'module') continue;
            } else if (call.bare ? !rule.bare : (rule.owner && !rule.owner.test(_calleeName(call.object)))) continue;
            const args = _callArgs(node) || [];
            const nameNode = args[rule.nameArg];
            if (!nameNode) continue;
            const object = position => (position != null ? _unwrap(args[position]) : null);
            let ownerNode = object(rule.ownerArg);
            if (rule.ownerArg != null && (!ownerNode || PATCH_LITERALS.has(ownerNode.type))) continue;
            if (rule.valueArg != null && (!object(rule.valueArg) || PATCH_LITERALS.has(object(rule.valueArg).type))) continue;
            if (rule.ownerOfCall) {
                // `mock(owner).expects('name')`: the owner is what the
                // receiver was built from.
                const built = _calleeNode(call.object);
                const builder = built && CALL_NODE_TYPES.includes(built.type) ? _calleeParts(built, true, false) : null;
                if (builder && rule.ownerOfCall.test(builder.member || builder.calleeText || '')) {
                    ownerNode = (_callArgs(built) || [])[0] || null;
                }
            }
            // A name that is a parameter of the enclosing callable is read
            // from what its callers pass (fix #512). These rules are matched
            // as written, so a name that cannot be read names nothing.
            const slot = {};
            const read = stringAlternatives(nameNode, _patchValueCtx(language, scopeMemo, slot));
            if (read && slot.parameter && read.some(alternative => alternative.includes(PARAM))) {
                facts.reflectionUses++;
                sites.push({ kind: 'runtime-member', dynamic: false,
                    ...(ownerNode && { receiver: classifyReceiver(ownerNode, language) }),
                    deferred: { parameter: slot.parameter, alternatives: read, spelledOnly: true },
                    line: node.startPosition.row + 1, expression: String(node.text).slice(0, EXPRESSION_CAP) });
                return;
            }
            // Names are read as for any patch call (a runner's table too).
            const valueCtx = _patchValueCtx(language, scopeMemo, null);
            const member = classifyNameExpression(nameNode, valueCtx);
            if (!member.name && !(member.patterns && !member.dynamic)) continue;
            facts.reflectionUses++;
            push(node, 'runtime-member', nameNode, ownerNode, undefined, valueCtx);
            // Its spelling is a pattern too: the member is a possible callee
            // of the call, listed as such (fix #512).
            const pushed = sites[sites.length - 1];
            if (!pushed.patterns) pushed.patterns = [pushed.name];
            return;
        }
        // `eval(cmd)`: the receiver is this file's own top-level namespace,
        // so even a fully dynamic name is bounded to it.
        if (ns?.calls && call.bare && ns.calls.test(call.calleeText)) {
            const args = _callArgs(node);
            if (args && args[0]) {
                facts.evalUses++;
                push(node, call.calleeText, args[0], null, MODULE_RECEIVER);
            }
            return;
        }
        if (unnamed.length === 0 && codeExecution.length === 0) return;
        // The callee as written, receiver included (`Class.forName`,
        // `reflect.ValueOf`); a bare callee is its own text.
        let written = null;
        const writtenCallee = () => (written ??= (node.type === 'method_invocation'
            ? (call.object ? `${_calleeName(call.object)}.${call.member}` : call.member || '')
            : calleeText()));
        const matches = rule => {
            if (rule.construct) return false;
            if (rule.callee) return rule.callee.test(writtenCallee());
            if (rule.package) {
                const qualifier = _calleeNode(call.object);
                if (qualifier?.type !== 'identifier' || qualifiers.get(qualifier.text) !== rule.package) return false;
                // The file import owns the spelling only outside scopes
                // that bind another value to it (parameters, locals, etc.).
                return require('../languages/lexical-scope').referenceScope(
                    qualifier, language, scopeMemo) === 'module';
            }
            return false;
        };
        if (unnamed.some(matches)) facts.reflectionUses++;
        else if (codeExecution.some(matches)) facts.evalUses++;
    };
    try {
        const candidates = [];
        if (useHints) {
            // One candidate per node: nested calls can begin at one offset
            // (`a.getMethod(x).getField(y)`), so the end is part of the key.
            const seen = new Set();
            const once = (kind, node) => {
                const key = `${kind}${node.startIndex}:${node.endIndex}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            };
            const re = new RegExp(hintSources.join('|'), 'gu');
            let m;
            while ((m = re.exec(code)) !== null) {
                if (m[0] === '') { re.lastIndex++; continue; }
                let node = tree.rootNode.descendantForIndex(m.index);
                for (; node; node = node.parent) {
                    if (!callTypes.includes(node.type)) continue;
                    if (once('c', node)) candidates.push(node);
                    // `globals()[name]`: the lookup is the enclosing subscript.
                    const parent = node.parent;
                    if (ns?.subscriptOf && parent?.type === 'subscript' && once('s', parent)) {
                        candidates.push(parent);
                    }
                    break;
                }
            }
        }
        if (types.length > 0) candidates.push(...tree.rootNode.descendantsOfType(types));
        candidates.sort((a, b) => a.startIndex - b.startIndex || (a.endIndex - b.endIndex));
        for (const node of candidates) visitNode(node);
    } catch (_) { /* partial inventory is disclosed as-is */ }
    return facts;
}

/** The reflection sites of one parsed file (see reflectionFactsInTree). */
function reflectionSitesInTree(tree, language, code = null) {
    return reflectionFactsInTree(tree, language, code).sites;
}

// ---------------------------------------------------------------------------
// Project matcher
// ---------------------------------------------------------------------------

function globMatches(pattern, name) {
    const parts = pattern.split('*');
    if (parts.length === 1) return pattern === name;
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!name.startsWith(first) || !name.endsWith(last) ||
        name.length < first.length + last.length) return false;
    let pos = first.length;
    const end = name.length - last.length;
    for (let i = 1; i < parts.length - 1; i++) {
        const at = name.indexOf(parts[i], pos);
        if (at < 0 || at + parts[i].length > end) return false;
        pos = at + parts[i].length;
    }
    return true;
}

function _longestFragment(pattern) {
    let best = '';
    for (const p of pattern.split('*')) if (p.length > best.length) best = p;
    return best;
}

/** Whether a pattern entry names members by some literal text (fix #433):
 * a fully dynamic name (`eval(code)`, `globals()[key]` with no literal
 * part) reaches every top-level name of its module alike and is attributed
 * to none of them; deadcode still withholds what it may reach. */
function patternIsAttributable(pattern) {
    return _longestFragment(String(pattern || '').split('\u0000').join('')) !== '';
}

function _family(language) {
    return langTraits(language)?.reflectionApi?.family || language;
}

/**
 * Memoized project matcher over the reflection inventory: pattern entries
 * grouped by their longest literal fragment, so a name probes only the
 * fragments it contains (one Map lookup per substring length).
 */
function reflectionPatternIndex(index) {
    if (index._reflectionPatternIndex) return index._reflectionPatternIndex;
    const { projectReflectionSites } = require('./ast-analysis');
    const byFile = projectReflectionSites(index);
    const byFragment = new Map();
    const lengths = new Set();
    let entryCount = 0;
    const moduleScoped = new Map();
    const keyParameterSites = [];
    const dynamicMembers = [];
    const deferredSites = [];
    const openSites = [];
    for (const [file, sites] of byFile) {
        const fe = index.files.get(file);
        if (!fe) continue;
        for (const site of sites) {
            if (site.dynamicMember) {
                dynamicMembers.push({ pattern: '*', file, relativePath: fe.relativePath,
                    language: fe.language, family: _family(fe.language), site });
                continue;
            }
            if (site.receiver?.kind === 'module') {
                // Bounded to this file's top-level names: a fully dynamic
                // name reaches every one of them.
                const patterns = site.dynamic ? ['*'] : (site.patterns || (site.name ? [site.name] : []));
                for (const pattern of patterns) {
                    if (!moduleScoped.has(file)) moduleScoped.set(file, []);
                    moduleScoped.get(file).push({ pattern, file, relativePath: fe.relativePath,
                        language: fe.language, family: _family(fe.language), site });
                }
                continue;
            }
            if (site.keyParameter && !site.patterns) {
                keyParameterSites.push({ file, relativePath: fe.relativePath,
                    language: fe.language, family: _family(fe.language), site });
                continue;
            }
            // Patch sites read when the project is asked (fix #512): a
            // parameter's values come from the callers; an open member
            // matches any name and the reach test bounds it.
            if (site.deferred) {
                deferredSites.push({ file, relativePath: fe.relativePath,
                    language: fe.language, family: _family(fe.language), site });
                continue;
            }
            if (site.open) {
                openSites.push({ pattern: '*', file, relativePath: fe.relativePath,
                    language: fe.language, family: _family(fe.language), site });
                continue;
            }
            if (!site.patterns) continue;
            for (const pattern of site.patterns) {
                const frag = _longestFragment(pattern);
                if (!frag) continue;
                lengths.add(frag.length);
                if (!byFragment.has(frag)) byFragment.set(frag, []);
                byFragment.get(frag).push({ pattern, file, relativePath: fe.relativePath,
                    language: fe.language, family: _family(fe.language), site });
                entryCount++;
            }
        }
    }
    const result = { byFragment, lengths: [...lengths].sort((a, b) => a - b), entryCount, moduleScoped,
        keyParameterSites, dynamicMembers, quoted: new Map(), keyNames: new Map(),
        deferredSites, openSites, deferred: new Map() };
    index._reflectionPatternIndex = result;
    return result;
}

/** Pattern entries whose glob spells `name` (same language family as `language`). */
function patternEntriesFor(index, name, language, file = null) {
    const pidx = reflectionPatternIndex(index);
    if (!name) return [];
    const out = [];
    if (file && pidx.moduleScoped.has(file)) {
        for (const entry of pidx.moduleScoped.get(file)) {
            if (globMatches(entry.pattern, name)) out.push(entry);
        }
    }
    const family = language ? _family(language) : null;
    for (const entry of pidx.dynamicMembers) {
        if (!family || entry.family === family) out.push(entry);
    }
    for (const entry of pidx.keyParameterSites) {
        if (family && entry.family !== family) continue;
        if (_keyParameterPasses(index, pidx, entry, name)) out.push({ ...entry, pattern: name });
    }
    for (const entry of pidx.openSites) {
        if (!family || entry.family === family) out.push(entry);
    }
    for (const entry of pidx.deferredSites) {
        if ((family && entry.family !== family) || !_deferredCanSpell(entry.site, name)) continue;
        // Read once per index: the sites the callers' values make of it.
        let resolved = pidx.deferred.get(entry);
        if (!resolved) pidx.deferred.set(entry, resolved = _resolveDeferredSite(index, entry));
        for (const site of resolved) {
            if (site.open) { out.push({ ...entry, pattern: '*', site }); continue; }
            const hit = (site.patterns || [site.name]).find(pattern => pattern && globMatches(pattern, name));
            if (hit) out.push({ ...entry, pattern: hit, site });
        }
    }
    if (pidx.entryCount === 0) return out;
    const seenFrag = new Set();
    for (const len of pidx.lengths) {
        if (len > name.length) break;
        for (let i = 0; i + len <= name.length; i++) {
            const frag = name.substr(i, len);
            if (seenFrag.has(frag)) continue;
            seenFrag.add(frag);
            const entries = pidx.byFragment.get(frag);
            if (!entries) continue;
            for (const entry of entries) {
                if (family && entry.family !== family) continue;
                if (globMatches(entry.pattern, name)) out.push(entry);
            }
        }
    }
    return out;
}

function _classRefFor(index, name, file, line, arity) {
    const ci = require('./class-identity');
    const info = ci.classDefsNamed(index, name);
    if (info.entries.length === 0) return null;
    if (line != null) {
        const hit = info.entries.find(e => e.def.file === file &&
            e.def.startLine <= line && (e.def.endLine || e.def.startLine) >= line);
        if (hit) return { name, key: hit.key, def: hit.def };
    }
    return ci.resolveClassRef(index, name, file, Number.isInteger(arity) ? { arity } : {});
}

function _reachesKey(index, fromRef, targetKey, targetName) {
    const ci = require('./class-identity');
    const visited = new Set();
    const queue = [fromRef];
    while (queue.length > 0) {
        const cur = queue.shift();
        const vk = cur.key || `n:${cur.name}`;
        if (visited.has(vk) || visited.size > 256) continue;
        visited.add(vk);
        if (cur.key && cur.key === targetKey) return true;
        if (!cur.key && cur.name === targetName && !cur.external) return true; // unresolved: maybe
        if (cur.external) continue;
        if (cur.key || cur.def) queue.push(...ci.parentRefsOf(index, cur));
    }
    return false;
}

/**
 * Could the reflective receiver of `entry` hold an instance whose class has
 * member `def`? Untyped receivers answer yes; self/type receivers answer yes
 * for the same class, an ancestor or descendant, and (multiple inheritance /
 * mixins) classes sharing a descendant. Unresolved identities answer yes.
 */
function reflectionEntryReaches(index, entry, def) {
    const site = entry.site;
    if (site.runtimeTarget) return require('./runtime-entrypoints').runtimeTargetReaches(index, def, site.runtimeTarget);
    // A patch call's owner object the file proves (fix #512).
    if (site.owner && !site.owner.receiver) return require('./runtime-entrypoints').ownerReaches(index, entry, def);
    if (site.membersOnly && !def.className && !def.receiver) return false;
    const recv = site.receiver;
    if (!recv) return true;
    if (recv.kind === 'module') {
        return def.file === entry.file && !def.className && !def.receiver;
    }
    let recvRef = null;
    if (recv.kind === 'self') {
        recvRef = _classRefFor(index, recv.className, entry.file, recv.classLine);
    } else if (recv.kind === 'name') {
        // An identifier naming a project class is a class receiver; any other
        // identifier is an untyped value.
        recvRef = _classRefFor(index, recv.name, entry.file, null);
        if (!recvRef) return true;
    } else if (recv.kind === 'type') {
        recvRef = _classRefFor(index, recv.name, entry.file, null, recv.arity);
        if (!recvRef) {
            // An out-of-project type (`typeof(Convert)`): its members are not
            // project code, but invoking a member it declares dispatches into
            // project classes deriving from it (`typeof(IConvertible)`).
            const { ownerDerivesFromExternal } = require('./contract-membership');
            return ownerDerivesFromExternal(index, def, [recv.name]);
        }
    }
    if (!recvRef || !recvRef.key) return true;
    const ci = require('./class-identity');
    const ownerRef = ci.ownerRefOf(index, def);
    // A class-level receiver never reaches a free function.
    if (!ownerRef) return false;
    if (!ownerRef.key) return true;
    if (ownerRef.key === recvRef.key) return true;
    if (_reachesKey(index, recvRef, ownerRef.key, ownerRef.name)) return true; // inherited member
    if (_reachesKey(index, ownerRef, recvRef.key, recvRef.name)) return true; // subclass member
    return ci.shareDescendant(index, recvRef, [def]);
}

/**
 * Is `def` a member of the class `className` declared in `file` (the one
 * declared at `line` when given), or of one of its ancestors? A runtime
 * attribute lookup on a class or an instance finds both (fix #512).
 */
function classOrAncestorDeclares(index, file, className, def, line = null) {
    if (!def.className) return false;
    const ci = require('./class-identity');
    const hit = ci.classDefsNamed(index, className).entries.find(entry => entry.def.file === file &&
        (line == null ? !entry.def.className : entry.def.startLine === line));
    if (!hit) return false;
    const classRef = { name: className, key: hit.key, def: hit.def };
    const ownerRef = ci.ownerRefOf(index, def);
    if (!ownerRef) return false;
    if (!ownerRef.key) return ownerRef.name === className;
    return ownerRef.key === classRef.key || _reachesKey(index, classRef, ownerRef.key, ownerRef.name);
}

/** Reaching pattern entries for one definition (sorted file, line). */
function reflectionPatternReferences(index, def) {
    const lang = index.files.get(def.file)?.language || detectLanguage(def.file, index.root);
    const runtimeName = langTraits(lang)?.reflectionApi?.pythonBindingIdentity ? pythonSourceName(def.name) : def.name;
    const entries = patternEntriesFor(index, runtimeName, lang, def.file)
        .filter(entry => reflectionEntryReaches(index, entry, def));
    entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
        a.site.line - b.site.line || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
    return entries;
}

function resetReflectionIndex(index) {
    index._reflectionPatternIndex = null;
}

/** Exact AST string literals, for conservative same-file dynamic dispatch.
 * This does not prove that a literal flows to a reflection call. */
function reflectionLiteralNames(tree) {
    const names = new Map();
    if (!tree) return names;
    for (const node of tree.rootNode.descendantsOfType([...STRING_NODES])) {
        const value = classifyNameExpression(node);
        if (value.name && !value.dynamic && !names.has(value.name)) {
            names.set(value.name, node.startPosition.row + 1);
        }
    }
    return names;
}

module.exports = {
    WILD,
    stringAlternatives,
    classifyNameExpression,
    classifyReceiver,
    reflectionFactsInTree,
    reflectionSitesInTree,
    globMatches,
    patternEntriesFor,
    reflectionEntryReaches,
    reflectionPatternReferences,
    reflectionPatternIndex,
    classOrAncestorDeclares,
    patternIsAttributable,
    resetReflectionIndex,
    reflectionLiteralNames,
    resolveKeyParameter,
};
