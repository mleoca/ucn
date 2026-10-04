'use strict';

/**
 * Shared AST extraction for C and C++.
 *
 * This module deliberately works from tree-sitter node kinds and fields. Text
 * is read only from nodes already identified by the grammar; there is no regex
 * source fallback.
 */

const { typeOrigin } = require('./type-evidence');


const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    extractJSDocstring,
    visitNameNodes,
    sameNode,
    extractStringArg,
    parseErrorRegions,
} = require('./utils');
const { referenceScope, scopeFields } = require('./lexical-scope');
const { createHash } = require('crypto');
const { isMainThread } = require('worker_threads');
const { PARSE_OPTIONS, safeParse } = require('./index');
const { functionMacroTemplate, objectMacroBody, lexPP } = require('./c-preprocessor');
const {
    directiveFunctionMacros, definitionInEffect, misreadMacroInvocations, substituteInvocation,
} = require('./c-macro-invocations');
const CPP_ACCESS_KEYWORDS = new Set(['public', 'protected', 'private']);
// Keywords the grammar can surface as plain identifiers inside an ERROR.
const CPP_KEYWORDS = new Set([
    'alignas', 'alignof', 'asm', 'auto', 'break', 'case', 'catch', 'class', 'concept', 'const',
    'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
    'co_yield', 'decltype', 'default', 'delete', 'do', 'dynamic_cast', 'else', 'enum', 'explicit',
    'export', 'extern', 'final', 'for', 'friend', 'goto', 'if', 'inline', 'mutable', 'namespace',
    'new', 'noexcept', 'operator', 'override', 'private', 'protected', 'public', 'register',
    'reinterpret_cast', 'requires', 'return', 'sizeof', 'static', 'static_assert', 'static_cast',
    'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'try', 'typedef', 'typeid',
    'typename', 'union', 'using', 'virtual', 'volatile', 'while', 'restrict', '_Atomic',
    '_Noreturn', '_Thread_local', '_Static_assert',
]);

// Replacement lists longer than this are not kept as expansion templates;
// their invocations are disclosed as unexpanded instead (fix #362).
const MAX_MACRO_TEMPLATE_CHARS = 16384;

const TYPE_NODES = new Set([
    'primitive_type', 'type_identifier', 'sized_type_specifier',
    'qualified_identifier', 'template_type', 'auto', 'decltype',
]);
const CLASS_NODES = new Set([
    'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier',
]);
const FUNCTION_CONTAINERS = new Set(['function_definition', 'declaration', 'field_declaration']);
const IDENTIFIER_NODES = new Set([
    'identifier', 'field_identifier', 'type_identifier', 'namespace_identifier',
    'operator_name', 'destructor_name',
]);

// Attribute-macro parse recovery. Export/visibility macros (`TS_PUBLIC extern
// void (*fp)(void *);`, `API int f(int);`) are consumed by the grammar as the
// declaration's TYPE, displacing the real return type into an ERROR node — and
// for function-pointer declarators, displacing the real name into a parameter.
// Blanking the macro token with spaces preserves every byte offset, so one
// whole-file re-parse yields correct positions for all extractors. Errored
// files pay the full recovery scan; a clean file still needs one cached walk
// because `class API Name` is a grammar-valid (but semantically wrong)
// function-definition shape.
const DECLARATION_NODES = new Set([
    'declaration', 'function_definition', 'field_declaration', 'type_definition',
]);
// An identifier node can only carry one of these texts through a mis-parse —
// they are reserved words in both C and C++.
const RESERVED_TYPE_KEYWORDS = new Set([
    'void', 'int', 'char', 'float', 'double', 'long', 'short',
    'signed', 'unsigned', 'bool', '_Bool',
]);

function hasMissingChild(node) {
    for (let i = 0; i < node.childCount; i++) {
        if (node.child(i).isMissing) return true;
    }
    return false;
}

function classAttributeShape(node) {
    if (node.type !== 'function_definition') return null;
    const typeNode = node.childForFieldName('type');
    const declaratorNode = node.childForFieldName('declarator');
    if (!['class_specifier', 'struct_specifier', 'union_specifier']
        .includes(typeNode?.type) ||
        typeNode.childForFieldName('body') ||
        declaratorNode?.type !== 'identifier' ||
        node.childForFieldName('body')?.type !== 'compound_statement') {
        return null;
    }
    return typeNode.childForFieldName('name') || null;
}

// `API int (name) (params);` / `API T (name) (params) { .. }` (fix #396):
// the grammar reads the decoration macro as the type and `int (name)` as a
// function declarator nested directly in another one, a function returning
// a function, which no C or C++ declaration can be. The only reading is a
// decoration before the return type `int` and the parenthesized name. Returns
// { typeNode, returnNode } for that shape.
function nestedFunctionDeclaratorShape(node) {
    if (!DECLARATION_NODES.has(node.type) || node.type === 'type_definition') return null;
    const typeNode = node.childForFieldName('type');
    const outer = node.childForFieldName('declarator');
    if (typeNode?.type !== 'type_identifier' || outer?.type !== 'function_declarator') return null;
    const inner = outer.childForFieldName('declarator');
    if (inner?.type !== 'function_declarator') return null;
    const returnNode = inner.childForFieldName('declarator');
    if (returnNode?.type !== 'identifier') return null;
    const list = inner.childForFieldName('parameters');
    const params = (list?.namedChildren || []).filter(child => child.type !== 'comment');
    if (params.length !== 1 || params[0].type !== 'parameter_declaration' ||
        params[0].childForFieldName('declarator') ||
        params[0].childForFieldName('type')?.type !== 'type_identifier') return null;
    const open = list.child(0);
    const close = list.child(list.childCount - 1);
    if (open?.type !== '(' || close?.type !== ')') return null;
    return { typeNode, returnNode, open, close };
}

// The definition after `node` (past an enclosing template head) on a later
// line, when it is a function definition with no type whose declarator is
// a function head: every parameter a declaration (a type, and a name where
// any is written), so no macro invocation reading fits it (fix #396).
function typelessFunctionHeadAfter(node) {
    const holder = node.parent?.type === 'template_declaration' ? node.parent : node;
    const next = holder.nextNamedSibling;
    if (next?.type !== 'function_definition' || next.childForFieldName('type') ||
        next.startPosition.row <= node.endPosition.row) return false;
    const declarator = next.childForFieldName('declarator');
    if (declarator?.type !== 'function_declarator' ||
        declarator.childForFieldName('declarator')?.type !== 'identifier') return false;
    const params = (declarator.childForFieldName('parameters')?.namedChildren || [])
        .filter(child => child.type !== 'comment');
    return params.length > 0 && params.every(param =>
        (param.type === 'parameter_declaration' || param.type === 'optional_parameter_declaration') &&
        param.childForFieldName('type')) &&
        params.some(param => param.childForFieldName('declarator'));
}

const NOT_DECLARATOR_WORDS = new Set(['noexcept', 'decltype', 'alignas', 'requires', 'throw', 'sizeof',
    'return', 'if', 'while', 'for', 'switch', 'const', 'volatile', 'override', 'final', 'static_assert']);

// A function head starts at `index` (after blanks): a plain or qualified
// name (or a destructor) followed by `(`, or an operator function id.
function functionHeadAt(code, index) {
    const rest = code.slice(skipBlank(code, index, 1), skipBlank(code, index, 1) + 256);
    if (/^operator\b/.test(rest)) return true;
    const head = /^~?\s*([A-Za-z_]\w*)(?:\s*::\s*~?\s*[A-Za-z_]\w*)*\s*\(/.exec(rest);
    return !!head && !NOT_DECLARATOR_WORDS.has(head[1]);
}

// Nothing but storage classes, qualifiers and attributes precede `typeNode`
// in the declaration.
function onlySpecifiersBefore(node, typeNode) {
    for (const child of node.namedChildren || []) {
        if (sameNode(child, typeNode)) return true;
        if (!['storage_class_specifier', 'type_qualifier', 'virtual', 'attribute_specifier',
            'attribute_declaration', 'ms_declspec_modifier'].includes(child.type)) return false;
    }
    return false;
}

function isMacroToken(text) {
    const value = String(text || '');
    if (value.length < 2) return false;
    let hasLetter = false;
    for (const character of value) {
        if (character >= 'A' && character <= 'Z') {
            hasLetter = true;
            continue;
        }
        if ((character >= '0' && character <= '9') ||
            character === '_') {
            continue;
        }
        return false;
    }
    return hasLetter;
}

function macroInvocationRange(code, identifier, statement = false) {
    if (!identifier || !isMacroToken(identifier.text)) return null;
    let cursor = identifier.endIndex;
    while (cursor < code.length &&
        (code[cursor] === ' ' || code[cursor] === '\t')) {
        cursor++;
    }
    if (code[cursor] !== '(') return null;
    let depth = 0;
    let nested = false;
    let quote = null;
    let escaped = false;
    for (let index = cursor; index < code.length; index++) {
        const character = code[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '(' && ++depth > 1) nested = true;
        else if (character === ')' && --depth === 0) {
            if (!nested || !(typeof statement === 'function' ? statement() : statement)) {
                return [identifier.startIndex, index + 1];
            }
            // In a function body, arguments holding a parenthesis (a call, a
            // cast) are never blanked: before `;` the name alone is, leaving
            // an expression statement whose calls stay calls (fix #387, as
            // for #385). Before a declaration the invocation is a prefix
            // macro and goes whole.
            let after = index + 1;
            while (after < code.length && (code[after] === ' ' || code[after] === '\t')) after++;
            return code[after] === ';' ? [identifier.startIndex, identifier.endIndex] : null;
        }
        if (character === '\n' && depth === 0) break;
    }
    return null;
}

function isStandaloneMacroLine(code, identifier) {
    if (!identifier || !isMacroToken(identifier.text)) return false;
    const lineStart = code.lastIndexOf('\n', identifier.startIndex - 1) + 1;
    const lineEndAt = code.indexOf('\n', identifier.endIndex);
    const lineEnd = lineEndAt < 0 ? code.length : lineEndAt;
    return code.slice(lineStart, lineEnd).trim() === identifier.text;
}

function onDirectiveLine(code, node) {
    let cursor = code.lastIndexOf('\n', node.startIndex - 1) + 1;
    while (code[cursor] === ' ' || code[cursor] === '\t') cursor++;
    return code[cursor] === '#';
}

// fix #387: which token of a declaration's specifier sequence is
// decoration. Two type names cannot stand side by side in one declaration
// (`X Y name(...)`): one of them is a macro that expands to specifiers,
// attributes or nothing (`CLI11_INLINE App *App::f()`, `BOOL WINAPI f()`).
// Recovery blanks that one and keeps every other token; a reserved word, a
// scope (`CLI::`), a template name (`Foo<`) or a directive line is never
// blanked.
const BUILTIN_TYPE_WORDS = new Set([
    ...RESERVED_TYPE_KEYWORDS, 'auto', 'decltype', 'wchar_t', 'char8_t', 'char16_t', 'char32_t',
    '_Complex', '_Imaginary',
]);
// Words that begin an elaborated or dependent type specifier.
const TYPE_INTRODUCER_WORDS = new Set(['struct', 'class', 'union', 'enum', 'typename']);
const NEVER_BLANKED_WORDS = new Set([
    ...CPP_KEYWORDS, ...BUILTIN_TYPE_WORDS, 'import', 'module', 'nullptr', 'true', 'false',
]);
const PLAIN_NAME_NODES = new Set(['identifier', 'field_identifier', 'type_identifier', 'namespace_identifier']);
// Nodes that are a whole type specifier on their own.
const WHOLE_TYPE_NODES = new Set([
    'qualified_identifier', 'template_type', 'primitive_type', 'sized_type_specifier',
    'struct_specifier', 'class_specifier', 'union_specifier', 'enum_specifier',
    'placeholder_type_specifier', 'decltype', 'auto', 'dependent_type',
]);
// Declarations whose `type` field names a type (not a function's return).
const TYPE_USE_CONTAINERS = new Set([
    'parameter_declaration', 'optional_parameter_declaration', 'type_descriptor',
]);
const TYPE_PARAMETER_NODES = new Set([
    'type_parameter_declaration', 'optional_type_parameter_declaration',
    'variadic_type_parameter_declaration',
]);

function skipBlank(code, index, step) {
    let cursor = index;
    while (cursor >= 0 && cursor < code.length && /\s/.test(code[cursor])) cursor += step;
    return cursor;
}

function isNameStart(character) {
    return !!character && /[A-Za-z_]/.test(character);
}

/**
 * The token continues as a qualified or templated type name (`std::string`,
 * `Foo<int>`): a scope or a template, never a decoration macro. `Class::*`
 * (a pointer to member) and `Class::~` do not continue a type.
 */
function continuesTypeName(code, node) {
    const next = skipBlank(code, node.endIndex, 1);
    if (code[next] === '<' && code[next + 1] !== '<' && code[next + 1] !== '=') return true;
    // `A::B` as written; `MACRO ::std::string` is a macro before a
    // global-qualified name.
    if (next !== node.endIndex || code[next] !== ':' || code[next + 1] !== ':') return false;
    const after = skipBlank(code, next + 2, 1);
    if (!isNameStart(code[after])) return false;
    return !/^operator\b/.test(code.slice(after, after + 9));
}

/** Is `node` in statement position (inside a function body)? */
function inFunctionBody(node) {
    for (let up = node; up; up = up.parent) {
        if (up.type === 'compound_statement') return true;
        if (up.type === 'field_declaration_list' || up.type === 'declaration_list' ||
            up.type === 'translation_unit') return false;
    }
    return false;
}

/** A token-pasting operand (`name##_SUFFIX`, `PREFIX##name`). */
function pastedToken(code, node) {
    const before = skipBlank(code, node.startIndex - 1, -1);
    const after = skipBlank(code, node.endIndex, 1);
    return (before > 0 && code[before] === '#' && code[before - 1] === '#') ||
        (code[after] === '#' && code[after + 1] === '#');
}

/** Preceded by `::`: a segment of a qualified name. */
function qualifiedSegment(code, node) {
    const previous = skipBlank(code, node.startIndex - 1, -1);
    return previous > 0 && code[previous] === ':' && code[previous - 1] === ':';
}

/** Does this node name a type on its own (structure, not evidence)? */
function structuralType(node, code) {
    if (!node) return false;
    if (WHOLE_TYPE_NODES.has(node.type)) return true;
    if (!PLAIN_NAME_NODES.has(node.type)) return false;
    return BUILTIN_TYPE_WORDS.has(node.text) || TYPE_INTRODUCER_WORDS.has(node.text) ||
        continuesTypeName(code, node);
}

function declaresFunction(declarator) {
    for (let current = declarator; current; current = current.childForFieldName('declarator')) {
        if (current.type === 'function_declarator') return true;
        if (!current.type.endsWith('_declarator') && current.type !== 'init_declarator') return false;
    }
    return false;
}

/**
 * Does this occurrence of a name prove it names a type (or a namespace)?
 * Positions a decoration macro cannot take: a scope, a template name, a
 * class/typedef/alias/type-parameter/namespace declaration, the type of a
 * parameter, template argument or variable in a construct that parsed
 * cleanly. A function's return-type position is not evidence (the grammar
 * reads decoration macros there).
 */
function occurrenceNamesType(node) {
    const parent = node.parent;
    if (!parent || parent.type === 'ERROR') return false;
    const field = name => sameNode(parent.childForFieldName(name), node);
    switch (parent.type) {
        case 'qualified_identifier':
            // `A::` as written (`MACRO ::std::string f()` reads as a scope).
            return field('scope') && !parent.hasError && node.endIndex < parent.endIndex &&
                parent.child(1)?.type === '::' && parent.child(1).startIndex === node.endIndex;
        case 'template_type':
            return field('name') && !parent.hasError;
        case 'class_specifier':
        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier': {
            // A class with its body, or a forward declaration `class X;`
            // (`class API X {` reads as a bodyless `class API`).
            if (!field('name') || parent.parent?.type === 'ERROR') return false;
            if (parent.childForFieldName('body')) return true;
            const holder = parent.parent;
            return holder?.type === 'declaration' && !holder.hasError && !holder.childForFieldName('declarator');
        }
        case 'alias_declaration':
        case 'namespace_definition':
            return field('name');
        case 'declaration':
        case 'field_declaration': {
            // A name alone on its line before a statement reads as a
            // declaration's type (`EXPECT_ABORT_BEGIN\n m = f();`): only a
            // declarator on the type's own line makes it evidence.
            const declarator = parent.childForFieldName('declarator');
            return field('type') && !parent.hasError && !!declarator && !declaresFunction(declarator) &&
                declarator.startPosition.row === node.startPosition.row;
        }
        default:
            break;
    }
    if (TYPE_PARAMETER_NODES.has(parent.type)) return true;
    if (TYPE_USE_CONTAINERS.has(parent.type)) return field('type') && !parent.hasError;
    // A typedef name, however deeply declared (`typedef struct s *PS;`).
    for (let up = parent; up; up = up.parent) {
        if (up.type === 'type_definition') return !up.hasError;
        if (!up.type.endsWith('_declarator')) return false;
    }
    return false;
}

const MAX_TYPE_EVIDENCE_OCCURRENCES = 512;
const definitionReadingMemo = new Map(); // grammar + replacement list -> reading (fix #387)
const IDENTIFIER_TEXT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Per-file evidence for decoration decisions, gathered lazily from the
 * file's own tree and directives: names proven types by an occurrence, names
 * proven decoration by a recovery shape that proves it, and the file's own
 * object-like macros read as the preprocessor would substitute them.
 */
class DecorationEvidence {
    constructor(parser, code, tree) {
        this.parser = parser;
        this.code = code;
        this.tree = tree;
        this.decorations = new Set();
        this.types = new Map();
        this.defines = null;
        this.defineEnds = null;
        // Names read by the project's definitions rather than the file's
        // own (fix #396).
        this.externalNames = new Set();
    }

    prove(node) {
        if (node && PLAIN_NAME_NODES.has(node.type)) this.decorations.add(node.text);
    }

    /**
     * How the file's own object-like `#define NAME ...` lines read (the
     * preprocessor's line grammar, continuations joined): 'decoration',
     * 'type' or null.
     */
    defined(name) {
        if (!IDENTIFIER_TEXT.test(name)) return null;
        if (!this.defines) {
            // One scan for the object-like definitions' name ends.
            this.defines = new Map();
            this.defineEnds = new Map();
            const directive = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_(])/gm;
            for (let match = directive.exec(this.code); match; match = directive.exec(this.code)) {
                if (!this.defineEnds.has(match[1])) this.defineEnds.set(match[1], []);
                this.defineEnds.get(match[1]).push(match.index + match[0].length);
            }
        }
        if (this.defines.has(name)) return this.defines.get(name);
        const bodies = [];
        const code = this.code;
        // A name the file does not define reads by the project's definitions
        // of it (fix #396); a type occurrence in the file outranks them.
        if (!this.defineEnds.has(name) && externalMacroContext?.objectBodies?.has(name)) {
            if (this.typeByOccurrence(name)) {
                this.defines.set(name, null);
                return null;
            }
            bodies.push(...externalMacroContext.objectBodies.get(name));
            this.externalNames.add(name);
        }
        for (const nameEnd of this.defineEnds.get(name) || []) {
            let end = nameEnd;
            let body = '';
            for (;;) {
                const lineEnd = code.indexOf('\n', end);
                const line = code.slice(end, lineEnd < 0 ? code.length : lineEnd);
                const continued = /\\[ \t\r]*$/.test(line);
                body += ` ${continued ? line.replace(/\\[ \t\r]*$/, '') : line}`;
                if (!continued || lineEnd < 0) break;
                end = lineEnd + 1;
            }
            bodies.push(body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ' '));
        }
        const readings = new Set(bodies.map(body => this.readBody(body)));
        let reading = readings.size === 1 ? [...readings][0] : null;
        // A statement macro defined empty in some configuration
        // (`#define TRY try` / `#define TRY`) is removable in all of them.
        if (!reading && readings.size === 2 && readings.has('statement') && readings.has('decoration') &&
            bodies.every(body => !body.trim() || this.readBody(body) === 'statement')) reading = 'statement';
        this.defines.set(name, reading);
        return reading;
    }

    /** Does a replacement list read as declaration specifiers, or as a type? */
    readBody(body) {
        const text = body.trim();
        if (!text) return 'decoration';
        // A statement fragment whose removal keeps the statements around it
        // (fix #396): `try` before a block, a complete `catch (...) { }`
        // handler after one.
        if (text === 'try') return 'statement';
        // A conditional keyword (`if`, `if constexpr`): read as `if`.
        if (text === 'if' || /^if\s+constexpr$/.test(text)) return 'if';
        // Replacement lists repeat across a project's files (one header's
        // macros read from every includer): one probe per grammar and text.
        const memoKey = `${this.parser.getLanguage?.()?.name || ''}\0${text}`;
        if (definitionReadingMemo.has(memoKey)) return definitionReadingMemo.get(memoKey);
        const reading = this.probeBody(text);
        if (definitionReadingMemo.size >= MACRO_BODY_MEMO_MAX) {
            definitionReadingMemo.delete(definitionReadingMemo.keys().next().value);
        }
        definitionReadingMemo.set(memoKey, reading);
        return reading;
    }

    probeBody(text) {
        if (/^catch\b/.test(text)) {
            const tree = safeParse(this.parser, `void __ucn_probe__() { try { } ${text} }`, undefined, PARSE_OPTIONS);
            const clean = !!tree && !tree.rootNode.hasError;
            tree?.delete?.();
            return clean ? 'statement' : null;
        }
        const probe = source => {
            const tree = safeParse(this.parser, source, undefined, PARSE_OPTIONS);
            const root = tree?.rootNode;
            const declaration = root && !root.hasError && root.namedChildCount === 1 ? root.namedChild(0) : null;
            const typeNode = declaration?.type === 'declaration' ? declaration.childForFieldName('type') : null;
            const result = typeNode ? { type: typeNode.type, typeEnd: typeNode.endIndex } : null;
            tree?.delete?.();
            return result;
        };
        const specifiers = probe(`${text} int __ucn_probe__;`);
        if (specifiers?.type === 'primitive_type' && specifiers.typeEnd === `${text} int`.length) return 'decoration';
        const typed = probe(`${text} __ucn_probe__;`);
        if (typed && typed.typeEnd <= text.length + 1) return 'type';
        return null;
    }

    /**
     * Decoration: the file's own `#define` reads as specifiers, or a shape
     * proved it and no occurrence proves the name a type (an occurrence is
     * the stronger proof).
     */
    decoration(name) {
        const defined = this.defined(name);
        if (defined) return defined === 'decoration';
        return this.decorations.has(name) && !this.typeByOccurrence(name);
    }

    type(name) {
        const defined = this.defined(name);
        if (defined) return defined === 'type';
        return this.typeByOccurrence(name);
    }

    typeByOccurrence(name) {
        if (!IDENTIFIER_TEXT.test(name)) return false;
        if (this.types.has(name)) return this.types.get(name);
        let result = false;
        const code = this.code;
        const root = this.tree.rootNode;
        let checked = 0;
        for (let at = code.indexOf(name); !result && at >= 0 && checked < MAX_TYPE_EVIDENCE_OCCURRENCES;
            at = code.indexOf(name, at + name.length)) {
            const end = at + name.length;
            if ((at > 0 && /[A-Za-z0-9_]/.test(code[at - 1])) || /[A-Za-z0-9_]/.test(code[end] || '')) continue;
            // A call, an invocation or a declarator puts `(` right after the
            // name; of those only a type-producing invocation (`M(x) name`,
            // a declarator after the argument list) can prove a type, so the
            // lookup is skipped for the rest.
            const open = skipBlank(code, end, 1);
            if (code[open] === '(') {
                const close = macroInvocationRange(code, { text: 'M_', startIndex: at, endIndex: end });
                const after = close ? code[skipBlank(code, close[1], 1)] || '' : '';
                if (!/[A-Za-z_*&]/.test(after)) continue;
            }
            checked++;
            const node = root.descendantForIndex(at, end);
            if (node && node.startIndex === at && node.endIndex === end && PLAIN_NAME_NODES.has(node.type) &&
                occurrenceNamesType(node)) {
                result = true;
            }
        }
        this.types.set(name, result);
        return result;
    }
}

/** May recovery blank this token as decoration? */
function blankableToken(node, code) {
    if (!node || !PLAIN_NAME_NODES.has(node.type)) return false;
    if (NEVER_BLANKED_WORDS.has(node.text)) return false;
    if (continuesTypeName(code, node) || qualifiedSegment(code, node)) return false;
    return !onDirectiveLine(code, node);
}

/**
 * Of two adjacent specifier tokens in one declaration, the one that is
 * decoration, or null when neither may be blanked. Structure decides first
 * (a reserved type word, a qualified or templated name, a class-key is the
 * type), then what the file proves about either name (an occurrence as a
 * type, a shape that proves decoration, its own `#define`), then the
 * spelling object-like macros conventionally take; failing all, the grammar
 * keeps the first as the type.
 */
function decorationOfPair(first, second, code, evidence) {
    const firstType = structuralType(first, code);
    const secondType = structuralType(second, code);
    const pick = node => (blankableToken(node, code) ? node : null);
    if (secondType && !firstType) return pick(first);
    if (firstType && !secondType) return pick(second);
    if (firstType && secondType) return null;
    if (!PLAIN_NAME_NODES.has(first.type) || !PLAIN_NAME_NODES.has(second.type)) return null;
    if (NEVER_BLANKED_WORDS.has(first.text) || NEVER_BLANKED_WORDS.has(second.text)) return null;
    if (evidence) {
        const firstDecoration = evidence.decoration(first.text);
        const secondDecoration = evidence.decoration(second.text);
        const firstIsType = evidence.type(first.text);
        const secondIsType = evidence.type(second.text);
        if ((secondIsType && !firstIsType) || (firstDecoration && !secondDecoration)) return pick(first);
        if ((firstIsType && !secondIsType) || (secondDecoration && !firstDecoration)) return pick(second);
    }
    const firstMacro = isMacroToken(first.text);
    const secondMacro = isMacroToken(second.text);
    if (firstMacro && !secondMacro) return pick(first);
    return pick(second);
}

/**
 * `ACCESS_MACRO:` alone on a line inside a class body can only be an access
 * specifier produced by a macro (`JSON_PRIVATE_UNLESS_TESTED:` expands to
 * `public:` or `private:`): a bit-field needs a type and a declarator, and a
 * label cannot appear in a member list. Blank the macro AND its colon;
 * leaving the colon behind derails the rest of the member list.
 */
function accessSpecifierMacroRange(code, identifier) {
    if (!identifier || !isMacroToken(identifier.text)) return null;
    const lineStart = code.lastIndexOf('\n', identifier.startIndex - 1) + 1;
    const lineEndAt = code.indexOf('\n', identifier.endIndex);
    const lineEnd = lineEndAt < 0 ? code.length : lineEndAt;
    if (code.slice(lineStart, identifier.startIndex).trim()) return null;
    const rest = code.slice(identifier.endIndex, lineEnd);
    const colon = rest.indexOf(':');
    if (colon < 0 || rest.slice(0, colon).trim() ||
        rest[colon + 1] === ':' || rest.slice(colon + 1).trim()) {
        return null;
    }
    return [identifier.startIndex, identifier.endIndex + colon + 1];
}

/**
 * Statement-keyword macros (`TRY_MACRO { ... }`, `CATCH_MACRO(e&) { ... }`,
 * `FOREACH_MACRO(x, xs) { ... }`) introduce a block the grammar cannot
 * attach: the first reads as a compound literal that swallows the block's
 * statements, the second as a function definition nested in a function body
 * (C and C++ have no nested function definitions). Blanking the macro and
 * its argument list leaves an ordinary nested block with the same contents
 * and scope, which is the structure the expansion produces.
 */
function statementMacroRange(node, code, evidence = null) {
    if (node.type === 'compound_literal_expression' && node.hasError &&
        node.parent?.type === 'expression_statement') {
        const type = node.childForFieldName('type');
        const value = node.childForFieldName('value');
        if (type?.type === 'type_identifier' && isMacroToken(type.text) &&
            value?.type === 'initializer_list' &&
            value.startPosition.row > type.startPosition.row) {
            return [type.startIndex, type.endIndex];
        }
        return null;
    }
    if (node.type !== 'function_definition' ||
        node.childForFieldName('type') ||
        node.parent?.type !== 'compound_statement') {
        return null;
    }
    const declarator = node.childForFieldName('declarator');
    const name = declarator?.type === 'function_declarator'
        ? declarator.childForFieldName('declarator') : null;
    if (name?.type !== 'identifier' || !isMacroToken(name.text)) return null;
    // A class the file declares: a constructor whose class body the
    // grammar lost, not a statement macro (fix #387).
    if (evidence?.type(name.text)) return null;
    return [name.startIndex, declarator.endIndex];
}

function errorMacroRanges(node, code, pairs = null, evidence = null) {
    const ranges = [];
    const decoration = token => {
        if (!blankableToken(token, code)) return;
        evidence?.prove(token);
        ranges.push([token.startIndex, token.endIndex]);
    };
    if (node.type === 'ERROR') {
        const named = node.namedChildren || [];
        // A constructor or destructor head the grammar left inside an ERROR
        // (`template <..., MACRO(x)> ATTR1 ATTR2 fstring(const S& s) :
        // str(s) {`): it has no return type, so the names written right
        // before it on its line are decoration (fix #387).
        for (let i = 1; i < named.length; i++) {
            if (named[i].type !== 'function_declarator' || !PLAIN_NAME_NODES.has(named[i - 1].type) ||
                named[i - 1].startPosition.row !== named[i].startPosition.row) continue;
            const found = declaratorIdentity(named[i]);
            const owner = found?.className?.replace(/<.*>$/s, '');
            // Only a constructor takes a member-initializer list (`f(...) :`).
            const next = named[i].nextSibling;
            const initializerList = next?.type === ':' && !next.isNamed;
            const constructor = found?.name && (initializerList || (owner
                ? found.name === owner || found.name === `~${owner}`
                : classBodyName(node) === found.name));
            if (!constructor) continue;
            for (let j = i - 1; j >= 0; j--) {
                const previous = named[j];
                if (!PLAIN_NAME_NODES.has(previous.type) ||
                    previous.startPosition.row !== named[i].startPosition.row) break;
                decoration(previous);
            }
        }
        // fix #379: `MACRO Type name(...)` split into ERROR[MACRO, Type] and a
        // declarator on the same line: two type specifiers in a row, so one
        // of them is decoration (fix #387: which one is decided, not assumed).
        const following = node.nextSibling;
        if (named.length === 2 && named[0].type === 'identifier' &&
            !RESERVED_TYPE_KEYWORDS.has(named[0].text) &&
            !CPP_KEYWORDS.has(named[0].text) && !CPP_KEYWORDS.has(named[1].text) &&
            (TYPE_NODES.has(named[1].type) || named[1].type === 'identifier') &&
            named[1].startPosition.row === named[0].startPosition.row &&
            following && following.startPosition.row === named[1].startPosition.row &&
            ['function_declarator', 'init_declarator', 'pointer_declarator',
                'reference_declarator'].includes(following.type) &&
            !onDirectiveLine(code, named[0])) {
            if (pairs) pairs.push({ first: named[0], second: named[1] });
            else ranges.push([named[0].startIndex, named[0].endIndex]);
        }
        for (const child of named) {
            if (['class_specifier', 'struct_specifier',
                'union_specifier'].includes(child.type)) {
                const name = child.childForFieldName('name');
                const invocation = macroInvocationRange(code, name);
                if (invocation) ranges.push(invocation);
                continue;
            }
            if (!IDENTIFIER_NODES.has(child.type)) continue;
            // Directive operands (`#ifndef GUARD`, `#define NAME`) are
            // preprocessor syntax, never declaration decoration. Blanking
            // an include-guard name turned `#ifndef GUARD` into a bare
            // `#ifndef`, and conditional recovery then selected the empty
            // configuration of the whole header.
            if (onDirectiveLine(code, child)) continue;
            const accessMacro = accessSpecifierMacroRange(code, child);
            if (accessMacro) {
                ranges.push(accessMacro);
                continue;
            }
            // A name the file proves is a type is not a macro: followed by
            // `(` it is a constructor or a functional cast (fix #387).
            const invocation = macroInvocationRange(code, child, () => inFunctionBody(node));
            if (invocation) {
                if (!evidence?.type(child.text)) ranges.push(invocation);
            } else if (isStandaloneMacroLine(code, child)) {
                if (!evidence?.type(child.text)) decoration(child);
            } else if (sameNode(child, named[0]) &&
                child.startPosition.row === node.startPosition.row &&
                isMacroToken(child.text) && !evidence?.type(child.text)) {
                // Prefix before a declaration fragment inside one ERROR:
                // `FMT_EXPORT template <...> class X`.
                decoration(child);
            }
        }
    }
    if ((node.type === 'function_definition' || node.type === 'declaration' ||
        node.type === 'field_declaration') && node.hasError) {
        const type = node.childForFieldName('type');
        // A declaration's first following child (an ERROR swallowing
        // `enum class`, fix #379) counts as its declarator here.
        const declarator = node.childForFieldName('declarator') ||
            (node.type === 'declaration' ? type?.nextNamedSibling : null) ||
            // `FIELDS_MACRO` alone before the `};` closing a member list.
            (node.namedChildren || []).find(child => child.type === 'ERROR' &&
                type && child.startIndex >= type.endIndex);
        if (type && type.type === 'type_identifier' && isStandaloneMacroLine(code, type) &&
            declarator &&
            declarator.startPosition.row > type.startPosition.row) {
            // A standalone namespace/opening macro followed by a declaration
            // can be swallowed as the return type of one enormous malformed
            // function. It cannot be a real multi-line C++ return type.
            decoration(type);
        }
    }
    // Prefix macro before a template declaration:
    // `FMT_EXPORT template <typename T> class X`. The grammar represents the
    // prefix plus template head as an erroneous template_function, followed
    // by the class fragment and its body.
    if (node.type === 'template_function' && node.hasError) {
        const macro = node.childForFieldName('name') || node.namedChild(0);
        if (macro && isMacroToken(macro.text) &&
            (node.namedChildren || []).some(child =>
                child.type === 'ERROR' &&
                child.text.trim() === 'template')) {
            decoration(macro);
        }
    }
    return ranges;
}

/**
 * fix #379: `class EXPORT Name : bases {` shape. tree-sitter reads
 * `class EXPORT` as a bodyless specifier of a declaration and the rest of the
 * head as an ERROR beginning with the real class name and the base-clause
 * colon (or `final`). Returns the macro name node to blank, else null.
 */
function classHeadMacroName(node, code) {
    if ((node.type !== 'declaration' && node.type !== 'function_definition') || !node.hasError) return null;
    const specifier = node.childForFieldName('type');
    if (!specifier || !['class_specifier', 'struct_specifier', 'union_specifier']
        .includes(specifier.type) || specifier.childForFieldName('body')) {
        return null;
    }
    const name = specifier.childForFieldName('name');
    if (name?.type !== 'type_identifier') return null;
    const following = specifier.nextSibling;
    if (!following || following.startPosition.row !== name.startPosition.row) return null;
    // The real class name: the first token of what follows (an ERROR, or a
    // qualified name the base clause was glued into).
    let realName = following;
    while (realName && realName.childCount > 0) realName = realName.child(0);
    if (!realName || !['identifier', 'type_identifier', 'namespace_identifier'].includes(realName.type) ||
        CPP_KEYWORDS.has(realName.text)) return null;
    // What follows the real name must open a base clause (`:` but not `::`),
    // possibly after `final`.
    let cursor = realName.endIndex;
    const skip = () => { while (cursor < code.length && /\s/.test(code[cursor])) cursor++; };
    skip();
    if (code.startsWith('final', cursor) && !/[A-Za-z0-9_]/.test(code[cursor + 5] || '')) {
        cursor += 5;
        skip();
    }
    if (code[cursor] === ':' && code[cursor + 1] !== ':') return name;
    return null;
}

/**
 * fix #379: the first scope segment of a function's qualified name when the
 * grammar found no `::` right after it (MISSING `::` or an ERROR next), i.e.
 * `X Y::m` where X is one of two adjacent names. Null otherwise.
 */
function qualifiedNameGapSegment(node) {
    if (!node.hasError) return null;
    const declarator = functionDeclarator(node);
    const qualifiedName = declarator?.childForFieldName('declarator');
    if (qualifiedName?.type !== 'qualified_identifier' || !qualifiedName.hasError) return null;
    const first = qualifiedName.child(0);
    const next = qualifiedName.child(1);
    if (!first || !['namespace_identifier', 'identifier', 'type_identifier'].includes(first.type)) return null;
    if (!next || !((next.type === '::' && next.isMissing) || next.type === 'ERROR')) return null;
    if (RESERVED_TYPE_KEYWORDS.has(first.text)) return null;
    return first;
}

/**
 * fix #379: a declaration whose leading type_identifier is followed by a
 * second type that the grammar folded into the declarator. See the caller.
 */
function twoTypeSpecifierShape(node, typeNode, declaratorNode, code) {
    if (!node.hasError) return false;
    // The declarator the grammar found is the first segment of a qualified
    // or templated type name it could not read (`MACRO std::size_t n() {}`
    // in a member list): the name continues past it in the source.
    if (declaratorNode && PLAIN_NAME_NODES.has(declaratorNode.type) &&
        continuesTypeName(code, declaratorNode)) {
        return true;
    }
    const declarator = functionDeclarator(node);
    const qualifiedName = declarator?.childForFieldName('declarator');
    if (qualifiedName?.type === 'qualified_identifier' && qualifiedName.hasError &&
        qualifiedName.startIndex > typeNode.endIndex) {
        return true;
    }
    if (node.type === 'field_declaration') {
        const bitfield = (node.namedChildren || []).find(child => child.type === 'bitfield_clause');
        const colon = bitfield?.child(0);
        const error = bitfield?.child(1);
        if (colon?.type === ':' && error?.type === 'ERROR' &&
            error.child(0)?.type === ':' &&
            error.child(0).startIndex === colon.endIndex) {
            return true;
        }
    }
    if (declaratorNode?.type === 'qualified_identifier' && !declaratorNode.hasError) {
        const next = declaratorNode.nextSibling;
        if (next?.type === 'ERROR' && next.namedChildCount === 1 &&
            IDENTIFIER_NODES.has(next.namedChild(0).type) &&
            next.startPosition.row === declaratorNode.startPosition.row) {
            return true;
        }
    }
    return false;
}

/**
 * The first token after `node` inside `container` (skipping blanks), or null.
 */
function tokenAfter(container, node, code) {
    const at = skipBlank(code, node.endIndex, 1);
    if (at >= container.endIndex) return null;
    const token = container.descendantForIndex(at, at + 1);
    return token && token.startIndex === at ? token : null;
}

/** The ERROR between a declaration's type and its declarator, or null. */
function displacedErrorOf(node, typeNode, declaratorNode, namedChildren = null) {
    if (!typeNode) return null;
    const declaratorStart = declaratorNode?.startIndex ?? node.endIndex;
    return (namedChildren || node.namedChildren || []).find(child => child.type === 'ERROR' &&
        child.startIndex >= typeNode.endIndex && child.endIndex <= declaratorStart) || null;
}

/** Name of the class whose member list holds `node` (the name as written, template arguments off), or null. */
function classBodyName(node) {
    for (let up = node.parent; up; up = up.parent) {
        if (up.type === 'field_declaration_list') {
            let name = up.parent?.childForFieldName('name');
            while (name?.type === 'qualified_identifier') name = name.childForFieldName('name');
            if (name?.type === 'template_type') name = name.childForFieldName('name');
            return name ? name.text : null;
        }
        if (up.type === 'compound_statement' || up.type === 'translation_unit') return null;
    }
    return null;
}

/** The next specifier after `node` that is not a storage/cv/function keyword. */
function specifierAfter(container, node, code) {
    let token = tokenAfter(container, node, code);
    while (token && NEVER_BLANKED_WORDS.has(token.text) && !BUILTIN_TYPE_WORDS.has(token.text) &&
        !TYPE_INTRODUCER_WORDS.has(token.text)) {
        token = tokenAfter(container, token, code);
    }
    return token;
}

// Keywords that begin a declaration and never follow a type specifier.
const DECLARATION_KEYWORDS = new Set(['template', 'namespace', 'using', 'static_assert']);

// Named nodes a declaration-specifier sequence may hold besides names.
const SPECIFIER_NODES = new Set([
    'type_qualifier', 'storage_class_specifier', 'virtual', 'explicit_function_specifier',
    'attribute_specifier', 'attribute_declaration', 'ms_declspec_modifier', 'comment',
]);

/**
 * fix #387: the specifier tokens the grammar pushed into an ERROR between a
 * declaration's type and its declarator (`X ERROR[Y] declarator`), read in
 * order: the names that may be decoration, and the whole type that ends the
 * sequence (a reserved type word, a qualified or templated name, a
 * class-key), if any. Storage, function and cv specifiers are skipped.
 * `conversion` is set when the ERROR opens with `operator` (a conversion
 * function has no return type). Null when the ERROR holds anything a
 * specifier sequence cannot (a base clause, a declarator, punctuation).
 */
function displacedSpecifiers(error, code) {
    const names = [];
    let type = null;
    let declarator = null;
    for (let i = 0; i < error.childCount; i++) {
        const child = error.child(i);
        const word = /^[A-Za-z_]\w*$/.test(child.type) ? child.text : null;
        if (declarator) return null;
        if (!child.isNamed) {
            if (child.type === 'operator' && !type && names.length === 0) {
                return { names, type, conversion: true, declarator };
            }
            if (word && NEVER_BLANKED_WORDS.has(word) && !BUILTIN_TYPE_WORDS.has(word)) continue;
            return null;
        }
        if (SPECIFIER_NODES.has(child.type)) continue;
        // `API int f(...) TRAILING {`: the whole head, with a trailing
        // macro left for the declarator field.
        if (type && (declaresFunction(child) || child.type.endsWith('_declarator'))) {
            declarator = child;
            continue;
        }
        if (type) return null;
        if (structuralType(child, code)) {
            type = child;
            // `struct foo`, `typename T::x`: the rest is the elaborated type.
            if (TYPE_INTRODUCER_WORDS.has(child.text)) break;
            continue;
        }
        if (!PLAIN_NAME_NODES.has(child.type)) return null;
        if (NEVER_BLANKED_WORDS.has(child.text)) continue;
        names.push(child);
    }
    return { names, type, conversion: false, declarator };
}

/** A dependent type the grammar misread inside a function body (fix
 * #402): within a parse ERROR, or in the parameters of a function
 * definition nested in a block (never valid C++). */
function dependentTypeInBodyError(node) {
    let misread = false;
    for (let current = node.parent; current; current = current.parent) {
        if (current.type === 'ERROR' || current.type === 'function_definition') misread = true;
        else if (current.type === 'compound_statement') return misread;
        else if (current.type === 'field_declaration_list' || current.type === 'translation_unit' ||
            current.type === 'declaration_list') return false;
    }
    return false;
}

function macroTypeRanges(tree, code, evidence = null) {
    const ranges = [];
    const pairs = [];
    const treeHasError = tree.rootNode.hasError;
    // A token a shape proves is decoration (fix #387: never a reserved word,
    // a scope, a template name or a directive line).
    const decoration = token => {
        if (!blankableToken(token, code)) return;
        evidence?.prove(token);
        ranges.push([token.startIndex, token.endIndex]);
    };
    // The grammar took one specifier for the type and pushed the next ones
    // into an ERROR before the declarator (`API int f()`, `API Widget *f()`,
    // `inline Widget API f()`, `(ATTR const T *)x`): with a whole type after
    // it, the type-position token and the names before that type are
    // decoration; with a whole type in the type position, the names are;
    // with two plain names, the pair decides (fix #387).
    // In a parameter the names left over may be its own name (`T name
    // ATTR`), so only a proven type after the type-position token decides.
    const displacedDecoration = (node, typeNode, declaratorNode, displacedError, pairable = true) => {
        const displaced = displacedError ? displacedSpecifiers(displacedError, code) : null;
        if (!displaced || !(displaced.type || displaced.conversion || displaced.names.length > 0)) return false;
        // A name the file proves is a type is never decoration.
        const decorateNames = () => {
            for (const name of displaced.names) {
                if (!evidence?.type(name.text)) decoration(name);
            }
        };
        const typeIsWhole = structuralType(typeNode, code) && !typeNode.hasError;
        if (displaced.type || displaced.conversion) {
            if (!typeIsWhole && !evidence?.type(typeNode.text)) decoration(typeNode);
            decorateNames();
            // A name after a complete declarator is a trailing specifier
            // macro (`... f() SPDLOG_NOEXCEPT {`).
            if (displaced.declarator && PLAIN_NAME_NODES.has(declaratorNode?.type)) decoration(declaratorNode);
        } else if (typeIsWhole) {
            if (pairable) decorateNames();
        } else if (!typeNode.hasError && pairable) {
            pairs.push({ first: typeNode, second: displaced.names[0] });
        } else if (!typeNode.hasError && displaced.names.length === 1 &&
            evidence?.type(displaced.names[0].text) && !evidence.type(typeNode.text)) {
            decoration(typeNode);
        }
        return true;
    };
    traverseTree(tree.rootNode, node => {
        ranges.push(...errorMacroRanges(node, code, pairs, evidence));
        const statementMacro = statementMacroRange(node, code, evidence);
        if (statementMacro) ranges.push(statementMacro);
        // `typename Q::T(args)` as an expression (a functional cast to a
        // dependent type): the grammar has no expression form for it and
        // drops the statement into an ERROR; without the disambiguator it is
        // the same construction, which the grammar reads (fix #402).
        if (treeHasError && node.type === 'dependent_type' && dependentTypeInBodyError(node)) {
            const keyword = node.child(0);
            if (keyword?.type === 'typename') ranges.push([keyword.startIndex, keyword.endIndex]);
            return false;
        }
        const classAttribute = classAttributeShape(node);
        // A name whose definitions (the file's own, or those its include
        // closure supplies) expand to a removable statement fragment
        // (`try`, a complete `catch` handler, nothing) is blanked wherever
        // the grammar left it (fix #396).
        if (treeHasError && (node.type === 'identifier' || node.type === 'type_identifier') &&
            evidence?.defined(node.text) === 'statement') {
            decoration(node);
            return false;
        }
        // A name every definition makes `if` (`#define IF_CONSTEXPR if
        // constexpr` / `if`) followed by a condition: read as `if` (fix #396).
        // The grammar reads `IF (c) { .. }` as a call statement with a
        // missing `;`, whose own subtree is clean.
        const ifName = node.type === 'call_expression' && node.parent?.type === 'expression_statement' &&
            node.parent.hasError ? node.childForFieldName('function') : node;
        if (treeHasError && (ifName?.type === 'identifier' || ifName?.type === 'type_identifier') &&
            code[skipBlank(code, ifName.endIndex, 1)] === '(' && blankableToken(ifName, code) &&
            evidence?.defined(ifName.text) === 'if') {
            ranges.push([ifName.startIndex, ifName.endIndex, 'if']);
            return false;
        }
        const nestedDeclarator = nestedFunctionDeclaratorShape(node);
        if (nestedDeclarator) {
            // The parentheses around the name only keep a function-like
            // macro of that name from expanding: `T name(..)` is the same
            // declaration, and the grammar reads `T (name)(..)` as a call
            // once the decoration is gone.
            ranges.push([nestedDeclarator.open.startIndex, nestedDeclarator.open.endIndex],
                [nestedDeclarator.close.startIndex, nestedDeclarator.close.endIndex]);
            if (RESERVED_TYPE_KEYWORDS.has(nestedDeclarator.returnNode.text)) {
                decoration(nestedDeclarator.typeNode);
            } else {
                pairs.push({ first: nestedDeclarator.typeNode, second: nestedDeclarator.returnNode });
            }
            return true;
        }
        if (!node.hasError && !classAttribute) {
            // In an errored tree a clean subtree cannot hide a recovery
            // candidate. A wholly clean tree still needs one traversal for
            // grammar-valid `class API Name` misparses.
            return treeHasError ? false : true;
        }
        if (TYPE_USE_CONTAINERS.has(node.type)) {
            const useType = node.childForFieldName('type');
            displacedDecoration(node, useType, node.childForFieldName('declarator'),
                displacedErrorOf(node, useType, node.childForFieldName('declarator')),
                node.type === 'type_descriptor');
            return true;
        }
        if (!DECLARATION_NODES.has(node.type)) return true;
        // `static T names[] INIT_MACRO;`: the grammar ends the declaration
        // at a MISSING `;` and reads the macro as a statement of its own. A
        // lone name after a complete declarator is a macro (an initializer
        // or attribute), never code (fix #387).
        const trailing = node.nextNamedSibling;
        if (trailing?.type === 'expression_statement' && trailing.namedChildCount === 1 &&
            trailing.namedChild(0).type === 'identifier' &&
            trailing.startPosition.row === node.endPosition.row &&
            node.childForFieldName('declarator') && hasMissingChild(node)) {
            decoration(trailing.namedChild(0));
        }
        const typeNode = node.childForFieldName('type');
        const declaratorNode = node.childForFieldName('declarator');
        // The type-position name of a declaration the grammar could not read,
        // whose definitions read as declaration specifiers (`API constexpr
        // std::size_t n = ..`, the macro defined in another header): the
        // definition proves it decoration (fix #396).
        if (typeNode?.type === 'type_identifier' && node.hasError &&
            evidence?.defined(typeNode.text) === 'decoration') {
            decoration(typeNode);
            return true;
        }
        // `PREFIX_MACRO(3.8.0, parse(ptr))` before a declaration on the next
        // line reads as the type `PREFIX_MACRO` with a parenthesized
        // declarator holding what no declarator can (literals, commas) and
        // a MISSING `;`: an invocation, blanked whole (fix #387).
        if (typeNode?.type === 'type_identifier' && declaratorNode?.type === 'parenthesized_declarator' &&
            declaratorNode.startIndex === skipBlank(code, typeNode.endIndex, 1) && hasMissingChild(node) &&
            (declaratorNode.namedChildren || []).some(child => child.type === 'ERROR')) {
            const invocation = macroInvocationRange(code, typeNode);
            if (invocation) {
                ranges.push(invocation);
                return true;
            }
        }
        // `RET_MACRO((cond), (T&))` on the line before `name(T& a, U b) {`
        // (fix #396): the grammar reads the invocation as a declaration with
        // a parenthesized declarator and an invented `;`, and the function
        // after it loses its return type. The invocation stands where the
        // return type goes: blanked whole, the definition keeps its name.
        if (typeNode?.type === 'type_identifier' && declaratorNode?.type === 'parenthesized_declarator' &&
            declaratorNode.startIndex === skipBlank(code, typeNode.endIndex, 1) && hasMissingChild(node) &&
            typelessFunctionHeadAfter(node)) {
            const invocation = macroInvocationRange(code, typeNode);
            if (invocation) {
                ranges.push(invocation);
                return true;
            }
        }
        // The same invocation followed by the function head on its own line
        // (`RET_MACRO((cond), (T&)) operator[](T* n) {`): a parenthesized
        // declarator is never followed by another declarator's name, so the
        // invocation is the return type (fix #396).
        if (typeNode?.type === 'type_identifier' && node.hasError &&
            code[skipBlank(code, typeNode.endIndex, 1)] === '(' && onlySpecifiersBefore(node, typeNode)) {
            const invocation = macroInvocationRange(code, typeNode);
            if (invocation && functionHeadAt(code, invocation[1])) {
                ranges.push(invocation);
                return true;
            }
        }
        // `ACCESS_MACRO:` inside a member list parses as a bit-field
        // declaration whose type is the macro and whose declarator is
        // missing.
        const accessMacro = node.type === 'field_declaration' &&
            accessSpecifierMacroRange(code, typeNode);
        if (accessMacro) {
            ranges.push(accessMacro);
            return true;
        }
        // `class API Widget { ... }` is parsed as a malformed function:
        // type=`class API`, declarator=`Widget`, body=`{...}`. The bodyless
        // class-specifier plus a bare declarator cannot be a valid function
        // declaration, so the specifier's name is proven to be a class
        // attribute/visibility macro. Blank only that token; the reparse
        // recovers the real class and all member ownership.
        if (classAttribute) {
            decoration(classAttribute);
            return true;
        }
        // The grammar took one specifier for the type and pushed the next
        // ones into an ERROR before the declarator (`API int f()`, `API
        // Widget *f()`): see displacedDecoration (fix #387).
        const namedChildren = node.namedChildren || [];
        const directErrorNode = namedChildren.find(child => child.type === 'ERROR');
        const displacedError = displacedErrorOf(node, typeNode, declaratorNode, namedChildren);
        if (displacedDecoration(node, typeNode, declaratorNode, displacedError)) return true;
        // Calling-convention/export macro between a return type and function
        // name (`int CJSON_CDECL main(void)`) splits into a missing-;
        // declaration plus a malformed function_definition on the SAME line.
        // After a whole type the declarator identifier is the macro; after a
        // plain name, one of the two is (fix #387).
        const next = node.nextNamedSibling;
        if (typeNode && declaratorNode?.type === 'identifier' &&
            hasMissingChild(node) &&
            next?.type === 'function_definition' &&
            next.startPosition.row === node.startPosition.row) {
            if (structuralType(typeNode, code)) decoration(declaratorNode);
            else pairs.push({ first: typeNode, second: declaratorNode });
            return true;
        }
        // `class API_MACRO Name : public Base<Name>, public Other {`: a
        // bodyless class head followed by an ERROR that starts with the real
        // class name and a base clause colon. A class-key is followed by ONE
        // name, so the first one is an attribute/export macro (fix #379).
        const exportMacro = classHeadMacroName(node, code);
        if (exportMacro) {
            decoration(exportMacro);
            return true;
        }
        // `void MACRO ns::Cls::m()`: the decoration sits between the return
        // type and the qualified name, which the grammar reads as the first
        // scope segment followed by a missing `::` or an ERROR (fix #379).
        const gapSegment = typeNode ? qualifiedNameGapSegment(node) : null;
        // A class body as the "return type" is a class the grammar closed
        // early, its next member read as this declarator: no decoration
        // shape (fix #396: `GenericPointer Append(..)` after a misread
        // member).
        if (gapSegment && typeNode.childForFieldName?.('body') &&
            ['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(typeNode.type)) {
            return true;
        }
        if (gapSegment && !continuesTypeName(code, gapSegment)) {
            // `explicit` marks a constructor or conversion function, which
            // has no return type: the type-position name is decoration.
            if (gapSegment.text === 'explicit') decoration(typeNode);
            else if (structuralType(typeNode, code)) decoration(gapSegment);
            else pairs.push({ first: typeNode, second: gapSegment });
            return true;
        }
        if (!typeNode || typeNode.type !== 'type_identifier') return true;
        // A name before `template`/`namespace`/`using`/`static_assert`
        // begins no declaration of its own: it is a prefix macro
        // (`FMT_EXPORT template <typename T> void f()`, fix #387).
        const followingWord = /^[A-Za-z_]\w*/.exec(code.slice(skipBlank(code, typeNode.endIndex, 1),
            skipBlank(code, typeNode.endIndex, 1) + 16))?.[0];
        if (DECLARATION_KEYWORDS.has(followingWord)) {
            decoration(typeNode);
            return true;
        }
        // A declaration with TWO type specifiers (fix #379): `MACRO
        // std::string Cls::m()` parses the qualified return type into the
        // declarator (a qualified name with a missing `::` or an ERROR), in a
        // member list `MACRO std::size_t n()` becomes the bit-field `std`
        // followed by `::`, and `MACRO ns::T value;` a qualified declarator
        // followed by a stray identifier. None of these is valid C/C++: the
        // second specifier starts at the token after the type, and one of
        // the two is decoration (fix #387: `BOOL WINAPI f()` keeps BOOL).
        if (twoTypeSpecifierShape(node, typeNode, declaratorNode, code)) {
            const second = specifierAfter(node, typeNode, code);
            if (second) pairs.push({ first: typeNode, second });
            return true;
        }
        const identity = declaratorIdentity(functionDeclarator(node));
        // `MACRO Type::Type(...) : Base{...} { ... }` is parsed as a
        // declaration whose initializer consumes the base brace and whose
        // real body becomes a sibling compound_statement. A qualified
        // constructor cannot have a return type, so an all-caps type token is
        // compiler-proven decoration and may be blanked safely.
        const isConstructor = found => {
            const owner = found?.className?.replace(/<.*>$/s, '');
            return !!owner && (found.name === owner || found.name === `~${owner}`);
        };
        // The constructor head may also sit in an ERROR before a member
        // initializer list the grammar read as the declarator
        // (`MACRO Type::Type(...) : member_(...) {`).
        const leading = displacedError?.namedChild(0) || directErrorNode?.namedChild(0);
        // Only a constructor takes a member-initializer list (`f(...) :`).
        const leadingInitializer = leading?.type === 'function_declarator' &&
            leading.nextSibling?.type === ':' && !leading.nextSibling.isNamed;
        const qualifiedConstructorMacro = node.hasError && isMacroToken(typeNode.text) &&
            (isConstructor(identity) || leadingInitializer ||
                (leading?.type === 'function_declarator' && isConstructor(declaratorIdentity(leading))));
        // In its class body a constructor is the member named like the class
        // (`MACRO accessor(OutputIt base) : OutputIt(base) {}`), a destructor
        // the one after `~`: neither has a return type (fix #387).
        const tilde = displacedError?.text.trim() === '~';
        const leadingIdentity = leading?.type === 'function_declarator' ? declaratorIdentity(leading) : null;
        const memberConstructor = node.hasError && [identity, leadingIdentity].some(found =>
            found?.name && !found.className && (tilde || classBodyName(node) === found.name));
        if (qualifiedConstructorMacro || memberConstructor || RESERVED_TYPE_KEYWORDS.has(identity?.name)) {
            decoration(typeNode);
            return true;
        }
        // `MACRO Type name;` with the name pushed into an ERROR after the
        // declarator the grammar chose (`FMT_NO_UNIQUE_ADDRESS locale_ref
        // loc_;`): three names in a row, the first two specifiers.
        const strayName = declaratorNode && PLAIN_NAME_NODES.has(declaratorNode.type) &&
            declaratorNode.nextSibling?.type === 'ERROR' ? declaratorNode.nextSibling : null;
        if (strayName && strayName.namedChildCount === 1 &&
            PLAIN_NAME_NODES.has(strayName.namedChild(0).type) &&
            strayName.startPosition.row === declaratorNode.endPosition.row) {
            pairs.push({ first: typeNode, second: declaratorNode });
            return true;
        }
        // Stacked attribute macros (`A B extern void (*fp)(void *);`) split
        // into a fragment declaration [type_identifier, identifier,
        // MISSING ';'] plus a clean tail — no ERROR node, so the evidence is
        // the missing semicolon on a bare two-identifier fragment. When the
        // tail on the same line has its own type, both fragment names are
        // decoration; otherwise one of them is the type (fix #387).
        const bareFragment = declaratorNode &&
            (declaratorNode.type === 'identifier' || declaratorNode.type === 'field_identifier') &&
            hasMissingChild(node) && namedChildren.every(child =>
                sameNode(child, typeNode) || sameNode(child, declaratorNode) ||
                child.type === 'type_qualifier' || child.type === 'storage_class_specifier');
        if (bareFragment) {
            // The tail's own type must be a type for certain: a reserved or
            // qualified type, or a storage/cv keyword first (C reads
            // `name(void) {` as the type `name` and a parenthesized
            // declarator).
            const tail = node.nextNamedSibling;
            const tailType = tail?.childForFieldName('type');
            const tailTyped = tail && tail.startPosition.row === declaratorNode.endPosition.row &&
                DECLARATION_NODES.has(tail.type) && !!tailType &&
                (structuralType(tailType, code) ||
                    ['storage_class_specifier', 'type_qualifier'].includes(tail.namedChild(0)?.type));
            // `MACRO explicit Name(...)` in a class body: the specifier and
            // the constructor after it have no return type.
            const tailName = tail && !tailType && tail.startPosition.row === declaratorNode.endPosition.row
                ? declaratorIdentity(functionDeclarator(tail))?.name : null;
            const constructorTail = !!tailName && (declaratorNode.text === 'explicit' ||
                (NEVER_BLANKED_WORDS.has(declaratorNode.text) && tailName === classBodyName(node)));
            if (tailTyped || constructorTail) {
                decoration(typeNode);
                evidence?.prove(declaratorNode);
            } else {
                pairs.push({ first: typeNode, second: declaratorNode });
            }
        }
        return true;
    });
    // Pairs are decided after the walk, with every decoration this walk
    // proved in hand.
    for (const { first, second } of pairs) {
        const chosen = decorationOfPair(first, second, code, evidence);
        if (chosen) ranges.push([chosen.startIndex, chosen.endIndex]);
    }
    // A blank a project definition read from another file justified is a
    // use of that definition (fix #396).
    if (evidence?.externalNames.size > 0 && externalMacroContext?.consulted) {
        for (const [start, end] of ranges) {
            const text = code.slice(start, end).trim();
            if (evidence.externalNames.has(text)) externalMacroContext.consulted.add(text);
        }
    }
    return [...new Map(ranges.map(range => [
        `${range[0]}:${range[1]}`, range,
    ])).values()];
}

const parseErrorCounts = new WeakMap();
function countParseErrors(node) {
    // Recovery compares the same immutable trees across several rounds.
    // Clean subtrees contribute nothing; error-bearing nodes retain their
    // count so another comparison does not cross the native boundary again.
    if (!node.hasError && node.type !== 'ERROR') return 0;
    const known = parseErrorCounts.get(node);
    if (known !== undefined) return known;
    let count = node.type === 'ERROR' ? 1 : 0;
    for (const child of node.children) {
        if (child.isMissing) count++;
        else if (child.hasError || child.type === 'ERROR') count += countParseErrors(child);
    }
    parseErrorCounts.set(node, count);
    return count;
}

// original code → blanked code (null = no recovery applies). The extractors
// each re-parse the same file content; the memo makes recovery detection a
// one-time cost per file content.
const RECOVERY_MEMO_MAX = 8;
const recoveryMemo = new Map();
// Whether the selected tree differs from the literal-source parse. A recovered
// tree can be completely error-free, so `tree.rootNode.hasError` alone cannot
// disclose that conditional-compilation or attribute recovery was required.
const recoveryAppliedMemo = new Map();
const recoveryAppliedByTree = new WeakMap();
// A selected conditional tree may be derived from an attribute-normalized
// all-source view.  Keep that byte/line-preserving source with the selected
// native tree so secondary extraction does not reintroduce the declaration
// macros that recovery already proved were syntactic adapters.
const allSourceRecoveryByTree = new WeakMap();
// The source text each selected tree was parsed from (fix #387): the byte
// ranges it blanks are persisted per file, so a query rebuilds the recovered
// tree with one parse instead of replaying recovery.
const selectedSourceByTree = new WeakMap();
// C/C++ usage, test, and consistency queries revisit the same files across
// separate operations. A recovered tree is immutable, so retain a bounded
// content-addressed LRU per grammar instead of reparsing it for every symbol.
// Hash keys avoid retaining a second copy of every source string. The byte
// budget is based on source size (native tree size is not exposed); eviction
// explicitly releases native trees rather than waiting for N-API finalizers.
const TREE_CACHE_MAX_ENTRIES = 128;
const TREE_CACHE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const treeCacheByParser = new WeakMap();
// Secondary all-source AST for a selected conditional tree. Weak keys tie its
// lifetime to the bounded primary-tree LRU, so repeated extractors and agent
// queries pay one additional parse per recovered file instead of one per
// symbol. This is critical for template-heavy C++ headers.
const allSourceTreeBySelected = new WeakMap();
// Replacement-list nodes are opaque leaves in the C grammars. Usage queries
// used to traverse an entire (sometimes 100k-node) header for every requested
// name merely to rediscover the same handful of macro definitions. Trees are
// immutable, so retain the exact AST node set without retaining dead trees.
const macroDefinitionsByTree = new WeakMap();
const macroParamEffectsByDefinition = new WeakMap();
const MACRO_BODY_MEMO_MAX = 4096;
const macroBodyMemo = new Map(); // language + params + replacement list -> { effects, nested }
const directiveDefinitionsByTree = new WeakMap();

function macroDefinitionNodes(tree) {
    const cached = macroDefinitionsByTree.get(tree);
    if (cached) return cached;
    const definitions = [];
    const directives = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type === 'preproc_function_def' || node.type === 'preproc_def') {
            definitions.push(node);
            return false;
        }
        // `#define` where the grammar expects an enumerator/initializer
        // (fix #362); collected in the same walk.
        if (node.type === 'preproc_call') {
            if (node.childForFieldName('directive')?.text.replace(/\s+/g, '') === '#define') {
                directives.push(node);
            }
            return false;
        }
        // A block comment between line continuations derails the grammar:
        // `#define END \ } /* c */ \ }` becomes an ERROR led by the
        // `#define` token. It is still an object-like macro definition.
        if (node.type === 'ERROR' && node.child(0)?.type === '#define' &&
            node.child(1)?.type === 'identifier') {
            definitions.push(node);
            return false;
        }
        return true;
    });
    macroDefinitionsByTree.set(tree, definitions);
    directiveDefinitionsByTree.set(tree, directives);
    return definitions;
}

function directiveDefinitionNodes(tree) {
    if (!directiveDefinitionsByTree.has(tree)) macroDefinitionNodes(tree);
    return directiveDefinitionsByTree.get(tree);
}

function treeCacheKey(code) {
    const key = `${code.length}:${createHash('sha256').update(code).digest('base64url')}`;
    return externalMacroContext ? `${key}:x${externalMacroContext.key}` : key;
}

/**
 * fix #396: definitions of macros the file uses but does not define, from
 * the files its #include closure reaches (the preprocessor's own view of
 * those names), for the recovery of a file the grammar could not read. Set
 * for the duration of one parse: { key, functionMacros: Map name -> defs,
 * objectBodies: Map name -> replacement lists }.
 */
let externalMacroContext = null;

function withExternalMacros(context, fn) {
    const previous = externalMacroContext;
    externalMacroContext = context || null;
    try {
        return fn();
    } finally {
        externalMacroContext = previous;
    }
}

function cachedCFamilyTree(parser, key) {
    const cache = treeCacheByParser.get(parser);
    const entry = cache?.entries.get(key);
    if (!entry) return null;
    cache.entries.delete(key);
    cache.entries.set(key, entry);
    return entry.tree;
}

function cacheCFamilyTree(parser, key, tree, sourceBytes) {
    let cache = treeCacheByParser.get(parser);
    if (!cache) {
        cache = { entries: new Map(), sourceBytes: 0 };
        treeCacheByParser.set(parser, cache);
    }
    const previous = cache.entries.get(key);
    if (previous) {
        cache.sourceBytes -= previous.sourceBytes;
        if (previous.tree !== tree) previous.tree.delete?.();
        cache.entries.delete(key);
    }
    cache.entries.set(key, { tree, sourceBytes });
    cache.sourceBytes += sourceBytes;
    while (cache.entries.size > TREE_CACHE_MAX_ENTRIES ||
        cache.sourceBytes > TREE_CACHE_MAX_SOURCE_BYTES) {
        const oldestKey = cache.entries.keys().next().value;
        const oldest = cache.entries.get(oldestKey);
        cache.entries.delete(oldestKey);
        cache.sourceBytes -= oldest.sourceBytes;
        if (oldest.tree !== tree) oldest.tree.delete?.();
    }
}

function releaseCFamilyTree(parser, code, tree) {
    const cache = treeCacheByParser.get(parser);
    if (cache) {
        const key = treeCacheKey(code);
        const entry = cache.entries.get(key);
        if (entry?.tree === tree) {
            cache.entries.delete(key);
            cache.sourceBytes -= entry.sourceBytes;
        }
    }
    const allSource = allSourceTreeBySelected.get(tree);
    allSourceTreeBySelected.delete(tree);
    // Build workers are short-lived and terminate immediately after handing
    // immutable IR back to the parent. Dropping ownership here lets their
    // isolate reclaim all native trees in one teardown; eagerly walking and
    // deleting every tree serialized worker completion and cost >10% cold
    // throughput on fmt. The main process is long-lived, so direct/sequential
    // indexing still releases native memory deterministically.
    if (isMainThread) {
        allSource?.delete?.();
        tree?.delete?.();
    }
}

function blankLine(line) {
    return line.replace(/[^\r\n]/g, ' ');
}

function preprocessorDefine(line) {
    const match = String(line).match(/^\s*#\s*define\s+([A-Za-z_]\w*)(?![\w(])/);
    return match ? match[1] : null;
}

function preprocessorDirective(line) {
    const content = line.replace(/[\r\n]+$/, '');
    const match = content.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
    if (!match) return null;
    let condition = match[2].trim();
    const defined = condition.match(/^defined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))$/);
    if (defined) condition = defined[1] || defined[2];
    return { kind: match[1], condition };
}

/**
 * Produce a bounded set of coherent preprocessor configurations while
 * preserving every byte and line offset. Tree-sitter models directives but
 * cannot represent braces whose opening and closing tokens live in separate
 * `#ifdef` regions. Parsing one concrete configuration is the same structural
 * view a compiler gets after preprocessing; trying several configurations
 * avoids silently swallowing the declarations that follow the malformed
 * region. This is syntax recovery, not a text-based symbol extractor.
 *
 * The search is bounded twice: by how many feature keys may vary (below), and
 * by source size. Each configuration is a whole-file reparse, so the sweep
 * costs O(configurations x file size) in simultaneously-live native ASTs.
 * tree-sitter 0.21 does not expose Tree#delete, which means a synchronous
 * build cannot reclaim those trees until V8 runs their finalizers. Large
 * amalgamated/generated sources are therefore kept on the literal AST view;
 * unlike ordinary translation units, sweeping them multiplies memory without
 * a reliable way to release it during the build.
 */
const CONDITIONAL_RECOVERY_MAX_BYTES = 256 * 1024;

function conditionalRecoverySources(code) {
    if (Buffer.byteLength(code) > CONDITIONAL_RECOVERY_MAX_BYTES) return [];
    const lines = code.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
    const directives = lines.map(preprocessorDirective);
    const keys = [];
    // `#ifndef NAME` immediately followed by `#define NAME` (include guards
    // and default-definition idioms) defines NAME itself: on the first
    // inclusion, the one a compiler parses, NAME is undefined. Varying it
    // would select the configuration in which the whole guarded body is
    // skipped, which trivially has zero syntax errors.
    const selfDefined = new Set();
    for (let index = 0; index < directives.length; index++) {
        const directive = directives[index];
        if (directive?.kind !== 'ifndef' || !directive.condition) continue;
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        const define = preprocessorDefine(lines[next] || '');
        if (define === directive.condition) selfDefined.add(define);
    }
    for (const directive of directives) {
        if (!directive || !['if', 'ifdef', 'ifndef', 'elif'].includes(directive.kind)) {
            continue;
        }
        const condition = directive.condition;
        if (!condition || condition === '0' || condition === '1') continue;
        if (selfDefined.has(condition)) continue;
        if (!keys.includes(condition)) keys.push(condition);
    }
    if (!directives.some(Boolean)) return [];

    const assignments = [];
    const addAssignment = values => {
        const key = keys.map(name => values.get(name) ? '1' : '0').join('');
        if (!assignments.some(entry => entry.key === key)) {
            assignments.push({ key, values });
        }
    };
    addAssignment(new Map(keys.map(key => [key, true])));
    addAssignment(new Map(keys.map(key => [key, false])));
    // Mixed configurations matter when two independent feature gates jointly
    // shape a declaration. Bound the search so pathological generated headers
    // do not create exponential parse work.
    for (const key of keys.slice(0, 6)) {
        addAssignment(new Map(keys.map(name => [name, name === key])));
        addAssignment(new Map(keys.map(name => [name, name !== key])));
    }

    const evaluate = (condition, values) => {
        if (condition === '0') return false;
        if (condition === '1') return true;
        if (selfDefined.has(condition)) return false;
        return values.get(condition) ?? true;
    };
    const sources = [];
    for (const { values } of assignments) {
        const stack = [];
        let active = true;
        const selected = [];
        let valid = true;
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const directive = directives[index];
            if (!directive) {
                selected.push(active ? line : blankLine(line));
                continue;
            }
            selected.push(blankLine(line));
            if (directive.kind === 'if' || directive.kind === 'ifdef' ||
                directive.kind === 'ifndef') {
                let branch = evaluate(directive.condition, values);
                if (directive.kind === 'ifndef') branch = !branch;
                const frame = {
                    parentActive: active,
                    branchTaken: branch,
                };
                stack.push(frame);
                active = frame.parentActive && branch;
            } else if (directive.kind === 'elif') {
                const frame = stack[stack.length - 1];
                if (!frame) { valid = false; break; }
                const branch = !frame.branchTaken &&
                    evaluate(directive.condition, values);
                frame.branchTaken ||= branch;
                active = frame.parentActive && branch;
            } else if (directive.kind === 'else') {
                const frame = stack[stack.length - 1];
                if (!frame) { valid = false; break; }
                const branch = !frame.branchTaken;
                frame.branchTaken = true;
                active = frame.parentActive && branch;
            } else {
                const frame = stack.pop();
                if (!frame) { valid = false; break; }
                active = frame.parentActive;
            }
        }
        if (!valid || stack.length > 0) continue;
        const source = selected.join('');
        if (!sources.includes(source)) sources.push(source);
    }
    return sources;
}

const CALL_SHAPE = /[A-Za-z_]\w*\s*\(/g;
const DIRECTIVE_TOKEN_TYPES = new Set([
    '#if', '#ifdef', '#ifndef', '#elif', '#elifdef', '#elifndef', '#else', '#endif',
]);

/**
 * fix #391: the source with the preprocessor conditionals the grammar could
 * not place resolved, or null. tree-sitter models a conditional as a node
 * that wraps whole declarations or statements; one that splits a construct
 * (`: base(o) #if X , extra(o) #endif {` in a member-initializer list, an
 * operand of an expression, a template argument) leaves its directive
 * tokens inside ERROR nodes and can derail the rest of the file. Each such
 * conditional is read in one configuration: its directive lines are blanked
 * and, when it has several branches, every branch but the one holding the
 * most call sites is blanked with them (the richest call view, as the sweep
 * prefers; the first on ties). Line breaks are kept, so every row keeps its
 * number. Only the conditionals the grammar could not place change; every
 * other line reads as before.
 */
function misplacedDirectiveRepair(tree, source) {
    const misplaced = new Set();
    const visit = node => {
        const error = node.type === 'ERROR';
        for (const child of node.children) {
            if (error && DIRECTIVE_TOKEN_TYPES.has(child.type)) misplaced.add(child.startPosition.row);
            if (child.hasError) visit(child);
        }
    };
    visit(tree.rootNode);
    const lines = source.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
    // A branch whose `{` and `}` tokens do not balance splits a block across
    // conditionals (`#ifdef X else { #endif ... #ifdef X } #endif`, fix
    // #393): the grammar reads it as a block that swallows the declarations
    // after it, with no ERROR near the directives.
    const braceBalance = (from, to) => {
        // Program tokens only: directive lines (a `#define` replacement
        // list, with its continuation lines) are not.
        const kept = [];
        for (let row = from; row < to; row++) {
            if (/^\s*#/.test(lines[row])) {
                while (row + 1 < to && /\\[ \t]*\r?\n?$/.test(lines[row])) row++;
                continue;
            }
            kept.push(lines[row]);
        }
        const text = kept.join('');
        let balance = 0;
        for (let index = 0; index < text.length; index++) {
            const skipped = skipLexicalRegion(text, index);
            if (skipped != null) {
                index = skipped - 1;
                continue;
            }
            if (text[index] === '{') balance++;
            else if (text[index] === '}') balance--;
        }
        return balance;
    };
    // Directive line spans (a directive continues over backslash-newlines).
    const directiveEnd = new Map();
    const directives = [];
    for (let row = 0; row < lines.length; row++) {
        const directive = preprocessorDirective(lines[row]);
        if (!directive) continue;
        let end = row;
        while (end + 1 < lines.length && /\\[ \t]*\r?\n?$/.test(lines[end])) end++;
        directiveEnd.set(row, end);
        directives.push({ row, kind: directive.kind });
    }
    const blank = new Set();
    const stack = [];
    for (const directive of directives) {
        if (directive.kind === 'if' || directive.kind === 'ifdef' || directive.kind === 'ifndef') {
            stack.push({ branches: [directive.row] });
        } else if (directive.kind === 'elif' || directive.kind === 'else') {
            stack[stack.length - 1]?.branches.push(directive.row);
        } else if (directive.kind === 'endif') {
            const group = stack.pop();
            if (!group) return null;
            const rows = [...group.branches, directive.row];
            if (!rows.some(row => misplaced.has(row))) {
                const edges = [...group.branches, directive.row];
                let split = false;
                for (let b = 0; b < group.branches.length && !split; b++) {
                    split = braceBalance(edges[b] + 1, edges[b + 1]) !== 0;
                }
                if (!split) continue;
            }
            for (const row of rows) {
                for (let line = row; line <= directiveEnd.get(row); line++) blank.add(line);
            }
            // One branch stays: the one holding the most call sites (the
            // richest call view, as the sweep prefers), the first on ties.
            if (group.branches.length > 1) {
                const bounds = [...group.branches, directive.row];
                let keep = 0;
                let keepCalls = -1;
                for (let b = 0; b < group.branches.length; b++) {
                    let calls = 0;
                    for (let line = bounds[b] + 1; line < bounds[b + 1]; line++) {
                        if (!directiveEnd.has(line)) calls += (lines[line].match(CALL_SHAPE) || []).length;
                    }
                    if (calls > keepCalls) {
                        keep = b;
                        keepCalls = calls;
                    }
                }
                for (let b = 0; b < group.branches.length; b++) {
                    if (b === keep) continue;
                    for (let line = bounds[b]; line < bounds[b + 1]; line++) blank.add(line);
                }
            }
        }
    }
    if (stack.length > 0 || blank.size === 0) return null;
    return lines.map((line, row) => (blank.has(row) ? blankLine(line) : line)).join('');
}

const STRUCTURE_SCORE_TYPES = [
    'function_definition', 'class_specifier', 'struct_specifier',
    'union_specifier', 'enum_specifier', 'type_definition', 'call_expression',
];

function treeStructureScore(tree) {
    // `descendantsOfType` performs the filtering in tree-sitter's native
    // cursor. Recovery can score the same large source under as many as 14
    // bounded preprocessor views; walking every node through the JS bridge
    // made scoring alone a material part of cold C/C++ build CPU. The native
    // query returns the exact same node sets and therefore preserves the
    // recovery ordering contract while avoiding thousands of wrapper calls.
    // One native walk for both kinds (fix #385; the two were walked apart).
    let declarations = 0;
    let calls = 0;
    for (const node of tree.rootNode.descendantsOfType(STRUCTURE_SCORE_TYPES)) {
        if (node.type === 'call_expression') calls++;
        else declarations++;
    }
    return declarations * 1000 + calls;
}

/**
 * Decide conditional regions whose condition the LANGUAGE defines, before any
 * recovery: `__cplusplus` is defined in every C++ translation unit and in no
 * C translation unit. Only `#ifdef/#ifndef/#if defined(__cplusplus)` blocks
 * without `#elif` are decided; their directive lines and inactive branch are
 * blanked byte-for-byte, every other conditional stays untouched.
 */
function languageConditionalLayout(code, mode) {
    if (!code.includes('__cplusplus') || (mode !== 'c' && mode !== 'cpp')) return null;
    const lines = code.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
    const frames = [];
    const stack = [];
    for (let index = 0; index < lines.length; index++) {
        const directive = preprocessorDirective(lines[index]);
        if (!directive) continue;
        if (['if', 'ifdef', 'ifndef'].includes(directive.kind)) {
            const frame = { opener: index, directive, branches: [index], elif: false };
            stack.push(frame);
            frames.push(frame);
        } else if (directive.kind === 'elif' || directive.kind === 'else') {
            const frame = stack[stack.length - 1];
            if (!frame) return null;
            if (directive.kind === 'elif') frame.elif = true;
            frame.branches.push(index);
        } else {
            const frame = stack.pop();
            if (!frame) return null;
            frame.end = index;
        }
    }
    if (stack.length > 0) return null;
    const defined = mode === 'cpp';
    const directiveLines = new Set();
    const inactiveLines = new Set();
    for (const frame of frames) {
        const { kind, condition } = frame.directive;
        if (condition !== '__cplusplus' || frame.elif) continue;
        const firstTaken = kind === 'ifndef' ? !defined : defined;
        const boundaries = [...frame.branches, frame.end];
        for (let branch = 0; branch < boundaries.length - 1; branch++) {
            const active = branch === 0 ? firstTaken : !firstTaken;
            directiveLines.add(boundaries[branch]);
            if (!active) {
                for (let line = boundaries[branch] + 1; line < boundaries[branch + 1]; line++) {
                    inactiveLines.add(line);
                }
            }
        }
        directiveLines.add(frame.end);
    }
    if (directiveLines.size === 0) return null;
    return { lines, directiveLines, inactiveLines };
}

function languagePinnedSource(code, mode) {
    const layout = languageConditionalLayout(code, mode);
    if (!layout) return code;
    const { lines, directiveLines, inactiveLines } = layout;
    return lines.map((line, index) => directiveLines.has(index) || inactiveLines.has(index)
        ? blankLine(line) : line).join('');
}

/**
 * fix #367b: the other language's view of a header's `__cplusplus` blocks.
 * A C-indexed header can carry C++-only declarations (`#ifdef __cplusplus`
 * inline overloads) and a C++-indexed header C-only ones; the pinned parse
 * drops them. Returns the source with ONLY those branch lines kept (every
 * other byte blanked, offsets preserved) and the language that sees them, or
 * null when the branches hold nothing but linkage braces (`extern "C" {`).
 */
function otherLanguageBranchSource(code, mode) {
    const layout = languageConditionalLayout(code, mode);
    if (!layout || layout.inactiveLines.size === 0) return null;
    const { lines, inactiveLines } = layout;
    let substantive = false;
    for (const index of inactiveLines) {
        const text = lines[index].trim();
        if (!text || text === '}' || text.startsWith('//') || text.startsWith('#') ||
            /^extern\s+"C(?:\+\+)?"\s*\{?$/.test(text) || text === '{') continue;
        substantive = true;
        break;
    }
    if (!substantive) return null;
    return {
        language: mode === 'c' ? 'cpp' : 'c',
        source: lines.map((line, index) => inactiveLines.has(index) ? line : blankLine(line)).join(''),
    };
}

// fix #385: code -> misread same-file macro invocations (bounded with
// recoveryMemo), and the invocations each selected/all-source tree carries.
const invocationMemo = new Map();
const macroInvocationsByTree = new WeakMap();

function blankPreservingLines(text) {
    return text.replace(/[^\r\n]/g, ' ');
}

const KNOWN_MACRO_ROUNDS = 3;

/**
 * Parse `source` and blank the invocations of the file's own function-like
 * macros that the grammar read as declarations (c-macro-invocations.js),
 * before any other recovery: the preprocessor's view of those lines. Kept
 * only when the blanked source parses with fewer syntax errors (or a clean
 * tree stays clean). Recovering one invocation can expose the next
 * (statements the grammar had swallowed into a broken declaration become
 * statements again), so a few rounds run. Returns { source, tree,
 * invocations }; `blank` stays set only on invocations the source blanks.
 */
function knownMacroInvocationRecovery(parser, source) {
    let tree = safeParse(parser, source, undefined, PARSE_OPTIONS);
    const own = directiveFunctionMacros(source);
    // The project's attribute and return-type macros matter only where the
    // grammar failed (fix #396).
    const macros = tree.rootNode.hasError ? withExternalFunctionMacros(own) : own;
    if (!macros) return { source, tree, invocations: [] };
    let current = source;
    const kept = new Map();
    for (let round = 0; round < KNOWN_MACRO_ROUNDS; round++) {
        const found = misreadMacroInvocations(tree, current, macros, parser)
            .filter(invocation => !kept.has(invocation.start) || !kept.get(invocation.start).blank);
        for (const invocation of found) kept.set(invocation.start, invocation);
        const blanks = found.filter(invocation => invocation.blank);
        if (blanks.length === 0) break;
        const pieces = [];
        let at = 0;
        for (const invocation of [...blanks].sort((a, b) => a.blank[0] - b.blank[0])) {
            const [start, end] = invocation.blank;
            if (start < at) continue;
            pieces.push(current.slice(at, start), blankPreservingLines(current.slice(start, end)));
            at = end;
        }
        pieces.push(current.slice(at));
        const blanked = pieces.join('');
        const candidate = safeParse(parser, blanked, undefined, PARSE_OPTIONS);
        const before = countParseErrors(tree.rootNode);
        const after = countParseErrors(candidate.rootNode);
        if (after > before || (after === before && before > 0)) {
            candidate.delete?.();
            for (const invocation of blanks) kept.set(invocation.start, { ...invocation, blank: null });
            break;
        }
        tree.delete?.();
        tree = candidate;
        current = blanked;
    }
    const invocations = [...kept.values()].sort((a, b) => a.start - b.start);
    if (externalMacroContext?.consulted) {
        for (const invocation of invocations) {
            if (invocation.blank && !own?.defs.has(invocation.name) &&
                externalMacroContext.functionMacros?.has(invocation.name)) {
                externalMacroContext.consulted.add(invocation.name);
            }
        }
    }
    return { source: current, tree, invocations };
}

// The file's own function-like macros plus the external ones it does not
// define itself, in effect from its first line (fix #396).
function withExternalFunctionMacros(macros) {
    const external = externalMacroContext?.functionMacros;
    if (!external || external.size === 0) return macros;
    const merged = macros || { defs: new Map(), undefs: new Map() };
    const defs = new Map(merged.defs);
    for (const [name, templates] of external) {
        if (defs.has(name)) continue;
        defs.set(name, templates.map(template => ({ name, line: 0, endLine: 0, ...template })));
    }
    return { defs, undefs: merged.undefs };
}

function parseTree(parser, code) {
    const cacheKey = treeCacheKey(code);
    const cached = cachedCFamilyTree(parser, cacheKey);
    if (cached) return cached;
    // Language-defined conditions (`__cplusplus`) are decided before any
    // recovery: a C translation unit never sees `extern "C" {`.
    const pinnedSource = languagePinnedSource(code, parser.getLanguage?.()?.name);
    // A parse with external macro definitions is a one-off view of the file
    // (fix #396): the content-keyed memos describe the plain recovery.
    const useMemo = !externalMacroContext;
    if (useMemo && recoveryMemo.has(code) && !recoveryAppliedMemo.get(code)) {
        const blanked = recoveryMemo.get(code);
        const selected = safeParse(parser, blanked === null ? pinnedSource : blanked,
            undefined, PARSE_OPTIONS);
        selectedSourceByTree.set(selected, blanked === null ? pinnedSource : blanked);
        allSourceRecoveryByTree.set(selected, null);
        recoveryAppliedByTree.set(selected, selected.rootNode.hasError);
        const invocations = invocationMemo.get(code);
        if (invocations) macroInvocationsByTree.set(selected, invocations);
        cacheCFamilyTree(parser, cacheKey, selected, Buffer.byteLength(code));
        return selected;
    }
    // Invocations of the file's own function-like macros that the grammar
    // read as declarations are the preprocessor's view before any other
    // recovery (fix #385).
    const known = knownMacroInvocationRecovery(parser, pinnedSource);
    const source = known.source;
    const tree = known.tree;
    const knownSource = source !== pinnedSource ? source : null;
    const knownInvocations = known.invocations;
    const rememberInvocations = selectedTree => {
        if (knownInvocations.length > 0) {
            if (useMemo) invocationMemo.set(code, knownInvocations);
            macroInvocationsByTree.set(selectedTree, knownInvocations);
        } else if (useMemo) {
            invocationMemo.delete(code);
        }
    };
    // What the file proves about names recovery may blank (fix #387): read
    // from this first tree, whose token offsets every later round keeps.
    const evidence = new DecorationEvidence(parser, source, tree);
    const initialRanges = macroTypeRanges(tree, source, evidence);
    if (!tree.rootNode.hasError && initialRanges.length === 0) {
        if (useMemo) {
            recoveryMemo.set(code, knownSource);
            recoveryAppliedMemo.set(code, false);
        }
        allSourceRecoveryByTree.set(tree, null);
        recoveryAppliedByTree.set(tree, false);
        rememberInvocations(tree);
        selectedSourceByTree.set(tree, source);
        if (useMemo && recoveryMemo.size > RECOVERY_MEMO_MAX) {
            const oldest = recoveryMemo.keys().next().value;
            recoveryMemo.delete(oldest);
            recoveryAppliedMemo.delete(oldest);
            invocationMemo.delete(oldest);
        }
        cacheCFamilyTree(parser, cacheKey, tree, Buffer.byteLength(code));
        return tree;
    }
    // Non-worsening rounds may continue (blanking a stacked macro can turn a
    // MISSING token into an ERROR before the next round clears it), but a
    // recovery is only ACCEPTED when it strictly improved on the original.
    let current = source;
    let workingTree = tree;
    let best = null;
    let bestCode = null;
    let bestErrors = countParseErrors(tree.rootNode);
    const originalHasError = tree.rootNode.hasError;
    const liveTrees = new Set([tree]);
    const releaseTree = candidate => {
        if (!candidate || !liveTrees.has(candidate)) return;
        liveTrees.delete(candidate);
        candidate.delete?.();
    };
    // Misreads a damage hid (fix #396): once a configuration or a directive
    // repair restores the structure around them, the decoration rules and
    // the misread-invocation shapes see them. One round, kept when it lowers
    // the error count.
    const exposedMisreadRound = (roundTree, roundSource, roundErrors) => {
        const own = directiveFunctionMacros(roundSource);
        const misread = misreadMacroInvocations(roundTree, roundSource,
            withExternalFunctionMacros(own), parser).filter(invocation => invocation.blank);
        const ranges = [
            ...macroTypeRanges(roundTree, roundSource, evidence),
            ...misread.map(invocation => invocation.blank),
        ].sort((a, b) => a[0] - b[0])
            .filter((range, i, all) => i === 0 || range[0] >= all[i - 1][1]);
        if (ranges.length === 0) return null;
        let next = roundSource;
        for (const [start, end, replacement] of ranges) {
            next = next.slice(0, start) + recoveryReplacement(next.slice(start, end), replacement) + next.slice(end);
        }
        const decorated = safeParse(parser, next, undefined, PARSE_OPTIONS);
        liveTrees.add(decorated);
        const errors = countParseErrors(decorated.rootNode);
        if (errors >= roundErrors) {
            releaseTree(decorated);
            return null;
        }
        for (const invocation of misread) {
            if (!own?.defs.has(invocation.name) && externalMacroContext?.functionMacros?.has(invocation.name)) {
                externalMacroContext.consulted?.add(invocation.name);
            }
        }
        return { tree: decorated, source: next, errors };
    };
    // A source too large for the configuration sweep gets the conditionals
    // the grammar could not place resolved (fix #391). The repair reads the
    // tree the first decoration round produced and rides on the second
    // round's parse (row numbers are kept by both); it takes a parse of its
    // own only when that round is refused with it, or when there is none.
    const largeSource = originalHasError &&
        Buffer.byteLength(source) > CONDITIONAL_RECOVERY_MAX_BYTES;
    let repairFolded = false;
    let foldRepair = largeSource;
    for (let attempt = 0; attempt < 8; attempt++) {
        const ranges = attempt === 0
            ? initialRanges : macroTypeRanges(workingTree, current, evidence);
        if (ranges.length === 0) break;
        let next = current;
        for (const [start, end, replacement] of ranges) {
            // Line breaks inside a blanked range stay (a multi-line
            // invocation): every later row keeps its number (fix #387).
            next = next.slice(0, start) + recoveryReplacement(next.slice(start, end), replacement) + next.slice(end);
        }
        let foldedHere = false;
        if (attempt === 1 && foldRepair) {
            const repaired = misplacedDirectiveRepair(workingTree, next);
            if (repaired) {
                next = repaired;
                foldedHere = true;
            }
        }
        const candidate = safeParse(parser, next, undefined, PARSE_OPTIONS);
        liveTrees.add(candidate);
        const errors = countParseErrors(candidate.rootNode);
        if (errors > bestErrors) {
            releaseTree(candidate);
            if (foldedHere) {
                // Refused with the repair: the round again without it.
                foldRepair = false;
                attempt -= 1;
                continue;
            }
            break;
        }
        if (foldedHere) repairFolded = true;
        const previousWorking = workingTree;
        current = next;
        workingTree = candidate;
        if (errors < bestErrors ||
            (!originalHasError && attempt === 0 &&
             errors === bestErrors)) {
            const previousBest = best;
            best = candidate;
            bestCode = next;
            bestErrors = errors;
            if (previousBest && previousBest !== tree) {
                releaseTree(previousBest);
            }
        }
        if (previousWorking !== tree && previousWorking !== best) {
            releaseTree(previousWorking);
        }
        if (!candidate.rootNode.hasError) break;
    }
    if (workingTree !== tree && workingTree !== best) releaseTree(workingTree);
    const attributeSelected = best || tree;
    const attributeSource = bestCode || source;
    let selectedErrors = countParseErrors(attributeSelected.rootNode);
    let selectedScore = null;
    let conditionalApplied = false;
    // Conditional branches may contain matching braces separated across two
    // directives. Parse coherent feature configurations and prefer fewer
    // syntax errors, then the richest declaration/call view.
    if (attributeSelected.rootNode.hasError) {
        for (const candidateSource of conditionalRecoverySources(attributeSource)) {
            const candidate = safeParse(parser, candidateSource, undefined, PARSE_OPTIONS);
            liveTrees.add(candidate);
            const errors = countParseErrors(candidate.rootNode);
            let score = null;
            // A configuration whose whole translation unit still fails to
            // parse (the root itself is an ERROR node) has not recovered any
            // structure; its lower error count only reflects swallowed text.
            let improves = candidate.rootNode.type !== 'ERROR' && errors < selectedErrors;
            if (errors === selectedErrors) {
                if (selectedScore == null) {
                    selectedScore = treeStructureScore(best || attributeSelected);
                }
                score = treeStructureScore(candidate);
                improves = score > selectedScore;
            }
            if (improves) {
                const previousBest = best;
                best = candidate;
                bestCode = candidateSource;
                selectedErrors = errors;
                // A strictly lower error count resets the tie baseline; defer
                // its structural walk until a later equal-error candidate.
                selectedScore = score;
                conditionalApplied = true;
                // The attribute-normalized tree is the all-source view a
                // selected configuration keeps (literalRecoveryTree): the
                // same source, already parsed.
                if (previousBest && previousBest !== tree && previousBest !== attributeSelected) {
                    releaseTree(previousBest);
                }
            } else {
                releaseTree(candidate);
            }
        }
        // The large-source repair when it did not ride on a decoration
        // round (fix #391): one parse, kept when it lowers the error count.
        // A selected configuration that still holds damage (fix #396).
        if (conditionalApplied && best && best.rootNode.hasError && !largeSource) {
            const round = exposedMisreadRound(best, bestCode, selectedErrors);
            if (round) {
                releaseTree(best);
                best = round.tree;
                bestCode = round.source;
                selectedErrors = round.errors;
            }
        }
        // A smaller file whose configurations all keep the damage (fix
        // #396: a conditional that splits a block's braces beside a macro
        // misread elsewhere) gets the same repair, then one more decoration
        // round over the repaired tree, which exposes misreads the damage hid.
        if (!conditionalApplied && !(repairFolded && best) &&
            (largeSource || attributeSelected.rootNode.hasError)) {
            const repairedSource = misplacedDirectiveRepair(attributeSelected, attributeSource);
            if (repairedSource) {
                let candidate = safeParse(parser, repairedSource, undefined, PARSE_OPTIONS);
                liveTrees.add(candidate);
                let candidateSource = repairedSource;
                let candidateErrors = countParseErrors(candidate.rootNode);
                if (!largeSource && candidate.rootNode.hasError) {
                    const round = exposedMisreadRound(candidate, candidateSource, candidateErrors);
                    if (round) {
                        releaseTree(candidate);
                        candidate = round.tree;
                        candidateSource = round.source;
                        candidateErrors = round.errors;
                    }
                }
                if (candidateErrors < selectedErrors) {
                    best = candidate;
                    bestCode = candidateSource;
                } else {
                    releaseTree(candidate);
                }
            }
        }
    }
    if (useMemo) {
        recoveryMemo.set(code, best ? bestCode : knownSource);
        // Deterministic attribute/visibility macro normalization is treated
        // like ordinary parser adaptation once it yields a clean tree.
        // Conditional configuration selection is inherently partial and
        // must remain visible.
        recoveryAppliedMemo.set(code, conditionalApplied);
    }
    if (useMemo && recoveryMemo.size > RECOVERY_MEMO_MAX) {
        const oldest = recoveryMemo.keys().next().value;
        recoveryMemo.delete(oldest);
        recoveryAppliedMemo.delete(oldest);
        invocationMemo.delete(oldest);
    }
    const selected = best || tree;
    rememberInvocations(selected);
    selectedSourceByTree.set(selected, best ? bestCode : source);
    allSourceRecoveryByTree.set(
        selected,
        conditionalApplied && attributeSource !== code ? attributeSource :
            conditionalApplied ? source : null,
    );
    recoveryAppliedByTree.set(
        selected,
        conditionalApplied || selected.rootNode.hasError,
    );
    // The all-source view of a selected configuration is the attribute-
    // normalized source (see allSourceRecoveryByTree above), whose tree was
    // parsed before the configuration sweep: keep it instead of parsing the
    // same text again (fix #385).
    const allSourceTree = conditionalApplied && selected !== attributeSelected
        ? attributeSelected : null;
    if (allSourceTree) {
        allSourceTreeBySelected.set(selected, allSourceTree);
        if (knownInvocations.length > 0) macroInvocationsByTree.set(allSourceTree, knownInvocations);
    }
    for (const parsed of liveTrees) {
        if (parsed !== selected && parsed !== allSourceTree) releaseTree(parsed);
    }
    cacheCFamilyTree(parser, cacheKey, selected, Buffer.byteLength(code));
    return selected;
}

/**
 * Syntax-error recovery regions plus, for a class body the grammar closed
 * early (fix #379), the declarations between that class and the stray `}`
 * that really closes it: members there were parsed as free functions and
 * lost their class, so their lines are disclosed as recovered.
 */
function cFamilyErrorRegions(rootNode) {
    const regions = parseErrorRegions(rootNode);
    const escaped = [];
    const scan = container => {
        const count = container.childCount;
        for (let i = 0; i < count; i++) {
            const child = container.child(i);
            if (!child.hasError) continue;
            if (child.type === 'namespace_definition') {
                const body = child.childForFieldName('body');
                if (body) scan(body);
                continue;
            }
            const damagedClass = child.descendantsOfType(['class_specifier', 'struct_specifier'])
                .some(cls => cls.childForFieldName('body')?.hasError);
            if (!damagedClass) continue;
            for (let j = i + 1; j < count && j <= i + 2000; j++) {
                const next = container.child(j);
                if (next.type === 'ERROR' && next.child(0)?.type === '}') {
                    escaped.push([child.startPosition.row + 1, next.startPosition.row + 1]);
                    break;
                }
            }
        }
    };
    scan(rootNode);
    if (escaped.length === 0) return regions;
    const all = [...regions, ...escaped].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const region of all) {
        const last = merged[merged.length - 1];
        if (last && region[0] <= last[1]) last[1] = Math.max(last[1], region[1]);
        else merged.push([...region]);
    }
    return merged;
}

/**
 * The ranges of `code` a recovery blanked in `recovered` (same length, line
 * breaks kept), merged across whitespace: [[start, end], ...].
 */
function recoveryBlanksOf(code, recovered) {
    const blanks = [];
    if (recovered == null || recovered === code || recovered.length !== code.length) return blanks;
    let open = -1;
    let last = -1;
    for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === recovered.charCodeAt(i)) continue;
        if (open >= 0 && /^[ \t\r\n]*$/.test(code.slice(last + 1, i))) {
            last = i;
            continue;
        }
        if (open >= 0) blanks.push(recoveryRange(recovered, open, last + 1));
        open = i;
        last = i;
    }
    if (open >= 0) blanks.push(recoveryRange(recovered, open, last + 1));
    return blanks;
}

// The text a recovery range becomes: blanks keeping line breaks, or a
// keyword padded to the range's length (fix #396).
function recoveryReplacement(text, replacement) {
    if (typeof replacement !== 'string' || replacement.length > text.length || text.includes('\n')) {
        return blankPreservingLines(text);
    }
    return replacement.padEnd(text.length, ' ');
}

// A range the recovery changed: blanked, or (fix #396) holding a keyword a
// statement macro stands for (`IF_MACRO (c)` read as `if (c)`), kept as
// the replacement text of the same length.
function recoveryRange(recovered, start, end) {
    const text = recovered.slice(start, end);
    return /\S/.test(text) ? [start, end, text] : [start, end];
}

/**
 * The tree a recovery selects for `code`, rebuilt from its persisted blank
 * ranges with one parse (null when the recovery changed nothing: the literal
 * tree is the recovered tree). Kept in the tree cache per content.
 */
function treeFromRecoveryBlanks(parser, code, blanks) {
    if (blanks.length === 0) return null;
    const cacheKey = `blanks:${treeCacheKey(code)}`;
    const cached = cachedCFamilyTree(parser, cacheKey);
    if (cached) return cached;
    let source = '';
    let at = 0;
    for (const [start, end, text] of blanks) {
        source += code.slice(at, start) +
            (typeof text === 'string' && text.length === end - start ? text : blankPreservingLines(code.slice(start, end)));
        at = end;
    }
    source += code.slice(at);
    const tree = safeParse(parser, source, undefined, PARSE_OPTIONS);
    if (tree) cacheCFamilyTree(parser, cacheKey, tree, Buffer.byteLength(code));
    return tree;
}

function parseRecoveryApplied(code, tree) {
    return recoveryAppliedByTree.get(tree) ??
        (recoveryAppliedMemo.get(code) || tree.rootNode.hasError);
}

/**
 * Return the literal-source AST when parseTree selected a concrete
 * preprocessor configuration.  The selected tree is the best view for
 * ownership and type evidence, but it cannot represent declarations/calls in
 * mutually-exclusive branches.  The literal tree still contains many of
 * those nodes as structurally valid children of preprocessor nodes.  Querying
 * both gives C/C++ the same all-source inventory contract as grep without
 * pretending the branch-only call sites are active in the selected build.
 */
function literalRecoveryTree(parser, code, selected) {
    const allSource = allSourceRecoveryByTree.get(selected);
    if (!parseRecoveryApplied(code, selected) || !allSource) return null;
    const cached = allSourceTreeBySelected.get(selected);
    if (cached) return cached;
    const literal = safeParse(
        parser,
        allSource,
        undefined,
        PARSE_OPTIONS,
    );
    allSourceTreeBySelected.set(selected, literal);
    const invocations = macroInvocationsByTree.get(selected);
    if (invocations) macroInvocationsByTree.set(literal, invocations);
    return literal;
}

function mergeExtracted(primary, secondary, keyOf) {
    const merged = [...primary];
    const seen = new Set(primary.map(keyOf));
    for (const item of secondary) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }
    // Secondary recovery trees may contribute an earlier source item after a
    // later primary item. Preserve the public source-order contract instead
    // of exposing merge history through callers, usages, or JSON output.
    return merged.sort((a, b) =>
        ((a.line ?? a.startLine ?? 0) - (b.line ?? b.startLine ?? 0)) ||
        ((a.column ?? a.startColumn ?? 0) - (b.column ?? b.startColumn ?? 0)) ||
        ((a.callStart ?? 0) - (b.callStart ?? 0)));
}

/**
 * Members a class declares only in a conditional branch the selected
 * configuration skips (fix #393: `#if !FMT_MSC_VERSION` around one overload
 * of `fallback`). The selected tree's class keeps its members; the literal
 * tree's class of the same key adds each member whose first line the
 * selected source blanked, so every configuration's overloads are indexed
 * (as free functions in skipped branches already are).
 */
function withBranchMembers(primary, literalClasses, code, selectedSource, codeLines) {
    if (!literalClasses || literalClasses.length === 0 || typeof selectedSource !== 'string' ||
        selectedSource === code) return primary;
    const keyOf = item => `${item.name}:${item.startLine}:${item.type}:${item.namespace || ''}`;
    const literalByKey = new Map(literalClasses.map(item => [keyOf(item), item]));
    let selectedLines = null;
    const blanked = line => {
        selectedLines ||= selectedSource.split('\n');
        return !(selectedLines[line - 1] || '').trim() && !!(codeLines[line - 1] || '').trim();
    };
    return primary.map(item => {
        const other = literalByKey.get(keyOf(item));
        if (!other || !Array.isArray(other.members) || !Array.isArray(item.members)) return item;
        const have = new Set(item.members.map(member => `${member.name}:${member.startLine}`));
        const extra = other.members.filter(member => !have.has(`${member.name}:${member.startLine}`) &&
            member.startLine >= item.startLine && member.endLine <= item.endLine &&
            blanked(member.startLine));
        if (extra.length === 0) return item;
        const members = [...item.members, ...extra].sort((a, b) => a.startLine - b.startLine);
        return { ...item, members };
    });
}

/**
 * The literal all-source tree is a secondary view for declarations that sit
 * in branches the selected configuration skips. Where the selected tree
 * already owns a region as a class body, a literal-tree FREE function with
 * the name and lines of one of that class's members is the same declaration
 * seen through a broken parse (its class closed early in the literal view),
 * not a second definition. Nor is a literal-tree free function inside the
 * body of a member the selected tree defines: C and C++ have no nested
 * function definitions (fix #387: `switch (val.type())` in a constructor
 * whose `#if` member-initializer list broke the literal view).
 */
function withoutShadowedFreeFunctions(secondary, primaryClasses) {
    const owners = (primaryClasses || []).filter(cls =>
        Array.isArray(cls.members) && cls.members.length > 0);
    if (owners.length === 0) return secondary;
    return secondary.filter(fn => {
        if (fn.className) return true;
        const end = fn.endLine ?? fn.startLine;
        return !owners.some(cls =>
            cls.startLine <= fn.startLine && end <= cls.endLine &&
            cls.members.some(member => {
                const memberEnd = member.endLine ?? member.startLine;
                if (member.name === fn.name) return member.startLine <= end && fn.startLine <= memberEnd;
                return memberEnd > member.startLine && member.startLine < fn.startLine && end <= memberEnd;
            }));
    });
}

function unwrapDeclarator(node) {
    let current = node;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.type === 'function_declarator') return current;
        const next = current.childForFieldName('declarator');
        if (next) {
            current = next;
            continue;
        }
        for (const child of current.namedChildren || []) {
            if (child.type === 'function_declarator' ||
                child.type.endsWith('_declarator') ||
                child.type === 'qualified_identifier') {
                current = child;
                break;
            }
        }
        if (current === node || !current) break;
    }
    return null;
}

function functionDeclarator(node) {
    if (!node) return null;
    if (node.type === 'function_declarator' ||
        node.type === 'operator_cast') return node;
    if (node.type === 'template_declaration') {
        const declaration = node.childForFieldName('declaration') ||
            node.namedChildren.find(child =>
                FUNCTION_CONTAINERS.has(child.type) ||
                child.type === 'operator_cast');
        return declaration ? functionDeclarator(declaration) : null;
    }
    const direct = node.childForFieldName('declarator');
    if (direct?.type === 'operator_cast') return direct;
    const unwrapped = unwrapDeclarator(direct);
    if (unwrapped) return unwrapped;
    for (const child of node.namedChildren || []) {
        if (child.type === 'operator_cast') return child;
        const found = unwrapDeclarator(child);
        if (found) return found;
    }
    return null;
}

function canonicalCallableName(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('operator')) return text;
    const rest = text.slice('operator'.length).trim();
    if (!rest) return 'operator';
    // Symbolic operator tokens, multi-character alternatives first. This set
    // must stay in lockstep with `canonicalOperatorName` in
    // eval/oracles/clangd-oracle.js — the eval pins UCN definitions by
    // oracle-listed name, so a token missing HERE mis-names the definition
    // (fmt's `operator++` landed in the conversion branch as "operator ++")
    // and a token missing THERE truncates the oracle's name.
    if (/^(?:\(\)|\[\]|<=>|<<=?|>>=?|->\*?|\+\+|--|&&|\|\||,|[+\-*/%<>=!&|^~]=?)$/
        .test(rest)) {
        return `operator${rest}`;
    }
    // Allocation operators keep their array suffix; user-defined literals are
    // named by their suffix.
    const wordForm = rest.match(/^(new|delete)\s*(\[\s*\])?$/);
    if (wordForm) return `operator ${wordForm[1]}${wordForm[2] ? '[]' : ''}`;
    const literal = rest.match(/^""\s*(_[A-Za-z0-9_]*)/);
    if (literal) return `operator""${literal[1]}`;
    // Conversion operators are named by their destination type. Template
    // arguments are instantiation detail, not source-level callable identity.
    const destination = rest.replace(/\s*\(\).*/s, '')
        .replace(/<.*>$/s, '').replace(/\s+/g, ' ').trim();
    return destination ? `operator ${destination}` : 'operator';
}

function parameterListOf(node) {
    if (!node) return null;
    const direct = node.childForFieldName('parameters');
    if (direct) return direct;
    for (const child of node.namedChildren || []) {
        if (child.type === 'parameter_list') return child;
        const nested = parameterListOf(child);
        if (nested) return nested;
    }
    return null;
}

function declaratorIdentity(declarator) {
    if (!declarator) return {};
    if (declarator.type === 'operator_cast') {
        const destination = declarator.childForFieldName('type') ||
            declarator.namedChildren.find(child => TYPE_NODES.has(child.type));
        if (!destination) return {};
        return {
            name: canonicalCallableName(`operator ${destination.text}`),
            nameNode: declarator,
            conversionType: typeName(destination),
        };
    }
    let node = declarator.childForFieldName('declarator') || declarator;
    while (node && (node.type.endsWith('_declarator') ||
        node.type === 'parenthesized_declarator')) {
        const next = node.childForFieldName('declarator');
        if (!next) break;
        node = next;
    }
    if (!node) return {};
    if (node.type === 'qualified_identifier') {
        // `ns::Cls<T>::m` nests qualified identifiers; the member name is the
        // innermost one, its owner the scope right before it, and the outer
        // scopes qualify the owner (fix #379: `sinks::base_sink<M>::flush`
        // was named "base_sink<M>::flush" in class "sinks").
        const scopes = [];
        let nameNode = node;
        while (nameNode?.type === 'qualified_identifier') {
            const scope = nameNode.childForFieldName('scope') ||
                (nameNode.namedChildCount > 1 ? nameNode.namedChild(0) : null);
            if (scope) scopes.push(scope);
            nameNode = nameNode.childForFieldName('name') ||
                nameNode.namedChildren[nameNode.namedChildCount - 1];
        }
        const scopeNode = scopes[scopes.length - 1];
        const qualifier = scopes.slice(0, -1).map(scope => scope.text.replace(/\s+/g, ''))
            .filter(Boolean).join('::');
        return {
            name: canonicalCallableName(nameNode?.text),
            className: scopeNode?.text?.split('::').pop(),
            nameNode,
            ...(qualifier && { ownerQualifier: qualifier }),
        };
    }
    if (IDENTIFIER_NODES.has(node.type)) {
        return { name: canonicalCallableName(node.text), nameNode: node };
    }
    const named = node.namedChildren || [];
    for (let i = named.length - 1; i >= 0; i--) {
        const candidate = declaratorIdentity(named[i]);
        if (candidate.name) return candidate;
    }
    return {};
}

function enclosingClass(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CLASS_NODES.has(parent.type)) {
            return classIdentity(parent);
        }
    }
    return null;
}

/**
 * fix #391: a `friend` function declared or defined in a class body is not a
 * member. It belongs to the innermost enclosing namespace (C++ [class.friend]
 * p6-7): ordinary lookup outside the class does not see it, argument-
 * dependent lookup does, and a body defined in the class is in the class's
 * lexical scope (its static members are reachable by bare name). Returns the
 * befriending class identity for `node` (the function_definition or
 * declaration under `friend`, possibly inside `template <...>`), else null.
 */
function friendClassOf(node) {
    let current = node?.parent;
    if (current?.type !== 'friend_declaration') return null;
    current = current.parent;
    while (current?.type === 'template_declaration') current = current.parent;
    if (current?.type !== 'field_declaration_list') return null;
    const cls = current.parent;
    return cls && CLASS_NODES.has(cls.type) ? classIdentity(cls) : null;
}

/** A member-list entry that is a friend declaration (fix #391). */
function isFriendEntry(child) {
    let current = child;
    while (current?.type === 'template_declaration') {
        current = current.childForFieldName('declaration') ||
            (current.namedChildren || []).find(entry => entry.type === 'friend_declaration');
    }
    return current?.type === 'friend_declaration';
}

/**
 * Scope of a class declared in a function body (fix #389): a local class
 * is visible from its declaration to the end of the enclosing block, never
 * outside the function.
 */
// fix #390: the parameter NAMES of a class template (`template <typename S,
// int N> class Base`), in order, so a base clause `: Base<std::string, 3>`
// reads as a substitution of those names.
function templateParameterNames(node) {
    const declaration = node?.parent;
    if (declaration?.type !== 'template_declaration') return null;
    const list = declaration.childForFieldName('parameters');
    if (!list) return null;
    const names = [];
    for (const param of list.namedChildren) {
        let nameNode = null;
        if (param.type === 'type_parameter_declaration' ||
            param.type === 'variadic_type_parameter_declaration') {
            nameNode = param.namedChildren.find(child => child.type === 'type_identifier');
        } else if (param.type === 'optional_type_parameter_declaration') {
            nameNode = param.childForFieldName('name');
        } else if (param.type === 'parameter_declaration' ||
            param.type === 'optional_parameter_declaration' ||
            param.type === 'variadic_parameter_declaration') {
            nameNode = param.childForFieldName('declarator');
            while (nameNode && nameNode.type !== 'identifier') {
                nameNode = nameNode.childForFieldName?.('declarator') ||
                    nameNode.namedChildren.find(child => child.type === 'identifier') || null;
            }
        } else if (param.type === 'template_template_parameter_declaration') {
            const inner = param.namedChildren.filter(child => child.type.endsWith('parameter_declaration')).pop();
            nameNode = inner?.namedChildren.find(child => child.type === 'type_identifier') || null;
        }
        // An unnamed parameter keeps its position.
        names.push(nameNode?.text || '_');
    }
    return names.length > 0 ? `<${names.join(', ')}>` : null;
}

function functionLocalClassScope(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CLASS_NODES.has(parent.type) || parent.type === 'namespace_definition' ||
            parent.type === 'translation_unit' || parent.type === 'declaration_list' ||
            parent.type === 'field_declaration_list') return {};
        if (parent.type === 'compound_statement') {
            return {
                lexicalScopeStartLine: node.startPosition.row + 1,
                lexicalScopeEndLine: parent.endPosition.row + 1,
            };
        }
    }
    return {};
}

function enclosingClassName(node) {
    const identity = enclosingClass(node);
    return identity?.ownerName || identity?.name || null;
}

// A typedef or alias declared in a block (a function body, a macro-wrapped
// body) is visible only there; one in a class body is a member type (fix
// #396).
function typeDeclarationScope(node) {
    const local = functionLocalClassScope(node);
    return local.lexicalScopeStartLine != null ? local : enclosingTypeScope(node);
}

function enclosingTypeScope(node) {
    const identity = enclosingClass(node);
    if (!identity?.node) return {};
    return {
        enclosingType: identity.ownerName || identity.name,
        lexicalScopeStartLine: identity.node.startPosition.row + 1,
        lexicalScopeEndLine: identity.node.endPosition.row + 1,
    };
}

// Namespace scopes an ERROR node holds as loose tokens (fix #393): the
// parser's recovery can leave `namespace detail {` ... `}` as direct
// children of an ERROR around well-formed declarations (a damaged
// amalgamated header). Keyed per tree by the ERROR's byte span.
const errorNamespaceRangesByTree = new WeakMap();

function errorNamespaceRanges(errorNode) {
    const tree = errorNode.tree;
    let byNode = tree ? errorNamespaceRangesByTree.get(tree) : null;
    const key = `${errorNode.startIndex}:${errorNode.endIndex}`;
    if (byNode?.has(key)) return byNode.get(key);
    const ranges = [];
    const stack = [];
    const children = errorNode.children || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === 'namespace') {
            let j = i + 1;
            let name = '';
            const nameNode = children[j];
            if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'namespace_identifier' ||
                nameNode.type === 'nested_namespace_specifier')) {
                name = nameNode.text.replace(/\s+/g, '');
                j++;
            }
            if (children[j]?.type === '{') {
                stack.push({ name, start: children[j].endIndex });
                i = j;
            }
            continue;
        }
        if (child.type === '{') {
            stack.push({ name: null, start: child.endIndex });
        } else if (child.type === '}') {
            const frame = stack.pop();
            if (frame && frame.name) ranges.push({ start: frame.start, end: child.startIndex, name: frame.name });
        }
    }
    // A frame whose `}` the recovery absorbed into a later declaration ends
    // at the brace matching its `{` in the token stream (one forward pass
    // over the ERROR's leaf tokens); a frame never matched is not a scope.
    const open = stack.filter(frame => frame.name);
    if (open.length > 0) {
        const frameAt = new Map(open.map(frame => [frame.start, frame]));
        const braces = [];
        const cursor = errorNode.walk();
        const first = open[0].start - 1;
        let done = false;
        const visit = () => {
            if (cursor.endIndex <= first) return;
            if (cursor.gotoFirstChild()) {
                do {
                    visit();
                    if (done) break;
                } while (cursor.gotoNextSibling());
                cursor.gotoParent();
                return;
            }
            const type = cursor.nodeType;
            // A MISSING token (zero width) is not in the source.
            if (cursor.startIndex === cursor.endIndex) return;
            if (type === '{') {
                braces.push(cursor.endIndex);
            } else if (type === '}') {
                const opened = braces.pop();
                const frame = opened != null ? frameAt.get(opened) : null;
                if (frame) {
                    ranges.push({ start: frame.start, end: cursor.startIndex, name: frame.name });
                    frameAt.delete(opened);
                    if (frameAt.size === 0) done = true;
                }
            }
        };
        visit();
    }
    ranges.sort((a, b) => a.start - b.start);
    if (tree) {
        if (!byNode) {
            byNode = new Map();
            errorNamespaceRangesByTree.set(tree, byNode);
        }
        byNode.set(key, ranges);
    }
    return ranges;
}

// Namespaces the parser closed early (fix #393): error recovery can absorb
// an opening brace into an ERROR (`-> decltype(a.f(), void()) {` in a
// trailing return type), so the declaration_list's `}` actually closes that
// brace and the declarations after it land outside the namespace, with the
// namespace's own `}` left as a lone ERROR token further down. The source's
// brace tokens decide: the namespace spans from its `{` to the brace that
// matches it in the token stream. Error-free subtrees are balanced and are
// skipped, so only damaged regions are walked. Keyed per tree.
const extendedNamespaceRangesByTree = new WeakMap();

function braceDelta(node) {
    if (node.startIndex === node.endIndex) return 0;
    if (node.type === '{') return 1;
    if (node.type === '}') return -1;
    if (!node.hasError || node.childCount === 0) return 0;
    let delta = 0;
    for (const child of node.children || []) delta += braceDelta(child);
    return delta;
}

// The `}` that brings `open` unmatched braces to zero inside `node`, or the
// remaining count when the node does not close them.
function closingBraceIn(node, open) {
    if (node.startIndex === node.endIndex) return { open };
    if (node.type === '{') return { open: open + 1 };
    if (node.type === '}') return open === 1 ? { brace: node, open: 0 } : { open: open - 1 };
    if (!node.hasError || node.childCount === 0) return { open };
    for (const child of node.children || []) {
        const result = closingBraceIn(child, open);
        if (result.brace) return result;
        open = result.open;
    }
    return { open };
}

// The early-closed namespaces among one container's children, keyed per
// tree by the container's node id: only a container holding an error can
// hold one (the namespace's own body has the surplus brace).
const NAMESPACE_CONTAINER_TYPES = new Set([
    'translation_unit', 'declaration_list', 'ERROR',
    'preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif', 'preproc_elifdef',
]);

function extendedNamespaceRanges(container) {
    if (!container || !NAMESPACE_CONTAINER_TYPES.has(container.type) || !container.hasError) return null;
    const tree = container.tree;
    let byContainer = tree ? extendedNamespaceRangesByTree.get(tree) : null;
    if (byContainer?.has(container.id)) return byContainer.get(container.id);
    const ranges = [];
    // Only namespace children are materialized; the rest are read by type.
    const namespaces = [];
    const cursor = container.walk();
    if (cursor.gotoFirstChild()) {
        do {
            if (cursor.nodeType === 'namespace_definition') namespaces.push(cursor.currentNode);
        } while (cursor.gotoNextSibling());
    }
    for (const namespaceNode of namespaces) {
        if (!namespaceNode.hasError) continue;
        // Its `}` can only lie in a later sibling that holds an error or is
        // a lone brace.
        let closable = false;
        for (let next = namespaceNode.nextSibling; next && !closable; next = next.nextSibling) {
            closable = next.hasError || (next.type === '}' && next.startIndex !== next.endIndex);
        }
        if (!closable) continue;
        const body = namespaceNode.childForFieldName('body');
        const bodyChildren = body?.children || [];
        const openBrace = bodyChildren[0];
        const closeBrace = bodyChildren[bodyChildren.length - 1];
        if (openBrace?.type !== '{' || closeBrace?.type !== '}' ||
            closeBrace.startIndex === closeBrace.endIndex) continue;
        let inner = 0;
        for (let i = 1; i < bodyChildren.length - 1; i++) inner += braceDelta(bodyChildren[i]);
        // The body's `}` closed an inner brace: `inner` braces (the
        // namespace's own included) are still open after it.
        if (inner <= 0) continue;
        let open = inner;
        let brace = null;
        for (let next = namespaceNode.nextSibling; next && !brace; next = next.nextSibling) {
            const result = closingBraceIn(next, open);
            brace = result.brace || null;
            open = result.open;
        }
        if (!brace) continue;
        const nameNode = namespaceNode.childForFieldName('name') ||
            (namespaceNode.namedChildren || []).find(child =>
                child.type === 'namespace_identifier' ||
                child.type === 'identifier' ||
                child.type === 'nested_namespace_specifier');
        if (!nameNode?.text) continue;
        ranges.push({
            name: nameNode.text.replace(/\s+/g, ''),
            astEnd: namespaceNode.endIndex,
            end: brace.startIndex,
        });
    }
    const result = ranges.length > 0 ? ranges : null;
    if (tree) {
        if (!byContainer) {
            byContainer = new Map();
            extendedNamespaceRangesByTree.set(tree, byContainer);
        }
        byContainer.set(container.id, result);
    }
    return result;
}

// One answer per node (declarations ask twice: once to test, once to set).
const enclosingNamespaceByTree = new WeakMap();

function enclosingNamespace(node) {
    const tree = node?.tree;
    let byNode = tree ? enclosingNamespaceByTree.get(tree) : null;
    if (byNode?.has(node.id)) return byNode.get(node.id);
    const result = enclosingNamespaceUncached(node);
    if (tree) {
        if (!byNode) {
            byNode = new Map();
            enclosingNamespaceByTree.set(tree, byNode);
        }
        byNode.set(node.id, result);
    }
    return result;
}

function enclosingNamespaceUncached(node) {
    const parts = [];
    const at = node?.startIndex;
    for (let parent = node?.parent; parent; parent = parent.parent) {
        // A namespace closed early whose token extent holds the node sits
        // between the node's scopes inside it and its own parent's.
        const extended = extendedNamespaceRanges(parent);
        if (extended) {
            for (let i = extended.length - 1; i >= 0; i--) {
                const range = extended[i];
                if (range.astEnd <= at && at < range.end) parts.unshift(range.name);
            }
        }
        if (parent.type === 'ERROR') {
            const names = errorNamespaceRanges(parent)
                .filter(range => range.start <= at && at < range.end)
                .map(range => range.name);
            if (names.length > 0) parts.unshift(...names);
            continue;
        }
        if (parent.type !== 'namespace_definition') continue;
        const nameNode = parent.childForFieldName('name') ||
            (parent.namedChildren || []).find(child =>
                child.type === 'namespace_identifier' ||
                child.type === 'identifier' ||
                child.type === 'nested_namespace_specifier');
        if (nameNode?.text) parts.unshift(nameNode.text.replace(/\s+/g, ''));
    }
    return parts.length > 0 ? parts.join('::') : null;
}

function cLanguageLinkage(node) {
    for (let current = node; current; current = current.parent) {
        if (current.type === 'linkage_specification' &&
            /^extern\s+"C"/.test(current.text.trim())) {
            return 'c';
        }
        if (current.type === 'translation_unit') break;
    }
    return null;
}

// The typedef name that names an anonymous specifier: the first plain
// declarator (`typedef struct { .. } T, *PT;` names the struct T; PT is a
// pointer alias of it).
function anonymousTypedefNameNode(typeDefinition) {
    const declarators = typeDefinition.childrenForFieldName
        ? typeDefinition.childrenForFieldName('declarator') : [];
    const plain = declarators.find(child => child.type === 'type_identifier');
    return plain || typeDefinition.childForFieldName('declarator');
}

function classIdentity(node) {
    let nameNode = node.childForFieldName('name');
    // `typedef struct { ... } T;` declares no tag: T is a typedef name (C's
    // ordinary identifier namespace), recorded as `typedefName` (fix #396).
    let typedefName = false;
    if (!nameNode && node.parent?.type === 'type_definition') {
        nameNode = anonymousTypedefNameNode(node.parent);
        typedefName = !!nameNode;
    }
    if (!nameNode) return null;
    if (typedefName) {
        return { name: nameNode.text, ownerName: nameNode.text, node, nameNode, typedefName: true };
    }
    // `struct Outer<T>::Node { .. }` / `struct Table::Rep { .. }` defines the
    // nested class a member declaration of Outer introduced (fix #396): its
    // name is the last segment, its enclosing type the scope before it, and
    // the outer scopes qualify that owner.
    if (nameNode.type === 'qualified_identifier') {
        const scopes = [];
        let inner = nameNode;
        while (inner?.type === 'qualified_identifier') {
            const scope = inner.childForFieldName('scope');
            if (scope) scopes.push(scope);
            inner = inner.childForFieldName('name');
        }
        const base = inner?.type === 'template_type' ? inner.childForFieldName('name') : inner;
        const owner = scopes[scopes.length - 1];
        if (base?.type === 'type_identifier' && owner) {
            const ownerBase = owner.type === 'template_type' ? owner.childForFieldName('name') : owner;
            const qualifier = scopes.slice(0, -1).map(scope => scope.text.replace(/\s+/g, ''))
                .filter(Boolean).join('::');
            return {
                name: base.text,
                ownerName: inner.type === 'template_type' ? inner.text : base.text,
                node,
                nameNode: base,
                ...(ownerBase?.text && { enclosingType: ownerBase.text }),
                ...(qualifier && { ownerQualifier: qualifier }),
            };
        }
    }
    if (nameNode.type === 'template_type') {
        const baseNode = nameNode.childForFieldName('name') ||
            (nameNode.namedChildren || []).find(child =>
                child.type === 'type_identifier' ||
                child.type === 'identifier');
        if (baseNode?.text) {
            return {
                name: baseNode.text,
                ownerName: nameNode.text,
                node,
                nameNode: baseNode,
            };
        }
    }
    return { name: nameNode.text, ownerName: nameNode.text, node, nameNode };
}

function modifiersOf(node, extra = []) {
    const modifiers = new Set(extra);
    for (const child of node.children || []) {
        if (child.type === 'virtual') modifiers.add('virtual');
        if (child.type === 'storage_class_specifier' ||
            child.type === 'type_qualifier' ||
            child.type === 'virtual_specifier' ||
            child.type === 'access_specifier') {
            modifiers.add(child.text);
        }
    }
    // `override`/`final` live under the function_declarator rather than as
    // direct children of the definition. Preserve those explicit C++
    // virtual-dispatch facts without scraping declaration text. The native
    // descendant query visits the same nodes as a named-child walk (a
    // virtual_specifier has no named children) without marshalling every
    // node of a body through the JS bridge (fix #385).
    // The walk it replaces visited them right to left (a LIFO stack of named
    // children); insertion order is the modifiers' output order.
    if (node.namedChildCount > 0) {
        const specifiers = node.descendantsOfType('virtual_specifier');
        for (let i = specifiers.length - 1; i >= 0; i--) {
            if (!sameNode(specifiers[i], node)) modifiers.add(specifiers[i].text);
        }
    }
    return [...modifiers];
}

function isTemplateDependentCallable(node) {
    // A callable can be dependent either because it has its own template
    // declaration or because it is a member of a class template. Keep this as
    // a boolean semantic fact; evaluating requires/enable_if expressions is a
    // compiler job, but knowing that overload selection depends on template
    // substitution lets the caller contract explain the uncertainty honestly.
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'template_declaration') return true;
        if (parent.type === 'translation_unit') break;
    }
    return false;
}

// `template <> bool f<bool>(...)` is a FULL specialization: the same compiler
// symbol as its primary template, selected by substitution rather than
// overload resolution (fix #299). Every enclosing template head must be
// empty — one non-empty parameter list means a member of a class template
// (partial-specialization territory for classes; ordinary dependence here).
function isFullSpecializationCallable(node) {
    let sawTemplateHead = false;
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'template_declaration') {
            const params = parent.childForFieldName('parameters');
            if (!params || params.namedChildCount > 0) return false;
            sawTemplateHead = true;
        }
        if (parent.type === 'translation_unit') break;
    }
    return sawTemplateHead;
}

// Full type text for a NAMED parameter: the parameter's own text with the
// name removed — `const char *s` → `const char *`, `int **pp` → `int **`,
// `void (*cb)(int)` → `void (*)(int)`. Reading around the identifier keeps
// qualifiers, pointer levels, array suffixes, and function-pointer shapes
// without re-deriving declarator grammar. Default values (C++ optional
// params) are cut before the removal.
function paramTypeText(param, identity) {
    if (!identity.nameNode) return null;
    const base = param.startIndex;
    const defaultValue = param.childForFieldName('default_value');
    const end = defaultValue ? defaultValue.startIndex : param.endIndex;
    if (identity.nameNode.startIndex < base || identity.nameNode.endIndex > end) return null;
    const text = nodeTextWithoutComments(param).slice(0, end - base);
    const typeText = (text.slice(0, identity.nameNode.startIndex - base) +
        text.slice(identity.nameNode.endIndex - base))
        .replace(/\s+/g, ' ')
        .replace(/\s*=\s*$/, '')
        .trim();
    return typeText || null;
}

function structuredParams(paramsNode) {
    if (!paramsNode) return [];
    const result = [];
    for (const param of paramsNode.namedChildren || []) {
        if (param.type !== 'parameter_declaration' &&
            param.type !== 'optional_parameter_declaration' &&
            param.type !== 'variadic_parameter_declaration' &&
            param.type !== 'variadic_parameter') continue;
        const declarator = param.childForFieldName('declarator');
        const identity = declaratorIdentity(declarator);
        const typeNode = param.childForFieldName('type') ||
            param.namedChildren.find(child => TYPE_NODES.has(child.type));
        // Unnamed parameters (`int f(size_t)`, `int f(void *)`) display as
        // their type text alone — the type must not double as both name and
        // annotation, and `void *` must not collapse into the `(void)` form.
        const info = {
            name: identity.name || nodeTextWithoutComments(param).replace(/\s+/g, ' ').trim(),
        };
        if (typeNode && identity.name) {
            info.type = paramTypeText(param, identity) || nodeTextWithoutComments(typeNode);
        } else if (typeNode && !identity.name) {
            // fix #393: an unnamed parameter's text is its type (without a
            // default argument); `unnamed` tells signature consumers so, as
            // for Go's unnamed interface parameters. A prototype
            // `f(const Option *)` and its definition `f(const Option *opt)`
            // then carry one parameter type list.
            const defaultValue = param.childForFieldName('default_value');
            const text = nodeTextWithoutComments(param);
            const typeText = (defaultValue ? text.slice(0, defaultValue.startIndex - param.startIndex) : text)
                .replace(/\s+/g, ' ').replace(/\s*=\s*$/, '').trim();
            if (typeText) {
                info.name = typeText;
                info.unnamed = true;
            }
        }
        if (param.type === 'optional_parameter_declaration') info.optional = true;
        let declaratorCursor = declarator;
        let variadicDeclarator = false;
        const seenDeclarators = new Set();
        while (declaratorCursor && !seenDeclarators.has(declaratorCursor.id)) {
            seenDeclarators.add(declaratorCursor.id);
            if (declaratorCursor.type === 'variadic_declarator') {
                variadicDeclarator = true;
                break;
            }
            declaratorCursor = declaratorCursor.childForFieldName('declarator') ||
                (declaratorCursor.namedChildren || []).find(child =>
                    child.type.endsWith('_declarator'));
        }
        if (param.type === 'variadic_parameter_declaration' ||
            param.type === 'variadic_parameter' || variadicDeclarator) {
            info.rest = true;
        }
        result.push(info);
    }
    // tree-sitter-c/cpp represents a bare C-style `...` as anonymous
    // punctuation rather than a named variadic parameter node. Preserve that
    // tail explicitly so nominal arity pruning accepts calls beyond the fixed
    // prefix (`void log(const char*, ...)`) instead of excluding every real
    // variadic call.
    if (!result.some(param => param.rest) &&
        /(?:\(|,)\s*\.\.\.\s*\)$/.test(paramsNode.text)) {
        result.push({ name: '...', rest: true });
    }
    if (result.length === 1 && result[0].name === 'void') return [];
    return result;
}

function skipLexicalRegion(code, index) {
    if (code.startsWith('//', index)) {
        const newline = code.indexOf('\n', index + 2);
        return newline < 0 ? code.length : newline;
    }
    if (code.startsWith('/*', index)) {
        const end = code.indexOf('*/', index + 2);
        return end < 0 ? code.length : end + 2;
    }
    if (code.startsWith('R"', index)) {
        const open = code.indexOf('(', index + 2);
        if (open >= 0 && open - (index + 2) <= 16) {
            const delimiter = code.slice(index + 2, open);
            const close = code.indexOf(`)${delimiter}"`, open + 1);
            if (close >= 0) return close + delimiter.length + 2;
        }
    }
    const quote = code[index];
    if (quote !== '"' && quote !== "'") return null;
    for (let cursor = index + 1; cursor < code.length; cursor++) {
        if (code[cursor] === '\\') cursor++;
        else if (code[cursor] === quote) return cursor + 1;
    }
    return code.length;
}

function balancedTokenEnd(code, openIndex, openToken, closeToken) {
    let depth = 0;
    for (let index = openIndex; index < code.length; index++) {
        const skipped = skipLexicalRegion(code, index);
        if (skipped != null) {
            index = skipped - 1;
            continue;
        }
        if (code[index] === openToken) depth++;
        else if (code[index] === closeToken && --depth === 0) return index + 1;
    }
    return null;
}

function cppConstructorBodyOpen(code, paramsEnd) {
    let inInitializers = false;
    let initializerComplete = false;
    for (let index = paramsEnd; index < code.length; index++) {
        const skipped = skipLexicalRegion(code, index);
        if (skipped != null) {
            index = skipped - 1;
            continue;
        }
        const character = code[index];
        if (!inInitializers) {
            if (character === ':') {
                inInitializers = true;
                initializerComplete = false;
            } else if (character === '{') {
                return index;
            } else if (character === ';' || character === '=') {
                return null;
            }
            continue;
        }
        if (/\s/.test(character)) continue;
        if (character === ',') {
            initializerComplete = false;
            continue;
        }
        if (character === '{' && initializerComplete) return index;
        if (character === '(' || character === '{') {
            const end = balancedTokenEnd(
                code, index, character, character === '(' ? ')' : '}');
            if (end == null) return null;
            index = end - 1;
            initializerComplete = true;
            continue;
        }
        // After a complete mem-initializer, the only legal top-level tokens
        // are a comma or the function body's opening brace. Attributes and
        // comments were consumed above; ordinary identifier characters here
        // belong to the next mem-initializer's name.
    }
    return null;
}

function functionRangeEnd(code, node, paramsNode, isConstructor, mode) {
    if (node.type !== 'function_definition') return null;
    const astBody = node.childForFieldName('body');
    let open = astBody?.startIndex;
    if (mode === 'cpp' && isConstructor && paramsNode) {
        open = cppConstructorBodyOpen(code, paramsNode.endIndex) ?? open;
    }
    if (open == null || code[open] !== '{') return null;
    return balancedTokenEnd(code, open, '{', '}');
}

function lineNumberAtIndex(lineStarts, index) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= index) low = mid;
        else high = mid;
    }
    return low + 1;
}

function returnTypeOf(node) {
    const findTrailing = current => {
        if (!current) return null;
        if (current.type === 'trailing_return_type') {
            const descriptor = (current.namedChildren || []).find(child =>
                child.type === 'type_descriptor') || current.namedChild(0);
            const type = descriptor?.childForFieldName('type') || descriptor;
            return nodeTextWithoutComments(type) || null;
        }
        for (const child of current.namedChildren || []) {
            const found = findTrailing(child);
            if (found) return found;
        }
        return null;
    };
    const trailing = findTrailing(node.childForFieldName('declarator'));
    if (trailing) return trailing;
    const typeNode = node.childForFieldName('type') ||
        node.namedChildren.find(child => TYPE_NODES.has(child.type));
    if (!typeNode) return null;
    // Pointer declarators wrapping the function declarator belong to the
    // RETURN type: `char *dup(...)` returns `char *`, and the pointer
    // variable `void *(*fp)(size_t)` yields `void *` when called. The walk
    // stops at the function/parenthesized declarator — inner pointers are
    // the function-pointer itself, not the return type.
    let stars = 0;
    let current = node.childForFieldName('declarator');
    const seen = new Set();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.type === 'function_declarator' ||
            current.type === 'parenthesized_declarator') break;
        if (current.type === 'pointer_declarator') stars++;
        current = current.childForFieldName('declarator') ||
            (current.namedChildren || []).find(child => child.type.endsWith('_declarator'));
    }
    return stars > 0 ? `${nodeTextWithoutComments(typeNode)} ${'*'.repeat(stars)}` : nodeTextWithoutComments(typeNode);
}

// The declaration a `template <...>` head wraps (a member template's return
// type is on it, fix #391); any other node as is.
function templatedDeclaration(node) {
    let current = node;
    while (current?.type === 'template_declaration') {
        const inner = current.childForFieldName('declaration') ||
            (current.namedChildren || []).find(child =>
                FUNCTION_CONTAINERS.has(child.type) || child.type === 'template_declaration');
        if (!inner) break;
        current = inner;
    }
    return current || node;
}

function memberFromNode(node, className, access, lines, mode) {
    const declarator = functionDeclarator(node);
    if (!declarator) return null;
    const identity = declaratorIdentity(declarator);
    if (!identity.name) return null;
    const paramsNode = parameterListOf(declarator);
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const isConstructor = mode === 'cpp' &&
        (identity.name === className || identity.name === `~${className}`);
    const modifiers = modifiersOf(node, access ? [access] : []);
    if (isConstructor && identity.name.startsWith('~')) modifiers.push('destructor');
    return {
        name: identity.name,
        params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\(|\)$/g, '').trim() : '...',
        paramsStructured: structuredParams(paramsNode),
        returnType: isConstructor ? null :
            (identity.conversionType || returnTypeOf(templatedDeclaration(node))),
        startLine,
        endLine,
        ...(identity.nameNode?.startPosition.row + 1 !== startLine && {
            nameLine: identity.nameNode.startPosition.row + 1,
        }),
        indent,
        modifiers,
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        ...(enclosingNamespace(node) && {
            namespace: enclosingNamespace(node),
        }),
        className,
        // A member template's own `template <...>` head counts (fix #391:
        // the head is the member-list entry itself, not a parent of it).
        ...(mode === 'cpp' && isTemplateDependentCallable(templatedDeclaration(node)) && {
            templateDependent: true,
        }),
        ...(mode === 'cpp' && templateParameterNames(templatedDeclaration(node)) && {
            templateParams: templateParameterNames(templatedDeclaration(node)),
        }),
        ...(mode === 'cpp' && isFullSpecializationCallable(templatedDeclaration(node)) && {
            isSpecialization: true,
        }),
        ...(mode === 'cpp' && cLanguageLinkage(node) && {
            linkage: cLanguageLinkage(node),
        }),
        // A member template with a body is a definition (fix #393).
        ...(templatedDeclaration(node).type !== 'function_definition' && { isSignature: true }),
        // A member inside a preprocessor conditional of its class body
        // exists only in some configurations (fix #385, as #379 for
        // functions).
        ...(conditionalBranchLines(node) && { ppBranch: conditionalBranchLines(node) }),
        docstring: extractJSDocstring(lines, startLine),
    };
}

function fieldMembers(node, access, lines) {
    if (node.type !== 'field_declaration') return [];
    if (functionDeclarator(node)) return [];
    const typeNode = node.childForFieldName('type') ||
        node.namedChildren.find(child => TYPE_NODES.has(child.type));
    const fields = [];
    for (const child of node.namedChildren || []) {
        if (!IDENTIFIER_NODES.has(child.type) && child.type !== 'field_declarator') continue;
        const identity = declaratorIdentity(child);
        if (!identity.name || identity.name === typeNode?.text) continue;
        const { startLine, endLine, indent } = nodeToLocation(child, lines);
        fields.push({
            name: identity.name,
            startLine,
            endLine,
            indent,
            modifiers: access ? [access] : [],
            memberType: 'field',
            fieldType: typeNode?.text || null,
        });
    }
    return fields;
}

/**
 * Member-list entries in document order, with preprocessor conditionals
 * opened (fix #385): `#ifdef _WIN32 bool f() {...} #else bool f() {...}
 * #endif` inside a class body holds members of the class in each branch.
 * The grammar nests them under the conditional node, which was read as ONE
 * member spanning the whole block (the first branch's), so every other
 * member of the block was lost. Conditions and directive names are not
 * members.
 */
function memberListEntries(body) {
    const entries = [];
    const visit = container => {
        const directive = container === body ? null : [
            container.childForFieldName('condition'), container.childForFieldName('name'),
        ].filter(Boolean);
        for (const child of container.namedChildren || []) {
            if (PP_CONDITIONAL_TYPES.has(child.type)) {
                visit(child);
                continue;
            }
            if (directive && directive.some(part => sameNode(part, child))) continue;
            entries.push(child);
        }
    };
    visit(body);
    return entries;
}

/** Recovered member-list macro invocations directly inside `body`. */
function memberListInvocations(tree, body) {
    const invocations = tree && macroInvocationsByTree.get(tree);
    if (!invocations || invocations.length === 0) return [];
    // The recovered tree decides: an invocation blanked whole whose range the
    // body itself spans (the grammar may have lost the class head around it
    // before recovery, as for `class E : public B { ERROR_DEF(B, E) };`).
    return invocations.filter(invocation => invocation.blank && invocation.blank[1] === invocation.end &&
        invocation.start >= body.startIndex && invocation.end <= body.endIndex &&
        sameNode(tree.rootNode.descendantForIndex(invocation.start, invocation.end), body));
}

/**
 * Members a member-list macro invocation declares (fix #385): the
 * replacement list with the invocation's arguments, parsed as the body of
 * a class of the same name so constructors stay constructors. Members sit
 * on the invocation's lines and carry `generatedByMacro`; `access` is the
 * access the expansion leaves in effect (its last access specifier).
 */
function expandedMembers(invocation, identity, access, lines, mode) {
    const text = substituteInvocation(invocation.definition, invocation.args);
    if (text == null) return { members: [], access: null };
    const className = identity.name;
    const wrapper = `class ${className} {\n${access}:\n${text}\n};\n`;
    const { getParser } = require('./index');
    const tree = safeParse(getParser(mode), wrapper, undefined, PARSE_OPTIONS);
    try {
        // Only a replacement list that is a member list declares members
        // (a statement-shaped expansion the grammar placed in a class body
        // after an earlier misparse declares nothing).
        if (tree.rootNode.hasError) return { members: [], access: null };
        const classNode = (tree.rootNode.namedChildren || []).find(child => child.type === 'class_specifier');
        if (!classNode) return { members: [], access: null };
        const wrapperLines = wrapper.split('\n');
        const startLine = lineOfIndex(lines, invocation.start);
        const endLine = lineOfIndex(lines, invocation.end - 1);
        const members = classMembers(classNode, wrapperLines, mode)
            .filter(member => member.name !== invocation.name)
            .map((member, ordinal) => {
                const { nameLine: _nameLine, docstring: _docstring, ppBranch: _ppBranch, ...rest } = member;
                const kind = rest.memberType || (rest.isConstructor ? 'constructor' : 'method');
                return {
                    ...rest,
                    // Every member of one invocation sits on its lines; each
                    // keeps its own binding identity.
                    bindingId: `${kind}:${startLine}:${invocation.start}:${ordinal}`,
                    ...(rest.className && { className: identity.ownerName || identity.name }),
                    ...(rest.fieldType === className && { fieldType: identity.ownerName || identity.name }),
                    startLine,
                    endLine,
                    indent: (lines[startLine - 1] || '').match(/^\s*/)[0].length,
                    generatedByMacro: {
                        name: invocation.name, line: invocation.definition.line,
                        // A name no argument spells (`Get##name##String`) is
                        // not written anywhere: nothing to edit (fix #396).
                        ...(!(invocation.args || []).some(arg => (Array.isArray(arg)
                            ? arg.map(token => token.v).join('') : String(arg).trim()) === member.name) &&
                            { unspelled: true }),
                    },
                };
            });
        return { members, access: macroAccessEffect(text) };
    } finally {
        if (isMainThread) tree.delete?.();
    }
}

function lineOfIndex(lines, index) {
    let offset = 0;
    for (let row = 0; row < lines.length; row++) {
        offset += lines[row].length + 1;
        if (index < offset) return row + 1;
    }
    return lines.length;
}

function classMembers(node, lines, mode) {
    const identity = classIdentity(node);
    if (!identity) return [];
    const body = node.childForFieldName('body');
    if (!body) return [];
    let access = node.type === 'class_specifier' ? 'private' : 'public';
    let unknownAccess = null;
    const members = [];
    // Member-list invocations of the file's own macros, blanked by recovery
    // (fix #385): their members come from the expansion, in document order.
    const pendingInvocations = memberListInvocations(node.tree, body);
    const emitInvocations = before => {
        while (pendingInvocations.length > 0 &&
            (before == null || pendingInvocations[0].start < before)) {
            const invocation = pendingInvocations.shift();
            const expanded = expandedMembers(invocation, identity, access, lines, mode);
            members.push(...expanded.members);
            if (expanded.access) {
                access = expanded.access;
                unknownAccess = null;
            }
        }
    };
    for (const child of memberListEntries(body)) {
        emitInvocations(child.startIndex);
        // Enumerators are declarations in an enum body, not ordinary C/C++
        // field_declaration nodes. Index them as named constant members so
        // they remain navigable across find/search/usages.
        if (node.type === 'enum_specifier' && child.type === 'enumerator') {
            const nameNode = child.childForFieldName('name') ||
                (child.namedChildren || []).find(candidate =>
                    candidate.type === 'identifier');
            if (nameNode?.text) {
                const { startLine, endLine, indent } = nodeToLocation(nameNode, lines);
                members.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    indent,
                    modifiers: ['public'],
                    memberType: 'field',
                    fieldType: identity.ownerName || identity.name,
                });
            }
            continue;
        }
        if (child.type === 'access_specifier') {
            access = child.text;
            unknownAccess = null;
            continue;
        }
        if (CLASS_NODES.has(child.type)) continue;
        // A friend is not a member (fix #391): friend functions are indexed
        // as namespace-scope functions, friend classes declare nothing.
        if (isFriendEntry(child)) continue;
        const effectiveAccess = unknownAccess ? null : access;
        const before = members.length;
        const macroName = mode === 'cpp' ? memberListMacroInvocation(child, identity) : null;
        // A macro invocation is not a member of its own (fix #379): indexing
        // `ERROR_DEF(Base, Name)` as a method named ERROR_DEF made it a
        // rename/deadcode candidate.
        const member = macroName ? null : memberFromNode(
            child, identity.ownerName || identity.name, effectiveAccess, lines, mode);
        if (member) members.push(member);
        else if (!macroName) members.push(...fieldMembers(child, effectiveAccess, lines));
        if (unknownAccess) {
            for (let i = before; i < members.length; i++) {
                members[i].accessAfterMacro = { ...unknownAccess };
            }
        }
        // fix #379: a macro invocation in a member list may emit an access
        // specifier (`ERROR_DEF(Base, Name)` ending in `public:`). A macro
        // defined in this file is read: its last access specifier becomes
        // the current access. Otherwise the access of the following members
        // is unknown until the next explicit specifier; they carry the macro
        // name and the access in effect before it, resolved against project
        // macro bodies at query time.
        if (macroName) {
            const effect = sameFileMacroAccessEffect(node.tree, lines, macroName);
            if (effect.known) {
                if (effect.access) {
                    access = effect.access;
                    unknownAccess = null;
                }
            } else {
                unknownAccess = {
                    macro: macroName,
                    before: unknownAccess ? unknownAccess.before : access,
                };
            }
        }
    }
    emitInvocations(null);
    return members;
}

/**
 * fix #379: the last access specifier (`public:`, `protected:`, `private:`)
 * spelled by a macro replacement list, or null when it spells none.
 */
function macroAccessEffect(replacement) {
    const tokens = lexPP(String(replacement || ''));
    let access = null;
    for (let i = 0; i + 1 < tokens.length; i++) {
        const token = tokens[i];
        if (token.k === 'id' && CPP_ACCESS_KEYWORDS.has(token.v) && tokens[i + 1].v === ':') {
            access = token.v;
        }
    }
    return access;
}

/**
 * fix #379: a member-list child that can only be a macro invocation: a
 * function declarator without a return type that is not a constructor,
 * destructor or conversion (`ERROR_DEF(Base, Name)`), or `NAME(arg)` with no
 * terminating semicolon (a declaration requires one). Returns the macro name.
 */
function memberListMacroInvocation(child, identity) {
    if (!FUNCTION_CONTAINERS.has(child.type)) return null;
    const type = child.childForFieldName('type');
    const declarator = child.childForFieldName('declarator');
    const owners = new Set([identity.name, identity.ownerName].filter(Boolean));
    if (!type && declarator?.type === 'function_declarator') {
        const name = declarator.childForFieldName('declarator');
        if (name && (name.type === 'identifier' || name.type === 'field_identifier') &&
            !owners.has(name.text)) {
            return name.text;
        }
        return null;
    }
    if (type?.type === 'type_identifier' && hasMissingChild(child) &&
        (declarator?.type === 'parenthesized_declarator' ||
            declarator?.type === 'function_declarator')) {
        return type.text;
    }
    return null;
}

const macroAccessByTree = new WeakMap();
function sameFileMacroAccessEffect(tree, lines, macroName) {
    let byName = macroAccessByTree.get(tree);
    if (!byName) {
        byName = new Map();
        for (const definition of macroDefinitionNodes(tree)) {
            const nameNode = definition.childForFieldName('name') ||
                (definition.namedChildren || []).find(child => child.type === 'identifier');
            if (!nameNode) continue;
            const effect = macroAccessEffect(macroReplacementText(lines, nameNode));
            if (!byName.has(nameNode.text)) byName.set(nameNode.text, new Set());
            byName.get(nameNode.text).add(effect);
        }
        macroAccessByTree.set(tree, byName);
    }
    const effects = byName.get(macroName);
    // Configuration alternatives that disagree leave the access unknown.
    if (!effects || effects.size !== 1) return { known: false };
    return { known: true, access: [...effects][0] };
}

function typedefEntries(node, lines) {
    // `typedef void (*cb)(int);` / `typedef int myint;` / `typedef struct A B;`
    // declare importable type names. Anonymous specifiers
    // (`typedef struct { … } Point;`) are named through classIdentity's
    // type_definition fallback, so only alias-style declarators are added here.
    const inner = node.childForFieldName('type');
    const innerIsClass = inner && CLASS_NODES.has(inner.type);
    const innerTagName = innerIsClass ? inner.childForFieldName('name')?.text : null;
    // An anonymous specifier takes its name from its first plain declarator
    // (classIdentity); the other declarators alias it (fix #396).
    const anonymousName = innerIsClass && !innerTagName
        ? anonymousTypedefNameNode(node)?.text || null : null;
    const innerClassName = innerTagName || anonymousName;
    const entries = [];
    for (const child of node.namedChildren || []) {
        if (inner && sameNode(child, inner)) continue;
        if (child.type === 'type_qualifier' || child.type === 'storage_class_specifier') continue;
        const identity = declaratorIdentity(child);
        if (!identity.name || RESERVED_TYPE_KEYWORDS.has(identity.name)) continue;
        if (innerIsClass && (!innerClassName || innerClassName === identity.name)) continue;
        const { startLine, endLine, indent } = nodeToLocation(child, lines);
        // A function-pointer typedef aliases a function shape, not the return
        // type — record no aliasOf for it.
        const aliasOf = unwrapDeclarator(child)
            ? null
            : (innerIsClass ? innerClassName : typeName(inner));
        entries.push({
            name: identity.name,
            type: 'type',
            startLine,
            endLine,
            ...(identity.nameNode?.startPosition.row + 1 !== startLine && {
                nameLine: identity.nameNode.startPosition.row + 1,
            }),
            indent,
            modifiers: ['public'],
            members: [],
            ...typeDeclarationScope(node),
            ...(enclosingNamespace(node) && {
                namespace: enclosingNamespace(node),
            }),
            ...(aliasOf && aliasOf !== identity.name && { aliasOf }),
            docstring: extractJSDocstring(lines, startLine),
        });
    }
    return entries;
}

function findClassesInTree(code, tree, mode, sourceLines = null) {
    const lines = sourceLines || code.split('\n');
    const classes = [];
    const seen = new Set();
    // Names with a bodied definition in this file: bodyless occurrences of
    // the same name (forward declarations, `struct S` in a parameter or
    // field type position) are references to it, never second definitions.
    const bodiedNames = new Set();
    const bodylessEntries = new Set();
    const forwardDeclared = new Set();
    traverseTreeCached(tree.rootNode, node => {
        if (mode === 'cpp' && node.type === 'alias_declaration') {
            const nameNode = node.childForFieldName('name') ||
                node.namedChildren.find(child =>
                    child.type === 'type_identifier' ||
                    child.type === 'identifier');
            const valueNode = node.childForFieldName('type') ||
                node.namedChildren.find(child =>
                    !sameNode(child, nameNode) &&
                    (child.type === 'type_descriptor' ||
                     TYPE_NODES.has(child.type)));
            if (!nameNode?.text) return false;
            const { startLine, endLine, indent } =
                nodeToLocation(node, lines);
            classes.push({
                name: nameNode.text,
                type: 'type',
                startLine,
                endLine,
                indent,
                modifiers: ['public'],
                members: [],
                ...typeDeclarationScope(node),
                ...(enclosingNamespace(node) && {
                    namespace: enclosingNamespace(node),
                }),
                ...(valueNode?.text && { aliasOf: valueNode.text }),
                docstring: extractJSDocstring(lines, startLine),
            });
            return false;
        }
        if (node.type === 'type_definition') {
            classes.push(...typedefEntries(node, lines));
            return true; // descend — the inner specifier may be a named class
        }
        if (!CLASS_NODES.has(node.type)) return true;
        const identity = classIdentity(node);
        if (!identity?.name) return true;
        const hasBody = !!node.childForFieldName('body');
        if (hasBody) {
            bodiedNames.add(identity.name);
        } else {
            if (bodiedNames.has(identity.name)) return true;
            // A bodyless specifier is only a DECLARATION at declaration
            // level (`struct S;`); in a type position (`void f(struct S *)`)
            // it is a reference. One entry per opaque forward-declared name.
            const parentType = node.parent?.type;
            if (parentType !== 'translation_unit' && parentType !== 'declaration_list') return true;
            if (forwardDeclared.has(identity.name)) return true;
            forwardDeclared.add(identity.name);
        }
        const key = `${node.startIndex}:${identity.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        let type = node.type.replace('_specifier', '');
        if (type === 'union') type = 'type';
        const baseClause = node.namedChildren.find(child => child.type === 'base_class_clause');
        const bases = baseClause
            ? baseClause.namedChildren
                .filter(child => child.type !== 'access_specifier')
                .map(child => child.text)
            : [];
        const modifiers = modifiersOf(node);
        if (mode === 'c' || node.type !== 'class_specifier' || modifiers.includes('public')) {
            modifiers.push('public');
        }
        // A nested class names its enclosing class (fix #396): lexically
        // (`class A { struct B { .. }; }`) or by its qualified definition
        // (`struct A::B { .. }`, whose outer scopes qualify its namespace).
        const outer = identity.enclosingType ? null : mode === 'cpp' ? enclosingClass(node) : null;
        const enclosingType = identity.enclosingType || outer?.name || null;
        const namespace = identity.ownerQualifier
            ? [enclosingNamespace(node), identity.ownerQualifier].filter(Boolean).join('::')
            : enclosingNamespace(node);
        const entry = {
            name: identity.name,
            ...(identity.ownerName !== identity.name && {
                specialization: identity.ownerName,
            }),
            type,
            startLine,
            endLine,
            ...(identity.nameNode?.startPosition.row + 1 !== startLine && {
                nameLine: identity.nameNode.startPosition.row + 1,
            }),
            ...(identity.typedefName && { typedefName: true }),
            indent,
            modifiers: [...new Set(modifiers)],
            members: classMembers(node, lines, mode),
            ...(namespace && { namespace }),
            ...(enclosingType && { enclosingType }),
            ...(bases.length > 0 && { extends: bases.join(', ') }),
            ...(mode === 'cpp' && templateParameterNames(node) && {
                generics: templateParameterNames(node),
            }),
            ...functionLocalClassScope(node),
            docstring: extractJSDocstring(lines, startLine),
        };
        classes.push(entry);
        if (!hasBody) bodylessEntries.add(entry);
        return true;
    });
    // A forward declaration can precede its body. Filtering after the single
    // traversal preserves the old "body wins" result without paying a full
    // preliminary tree walk merely to discover future bodied names.
    return classes.filter(entry =>
        !bodylessEntries.has(entry) || !bodiedNames.has(entry.name));
}

function findClasses(code, parser, mode) {
    const tree = parseTree(parser, code);
    const primary = findClassesInTree(code, tree, mode);
    const literal = literalRecoveryTree(parser, code, tree);
    if (!literal) return primary;
    try {
        return mergeExtracted(
            primary,
            findClassesInTree(code, literal, mode),
            item => `${item.name}:${item.startLine}:${item.type}:${item.namespace || ''}`,
        );
    } finally { /* cached with the selected tree */ }
}

function findFunctionsInTree(code, tree, mode, sourceLines = null) {
    const lines = sourceLines || code.split('\n');
    const lineStarts = [0];
    for (let index = 0; index < code.length; index++) {
        if (code.charCodeAt(index) === 10) lineStarts.push(index + 1);
    }
    const functions = [];
    const seen = new Set();
    const variableTypes = mode === 'cpp' ? buildVariableTypes(tree) : null;
    traverseTreeCached(tree.rootNode, node => {
        // A body the grammar left at namespace scope after a macro
        // invocation statement (`TEST_CASE("x") { ... }`, fix #391).
        if (node.type === 'compound_statement') {
            const generated = generatedCallableOf(node, lines);
            if (generated) functions.push(generated);
            return true;
        }
        if (!FUNCTION_CONTAINERS.has(node.type)) return true;
        const declarator = functionDeclarator(node);
        if (!declarator) return true;
        // A macro invocation read as a function is not one (fix #385); an
        // invocation with a body at namespace scope defines the callable
        // the expansion declares around that body (fix #391).
        if (macroInvocationDeclaration(node)) {
            const generated = generatedCallableOf(node, lines);
            if (generated) functions.push(generated);
            return false;
        }
        const owner = enclosingClass(node);
        const identity = declaratorIdentity(declarator);
        if (!identity.name) return true;
        // A name joined by `##` is replacement-list text of a macro the
        // grammar could not read as a directive, never a declared function
        // (fix #387).
        if (identity.nameNode && pastedToken(code, identity.nameNode)) return true;
        // A friend function is a namespace-scope function lexically inside
        // its class (fix #391); a friend declaration naming another class's
        // member (`friend void Other::f();`) redeclares that member and
        // declares nothing new.
        const friendOf = owner ? friendClassOf(node) : null;
        if (friendOf && identity.className) return false;
        if (owner && !identity.className && !friendOf) return false;
        const key = `${node.startIndex}:${identity.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const paramsNode = parameterListOf(declarator);
        const location = nodeToLocation(node, lines);
        const startLine = location.startLine;
        const indent = location.indent;
        const ownerName = identity.className && identity.className.replace(/<.*>$/s, '');
        const isConstructor = mode === 'cpp' && !!identity.className &&
            (identity.name === ownerName || identity.name === `~${ownerName}`);
        const namespace = [enclosingNamespace(node), identity.className && identity.ownerQualifier]
            .filter(Boolean).join('::');
        const lexicalEnd = functionRangeEnd(
            code, node, paramsNode, isConstructor, mode);
        const endLine = lexicalEnd == null
            ? location.endLine
            : lineNumberAtIndex(lineStarts, Math.max(0, lexicalEnd - 1));
        const modifiers = modifiersOf(node);
        if (friendOf && !modifiers.includes('friend')) modifiers.unshift('friend');
        if (!modifiers.includes('static')) modifiers.push('export');
        const returnedConcreteType = mode === 'cpp' && variableTypes
            ? inferredAutoReturnType(node, variableTypes)
            : null;
        functions.push({
            name: identity.name,
            params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\(|\)$/g, '').trim() : '...',
            paramsStructured: structuredParams(paramsNode),
            returnType: isConstructor ? null :
                (identity.conversionType || returnTypeOf(node)),
            startLine,
            endLine,
            ...(identity.nameNode?.startPosition.row + 1 !== startLine && {
                nameLine: identity.nameNode.startPosition.row + 1,
            }),
            indent,
            modifiers,
            ...(namespace && { namespace }),
            ...(identity.className && {
                className: identity.className,
                receiver: identity.className,
                isMethod: true,
            }),
            ...(friendOf && { friendOf: friendOf.ownerName || friendOf.name }),
            ...(mode === 'cpp' && isTemplateDependentCallable(node) && {
                templateDependent: true,
            }),
            // fix #393: the function template's own type parameters; a
            // receiver typed by one is decided per instantiation.
            ...(mode === 'cpp' && templateParameterNames(node) && {
                templateParams: templateParameterNames(node),
            }),
            ...(mode === 'cpp' && isFullSpecializationCallable(node) && {
                isSpecialization: true,
            }),
            ...(returnedConcreteType && { returnedConcreteType }),
            ...(mode === 'cpp' && cLanguageLinkage(node) && {
                linkage: cLanguageLinkage(node),
            }),
            ...(isConstructor && { isConstructor: true }),
            ...(node.type !== 'function_definition' && { isSignature: true }),
            // fix #379: a definition inside a preprocessor conditional (not
            // an include guard) exists only in some build configurations;
            // the lines of its innermost branch.
            ...(conditionalBranchLines(node) && { ppBranch: conditionalBranchLines(node) }),
            docstring: extractJSDocstring(lines, startLine),
        });
        return false;
    });
    return functions;
}

/**
 * C++ `auto` return deduction is compiler-exact when every return statement
 * yields a local whose declared/inferred type agrees. This is intentionally
 * narrower than expression type inference; unknown or mixed returns abstain.
 */
function inferredAutoReturnType(functionNode, variableTypes) {
    const declared = returnTypeOf(functionNode);
    if (!/^auto\b/.test(String(declared || '').trim())) return null;
    const body = functionNode.childForFieldName('body');
    if (!body) return null;
    const autoBindings = [];
    traverseTree(body, node => {
        if (node !== body &&
            (node.type === 'function_definition' ||
             node.type === 'lambda_expression')) return false;
        if (node !== body && CLASS_NODES.has(node.type)) return false;
        if (node.type !== 'declaration') return true;
        const typeNode = node.childForFieldName('type') ||
            (node.namedChildren || []).find(child => TYPE_NODES.has(child.type));
        if (typeName(typeNode) !== 'auto') return true;
        const scope = variableBindingScope(node);
        for (const declarator of variableDeclarators(node)) {
            const identity = declaratorIdentity(declarator);
            const value = declarator.childForFieldName('value');
            if (!identity.name || value?.type !== 'call_expression') continue;
            const callee = callIdentity(value.childForFieldName('function'));
            if (!callee.name) continue;
            autoBindings.push({
                name: identity.name,
                type: callee.name,
                declaredAt: declarator.startIndex,
                scopeStart: scope.startIndex,
                scopeEnd: scope.endIndex,
            });
        }
        return true;
    });
    const autoTypeAt = (name, node) => autoBindings
        .filter(binding => binding.name === name &&
            binding.scopeStart <= node.startIndex &&
            node.startIndex < binding.scopeEnd &&
            binding.declaredAt <= node.startIndex)
        .sort((left, right) =>
            (left.scopeEnd - left.scopeStart) -
                (right.scopeEnd - right.scopeStart) ||
            right.declaredAt - left.declaredAt)[0]?.type;
    const types = [];
    let incomplete = false;
    const stack = [body];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node !== body &&
            (node.type === 'function_definition' ||
             node.type === 'lambda_expression')) continue;
        if (node !== body && CLASS_NODES.has(node.type)) continue;
        if (node.type === 'return_statement') {
            let value = node.namedChild(0);
            while (value?.type === 'parenthesized_expression') {
                value = value.namedChild(0);
            }
            const type = value?.type === 'identifier'
                ? (variableTypes.get(value.text, node) ||
                    autoTypeAt(value.text, node))
                : null;
            if (type) types.push(type);
            else incomplete = true;
            continue;
        }
        for (let index = node.namedChildCount - 1; index >= 0; index--) {
            stack.push(node.namedChild(index));
        }
    }
    return !incomplete && types.length > 0 && new Set(types).size === 1
        ? types[0] : null;
}

function findFunctions(code, parser, mode) {
    const tree = parseTree(parser, code);
    const primary = findFunctionsInTree(code, tree, mode);
    const literal = literalRecoveryTree(parser, code, tree);
    if (!literal) return primary;
    try {
        return mergeExtracted(
            primary,
            withoutShadowedFreeFunctions(
                findFunctionsInTree(code, literal, mode),
                findClassesInTree(code, tree, mode)),
            item => `${item.name}:${item.startLine}:${item.className || ''}:${item.isSignature ? 1 : 0}`,
        );
    } finally { /* cached with the selected tree */ }
}

function findStateObjectsInTree(tree, lines) {
    const states = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'declaration') return true;
        if (functionDeclarator(node)) return false;
        // A top-level declaration may be wrapped in one or more preprocessor
        // condition nodes.  Treat those wrappers as transparent: both arms of
        // an #if/#else remain part of the source inventory even though only
        // one arm can exist in any particular build configuration.
        let scope = node.parent;
        while (scope && /^preproc_/.test(scope.type)) scope = scope.parent;
        if (scope?.type !== 'translation_unit' && scope?.type !== 'declaration_list') return false;
        for (const child of node.namedChildren || []) {
            const identity = declaratorIdentity(child);
            if (!identity.name || TYPE_NODES.has(child.type)) continue;
            const { startLine, endLine, indent } = nodeToLocation(child, lines);
            states.push({
                name: identity.name,
                startLine,
                endLine,
                indent,
                modifiers: modifiersOf(node),
            });
        }
        return false;
    });
    return states;
}

function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const primary = findStateObjectsInTree(tree, lines);
    const literal = literalRecoveryTree(parser, code, tree);
    return literal ? mergeExtracted(primary,
        findStateObjectsInTree(literal, lines),
        item => `${item.name}:${item.startLine}`) : primary;
}

function collectMacroParameterEffects(nestedTree, parameters) {
    const effects = [];
    traverseTree(nestedTree.rootNode, node => {
        // Token-paste after a global qualifier (`::_##call`) is not C++
        // until preprocessing. tree-sitter preserves the `#call` token as
        // a preprocessor node next to an AST global qualified identifier;
        // that exact shape still proves the substituted callable is
        // globally qualified.
        if (node.type === 'preproc_directive' &&
            node.text.startsWith('#')) {
            const paramIndex = parameters.indexOf(node.text.slice(1));
            let globalSibling = false;
            let container = node.parent;
            for (let hops = 0; container && hops < 3 && !globalSibling;
                hops++, container = container.parent) {
                const stack = [...(container.namedChildren || [])];
                while (stack.length > 0 && !globalSibling) {
                    const sibling = stack.pop();
                    if (sibling === node) continue;
                    if (sibling.type === 'qualified_identifier' &&
                        sibling.children?.[0]?.type === '::') {
                        globalSibling = true;
                        break;
                    }
                    for (const child of sibling.namedChildren || []) {
                        stack.push(child);
                    }
                }
            }
            if (paramIndex >= 0 && globalSibling) {
                effects.push({
                    paramIndex,
                    kind: 'qualified',
                    qualifier: 'global',
                });
            }
            return true;
        }
        if (node.type !== 'identifier') return true;
        const paramIndex = parameters.indexOf(node.text);
        if (paramIndex < 0) return true;
        const parent = node.parent;
        if (parent?.type === 'qualified_identifier' &&
            parent.childForFieldName('name') === node) {
            const scope = parent.childForFieldName('scope');
            effects.push({
                paramIndex,
                kind: 'qualified',
                qualifier: scope?.text || 'global',
            });
            return true;
        }
        if (parent?.type === 'argument_list' &&
            parent.parent?.type === 'call_expression') {
            const wrapper = callIdentity(
                parent.parent.childForFieldName('function'));
            if (!wrapper.name || !isMacroToken(wrapper.name)) return true;
            const args = (parent.namedChildren || [])
                .filter(child => !child.type.endsWith('comment'));
            const argIndex = args.findIndex(argument =>
                argument.startIndex <= node.startIndex &&
                node.endIndex <= argument.endIndex);
            if (argIndex >= 0) {
                effects.push({
                    paramIndex,
                    kind: 'forwarded',
                    macro: wrapper.name,
                    argIndex,
                });
            }
        }
        return true;
    });
    return effects;
}

function macroParameterEffects(definitionNode, valueNode, paramsNode, parser) {
    if (definitionNode && macroParamEffectsByDefinition.has(definitionNode)) {
        return macroParamEffectsByDefinition.get(definitionNode);
    }
    if (!valueNode || !paramsNode || !parser) return [];
    const parameters = (paramsNode.namedChildren || [])
        .filter(child => child.type === 'identifier')
        .map(child => child.text);
    if (parameters.length === 0) return [];
    const body = valueNode.text.replace(/\\(?=\r?\n)/g, ' ');
    // Cheap parse-avoidance only; every semantic decision below comes from
    // the replacement list's tree. Ordinary value/punctuation macros need no
    // extra native tree.
    if (!body.includes('::') &&
        !/[A-Z_][A-Z0-9_]*\s*\(/.test(body)) return [];
    const prefix = 'void __ucn_macro_effect__(void) {\n';
    const synthetic = `${prefix}${body}\n;}`;
    const nestedTree = safeParse(parser, synthetic, undefined, PARSE_OPTIONS);
    try {
        const effects = collectMacroParameterEffects(nestedTree, parameters);
        if (definitionNode) {
            macroParamEffectsByDefinition.set(definitionNode, effects);
        }
        return effects;
    } finally {
        nestedTree.delete?.();
    }
}

/**
 * Namespace effect of an object-like macro whose replacement list only opens
 * or only closes namespaces (`#define NS_BEGIN namespace lib { inline
 * namespace v1 {` / `#define NS_END } }`). The replacement list is a token
 * sequence (tree-sitter keeps it as one opaque preproc_arg), so this reads
 * the tokens the preprocessor would substitute:
 *   opens:  one entry per `{`, each listing the namespace names it opens
 *           (`namespace a::b {` opens two names with one brace); inline and
 *           macro-named namespaces are transparent to qualified lookup and
 *           contribute no name
 *   closes: number of `}` tokens
 * Anything else in the list (declarations, mixed opens/closes) yields null.
 */
function macroReplacementText(lines, nameNode) {
    const row = nameNode.endPosition.row;
    let text = String(lines[row] || '').slice(nameNode.endPosition.column);
    for (let next = row; /\\\s*$/.test(lines[next] || '') && next + 1 < lines.length; next++) {
        text = text.replace(/\\\s*$/, ' ') + lines[next + 1];
    }
    return text;
}

function macroNamespaceScope(replacement) {
    const text = String(replacement || '')
        .replace(/\\\r?\n/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
    const tokens = text.match(/[A-Za-z_]\w*|::|[{}()]|\S/g) || [];
    if (tokens.length === 0) return null;
    if (tokens.every(token => token === '}')) {
        return { opens: [], closes: tokens.length };
    }
    const opens = [];
    let index = 0;
    while (index < tokens.length) {
        let inline = false;
        if (tokens[index] === 'inline') {
            inline = true;
            index++;
        }
        if (tokens[index] !== 'namespace') return null;
        index++;
        const names = [];
        let transparent = inline;
        while (index < tokens.length && tokens[index] !== '{') {
            const token = tokens[index];
            if (token === '::') {
                index++;
                continue;
            }
            if (!/^[A-Za-z_]\w*$/.test(token)) return null;
            if (tokens[index + 1] === '(') {
                // Macro-computed name (`NS_CONCAT(a, b)`): skip the balanced
                // argument list. Only an inline namespace may be anonymous
                // to lookup this way; a named outer namespace must be known.
                let depth = 0;
                index++;
                for (; index < tokens.length; index++) {
                    if (tokens[index] === '(') depth++;
                    else if (tokens[index] === ')' && --depth === 0) break;
                }
                if (depth !== 0 || !inline) return null;
                transparent = true;
                index++;
                continue;
            }
            names.push(token);
            index++;
        }
        if (tokens[index] !== '{') return null;
        index++;
        opens.push(transparent ? [] : names);
    }
    return opens.length > 0 ? { opens, closes: 0 } : null;
}

/**
 * Standalone macro-token lines at namespace scope (`LIB_NAMESPACE_BEGIN`).
 * Recovery blanks such lines, so the selected tree shows the position as
 * whitespace inside its enclosing scope; comments, strings, function and
 * class bodies, and macro definitions are rejected from that AST position.
 * Query-time code pairs the markers with indexed macro definitions whose
 * replacement lists open or close namespaces.
 */
const MARKER_REJECT_TYPES = new Set([
    'comment', 'string_literal', 'raw_string_literal', 'char_literal',
    'compound_statement', 'field_declaration_list', 'preproc_def',
    'preproc_function_def', 'preproc_call', 'parameter_list',
    'argument_list', 'initializer_list', 'enumerator_list',
]);

function findMacroScopeMarkers(code, tree, lines) {
    const markers = [];
    let offset = 0;
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        const lineStart = offset;
        offset += line.length + 1;
        const trimmed = line.trim();
        if (trimmed.length < 2 || !isMacroToken(trimmed)) continue;
        const column = line.indexOf(trimmed);
        let node = tree.rootNode.descendantForIndex(lineStart + column);
        let rejected = false;
        for (; node; node = node.parent) {
            if (MARKER_REJECT_TYPES.has(node.type)) {
                rejected = true;
                break;
            }
        }
        if (!rejected) markers.push({ name: trimmed, line: row + 1 });
    }
    return markers;
}

/**
 * C++ name-introducing declarations that qualified-name resolution needs:
 *   { kind: 'declaration', name, target }  `using ns::Name;`
 *   { kind: 'directive', target }           `using namespace ns;`
 *   { kind: 'namespace-alias', name, target } `namespace fs = std::filesystem;`
 * each with its line, AST namespace, and the block scope span when it sits
 * inside a function body (block-scope declarations are invisible outside).
 */
function findCppUsingFacts(tree) {
    const facts = [];
    for (const node of tree.rootNode.descendantsOfType(
        ['using_declaration', 'namespace_alias_definition'])) {
        let block = null;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === 'compound_statement') {
                block = parent;
                break;
            }
            if (parent.type === 'field_declaration_list') {
                block = parent;
                break;
            }
            if (parent.type === 'namespace_definition' ||
                parent.type === 'translation_unit') break;
        }
        const location = {
            line: node.startPosition.row + 1,
            ...(enclosingNamespace(node) && { namespace: enclosingNamespace(node) }),
            ...(block && {
                scopeStartLine: block.startPosition.row + 1,
                scopeEndLine: block.endPosition.row + 1,
            }),
        };
        if (node.type === 'namespace_alias_definition') {
            const name = (node.namedChildren || []).find(child =>
                child.type === 'namespace_identifier');
            const target = (node.namedChildren || []).find(child =>
                !sameNode(child, name) && child.type !== 'comment');
            if (name && target) {
                facts.push({ kind: 'namespace-alias', name: name.text,
                    target: target.text.replace(/\s+/g, ''), ...location });
            }
            continue;
        }
        const directive = (node.children || []).some(child => child.type === 'namespace');
        const operand = (node.namedChildren || []).find(child =>
            child.type === 'qualified_identifier' || child.type === 'identifier' ||
            child.type === 'namespace_identifier');
        if (!operand) continue;
        const target = operand.text.replace(/\s+/g, '');
        if (directive) {
            facts.push({ kind: 'directive', target, ...location });
        } else {
            const name = target.split('::').filter(Boolean).pop();
            if (name && name !== target.replace(/^::/, '')) {
                facts.push({ kind: 'declaration', name, target, ...location });
            }
        }
    }
    return facts;
}

const PP_CONDITIONAL_TYPES = new Set([
    'preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef', 'preproc_else',
]);

/** `#ifndef G` whose first directive is `#define G` and that has no else. */
function isIncludeGuard(node) {
    if (node.type !== 'preproc_ifdef' || node.child(0)?.type !== '#ifndef') return false;
    if (node.childForFieldName('alternative')) return false;
    const guard = node.childForFieldName('name')?.text;
    let first = null;
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'identifier' || child.type === 'comment') continue;
        first = child;
        break;
    }
    return !!guard && first?.type === 'preproc_def' &&
        first.childForFieldName('name')?.text === guard;
}

/**
 * Is a macro definition inside a preprocessor conditional other than an
 * include guard (fix #377)? Such a definition is in effect only in some
 * build configurations.
 */
function macroUnderCondition(node) {
    for (let up = node.parent; up; up = up.parent) {
        if (!PP_CONDITIONAL_TYPES.has(up.type)) continue;
        if (isIncludeGuard(up)) continue;
        return true;
    }
    return false;
}

/**
 * fix #379: [firstLine, lastLine] (1-based) of the innermost preprocessor
 * branch holding `node`, include guards skipped, or null. An `#if`/`#ifdef`
 * branch ends before its `#elif`/`#else` alternative.
 */
function conditionalBranchLines(node) {
    for (let up = node.parent; up; up = up.parent) {
        if (!PP_CONDITIONAL_TYPES.has(up.type)) continue;
        if (isIncludeGuard(up)) continue;
        const alternative = up.childForFieldName('alternative');
        const end = alternative ? alternative.startPosition.row : up.endPosition.row + 1;
        return [up.startPosition.row + 1, end];
    }
    return null;
}

function findMacrosInTree(tree, lines, parser) {
    const macros = [];
    for (const node of macroDefinitionNodes(tree)) {
        const nameNode = node.childForFieldName('name') ||
            (node.namedChildren || []).find(child => child.type === 'identifier');
        if (!nameNode) continue;
        const paramsNode = node.childForFieldName('parameters') ||
            (node.namedChildren || []).find(child => child.type === 'preproc_params');
        const { startLine, indent } = nodeToLocation(node, lines);
        // Preprocessor nodes include their terminating newline, so a node
        // ending at column zero belongs to the preceding physical line.
        const endLine = Math.max(startLine,
            node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0));
        macros.push({
            name: nameNode.text,
            startLine,
            endLine,
            indent,
            params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\(|\)$/g, '').trim() : undefined,
            paramsStructured: paramsNode
                ? (paramsNode.namedChildren || [])
                    .filter(child => child.type === 'identifier')
                    .map(child => ({ name: child.text }))
                : undefined,
            modifiers: [],
            functionLike: node.type === 'preproc_function_def',
            ...(macroUnderCondition(node) && { ppConditional: true }),
            ...(() => {
                // Replacement-list template for token-level expansion of
                // invocations (fix #362): pasted (`a##b`) call targets exist
                // only after substitution, so the index keeps the tokens.
                // The template is read from source lines; a tree whose rows do
                // not line up with the text (never observed on a primary
                // tree) yields no template rather than a wrong one.
                if (String(lines[nameNode.startPosition.row] || '').slice(
                    nameNode.startPosition.column, nameNode.endPosition.column) !== nameNode.text) return {};
                if (node.type !== 'preproc_function_def') {
                    // Short object-like replacement lists (`#define PREFIX uv_`)
                    // take part in argument pre-expansion before a paste.
                    const body = objectMacroBody(macroReplacementText(lines, nameNode));
                    return body !== null ? { ppBody: body } : {};
                }
                const template = functionMacroTemplate(
                    macroReplacementText(lines, nameNode));
                if (!template || template.body.length > MAX_MACRO_TEMPLATE_CHARS) return {};
                return {
                    ppParams: template.params,
                    ...(template.variadic && { ppVariadic: true }),
                    ppBody: template.body,
                };
            })(),
            ...(() => {
                if (node.type === 'preproc_function_def') return {};
                const scope = macroNamespaceScope(
                    macroReplacementText(lines, nameNode));
                return scope ? { namespaceScope: scope } : {};
            })(),
            ...(() => {
                const effects = macroParameterEffects(
                    node,
                    node.childForFieldName('value') ||
                        (node.namedChildren || []).find(child =>
                            child.type === 'preproc_arg'),
                    paramsNode,
                    parser);
                return effects.length > 0
                    ? { macroParamEffects: effects } : {};
            })(),
            docstring: extractJSDocstring(lines, startLine),
        });
    }
    return macros;
}

/**
 * `#define` lines the grammar cannot place as definitions (inside an
 * enumerator list or initializer, where C permits directives) surface as a
 * `preproc_call` whose directive is `#define`. The directive's argument is
 * the definition's token sequence: `NAME(params) body` (function-like only
 * when `(` immediately follows the name) or `NAME body`. Fix #362: libuv's
 * `typedef enum { #define XX(code, _) UV_ ## code = ..., UV_ERRNO_MAP(XX) }`.
 */
function findDirectiveMacrosInTree(tree, lines) {
    const macros = [];
    for (const node of directiveDefinitionNodes(tree)) {
        const argument = node.childForFieldName('argument');
        const nameMatch = /^\s*([A-Za-z_]\w*)/.exec(argument?.text || '');
        if (!argument || !nameMatch) continue;
        const name = nameMatch[1];
        const row = argument.startPosition.row;
        const nameColumn = argument.startPosition.column + nameMatch[0].length;
        if (!String(lines[row] || '').slice(0, nameColumn).endsWith(name)) continue;
        const afterName = macroReplacementText(lines, {
            endPosition: { row, column: nameColumn },
        });
        const functionLike = afterName.startsWith('(');
        const template = functionLike ? functionMacroTemplate(afterName) : null;
        const objectBody = functionLike ? null : objectMacroBody(afterName);
        const { startLine, indent } = nodeToLocation(node, lines);
        const endLine = Math.max(startLine,
            node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0));
        macros.push({
            name,
            startLine,
            endLine,
            indent,
            ...(template && {
                params: template.params.join(', '),
                paramsStructured: template.params.map(param => ({ name: param })),
            }),
            modifiers: [],
            functionLike,
            ...(template && template.body.length <= MAX_MACRO_TEMPLATE_CHARS && {
                ppParams: template.params,
                ...(template.variadic && { ppVariadic: true }),
                ppBody: template.body,
            }),
            ...(objectBody !== null && { ppBody: objectBody }),
        });
    }
    return macros;
}

function macrosOfTree(tree, lines, parser) {
    const macros = findMacrosInTree(tree, lines, parser);
    const directives = findDirectiveMacrosInTree(tree, lines);
    return directives.length > 0 ? macros.concat(directives) : macros;
}

function findMacros(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const primary = macrosOfTree(tree, lines, parser);
    const literal = literalRecoveryTree(parser, code, tree);
    return literal ? mergeExtracted(primary,
        macrosOfTree(literal, lines, parser),
        item => `${item.name}:${item.startLine}:${item.functionLike ? 1 : 0}`) : primary;
}

let cppLanguage = null;
function isCppTree(tree) {
    if (!tree?.language) return false;
    if (!cppLanguage) cppLanguage = require('./index').getParser('cpp').getLanguage();
    return tree.language === cppLanguage;
}

/**
 * A declaration or definition the grammar built from a macro invocation
 * (fix #385): `NAME(args);` or `NAME(args) { ... }` with no type, outside a
 * class body, whose declarator is a plain name (not a constructor,
 * destructor, operator or deduction guide). C++ has no implicit int, so such
 * a declaration can only be an invocation (`TEST(suite, name) { }`,
 * `DECLARE_HANDLER(x);`) unless the file declares a class of that name (a
 * constructor whose class head the grammar lost); in C, where implicit int
 * is old but valid syntax, and in C++ as well, it is one when the file's own
 * function-like macro of that name is in effect there.
 */
// Scopes a declaration can sit in at namespace level: the translation
// unit, namespace and linkage-specification bodies, and preprocessor
// conditionals among them.
const NAMESPACE_SCOPE_CONTAINERS = new Set([
    'translation_unit', 'declaration_list', 'namespace_definition',
    'linkage_specification', 'preproc_if', 'preproc_ifdef', 'preproc_else',
    'preproc_elif', 'preproc_elifdef',
]);

function atNamespaceScope(node) {
    for (let up = node?.parent; up; up = up.parent) {
        if (up.type === 'translation_unit') return true;
        if (!NAMESPACE_SCOPE_CONTAINERS.has(up.type)) return false;
    }
    return false;
}

/**
 * Top-level comma-separated arguments of a parenthesized list's text,
 * respecting nested brackets and string/char literals.
 */
function splitInvocationArguments(text) {
    const inner = String(text || '').replace(/^\s*\(/, '').replace(/\)\s*$/, '');
    const args = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            current += ch;
            if (ch === '\\' && i + 1 < inner.length) current += inner[++i];
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === '\'') { quote = ch; current += ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
        else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            args.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) args.push(current);
    return args;
}

const fileMacrosByTree = new WeakMap();
function fileFunctionMacros(tree) {
    if (!tree) return null;
    if (!fileMacrosByTree.has(tree)) fileMacrosByTree.set(tree, directiveFunctionMacros(treeText(tree)));
    return fileMacrosByTree.get(tree);
}

// Tokens a function head can end with: its parameter list, a trailing
// return type or template argument list, or a specifier after the
// parameters.
const FUNCTION_HEAD_END_WORDS = new Set([
    'const', 'volatile', 'override', 'final', 'noexcept', 'throw', 'mutable', 'constexpr',
]);

function endsFunctionHead(body) {
    const tokens = lexPP(String(body || ''));
    const last = tokens[tokens.length - 1];
    if (!last) return false;
    if (last.v === ')' || last.v === '>' || last.v === '&' || last.v === '&&') return true;
    // A name completes a head only as a specifier or a trailing return
    // type (`-> T`); a macro argument there (`name ## Test`) cannot tell.
    return last.k === 'id' && (FUNCTION_HEAD_END_WORDS.has(last.v) ||
        tokens.some(token => token.v === '->'));
}

function significantSibling(node, direction) {
    let current = direction < 0 ? node.previousSibling : node.nextSibling;
    while (current && current.type === 'comment') {
        current = direction < 0 ? current.previousSibling : current.nextSibling;
    }
    return current;
}

function lastLeafOf(node) {
    let current = node;
    while (current && current.childCount > 0) current = current.child(current.childCount - 1);
    return current;
}

/**
 * Whether `node` begins a new declaration: nothing precedes it in its scope,
 * or what precedes it is complete (`;`, `}`), a scope's `{`, a directive, or
 * the condition line of the conditional it sits in. Comments are skipped.
 * Returns null when the previous entry is unterminated (the caller decides).
 */
function followsDeclarationBoundary(node) {
    const previous = significantSibling(node, -1);
    if (!previous || previous.type === '{' || previous.type === '\n' ||
        previous.type.startsWith('preproc_') || previous.type.startsWith('#')) return true;
    const parent = node.parent;
    if (parent?.type.startsWith('preproc_') &&
        (sameNode(parent.childForFieldName('condition'), previous) ||
         sameNode(parent.childForFieldName('name'), previous))) return true;
    if (previous.type === 'ERROR') return false;
    const leaf = lastLeafOf(previous);
    if (leaf && !leaf.isMissing && (leaf.type === ';' || leaf.type === '}')) return true;
    return null;
}

const LITERAL_ARGUMENT_TYPES = new Set([
    'string_literal', 'raw_string_literal', 'concatenated_string', 'char_literal',
    'number_literal', 'true', 'false', 'null', 'nullptr',
]);

// An unterminated declaration that can be a function head: a function
// declarator, or a parenthesized initializer holding no literal (`A::f()`
// reads as `A::f` initialized by `()`); a literal argument makes it a macro
// invocation line (`SUPPRESS_WARNING("-Wx")`).
function openFunctionHead(previous) {
    if (previous.type !== 'declaration' && previous.type !== 'field_declaration') return false;
    if (functionDeclarator(previous)) return true;
    return (previous.namedChildren || []).some(child => {
        if (child.type !== 'init_declarator') return false;
        const value = child.childForFieldName('value');
        return value?.type === 'argument_list' &&
            !(value.namedChildren || []).some(arg => LITERAL_ARGUMENT_TYPES.has(arg.type));
    });
}

function startsDeclaration(head) {
    const boundary = followsDeclarationBoundary(head);
    if (boundary !== null) return boundary;
    // An unterminated function head (`void f() const` then
    // `LOCK_ANNOTATION(mu) { ... }` on the next line) owns what follows: the
    // invocation annotates it. Any other unterminated entry is itself a
    // declaration-level macro invocation written without `;`.
    return !openFunctionHead(significantSibling(head, -1));
}

// Siblings scanned after a candidate body for the stray `}` that marks an
// early-closed enclosing function.
const DEBRIS_SCAN_LIMIT = 64;

function endsInDeclarationContext(last) {
    // A body the grammar closed early leaves the enclosing function's
    // remaining statements at namespace scope and its real `}` stray:
    // `FMT_TRY { .. } FMT_CATCH(...) {} f(x); }`. Any complete declaration
    // before such a brace ends the scan.
    let next = significantSibling(last, 1);
    for (let scanned = 0; next && scanned < DEBRIS_SCAN_LIMIT; scanned++) {
        if (next.type === 'ERROR') {
            if (next.text.trimStart().startsWith('}')) return false;
        } else if (next.type === 'function_definition' || next.type === 'declaration' ||
            next.type === 'namespace_definition' || next.type === 'template_declaration' ||
            next.type === 'compound_statement' || next.type === 'linkage_specification' ||
            next.type === '}' || next.type.endsWith('_specifier')) {
            return true;
        }
        next = significantSibling(next, 1);
    }
    return true;
}

/**
 * fix #391: the callable a macro invocation with a body defines at
 * namespace scope. `M(args) { body }` compiles only when M's expansion ends
 * in a function head, so the body is a function body invoked through code
 * the expansion generates (test registration, handler tables). The grammar
 * reads the invocation either as a typeless function definition (C++, see
 * macroInvocationDeclaration) or as a call statement missing its `;`
 * followed by a compound statement at namespace scope (string arguments).
 * The generated name is not spelled in the source: it is built from the
 * invocation's arguments (identifiers and string contents joined by `_`),
 * or the macro name when they yield none; the record carries
 * `generatedByMacro`. Returns null for any other shape.
 */
function generatedCallableOf(node, lines) {
    let head;
    let macroNode;
    let argsNode;
    let body;
    if (node.type === 'function_definition') {
        const declarator = node.childForFieldName('declarator');
        body = node.childForFieldName('body');
        if (body?.type !== 'compound_statement' || declarator?.type !== 'function_declarator') return null;
        macroNode = declarator.childForFieldName('declarator');
        argsNode = declarator.childForFieldName('parameters');
        head = node;
    } else if (node.type === 'compound_statement') {
        const parentType = node.parent?.type;
        if (parentType !== 'translation_unit' && parentType !== 'declaration_list' &&
            !String(parentType || '').startsWith('preproc_')) return null;
        let previous = node.previousNamedSibling;
        while (previous?.type === 'comment') previous = previous.previousNamedSibling;
        if (previous?.type !== 'expression_statement') return null;
        const semicolon = previous.lastChild;
        if (semicolon?.type === ';' && !semicolon.isMissing) return null;
        const call = previous.namedChild(0);
        if (call?.type !== 'call_expression') return null;
        macroNode = call.childForFieldName('function');
        argsNode = call.childForFieldName('arguments');
        body = node;
        head = previous;
    } else {
        return null;
    }
    if (macroNode?.type !== 'identifier' || !argsNode || !atNamespaceScope(head)) return null;
    // The invocation starts a declaration: what precedes it is complete
    // (`;`, `}`, a namespace `{`, a directive). A head the grammar left
    // open (`void f() LOCK_ANNOTATION(mu) { ... }`) makes it an annotation
    // of that head, not an invocation of its own.
    if (!startsDeclaration(head)) return null;
    // What follows is a declaration or another such invocation. A statement
    // at namespace scope, or a stray `}`, means the grammar lost the head of
    // an enclosing function (`FMT_TRY { .. } FMT_CATCH(...) {}` after an
    // early-closed body): recovery debris, not a generated callable.
    if (!endsInDeclarationContext(body.type === 'compound_statement' && head !== node ? node : head)) return null;
    const macroName = macroNode.text;
    // A macro the file defines is read: its expansion must end in a function
    // head for a body to follow it (a replacement list that declares a
    // class, `... };`, is not one).
    const macros = fileFunctionMacros(node.tree);
    const definition = macros && definitionInEffect(macros, macroName, head.startPosition.row + 1);
    if (definition && !endsFunctionHead(definition.body)) return null;
    const parts = [];
    // Arguments spelled as plain identifiers: a class they name may be the
    // scope the expansion puts the body in (fix #396).
    const names = [];
    for (const arg of splitInvocationArguments(argsNode.text)) {
        const cleaned = arg.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        if (cleaned) parts.push(cleaned);
        const trimmed = arg.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed)) names.push(trimmed);
    }
    let name = parts.join('_') || macroName;
    if (/^[0-9]/.test(name)) name = `${macroName}_${name}`;
    const startLine = head.startPosition.row + 1;
    const endLine = body.endPosition.row + 1;
    const namespace = enclosingNamespace(head);
    return {
        name,
        params: '...',
        returnType: null,
        startLine,
        endLine,
        indent: head.startPosition.column,
        modifiers: [],
        ...(namespace && { namespace }),
        generatedByMacro: { name: macroName, ...(names.length > 0 && { args: names }) },
        docstring: extractJSDocstring(lines, startLine),
    };
}

function macroInvocationDeclaration(node) {
    if (!FUNCTION_CONTAINERS.has(node.type) || node.childForFieldName('type')) return false;
    const declarator = node.childForFieldName('declarator');
    if (declarator?.type !== 'function_declarator') return false;
    const name = declarator.childForFieldName('declarator');
    if (name?.type !== 'identifier') return false;
    if ((declarator.namedChildren || []).some(child => child.type === 'trailing_return_type')) return false;
    for (let up = node.parent; up; up = up.parent) {
        if (up.type === 'field_declaration_list') return false;
        if (up.type === 'translation_unit') break;
    }
    const invocations = macroInvocationsByTree.get(node.tree) || [];
    if (invocations.some(invocation => invocation.start === name.startIndex)) return true;
    if (!isCppTree(node.tree)) return false;
    // Typeless in the tree is not typeless in the source when a type token
    // precedes the name (`static basic_json binary(...)` after a decoration
    // macro the grammar could not place): the declaration only lost its
    // type to a syntax error.
    const text = treeText(node.tree);
    let before = name.startIndex - 1;
    for (;;) {
        while (before >= 0 && /\s/.test(text[before])) before--;
        if (before >= 1 && text[before] === '/' && text[before - 1] === '*') {
            const open = text.lastIndexOf('/*', before - 2);
            if (open < 0) break;
            before = open - 1;
            continue;
        }
        break;
    }
    // A declaration boundary the text scan cannot see: a directive line or a
    // line comment before the name (fix #391).
    if (before >= 0 && !';{}):'.includes(text[before]) &&
        followsDeclarationBoundary(node) !== true) return false;
    // A class of that name in the file: a constructor whose class head the
    // grammar lost (`class API Matcher<T> : ...`), not an invocation.
    return !classNamesOf(node.tree).has(name.text);
}

const textByTree = new WeakMap();
function treeText(tree) {
    let text = textByTree.get(tree);
    if (text === undefined) {
        text = tree.rootNode.text;
        textByTree.set(tree, text);
    }
    return text;
}

const classNamesByTree = new WeakMap();
/**
 * Names that follow a class key in the file's tokens (`class N`,
 * `struct API N`), whether or not the grammar recovered the class.
 */
function classNamesOf(tree) {
    let names = classNamesByTree.get(tree);
    if (!names) {
        names = new Set();
        const tokens = lexPP(treeText(tree));
        for (let i = 0; i + 1 < tokens.length; i++) {
            if (tokens[i].k !== 'id' || !CLASS_KEYS.has(tokens[i].v) || tokens[i + 1].k !== 'id') continue;
            names.add(tokens[i + 1].v);
            if (tokens[i + 2]?.k === 'id') names.add(tokens[i + 2].v);
        }
        classNamesByTree.set(tree, names);
    }
    return names;
}
const CLASS_KEYS = new Set(['class', 'struct', 'union']);

function enclosingFunctionOf(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_definition') {
            // Code inside a macro invocation read as a definition belongs to
            // whatever the expansion declares, not to a function of the
            // macro's name (fix #385).
            if (macroInvocationDeclaration(parent)) return null;
            const identity = declaratorIdentity(functionDeclarator(parent));
            return identity.name ? {
                name: identity.name,
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
                ...(identity.className && {
                    className: identity.className,
                }),
            } : null;
        }
    }
    return null;
}

function typeName(node) {
    if (!node) return null;
    let text = node.text;
    text = text.replace(/\b(const|volatile|struct|class|typename)\b/g, '').trim();
    text = text.replace(/[*&]+/g, '').trim();
    // Strip template arguments before splitting namespace qualifiers.
    // `dynamic_store<fmt::context<Char>>` contains `::` inside its template
    // arguments; splitting first produced the bogus receiver type
    // `context>` and discarded otherwise compiler-visible ownership.
    const templateStart = text.indexOf('<');
    if (templateStart >= 0) text = text.slice(0, templateStart).trim();
    const parts = text.split(/::/);
    return parts[parts.length - 1].trim() || null;
}

function variableBindingScope(node) {
    const parameter = node.type === 'parameter_declaration';
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parameter && parent.type === 'function_definition') return parent;
        if (!parameter && (parent.type === 'compound_statement' ||
            parent.type === 'translation_unit')) {
            return parent;
        }
    }
    return treeRoot(node);
}

function treeRoot(node) {
    let current = node;
    while (current?.parent) current = current.parent;
    return current;
}

function variableDeclarators(node) {
    if (node.type === 'parameter_declaration') {
        const declarator = node.childForFieldName('declarator');
        return declarator ? [declarator] : [];
    }
    // An initializer can contain a call expression whose nested syntax looks
    // declarator-like to the generic recursive probe. The declaration itself
    // is still unequivocally a value binding (`T value = factory()`), so keep
    // its init_declarator before asking whether the outer node is callable.
    const initialized = (node.namedChildren || []).filter(child =>
        child.type === 'init_declarator');
    if (initialized.length > 0) return initialized;
    if (functionDeclarator(node)) return [];
    return (node.namedChildren || []).filter(child =>
        child.type !== 'attribute_specifier' &&
        !TYPE_NODES.has(child.type));
}

/**
 * Scope- and position-aware declared-type bindings.
 *
 * A file-global Map is unsound for C/C++: a later `auto specs` in an
 * unrelated function used to overwrite an earlier `format_specs specs`
 * parameter, changing every receiver in the file. Bindings are instead
 * selected from scopes containing the use, with the nearest scope and latest
 * preceding declaration winning. `auto` deliberately contributes no static
 * type; assigned-call return flow handles it separately.
 */
/**
 * The namespace path a declaration's type is written under (fix #371):
 * `std::mutex m` -> { namespace: 'std', name: 'mutex' }; `::std::chrono::duration<int>`
 * -> { namespace: '::std::chrono', name: 'duration' }. null when unqualified or dependent.
 */
function writtenTypeNamespace(typeNode) {
    let node = typeNode;
    const parts = [];
    while (node?.type === 'qualified_identifier') {
        const scope = node.childForFieldName('scope');
        if (!scope) parts.push('');
        else if (scope.type === 'namespace_identifier') parts.push(scope.text);
        else return null;
        node = node.childForFieldName('name');
    }
    if (parts.length === 0) return null;
    if (!node || !['type_identifier', 'template_type'].includes(node.type)) return null;
    const terminal = node.type === 'template_type' ? node.childForFieldName('name')?.text : node.text;
    return terminal ? { namespace: parts.join('::'), name: terminal } : null;
}

function buildVariableTypes(tree) {
    const bindings = [];
    const fieldTypes = new Map();
    // tree-sitter must preserve C++'s most-vexing-parse ambiguity and can
    // represent `T value(factory())` as a block-scope function declarator.
    // A later `value.method()` use proves that spelling denotes an object in
    // compiling code: a function declaration cannot be a member receiver.
    // Record only those use-proven direct initializers, never every ambiguous
    // block declaration.
    const memberReceiverUses = [];
    const ambiguousDirectInitializers = [];
    const autoElementInitializers = [];
    const declaratorStaticType = (type, declarator, holder) => {
        // The declaration's type node carries only the base type. Preserve
        // array rank from the AST declarator for overload arguments:
        // `wchar_t format_str[]; runtime(format_str)` passes a wide-character
        // array (and decays to wchar_t*), not a scalar wchar_t. Receiver
        // typing continues to use the base `type`; only static argument shape
        // consumes this fuller spelling.
        let arrays = 0;
        const stack = [declarator];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;
            if (current.type === 'array_declarator') arrays++;
            for (const child of current.namedChildren || []) stack.push(child);
        }
        if (arrays > 0) return `${type}${'[]'.repeat(arrays)}`;
        // Pointer levels are part of the argument's type (fix #393):
        // `const char* format` passes a C string, never a `char`. The chain
        // of declarators is followed (an initializer's own declarators are
        // not this variable's); a function declarator (function pointer)
        // keeps the base type. The pointee's const qualifier is kept, as it
        // decides overloads (`f(char*)` versus `f(const char*)`).
        let pointers = 0;
        for (let current = declarator; current;) {
            if (current.type === 'function_declarator') return type;
            if (current.type === 'pointer_declarator') pointers++;
            current = current.type === 'init_declarator' || current.type === 'pointer_declarator' ||
                current.type === 'reference_declarator' || current.type === 'parenthesized_declarator'
                ? (current.childForFieldName('declarator') ||
                    (current.namedChildren || []).find(child =>
                        child.type.endsWith('declarator') || child.type === 'identifier'))
                : null;
        }
        if (pointers === 0) return type;
        const pointeeConst = (holder?.children || []).some(child =>
            child.type === 'type_qualifier' && child.text === 'const');
        return `${pointeeConst ? 'const ' : ''}${type} ${'*'.repeat(pointers)}`;
    };
    const addBindings = (node, type, pointeeType, scope, declarators, containerElementType, typeNamespace) => {
        for (const declarator of declarators) {
            const identity = declaratorIdentity(declarator);
            if (!identity.name) continue;
            // `T items[]` / `T items[N]` (one rank, no pointer) index to T.
            let arrays = 0;
            let pointers = 0;
            const walk = [declarator];
            while (walk.length > 0) {
                const current = walk.pop();
                if (!current) continue;
                if (current.type === 'array_declarator') arrays++;
                if (current.type === 'pointer_declarator') pointers++;
                if (current.type === 'init_declarator') {
                    walk.push(current.childForFieldName('declarator'));
                    continue;
                }
                for (const child of current.namedChildren || []) {
                    if (child.type.endsWith('declarator') || child.type === 'identifier') walk.push(child);
                }
            }
            const elementType = arrays === 1 && pointers === 0 ? type
                : (arrays === 0 && pointers === 0 ? containerElementType : undefined);
            bindings.push({
                ...(elementType && { elementType }),
                name: identity.name,
                type,
                staticType: declaratorStaticType(type, declarator, node),
                origin: typeOrigin(node.type === 'declaration' &&
                    (declarator.type === 'identifier' ||
                     declarator.childForFieldName('value')?.type === 'new_expression')
                    ? 'constructor' : 'annotation', declarator),
                ...(pointeeType && { pointeeType }),
                ...(pointers === 0 && arrays === 0 && { valueDeclarator: true }),
                ...(typeNamespace?.name === type && { typeNamespace: typeNamespace.namespace }),
                declaredAt: node.type === 'parameter_declaration'
                    ? scope.startIndex : declarator.startIndex,
                scopeStart: scope.startIndex,
                scopeEnd: scope.endIndex,
            });
        }
    };
    traverseTreeCached(tree.rootNode, node => {
        if (node.type === 'field_expression') {
            const argument = node.childForFieldName('argument') || node.namedChild(0);
            if (argument?.type === 'identifier') {
                memberReceiverUses.push({ name: argument.text, at: argument.startIndex });
            }
            return true;
        }
        if (node.type === 'field_declaration' && !functionDeclarator(node)) {
            const owner = enclosingClassName(node);
            const typeNode = node.childForFieldName('type') ||
                node.namedChildren.find(child => TYPE_NODES.has(child.type));
            const fieldType = typeName(typeNode);
            if (!owner || !fieldType) return true;
            for (const child of node.namedChildren || []) {
                if (!IDENTIFIER_NODES.has(child.type) &&
                    child.type !== 'field_declarator') continue;
                const identity = declaratorIdentity(child);
                if (identity.name && identity.name !== typeNode?.text) {
                    fieldTypes.set(`${owner}.${identity.name}`, fieldType);
                }
            }
            return true;
        }
        if (node.type !== 'parameter_declaration' && node.type !== 'declaration') {
            return true;
        }
        const typeNode = node.childForFieldName('type') ||
            (node.namedChildren || []).find(child => TYPE_NODES.has(child.type));
        const type = typeName(typeNode);
        if (type === 'auto') {
            // `auto &c = items[i]` binds the declared element (fix #359);
            // resolved after the walk, when every container binding exists.
            for (const declarator of variableDeclarators(node)) {
                if (declarator.type !== 'init_declarator') continue;
                const value = declarator.childForFieldName('value');
                const root = value?.type === 'subscript_expression'
                    ? (value.childForFieldName('argument') || value.namedChild(0)) : null;
                if (root?.type === 'identifier') {
                    autoElementInitializers.push({
                        node, declarator, root, scope: variableBindingScope(node),
                    });
                }
            }
            return true;
        }
        if (!type) return true;
        const pointeeType = (() => {
            const raw = String(typeNode?.text || '')
                .replace(/\b(const|volatile|class|struct|typename)\b/g, '')
                .trim();
            const match = raw.match(
                /^(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|auto_ptr)\s*<\s*(.+)\s*>$/s);
            if (!match) return undefined;
            let depth = 0;
            for (const character of match[1]) {
                if (character === '<') depth++;
                else if (character === '>') depth--;
                else if (character === ',' && depth === 0) return undefined;
            }
            return typeName({ text: match[1] }) || undefined;
        })();
        // Declared subscript element (fix #359): std sequence/map containers
        // index to their element slot. C arrays are handled per declarator.
        const containerElementType = (() => {
            const raw = String(typeNode?.text || '')
                .replace(/\b(const|volatile|class|struct|typename)\b/g, '')
                .trim();
            const open = raw.indexOf('<');
            if (open <= 0 || !raw.endsWith('>')) return undefined;
            const base = raw.slice(0, open).replace(/\s+/g, '').replace(/^std::/, '');
            const args = [];
            let depth = 0;
            let start = open + 1;
            for (let i = open + 1; i < raw.length - 1; i++) {
                const character = raw[i];
                if (character === '<' || character === '(' || character === '[') depth++;
                else if (character === '>' || character === ')' || character === ']') depth--;
                else if (character === ',' && depth === 0) {
                    args.push(raw.slice(start, i).trim());
                    start = i + 1;
                }
            }
            args.push(raw.slice(start, raw.length - 1).trim());
            let element;
            if (['vector', 'deque'].includes(base) && args.length <= 2) element = args[0];
            else if (base === 'array' && args.length === 2) element = args[0];
            else if (['map', 'unordered_map'].includes(base) && args.length >= 2 &&
                args.length <= 4) element = args[1];
            if (!element || /[*&]/.test(element)) return undefined;
            return typeName({ text: element }) || undefined;
        })();
        const scope = variableBindingScope(node);
        const declarators = variableDeclarators(node);
        if (declarators.length === 0 && node.type === 'declaration' &&
            node.parent?.type === 'compound_statement') {
            const direct = node.childForFieldName('declarator');
            const identity = direct?.type === 'function_declarator'
                ? declaratorIdentity(direct) : null;
            if (identity?.name) {
                ambiguousDirectInitializers.push({
                    node, type, pointeeType, scope, direct, name: identity.name,
                });
            }
            return true;
        }
        addBindings(node, type, pointeeType, scope, declarators, containerElementType,
            writtenTypeNamespace(typeNode));
        return true;
    });
    for (const candidate of ambiguousDirectInitializers) {
        if (memberReceiverUses.some(use =>
            use.name === candidate.name &&
            use.at > candidate.direct.endIndex &&
            candidate.scope.startIndex <= use.at &&
            use.at < candidate.scope.endIndex)) {
            addBindings(candidate.node, candidate.type, candidate.pointeeType,
                candidate.scope, [candidate.direct]);
        }
    }
    for (const candidate of autoElementInitializers) {
        const at = candidate.root.startIndex;
        const containers = bindings.filter(binding =>
            binding.name === candidate.root.text &&
            binding.scopeStart <= at && at < binding.scopeEnd &&
            binding.declaredAt <= at);
        containers.sort((a, b) => (a.scopeEnd - a.scopeStart) - (b.scopeEnd - b.scopeStart) ||
            b.declaredAt - a.declaredAt);
        const elementType = containers[0]?.elementType;
        if (elementType) {
            addBindings(candidate.node, elementType, undefined, candidate.scope,
                [candidate.declarator]);
        }
    }
    // Bindings are complete before call extraction. Partition by spelling
    // once: every argument and receiver lookup otherwise scans all locals
    // in the translation unit, including unrelated functions.
    const bindingsByName = new Map();
    for (const binding of bindings) {
        let named = bindingsByName.get(binding.name);
        if (!named) { named = []; bindingsByName.set(binding.name, named); }
        named.push(binding);
    }
    for (const named of bindingsByName.values()) {
        named.sort((a, b) => (a.scopeEnd - a.scopeStart) - (b.scopeEnd - b.scopeStart) ||
            b.declaredAt - a.declaredAt);
    }
    const resolveBinding = (name, atNode) => {
        if (!name || !atNode) return undefined;
        const at = atNode.startIndex;
        return bindingsByName.get(name)?.find(binding =>
            binding.scopeStart <= at && at < binding.scopeEnd &&
            binding.declaredAt <= at);
    };
    return {
        get: (name, atNode) => resolveBinding(name, atNode)?.type,
        getStatic: (name, atNode) => resolveBinding(name, atNode)?.staticType,
        evidence: (name, atNode) => {
            const binding = resolveBinding(name, atNode);
            return { receiverTypeSource: binding?.origin?.source || 'unknown',
                ...(binding && { receiverTypeEvidence: { ...binding.origin, name, type: binding.type } }),
                ...(binding?.typeNamespace && { receiverTypeNamespace: binding.typeNamespace }),
            };
        },
        getPointee: (name, atNode) =>
            resolveBinding(name, atNode)?.pointeeType,
        // fix #379: `v->m()` on a variable declared as an object (no
        // pointer declarator) goes through the class's operator->: the
        // declared type is a smart pointer or iterator (possibly behind an
        // alias), never the owner of m.
        arrowThroughObject: (name, atNode) => {
            const binding = resolveBinding(name, atNode);
            return !!binding && !binding.pointeeType && !!binding.valueDeclarator;
        },
        getElement: (name, atNode) =>
            resolveBinding(name, atNode)?.elementType,
        has: (name, atNode) => resolveBinding(name, atNode) !== undefined,
        fieldTypes,
    };
}

function stringLiteralKind(node) {
    const text = node?.text || '';
    if (text.startsWith('L"') || text.startsWith('LR"')) {
        return 'string:wchar_t';
    }
    if (text.startsWith('u8"') || text.startsWith('u8R"')) {
        return 'string:char8_t';
    }
    if (text.startsWith('u"') || text.startsWith('uR"')) {
        return 'string:char16_t';
    }
    if (text.startsWith('U"') || text.startsWith('UR"')) {
        return 'string:char32_t';
    }
    return 'string:char';
}

function literalPrefixKind(node, base) {
    const text = node?.text || '';
    if (text.startsWith('L')) return `${base}:wchar_t`;
    if (text.startsWith('u8')) return `${base}:char8_t`;
    if (text.startsWith('u')) return `${base}:char16_t`;
    if (text.startsWith('U')) return `${base}:char32_t`;
    return `${base}:char`;
}

/**
 * Compiler-visible argument shape for conservative C++ overload pruning.
 *
 * Every branch starts from an AST-classified expression node. Text is used
 * only to distinguish literal prefixes/suffixes or recover the type spelling
 * carried by that node; unknown expressions deliberately stay `expr`.
 */
function staticArgumentKind(node, variableTypes) {
    if (!node) return 'expr';
    if (node.type === 'parenthesized_expression') {
        return staticArgumentKind(node.namedChild(0), variableTypes);
    }
    if (node.type === 'string_literal' || node.type === 'raw_string_literal') {
        return stringLiteralKind(node);
    }
    if (node.type === 'concatenated_string') {
        const parts = (node.namedChildren || [])
            .filter(child => child.type === 'string_literal' ||
                child.type === 'raw_string_literal')
            .map(stringLiteralKind);
        return parts.length > 0 && parts.every(kind => kind === parts[0])
            ? parts[0] : 'expr';
    }
    if (node.type === 'char_literal') {
        return literalPrefixKind(node, 'char');
    }
    if (node.type === 'number_literal') {
        const text = node.text || '';
        const floating = text.includes('.') ||
            /[pP][+-]?[0-9]/.test(text) ||
            /[eE][+-]?[0-9]/.test(text) ||
            /[fF]$/.test(text);
        return floating ? 'number:floating' : 'number:integer';
    }
    if (node.type === 'true' || node.type === 'false') return 'bool';
    if (node.type === 'null' || node.type === 'nullptr') return 'null';
    if (node.type === 'identifier') {
        const type = variableTypes?.getStatic(node.text, node) ||
            variableTypes?.get(node.text, node);
        return type ? `type:${type}` : 'expr';
    }
    if (node.type === 'compound_literal_expression') {
        const typeNode = node.childForFieldName('type') ||
            (node.namedChildren || []).find(child =>
                TYPE_NODES.has(child.type) || child.type === 'type_descriptor');
        const type = typeName(typeNode);
        return type ? `type:${type}` : 'expr';
    }
    if (node.type === 'new_expression') {
        const typeNode = node.childForFieldName('type') ||
            (node.namedChildren || []).find(child =>
                TYPE_NODES.has(child.type) || child.type === 'type_descriptor');
        const type = typeName(typeNode);
        return type ? `type:${type}` : 'expr';
    }
    if (node.type === 'cast_expression') {
        const typeNode = node.childForFieldName('type') ||
            (node.namedChildren || []).find(child =>
                TYPE_NODES.has(child.type) || child.type === 'type_descriptor');
        const type = typeName(typeNode);
        return type ? `type:${type}` : 'expr';
    }
    if (node.type === 'call_expression') {
        const fnNode = node.childForFieldName('function');
        const identity = callIdentity(fnNode);
        if (identity.name === 'static_cast' || identity.name === 'dynamic_cast' ||
            identity.name === 'const_cast' || identity.name === 'reinterpret_cast') {
            const typeNode = fnNode?.childForFieldName('type') ||
                (fnNode?.namedChildren || []).find(child =>
                    child.type === 'type_descriptor' || TYPE_NODES.has(child.type));
            const type = typeName(typeNode);
            if (type) return `type:${type}`;
        }
        // Bare-identifier producers are name-resolvable (fix #299B): mark
        // them `bcall:` so the overload discipline can type the argument
        // from the producer's declared return type. A local callable
        // variable shadows the project name — those record plain 'expr'
        // (the #203 localShadow rule at kind-recording time). Member,
        // qualified, and template-explicit producers keep `call:NAME`.
        if (identity.name && !identity.isMethod && !identity.isPathCall &&
            identity.nameNode && IDENTIFIER_NODES.has(identity.nameNode.type) &&
            fnNode && IDENTIFIER_NODES.has(fnNode.type)) {
            if (variableTypes?.get(identity.name, node)) return 'expr';
            return `bcall:${identity.name}`;
        }
        return identity.name ? `call:${identity.name}` : 'expr';
    }
    return 'expr';
}

function callArguments(node, variableTypes) {
    const args = node.childForFieldName('arguments');
    if (!args) return { argCount: 0, argKinds: [] };
    const values = args.namedChildren.filter(child => !child.type.endsWith('comment'));
    return {
        argCount: values.length,
        argKinds: values.map(value => staticArgumentKind(value, variableTypes)),
        firstArg: values[0],
    };
}

const templateScopesByTree = new WeakMap();

// Template-parameter scopes of a tree, by parameter name: one native query
// per tree, and a qualified call checks only the scopes declaring its
// qualifier (fix #365: every call scanned every template scope).
function templateScopes(tree) {
    let scopes = templateScopesByTree.get(tree);
    if (scopes) return scopes;
    scopes = new Map(); // name -> [{ start, end }]
    for (const declaration of tree.rootNode.descendantsOfType('template_declaration')) {
        const names = [];
        const parameters = declaration.childForFieldName('parameters');
        for (const parameter of parameters?.namedChildren || []) {
            if (!parameter.type.endsWith('parameter_declaration') ||
                parameter.type === 'parameter_declaration' ||
                parameter.type === 'optional_parameter_declaration') continue;
            const nameNode = parameter.childForFieldName('name') ||
                (parameter.namedChildren || []).find(child =>
                    child.type === 'type_identifier');
            if (nameNode?.text) names.push(nameNode.text);
        }
        if (names.length === 0) continue;
        const range = { start: declaration.startIndex, end: declaration.endIndex };
        for (const name of names) {
            if (!scopes.has(name)) scopes.set(name, []);
            scopes.get(name).push(range);
        }
    }
    templateScopesByTree.set(tree, scopes);
    return scopes;
}

/**
 * Is `name` a type parameter of a template enclosing `node`? A qualifier
 * rooted in one (`T::parse(...)`) is a dependent type: which class it names
 * is decided per instantiation, so it is never evidence for or against a
 * particular project class.
 */
function enclosedByTemplateParameter(node, name) {
    if (!name || !node?.tree) return false;
    const ranges = templateScopes(node.tree).get(name);
    if (!ranges) return false;
    const start = node.startIndex;
    const end = node.endIndex;
    return ranges.some(range => range.start <= start && end <= range.end);
}

function callIdentity(fnNode) {
    if (!fnNode) return {};
    if (fnNode.type === 'type_descriptor') {
        return callIdentity(fnNode.childForFieldName('type') ||
            fnNode.namedChild(0));
    }
    if (fnNode.type === 'parenthesized_expression') {
        return callIdentity(fnNode.namedChild(0));
    }
    if (IDENTIFIER_NODES.has(fnNode.type)) {
        return { name: fnNode.text, nameNode: fnNode, isMethod: false };
    }
    if (fnNode.type === 'field_expression') {
        let nameNode = fnNode.childForFieldName('field') ||
            fnNode.namedChildren[fnNode.namedChildCount - 1];
        // `obj.conv<long>()` / `obj.template conv<long>()` (fix #378): the
        // member is the template_method's name, the arguments are explicit
        // template arguments.
        if (nameNode?.type === 'dependent_name') nameNode = nameNode.namedChild(0);
        const explicitTemplateCall = nameNode?.type === 'template_method';
        if (explicitTemplateCall) {
            nameNode = nameNode.childForFieldName('name') || nameNode.namedChild(0);
        }
        const receiverNode = fnNode.childForFieldName('argument') || fnNode.namedChild(0);
        return {
            name: nameNode?.text,
            nameNode,
            ...(explicitTemplateCall && { explicitTemplateCall: true }),
            isMethod: true,
            receiver: receiverNode?.text,
            receiverNode,
            pointerAccess: (fnNode.children || []).some(child =>
                child.type === '->'),
        };
    }
    if (fnNode.type === 'qualified_identifier') {
        const rawNameNode = fnNode.childForFieldName('name') ||
            fnNode.namedChildren[fnNode.namedChildCount - 1];
        const scopeNode = fnNode.childForFieldName('scope') || fnNode.namedChild(0);
        const globalQualified = fnNode.text.startsWith('::') &&
            (!scopeNode || sameNode(scopeNode, rawNameNode));
        if (globalQualified) {
            return {
                name: rawNameNode?.text,
                nameNode: rawNameNode,
                isMethod: false,
                isPathCall: true,
                globalQualified: true,
            };
        }
        const nested = rawNameNode?.type === 'template_function' ||
            rawNameNode?.type === 'qualified_identifier'
            ? callIdentity(rawNameNode) : null;
        const qualifierRoot = String(scopeNode?.text || '')
            .replace(/<[\s\S]*$/, '').split('::')[0].trim();
        return {
            name: nested?.name || rawNameNode?.text,
            nameNode: nested?.nameNode || rawNameNode,
            isMethod: true,
            receiver: nested?.receiver
                ? `${scopeNode?.text}::${nested.receiver}`
                : scopeNode?.text,
            isPathCall: true,
            ...(nested?.explicitTemplateCall && { explicitTemplateCall: true }),
            ...(enclosedByTemplateParameter(fnNode, qualifierRoot) &&
                { qualifierTemplateParam: true }),
        };
    }
    if (fnNode.type === 'template_function' || fnNode.type === 'template_type') {
        const nested = callIdentity(
            fnNode.childForFieldName('name') || fnNode.namedChild(0));
        return {
            ...nested,
            explicitTemplateCall: true,
        };
    }
    return {};
}

function compileTimeOnlyContext(node) {
    for (let current = node?.parent; current; current = current.parent) {
        // `decltype(f())` forms a compile-time dependency but never executes
        // `f`. Keep it visible to impact analysis without presenting it as a
        // runtime caller. Stop at the nearest callable so an outer declaration
        // cannot accidentally classify calls inside a nested function body.
        if (current.type === 'decltype') return 'decltype';
        if (current.type === 'function_definition' ||
            current.type === 'lambda_expression') return null;
    }
    return null;
}

function recoveredExplicitCallOperator(node, variableTypes) {
    if (node?.type === 'ERROR') {
        const operatorNode = (node.namedChildren || []).find(child =>
            child.type === 'operator_name' && child.text === 'operator()');
        const tokens = new Set((node.children || [])
            .filter(child => !child.isNamed).map(child => child.type));
        const named = node.namedChildren || [];
        const operatorIndex = named.indexOf(operatorNode);
        const templateType = named[operatorIndex + 1];
        const hasTemplateType = TYPE_NODES.has(templateType?.type) ||
            templateType?.type === 'type_descriptor';
        if (!operatorNode || !hasTemplateType ||
            !tokens.has('<') || !tokens.has('>') ||
            !tokens.has('(') || !tokens.has(')')) return null;
        const values = named.slice(operatorIndex + 2);
        return {
            name: 'operator()',
            line: operatorNode.startPosition.row + 1,
            column: operatorNode.startPosition.column,
            isMethod: false,
            explicitTemplateCall: true,
            argCount: values.length,
            argKinds: values.map(value =>
                staticArgumentKind(value, variableTypes)),
            enclosingFunction: enclosingFunctionOf(node),
        };
    }
    if (node?.type !== 'binary_expression') return null;
    const left = node.childForFieldName('left') || node.namedChild(0);
    const right = node.childForFieldName('right') ||
        node.namedChildren[node.namedChildCount - 1];
    if (left?.type !== 'call_expression' || !right) return null;
    const functionNode = left.childForFieldName('function');
    const argumentNode = left.childForFieldName('arguments');
    if (functionNode?.type !== 'identifier' ||
        functionNode.text !== 'operator' ||
        (argumentNode?.namedChildCount || 0) !== 0) return null;
    const errorNode = (node.namedChildren || []).find(
        child => child.type === 'ERROR');
    const hasTemplateType = (errorNode?.namedChildren || []).some(child =>
        TYPE_NODES.has(child.type) || child.type === 'type_descriptor');
    const errorTokens = new Set((errorNode?.children || [])
        .filter(child => !child.isNamed).map(child => child.type));
    const binaryTokens = new Set((node.children || [])
        .filter(child => !child.isNamed).map(child => child.type));
    // tree-sitter-cpp 0.23 recovers `operator()<T>(value)` as
    // `(operator()) < ERROR[T>( value`. This exact AST recovery shape is
    // stronger than a text fallback and prevents the call from disappearing.
    if (!hasTemplateType || !binaryTokens.has('<') ||
        !errorTokens.has('>') || !errorTokens.has('(')) return null;
    const values = commaExpressionValues(right);
    return {
        name: 'operator()',
        line: functionNode.startPosition.row + 1,
        column: functionNode.startPosition.column,
        isMethod: false,
        explicitTemplateCall: true,
        argCount: values.length,
        argKinds: values.map(value =>
            staticArgumentKind(value, variableTypes)),
        enclosingFunction: enclosingFunctionOf(node),
    };
}

function commaExpressionValues(node) {
    if (!node) return [];
    if (node.type !== 'comma_expression') return [node];
    const left = node.childForFieldName('left') || node.namedChild(0);
    const right = node.childForFieldName('right') || node.namedChild(1);
    return [...commaExpressionValues(left), ...commaExpressionValues(right)];
}

function assignmentTargetOf(callNode) {
    let value = callNode;
    let parent = value.parent;
    while (parent?.type === 'parenthesized_expression') {
        value = parent;
        parent = parent.parent;
    }
    if (parent?.type === 'init_declarator' &&
        sameNode(parent.childForFieldName('value'), value)) {
        const identity = declaratorIdentity(parent.childForFieldName('declarator'));
        return identity.name || null;
    }
    if (parent?.type === 'assignment_expression' &&
        sameNode(parent.childForFieldName('right'), value)) {
        const left = parent.childForFieldName('left');
        return left?.type === 'identifier' ? left.text : null;
    }
    return null;
}

function fieldReceiverPath(node) {
    if (!node) return null;
    if (node.type === 'parenthesized_expression') {
        return fieldReceiverPath(node.namedChild(0));
    }
    if (node.type === 'identifier' || node.type === 'this') {
        return { root: node.text, fields: [] };
    }
    if (node.type !== 'field_expression') return null;
    const argument = node.childForFieldName('argument') || node.namedChild(0);
    const field = node.childForFieldName('field') ||
        node.namedChildren[node.namedChildCount - 1];
    const base = fieldReceiverPath(argument);
    if (!base || !field?.text) return null;
    return { root: base.root, fields: [...base.fields, field.text] };
}

/** Macro invocations whose argument expression contains this call node. */
function enclosingMacroArguments(node) {
    const wrappers = [];
    let current = node;
    let hops = 0;
    while (current?.parent && hops++ < 24) {
        const argumentsNode = current.parent;
        const outerCall = argumentsNode?.type === 'argument_list'
            ? argumentsNode.parent : null;
        if (outerCall?.type === 'call_expression') {
            const wrapper = callIdentity(
                outerCall.childForFieldName('function'));
            if (wrapper.name && isMacroToken(wrapper.name)) {
                const args = (argumentsNode.namedChildren || [])
                    .filter(child => !child.type.endsWith('comment'));
                const argIndex = args.findIndex(argument =>
                    argument.startIndex <= node.startIndex &&
                    node.endIndex <= argument.endIndex);
                if (argIndex >= 0) {
                    wrappers.push({ name: wrapper.name, argIndex });
                }
            }
            current = outerCall;
            continue;
        }
        // Once the walk leaves an expression, no outer macro invocation can
        // contain this call. Stopping here keeps the common non-macro path
        // constant-depth instead of climbing every call to the translation
        // unit (material on template-heavy fmt headers).
        if (/(?:statement|declaration|definition)$/.test(
            argumentsNode.type) ||
            argumentsNode.type === 'translation_unit' ||
            argumentsNode.type === 'init_declarator') {
            break;
        }
        current = current.parent;
    }
    return wrappers;
}

/**
 * The name `X` of a parameter `X()` (a type followed by an empty abstract
 * function declarator) of a function declarator declared in a block (fix
 * #401): the shape of `T v(X());` that is an object initialized by a call
 * whenever X is not a type. null for any other parameter.
 */
function vexingParseCallName(node) {
    const list = node.parent;
    const declarator = list?.type === 'parameter_list' ? list.parent : null;
    const declaration = declarator?.type === 'function_declarator' ? declarator.parent : null;
    if (declaration?.type !== 'declaration' || declaration.parent?.type !== 'compound_statement') return null;
    const typeNode = node.childForFieldName('type');
    const abstract = node.childForFieldName('declarator');
    if (typeNode?.type !== 'type_identifier' || abstract?.type !== 'abstract_function_declarator') return null;
    const params = abstract.childForFieldName('parameters');
    if (!params || params.namedChildCount !== 0) return null;
    if (node.namedChildren.some(child => child.type === 'type_qualifier')) return null;
    return typeNode.text;
}

function findCallsInTree(code, parser, _options = {}, existingTree = null,
    includeMacroBodies = true) {
    const tree = existingTree || parseTree(parser, code);
    const variableTypes = buildVariableTypes(tree);
    const fieldTypes = variableTypes.fieldTypes;
    const calls = [];
    traverseTreeCached(tree.rootNode, node => {
        const recoveredOperator = recoveredExplicitCallOperator(
            node, variableTypes);
        if (recoveredOperator) {
            calls.push(recoveredOperator);
            return true;
        }
        // `ModelDB model(CurrentOptions());` in a block (fix #401): the
        // grammar reads a function declaration whose parameter is an
        // unnamed function type; when `CurrentOptions` is no type (decided at
        // query time) it is a call initializing the object.
        if (node.type === 'parameter_declaration' && vexingParseCallName(node)) {
            const nameNode = node.childForFieldName('type');
            calls.push({
                name: nameNode.text,
                line: nameNode.startPosition.row + 1,
                column: nameNode.startPosition.column,
                callStart: node.startIndex,
                callEnd: node.endIndex,
                isMethod: false,
                argCount: 0,
                argKinds: [],
                enclosingFunction: enclosingFunctionOf(node),
                declarationReading: true,
            });
            return false;
        }
        if (node.type === 'call_expression') {
            if (recoveredExplicitCallOperator(node.parent, variableTypes)) {
                return true;
            }
            const functionNode = node.childForFieldName('function');
            const identity = callIdentity(functionNode);
            if (!identity.name) return true;
            const args = callArguments(node, variableTypes);
            const first = extractStringArg(args.firstArg);
            const enclosingFunction = enclosingFunctionOf(node);
            const owner = enclosingClassName(node) ||
                enclosingFunction?.className;
            const receiverNode = identity.receiverNode ||
                (functionNode?.type === 'field_expression'
                    ? functionNode.childForFieldName('argument') || functionNode.namedChild(0)
                    : null);
            let receiverCall;
            let receiverCallIsMethod = false;
            let receiverCallReceiver;
            let receiverCallLine;
            let receiverCallStart;
            let receiverCallEnd;
            if (receiverNode?.type === 'call_expression') {
                const producerNode = receiverNode.childForFieldName('function');
                const producer = callIdentity(producerNode);
                if (producer.name) {
                    receiverCall = producer.name;
                    receiverCallIsMethod = producer.isMethod;
                    receiverCallReceiver = producer.isPathCall
                        ? producer.receiver : undefined;
                    receiverCallLine = producer.nameNode?.startPosition.row + 1 ||
                        receiverNode.startPosition.row + 1;
                    receiverCallStart = receiverNode.startIndex;
                    receiverCallEnd = receiverNode.endIndex;
                }
            }
            const receiverPath = fieldReceiverPath(receiverNode);
            let receiverRoot = receiverPath?.root;
            let receiverFields = receiverPath?.fields || [];
            const arrowThroughObject = identity.pointerAccess && receiverFields.length === 0 &&
                receiverRoot && variableTypes.arrowThroughObject(receiverRoot, node);
            let receiverRootType = receiverRoot && !arrowThroughObject
                ? ((identity.pointerAccess && receiverFields.length === 0
                    ? variableTypes.getPointee(receiverRoot, node) : undefined) ||
                   variableTypes.get(receiverRoot, node))
                : undefined;
            // A bare field inside a member function is implicitly rooted at
            // `this`; keep that field path so declared-field resolution can
            // type it without mistaking it for an unrelated local.
            if (owner && receiverNode?.type === 'identifier' &&
                !receiverRootType && !arrowThroughObject &&
                (fieldTypes.has(`${owner}.${receiverNode.text}`) ||
                 !variableTypes.get(receiverNode.text, node))) {
                receiverRoot = 'this';
                receiverFields = [receiverNode.text];
                receiverRootType = owner;
            }
            if (receiverRoot === 'this' && !receiverRootType) {
                receiverRootType = owner || undefined;
            }
            const directReceiverType = receiverPath && !arrowThroughObject &&
                receiverFields.length === 0 && receiverRoot
                ? ((identity.pointerAccess
                    ? variableTypes.getPointee(receiverRoot, node) : undefined) ||
                   variableTypes.get(receiverRoot, node))
                : undefined;
            // `items[i].m()` on a declared container/array (fix #359).
            let indexedReceiverType;
            // `v["x"].m()` on a variable declared as a class object (fix
            // #401): the receiver is what the class's operator[] returns,
            // decided at query time from its declarations.
            let subscriptObject;
            if (!receiverPath && receiverNode?.type === 'subscript_expression' &&
                !identity.pointerAccess) {
                const indexedRoot = receiverNode.childForFieldName('argument') ||
                    receiverNode.namedChild(0);
                if (indexedRoot?.type === 'identifier') {
                    indexedReceiverType = variableTypes.getElement(indexedRoot.text, node);
                    if (!indexedReceiverType && variableTypes.arrowThroughObject(indexedRoot.text, node)) {
                        const declared = variableTypes.get(indexedRoot.text, node);
                        if (declared) {
                            subscriptObject = { type: declared,
                                at: variableTypes.evidence(indexedRoot.text, node).receiverTypeEvidence?.start,
                                line: variableTypes.evidence(indexedRoot.text, node).receiverTypeEvidence?.line };
                        }
                    }
                }
            }
            const assignedTo = assignmentTargetOf(node);
            const compileTimeOnly = compileTimeOnlyContext(node);
            const macroArguments = enclosingMacroArguments(node);
            calls.push({
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                column: identity.nameNode?.startPosition.column,
                callStart: node.startIndex,
                callEnd: node.endIndex,
                isMethod: identity.isMethod,
                ...(functionNode?.type === 'identifier' &&
                    cLocalBindingNames(tree).has(identity.name) &&
                    cBareNameShadowedByLocal(node, identity.name) && { localShadow: true }),
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(identity.isPathCall && { isPathCall: true }),
                ...(identity.globalQualified && { globalQualified: true }),
                ...(identity.qualifierTemplateParam && {
                    qualifierTemplateParam: true,
                }),
                ...(identity.explicitTemplateCall && {
                    explicitTemplateCall: true,
                }),
                ...(compileTimeOnly && { compileTimeOnly }),
                ...(macroArguments.length > 0 && { macroArguments }),
                // fix #393: `v->m()` on a variable. The member is looked up
                // in what `->` yields: the pointee of a pointer, or the
                // result of the class's operator-> for an object (a smart
                // pointer behind an alias, an iterator). A variable declared
                // as an object records its declared type for that lookup.
                ...(identity.pointerAccess && receiverNode?.type === 'identifier' &&
                    receiverFields.length === 0 && { receiverArrow: true }),
                ...(arrowThroughObject && variableTypes.get(receiverRoot, node) && {
                    receiverArrowObject: variableTypes.get(receiverRoot, node),
                    receiverArrowObjectAt: variableTypes.evidence(receiverRoot, node)
                        .receiverTypeEvidence?.start,
                    receiverArrowObjectLine: variableTypes.evidence(receiverRoot, node)
                        .receiverTypeEvidence?.line,
                }),
                ...(directReceiverType && { receiverType: directReceiverType, ...variableTypes.evidence(receiverRoot, node) }),
                ...(!directReceiverType && indexedReceiverType && {
                    receiverType: indexedReceiverType,
                    receiverTypeSource: 'annotation',
                    receiverTypeEvidence: typeOrigin('annotation', receiverNode),
                }),
                ...(!directReceiverType && subscriptObject && {
                    receiverSubscriptObject: subscriptObject.type,
                    ...(subscriptObject.at != null && { receiverSubscriptObjectAt: subscriptObject.at }),
                    ...(subscriptObject.line != null && { receiverSubscriptObjectLine: subscriptObject.line }),
                }),
                ...(receiverCall && {
                    receiverCall,
                    receiverIsChainRoot: true,
                    receiverCallLine,
                    receiverCallStart,
                    receiverCallEnd,
                    ...(receiverCallIsMethod && {
                        receiverCallIsMethod: true,
                    }),
                    ...(receiverCallReceiver && { receiverCallReceiver }),
                }),
                ...(receiverFields.length > 0 && receiverRoot && {
                    receiverRoot,
                    receiverField: receiverFields[0],
                    receiverFields,
                    ...(receiverRootType && { receiverRootType }),
                }),
                ...(assignedTo && { assignedTo }),
                argCount: args.argCount,
                argKinds: args.argKinds,
                enclosingFunction,
                ...(first && {
                    firstStringArg: first.value,
                    firstStringArgInterp: first.interp,
                }),
            });
            return true;
        }
        if (node.type === 'cast_expression') {
            // tree-sitter-cpp parses parenthesized function-template
            // invocation (`(PrintSmartPointer<T>)(p, os, 0)`) as a cast whose
            // "type" is the template callable. This is still an AST-proven
            // callable expression: require the exact type-descriptor +
            // parenthesized-value shape and recover its base/path identity.
            const typeNode = node.childForFieldName('type');
            const valueNode = node.childForFieldName('value');
            if (typeNode?.type === 'type_descriptor' &&
                valueNode?.type === 'parenthesized_expression') {
                const identity = callIdentity(typeNode);
                if (identity.name) {
                    const expression = valueNode.namedChild(0);
                    const values = commaExpressionValues(expression);
                    calls.push({
                        name: identity.name,
                        line: identity.nameNode?.startPosition.row + 1 ||
                            node.startPosition.row + 1,
                        column: identity.nameNode?.startPosition.column,
                        isMethod: identity.isMethod,
                        ...(identity.receiver && { receiver: identity.receiver }),
                        ...(identity.isPathCall && { isPathCall: true }),
                        argCount: values.length,
                        argKinds: values.map(value =>
                            staticArgumentKind(value, variableTypes)),
                        enclosingFunction: enclosingFunctionOf(node),
                    });
                    return false;
                }
            }
        }
        if (node.type === 'new_expression') {
            const typeNode = node.childForFieldName('type') ||
                node.namedChildren.find(child => child.type === 'type_identifier' ||
                    child.type === 'qualified_identifier');
            if (!typeNode) return true;
            const args = callArguments(node, variableTypes);
            const name = typeName(typeNode);
            if (name) {
                calls.push({
                    name,
                    line: typeNode.startPosition.row + 1,
                    column: typeNode.startPosition.column,
                    isMethod: false,
                    isConstructor: true,
                    argCount: args.argCount,
                    argKinds: args.argKinds,
                    enclosingFunction: enclosingFunctionOf(node),
                });
            }
        }
        return true;
    });
    if (includeMacroBodies) calls.push(...findMacroBodyCalls(tree, code, parser));
    return calls;
}

function callIdentityKey(call) {
    return [
        call.name,
        call.line,
        call.column ?? '',
        call.callStart ?? '',
        call.callEnd ?? '',
        call.isMethod ? 1 : 0,
        call.isConstructor ? 1 : 0,
        call.inMacroBody ? 1 : 0,
    ].join(':');
}

/**
 * fix #396: a receiver declared in a replacement list with a macro parameter
 * as its type (`T v(x); v.f();` in `#define M(T, x)`) has the type of the
 * argument each invocation passes, so the body gives it no type. Returns
 * the call without the receiver type facts drawn from that declaration.
 */
function withoutParameterReceiverTypes(call, parameters) {
    const isParameter = type => typeof type === 'string' &&
        parameters.has(type.replace(/^[\s*&]+|[\s*&]+$/g, ''));
    if (!isParameter(call.receiverType) && !isParameter(call.receiverRootType)) return call;
    const out = {};
    for (const key of Object.keys(call)) {
        if (key.startsWith('receiverType') || key.startsWith('receiverRootType')) continue;
        out[key] = call[key];
    }
    // The parameter a receiver is declared with (fix #401): each invocation
    // of the macro types it with the argument it passes there.
    if (isParameter(call.receiverType) && !call.receiverField) {
        out.receiverMacroParam = call.receiverType.replace(/^[\s*&]+|[\s*&]+$/g, '');
    }
    return out;
}

/**
 * fix #396: a comment before a line splice (`X; <comment> <backslash>`) ends the
 * grammar's replacement-list token early, so the rest of the `#define`
 * parses as code and its calls look like file-scope calls. The preprocessor
 * joins spliced lines first: a call on a line of a `#define` directive is in
 * that macro's replacement list.
 */
// The `#define` line ranges of the last sources read (one per analysis of a
// file: its calls are marked by several extraction paths).
const directiveRangesMemo = new Map();

function markDirectiveBodyCalls(code, calls) {
    if (!calls.some(call => !call.inMacroBody && !call.macroExpansion)) return calls;
    if (!code.includes('#') || !code.includes('define')) return calls;
    const ranges = directiveRanges(code);
    if (ranges.length === 0) return calls;
    for (const call of calls) {
        if (call.inMacroBody || call.macroExpansion) continue;
        const range = ranges.find(candidate => candidate.startLine < call.line && call.line <= candidate.endLine);
        if (!range || call.enclosingFunction) continue;
        const stripped = withoutParameterReceiverTypes(call, range.params);
        if (stripped !== call) {
            for (const key of Object.keys(call)) {
                if (key.startsWith('receiverType') || key.startsWith('receiverRootType')) delete call[key];
            }
            if (stripped.receiverMacroParam) call.receiverMacroParam = stripped.receiverMacroParam;
        }
        call.inMacroBody = true;
        if (range.params.has(call.name)) call.macroParameter = true;
        call.enclosingFunction = {
            name: range.name, startLine: range.startLine, endLine: range.endLine, isMacro: true,
        };
    }
    return calls;
}

/** Multi-line `#define` directives of `code`: [{ name, startLine, endLine, params }]. */
function directiveRanges(code) {
    const cached = directiveRangesMemo.get(code);
    if (cached) return cached;
    const lines = code.split('\n');
    const ranges = [];
    for (let row = 0; row < lines.length; row++) {
        const define = /^\s*#\s*define\s+([A-Za-z_]\w*)(\()?/.exec(lines[row]);
        const first = row;
        while (row + 1 < lines.length && /\\\s*$/.test(lines[row])) row++;
        if (!define || row === first) continue;
        // The parameter list may continue on the spliced lines.
        const directive = lines.slice(first, row + 1).join(' ').replace(/\\\s*$/gm, ' ').replace(/\\\s/g, ' ');
        const params = define[2] ? (/^[^(]*\(([^)]*)\)/.exec(directive.slice(directive.indexOf(define[1])))?.[1] || '')
            .split(',').map(param => param.trim()).filter(Boolean) : [];
        ranges.push({ name: define[1], startLine: first + 1, endLine: row + 1, params: new Set(params) });
    }
    if (directiveRangesMemo.size >= 8) directiveRangesMemo.delete(directiveRangesMemo.keys().next().value);
    directiveRangesMemo.set(code, ranges);
    return ranges;
}

function attributeCallsToLexicalFunctions(calls, functions) {
    const bodies = functions.filter(fn => !fn.isSignature)
        .sort((a, b) =>
            ((a.endLine - a.startLine) - (b.endLine - b.startLine)) ||
            b.startLine - a.startLine);
    for (const call of calls) {
        const owner = bodies.find(fn =>
            fn.startLine <= call.line && call.line <= fn.endLine);
        if (!owner) continue;
        call.enclosingFunction = {
            name: owner.name,
            startLine: owner.startLine,
            endLine: owner.endLine,
            ...(owner.className && { className: owner.className }),
        };
    }
    return calls;
}

/**
 * The value a C/C++ declarator declares (fix #369): `auto run = ..`,
 * `void (*cb)(void)`, `F &f`. A plain `void f();` block-scope function
 * declaration declares a function, not a value, and yields null.
 */
function cDeclaratorValueName(declarator) {
    let current = declarator;
    for (let depth = 0; current && depth < 16; depth++) {
        switch (current.type) {
            case 'identifier':
                return current.text;
            case 'init_declarator':
            case 'pointer_declarator':
            case 'reference_declarator':
            case 'array_declarator':
            case 'parenthesized_declarator':
                current = current.childForFieldName('declarator') ||
                    current.namedChildren.find(child => /declarator|identifier/.test(child.type));
                break;
            case 'function_declarator': {
                const inner = current.childForFieldName('declarator');
                if (!inner || inner.type === 'identifier' || inner.type === 'qualified_identifier') {
                    return null;
                }
                current = inner;
                break;
            }
            default:
                return null;
        }
    }
    return null;
}

/**
 * A local value named like a bare call (`auto run = [] {}; run();`, a
 * function-pointer parameter `cb(...)`) is the callee, never a same-named
 * project function (fix #369). Walks enclosing compound statements
 * (declarations before the call), range-for / for / condition declarations,
 * catch and lambda parameters, and the enclosing function's parameters.
 */
const _cLocalNamesByTree = new WeakMap();
/** Every value name a declaration or parameter in the file declares (fix #369). */
function cLocalBindingNames(tree) {
    let names = _cLocalNamesByTree.get(tree);
    if (names) return names;
    names = new Set();
    for (const node of tree.rootNode.descendantsOfType([
        'init_declarator', 'parameter_declaration', 'for_range_loop', 'declaration',
        'alias_declaration'])) {
        if (node.type === 'alias_declaration') {
            const name = node.childForFieldName('name')?.text;
            if (name) names.add(name);
            continue;
        }
        if (node.type === 'declaration') {
            for (const child of node.namedChildren) {
                if (child.type === 'identifier' || /declarator$/.test(child.type)) {
                    const name = cDeclaratorValueName(child);
                    if (name) names.add(name);
                }
            }
            continue;
        }
        const name = cDeclaratorValueName(node.type === 'init_declarator'
            ? node : node.childForFieldName('declarator'));
        if (name) names.add(name);
    }
    _cLocalNamesByTree.set(tree, names);
    return names;
}

function cBareNameShadowedByLocal(callNode, name) {
    const declarationBinds = declaration => {
        // A block-scope type alias (`using T = ...;`, `typedef ... T;`)
        // shadows every outer T: `T()` is its value-initialization (fix #379).
        if (declaration?.type === 'alias_declaration') {
            return declaration.childForFieldName('name')?.text === name;
        }
        if (declaration?.type === 'type_definition') {
            return declaration.namedChildren.some(child =>
                !sameNode(child, declaration.childForFieldName('type') || child.parent) &&
                cDeclaratorValueName(child) === name);
        }
        if (!declaration || declaration.type !== 'declaration') return false;
        return declaration.namedChildren.some(child =>
            /declarator|^identifier$/.test(child.type) &&
            !sameNode(child, declaration.childForFieldName('type') || child.parent) &&
            cDeclaratorValueName(child) === name);
    };
    const parametersBind = list => (list?.namedChildren || []).some(param =>
        /parameter_declaration/.test(param.type) &&
        cDeclaratorValueName(param.childForFieldName('declarator')) === name);
    let child = callNode;
    for (let p = callNode.parent; p; child = p, p = p.parent) {
        switch (p.type) {
            case 'compound_statement':
            case 'case_statement':
                for (let i = 0; i < p.namedChildCount; i++) {
                    const statement = p.namedChild(i);
                    if (statement.startIndex >= child.startIndex) break;
                    if (declarationBinds(statement)) return true;
                }
                break;
            case 'for_range_loop':
                if (cDeclaratorValueName(p.childForFieldName('declarator')) === name) return true;
                break;
            case 'for_statement': {
                const initializer = p.childForFieldName('initializer');
                if (initializer && !sameNode(initializer, child) && declarationBinds(initializer)) {
                    return true;
                }
                break;
            }
            case 'condition_clause':
                break;
            case 'if_statement':
            case 'while_statement':
            case 'switch_statement': {
                const condition = p.childForFieldName('condition');
                const declaration = condition?.namedChildren?.find(c => c.type === 'declaration');
                if (declaration && !sameNode(condition, child) && declarationBinds(declaration)) {
                    return true;
                }
                break;
            }
            case 'catch_clause':
                if (parametersBind(p.childForFieldName('parameters'))) return true;
                break;
            case 'lambda_expression': {
                const declarator = p.childForFieldName('declarator');
                if (parametersBind(declarator?.childForFieldName('parameters'))) return true;
                break;
            }
            case 'function_definition': {
                let declarator = p.childForFieldName('declarator');
                while (declarator && declarator.type !== 'function_declarator') {
                    declarator = declarator.childForFieldName('declarator') ||
                        declarator.namedChildren.find(c => /declarator/.test(c.type));
                }
                return parametersBind(declarator?.childForFieldName('parameters'));
            }
            default:
                break;
        }
    }
    return false;
}

function findCallsInCode(code, parser, options = {}, existingTree = null,
    includeMacroBodies = true, mode = 'cpp') {
    // Synthetic macro-body parses and other explicit trees are already exact
    // views supplied by the caller.  Only whole-file extraction participates
    // in preprocessor-configuration conservation.
    if (existingTree) {
        const calls = findCallsInTree(
            code, parser, options, existingTree, includeMacroBodies);
        const functions = findFunctionsInTree(code, existingTree, mode);
        return markDirectiveBodyCalls(code, attributeCallsToLexicalFunctions(calls, functions));
    }
    const tree = parseTree(parser, code);
    const primary = findCallsInTree(
        code, parser, options, tree, includeMacroBodies);
    const literal = literalRecoveryTree(parser, code, tree);
    if (!literal) {
        return markDirectiveBodyCalls(code, attributeCallsToLexicalFunctions(
            primary, findFunctionsInTree(code, tree, mode)));
    }
    try {
        const literalCalls = findCallsInTree(
            code, parser, options, literal, includeMacroBodies)
            .map(call => ({ ...call, configurationVariant: true }));
        // Selected-configuration facts retain their stronger evidence.  Only
        // literal-only sites carry configurationVariant and are therefore
        // routed to the visible unverified tier by callers.js.
        const calls = mergeExtracted(primary, literalCalls, callIdentityKey);
        const functions = mergeExtracted(
            findFunctionsInTree(code, tree, mode),
            withoutShadowedFreeFunctions(
                findFunctionsInTree(code, literal, mode),
                findClassesInTree(code, tree, mode)),
            item => `${item.name}:${item.startLine}:${item.className || ''}:${item.isSignature ? 1 : 0}`,
        );
        return markDirectiveBodyCalls(code, attributeCallsToLexicalFunctions(calls, functions));
    } finally { /* cached with the selected tree */ }
}

/**
 * Parse C/C++ replacement lists as executable syntax without treating the
 * preprocessor's opaque `preproc_arg` token as text evidence. Tree-sitter does
 * not descend into replacement lists, so wrap each AST-identified value in a
 * synthetic function body and parse it with the same grammar. The wrapper and
 * line-splice blanking preserve a deterministic mapping back to source.
 *
 * Calls through macro parameters (`#define APPLY(fn, x) fn(x)`) are retained
 * for conservation but marked as lexical parameter dispatch; they must never
 * resolve to an unrelated project function that happens to share `fn`'s name.
 */
function findMacroBodyCalls(tree, code, parser, onlyName = null) {
    const calls = [];
    for (const node of macroDefinitionNodes(tree)) {
        const nameNode = node.childForFieldName('name') ||
            (node.namedChildren || []).find(child => child.type === 'identifier');
        const valueNode = node.childForFieldName('value') ||
            (node.namedChildren || []).find(child => child.type === 'preproc_arg');
        if (!nameNode || !valueNode || !valueNode.text.trim()) continue;
        // Usage queries ask about one identifier. Avoid reparsing every macro
        // in every scanned file; the cheap prefilter only skips replacement
        // lists that cannot possibly produce the requested AST name.
        if (onlyName && !valueNode.text.includes(onlyName)) continue;
        const paramsNode = node.childForFieldName('parameters') ||
            (node.namedChildren || []).find(child => child.type === 'preproc_params');
        const parameterNames = (paramsNode?.namedChildren || [])
            .filter(child => child.type === 'identifier')
            .map(child => child.text);
        const parameters = new Set(parameterNames);
        // Replace only the continuation backslash. Keeping the newline and
        // every other byte makes source-line/column and span remapping exact.
        const body = valueNode.text.replace(/\\(?=\r?\n)/g, ' ');
        const prefix = 'void __ucn_macro_body__(void) {\n';
        const synthetic = `${prefix}${body}\n;}`;
        // Synthetic replacement-list wrappers are one-shot parse inputs. Do
        // not put hundreds of tiny trees in the full-source recovery LRU:
        // that evicted large project headers and made every later agent query
        // recover them again. Extract the immutable records, then explicitly
        // release this native tree.
        // The records depend only on the replacement list and parameter
        // names; a recovered file analyzes its selected and literal trees,
        // which share every macro (fix #365).
        const memoKey = `${parser.getLanguage?.()?.name || ''}\0${parameterNames.join(',')}\0${synthetic}`;
        let memo = macroBodyMemo.get(memoKey);
        if (!memo) {
            const nestedTree = safeParse(parser, synthetic, undefined, PARSE_OPTIONS);
            try {
                memo = {
                    effects: body.includes('::') ||
                        /[A-Z_][A-Z0-9_]*\s*\(/.test(body)
                        ? collectMacroParameterEffects(nestedTree, parameterNames)
                        : [],
                    nested: findCallsInCode(synthetic, parser, {}, nestedTree, false),
                };
            } finally {
                nestedTree.delete?.();
            }
            if (macroBodyMemo.size >= MACRO_BODY_MEMO_MAX) macroBodyMemo.clear();
            macroBodyMemo.set(memoKey, memo);
        }
        macroParamEffectsByDefinition.set(node, memo.effects);
        const nested = memo.nested;
        for (const call of nested) {
            if (call.line < 2) continue;
            const line = valueNode.startPosition.row + call.line - 1;
            const column = call.line === 2
                ? valueNode.startPosition.column + (call.column || 0)
                : call.column;
            const callStart = call.callStart == null
                ? undefined
                : valueNode.startIndex + call.callStart - prefix.length;
            const callEnd = call.callEnd == null
                ? undefined
                : valueNode.startIndex + call.callEnd - prefix.length;
            calls.push({
                ...withoutParameterReceiverTypes(call, parameters),
                line,
                column,
                ...(callStart != null && callStart >= valueNode.startIndex && {
                    callStart,
                }),
                ...(callEnd != null && callEnd >= valueNode.startIndex && {
                    callEnd,
                }),
                inMacroBody: true,
                ...(parameters.has(call.name) && { macroParameter: true }),
                enclosingFunction: {
                    name: nameNode.text,
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    isMacro: true,
                },
            });
        }
    }
    return calls;
}

function findImportsInTree(code, tree) {
    const imports = [];
    const pushInclude = (spelled, line) => {
        const system = spelled.startsWith('<');
        const raw = spelled.replace(/^["<]|[">]$/g, '');
        imports.push({
            module: system ? raw : (raw.startsWith('.') ? raw : `./${raw}`),
            names: ['*'],
            type: system ? 'system-include' : 'include',
            line,
        });
    };
    traverseTreeCached(tree.rootNode, node => {
        // `#include` where the grammar expects an initializer or enumerator
        // (X-macro tables: `T t[] = {\n#include "list.def"\n};`) surfaces as
        // an ERROR `#include` token followed by the path literal, or as a
        // `preproc_call` whose directive is `#include` (fix #362).
        if (node.type === 'ERROR' && node.text.replace(/\s+/g, '') === '#include') {
            const next = node.nextSibling;
            if (next && next.startPosition.row === node.startPosition.row &&
                (next.type === 'string_literal' || next.type === 'system_lib_string')) {
                pushInclude(next.text, node.startPosition.row + 1);
            }
            return false;
        }
        if (node.type === 'preproc_call') {
            const directive = node.childForFieldName('directive');
            const argument = node.childForFieldName('argument')?.text.trim() || '';
            if (directive?.text.replace(/\s+/g, '') === '#include' &&
                /^(?:"[^"]+"|<[^>]+>)$/.test(argument)) {
                pushInclude(argument, node.startPosition.row + 1);
            }
            return false;
        }
        if (node.type !== 'preproc_include') return true;
        const pathNode = node.childForFieldName('path') || node.namedChild(0);
        if (!pathNode) return false;
        const system = pathNode.type === 'system_lib_string';
        const raw = pathNode.text.replace(/^["<]|[">]$/g, '');
        imports.push({
            module: system ? raw : (raw.startsWith('.') ? raw : `./${raw}`),
            names: ['*'],
            type: system ? 'system-include' : 'include',
            line: node.startPosition.row + 1,
        });
        return false;
    });
    return imports;
}

function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const primary = findImportsInTree(code, tree);
    const literal = literalRecoveryTree(parser, code, tree);
    if (!literal) return primary;
    try {
        return mergeExtracted(
            primary,
            findImportsInTree(code, literal),
            item => `${item.module}:${item.line}:${item.type}`,
        );
    } finally { /* cached with the selected tree */ }
}

const CALLEE_WRAPPER_NODES = new Set(['template_method', 'dependent_name', 'field_expression']);

function findUsagesInCode(code, name, parser, existingTree, options = {}) {
    // Usage is the raw literal-name inventory. The literal C/C++ tree retains
    // identifiers from every preprocessor branch and is sufficient for
    // occurrence kind/line classification; symbol ownership still comes from
    // the recovered index. Reusing ProjectIndex's raw tree avoids replaying
    // expensive conditional recovery for every queried name.
    const tree = existingTree ||
        safeParse(parser, code, undefined, PARSE_OPTIONS);
    const usages = [];
    const scopeMemo = options.lexicalScopes && options.mode === 'c' ? new Map() : null;
    const seenUsages = new Set();
    const addUsage = usage => {
        const key = `${usage.line}:${usage.column ?? ''}:${usage.usageType}:${usage.receiver || ''}`;
        if (seenUsages.has(key)) return;
        seenUsages.add(key);
        usages.push(usage);
    };
    const collectTreeUsages = sourceTree => visitNameNodes(sourceTree, code, name, node => {
        if (!IDENTIFIER_NODES.has(node.type) || node.text !== name) return;
        let usageType = 'reference';
        let receiver = null;
        const parent = node.parent;
        if (parent) {
            let call = parent.type === 'call_expression'
                ? parent
                : parent.parent?.type === 'call_expression' ? parent.parent : null;
            // `obj.template conv<long>()` nests the member name up to three
            // levels below the call (fix #378).
            if (!call && CALLEE_WRAPPER_NODES.has(parent.type)) {
                let up = parent.parent;
                for (let depth = 0; up && depth < 3 && CALLEE_WRAPPER_NODES.has(up.type); depth++) {
                    up = up.parent;
                }
                if (up?.type === 'call_expression') call = up;
            }
            // Only the callable's terminal name is a call usage. The previous
            // descendant test also matched receiver identifiers, classifying
            // `copy.descriptor()` as a call to a free function named `copy`.
            // callIdentity already unwraps qualified/template/parenthesized
            // callees while preserving the exact terminal name node.
            const calledIdentity = call
                ? callIdentity(call.childForFieldName('function')) : null;
            if (calledIdentity?.nameNode &&
                sameNode(calledIdentity.nameNode, node)) {
                usageType = 'call';
            } else if ((parent.type === 'function_declarator' ||
                parent.type === 'parameter_declaration') &&
                (sameNode(parent.childForFieldName('declarator'), node) ||
                    sameNode(parent.childForFieldName('name'), node))) {
                usageType = 'definition';
            } else if (CLASS_NODES.has(parent.type) &&
                sameNode(parent.childForFieldName('name'), node)) {
                const body = parent.childForFieldName('body');
                const declaration = parent.parent;
                const opaqueForwardDeclaration =
                    ['translation_unit', 'declaration_list']
                        .includes(declaration?.type) ||
                    (declaration?.type === 'declaration' &&
                     (declaration.namedChildren || []).length === 1);
                // `struct S *value` names an existing tag; only a bodied
                // declaration or a standalone `struct S;` introduces it.
                usageType = body || opaqueForwardDeclaration
                    ? 'definition' : 'reference';
            } else if (parent.type === 'preproc_include') {
                usageType = 'import';
            }
            if (parent.type === 'qualified_identifier' &&
                sameNode(parent.childForFieldName('name'), node)) {
                receiver = typeName(parent.childForFieldName('scope') ||
                    parent.namedChild(0));
            } else if (parent.type === 'field_expression' &&
                sameNode(parent.childForFieldName('field'), node)) {
                const argument = parent.childForFieldName('argument') ||
                    parent.namedChild(0);
                receiver = argument?.text || null;
            }
        }
        // A bare name lexically inside a class method participates in C++
        // member lookup on that class. This is ownership evidence for test
        // discovery and usage presentation; receiver-qualified forms above
        // retain their explicit receiver instead.
        if (!receiver) receiver = enclosingClassName(node);
        // Where a bare C reference resolves (fix #396): block declarations,
        // parameters and `for` initializers bind it, else file scope.
        const scope = scopeMemo && usageType === 'reference' && !receiver
            ? scopeFields(referenceScope(node, 'c', scopeMemo)) : null;
        addUsage({
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            usageType,
            ...(receiver && { receiver }),
            ...scope,
        });
    });
    collectTreeUsages(tree);
    // Replacement lists are opaque preproc_arg nodes in the C grammars. The
    // call extractor reparses those AST-proven regions; surface the resulting
    // call usages here as well so callers/callees, usages, and tests share one
    // semantic fact set.
    if (!options.skipCallRecovery) {
        const seenCalls = new Set(usages
            .filter(usage => usage.usageType === 'call')
            .map(usage => `${usage.line}:${usage.column ?? ''}`));
        const macroCalls = findMacroBodyCalls(tree, code, parser, name);
        for (const call of macroCalls) {
            if (call.name !== name) continue;
            const key = `${call.line}:${call.column ?? ''}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key);
            addUsage({
                line: call.line,
                column: call.column,
                usageType: 'call',
                ...(call.receiver && { receiver: call.receiver }),
                ...(call.macroParameter && { macroParameter: true }),
            });
        }
    }
    return usages;
}

function getEntryPointKind(symbol) {
    if (symbol.name === 'main' || symbol.name === 'WinMain' ||
        symbol.name === 'wWinMain' || symbol.name === 'DllMain') return 'main';
    // A callable a macro invocation defines around its body is invoked by
    // code the expansion generates (fix #391).
    if (symbol.generatedByMacro && !symbol.className && !symbol.isMethod) return 'generated';
    if (/^(test_|Test|TEST_)/.test(symbol.name)) return 'test';
    return null;
}

function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

function parse(code, parser, mode, options = {}) {
    if (options.externalMacros && !externalMacroContext) {
        return withExternalMacros(options.externalMacros, () => parse(code, parser, mode, options));
    }
    const tree = parseTree(parser, code);
    const literal = literalRecoveryTree(parser, code, tree);
    try {
        const lines = code.split('\n');
        const primaryClasses = findClassesInTree(code, tree, mode, lines);
        const functions = literal
            ? mergeExtracted(
                findFunctionsInTree(code, tree, mode, lines),
                withoutShadowedFreeFunctions(
                    findFunctionsInTree(code, literal, mode, lines),
                    primaryClasses),
                item => `${item.name}:${item.startLine}:${item.className || ''}:${item.isSignature ? 1 : 0}`,
            )
            : findFunctionsInTree(code, tree, mode, lines);
        const literalClasses = literal ? findClassesInTree(code, literal, mode, lines) : null;
        const classes = literal
            ? mergeExtracted(
                withBranchMembers(primaryClasses, literalClasses, code, selectedSourceByTree.get(tree), lines),
                literalClasses,
                item => `${item.name}:${item.startLine}:${item.type}:${item.namespace || ''}`,
            )
            : primaryClasses;
        const imports = literal
            ? mergeExtracted(
                findImportsInTree(code, tree),
                findImportsInTree(code, literal),
                item => `${item.module}:${item.line}:${item.type}`,
            )
            : findImportsInTree(code, tree);
        const primaryCalls = findCallsInTree(code, parser, {}, tree, true);
        const calls = literal
            ? mergeExtracted(
                primaryCalls,
                findCallsInTree(code, parser, {}, literal, true)
                    .map(call => ({ ...call, configurationVariant: true })),
                callIdentityKey,
            )
            : primaryCalls;
        // fix #367b: declarations only the other language's translation
        // units see (`#ifdef __cplusplus` inline overloads in a C header),
        // tagged with that language so resolution offers them only to call
        // sites compiled as it.
        const branch = languageBranchExtraction(code, mode);
        if (branch) {
            functions.push(...branch.functions);
            classes.push(...branch.classes);
            calls.push(...branch.calls);
            const byLine = (a, b) => ((a.line ?? a.startLine ?? 0) - (b.line ?? b.startLine ?? 0)) ||
                ((a.column ?? a.startColumn ?? 0) - (b.column ?? b.startColumn ?? 0)) ||
                ((a.callStart ?? 0) - (b.callStart ?? 0));
            functions.sort(byLine);
            classes.sort(byLine);
            calls.sort(byLine);
        }
        attributeCallsToLexicalFunctions(calls, functions);
        markDirectiveBodyCalls(code, calls);
        const result = {
            language: mode,
            totalLines: code.length === 0 ? 0 : lines.length,
            functions,
            classes,
            stateObjects: literal
                ? mergeExtracted(findStateObjectsInTree(tree, lines),
                    findStateObjectsInTree(literal, lines),
                    item => `${item.name}:${item.startLine}`)
                : findStateObjectsInTree(tree, lines),
            macros: literal
                ? mergeExtracted(macrosOfTree(tree, lines, parser),
                    macrosOfTree(literal, lines, parser),
                    item => `${item.name}:${item.startLine}:${item.functionLike ? 1 : 0}`)
                : macrosOfTree(tree, lines, parser),
            imports,
            exports: [
                ...functions
                    .filter(fn => !fn.modifiers.includes('static'))
                    .map(fn => ({ name: fn.name, type: 'export', line: fn.startLine })),
                ...classes.map(cls => ({ name: cls.name, type: 'export', line: cls.startLine })),
            ],
            ...(parseRecoveryApplied(code, tree) && { parseRecovery: true }),
            ...(tree.rootNode.hasError && { parseErrorRegions: cFamilyErrorRegions(tree.rootNode) }),
            recoveryBlanks: recoveryBlanksOf(code, selectedSourceByTree.get(tree)),
        };
        // Names at the damage the recovery could not read, and the project
        // macro definitions it used (fix #396): a build re-reads the file
        // when their definitions change.
        if (tree.rootNode.hasError) {
            const candidates = recoveryCandidateNames(tree.rootNode);
            if (candidates.length > 0) result.recoveryCandidates = candidates;
        }
        if (externalMacroContext?.consulted?.size > 0) {
            result.externalMacroNames = [...externalMacroContext.consulted].sort();
        }
        if (mode === 'cpp') {
            const markers = findMacroScopeMarkers(code, tree, lines);
            if (markers.length > 0) result.macroScopeMarkers = markers;
            const usings = findCppUsingFacts(tree);
            if (usings.length > 0) result.cppUsings = usings;
        }
        // Adapter-only full-analysis fact: keep the public parse result shape
        // stable while avoiding a second pair of whole-tree call walks during
        // indexing.
        Object.defineProperty(result, 'calls', {
            value: calls,
            enumerable: false,
            configurable: true,
        });
        return result;
    } finally {
        if (options.releaseAnalysisTree) {
            releaseCFamilyTree(parser, code, tree);
        }
    }
}

function languageBranchExtraction(code, mode) {
    const branch = otherLanguageBranchSource(code, mode);
    if (!branch) return null;
    const { getParser } = require('./index');
    const branchParser = getParser(branch.language);
    const tree = safeParse(branchParser, branch.source, undefined, PARSE_OPTIONS);
    if (!tree) return null;
    try {
        const lines = branch.source.split('\n');
        const tag = item => ({ ...item, languageBranch: branch.language });
        const classes = findClassesInTree(branch.source, tree, branch.language, lines).map(cls => ({
            ...tag(cls),
            ...(Array.isArray(cls.members) && { members: cls.members.map(tag) }),
        }));
        return {
            functions: findFunctionsInTree(branch.source, tree, branch.language, lines).map(tag),
            classes,
            calls: findCallsInTree(branch.source, branchParser, {}, tree, true).map(tag),
        };
    } finally {
        if (isMainThread) tree.delete?.();
    }
}

function findExportsInCodeShallow(code, parser, mode) {
    const functions = findFunctions(code, parser, mode);
    const classes = findClasses(code, parser, mode);
    return [
        ...functions
            .filter(fn => !fn.modifiers.includes('static'))
            .map(fn => ({ name: fn.name, type: 'export', line: fn.startLine })),
        ...classes.map(cls => ({ name: cls.name, type: 'export', line: cls.startLine })),
    ];
}

function createCFamilyLanguage(mode) {
    return {
        parseProvidesAnalysisFacts: true,
        findFunctions: (code, parser) => findFunctions(code, parser, mode),
        findClasses: (code, parser) => findClasses(code, parser, mode),
        findStateObjects,
        findMacros,
        findCallsInCode: (code, parser, options, existingTree, includeMacroBodies) =>
            findCallsInCode(code, parser, options, existingTree, includeMacroBodies, mode),
        findImportsInCode,
        findExportsInCode: (code, parser) => findExportsInCodeShallow(code, parser, mode),
        findUsagesInCode: (code, name, parser, existingTree, options) =>
            findUsagesInCode(code, name, parser, existingTree, { ...options, mode }),
        isEntryPoint,
        getEntryPointKind,
        parse: (code, parser, options) => parse(code, parser, mode, options),
        // The tree the index reads (macro recoveries applied; offsets and
        // lines of every kept token are those of `code`), memoized. With the
        // file's persisted blank ranges it is one parse (null: no recovery).
        recoveredTree: (code, parser, blanks = null) => (Array.isArray(blanks)
            ? treeFromRecoveryBlanks(parser, code, blanks) : parseTree(parser, code)),
    };
}

const RECOVERY_CANDIDATES_MAX = 64;

/**
 * fix #396: the names a macro definition could explain where the grammar
 * failed: identifiers directly inside ERROR nodes, the type-position name of
 * a damaged declaration, a lone name statement with a missing `;`, the type
 * of a compound literal holding a block. Sorted, capped.
 */
function recoveryCandidateNames(root) {
    const names = new Set();
    const add = node => {
        if (node && PLAIN_NAME_NODES.has(node.type) && names.size < RECOVERY_CANDIDATES_MAX) names.add(node.text);
    };
    const visit = node => {
        if (names.size >= RECOVERY_CANDIDATES_MAX || !node.hasError) return;
        if (node.type === 'ERROR') {
            for (const child of node.namedChildren || []) {
                if (PLAIN_NAME_NODES.has(child.type)) add(child);
            }
        }
        if (DECLARATION_NODES.has(node.type) || TYPE_USE_CONTAINERS.has(node.type)) {
            const type = node.childForFieldName('type');
            if (type?.type === 'type_identifier') add(type);
        }
        if (node.type === 'expression_statement' && node.namedChildCount === 1 &&
            PLAIN_NAME_NODES.has(node.namedChild(0).type)) add(node.namedChild(0));
        if (node.type === 'compound_literal_expression') add(node.childForFieldName('type'));
        for (const child of node.children || []) visit(child);
    };
    visit(root);
    return [...names].sort();
}

/**
 * How object-like replacement lists read (fix #396): 'decoration'
 * (declaration specifiers or nothing), 'statement' (a removable statement
 * fragment: `try`, a complete `catch` handler, or nothing in some of the
 * definitions), 'type', or null when they disagree or read as neither.
 */
function objectMacroReading(parser, bodies) {
    const evidence = new DecorationEvidence(parser, '', null);
    evidence.defines = new Map();
    evidence.defineEnds = new Map();
    const readings = new Set(bodies.map(body => evidence.readBody(body)));
    if (readings.size === 1) return [...readings][0];
    if (readings.size === 2 && readings.has('statement') && readings.has('decoration') &&
        bodies.every(body => !body.trim() || evidence.readBody(body) === 'statement')) return 'statement';
    return null;
}

module.exports = {
    createCFamilyLanguage,
    objectMacroReading,
    withExternalMacros,
    // Deterministic test seams for the recovery memory/order contracts.
    conditionalRecoverySources,
    mergeExtracted,
    macroAccessEffect,
};
