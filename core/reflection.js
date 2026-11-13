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
const { sameNode } = require('../languages/utils');

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
    const ctx = { formatCalls: api.formatCalls || null, resolve };
    const sites = facts.sites;
    const push = (node, kind, nameNode, receiverNode, receiverFact) => {
        const cls = classifyNameExpression(nameNode, ctx);
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
    const qualifiers = _packageQualifiers([...unnamed, ...codeExecution], options.imports);
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
    const useHints = code != null && hintSources.length > 0;
    const callTypes = constructs.length > 0 ? [...CALL_NODE_TYPES, ...NEW_NODE_TYPES] : CALL_NODE_TYPES;
    const types = [];
    if (!useHints) {
        types.push(...callTypes);
        if (ns?.subscriptOf) types.push('subscript');
    }
    if (api.computedMembers) types.push('subscript_expression');
    const wantMembers = (api.members || []).length > 0;
    // Qualified callees (`Reflect.get`, a package's functions) need the
    // callee text of member-shaped calls; bare vocabularies (`getattr`)
    // never do.
    const wantQualified = qualifiers.size > 0 ||
        [...(api.functions || []), ...unnamed, ...codeExecution].some(rule => rule.qualified);
    const visitNode = node => {
        if (node.type === 'subscript_expression') {
            // obj["on" + evt] / this[`handle${t}`] (JS/TS computed member
            // access): only a key built in place from literal fragments
            // counts; opaque keys stay the computed-dispatch disclosure.
            const index = node.childForFieldName('index');
            const inner = _unwrap(index);
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
        // Match on the callee spelling first; arguments are read only for a
        // vocabulary hit (most calls in a hinted file are unrelated).
        const calleeText = () => (call.calleeText ??= _calleeName(call.fn));
        for (const rule of api.functions || []) {
            if (!rule.callee.test(calleeText())) continue;
            const args = _callArgs(node);
            if (args && args[rule.nameArg]) {
                facts.reflectionUses++;
                push(node, rule.kind || calleeText().split('.').pop(),
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
            if (site.keyParameter && !site.patterns) {
                keyParameterSites.push({ file, relativePath: fe.relativePath,
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
        keyParameterSites, quoted: new Map(), keyNames: new Map() };
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
    for (const entry of pidx.keyParameterSites) {
        if (family && entry.family !== family) continue;
        if (_keyParameterPasses(index, pidx, entry, name)) out.push({ ...entry, pattern: name });
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
    patternIsAttributable,
    resetReflectionIndex,
    reflectionLiteralNames,
    resolveKeyParameter,
};
