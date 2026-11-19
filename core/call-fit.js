/**
 * core/call-fit.js - When is a changed call into project code settled?
 *
 * A call that fits by count and keyword names is settled when nothing the
 * language's checker enforces on it is left unproven. Four questions, each
 * answered from syntax and declarations only:
 *
 *   interface   the call binds one declaration whose written parameters are
 *               its call interface (no constructor, overload set, decorator,
 *               hidden or abstract member, explicit receiver parameter);
 *   arguments   every argument is shown to fit its parameter: a parameter
 *               the checker gives no type (trait `untypedParameters`), a
 *               literal of the kind a literal default or a written builtin
 *               type takes, or the caller's own parameter passed on under
 *               the same written type;
 *   invocation  the call existed before in the same written context (only
 *               literal values moved), or the language requires nothing of
 *               a call beyond its binding (trait `callAvailableByBinding`);
 *   result      a new call's value is discarded, or returned from a
 *               callable whose return contract is read from its body or is
 *               written as the callee's own.
 *
 * Every answer is a proof or a named reason. A reason means an unverified
 * call, never a mismatch: a note when the change wrote the call and its value
 * stays on lines the change wrote (`resultReach`), review otherwise.
 */
'use strict';

const { langTraits, getLanguageAdapter } = require('../languages');
const { sameNode } = require('../languages/utils');
const { argumentProvablyConverts, cppArgumentProvablyConverts } = require('./callers');
const { CALLABLE_NODES } = require('./ast-analysis');
const { bindingTargets, identifiersOf, callableNodeOf, rangeOf } = require('./change-kinds');

// Why a count-valid call is not settled.
const UNSETTLED = Object.freeze({
    interface: 'call-interface-unverified',
    arguments: 'argument-compatibility-unverified',
    requirements: 'call-requirements-unverified',
    result: 'result-use-unverified',
});

const CALL_NODES = new Set(['call_expression', 'call', 'method_invocation',
    'invocation_expression', 'object_creation_expression', 'new_expression']);
const RESULT_NODES = new Set(['return_statement', 'return_expression']);
const AWAIT_NODES = new Set(['await_expression', 'await']);
// What a declaration statement of a callable is written inside, and the
// wrappers that are part of that statement.
const DECLARATION_HOLDERS = new Set(['program', 'module', 'block', 'statement_block', 'class_body', 'declaration_list']);
const DECLARATION_WRAPPERS = new Set(['export_statement', 'decorated_definition', 'lexical_declaration',
    'variable_declaration', 'variable_declarator']);
// Scopes that bind their own names without being callables.
const SCOPE_EXPRESSION = /comprehension$|^generator_expression$/;
const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

function literalKind(argument) {
    if (argument?.kind === 'number_literal' && /^\d+$/.test(argument.text || '') &&
        Number(argument.text) <= 127) return 'smallInteger';
    // Prefixes can change the type (Python bytes, C++ encoded strings).
    // Only plain quoted strings belong to this bounded proof domain.
    if (argument?.kind === 'string_literal' && ['"', "'"].includes(argument.text?.[0])) return 'string';
    if (['true', 'false', 'boolean_literal'].includes(argument?.nodeType)) return 'boolean';
    return null;
}

/** A written builtin type cannot borrow a project or imported namesake. */
function unshadowed(index, file, type) {
    const simple = String(type || '').replace(/^&/, '').trim();
    if ((index.symbols.get(simple) || []).length) return false;
    const entry = index.files.get(file);
    if ((entry?.importDetails || []).some(detail => detail.type === 'from' && detail.names?.includes('*'))) return false;
    return !(entry?.importBindings || []).some(binding => binding.name === '*' || binding.kind === 'wildcard' ||
        binding.name === simple || binding.local === simple || binding.alias === simple);
}

function unavailableSurface(index, definition, caller) {
    const sameOwner = caller.file === definition.file && caller.className && caller.className === definition.className &&
        (caller.namespace || null) === (definition.namespace || null) &&
        (caller.enclosingType || null) === (definition.enclosingType || null);
    const uncertain = member => member.isAbstract || (member.modifiers || []).includes('abstract') || (member.decorators || []).length > 0 ||
        !sameOwner && (member.modifiers || []).some(modifier => ['private', 'protected'].includes(modifier));
    if (uncertain(definition)) return true;
    if (definition.initializerOf) {
        const owners = (index.symbols.get(definition.initializerOf) || []).filter(owner => owner.type === 'class');
        if (owners.length !== 1 || uncertain(owners[0])) return true;
    }
    if (definition.type !== 'class') return false;
    const entry = index.files.get(definition.file);
    return (entry?.symbols || []).some(member => member.className === definition.name &&
        member.startLine >= definition.startLine && member.startLine <= definition.endLine &&
        (member.type === 'constructor' || member.isConstructor ||
            ['constructor', '__init__'].includes(member.name)) && uncertain(member));
}

/** A visible checked-JS/JSDoc contract withdraws the dynamic-only proof. */
function typedComments(index, file) {
    const trait = langTraits(index.files.get(file)?.language)?.checkTypedComment;
    if (!trait) return false;
    const memo = index._opMemo?.('checkTypedComments', () => new Map());
    if (memo?.has(file)) return memo.get(file);
    let found = true;
    try {
        const source = index._readFile(file);
        const root = index._getParsedTree(file, source, index.files.get(file)?.language)?.rootNode;
        if (root) found = root.descendantsOfType('comment').some(comment => trait(comment.text));
    } catch (_) { /* unread checking context stays unknown */ }
    memo?.set(file, found);
    return found;
}

/** The tree verify located the call in: offsets of a span are its offsets. */
function treeOf(index, file) {
    const language = index.files.get(file)?.language;
    if (!language || typeof index._getParsedTree !== 'function') return null;
    const content = index._readFile(file);
    const adapter = getLanguageAdapter(language);
    if (adapter?.queryTree && !adapter.queryTreeIsPlain?.(content, index.files.get(file))) {
        return typeof index._plainParsedTree === 'function' ? index._plainParsedTree(file, content, language) : null;
    }
    return index._getParsedTree(file, content, language);
}

/** The call node at a span verify recorded, or null. */
function callNodeAt(index, file, span) {
    if (!span || span.start == null) return null;
    try {
        const root = treeOf(index, file)?.rootNode;
        let node = root ? root.descendantForIndex(span.start) : null;
        while (node && !(node.startIndex === span.start && node.endIndex === span.end && CALL_NODES.has(node.type))) {
            if (node.startIndex < span.start || node.endIndex > span.end) return null;
            node = node.parent;
        }
        return node || null;
    } catch (_) {
        return null;
    }
}

/**
 * Where a call's value goes, read from the syntax around it.
 *
 *   use      'discarded'  the call, awaited or not, is a whole statement;
 *            'returned'   it is the whole result of the callable that holds
 *                         it (a `return`, an expression body);
 *            'other'      anything else: its type is checked there.
 *   nested   a callable or a scope-binding expression stands between the
 *            call and the caller's own body (its names, its receiver and
 *            its result are not the caller's);
 *   typeArguments  the call names type arguments;
 *   rebound(name)  the caller's body binds `name` again.
 *
 * @returns {object|null} null when the call cannot be located
 */
function siteFacts(index, caller, span) {
    const memo = index._opMemo?.('checkCallSiteFacts', () => new Map());
    const key = `${caller.file}\0${caller.startLine}\0${span?.start}\0${span?.end}`;
    if (memo?.has(key)) return memo.get(key);
    let facts = null;
    const call = callNodeAt(index, caller.file, span);
    if (call) {
        let value = call;
        let awaited = false;
        while (value.parent && (value.parent.type === 'parenthesized_expression' || AWAIT_NODES.has(value.parent.type))) {
            if (AWAIT_NODES.has(value.parent.type)) awaited = true;
            value = value.parent;
        }
        const parent = value.parent;
        let use = 'other';
        let holder = parent;
        if (parent?.type === 'expression_statement' && parent.namedChildCount === 1) use = 'discarded';
        else if (parent && RESULT_NODES.has(parent.type) && parent.namedChildCount === 1) use = 'returned';
        else if (parent && CALLABLE_NODES.has(parent.type) && sameNode(parent.childForFieldName('body'), value)) {
            use = 'returned';
            holder = value;
        }
        // Callables of the caller's own declaration that hold the call,
        // innermost first: the last one is the caller itself.
        const callables = [];
        let scoped = false;
        for (let up = holder; up; up = up.parent) {
            const startLine = up.startPosition.row + 1;
            const endLine = up.endPosition.row + 1;
            if (startLine < caller.startLine || endLine > (caller.endLine || caller.startLine)) break;
            if (CALLABLE_NODES.has(up.type)) callables.push(up);
            else if (SCOPE_EXPRESSION.test(up.type)) scoped = true;
        }
        const callable = Array.isArray(caller.paramsStructured);
        const own = callable && callables.length > 0 ? callables[callables.length - 1] : null;
        // A callable that is not a plain declaration statement (a value of
        // a typed variable, a member of an object, an argument) can take
        // its return contract from where it is written.
        const plainDeclaration = !!own && isPlainDeclaration(own);
        let bound = null;
        facts = {
            use, awaited,
            // The caller's result type is whatever its body returns.
            returnFromBody: plainDeclaration && !own.childForFieldName('return_type') &&
                !own.childForFieldName('result') && !own.childForFieldName('type'),
            // Not inside the caller's body at all (a default value, a
            // decorator argument) is as far from its names as a closure.
            nested: !own || callables.length > 1 || scoped || !inBody(own, call),
            typeArguments: !!call.childForFieldName('type_arguments') ||
                call.namedChildren.some(child => child.type === 'type_arguments'),
            rebound(name) {
                if (!own) return true;
                if (!bound) {
                    bound = new Set();
                    const body = own.childForFieldName('body');
                    const visit = node => {
                        for (const target of bindingTargets(node)) identifiersOf(target, bound);
                        for (const child of node.namedChildren) visit(child);
                    };
                    if (body) visit(body);
                }
                return bound.has(name);
            },
        };
    }
    memo?.set(key, facts);
    return facts;
}

/**
 * Is a callable written as a declaration statement of its own? One that is
 * a value of a typed variable, a member of an object or an argument can
 * take the types of its parameters and of its result from where it stands.
 */
function isPlainDeclaration(callable) {
    for (let up = callable.parent; up && !DECLARATION_HOLDERS.has(up.type); up = up.parent) {
        if (!DECLARATION_WRAPPERS.has(up.type) || up.childForFieldName('type')) return false;
    }
    return true;
}

/** The callable node a declaration's range holds, or null. */
function ownCallableNode(index, definition) {
    try {
        const root = treeOf(index, definition.file)?.rootNode;
        return root ? callableNodeOf(root, rangeOf(definition)) : null;
    } catch (_) { return null; }
}

/**
 * Is a declaration's callable a value of something else (a binding with or
 * without a type, a member of an object, an argument), rather than a
 * declaration statement of its own? Such a callable can take its result
 * type from where it stands.
 */
function heldAsValue(index, definition) {
    const callable = ownCallableNode(index, definition);
    return !!callable && (FUNCTION_VALUE_NODES.has(callable.type) || callable.parent?.type === 'object') &&
        !isPlainDeclaration(callable);
}

/**
 * Is a declaration's callable held by something whose written type it must
 * fit (`const h: Handler = (c) => ..`, a member of an object a typed binding
 * holds, a field written with a type)? The checker holds it to that type
 * wherever it is called from, and where it is not called at all.
 */
function typedByHolder(index, definition) {
    const memo = index._opMemo?.('checkTypedByHolder', () => new Map());
    const key = `${definition.file}\0${definition.startLine}\0${definition.name}`;
    if (memo?.has(key)) return memo.get(key);
    let held = false;
    const callable = ownCallableNode(index, definition);
    if (callable && (FUNCTION_VALUE_NODES.has(callable.type) || callable.parent?.type === 'object')) {
        // Up through what holds the value, to the statement that holds it.
        for (let up = callable.parent; up; up = up.parent) {
            if (up.childForFieldName('type')) { held = true; break; }
            if (isUnit(up) || BLOCK_NODES.has(up.type) || up.type === 'arguments') break;
        }
    }
    memo?.set(key, held);
    return held;
}

/** Is the declaration's own callable a plain declaration statement? */
function declaredPlainly(index, definition) {
    const memo = index._opMemo?.('checkPlainDeclarations', () => new Map());
    const key = `${definition.file}\0${definition.startLine}\0${definition.name}`;
    if (memo?.has(key)) return memo.get(key);
    let plain;
    try {
        const root = treeOf(index, definition.file)?.rootNode;
        const callable = root ? callableNodeOf(root, rangeOf(definition)) : null;
        plain = !!callable && isPlainDeclaration(callable);
    } catch (_) { plain = false; }
    memo?.set(key, plain);
    return plain;
}

function inBody(callable, node) {
    const body = callable.childForFieldName('body');
    return !!body && node.startIndex >= body.startIndex && node.endIndex <= body.endIndex;
}

/** The single type that owns a member, when it has no supertype written. */
function plainOwner(index, definition) {
    const owners = (index.symbols.get(definition.className) || []).filter(owner => owner.file === definition.file &&
        owner.startLine <= definition.startLine && owner.endLine >= definition.endLine);
    return owners.length === 1 && !owners[0].extends?.length && !owners[0].implements?.length ? owners[0] : null;
}

/**
 * Do two declarations read a written type in the same scope? Members of
 * one type do, and so do two declarations at the top of one file; one
 * written inside a callable can see names the other cannot.
 */
function sameScope(a, b) {
    const outermost = declaration => !!declaration.className ||
        (!(declaration.indent > 0) && declaration.lexicalScopeStartLine == null);
    return a.file === b.file && (a.className || null) === (b.className || null) && outermost(a) && outermost(b);
}

/** A written builtin of the literal table, meaning itself in both files. */
function sharedBuiltin(index, traits, written, files) {
    const builtins = Object.values(traits.checkLiteralArguments || {}).flat();
    return builtins.includes(written) && files.every(file => unshadowed(index, file, written));
}

/** The type a literal default gives a parameter with no written type. */
function defaultType(untyped, text) {
    const written = String(text).trim();
    const kind = /^\d+$/.test(written) ? 'integer'
        : /^\d+\.\d*$|^\.\d+$/.test(written) ? 'float'
            : /^(?:true|false)$/i.test(written) ? 'boolean'
                : /^(["'])(?:(?!\1)[^\\\n])*\1$/.test(written) ? 'string' : null;
    return kind ? untyped.defaultTypes?.[kind] || null : null;
}

/**
 * 'typed' or 'open' when the argument is shown to fit its parameter; null
 * when it is not. 'open': the checker gives the parameter no written type,
 * so where it re-reads an unannotated result from the arguments (trait
 * `untypedParameters.resultFollowsArguments`) the call's type moves with it.
 */
function argumentProof(index, traits, definition, caller, record, parameter, argument, at, site, stable) {
    const kind = literalKind(argument);
    if (!parameter.type) {
        const untyped = traits.untypedParameters;
        // A callable that is not a declaration statement of its own can be
        // given its parameter types by where it is written.
        if (!untyped || !PLAIN_NAME.test(parameter.name || '') || !declaredPlainly(index, definition)) return null;
        if (parameter.default === undefined || (untyped.openDefaults || []).includes(String(parameter.default).trim())) return 'open';
        const declared = defaultType(untyped, parameter.default);
        return declared && kind && (traits.checkLiteralArguments?.[kind] || []).includes(declared) ? 'open' : null;
    }
    // An argument the change did not write was accepted where it stands.
    if (stable && !kind) return 'typed';
    // The nominal conversion helpers classify values, not C++
    // lvalue/rvalue reference binding or language passing modes.
    if (/[&*]/.test(parameter.type) && parameter.type !== '&str') return null;
    if (kind) {
        if (traits.checkLiteralArguments) {
            const accepted = traits.checkLiteralArguments[kind] || [];
            return accepted.includes(parameter.type) && unshadowed(index, definition.file, parameter.type) ? 'typed' : null;
        }
        // Reuse the nominal overload engine's positive conversion
        // facts, never its weaker "not disproved" applicability test.
        if (!traits.hasArityOverloads || parameter.type.includes('.') ||
            !unshadowed(index, definition.file, parameter.type)) return null;
        const argumentKind = record.argKinds?.[at];
        if (!argumentKind) return null;
        const language = index.files.get(definition.file)?.language;
        const converts = traits.userDefinedConversions === 'constructors-and-operators'
            ? cppArgumentProvablyConverts(index, argumentKind, parameter, definition, { ...record, argumentFile: caller.file }, at)
            : argumentProvablyConverts(index, argumentKind, parameter, language, definition, { file: caller.file });
        return converts ? 'typed' : null;
    }
    // The caller's own parameter, passed on under the same written type:
    // whatever the body assigns to it must already fit that type.
    if (argument?.nodeType !== 'identifier' || !site || site.nested) return null;
    const own = (caller.paramsStructured || []).find(candidate => candidate.name === argument.text);
    const written = String(parameter.type).trim();
    if (!own || own.rest || !own.type || String(own.type).trim() !== written) return null;
    // A parameter that may be omitted with no default holds more than its written type.
    if (own.optional && own.default === undefined) return null;
    if (caller.generics || definition.generics || site.rebound(argument.text)) return null;
    return sameScope(caller, definition) ||
        sharedBuiltin(index, traits, written, [caller.file, definition.file]) ? 'typed' : null;
}

/**
 * Why a call that fits `definition` by count is not settled, or null when
 * it is.
 *
 * @param {object} index
 * @param {object} definition - the project declaration the call binds
 * @param {object} caller - the changed declaration that holds the call
 * @param {object} record - the call record
 * @param {object} result - verifyCallSites' answer for this one site
 * @param {object} [context] - { stableInvocation: the base revision made
 *   this call in the same written context, receiverProven: the receiver's
 *   type is established as the member's owner }
 * @returns {string|null} a reason of UNSETTLED
 */
function unsettledReason(index, definition, caller, record, result, context = {}) {
    const stable = context.stableInvocation === true;
    const traits = langTraits(index.files.get(definition.file)?.language) || {};
    const callerTraits = langTraits(index.files.get(caller.file)?.language) || {};
    const byBinding = !!traits.callAvailableByBinding && !!callerTraits.callAvailableByBinding;
    // Constructors and their implementation projections are outside this
    // proof: the public overload interface is not the body.
    if (definition.initializerOf || definition.isConstructor ||
        ['class', 'struct', 'record', 'constructor'].includes(definition.type)) return UNSETTLED.interface;
    if (unavailableSurface(index, definition, caller)) return UNSETTLED.interface;
    // A literal may select a different overload with different access,
    // exception or passing-mode requirements even when both return the
    // same type. Where a call is available by its binding the binding
    // names the file, and one declaration there is the interface; elsewhere
    // only a declaration unique in the project is.
    const namesakes = index.symbols.get(definition.name) || [];
    const single = byBinding
        ? namesakes.filter(other => other.file === definition.file &&
            (other.className || null) === (definition.className || null)).length === 1
        : namesakes.length === 1;
    if (!single) return UNSETTLED.interface;
    // A file that only declares (a stub, an ambient declaration) states the
    // interface of code written elsewhere: where one declares this name,
    // the implementation's parameters are not what a checker reads.
    const declarationFile = file => [traits, callerTraits].some(each => each.declarationFilePattern?.test(file));
    if (!declarationFile(definition.file) && namesakes.some(other => other.file !== definition.file &&
        (other.className || null) === (definition.className || null) && declarationFile(other.file))) return UNSETTLED.interface;
    const shape = result.callShapes?.[0];
    const site = shape?.span ? siteFacts(index, caller, shape.span) : null;
    if (definition.className) {
        // A receiver or an inherited outside overload can choose a method
        // absent from the project family. A static member of a non-derived
        // owner is itself; so is an instance member reached through a
        // receiver shown to be that owner (the caller's own receiver
        // parameter, a receiver typed by its construction).
        if (!plainOwner(index, definition)) return UNSETTLED.interface;
        const isStatic = (definition.modifiers || []).includes('static') || definition.type === 'static';
        const ownReceiver = !!site && !site.nested && caller.file === definition.file &&
            caller.className === definition.className && definition.type === 'method' &&
            ['method', 'constructor'].includes(caller.type) &&
            !!record.receiver && (callerTraits.selfParam || []).includes(record.receiver) &&
            (record.receiver === 'this' || caller.paramsStructured?.[0]?.name === record.receiver);
        if (!isStatic && !(byBinding && (context.receiverProven === true || ownReceiver))) return UNSETTLED.interface;
    } else if ((traits.selfParam || []).includes(definition.paramsStructured?.[0]?.name)) {
        // A free function that declares a receiver parameter.
        return UNSETTLED.interface;
    }
    if ((definition.modifiers || []).some(modifier => (traits.compileTimeCallableMarkers || []).includes(modifier))) return UNSETTLED.interface;
    // Written TS declarations do not make ordinary JS arguments checked.
    if (callerTraits.lenientCallArity) {
        if (typedComments(index, caller.file) || typedComments(index, definition.file)) return UNSETTLED.arguments;
        return stable || byBinding ? null : UNSETTLED.requirements;
    }
    if (!shape || shape.hasSpread || shape.indirectKind) return UNSETTLED.arguments;
    const arguments_ = shape.argumentFacts || [];
    if (arguments_.length !== shape.argCount) return UNSETTLED.arguments;
    const lists = result.parameterLists || [];
    if (lists.length !== 1) return UNSETTLED.interface;
    const parameters = lists[0];
    let positional = 0;
    let open = false;
    for (let at = 0; at < arguments_.length; at++) {
        const argument = arguments_[at];
        const parameter = argument.keyword ? parameters.find(candidate => candidate.name === argument.keyword)
            : parameters[positional++];
        if (!parameter || parameter.rest) return UNSETTLED.arguments;
        const proof = argumentProof(index, traits, definition, caller, record, parameter, argument, at, site, stable);
        if (!proof) return UNSETTLED.arguments;
        if (proof === 'open') open = true;
    }
    // A call statement whose callee declares an assertion result narrows
    // what it is handed for the lines after it (trait
    // `callResultFlow.narrowing.statement`): discarding its value settles
    // nothing.
    const asserting = callerTraits.callResultFlow?.narrowing?.statement;
    if (site?.use === 'discarded' && asserting && definition.returnType && asserting.test(String(definition.returnType))) return UNSETTLED.result;
    // The checker reads an unannotated result again from the arguments an
    // untyped parameter received: the call's type is the argument's.
    const follows = open && !definition.returnType && traits.untypedParameters?.resultFollowsArguments === true;
    // A changed call may reuse its baseline availability only under an
    // unchanged invocation context.
    if (stable && !follows) return null;
    if (!byBinding) return UNSETTLED.requirements;
    if (!site) return UNSETTLED.result;
    if (!stable) {
        // What a new call needs beyond its binding: a declaration that is
        // called as written, where the call runs after its module loaded.
        if (!Array.isArray(caller.paramsStructured) || definition.generics || site.typeArguments) return UNSETTLED.requirements;
        if ((index.files.get(caller.file)?.importBindings || []).some(binding => binding.deferred &&
            (binding.alias || binding.local || binding.name) === record.name)) return UNSETTLED.requirements;
        // A function declared inside the caller exists from its own line on.
        if (definition.lexicalScopeStartLine != null && !(record.line > (definition.endLine || definition.startLine))) return UNSETTLED.requirements;
        // An awaitable: its value exists where it is awaited, and that is
        // inside a callable that can await.
        if ((definition.isAsync || (definition.modifiers || []).includes('async')) &&
            !(site.awaited && caller.isAsync)) return UNSETTLED.result;
    }
    if (site.use === 'discarded') return null;
    if (site.use !== 'returned' || site.nested) return UNSETTLED.result;
    if (!caller.returnType) {
        // The caller's return contract is read from its body: the change
        // to it is judged as a contract change of the caller. A member that
        // fills an inherited slot is held to that slot's written type.
        const inferred = (callerTraits.inferredReturnForms || []).includes('unannotated') && site.returnFromBody;
        return inferred && (!caller.className || plainOwner(index, caller)) ? null : UNSETTLED.result;
    }
    // The callee's written result type is the caller's.
    const written = String(definition.returnType || '').trim();
    if (!written || written !== String(caller.returnType).trim() || !PLAIN_NAME.test(written) ||
        caller.generics || definition.generics) return UNSETTLED.result;
    return sameScope(caller, definition) ||
        sharedBuiltin(index, traits, written, [caller.file, definition.file]) ? null : UNSETTLED.result;
}

// ── Where a written call's value goes (fix #511) ──────────────────────────
//
// A call the change wrote, on lines the change wrote, is the author's own
// line: whatever the toolchain finds wrong with it, it reports there. Such a
// call is a note, not a verdict, unless its value reaches a line the change
// did not write: bound to a name such a line reads, stored in a member, a
// subscript or an outer name, narrowing a name such a line reads, or
// returned into a result type written elsewhere.

// Containers whose children are statements, and statement-level nodes.
const BLOCK_NODES = new Set(['block', 'statement_block', 'compound_statement', 'module', 'program']);
const UNIT_SHAPE = /(?:_statement|_declaration|_definition|_clause)$|^switch_(?:case|default)$/;
const TRANSPARENT_NODES = new Set(['parenthesized_expression', 'await_expression', 'await']);
// Statements that run a call and drop its value.
const DISCARDING_NODES = new Set(['defer_statement', 'go_statement']);
const YIELDING_NODES = new Set(['yield', 'yield_expression', 'yield_statement']);
// A write through a member or an element: what is written is held beyond
// the callable.
const MEMBER_WRITE = /^(?:attribute|member_expression|subscript|subscript_expression|field_expression|index_expression|element_access_expression|member_access_expression|field_access|array_access)$/;
// Expressions that assign to what they name, rather than declare it.
const ASSIGNING_NODES = new Set(['assignment_expression', 'augmented_assignment_expression', 'update_expression']);
// What declares a name in the callable that holds it, for languages where
// assigning does not (trait `callResultFlow.assignmentDeclares: false`).
const DECLARING_NODES = new Map([
    ['variable_declarator', 'name'], ['function_declaration', 'name'], ['generator_function_declaration', 'name'],
    ['class_declaration', 'name'], ['catch_clause', 'parameter'],
]);
const SCOPE_LISTS = new Set(['global_statement', 'nonlocal_statement']);
const VARIABLE_LEAVES = new Set(['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern', 'this']);
// Callables written as values (not declaration statements).
const FUNCTION_VALUE_NODES = new Set(['function_expression', 'generator_function', 'arrow_function', 'lambda',
    'func_literal', 'closure_expression', 'lambda_expression', 'anonymous_method_expression']);

const linesOf = node => [node.startPosition.row + 1, node.endPosition.row + 1];
const writtenNode = (node, written) => {
    const [from, to] = linesOf(node);
    for (let line = from; line <= to; line++) if (!written.has(line)) return false;
    return true;
};
const isUnit = node => UNIT_SHAPE.test(node.type) || (!!node.parent && BLOCK_NODES.has(node.parent.type));

/** The innermost statement holding `node` (the node itself included). */
function statementOf(node) {
    for (let up = node; up; up = up.parent) if (isUnit(up)) return up;
    return null;
}

/** The innermost callable holding `node`, or null. */
function callableOf(node) {
    for (let up = node.parent; up; up = up.parent) if (CALLABLE_NODES.has(up.type)) return up;
    return null;
}

/** A member or keyword name: spelled like a variable, naming none. */
function namesNoVariable(leaf) {
    const parent = leaf.parent;
    if (!parent) return false;
    const member = parent.childForFieldName('attribute') || parent.childForFieldName('property') ||
        parent.childForFieldName('field') || (parent.type === 'keyword_argument' ? parent.childForFieldName('name') : null);
    return !!member && sameNode(member, leaf);
}

/**
 * Nodes of a statement's own part: its subtree without the statements and
 * blocks it holds (a compound statement's own part is its header).
 */
function ownNodes(statement, visit) {
    const walk = node => {
        visit(node);
        for (const child of node.namedChildren) {
            if (BLOCK_NODES.has(child.type) || (isUnit(child) && !sameNode(child, statement))) continue;
            walk(child);
        }
    };
    walk(statement);
}

/** Variable names an own part reads (binding positions included). */
function namesRead(statement) {
    const names = new Set();
    ownNodes(statement, node => {
        if (node.childCount === 0 && VARIABLE_LEAVES.has(node.type) && !namesNoVariable(node)) names.add(node.text);
        else if (node.type === 'this') names.add('this');
    });
    return names;
}

/**
 * The facts of one changed callable: its statements, the names it reads on
 * each line, the names it declares and the names it scopes to an outer
 * binding. Memoized per operation.
 */
function callableFacts(index, definition, own, region) {
    const memo = index._opMemo?.('checkCallableFacts', () => new Map());
    const key = `${definition.file}\0${definition.startLine}\0${definition.name}`;
    if (memo?.has(key)) return memo.get(key);
    const units = [];
    const reads = []; // [line, name]
    const declared = new Set();
    const locals = new Set();
    const outer = new Set();
    const assignmentDeclares = !!(langTraits(index.files.get(definition.file)?.language)?.callResultFlow?.assignmentDeclares);
    const walk = node => {
        const [from, to] = linesOf(node);
        if (to < region.startLine || from > region.endLine) return;
        if (isUnit(node)) units.push(node);
        if (node.childCount === 0) {
            if (VARIABLE_LEAVES.has(node.type) && !namesNoVariable(node) && from >= region.startLine && from <= region.endLine) {
                reads.push([from, node.text]);
            }
            return;
        }
        const field = DECLARING_NODES.get(node.type);
        if (field && node.childForFieldName(field)) {
            identifiersOf(node.childForFieldName(field), declared);
            identifiersOf(node.childForFieldName(field), locals);
        }
        if (assignmentDeclares && !ASSIGNING_NODES.has(node.type)) {
            for (const target of bindingTargets(node)) if (target.type === 'identifier') locals.add(target.text);
        }
        if (CALLABLE_NODES.has(node.type)) {
            const parameters = node.childForFieldName('parameters') || node.childForFieldName('parameter');
            if (parameters) identifiersOf(parameters, declared);
        }
        if (SCOPE_LISTS.has(node.type)) identifiersOf(node, outer);
        for (const child of node.children) walk(child);
    };
    // A callable's own header (its name, its parameters and their
    // defaults) is not where its body's values go; its parameters are
    // names it declares.
    const body = own && CALLABLE_NODES.has(own.type) ? own.childForFieldName('body') : own;
    if (own && CALLABLE_NODES.has(own.type)) {
        const parameters = own.childForFieldName('parameters') || own.childForFieldName('parameter');
        if (parameters) identifiersOf(parameters, declared);
    }
    if (body) walk(body);
    for (const name of outer) locals.delete(name);
    const unitReads = new Map();
    const readsOf = unit => {
        if (!unitReads.has(unit.id)) unitReads.set(unit.id, [...namesRead(unit)]);
        return unitReads.get(unit.id);
    };
    const facts = { units, reads, declared, locals, outer, readsOf };
    memo?.set(key, facts);
    return facts;
}

/**
 * May this call narrow the names it is handed? Where the checker narrows a
 * name through a callee's declared result (trait `callResultFlow.narrowing`:
 * a type predicate, an assertion signature, `TypeGuard`/`TypeIs`), a callee
 * whose result is one, a callee whose result is not written where the
 * checker infers predicates, or a callee that is not established narrows.
 */
function mayNarrow(narrowing, candidates, discarded) {
    if (!narrowing) return false;
    const pattern = discarded ? narrowing.statement : narrowing.condition;
    if (!pattern) return false;
    if (candidates.length === 0) return true;
    return candidates.some(candidate => {
        const written = candidate.returnType ? String(candidate.returnType) : '';
        if (written) return pattern.test(written);
        return !discarded && narrowing.unannotatedCondition === true &&
            (!Array.isArray(candidate.paramsStructured) || candidate.paramsStructured.length > 0);
    });
}

/**
 * The names a narrowing call can re-type: the references it is handed (a
 * name, or a member chain read through one) and its receiver's root. A
 * computed argument (a call, an operator) is a new value no later line
 * reads.
 */
function narrowedNames(call) {
    const names = new Set();
    const rootOf = node => {
        let root = node;
        while (root && MEMBER_WRITE.test(root.type)) root = root.childForFieldName('object') || root.childForFieldName('value');
        return root && (root.type === 'identifier' || root.type === 'this') ? root : null;
    };
    const args = call.childForFieldName('arguments');
    for (const argument of args ? args.namedChildren : []) {
        const value = argument.type === 'keyword_argument' ? argument.childForFieldName('value') : argument;
        const root = value && (value.type === 'identifier' || value.type === 'this' || MEMBER_WRITE.test(value.type)) ? rootOf(value) : null;
        if (root) names.add(root.type === 'this' ? 'this' : root.text);
    }
    const callee = call.childForFieldName('function');
    const receiver = callee && callee.childForFieldName('object');
    const root = receiver ? rootOf(receiver) : null;
    if (root) names.add(root.type === 'this' ? 'this' : root.text);
    return names;
}

/**
 * Locals a statement hands a value to as the receiver of a call: a method
 * can store what it is handed in its receiver (`xs.push(v)`), and where a
 * local's type grows with what it holds (an array declared empty), the
 * local is retyped. `holds(node)`: the argument list carries the value.
 */
function receiversHanded(statement, locals, holds) {
    const names = new Set();
    ownNodes(statement, node => {
        if (!CALL_NODES.has(node.type)) return;
        const args = node.childForFieldName('arguments');
        const callee = node.childForFieldName('function');
        if (!args || !callee || !holds(args)) return;
        let root = callee.childForFieldName('object');
        if (!root) return;
        while (root.childForFieldName('object')) root = root.childForFieldName('object');
        if (root.type === 'identifier' && locals.has(root.text)) names.add(root.text);
    });
    return names;
}

/**
 * What a statement's own part binds, and whether it writes past the
 * callable: `{ names, escapes }`. escapes: a member, a subscript, a name
 * the callable scopes to an outer binding, an assignment to a name the
 * callable does not declare (where assigning does not declare), or any
 * binding of a declaration that is not a callable.
 */
function bindingsOf(statement, flow, facts, callable) {
    const names = new Set();
    let escapes = null;
    ownNodes(statement, node => {
        for (const target of bindingTargets(node)) {
            let member = false;
            const scan = candidate => {
                if (MEMBER_WRITE.test(candidate.type)) member = true;
                else for (const child of candidate.namedChildren) scan(child);
            };
            scan(target);
            if (member) { escapes = escapes || 'member-write'; continue; }
            const bound = identifiersOf(target);
            for (const name of bound) {
                names.add(name);
                if (facts.outer.has(name)) escapes = escapes || 'outer-write';
                else if (!flow.assignmentDeclares && ASSIGNING_NODES.has(node.type) && !facts.declared.has(name)) {
                    escapes = escapes || 'outer-write';
                }
            }
        }
    });
    if (!callable && names.size > 0) escapes = escapes || 'declaration-binding';
    return { names, escapes };
}

/**
 * The call node of a call record: by the call's own span where the record
 * has one, else the innermost call whose callee holds the callee name the
 * record names.
 */
function callOfRecord(index, file, record) {
    if (Number.isInteger(record.callStart) && Number.isInteger(record.callEnd)) {
        return callNodeAt(index, file, { start: record.callStart, end: record.callEnd });
    }
    const site = record.callSite;
    if (!site || !Number.isInteger(site.start)) return null;
    try {
        const root = treeOf(index, file)?.rootNode;
        let node = root ? root.descendantForIndex(site.start) : null;
        while (node && !(node.startIndex === site.start && node.endIndex === site.end)) {
            if (node.startIndex > site.start || node.endIndex < site.end) return null;
            node = node.parent;
        }
        for (let up = node && node.parent; up; up = up.parent) {
            if (!CALL_NODES.has(up.type)) continue;
            const callee = up.childForFieldName('function') || up.childForFieldName('name') ||
                up.childForFieldName('constructor') || up.childForFieldName('type');
            if (callee && callee.startIndex <= site.start && callee.endIndex >= site.end) return up;
        }
    } catch (_) { /* not located */ }
    return null;
}

// What a call does to what it is handed (trait `callEffects`).
const LOOP_NODES = new Set(['loop_expression', 'while_expression', 'for_expression', 'while_statement', 'for_statement',
    'for_in_statement', 'do_statement']);
const NAME_LEAVES = new Set(['identifier', 'self', 'this', 'shorthand_property_identifier']);
const PATH_NODES = new Set(['scoped_identifier', 'scoped_type_identifier', 'generic_type']);

/**
 * The names of a callable: where each occurs and how each is declared.
 * `occurrences`: name -> [{ line, index }] (member names left out);
 * `declarations`: name -> [{ index, type, value, parameter }] in source
 * order (`type` the written type's text, `value` the initializer's node
 * type). Memoized per operation.
 */
function callableNames(index, definition, callable) {
    const memo = index._opMemo?.('checkCallableNames', () => new Map());
    const key = `${definition.file}\0${definition.startLine}\0${definition.name}`;
    if (memo?.has(key)) return memo.get(key);
    const occurrences = new Map();
    const declarations = new Map();
    const declare = (name, entry) => {
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push(entry);
    };
    const walk = node => {
        if (node.childCount === 0) {
            if (NAME_LEAVES.has(node.type) && !namesNoVariable(node)) {
                if (!occurrences.has(node.text)) occurrences.set(node.text, []);
                occurrences.get(node.text).push({ line: node.startPosition.row + 1, index: node.startIndex });
            }
            return;
        }
        if (node.type === 'let_declaration' || node.type === 'variable_declarator') {
            const target = node.childForFieldName('pattern') || node.childForFieldName('name');
            const type = node.childForFieldName('type');
            const value = node.childForFieldName('value');
            if (target) {
                for (const name of identifiersOf(target)) {
                    declare(name, { index: node.startIndex, type: type ? type.text.replace(/^:\s*/, '') : null,
                        value: value ? (value.type === 'array' && value.namedChildCount === 0 ? 'empty-array' : value.type) : null });
                }
            }
        } else if (node.type === 'parameter' || node.type === 'required_parameter' || node.type === 'optional_parameter') {
            const target = node.childForFieldName('pattern') || node.childForFieldName('name');
            const type = node.childForFieldName('type');
            if (target) for (const name of identifiersOf(target)) declare(name, { index: node.startIndex, type: type ? type.text.replace(/^:\s*/, '') : null, parameter: true });
        } else if (node.type === 'self_parameter') {
            declare('self', { index: node.startIndex, type: node.text, parameter: true });
        }
        for (const child of node.children) walk(child);
    };
    if (callable) walk(callable);
    const names = { occurrences, declarations };
    memo?.set(key, names);
    return names;
}

/**
 * Does a declaration the diff calls new keep lines the change did not
 * write that name something (a renamed callable keeps its body)? Lines of
 * braces, keywords and literals alone do not count: a diff aligns them
 * with any neighbour.
 */
function carriesUnwrittenNames(index, definition, written) {
    try {
        const root = treeOf(index, definition.file)?.rootNode;
        if (!root) return true;
        const range = rangeOf(definition);
        let found = false;
        const walk = node => {
            if (found) return;
            const from = node.startPosition.row + 1;
            const to = node.endPosition.row + 1;
            if (to < range.startLine || from > range.endLine) return;
            if (node.childCount === 0) {
                if (node.type.includes('identifier') && from >= range.startLine && from <= range.endLine && !written.has(from)) found = true;
                return;
            }
            for (const child of node.children) walk(child);
        };
        walk(root);
        return found;
    } catch (_) { return true; }
}

/** Variable names inside `node`, each with whether a borrow holds it. */
function handedNamesOf(node, borrowNodes, borrowed = false, out = []) {
    if (!node) return out;
    if (node.childCount === 0) {
        if (NAME_LEAVES.has(node.type) && !namesNoVariable(node)) out.push({ name: node.text, borrowed });
        return out;
    }
    // A path names an item (`Kind::A`, `module::f`), never a local.
    if (PATH_NODES.has(node.type)) return out;
    // A member's name is not a variable; the chain's root is.
    if (MEMBER_WRITE.test(node.type) || node.type === 'field_expression') {
        const object = node.childForFieldName('object') || node.childForFieldName('value');
        if (object) handedNamesOf(object, borrowNodes, borrowed, out);
        const indexNode = node.childForFieldName('index');
        if (indexNode) handedNamesOf(indexNode, borrowNodes, borrowed, out);
        return out;
    }
    const inner = borrowed || borrowNodes.includes(node.type);
    for (const child of node.namedChildren) handedNamesOf(child, borrowNodes, inner, out);
    return out;
}

/**
 * What a call the change wrote does to what it is handed, or to the code
 * that holds it, that reaches a line the change did not write (trait
 * `callEffects`; a callable instantiated per caller, trait
 * `inferredReturnForms` 'instantiated'). Null when nothing modeled does.
 */
function callEffectsReach(index, definition, call, context) {
    const { traits, written, candidates, callable } = context;
    // A call into a template instantiates its body for these arguments:
    // what does not fit is reported in the body, where the change did not
    // write.
    if ((traits.inferredReturnForms || []).includes('instantiated') &&
        (candidates.length === 0 || candidates.some(candidate => candidate.templateDependent || candidate.templateParams))) {
        return 'callee-instantiated';
    }
    const effects = traits.callEffects;
    if (!effects || !callable) return null;
    const names = callableNames(index, definition, callable);
    const unwrittenOccurrence = (name, keep = () => true) => (names.occurrences.get(name) || [])
        .some(at => !written.has(at.line) && keep(at));
    const declarationOf = name => {
        const all = names.declarations.get(name) || [];
        const before = all.filter(entry => entry.index < call.startIndex);
        return before.length ? before[before.length - 1] : all[0] || null;
    };
    const args = call.childForFieldName('arguments');
    const callee = call.childForFieldName('function');
    const receiver = callee && (callee.childForFieldName('object') || (callee.type === 'field_expression' ? callee.childForFieldName('value') : null));
    if (effects.argumentDeclarations && args) {
        for (const kind of effects.argumentDeclarations) {
            for (const declared of args.descendantsOfType(kind)) {
                const name = declared.childForFieldName('name');
                if (name && unwrittenOccurrence(name.text)) return 'declares-a-name';
            }
        }
    }
    if (effects.evolvingLocals) {
        const handed = [...handedNamesOf(args, []), ...handedNamesOf(receiver, [])];
        for (const { name } of handed) {
            const declaration = declarationOf(name);
            if (declaration && !declaration.parameter && !declaration.type &&
                (declaration.value == null || declaration.value === 'empty-array') && unwrittenOccurrence(name)) {
                return 'evolving-local-handed';
            }
        }
    }
    const values = effects.handedValues;
    if (values) {
        // A method's receiver goes by value unless every declaration the
        // call may bind borrows it.
        const receiverBorrowed = candidates.length > 0 && candidates.every(candidate =>
            /^&/.test(String(candidate.paramsStructured?.[0]?.name || '')));
        const handed = [...handedNamesOf(args, values.borrowNodes),
            ...handedNamesOf(receiver, values.borrowNodes, receiverBorrowed)];
        // Code in a loop around the call runs again after it.
        let loop = null;
        for (let up = call.parent; up && !sameNode(up, callable); up = up.parent) if (LOOP_NODES.has(up.type)) loop = up;
        const afterCall = at => at.index >= call.endIndex || (!!loop && at.index >= loop.startIndex && at.index < loop.endIndex);
        for (const { name, borrowed } of handed) {
            // A name bound by a pattern (`for`, `if let`, a `match` arm, a
            // closure parameter) or outside the callable has no type the
            // engine reads: as a local with no written type.
            const declaration = declarationOf(name) || { type: null, value: null };
            const type = declaration.type ? declaration.type.replace(/\s+/g, ' ').trim() : null;
            const fixed = !!type || (declaration.value != null && values.fixedInitializers.includes(declaration.value));
            // The type is taken from the uses: this call can fix it.
            if (!fixed && unwrittenOccurrence(name)) return 'handed-value-retyped';
            const copies = !!type && (values.copyTypes.includes(type) || (/^&/.test(type) && !/^&\s*mut\b/.test(type)));
            // Moved: a later use is a use after the move.
            if (!borrowed && !copies && unwrittenOccurrence(name, afterCall)) return 'handed-value-moved';
        }
    }
    return null;
}

/**
 * Where a changed call's value goes, as far as the lines the change wrote.
 *
 * @param {object} index
 * @param {object} definition - the changed declaration holding the call
 * @param {object} record - the call record (its span locates the call)
 * @param {object} context - { added: the declaration is new, written: Set
 *   of the file's lines the change wrote, candidates: the declarations the
 *   call may bind }
 * @returns {string|null} null: nothing the call produces reaches a line the
 *   change did not write (a note); otherwise why it does
 */
function resultReach(index, definition, record, context) {
    const written = context.written || new Set();
    const call = callOfRecord(index, definition.file, record);
    if (!call) return 'call-not-located';
    const first = statementOf(call);
    if (!first || !writtenNode(first, written)) return 'unwritten-line';
    const traits = langTraits(index.files.get(definition.file)?.language) || {};
    // Where nothing checks a call before it runs (trait `lenientCallArity`),
    // what is wrong with it surfaces wherever the callee fails, not on the
    // line that wrote it.
    if (traits.lenientCallArity) return 'calls-not-checked';
    // Text the change removed from the declaration (a replaced line, a
    // deleted one) could have supplied what an unwritten line relies on: a
    // use, an assignment, a narrowing, a thrown exception. Its calls are
    // not notes.
    if (context.replaced) return 'lines-replaced';
    const range = rangeOf(definition);
    const root = treeOf(index, definition.file)?.rootNode;
    const callable = Array.isArray(definition.paramsStructured) && root ? callableNodeOf(root, range) : null;
    const candidates = context.candidates || [];
    const effect = callEffectsReach(index, definition, call, { traits, written, candidates, callable });
    if (effect) return effect;
    const flow = traits.callResultFlow || null;
    // Every line of a new declaration is the change's: its own reasons
    // (capture, novelty) say what can reach it. Where a member's type, and a
    // module name's, is whatever the code assigns to it (trait
    // `memberTypesFromAssignments`), a store the new code makes is read
    // where the change did not write.
    const added = !!context.added;
    if (added && !(flow && traits.memberTypesFromAssignments)) return null;
    const ownResult = node => {
        const holder = callableOf(node);
        return !!callable && !!holder && sameNode(holder, callable);
    };

    // The value is the changed callable's result: a result type read from
    // the body is the callable's contract (its own reason decides the
    // item), a written one is checked on the written `return` line.
    const returned = () => {
        if (added) return null;
        if (!callable) return 'result-slot-elsewhere';
        // A function written as a value (of a typed binding, a member of an
        // object, an argument) takes its result type from where it stands.
        if (heldAsValue(index, definition)) return 'result-slot-elsewhere';
        // A member that may fill an inherited slot is held to the slot's
        // type, written where the change did not write: a member of an
        // owner with a written supertype, or of any owner where the slots a
        // member fills are not declared by its owner (Go methods satisfy
        // interfaces implicitly; Rust trait members stand in impl blocks).
        if (definition.className && (!traits.memberFillsSupertypeSlots || !plainOwner(index, definition))) return 'inherited-slot';
        return null;
    };
    const yieldsOwn = node => node.descendantsOfType([...YIELDING_NODES]).some(ownResult);
    // The last expression of a body that ends in its value (trait
    // `pathEnds.blockValues`) is the callable's result.
    const tailOf = (value, parent) => traits.pathEnds?.blockValues === true && parent.type === 'block' &&
        sameNode(parent.lastNamedChild, value) && parent.lastChild?.type !== ';';

    // Follow the value to the statement that receives it.
    let value = call;
    let statement;
    let discarded = false;
    for (;;) {
        while (value.parent && TRANSPARENT_NODES.has(value.parent.type)) value = value.parent;
        const parent = value.parent;
        if (!parent) return 'value-unread';
        if ((parent.type === 'expression_statement' && parent.namedChildCount === 1) || DISCARDING_NODES.has(parent.type)) {
            statement = parent;
            discarded = true;
            break;
        }
        // An expression body, or a body's last value, is its callable's
        // result.
        const body = CALLABLE_NODES.has(parent.type) && sameNode(parent.childForFieldName('body'), value) ? parent
            : tailOf(value, parent) && CALLABLE_NODES.has(parent.parent?.type) &&
                sameNode(parent.parent.childForFieldName('body'), parent) ? parent.parent : null;
        if (body) {
            if (callable && sameNode(body, callable)) {
                if (!writtenNode(value, written)) return 'unwritten-line';
                return returned();
            }
            if (!FUNCTION_VALUE_NODES.has(body.type)) return 'nested-result';
            value = body;
            continue;
        }
        statement = statementOf(value);
        if (!statement) return 'value-unread';
        if (!writtenNode(statement, written)) return 'unwritten-line';
        if (RESULT_NODES.has(statement.type)) {
            if (ownResult(statement)) return returned();
            // Returned from a function value nested in the change: the
            // value is that function's.
            const holder = callableOf(statement);
            if (holder && FUNCTION_VALUE_NODES.has(holder.type) && callable &&
                holder.startIndex >= callable.startIndex && holder.endIndex <= callable.endIndex) {
                value = holder;
                continue;
            }
            return 'nested-result';
        }
        break;
    }

    // What the value reaches from that statement on.
    const taint = new Set();
    if (mayNarrow(flow?.narrowing || null, candidates, discarded)) for (const name of narrowedNames(call)) taint.add(name);
    if (discarded && flow) {
        // A call statement can still bind a name in its arguments.
        const facts = callableFacts(index, definition, callable || root, range);
        const own = bindingsOf(statement, flow, facts, callable);
        if (own.escapes && !(added && own.escapes === 'declaration-binding')) return own.escapes;
        for (const name of own.names) taint.add(name);
    }
    if (!discarded) {
        if (!flow) return 'binding-facts-unread';
        const facts = callableFacts(index, definition, callable || root, range);
        const own = bindingsOf(statement, flow, facts, callable);
        if (own.escapes && !(added && own.escapes === 'declaration-binding')) return own.escapes;
        for (const name of own.names) taint.add(name);
        const carrier = value;
        if (flow.receiversRetyped) for (const name of receiversHanded(statement, facts.locals,
            args => args.startIndex <= carrier.startIndex && args.endIndex >= carrier.endIndex)) taint.add(name);
        // A value a generator yields is part of its result in a way this
        // reading does not follow.
        if (yieldsOwn(statement) && !added) return 'yielded';
    }
    if (taint.size === 0) return null;
    if (!flow) return 'binding-facts-unread';
    const facts = callableFacts(index, definition, callable || root, range);
    // Statements the value flows through: each one that reads it passes
    // it on to what it binds, to what it stores, to what it returns.
    const done = new Set([statement.id]);
    for (let grew = true; grew;) {
        grew = false;
        for (const unit of facts.units) {
            if (done.has(unit.id)) continue;
            if (!facts.readsOf(unit).some(name => taint.has(name))) continue;
            done.add(unit.id);
            let header = true;
            ownNodes(unit, node => { if (node.childCount === 0 && !written.has(node.startPosition.row + 1)) header = false; });
            if (!header) return 'read-on-unwritten-line';
            const own = bindingsOf(unit, flow, facts, callable);
            if (own.escapes && !(added && own.escapes === 'declaration-binding')) return own.escapes;
            if (yieldsOwn(unit) && !added) return 'yielded';
            if (RESULT_NODES.has(unit.type)) {
                if (!ownResult(unit)) return added ? null : 'nested-result';
                const verdict = returned();
                if (verdict) return verdict;
            }
            const handed = flow.receiversRetyped
                ? receiversHanded(unit, facts.locals, args => [...identifiersOf(args)].some(name => taint.has(name))) : [];
            for (const name of [...own.names, ...handed]) if (!taint.has(name)) { taint.add(name); grew = true; }
        }
    }
    for (const [line, name] of facts.reads) {
        if (taint.has(name) && !written.has(line)) return 'read-on-unwritten-line';
    }
    return null;
}

/** The identifier a call record's callee span names, or null. */
function calleeIdentifierAt(index, file, callSite) {
    if (!callSite || callSite.start == null) return null;
    try {
        const node = treeOf(index, file)?.rootNode.descendantForIndex(callSite.start);
        return node && node.type === 'identifier' && node.startIndex === callSite.start &&
            node.endIndex === callSite.end ? node : null;
    } catch (_) {
        return null;
    }
}

module.exports = { unsettledReason, UNSETTLED, plainOwner, calleeIdentifierAt, resultReach, typedByHolder, carriesUnwrittenNames };
