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
 * Site extraction is syntax-only and runs in the same per-file parse as the
 * computed-dispatch inventory (ast-analysis.js); the per-project matcher is
 * memoized on the index and reset with it.
 */

const { langTraits } = require('../languages');

const WILD = '\u0000*';
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

function _concat(a, b) {
    const out = [];
    for (const x of a) {
        for (const y of b) {
            out.push([...x, ...y]);
            if (out.length > MAX_ALTERNATIVES) return [[WILD]];
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

function _stringLiteral(node) {
    const pieces = [];
    let sawContent = false;
    for (const child of node.children || []) {
        if (STRING_CONTENT_NODES.has(child.type)) {
            pieces.push(child.text);
            sawContent = true;
        } else if (INTERPOLATION_NODES.has(child.type)) {
            pieces.push(WILD);
        } else if (child.type === 'escape_sequence') {
            // An escaped character never spells an identifier fragment.
            pieces.push('\\');
        }
        // Delimiters, prefixes and quote tokens carry no name text.
    }
    if (!sawContent && pieces.length === 0) {
        // Grammars that keep simple literals as one token (`"abc"`, `'abc'`).
        const raw = String(node.text || '');
        const m = /^[A-Za-z@$]*(["'`])([\s\S]*)\1$/.exec(raw);
        if (m) pieces.push(m[2]);
    }
    return [pieces];
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
    if (STRING_NODES.has(node.type)) return _stringLiteral(node);
    switch (node.type) {
        case 'concatenated_string': {
            let acc = [[]];
            for (const child of node.namedChildren) {
                const part = stringAlternatives(child, ctx, depth + 1) || [[WILD]];
                acc = _concat(acc, part);
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
                return _concat(l || [[WILD]], r || [[WILD]]);
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
        case 'identifier': {
            if (!ctx.resolve || (ctx.resolveDepth || 0) >= MAX_RESOLVE_DEPTH) return null;
            const values = ctx.resolve(node);
            if (!values || values.length === 0) return null;
            let out = [];
            for (const value of values) {
                const alt = stringAlternatives(value,
                    { ...ctx, resolveDepth: (ctx.resolveDepth || 0) + 1 }, depth + 1);
                if (!alt) return null; // one non-string binding: unknown
                out.push(...alt);
                if (out.length > MAX_ALTERNATIVES) return [[WILD]];
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

/**
 * Classify a name expression.
 * @returns {{name?: string, patterns?: string[], dynamic: boolean}}
 *   name - one exact spelling; patterns - specific glob patterns (sorted);
 *   dynamic - some alternative is unknown or names anything.
 */
function classifyNameExpression(node, ctx) {
    const alts = stringAlternatives(node, ctx);
    if (!alts) return { dynamic: true };
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
// Site extraction
// ---------------------------------------------------------------------------

// Member-shaped callee node -> [member-name field, receiver field].
const MEMBER_CALLEE_FIELDS = {
    selector_expression: ['field', 'operand'], // Go
    member_expression: ['property', 'object'], // JS/TS
    member_access_expression: ['name', 'expression'], // C#
    attribute: ['attribute', 'object'], // Python
};

/** Callee text, member name and receiver of a call node (no arguments). */
function _calleeParts(node, wantMembers, wantQualified) {
    if (node.type === 'method_invocation') {
        if (!wantMembers) return null;
        const name = node.childForFieldName('name')?.text || '';
        return { calleeText: name, member: name, object: node.childForFieldName('object') };
    }
    const fn = node.childForFieldName('function') || node.namedChild(0);
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

/**
 * Reflection sites of one parsed file.
 * Each site: { kind, line, expression, dynamic, name?, patterns?, receiver?,
 *   membersOnly? }.
 */
function reflectionSitesInTree(tree, language, code = null) {
    const traits = langTraits(language) || {};
    const api = traits.reflectionApi;
    if (!api || !tree) return [];
    const resolve = makeResolver();
    const ctx = { formatCalls: api.formatCalls || null, resolve };
    const sites = [];
    const push = (node, kind, nameNode, receiverNode, receiverFact) => {
        const cls = classifyNameExpression(nameNode, ctx);
        const expression = String(node.text || '');
        sites.push({
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
    // Candidate nodes are located natively: reflective calls from the
    // vocabulary's spelling positions (descendantForIndex, walking up to the
    // enclosing call), computed member keys by node type. No JS-side walk of
    // the whole tree.
    const hintPattern = api.hintPattern || null;
    const useHints = code != null && hintPattern;
    const types = [];
    if (!useHints) {
        types.push(...CALL_NODE_TYPES);
        if (ns?.subscriptOf) types.push('subscript');
    }
    if (api.computedMembers) types.push('subscript_expression');
    const wantMembers = (api.members || []).length > 0;
    // Qualified function callees (`Reflect.get`) need the callee text of
    // member-shaped calls; bare vocabularies (`getattr`) never do.
    const wantQualified = (api.functions || []).some(rule => rule.qualified);
    const visitNode = node => {
        if (node.type === 'subscript_expression') {
            // obj["on" + evt] / this[`handle${t}`] (JS/TS computed member
            // access): only a key built in place from literal fragments
            // counts; opaque keys stay the computed-dispatch disclosure.
            const index = node.childForFieldName('index');
            const inner = _unwrap(index);
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
        const call = _calleeParts(node, wantMembers, wantQualified);
        if (!call) return;
        // Match on the callee spelling first; arguments are read only for a
        // vocabulary hit (most calls in a hinted file are unrelated).
        const calleeText = () => (call.calleeText ??= call.fn.text || '');
        for (const rule of api.functions || []) {
            if (!rule.callee.test(calleeText())) continue;
            const args = _callArgs(node);
            if (args && args[rule.nameArg]) {
                push(node, rule.kind || calleeText().split('.').pop(),
                    args[rule.nameArg], args[rule.receiverArg]);
            }
            return;
        }
        if (call.member && call.object) {
            for (const rule of api.members || []) {
                if (!rule.member.test(call.member)) continue;
                const args = _callArgs(node);
                if (args && args[rule.nameArg]) push(node, call.member, args[rule.nameArg], call.object);
                return;
            }
        }
        // `eval(cmd)`: the receiver is this file's own top-level namespace,
        // so even a fully dynamic name is bounded to it.
        if (ns?.calls && call.bare && ns.calls.test(call.calleeText)) {
            const args = _callArgs(node);
            if (args && args[0]) push(node, call.calleeText, args[0], null, MODULE_RECEIVER);
        }
    };
    try {
        const candidates = [];
        if (useHints) {
            const seen = new Set();
            const re = new RegExp(hintPattern.source, 'g');
            let m;
            while ((m = re.exec(code)) !== null) {
                let node = tree.rootNode.descendantForIndex(m.index);
                for (let i = 0; node && i < 6; i++, node = node.parent) {
                    if (!CALL_NODE_TYPES.includes(node.type)) continue;
                    if (!seen.has(node.startIndex)) { seen.add(node.startIndex); candidates.push(node); }
                    // `globals()[name]`: the lookup is the enclosing subscript.
                    const parent = node.parent;
                    if (ns?.subscriptOf && parent?.type === 'subscript' &&
                        !seen.has(-parent.startIndex - 1)) {
                        seen.add(-parent.startIndex - 1);
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
    return sites;
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
    for (const [file, sites] of byFile) {
        const fe = index.files.get(file);
        if (!fe) continue;
        for (const site of sites) {
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
    const result = { byFragment, lengths: [...lengths].sort((a, b) => a - b), entryCount, moduleScoped };
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
    if (pidx.entryCount === 0) return out;
    const family = language ? _family(language) : null;
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

/** Reaching pattern entries for one definition (sorted file, line). */
function reflectionPatternReferences(index, def) {
    const lang = index.files.get(def.file)?.language;
    const entries = patternEntriesFor(index, def.name, lang, def.file)
        .filter(entry => reflectionEntryReaches(index, entry, def));
    entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
        a.site.line - b.site.line || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
    return entries;
}

function resetReflectionIndex(index) {
    index._reflectionPatternIndex = null;
}

module.exports = {
    WILD,
    stringAlternatives,
    classifyNameExpression,
    classifyReceiver,
    reflectionSitesInTree,
    globMatches,
    patternEntriesFor,
    reflectionEntryReaches,
    reflectionPatternReferences,
    reflectionPatternIndex,
    resetReflectionIndex,
};
