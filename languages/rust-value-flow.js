/**
 * Where a Rust call's value goes, from the syntax tree alone (fix #372).
 *
 * Shared by the Rust parser, which records per call record whether the
 * value can possibly be lost or misused (`valueConsumed` / `consumingMethod`),
 * and by audit-async, which classifies a resolved future's flow. The one
 * decision that needs project facts (a method called on the value) is left
 * to the caller: with no producer it is reported as kind 'member', otherwise
 * `memberVerdict(future, member, isMethod, exprNode)` decides.
 */

'use strict';

const { sameNode } = require('./utils');

function fieldIs(parent, field, node) {
    const child = parent.childForFieldName(field);
    return !!child && sameNode(child, node);
}

function hasChildToken(node, tokenType) {
    for (let i = 0; i < node.childCount; i++) {
        if (node.child(i).type === tokenType) return true;
    }
    return false;
}

const RUST_FUNCTION_BOUNDARY = new Set(['function_item', 'closure_expression']);

function rustPatternBinds(pattern, name) {
    if (!pattern) return false;
    if (pattern.type === 'identifier') return pattern.text === name;
    if (pattern.type === 'field_identifier' || pattern.type === 'type_identifier' ||
        pattern.type === 'scoped_identifier') return false;
    for (let i = 0; i < pattern.namedChildCount; i++) {
        const child = pattern.namedChild(i);
        // `Some(x)`: the variant path is not a binding.
        if (sameNode(pattern.childForFieldName('type'), child)) continue;
        if (rustPatternBinds(child, name)) return true;
    }
    return false;
}

function rustLetPattern(letNode) {
    return letNode.childForFieldName('pattern');
}

function rustMatchDestructures(matchNode) {
    const body = matchNode.childForFieldName('body');
    for (const arm of body?.namedChildren || []) {
        if (arm.type !== 'match_arm') continue;
        const pattern = arm.childForFieldName('pattern');
        const inner = pattern?.type === 'match_pattern' ? pattern.namedChild(0) : pattern;
        if (inner && inner.type !== 'identifier' && !(pattern.namedChildCount > 1 && inner.type === 'identifier')) {
            return true;
        }
    }
    return false;
}

/**
 * Where an unpolled Rust future value goes. Returns
 *   { kind: 'awaited' | 'flow' }       polled or handed on
 *   { kind: 'discarded' }              statement position
 *   { kind: 'dropped' }                `let _ = fut;`
 *   { kind: 'stored', holder, binding, declared }  plain local
 *   { kind: 'used-as-value', member? } treated as its Output
 */
function rustValueFlow(exprNode, future, memberVerdict) {
    let expr = exprNode;
    for (let depth = 0; depth < 32; depth++) {
        const parent = expr.parent;
        if (!parent) return { kind: 'flow' };
        switch (parent.type) {
            case 'parenthesized_expression':
            case 'unsafe_block':
            case 'else_clause':
            case 'match_arm':
            case 'match_block':
                expr = parent;
                continue;
            case 'block': {
                // Only the tail expression is the block's value.
                let tail = parent.namedChildCount - 1;
                while (tail >= 0 && ['line_comment', 'block_comment'].includes(parent.namedChild(tail).type)) tail--;
                if (tail < 0 || !sameNode(parent.namedChild(tail), expr)) return { kind: 'flow' };
                expr = parent;
                continue;
            }
            case 'if_expression':
                if (fieldIs(parent, 'condition', expr)) return { kind: 'used-as-value' };
                expr = parent;
                continue;
            case 'match_expression':
                if (fieldIs(parent, 'value', expr)) {
                    return rustMatchDestructures(parent) ? { kind: 'used-as-value' } : { kind: 'flow' };
                }
                expr = parent;
                continue;
            case 'let_condition': {
                if (!fieldIs(parent, 'value', expr)) return { kind: 'flow' };
                const pattern = parent.childForFieldName('pattern');
                return pattern && pattern.type !== 'identifier' ? { kind: 'used-as-value' } : { kind: 'flow' };
            }
            case 'await_expression':
                return { kind: 'awaited' };
            case 'expression_statement': {
                // A block-like expression (`if`/`match`) without `;` at the
                // end of a block is that block's value, not a statement.
                const block = parent.parent;
                if (block?.type === 'block' && !hasChildToken(parent, ';')) {
                    let tail = block.namedChildCount - 1;
                    while (tail >= 0 && ['line_comment', 'block_comment'].includes(block.namedChild(tail).type)) tail--;
                    if (tail >= 0 && sameNode(block.namedChild(tail), parent)) {
                        expr = block;
                        continue;
                    }
                }
                return { kind: 'discarded' };
            }
            case 'let_declaration': {
                if (!fieldIs(parent, 'value', expr)) return { kind: 'flow' };
                const pattern = rustLetPattern(parent);
                if (!pattern || pattern.text === '_') return { kind: 'dropped' };
                if (pattern.type === 'identifier') {
                    return { kind: 'stored', holder: parent, binding: pattern.text, declared: true };
                }
                return { kind: 'used-as-value' };
            }
            case 'assignment_expression': {
                if (!fieldIs(parent, 'right', expr)) return { kind: 'flow' };
                const left = parent.childForFieldName('left');
                if (left?.type === 'identifier') {
                    return { kind: 'stored', holder: parent, binding: left.text, declared: false };
                }
                return left?.text === '_' ? { kind: 'dropped' } : { kind: 'flow' };
            }
            case 'try_expression':
            case 'binary_expression':
            case 'unary_expression':
            case 'compound_assignment_expr':
            case 'range_expression':
                return { kind: 'used-as-value' };
            case 'index_expression':
                return sameNode(parent.namedChild(0), expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'for_expression':
                return fieldIs(parent, 'value', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'while_expression':
                return fieldIs(parent, 'condition', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'call_expression':
                return fieldIs(parent, 'function', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'field_expression': {
                if (!fieldIs(parent, 'value', expr)) return { kind: 'flow' };
                const member = parent.childForFieldName('field')?.text;
                const call = parent.parent;
                const isMethod = call?.type === 'call_expression' && fieldIs(call, 'function', parent);
                // Unresolved producer (a first, cheap pass): undecided.
                if (!future) return { kind: 'member', member, node: expr };
                return memberVerdict(future, member, isMethod, expr);
            }
            default:
                // Arguments, collections, struct fields, returns, closures,
                // references, casts, `Box::pin(..)`, macro token trees.
                return { kind: 'flow' };
        }
    }
    return { kind: 'flow' };
}

/**
 * Follow a local that received a future: the first use that takes it for its
 * Output, or whether it is used at all before it is shadowed, reassigned or
 * goes out of scope. Returns { read: bool, misuse: node|null }.
 */
function rustStoredFutureUse(holder, name, future, memberVerdict) {
    let statement = holder;
    while (statement.parent && statement.parent.type !== 'block') statement = statement.parent;
    const declBlock = statement.parent;
    if (!declBlock) return { read: true, misuse: null };
    let read = false;
    let misuse = null;
    let stop = false;
    // A loop around an assignment can read the value on the next iteration.
    if (holder.type === 'assignment_expression') {
        for (let up = holder.parent; up && !RUST_FUNCTION_BOUNDARY.has(up.type); up = up.parent) {
            if (['loop_expression', 'while_expression', 'for_expression'].includes(up.type)) return { read: true, misuse: null };
        }
    }
    // Only nodes whose text holds `name` can read, misuse, rebind or
    // overwrite the local (fix #388): the walk skips every other subtree.
    // Offsets of every substring occurrence in the region the walk can
    // reach (the declaring block, or the enclosing function for an
    // assignment that may be read after its block).
    let region = declBlock;
    if (holder.type === 'assignment_expression') {
        region = null;
        for (let up = declBlock; up; up = up.parent) {
            region = up;
            if (RUST_FUNCTION_BOUNDARY.has(up.type)) break;
        }
    }
    const occurrences = [];
    {
        const text = region.text;
        const base = region.startIndex;
        for (let at = name ? text.indexOf(name) : -1; at >= 0; at = text.indexOf(name, at + 1)) {
            occurrences.push(base + at);
        }
    }
    const mayHoldName = node => {
        const start = node.startIndex;
        let lo = 0;
        let hi = occurrences.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (occurrences[mid] < start) lo = mid + 1;
            else hi = mid;
        }
        return lo < occurrences.length && occurrences[lo] + name.length <= node.endIndex;
    };
    const visit = node => {
        if (stop || misuse) return;
        if (!mayHoldName(node)) return;
        switch (node.type) {
            case 'function_item':
                return;
            case 'closure_expression':
                if (rustPatternBinds(node.childForFieldName('parameters'), name)) return;
                break;
            case 'match_arm':
                if (rustPatternBinds(node.childForFieldName('pattern'), name)) return;
                break;
            case 'token_tree':
                // Macro arguments (`join!`, `select!`, `println!`) consume it.
                if (tokenTreeNames(node, name)) read = true;
                return;
            case 'identifier':
                if (node.text === name) {
                    read = true;
                    const flow = rustValueFlow(node, future, memberVerdict);
                    if (flow.kind === 'used-as-value' || flow.kind === 'member') misuse = node;
                }
                return;
            case 'block': {
                for (let i = 0; i < node.namedChildCount && !stop && !misuse; i++) {
                    const child = node.namedChild(i);
                    if (child.type === 'let_declaration' && rustPatternBinds(rustLetPattern(child), name)) {
                        const value = child.childForFieldName('value');
                        if (value) visit(value);
                        return; // shadowed for the rest of this block
                    }
                    visit(child);
                }
                return;
            }
            case 'assignment_expression': {
                const left = node.childForFieldName('left');
                if (left?.type === 'identifier' && left.text === name) {
                    const right = node.childForFieldName('right');
                    if (right) visit(right);
                    stop = true; // overwritten: the old future is dropped
                    return;
                }
                break;
            }
            default:
                break;
        }
        for (let i = 0; i < node.namedChildCount && !stop && !misuse; i++) visit(node.namedChild(i));
    };
    let started = false;
    for (let i = 0; i < declBlock.namedChildCount && !stop && !misuse; i++) {
        const child = declBlock.namedChild(i);
        if (!started) {
            if (sameNode(child, statement)) {
                started = true;
                // `x = fut` inside an expression statement: nothing else in it.
            }
            continue;
        }
        if (child.type === 'let_declaration' && rustPatternBinds(rustLetPattern(child), name)) {
            const value = child.childForFieldName('value');
            if (value) visit(value);
            break;
        }
        visit(child);
    }
    // An assignment to an outer local stays readable after its block ends.
    if (!read && !stop && !misuse && holder.type === 'assignment_expression') {
        let inner = declBlock;
        for (let outer = inner.parent; outer && !stop && !misuse; inner = outer, outer = outer.parent) {
            if (RUST_FUNCTION_BOUNDARY.has(outer.type)) break;
            if (outer.type !== 'block') continue;
            let after = false;
            for (let i = 0; i < outer.namedChildCount && !stop && !misuse; i++) {
                const child = outer.namedChild(i);
                if (!after) {
                    if (child.startIndex <= inner.startIndex && child.endIndex >= inner.endIndex) after = true;
                    continue;
                }
                visit(child);
            }
        }
    }
    return { read: read || !!misuse, misuse };
}

function tokenTreeNames(node, name) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'identifier' && child.text === name) return true;
        if (child.type === 'token_tree' && tokenTreeNames(child, name)) return true;
    }
    return false;
}

/**
 * Parser fact (fix #372): can this call's value be lost or used as a
 * resolved value, judged before knowing what the call returns? Mirrors
 * audit-async's pre-resolution test exactly: a value that is awaited or
 * flows on is consumed; a method called on it (directly or on the local it
 * is stored in) is recorded as `consumingMethod` for the name-level Output
 * test; anything else (discarded, dropped, stored and never read, used as
 * a value, a field read) stays open.
 * @param {object} callNode - call_expression
 * @returns {{ valueConsumed: string|null, consumingMethod: string|null }}
 */
function rustValueFacts(callNode) {
    const open = { valueConsumed: null, consumingMethod: null };
    let expr = callNode;
    while (expr.parent?.type === 'parenthesized_expression') expr = expr.parent;
    const parent = expr.parent;
    if (parent?.type === 'await_expression') return { valueConsumed: 'awaited', consumingMethod: null };
    if (parent?.type === 'arguments') return { valueConsumed: 'argument', consumingMethod: null };
    const methodOf = flow => {
        const member = flow.node?.parent;
        const call = member?.parent;
        return call?.type === 'call_expression' && fieldIs(call, 'function', member) ? flow.member || null : null;
    };
    const flow = rustValueFlow(callNode, null, null);
    if (flow.kind === 'awaited') return { valueConsumed: 'awaited', consumingMethod: null };
    if (flow.kind === 'flow') return { valueConsumed: 'flow', consumingMethod: null };
    if (flow.kind === 'member') {
        const method = methodOf(flow);
        return method ? { valueConsumed: null, consumingMethod: method } : open;
    }
    if (flow.kind !== 'stored') return open;
    const use = rustStoredFutureUse(flow.holder, flow.binding, null, null);
    if (!use.read) return open;
    if (!use.misuse) return { valueConsumed: 'stored', consumingMethod: null };
    const misuseFlow = rustValueFlow(use.misuse, null, null);
    if (misuseFlow.kind !== 'member') return open;
    const method = methodOf(misuseFlow);
    return method ? { valueConsumed: null, consumingMethod: method } : open;
}

// Standard-library path roots: a `std::..::f()` call never reaches a
// project definition.
const STD_ROOTS = new Set(['std', 'core', 'alloc']);

/**
 * Compact file-level shape of a call record whose value is not consumed
 * where produced (fix #372), persisted per file so audit-async decides
 * whether a file can hold a lost future without loading its call records:
 *   name            bare call
 *   name.Type       method call (Type = receiverType, may be empty)
 *   name:Last       path call (Last = last receiver segment, 'std' for std roots)
 *   ...~member      a method is called on the value
 * @param {object} record - call record
 */
function openCallShape(record) {
    let shape = record.name;
    if (record.isPathCall) {
        const parts = String(record.receiver || '').split('::').filter(Boolean);
        shape += ':' + (STD_ROOTS.has(parts[0]) ? 'std' : (parts[parts.length - 1] || ''));
    } else if (record.isMethod) {
        shape += '.' + (record.receiverType || '');
    }
    return record.consumingMethod ? `${shape}~${record.consumingMethod}` : shape;
}

/**
 * The call-record fields an openCallShape keeps, as a record-shaped object
 * (a superset test: fields the shape drops only ever narrow a match).
 */
function parseOpenCallShape(shape) {
    const text = String(shape);
    const tilde = text.indexOf('~');
    const head = tilde < 0 ? text : text.slice(0, tilde);
    const record = tilde < 0 ? {} : { consumingMethod: text.slice(tilde + 1) };
    const colon = head.indexOf(':');
    const dot = head.indexOf('.');
    if (colon >= 0) {
        const last = head.slice(colon + 1);
        return { ...record, name: head.slice(0, colon), isMethod: true, isPathCall: true,
            receiver: last === 'std' ? 'std::_' : last };
    }
    if (dot >= 0) {
        const type = head.slice(dot + 1);
        return { ...record, name: head.slice(0, dot), isMethod: true, ...(type && { receiverType: type }) };
    }
    return { ...record, name: head };
}

module.exports = {
    openCallShape,
    parseOpenCallShape,
    RUST_FUNCTION_BOUNDARY,
    rustPatternBinds,
    rustLetPattern,
    rustMatchDestructures,
    rustValueFlow,
    rustStoredFutureUse,
    tokenTreeNames,
    rustValueFacts,
};
