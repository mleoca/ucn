/**
 * core/route-graph.js - AST router composition and constant propagation for
 * `endpoints` (fix #366).
 *
 * Two pieces:
 *
 *   1. A string constant evaluator over tree-sitter ASTs. A route or mount
 *      prefix is often an expression, not a literal: `settings.API_V1_STR`
 *      (attribute of a module-level instance whose class field has a literal
 *      default), `f"{BASE}/v1"`, `API + "/users"`, `Paths.API` (Java/C#
 *      constant), a Go package constant. The evaluator folds literals,
 *      concatenation, template/f-strings, same-scope and module constants,
 *      imported constants, object-literal members and class field defaults.
 *      Anything it cannot prove becomes a DISCLOSED wildcard segment
 *      `{?expr}` instead of being dropped.
 *
 *   2. A router graph for the call-registered frameworks (JS/TS: Express,
 *      Koa, Hono, Fastify; Go: gin, echo, chi, fiber, gorilla/mux, net/http).
 *      Nodes are router VALUES identified by their declaring binding (scope
 *      aware: chi reuses `r` for every nested router), edges are mount calls
 *      with their prefix expressions (`use`, `route`, `register({prefix})`,
 *      `Group`, `Route`, `Mount`, `PathPrefix().Subrouter()`,
 *      `StripPrefix`), routers returned from functions and routers passed to
 *      function parameters. Composition walks the edges from each root, so a
 *      router mounted along several paths serves under several full paths.
 *
 * Everything here is advisory route inventory: an unresolved mount target
 * contributes no edge (the route keeps the prefix it has), an unresolved
 * prefix contributes a `{?expr}` segment.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getParser, safeParse } = require('../languages');
const { codeUnitCompare } = require('./shared');

const MAX_DEPTH = 8;

const JS_LANGS = new Set(['javascript', 'typescript', 'tsx']);

// ============================================================================
// AST SESSION (one per endpoints extraction)
// ============================================================================

class AstSession {
    constructor(index) {
        this.index = index;
        this.trees = new Map();
        this.scopeDecls = new Map();
        this.memo = new Map();
        this.packageFiles = null;
    }

    entry(file) { return this.index.files.get(file); }

    lang(file) { return this.entry(file)?.language || null; }

    /** Root node of a project file (parsed once per session). */
    root(file) {
        if (this.trees.has(file)) {
            const tree = this.trees.get(file);
            return tree ? tree.rootNode : null;
        }
        let tree = null;
        const entry = this.entry(file);
        if (entry) {
            try {
                const parser = getParser(entry.language);
                if (parser) tree = safeParse(parser, this.text(file));
            } catch (e) { tree = null; }
        }
        this.trees.set(file, tree);
        return tree ? tree.rootNode : null;
    }

    /** Source text of a project file (read once per session). */
    text(file) {
        if (!this.texts) this.texts = new Map();
        if (this.texts.has(file)) return this.texts.get(file);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
        this.texts.set(file, text);
        return text;
    }

    /** Parse a detached snippet (annotation/attribute arguments). */
    snippet(lang, code) {
        const key = `snippet\0${lang}\0${code}`;
        if (this.trees.has(key)) {
            const tree = this.trees.get(key);
            return tree ? tree.rootNode : null;
        }
        let tree = null;
        try {
            const parser = getParser(lang);
            if (parser) tree = safeParse(parser, code);
        } catch (e) { tree = null; }
        this.trees.set(key, tree);
        return tree ? tree.rootNode : null;
    }

    /** Memoize with a cycle guard: a re-entrant key answers `fallback`. */
    once(key, fallback, fn) {
        if (this.memo.has(key)) {
            const value = this.memo.get(key);
            return value === IN_PROGRESS ? fallback : value;
        }
        this.memo.set(key, IN_PROGRESS);
        const value = fn();
        this.memo.set(key, value);
        return value;
    }

    /** Go files of one package directory (non-test first). */
    goPackageFiles(dir) {
        if (!this.packageFiles) {
            this.packageFiles = new Map();
            for (const [file, entry] of this.index.files) {
                if (entry.language !== 'go') continue;
                const d = path.dirname(file);
                const list = this.packageFiles.get(d) || [];
                list.push(file);
                this.packageFiles.set(d, list);
            }
            for (const list of this.packageFiles.values()) list.sort(codeUnitCompare);
        }
        return this.packageFiles.get(dir) || [];
    }
}

const IN_PROGRESS = Symbol('in-progress');

// ============================================================================
// SMALL AST HELPERS
// ============================================================================

function field(node, name) {
    return node ? node.childForFieldName(name) : null;
}

function namedChildren(node) {
    const out = [];
    if (!node) return out;
    for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i));
    return out;
}

function isComment(node) {
    return node && node.type.includes('comment');
}

function unwrap(node) {
    let n = node;
    while (n && (n.type === 'parenthesized_expression' || n.type === 'as_expression' ||
        n.type === 'satisfies_expression' || n.type === 'non_null_expression' ||
        n.type === 'type_assertion' || n.type === 'await_expression')) {
        const inner = namedChildren(n).find(c => !isComment(c));
        if (!inner) break;
        n = inner;
    }
    return n;
}

function nodeKey(file, node) {
    return `${file}#${node.startIndex}`;
}

function unescapeSequence(text) {
    switch (text) {
        case '\\n': return '\n';
        case '\\t': return '\t';
        case '\\r': return '\r';
        case '\\\\': return '\\';
        case '\\"': return '"';
        case "\\'": return "'";
        case '\\/': return '/';
        case '\\`': return '`';
        default: return text.length === 2 ? text[1] : '';
    }
}

/** A disclosed unresolved segment. */
function unresolved(node) {
    const text = String(node?.text ?? node ?? '')
        .replace(/\s+/g, ' ').replace(/[{}/?]/g, '').trim().slice(0, 48);
    return `{?${text || 'expr'}}`;
}

function hasUnresolved(value) {
    return typeof value === 'string' && value.includes('{?');
}

const STRING_LITERAL_TYPES = new Set([
    'string', 'template_string', 'concatenated_string',
    'interpreted_string_literal', 'raw_string_literal',
    'string_literal', 'verbatim_string_literal', 'interpolated_string_expression',
    'raw_string_literal_expression', 'text_block',
]);

function isStringLiteral(node) {
    return !!node && STRING_LITERAL_TYPES.has(node.type);
}

/** Fold a string literal node; `evalChild` folds interpolated expressions. */
function readLiteral(node, evalChild) {
    if (node.type === 'concatenated_string') {
        return namedChildren(node).map(child => readLiteral(child, evalChild)).join('');
    }
    const parts = namedChildren(node);
    // Python f-string literal text spells braces doubled (`{{id}}` is `{id}`).
    const fstring = node.type === 'string' && parts[0]?.type === 'string_start' && /[fF]/.test(parts[0].text);
    if (parts.length === 0) {
        const m = node.text.match(/^[@$rRbBuUfF]*("""|'''|"|'|`)([\s\S]*)\1$/);
        return m ? m[2] : '';
    }
    let out = '';
    for (const part of parts) {
        const t = part.type;
        if (t === 'string_start' || t === 'string_end' || t === 'interpolation_start' ||
            t === 'interpolation_brace' || t === 'interpolation_quote' ||
            t === 'raw_string_start' || t === 'raw_string_end') continue;
        if (t === 'escape_sequence') { out += unescapeSequence(part.text); continue; }
        if (t === 'interpolation' || t === 'template_substitution') {
            const inner = namedChildren(part).find(c => c.type !== 'interpolation_brace' &&
                c.type !== 'format_specifier' && c.type !== 'type_conversion' && !isComment(c));
            out += inner ? evalChild(inner) : unresolved(part);
            continue;
        }
        if (t.includes('content') || t.includes('fragment')) {
            // Python string_content may embed escape_sequence children.
            if (part.namedChildCount > 0) {
                let s = '';
                let cursor = part.startIndex;
                for (const esc of namedChildren(part)) {
                    s += part.text.slice(cursor - part.startIndex, esc.startIndex - part.startIndex);
                    s += esc.type === 'escape_sequence' ? unescapeSequence(esc.text) : esc.text;
                    cursor = esc.endIndex;
                }
                s += part.text.slice(cursor - part.startIndex);
                out += fstring ? s.replace(/\{\{/g, '{').replace(/\}\}/g, '}') : s;
            } else {
                out += fstring ? part.text.replace(/\{\{/g, '{').replace(/\}\}/g, '}') : part.text;
            }
            continue;
        }
        return null;
    }
    return out;
}

function binaryOperator(node) {
    const op = field(node, 'operator');
    if (op) return op.type === '+' ? '+' : op.text;
    for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c.isNamed) return c.type;
    }
    return null;
}

// ============================================================================
// CONSTANT EVALUATION
// ============================================================================

/**
 * Evaluate a string-valued expression. Returns the folded string; unprovable
 * leaves appear as `{?expr}` segments.
 */
function evalString(sess, file, node, depth = 0, ctx = null) {
    if (!node) return unresolved('');
    if (depth > MAX_DEPTH) return unresolved(node);
    const n = unwrap(node);
    if (!n) return unresolved(node);
    const recurse = child => evalString(sess, file, child, depth + 1, ctx);

    if (isStringLiteral(n)) {
        const value = readLiteral(n, recurse);
        return value == null ? unresolved(n) : value;
    }
    if (n.type === 'binary_expression' || n.type === 'binary_operator') {
        if (binaryOperator(n) !== '+') return unresolved(n);
        const left = field(n, 'left');
        const right = field(n, 'right');
        if (!left || !right) return unresolved(n);
        return recurse(left) + recurse(right);
    }
    // C# nameof(X) is the identifier text.
    if (n.type === 'invocation_expression') {
        const fn = field(n, 'function');
        if (fn && fn.text === 'nameof') {
            const arg = namedChildren(field(n, 'arguments'))[0];
            if (arg) return arg.text.split('.').pop();
        }
        return unresolved(n);
    }
    const value = lookupValue(sess, file, n, depth + 1, ctx);
    if (value && value.kind === 'expr') {
        return evalString(sess, value.file, value.node, depth + 1,
            value.ctx || (value.file === file ? ctx : null));
    }
    return unresolved(n);
}

/**
 * Resolve a name/member expression to what it denotes:
 *   { kind: 'expr', file, node }   - an expression (constant initializer)
 *   { kind: 'module', file, dir }  - a module / Go package
 *   { kind: 'class', file, node }  - a class declaration
 *   { kind: 'instance', cls }      - an instance of a resolved class
 *   null                           - unknown
 */
function lookupValue(sess, file, node, depth, ctx = null) {
    if (!node || depth > MAX_DEPTH) return null;
    const n = unwrap(node);
    const lang = ctx?.lang || sess.lang(file);
    switch (n.type) {
        case 'identifier':
        case 'shorthand_property_identifier':
            return lookupName(sess, file, n.text, n, depth, ctx);
        case 'member_expression': // JS
            return lookupMember(sess, file, field(n, 'object'), field(n, 'property')?.text, depth, ctx);
        case 'attribute': // Python
            return lookupMember(sess, file, field(n, 'object'), field(n, 'attribute')?.text, depth, ctx);
        case 'selector_expression': // Go
            return lookupMember(sess, file, field(n, 'operand'), field(n, 'field')?.text, depth, ctx);
        case 'field_access': // Java
            return lookupMember(sess, file, field(n, 'object'), field(n, 'field')?.text, depth, ctx);
        case 'member_access_expression': // C#
            return lookupMember(sess, file, field(n, 'expression'), field(n, 'name')?.text, depth, ctx);
        case 'call_expression': { // JS: require('./consts')
            const fn = field(n, 'function');
            if (fn && fn.type === 'identifier' && fn.text === 'require') {
                const arg = namedChildren(field(n, 'arguments'))[0];
                const target = arg && arg.type === 'string'
                    ? resolveJsSpecifier(sess, file, readLiteral(arg, () => '')) : null;
                return target ? { kind: 'module', file: target } : null;
            }
            return null;
        }
        case 'call': // Python: Settings()
        case 'new_expression': { // JS: new Config()
            const callee = field(n, n.type === 'call' ? 'function' : 'constructor');
            const cls = lookupValue(sess, file, callee, depth + 1, ctx);
            return cls && cls.kind === 'class' ? { kind: 'instance', cls } : null;
        }
        default:
            if (lang && isStringLiteral(n)) return { kind: 'expr', file, node: n, ctx };
            return null;
    }
}

function lookupMember(sess, file, objNode, name, depth, ctx) {
    if (!objNode || !name || depth > MAX_DEPTH) return null;
    const obj = lookupValue(sess, file, objNode, depth + 1, ctx);
    if (!obj) return null;
    return memberOf(sess, obj, name, depth + 1);
}

function memberOf(sess, obj, name, depth) {
    if (depth > MAX_DEPTH || !obj) return null;
    if (obj.kind === 'module') return lookupTopLevel(sess, obj.file, name, depth + 1, obj.dir);
    if (obj.kind === 'class') return classMember(sess, obj.file, obj.node, name, depth + 1);
    if (obj.kind === 'instance') {
        return obj.cls ? classMember(sess, obj.cls.file, obj.cls.node, name, depth + 1) : null;
    }
    if (obj.kind === 'expr') {
        const v = unwrap(obj.node);
        if (v.type === 'object') { // JS object literal
            for (const pair of namedChildren(v)) {
                if (pair.type === 'pair') {
                    const key = field(pair, 'key');
                    const keyText = key && (key.type === 'string' ? readLiteral(key, () => '') : key.text);
                    if (keyText === name) return { kind: 'expr', file: obj.file, node: field(pair, 'value') };
                } else if (pair.type === 'shorthand_property_identifier' && pair.text === name) {
                    return lookupName(sess, obj.file, name, pair, depth + 1);
                }
            }
            return null;
        }
        const inner = lookupValue(sess, obj.file, v, depth + 1, obj.ctx);
        if (inner && inner.kind !== 'expr') return memberOf(sess, inner, name, depth + 1);
    }
    return null;
}

/** A class member's constant initializer (class attribute, static field,
 *  const, or a pydantic/dataclass field default). */
function classMember(sess, file, classNode, name, depth) {
    const body = field(classNode, 'body');
    if (!body) return null;
    const lang = sess.lang(file);
    const hits = [];
    const visitStatements = (container) => {
        for (const stmt of namedChildren(container)) {
            if (lang === 'python') {
                const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : stmt;
                if (assign && assign.type === 'assignment') {
                    const left = field(assign, 'left');
                    const right = field(assign, 'right');
                    if (left && left.type === 'identifier' && left.text === name && right) hits.push(right);
                }
            } else if (JS_LANGS.has(lang)) {
                if (stmt.type === 'public_field_definition' || stmt.type === 'field_definition') {
                    const prop = field(stmt, 'name') || field(stmt, 'property');
                    const value = field(stmt, 'value');
                    if (prop && prop.text === name && value) hits.push(value);
                }
            } else if (lang === 'java' || lang === 'csharp') {
                if (stmt.type === 'field_declaration' || stmt.type === 'constant_declaration') {
                    const decls = [];
                    const collect = (n) => {
                        for (const c of namedChildren(n)) {
                            if (c.type === 'variable_declarator') decls.push(c);
                            else if (c.type === 'variable_declaration') collect(c);
                        }
                    };
                    collect(stmt);
                    for (const d of decls) {
                        const nameNode = field(d, 'name') || d.namedChild(0);
                        if (!nameNode || nameNode.text !== name) continue;
                        const value = field(d, 'value') ||
                            namedChildren(d).filter(c => !(c.startIndex === nameNode.startIndex &&
                                c.endIndex === nameNode.endIndex)).pop();
                        if (value && value.type !== 'bracketed_argument_list') hits.push(value);
                    }
                }
            }
        }
    };
    visitStatements(body);
    if (hits.length !== 1) return null;
    return { kind: 'expr', file, node: hits[0], ctx: { lang, classNode } };
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

const JS_FUNCTION_TYPES = new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function_declaration', 'generator_function',
]);
const GO_FUNCTION_TYPES = new Set(['function_declaration', 'method_declaration', 'func_literal']);
const PY_FUNCTION_TYPES = new Set(['function_definition', 'lambda']);
// Go statements whose header declares variables scoped to the statement.
const GO_CLAUSE_SCOPES = new Set([
    'for_statement', 'if_statement', 'expression_switch_statement', 'type_switch_statement',
]);

function isScopeNode(lang, node) {
    if (JS_LANGS.has(lang)) {
        return node.type === 'program' || node.type === 'statement_block' ||
            JS_FUNCTION_TYPES.has(node.type);
    }
    if (lang === 'go') {
        return node.type === 'source_file' || node.type === 'block' ||
            GO_FUNCTION_TYPES.has(node.type) || GO_CLAUSE_SCOPES.has(node.type);
    }
    if (lang === 'python') {
        return node.type === 'module' || PY_FUNCTION_TYPES.has(node.type);
    }
    return false;
}

/** Parameter name nodes of a function node, in positional order. */
function paramNames(lang, fnNode) {
    const out = [];
    const params = field(fnNode, 'parameters') ||
        (fnNode.type === 'arrow_function' ? field(fnNode, 'parameter') : null);
    if (!params) return out;
    if (params.type === 'identifier') return [{ name: params, type: null }];
    for (const p of namedChildren(params)) {
        if (isComment(p)) continue;
        if (JS_LANGS.has(lang)) {
            if (p.type === 'identifier') out.push({ name: p, type: null });
            else if (p.type === 'required_parameter' || p.type === 'optional_parameter') {
                const pat = field(p, 'pattern');
                out.push({ name: pat && pat.type === 'identifier' ? pat : null, type: field(p, 'type') });
            } else if (p.type === 'assignment_pattern') {
                const left = field(p, 'left');
                out.push({ name: left && left.type === 'identifier' ? left : null, type: null });
            } else {
                out.push({ name: null, type: null });
            }
        } else if (lang === 'go') {
            if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue;
            const names = [];
            for (let i = 0; i < p.childCount; i++) {
                if (p.fieldNameForChild(i) === 'name') names.push(p.child(i));
            }
            const type = field(p, 'type');
            if (names.length === 0) out.push({ name: null, type });
            for (const nm of names) out.push({ name: nm, type });
        } else if (lang === 'python') {
            if (p.type === 'identifier') out.push({ name: p, type: null });
            else if (p.type === 'typed_parameter') {
                const nm = namedChildren(p).find(c => c.type === 'identifier');
                out.push({ name: nm || null, type: field(p, 'type') });
            } else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
                out.push({ name: field(p, 'name'), type: field(p, 'type') });
            } else {
                out.push({ name: null, type: null });
            }
        }
    }
    return out;
}

/**
 * Declarations directly owned by a scope node: Map name -> decl record
 *   { nameNode, valueNode, kind, count, typeNode, fnNode, paramIndex }
 */
function scopeDecls(sess, file, lang, scope) {
    const key = `${file}#${scope.startIndex}:${scope.type}`;
    const cached = sess.scopeDecls.get(key);
    if (cached) return cached;
    const map = new Map();
    const add = (nameNode, rec) => {
        if (!nameNode) return;
        const prev = map.get(nameNode.text);
        if (prev) { prev.count++; return; }
        map.set(nameNode.text, { nameNode, count: 1, ...rec });
    };

    const isFn = JS_LANGS.has(lang) ? JS_FUNCTION_TYPES.has(scope.type)
        : lang === 'go' ? GO_FUNCTION_TYPES.has(scope.type)
            : PY_FUNCTION_TYPES.has(scope.type);
    if (lang === 'go' && GO_CLAUSE_SCOPES.has(scope.type)) {
        // `for k, v := range x`, `if v := f(); ...`, `switch x := y.(type)`
        for (const c of namedChildren(scope)) {
            if (c.type === 'range_clause') {
                for (const nm of namedChildren(field(c, 'left'))) {
                    if (nm.type === 'identifier') add(nm, { kind: 'var', valueNode: null });
                }
            } else if (c.type === 'for_clause') {
                const init = field(c, 'initializer');
                if (init) collectStatement(init);
            }
        }
        const init = field(scope, 'initializer');
        if (init) collectStatement(init);
        const alias = field(scope, 'alias');
        if (alias) {
            const names = alias.type === 'identifier' ? [alias] : namedChildren(alias);
            for (const nm of names) if (nm.type === 'identifier') add(nm, { kind: 'var', valueNode: null });
        }
    } else if (isFn) {
        paramNames(lang, scope).forEach((p, i) => {
            if (p.name) add(p.name, { kind: 'param', valueNode: null, typeNode: p.type, fnNode: scope, paramIndex: i });
        });
        if (lang === 'go') {
            const recv = field(scope, 'receiver');
            for (const p of namedChildren(recv)) {
                const nm = field(p, 'name');
                if (nm) add(nm, { kind: 'receiver', valueNode: null, typeNode: field(p, 'type') });
            }
        }
        if (lang === 'python' && scope.type === 'function_definition') {
            const body = field(scope, 'body');
            if (body) collectStatements(body);
        }
    } else {
        collectStatements(scope);
    }

    function collectStatements(container) {
        for (const stmt of namedChildren(container)) {
            if (stmt.type === 'statement_list') { collectStatements(stmt); continue; }
            collectStatement(stmt);
        }
    }

    function collectStatement(stmt) {
        if (JS_LANGS.has(lang)) {
            if (stmt.type === 'export_statement') {
                const decl = field(stmt, 'declaration');
                if (decl) collectStatement(decl);
                return;
            }
            if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
                const isConst = stmt.type === 'lexical_declaration' && stmt.child(0)?.text === 'const';
                for (const d of namedChildren(stmt)) {
                    if (d.type !== 'variable_declarator') continue;
                    const nm = field(d, 'name');
                    if (nm && nm.type === 'identifier') {
                        add(nm, { kind: isConst ? 'const' : 'var', valueNode: field(d, 'value') });
                    }
                }
                return;
            }
            if (stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration') {
                add(field(stmt, 'name'), { kind: 'function', valueNode: stmt });
                return;
            }
            if (stmt.type === 'class_declaration') {
                add(field(stmt, 'name'), { kind: 'class', valueNode: stmt });
            }
            return;
        }
        if (lang === 'go') {
            if (stmt.type === 'short_var_declaration') {
                const left = namedChildren(field(stmt, 'left'));
                const right = namedChildren(field(stmt, 'right'));
                left.forEach((nm, i) => {
                    if (nm.type === 'identifier' && nm.text !== '_') {
                        add(nm, { kind: 'var', valueNode: left.length === right.length ? right[i] : null });
                    }
                });
                return;
            }
            if (stmt.type === 'var_declaration' || stmt.type === 'const_declaration') {
                const specs = [];
                const walkSpecs = (n) => {
                    for (const c of namedChildren(n)) {
                        if (c.type === 'var_spec' || c.type === 'const_spec') specs.push(c);
                        else if (c.type === 'var_spec_list' || c.type === 'const_spec_list') walkSpecs(c);
                    }
                };
                walkSpecs(stmt);
                for (const spec of specs) {
                    const names = [];
                    for (let i = 0; i < spec.childCount; i++) {
                        if (spec.fieldNameForChild(i) === 'name') names.push(spec.child(i));
                    }
                    const values = namedChildren(field(spec, 'value'));
                    names.forEach((nm, i) => add(nm, {
                        kind: stmt.type === 'const_declaration' ? 'const' : 'var',
                        valueNode: names.length === values.length ? values[i] : null,
                        typeNode: field(spec, 'type'),
                    }));
                }
                return;
            }
            if (stmt.type === 'function_declaration') {
                add(field(stmt, 'name'), { kind: 'function', valueNode: stmt });
            }
            return;
        }
        if (lang === 'python') {
            if (stmt.type === 'expression_statement') {
                const assign = stmt.namedChild(0);
                if (assign && assign.type === 'assignment') {
                    const left = field(assign, 'left');
                    if (left && left.type === 'identifier') {
                        add(left, { kind: 'var', valueNode: field(assign, 'right') });
                    }
                }
                return;
            }
            if (stmt.type === 'decorated_definition') {
                const def = field(stmt, 'definition');
                if (def) collectStatement(def);
                return;
            }
            if (stmt.type === 'class_definition') {
                add(field(stmt, 'name'), { kind: 'class', valueNode: stmt });
                return;
            }
            if (stmt.type === 'function_definition') {
                add(field(stmt, 'name'), { kind: 'function', valueNode: stmt });
            }
        }
    }

    sess.scopeDecls.set(key, map);
    return map;
}

/** Nearest lexical declaration of `name` visible from `refNode`. */
function findDecl(sess, file, name, refNode) {
    const lang = sess.lang(file);
    let scope = refNode ? refNode.parent : sess.root(file);
    while (scope) {
        if (isScopeNode(lang, scope)) {
            const decl = scopeDecls(sess, file, lang, scope).get(name);
            // A declaration in the same scope that starts after the reference
            // is not visible to it (Go/Python statement order); JS hoisting
            // of function declarations is honored.
            if (decl && (!refNode || decl.kind === 'function' || decl.kind === 'param' ||
                decl.kind === 'class' || decl.nameNode.startIndex <= refNode.startIndex ||
                scope.parent === null)) {
                return { ...decl, scope };
            }
        }
        scope = scope.parent;
    }
    return null;
}

function declValue(sess, file, decl, depth) {
    if (!decl) return null;
    if (decl.kind === 'class') return { kind: 'class', file, node: decl.valueNode };
    if (decl.kind === 'function' || decl.kind === 'param' || decl.kind === 'receiver') return null;
    if (decl.count > 1 || !decl.valueNode) return null;
    // JS let/var and Go var are reassignable; a single declaration with an
    // initializer is still the only value the scan can see, and Python has
    // no const at all, so a single assignment is the declared value.
    return { kind: 'expr', file, node: decl.valueNode };
}

function lookupName(sess, file, name, refNode, depth, ctx = null) {
    if (depth > MAX_DEPTH) return null;
    const lang = ctx?.lang || sess.lang(file);
    if (lang === 'java' || lang === 'csharp') return lookupJvmName(sess, file, name, depth, ctx);

    const decl = findDecl(sess, file, name, refNode);
    if (decl) return declValue(sess, file, decl, depth);

    if (lang === 'go') {
        // An import alias (`http.MethodGet`) never needs the package scan.
        const entry = sess.entry(file);
        if ((entry?.importBindings || []).some(b => b.name === name)) return lookupImport(sess, file, name, depth);
        return lookupGoPackageLevel(sess, path.dirname(file), name, depth, file);
    }
    return lookupImport(sess, file, name, depth);
}

/** Top-level name in a module (or Go package directory). */
function lookupTopLevel(sess, file, name, depth, dir = null) {
    if (depth > MAX_DEPTH) return null;
    const lang = sess.lang(file);
    if (lang === 'go') return lookupGoPackageLevel(sess, dir || path.dirname(file), name, depth, null);
    const root = sess.root(file);
    if (!root) return null;
    const decl = scopeDecls(sess, file, lang, root).get(name);
    if (decl) return declValue(sess, file, decl, depth);
    if (JS_LANGS.has(lang)) {
        const exported = resolveJsExport(sess, file, name, depth + 1);
        if (exported && exported.file !== file) return exported.value;
    }
    return lookupImport(sess, file, name, depth);
}

function lookupGoPackageLevel(sess, dir, name, depth, skipFile) {
    for (const f of sess.goPackageFiles(dir)) {
        if (f === skipFile) continue;
        // A file that never spells the name cannot declare it (skip the parse).
        if (!sess.text(f).includes(name)) continue;
        const root = sess.root(f);
        if (!root) continue;
        const decl = scopeDecls(sess, f, 'go', root).get(name);
        if (decl) return declValue(sess, f, decl, depth);
    }
    return null;
}

/** Resolve a name bound by an import statement. */
function lookupImport(sess, file, name, depth) {
    const entry = sess.entry(file);
    if (!entry || depth > MAX_DEPTH) return null;
    const lang = entry.language;
    const bindings = entry.importBindings || [];
    const local = name;
    let binding = bindings.find(b => (b.alias || b.name) === local);
    let original = binding ? binding.name : name;
    if (!binding) {
        const alias = (entry.importAliases || []).find(a => a.local === local);
        if (alias) {
            original = alias.original;
            binding = bindings.find(b => b.name === original);
        }
    }
    if (!binding) return null;
    const resolvedRel = (spec) => entry.moduleResolved?.[spec];
    const abs = rel => path.join(sess.index.root, rel);

    if (lang === 'go') {
        const rel = resolvedRel(binding.module);
        return rel ? { kind: 'module', file: abs(rel), dir: path.dirname(abs(rel)) } : null;
    }
    if (lang === 'python') {
        const mod = String(binding.module || '');
        if (binding.kind === 'from') {
            const subSpec = mod.endsWith('.') ? mod + original : `${mod}.${original}`;
            const subRel = resolvedRel(subSpec);
            if (subRel) return { kind: 'module', file: abs(subRel) };
            const rel = resolvedRel(mod);
            return rel ? lookupTopLevel(sess, abs(rel), original, depth + 1) : null;
        }
        const rel = resolvedRel(mod);
        return rel ? { kind: 'module', file: abs(rel) } : null;
    }
    if (JS_LANGS.has(lang)) {
        const rel = resolvedRel(binding.module);
        if (!rel) return null;
        const target = abs(rel);
        if (binding.kind === 'namespace' || original === '*' ||
            (binding.kind === 'require' && binding.defaultLike)) {
            return { kind: 'module', file: target };
        }
        const exported = jsImportedRecord(sess, target, binding, original, depth + 1);
        return exported ? exported.value : null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// JS module exports (ESM + CommonJS), AST-level
// ---------------------------------------------------------------------------

/**
 * Resolve an exported NAME of a JS/TS module to its declaration.
 * Returns { file, declNode|null, valueNode|null, value } where `value` is a
 * lookupValue-style descriptor for constant evaluation.
 */
function resolveJsExport(sess, file, name, depth) {
    if (depth > MAX_DEPTH) return null;
    return sess.once(`jsexport\0${file}\0${name}`, null, () => {
        const root = sess.root(file);
        if (!root) return null;
        const lang = sess.lang(file);
        const decls = scopeDecls(sess, file, lang, root);
        const local = (localName) => {
            const d = decls.get(localName);
            if (d) {
                return { file, declNode: d.nameNode, valueNode: d.valueNode, decl: d,
                    value: declValue(sess, file, d, depth) };
            }
            const imported = lookupImport(sess, file, localName, depth + 1);
            return imported ? { file, declNode: null, valueNode: null, value: imported,
                importedName: localName } : null;
        };
        for (const stmt of namedChildren(root)) {
            if (stmt.type === 'export_statement') {
                const decl = field(stmt, 'declaration');
                if (decl) {
                    for (const d of declaredNames(decl)) if (d === name) return local(name);
                    continue;
                }
                const source = field(stmt, 'source');
                const clause = namedChildren(stmt).find(c => c.type === 'export_clause');
                if (clause) {
                    for (const spec of namedChildren(clause)) {
                        if (spec.type !== 'export_specifier') continue;
                        const orig = field(spec, 'name')?.text;
                        const alias = field(spec, 'alias')?.text || orig;
                        if (alias !== name || !orig) continue;
                        if (source) {
                            const target = resolveJsSpecifier(sess, file, readLiteral(source, () => ''));
                            return target ? resolveJsExport(sess, target, orig, depth + 1) : null;
                        }
                        return local(orig);
                    }
                } else if (source && /\*/.test(stmt.text.slice(0, stmt.text.indexOf('from')))) {
                    const target = resolveJsSpecifier(sess, file, readLiteral(source, () => ''));
                    const hit = target && resolveJsExport(sess, target, name, depth + 1);
                    if (hit) return hit;
                }
            }
            // CommonJS: module.exports = { name }, module.exports.name = X, exports.name = X
            const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : null;
            if (assign && assign.type === 'assignment_expression') {
                const left = field(assign, 'left');
                const right = field(assign, 'right');
                if (!left || !right) continue;
                const lt = left.text.replace(/\s+/g, '');
                if ((lt === `module.exports.${name}` || lt === `exports.${name}`)) {
                    return jsValueRecord(sess, file, right, depth);
                }
                if (lt === 'module.exports' && unwrap(right).type === 'object') {
                    for (const pair of namedChildren(unwrap(right))) {
                        if (pair.type === 'pair' && field(pair, 'key')?.text === name) {
                            return jsValueRecord(sess, file, field(pair, 'value'), depth);
                        }
                        if (pair.type === 'shorthand_property_identifier' && pair.text === name) {
                            return local(name);
                        }
                    }
                }
            }
        }
        return null;
    });
}

function declaredNames(decl) {
    const out = [];
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
        for (const d of namedChildren(decl)) {
            if (d.type === 'variable_declarator' && field(d, 'name')?.type === 'identifier') {
                out.push(field(d, 'name').text);
            }
        }
    } else {
        const nm = field(decl, 'name');
        if (nm) out.push(nm.text);
    }
    return out;
}

/** An expression value inside a module; identifiers resolve to their decl. */
function jsValueRecord(sess, file, node, depth) {
    const v = unwrap(node);
    if (v && v.type === 'identifier') {
        const d = findDecl(sess, file, v.text, v);
        if (d) {
            return { file, declNode: d.nameNode, valueNode: d.valueNode, decl: d,
                value: declValue(sess, file, d, depth) };
        }
        const imported = lookupImport(sess, file, v.text, depth + 1);
        return imported ? { file, declNode: null, valueNode: null, value: imported, importedName: v.text } : null;
    }
    return { file, declNode: null, valueNode: v, value: v ? { kind: 'expr', file, node: v } : null };
}

/** The default export (`export default X`, `module.exports = X`). */
function resolveJsDefaultExport(sess, file, depth) {
    if (depth > MAX_DEPTH) return null;
    return sess.once(`jsdefault\0${file}`, null, () => {
        const root = sess.root(file);
        if (!root) return null;
        for (const stmt of namedChildren(root)) {
            if (stmt.type === 'export_statement' && /^export\s+default\b/.test(stmt.text)) {
                const decl = field(stmt, 'declaration');
                if (decl) {
                    const nm = field(decl, 'name');
                    return nm ? { file, declNode: nm, valueNode: decl, value: null }
                        : { file, declNode: null, valueNode: decl, value: null };
                }
                const value = field(stmt, 'value') || namedChildren(stmt).find(c => !isComment(c));
                return value ? jsValueRecord(sess, file, value, depth) : null;
            }
            const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : null;
            if (assign && assign.type === 'assignment_expression' &&
                field(assign, 'left')?.text.replace(/\s+/g, '') === 'module.exports') {
                return jsValueRecord(sess, file, field(assign, 'right'), depth);
            }
            // `var app = module.exports = express()` (fix #397): the export
            // is the declared binding's value.
            if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
                for (const declarator of namedChildren(stmt)) {
                    if (declarator.type !== 'variable_declarator') continue;
                    const nameNode = field(declarator, 'name');
                    for (let v = unwrap(field(declarator, 'value')); v?.type === 'assignment_expression';
                        v = unwrap(field(v, 'right'))) {
                        if (field(v, 'left')?.text.replace(/\s+/g, '') !== 'module.exports') continue;
                        if (nameNode?.type === 'identifier') return jsValueRecord(sess, file, nameNode, depth);
                    }
                }
            }
        }
        // `export { x as default }` / `export { default } from './y'`
        return resolveJsExport(sess, file, 'default', depth + 1);
    });
}

/** The export an import binding denotes (default vs named, with the
 *  default-import-labeled-named fallback). */
function jsImportedRecord(sess, target, binding, original, depth) {
    if (binding.kind === 'default' || original === 'default' ||
        (binding.kind === 'require' && binding.defaultLike)) {
        return resolveJsDefaultExport(sess, target, depth);
    }
    return resolveJsExport(sess, target, original, depth) ||
        (binding.kind === 'named' ? resolveJsDefaultExport(sess, target, depth) : null);
}

function resolveJsSpecifier(sess, file, spec) {
    const entry = sess.entry(file);
    const rel = entry?.moduleResolved?.[spec];
    return rel ? path.join(sess.index.root, rel) : null;
}

// ---------------------------------------------------------------------------
// Java / C# constants
// ---------------------------------------------------------------------------

function findClassDecls(root, name) {
    const out = [];
    const visit = (node) => {
        if (/^(class|interface|enum|record|struct)_declaration$/.test(node.type)) {
            const nm = field(node, 'name');
            if (nm && nm.text === name) out.push(node);
        }
        for (const c of namedChildren(node)) {
            if (c.type.endsWith('_declaration') || c.type === 'class_body' || c.type === 'declaration_list' ||
                c.type === 'program' || c.type === 'compilation_unit' || c.type === 'namespace_declaration' ||
                c.type === 'file_scoped_namespace_declaration' || c.type === 'enum_body' ||
                c.type === 'interface_body') visit(c);
        }
    };
    visit(root);
    return out;
}

/** Resolve a Java/C# class by simple name: same file, same directory, then
 *  a unique project-wide definition. */
function resolveJvmClass(sess, file, name) {
    return sess.once(`jvmclass\0${file}\0${name}`, null, () => {
        const root = sess.root(file);
        const here = root ? findClassDecls(root, name) : [];
        if (here.length === 1) return { kind: 'class', file, node: here[0] };
        const defs = (sess.index.symbols.get(name) || []).filter(d =>
            /^(class|interface|enum|record|struct)$/.test(d.type) &&
            ['java', 'csharp'].includes(sess.lang(d.file)));
        const dir = path.dirname(file);
        const sameDir = defs.filter(d => path.dirname(d.file) === dir);
        const pick = sameDir.length === 1 ? sameDir[0] : defs.length === 1 ? defs[0] : null;
        if (!pick) return null;
        const r = sess.root(pick.file);
        const nodes = r ? findClassDecls(r, name) : [];
        return nodes.length === 1 ? { kind: 'class', file: pick.file, node: nodes[0] } : null;
    });
}

function lookupJvmName(sess, file, name, depth, ctx) {
    // A bare identifier: a field of the enclosing class, else a class name.
    if (ctx?.classNode) {
        const member = classMember(sess, file, ctx.classNode, name, depth + 1);
        if (member) return member;
    }
    return resolveJvmClass(sess, file, name);
}

// ============================================================================
// ROUTER GRAPH (JS/TS + Go)
// ============================================================================

const JS_ROUTE_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const GO_ROUTE_VERBS = new Set([
    'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'Any', 'Handle', 'HandleFunc',
    'Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'Connect', 'Trace', 'All',
]);

// Router factories: the call that creates a router value (framework API).
const JS_FACTORY_CALLS = new Set(['express', 'Router', 'fastify', 'Fastify', 'Koa']);
const JS_FACTORY_CTORS = new Set(['Router', 'Hono', 'Koa', 'Fastify']);
const GO_FACTORY_CALLS = new Set([
    'chi.NewRouter', 'chi.NewMux', 'gin.New', 'gin.Default', 'echo.New', 'fiber.New',
    'mux.NewRouter', 'http.NewServeMux', 'httprouter.New',
]);
// Parameter types that denote a router value.
const GO_ROUTER_TYPES = new Set([
    'chi.Router', 'chi.Mux', 'chi.Routes', 'gin.Engine', 'gin.RouterGroup', 'gin.IRouter',
    'gin.IRoutes', 'echo.Echo', 'echo.Group', 'fiber.Router', 'fiber.App', 'fiber.Group',
    'mux.Router', 'http.ServeMux',
]);
const JS_ROUTER_TYPES = new Set([
    'Router', 'Express', 'Application', 'FastifyInstance', 'Hono', 'Koa', 'express.Router',
    'express.Express', 'express.Application',
]);

function goTypeName(typeNode) {
    if (!typeNode) return null;
    let t = typeNode;
    while (t && (t.type === 'pointer_type' || t.type === 'parenthesized_type')) t = t.namedChild(0);
    if (!t) return null;
    if (t.type === 'qualified_type') {
        return `${field(t, 'package')?.text}.${field(t, 'name')?.text}`;
    }
    return null;
}

function jsTypeName(typeNode) {
    if (!typeNode) return null;
    const text = typeNode.text.replace(/^:\s*/, '').trim();
    const m = text.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/);
    return m ? m[1] : null;
}

class RouteGraph {
    constructor(index, sess) {
        this.index = index;
        this.sess = sess;
        this.ctor = new Map();       // key -> own prefix
        this.ctorJoin = new Map();   // key -> join rule of its own prefix
        this.edges = new Map();      // target key -> [{ mounterKey, prefix }]
        this.edgeSeen = new Set();
        this.evidence = new Set();   // keys proven to be router values
        this.sites = new Map();      // `${file}:${callStart}` -> { key, verb, path? }
        this.queue = [];
        this.queued = new Set();
        this.walked = new Set();
        this.bindingMemo = new Map();
        this.fnReturnDone = new Set();
        this.globalPrefixes = new Set();
    }

    /** Call records that can register, mount, or pass a router. */
    relevantCall(lang, call) {
        if (lang === 'go') {
            return GO_ROUTE_VERBS.has(call.name) || GO_MOUNT_METHODS.has(call.name) ||
                this.goRouterParamNames().has(call.name);
        }
        if (call.isMethod) {
            return JS_ROUTE_VERBS.has(call.name) || JS_MOUNT_METHODS.has(call.name) ||
                call.receiverIsModule === true;
        }
        return true;
    }

    enqueue(file) {
        if (!file || this.queued.has(file) || !this.index.files.has(file)) return;
        this.queued.add(file);
        this.queue.push(file);
    }

    addEdge(targetKey, mounterKey, prefix, file = null) {
        if (!targetKey || targetKey === mounterKey) return;
        const id = `${targetKey}\0${mounterKey}\0${prefix}`;
        if (this.edgeSeen.has(id)) return;
        this.edgeSeen.add(id);
        const list = this.edges.get(targetKey) || [];
        // The framework of the mounting call decides how its prefix joins
        // what it mounts (fix #383).
        const join = file && this.joinRuleOf ? this.joinRuleOf(file) : 'path';
        list.push({ mounterKey: mounterKey || null, prefix: prefix || '', ...(join !== 'path' && { join }) });
        this.edges.set(targetKey, list);
        if (mounterKey && this.evidence.has(mounterKey)) this.evidence.add(targetKey);
    }

    run() {
        while (this.queue.length > 0) {
            const file = this.queue.shift();
            if (this.walked.has(file)) continue;
            this.walked.add(file);
            const root = this.sess.root(file);
            if (!root) continue;
            const lang = this.sess.lang(file);
            const visit = node => (lang === 'go' ? this.visitGoCall(file, node) : this.visitJsCall(file, node));
            const calls = this.callsOf ? this.callsOf(file) : null;
            if (calls) {
                // Visit only the call nodes the call records point at (the
                // records carry exact spans); a full-tree walk costs a native
                // crossing per node.
                for (const call of calls) {
                    if (call.callStart == null || call.callEnd == null || !this.relevantCall(lang, call)) continue;
                    const node = locateSpan(root, call.callStart, call.callEnd, 'call_expression');
                    if (!node) continue;
                    visit(node);
                    // `require('./routes')(app)`: the outer call has no record.
                    if (call.name === 'require' && node.parent && node.parent.type === 'call_expression' &&
                        field(node.parent, 'function')?.startIndex === node.startIndex) {
                        visit(node.parent);
                    }
                }
                continue;
            }
            const stack = [root];
            while (stack.length > 0) {
                const node = stack.pop();
                if (node.type === 'call_expression') visit(node);
                for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
            }
        }
        // Evidence flows along mount edges (a router mounted by a router).
        let changed = true;
        while (changed) {
            changed = false;
            for (const [target, list] of this.edges) {
                if (this.evidence.has(target)) continue;
                if (list.some(e => e.mounterKey && this.evidence.has(e.mounterKey))) {
                    this.evidence.add(target);
                    changed = true;
                }
            }
        }
    }

    // ------------------------------------------------------------------ JS

    visitJsCall(file, node) {
        const fn = unwrap(field(node, 'function'));
        const args = namedChildren(field(node, 'arguments')).filter(a => !isComment(a));
        if (!fn) return;
        if (fn.type === 'member_expression') {
            const method = field(fn, 'property')?.text;
            const obj = field(fn, 'object');
            if (!method || !obj) return;
            if (JS_ROUTE_VERBS.has(method) && args.length >= 2) {
                const key = this.jsRouterKey(file, obj, 0);
                if (key) this.addSite(file, node, key, method, args[0]);
                return;
            }
            if (method === 'use' || (method === 'route' && args.length >= 2)) {
                if (args.length === 0) return;
                const mounter = this.jsRouterKey(file, obj, 0);
                let prefix = '';
                let targets = args;
                if (this.jsIsPathExpr(file, args[0])) {
                    prefix = evalString(this.sess, file, args[0]);
                    targets = args.slice(1);
                } else if (method === 'route') {
                    return;
                }
                for (const t of targets) {
                    const key = this.jsRouterKey(file, t, 0);
                    if (key) this.addEdge(key, mounter, prefix, file);
                }
                return;
            }
            if (method === 'register' && args.length >= 1) {
                const mounter = this.jsRouterKey(file, obj, 0);
                if (!mounter) return;
                let prefix = '';
                const opts = args[1] ? unwrap(args[1]) : null;
                if (opts && opts.type === 'object') {
                    for (const pair of namedChildren(opts)) {
                        if (pair.type === 'pair' && field(pair, 'key')?.text === 'prefix') {
                            prefix = evalString(this.sess, file, field(pair, 'value'));
                        }
                    }
                }
                const plugin = this.jsFunctionOf(file, args[0], 0);
                if (!plugin) return;
                const params = paramNames(this.sess.lang(plugin.file), plugin.node);
                if (params[0]?.name) {
                    const key = nodeKey(plugin.file, params[0].name);
                    this.evidence.add(key);
                    (this.paramNames || (this.paramNames = new Set())).add(params[0].name.text);
                    this.addEdge(key, mounter, prefix, file);
                    this.enqueue(plugin.file);
                }
                return;
            }
            if (method === 'setGlobalPrefix' && args.length >= 1) {
                this.globalPrefixes.add(evalString(this.sess, file, args[0]));
                return;
            }
        }
        // Router passed to a function: `routes(app)`, `require('./r')(router)`.
        if (args.length > 0 && (fn.type === 'identifier' || fn.type === 'call_expression' ||
            fn.type === 'member_expression')) {
            this.jsPassRouterArgs(file, fn, args);
        }
    }

    jsIsPathExpr(file, node) {
        const n = unwrap(node);
        if (!n) return false;
        if (n.type === 'string' || n.type === 'template_string') return true;
        if (n.type === 'binary_expression') return binaryOperator(n) === '+';
        if (n.type === 'identifier' || n.type === 'member_expression') {
            const v = lookupValue(this.sess, file, n, 0);
            if (!v || v.kind !== 'expr') return false;
            const vn = unwrap(v.node);
            return vn && (vn.type === 'string' || vn.type === 'template_string' ||
                (vn.type === 'binary_expression' && binaryOperator(vn) === '+'));
        }
        return false;
    }

    /** Function node denoted by an expression (inline, local, imported, require). */
    jsFunctionOf(file, node, depth) {
        if (depth > MAX_DEPTH) return null;
        const n = unwrap(node);
        if (!n) return null;
        if (JS_FUNCTION_TYPES.has(n.type)) return { file, node: n };
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) {
                if (decl.kind === 'function') return { file, node: decl.valueNode };
                if (decl.valueNode) return this.jsFunctionOf(file, decl.valueNode, depth + 1);
                return null;
            }
            const rec = this.jsImportRecord(file, n.text, depth + 1);
            if (rec) return this.jsRecordFunction(rec, depth + 1);
            return null;
        }
        if (n.type === 'call_expression' && this.isRequireCall(n)) {
            const target = resolveJsSpecifier(this.sess, file, this.requireSpec(n));
            const rec = target && resolveJsDefaultExport(this.sess, target, depth + 1);
            return rec ? this.jsRecordFunction(rec, depth + 1) : null;
        }
        if (n.type === 'member_expression') {
            const obj = unwrap(field(n, 'object'));
            const prop = field(n, 'property')?.text;
            if (obj && obj.type === 'identifier' && prop) {
                const v = lookupValue(this.sess, file, obj, depth + 1);
                if (v && v.kind === 'module') {
                    const rec = resolveJsExport(this.sess, v.file, prop, depth + 1);
                    return rec ? this.jsRecordFunction(rec, depth + 1) : null;
                }
            }
        }
        return null;
    }

    jsRecordFunction(rec, depth) {
        if (!rec) return null;
        if (rec.decl && rec.decl.kind === 'function') return { file: rec.file, node: rec.decl.valueNode };
        if (rec.valueNode) {
            const v = unwrap(rec.valueNode);
            if (JS_FUNCTION_TYPES.has(v.type)) return { file: rec.file, node: v };
            if (v.type === 'identifier' || v.type === 'call_expression') {
                return this.jsFunctionOf(rec.file, v, depth + 1);
            }
        }
        return null;
    }

    jsImportRecord(file, name, depth) {
        const entry = this.sess.entry(file);
        if (!entry) return null;
        const bindings = entry.importBindings || [];
        let binding = bindings.find(b => (b.alias || b.name) === name);
        let original = binding ? binding.name : name;
        if (!binding) {
            const alias = (entry.importAliases || []).find(a => a.local === name);
            if (alias) { original = alias.original; binding = bindings.find(b => b.name === original); }
        }
        if (!binding) return null;
        const target = resolveJsSpecifier(this.sess, file, binding.module);
        if (!target || binding.kind === 'namespace') return null;
        return jsImportedRecord(this.sess, target, binding, original, depth + 1);
    }

    isRequireCall(n) {
        const f = field(n, 'function');
        return f && f.type === 'identifier' && f.text === 'require';
    }

    requireSpec(n) {
        const arg = namedChildren(field(n, 'arguments'))[0];
        return arg && arg.type === 'string' ? readLiteral(arg, () => '') : null;
    }

    /** Names a file uses as routers (factory results, route/mount
     *  receivers) - the only identifiers worth resolving as router args. */
    jsRouterNames(file) {
        if (!this._jsRouterNames) this._jsRouterNames = new Map();
        let names = this._jsRouterNames.get(file);
        if (names) return names;
        names = new Set();
        for (const call of (this.callsOf ? this.callsOf(file) : null) || []) {
            if (call.isMethod && call.receiver &&
                (JS_ROUTE_VERBS.has(call.name) || JS_MOUNT_METHODS.has(call.name))) names.add(call.receiver);
            if (call.assignedTo && (JS_FACTORY_CALLS.has(call.name) || JS_FACTORY_CTORS.has(call.name) ||
                call.name === 'basePath')) names.add(call.assignedTo);
        }
        this._jsRouterNames.set(file, names);
        return names;
    }

    jsPassRouterArgs(file, fnNode, args) {
        const routerArgs = [];
        const names = this.callsOf ? this.jsRouterNames(file) : null;
        args.forEach((a, i) => {
            const n = unwrap(a);
            if (!n || (n.type !== 'identifier' && n.type !== 'member_expression')) return;
            if (names && n.type === 'identifier' && !names.has(n.text) && !this.isEvidenceParamName(file, n)) return;
            const key = this.jsRouterKey(file, n, 0, true);
            if (key && this.evidence.has(key)) routerArgs.push([i, key]);
        });
        if (routerArgs.length === 0) return;
        const fn = this.jsFunctionOf(file, fnNode, 0);
        if (!fn) return;
        const params = paramNames(this.sess.lang(fn.file), fn.node);
        for (const [i, key] of routerArgs) {
            const p = params[i];
            if (!p || !p.name) continue;
            const pk = nodeKey(fn.file, p.name);
            this.evidence.add(pk);
            (this.paramNames || (this.paramNames = new Set())).add(p.name.text);
            this.addEdge(pk, key, '', file);
            this.enqueue(fn.file);
        }
    }

    /** A parameter already proven to receive a router (passed on). */
    isEvidenceParamName(file, n) {
        if (!this.paramNames || !this.paramNames.has(n.text)) return false;
        const decl = findDecl(this.sess, file, n.text, n);
        return !!decl && decl.kind === 'param' && this.evidence.has(nodeKey(file, decl.nameNode));
    }

    /**
     * Router value key of an expression. `lookupOnly` skips creating keys for
     * values with no router evidence (argument passing).
     */
    jsRouterKey(file, node, depth, lookupOnly = false) {
        if (depth > MAX_DEPTH) return null;
        const n = unwrap(node);
        if (!n) return null;
        if (n.type === 'identifier' || n.type === 'this') {
            if (n.type === 'this') return null;
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) return this.jsBindingKey(file, decl, depth);
            const rec = this.jsImportRecord(file, n.text, depth + 1);
            if (rec) return this.jsRecordKey(rec, depth + 1);
            return null;
        }
        if (n.type === 'call_expression' || n.type === 'new_expression') {
            return this.jsValueKey(file, n, nodeKey(file, n), depth);
        }
        if (n.type === 'member_expression') {
            const obj = unwrap(field(n, 'object'));
            const prop = field(n, 'property')?.text;
            if (obj && obj.type === 'identifier' && prop) {
                const v = lookupValue(this.sess, file, obj, depth + 1);
                if (v && v.kind === 'module') {
                    const rec = resolveJsExport(this.sess, v.file, prop, depth + 1);
                    return rec ? this.jsRecordKey(rec, depth + 1) : null;
                }
            }
        }
        return null;
    }

    jsRecordKey(rec, depth) {
        if (!rec) return null;
        this.enqueue(rec.file);
        if (rec.decl) return this.jsBindingKey(rec.file, rec.decl, depth + 1);
        if (rec.valueNode) {
            const v = unwrap(rec.valueNode);
            return this.jsValueKey(rec.file, v, nodeKey(rec.file, v), depth + 1);
        }
        return null;
    }

    jsBindingKey(file, decl, depth) {
        const key = nodeKey(file, decl.nameNode);
        if (decl.kind === 'param') {
            if (JS_ROUTER_TYPES.has(jsTypeName(decl.typeNode))) this.evidence.add(key);
            return key;
        }
        if (decl.kind !== 'const' && decl.kind !== 'var') return null;
        const memo = this.bindingMemo.get(key);
        if (memo !== undefined) return memo === IN_PROGRESS ? key : memo;
        this.bindingMemo.set(key, IN_PROGRESS);
        let result = key;
        if (decl.valueNode && decl.count === 1) {
            let v = unwrap(decl.valueNode);
            // `var app = module.exports = express()`: the assigned value.
            while (v?.type === 'assignment_expression') v = unwrap(field(v, 'right'));
            if (v.type === 'identifier') {
                result = this.jsRouterKey(file, v, depth + 1) || key;
            } else {
                result = this.jsValueKey(file, v, key, depth + 1) || key;
            }
        }
        this.bindingMemo.set(key, result);
        return result;
    }

    /** Key of a router-producing expression; `key` names the value. */
    jsValueKey(file, v, key, depth) {
        if (!v || depth > MAX_DEPTH) return null;
        if (v.type === 'new_expression') {
            const ctor = field(v, 'constructor');
            const name = ctor ? ctor.text.split('.').pop() : null;
            if (name && JS_FACTORY_CTORS.has(name)) {
                this.evidence.add(key);
                // koa-router: new Router({ prefix: '/api' })
                const opts = unwrap(namedChildren(field(v, 'arguments'))[0]);
                if (opts && opts.type === 'object') {
                    for (const pair of namedChildren(opts)) {
                        if (pair.type === 'pair' && field(pair, 'key')?.text === 'prefix') {
                            this.ctor.set(key, evalString(this.sess, file, field(pair, 'value')));
                            if (this.joinRuleOf) this.ctorJoin.set(key, this.joinRuleOf(file));
                        }
                    }
                }
                return key;
            }
            return null;
        }
        if (v.type !== 'call_expression') return null;
        const fn = unwrap(field(v, 'function'));
        const args = namedChildren(field(v, 'arguments')).filter(a => !isComment(a));
        if (!fn) return null;
        if (fn.type === 'identifier') {
            if (JS_FACTORY_CALLS.has(fn.text)) { this.evidence.add(key); return key; }
            if (fn.text === 'require') {
                const target = resolveJsSpecifier(this.sess, file, this.requireSpec(v));
                const rec = target && resolveJsDefaultExport(this.sess, target, depth + 1);
                return rec ? this.jsRecordKey(rec, depth + 1) : null;
            }
            return this.jsFunctionResultKey(file, fn, depth);
        }
        if (fn.type === 'member_expression') {
            const method = field(fn, 'property')?.text;
            const obj = field(fn, 'object');
            if (method === 'Router' && obj && /^express$/.test(obj.text)) {
                this.evidence.add(key);
                return key;
            }
            if (method === 'basePath' && args.length >= 1) {
                const parent = this.jsRouterKey(file, obj, depth + 1);
                this.evidence.add(key);
                this.addEdge(key, parent, evalString(this.sess, file, args[0]), file);
                return key;
            }
            // koa-router `sub.routes()`, and chained registrations
            // (`app.get(...).post(...)`, `app.use(mw)`) return the router.
            if (method === 'routes' || method === 'use' ||
                (JS_ROUTE_VERBS.has(method) && args.length >= 2)) {
                return this.jsRouterKey(file, obj, depth + 1);
            }
            return this.jsFunctionResultKey(file, fn, depth);
        }
        return null;
    }

    /** A call to a project function that returns a router. */
    jsFunctionResultKey(file, fnExpr, depth) {
        const fn = this.jsFunctionOf(file, fnExpr, depth + 1);
        if (!fn) return null;
        const fkey = `fn:${nodeKey(fn.file, fn.node)}`;
        if (!this.fnReturnDone.has(fkey)) {
            this.fnReturnDone.add(fkey);
            const body = field(fn.node, 'body');
            const returns = [];
            if (body && body.type !== 'statement_block') returns.push(body);
            else collectReturns(body, returns, JS_FUNCTION_TYPES);
            for (const r of returns) {
                const key = this.jsRouterKey(fn.file, r, depth + 1);
                if (key && this.evidence.has(key)) {
                    this.addEdge(key, fkey, '', file);
                    this.evidence.add(fkey);
                    this.enqueue(fn.file);
                }
            }
        }
        return this.evidence.has(fkey) ? fkey : null;
    }

    addSite(file, callNode, key, verb, pathArg) {
        const site = { key, verb };
        if (pathArg) {
            const value = evalString(this.sess, file, pathArg);
            if (!hasUnresolved(value)) site.path = value;
        }
        // Chained calls share a start offset; the span identifies the call.
        this.sites.set(`${file}:${callNode.startIndex}:${callNode.endIndex}`, site);
    }

    // ------------------------------------------------------------------ Go

    visitGoCall(file, node) {
        const fn = unwrap(field(node, 'function'));
        const args = namedChildren(field(node, 'arguments')).filter(a => !isComment(a));
        if (!fn) return;
        if (fn.type === 'selector_expression') {
            const method = field(fn, 'field')?.text;
            const operand = field(fn, 'operand');
            if (!method || !operand) return;
            const registers = GO_ROUTE_VERBS.has(method) || method === 'Route' || method === 'Group' ||
                method === 'Mount';
            if (registers && !this.goIsPackage(file, operand)) {
                if (GO_ROUTE_VERBS.has(method) && args.length >= 2) {
                    const key = this.goRouterKey(file, operand, 0);
                    if (key) this.addSite(file, node, key, method, args[0]);
                    // net/http: mux.Handle("/api/", http.StripPrefix("/api", sub))
                    if ((method === 'Handle' || method === 'HandleFunc') && key) {
                        const h = unwrap(args[1]);
                        if (h && h.type === 'call_expression') {
                            const hf = unwrap(field(h, 'function'));
                            const hargs = namedChildren(field(h, 'arguments')).filter(a => !isComment(a));
                            if (hf && hf.type === 'selector_expression' &&
                                field(hf, 'field')?.text === 'StripPrefix' && hargs.length >= 2) {
                                const target = this.goRouterKey(file, hargs[1], 0);
                                if (target) this.addEdge(target, key, evalString(this.sess, file, hargs[0]), file);
                            }
                        }
                    }
                    return;
                }
                if ((method === 'Route' || method === 'Group') && args.length >= 1) {
                    const closure = unwrap(args[args.length - 1]);
                    if (closure && closure.type === 'func_literal') {
                        const mounter = this.goRouterKey(file, operand, 0);
                        const prefix = method === 'Route' && args.length >= 2
                            ? evalString(this.sess, file, args[0]) : '';
                        const p = paramNames('go', closure)[0];
                        if (p && p.name && mounter) {
                            const key = nodeKey(file, p.name);
                            this.evidence.add(key);
                            this.addEdge(key, mounter, prefix, file);
                        }
                    }
                    return;
                }
                if (method === 'Mount' && args.length >= 2) {
                    const mounter = this.goRouterKey(file, operand, 0);
                    const target = this.goRouterKey(file, args[1], 0);
                    if (mounter && target) {
                        this.addEdge(target, mounter, evalString(this.sess, file, args[0]), file);
                    }
                    return;
                }
            }
        }
        // Router passed to a function parameter: `api.Register(v1)`.
        if (args.length > 0 && (fn.type === 'identifier' || fn.type === 'selector_expression')) {
            const calleeName = fn.type === 'identifier' ? fn.text : field(fn, 'field')?.text;
            if (calleeName && this.goRouterParamNames().has(calleeName)) this.goPassRouterArgs(file, fn, args);
        }
    }

    goIsPackage(file, operand) {
        const n = unwrap(operand);
        if (!n || n.type !== 'identifier') return false;
        const entry = this.sess.entry(file);
        if (!(entry?.importBindings || []).some(b => b.name === n.text)) return false;
        return !findDecl(this.sess, file, n.text, n);
    }

    /** Go function/method names with a router-typed parameter (from the
     *  index's structured parameters; no parse). */
    goRouterParamNames() {
        if (this._goRouterParamNames) return this._goRouterParamNames;
        const names = new Set();
        for (const [name, defs] of this.index.symbols) {
            for (const d of defs) {
                if (!d.paramsStructured || this.sess.lang(d.file) !== 'go') continue;
                if (d.paramsStructured.some(p => isGoRouterTypeText(p.type))) { names.add(name); break; }
            }
        }
        this._goRouterParamNames = names;
        return names;
    }

    goPassRouterArgs(file, fnNode, args) {
        // Only arguments bound to a router-typed parameter are routers the
        // callee registers on (Go parameters are typed; this keeps the scan
        // to one memoized callee lookup per call site).
        if (!args.some(a => { const n = unwrap(a); return n && (n.type === 'identifier' ||
            n.type === 'call_expression' || n.type === 'unary_expression'); })) return;
        const fn = this.goFunctionOf(file, fnNode);
        if (!fn) return;
        const params = paramNames('go', fn.node);
        args.forEach((a, i) => {
            const p = params[i];
            if (!p || !p.name || !isGoRouterType(p.type)) return;
            const key = this.goRouterKey(file, a, 0);
            if (!key) return;
            const pk = nodeKey(fn.file, p.name);
            this.evidence.add(pk);
            this.addEdge(pk, key, '', file);
            this.enqueue(fn.file);
        });
    }

    /** Project function/method declaration a Go call expression denotes. */
    goFunctionOf(file, fnNode) {
        const n = unwrap(fnNode);
        if (!n) return null;
        if (n.type === 'func_literal') return { file, node: n };
        if (n.type === 'identifier' && findDecl(this.sess, file, n.text, n)) {
            return this.goFunctionOfUncached(file, n);
        }
        const memoKey = `gofn\0${file}\0${n.text}`;
        if (this.bindingMemo.has(memoKey)) return this.bindingMemo.get(memoKey);
        const result = this.goFunctionOfUncached(file, n);
        this.bindingMemo.set(memoKey, result);
        return result;
    }

    goFunctionOfUncached(file, n) {
        let name = null;
        let dirs = null;
        let methodsOnly = false;
        if (n.type === 'func_literal') return { file, node: n };
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl && decl.kind === 'function') return { file, node: decl.valueNode };
            if (decl && decl.valueNode && unwrap(decl.valueNode).type === 'func_literal') {
                return { file, node: unwrap(decl.valueNode) };
            }
            if (decl) return null;
            name = n.text;
            dirs = [path.dirname(file)];
        } else if (n.type === 'selector_expression') {
            const operand = unwrap(field(n, 'operand'));
            name = field(n, 'field')?.text;
            if (this.goIsPackage(file, operand)) {
                const v = lookupImport(this.sess, file, operand.text, 0);
                if (!v || v.kind !== 'module') return null;
                dirs = [v.dir];
            } else {
                methodsOnly = true;
            }
        }
        if (!name) return null;
        const defs = (this.index.symbols.get(name) || []).filter(d => {
            if (this.sess.lang(d.file) !== 'go') return false;
            if (methodsOnly) return !!(d.isMethod || d.type === 'method' || d.receiver);
            if (d.isMethod || d.type === 'method' || d.receiver) return false;
            return dirs.includes(path.dirname(d.file));
        });
        if (defs.length !== 1) return null;
        const def = defs[0];
        const found = (goTopLevelFunctions(this.sess, def.file).get(name) || []).find(node =>
            node.startPosition.row + 1 <= def.startLine && node.endPosition.row + 1 >= def.startLine);
        return found ? { file: def.file, node: found } : null;
    }

    goRouterKey(file, node, depth) {
        if (depth > MAX_DEPTH) return null;
        const n = unwrap(node);
        if (!n) return null;
        if (n.type === 'unary_expression') return this.goRouterKey(file, n.namedChild(0), depth + 1);
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) return this.goBindingKey(file, decl, depth);
            // Package-level router variable in a sibling file.
            for (const f of this.sess.goPackageFiles(path.dirname(file))) {
                if (f === file || !this.sess.text(f).includes(n.text)) continue;
                const root = this.sess.root(f);
                const d = root && scopeDecls(this.sess, f, 'go', root).get(n.text);
                if (d) { this.enqueue(f); return this.goBindingKey(f, d, depth + 1); }
            }
            return null;
        }
        if (n.type === 'call_expression') return this.goValueKey(file, n, nodeKey(file, n), depth);
        return null;
    }

    goBindingKey(file, decl, depth) {
        const key = nodeKey(file, decl.nameNode);
        if (decl.kind === 'param' || decl.kind === 'receiver') {
            if (isGoRouterType(decl.typeNode)) this.evidence.add(key);
            return key;
        }
        if (decl.kind !== 'var') return null;
        const memo = this.bindingMemo.get(key);
        if (memo !== undefined) return memo === IN_PROGRESS ? key : memo;
        this.bindingMemo.set(key, IN_PROGRESS);
        let result = key;
        if (isGoRouterType(decl.typeNode)) this.evidence.add(key);
        if (decl.valueNode && decl.count === 1) {
            const v = unwrap(decl.valueNode);
            if (v.type === 'identifier') result = this.goRouterKey(file, v, depth + 1) || key;
            else result = this.goValueKey(file, v, key, depth + 1) || key;
        }
        this.bindingMemo.set(key, result);
        return result;
    }

    goValueKey(file, v, key, depth) {
        if (!v || depth > MAX_DEPTH) return null;
        if (v.type === 'unary_expression') return this.goValueKey(file, v.namedChild(0), key, depth + 1);
        if (v.type !== 'call_expression') return null;
        const fn = unwrap(field(v, 'function'));
        const args = namedChildren(field(v, 'arguments')).filter(a => !isComment(a));
        if (!fn) return null;
        if (fn.type === 'selector_expression') {
            const operand = field(fn, 'operand');
            const method = field(fn, 'field')?.text;
            if (this.goIsPackage(file, operand)) {
                if (GO_FACTORY_CALLS.has(`${unwrap(operand).text}.${method}`)) {
                    this.evidence.add(key);
                    return key;
                }
                return this.goFunctionResultKey(file, fn, depth);
            }
            // gin/echo/fiber: r.Group("/v1", mw...) - a string-first group.
            if (method === 'Group' && args.length >= 1 && unwrap(args[0]).type !== 'func_literal') {
                const parent = this.goRouterKey(file, operand, depth + 1);
                if (!parent) return null;
                this.evidence.add(key);
                this.addEdge(key, parent, evalString(this.sess, file, args[0]), file);
                return key;
            }
            // fiber: app.Route("/p", fn) returns the prefixed router.
            if (method === 'Route' && args.length >= 1 && unwrap(args[0]).type !== 'func_literal') {
                const parent = this.goRouterKey(file, operand, depth + 1);
                if (!parent) return null;
                this.evidence.add(key);
                this.addEdge(key, parent, evalString(this.sess, file, args[0]), file);
                return key;
            }
            // gorilla/mux: r.PathPrefix("/api").Subrouter()
            if (method === 'Subrouter') {
                const inner = unwrap(operand);
                if (inner && inner.type === 'call_expression') {
                    const f2 = unwrap(field(inner, 'function'));
                    const a2 = namedChildren(field(inner, 'arguments')).filter(a => !isComment(a));
                    if (f2 && f2.type === 'selector_expression' && field(f2, 'field')?.text === 'PathPrefix' && a2.length >= 1) {
                        const parent = this.goRouterKey(file, field(f2, 'operand'), depth + 1);
                        if (!parent) return null;
                        this.evidence.add(key);
                        this.addEdge(key, parent, evalString(this.sess, file, a2[0]), file);
                        return key;
                    }
                }
                return null;
            }
            // chi: r.With(mw) is the same router with extra middleware.
            if (method === 'With') return this.goRouterKey(file, operand, depth + 1);
            return this.goFunctionResultKey(file, fn, depth);
        }
        if (fn.type === 'identifier') return this.goFunctionResultKey(file, fn, depth);
        return null;
    }

    goFunctionResultKey(file, fnExpr, depth) {
        const fn = this.goFunctionOf(file, fnExpr);
        if (!fn) return null;
        const fkey = `fn:${nodeKey(fn.file, fn.node)}`;
        if (!this.fnReturnDone.has(fkey)) {
            this.fnReturnDone.add(fkey);
            const returns = [];
            collectReturns(field(fn.node, 'body'), returns, GO_FUNCTION_TYPES);
            for (const r of returns) {
                const key = this.goRouterKey(fn.file, r, depth + 1);
                if (key && this.evidence.has(key)) {
                    this.addEdge(key, fkey, '', file);
                    this.evidence.add(fkey);
                    this.enqueue(fn.file);
                }
            }
        }
        return this.evidence.has(fkey) ? fkey : null;
    }
}

const GO_ROUTER_TYPE_NAMES = new Set([
    'Router', 'Mux', 'Routes', 'Engine', 'RouterGroup', 'IRouter', 'IRoutes', 'Echo', 'Group',
    'App', 'ServeMux',
]);

/** A router-typed Go parameter: a known framework type, or (inside the
 *  framework's own package) the same type name unqualified. */
function isGoRouterType(typeNode) {
    if (!typeNode) return false;
    const qualified = goTypeName(typeNode);
    if (qualified) return GO_ROUTER_TYPES.has(qualified);
    let t = typeNode;
    while (t && (t.type === 'pointer_type' || t.type === 'parenthesized_type')) t = t.namedChild(0);
    return !!t && t.type === 'type_identifier' && GO_ROUTER_TYPE_NAMES.has(t.text);
}

function isGoRouterTypeText(text) {
    if (!text) return false;
    const t = String(text).replace(/^[*(\s]+|[)\s]+$/g, '');
    return GO_ROUTER_TYPES.has(t) || GO_ROUTER_TYPE_NAMES.has(t);
}

/** Top-level function/method declarations of a Go file by name. */
function goTopLevelFunctions(sess, file) {
    return sess.once(`gofuncs\0${file}`, new Map(), () => {
        const map = new Map();
        const root = sess.root(file);
        for (const node of namedChildren(root)) {
            if (node.type !== 'function_declaration' && node.type !== 'method_declaration') continue;
            const name = field(node, 'name')?.text;
            if (!name) continue;
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(node);
        }
        return map;
    });
}

const JS_MOUNT_METHODS = new Set(['use', 'route', 'register', 'setGlobalPrefix', 'basePath']);
const GO_MOUNT_METHODS = new Set(['Group', 'Route', 'Mount', 'Handle', 'HandleFunc']);

/** The node of `type` spanning exactly [start, end). */
function locateSpan(root, start, end, type) {
    let node = root.descendantForIndex(start, Math.max(start, end - 1));
    while (node && !(node.type === type && node.startIndex === start && node.endIndex === end)) {
        if (node.startIndex < start || node.endIndex > end) {
            // Climbed past the span without finding the exact node.
            if (node.type === type && node.startIndex <= start && node.endIndex >= end) break;
        }
        node = node.parent;
    }
    return node && node.type === type && node.startIndex === start && node.endIndex === end ? node : null;
}

/** Returned expressions of a function body, excluding nested functions. */
function collectReturns(body, out, fnTypes) {
    if (!body) return;
    const stack = [body];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node !== body && fnTypes.has(node.type)) continue;
        if (node.type === 'return_statement') {
            const values = namedChildren(node).filter(c => !isComment(c));
            const v = values.length === 1 && values[0].type === 'expression_list'
                ? namedChildren(values[0]) : values;
            if (v.length === 1) out.push(v[0]);
            continue;
        }
        for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
    }
}

/**
 * Build the router graph for JS/TS and Go files that carry mount calls.
 * `seedFiles` are the files whose call cache shows a mount/group call; files
 * reached through resolution are walked too.
 */
function buildRouteGraph(index, sess, seedFiles, callsOf = null, goRouterParamNames = null, joinRuleOf = null) {
    const graph = new RouteGraph(index, sess);
    graph.callsOf = callsOf;
    graph.joinRuleOf = joinRuleOf;
    if (goRouterParamNames) graph._goRouterParamNames = goRouterParamNames;
    for (const f of [...seedFiles].sort(codeUnitCompare)) graph.enqueue(f);
    graph.run();
    return graph;
}

module.exports = {
    AstSession,
    buildRouteGraph,
    locateSpan,
    evalString,
    hasUnresolved,
    unresolved,
    lookupValue,
    lookupImport,
    resolveJsExport,
    resolveJsDefaultExport,
    resolveJvmClass,
    findClassDecls,
    findDecl,
    scopeDecls,
    paramNames,
    readLiteral,
    unwrap,
    field,
    namedChildren,
    nodeKey,
    isStringLiteral,
    GO_ROUTER_TYPES,
    isGoRouterTypeText,
};
