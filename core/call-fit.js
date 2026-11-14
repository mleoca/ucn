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
 * Every answer is a proof or a named reason. A reason means review, never a
 * mismatch.
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

module.exports = { unsettledReason, UNSETTLED, plainOwner, calleeIdentifierAt };
