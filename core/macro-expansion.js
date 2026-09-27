'use strict';

/**
 * Token-level expansion of C/C++ function-like macro invocations (fix #362).
 *
 * `#define XX(uc, lc) case UV_FS_##uc: fs__##lc(req); break;` followed by
 * `XX(STAT, stat)` calls `fs__stat`, but no AST node spells that name: the
 * call target exists only after the preprocessor substitutes arguments and
 * pastes tokens. This module performs that substitution for invocations of
 * project macros, parses the substituted token stream with the language's own
 * tree-sitter grammar, and reports the identifiers the expansion produced:
 *
 *   calls - pasted (`fs__##lc`) or argument-substituted (`CALL(foo)` ->
 *           `foo()`) identifiers in call position, attributed to the
 *           invocation site with `macroExpansion` provenance
 *   refs  - pasted identifiers in value position (X-macro tables:
 *           `{ #name, handle_##name }`), used as deadcode liveness
 *   blind - invocations whose expansion cannot be computed (budget,
 *           unbalanced arguments, a pasted operand that is an unexpanded
 *           object-like project macro); disclosed, never guessed
 *
 * Nothing here is persisted: macro templates are indexed per file
 * (`ppParams`/`ppBody` on macro symbols) and expansions are derived from the
 * current index on demand, so a header edit or an incremental rebuild never
 * leaves stale expansion edges behind. Work is proportional to invocations of
 * macros that can produce names (pasting or higher-order macros, or macros
 * that invoke them); a project without such macros pays one symbol scan.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { langTraits, getParser, safeParse, PARSE_OPTIONS } = require('../languages');
const { lexPP, splitArguments, pastePatterns } = require('../languages/c-preprocessor');
const { codeUnitCompare } = require('./shared');

const MAX_DEPTH = 64;
const MAX_TOKENS = 20000;
const MAX_VARIANTS = 4;

class BlindExpansion extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

const WRAPPERS = {
    statement: ['void __ucn_macro_expansion__(void) { switch (0) {\n', '\n; } }\n'],
    file: ['', '\n;\n'],
    initializer: ['static int __ucn_macro_expansion__[] = {\n', '\n};\n'],
};

/** Per-build memo; reset with the other definition-derived memos. */
function expansionState(index) {
    if (index._macroExpansion) return index._macroExpansion;
    const templates = new Map();   // name -> function-like macro defs with a template
    const macroDefs = new Map();   // name -> every macro def (object- and function-like)
    const defsByFile = new Map();  // file -> function-like template defs
    for (const [name, defs] of index.symbols) {
        for (const def of defs) {
            if (def.type !== 'macro') continue;
            if (!langTraits(index.files.get(def.file)?.language)?.textualIncludes) continue;
            if (!macroDefs.has(name)) macroDefs.set(name, []);
            macroDefs.get(name).push(def);
            if (!def.functionLike || typeof def.ppBody !== 'string') continue;
            if (!templates.has(name)) templates.set(name, []);
            templates.get(name).push(def);
            if (!defsByFile.has(def.file)) defsByFile.set(def.file, []);
            defsByFile.get(def.file).push(def);
        }
    }
    const bodyTokens = new Map();
    const tokensOf = def => {
        let tokens = bodyTokens.get(def);
        if (!tokens) {
            tokens = lexPP(def.ppBody);
            bodyTokens.set(def, tokens);
        }
        return tokens;
    };
    const relevant = productiveMacros(index, templates, tokensOf);
    const state = {
        templates, macroDefs, defsByFile, relevant, tokensOf,
        byFile: new Map(), summary: null, includeTokens: new Map(),
        words: new Map(), visibleMemo: new Map(), persistOut: new Map(), signature: null,
    };
    index._macroExpansion = state;
    return state;
}

/**
 * Macros whose invocations can produce a project name the source does not
 * spell (the invocations worth expanding). Parameter flow, per definition:
 * a parameter is productive when its argument can become a paste operand,
 * the callee of a call (`p(...)`, higher-order `LIST(X)`), or an argument
 * at a productive position of a macro the body invokes. A literal-only
 * paste that spells a project name makes the macro productive by itself.
 * gtest-style assertion macros (arguments only ever in value position,
 * pastes only of `__LINE__`-built locals) are not expanded at all.
 */
/**
 * Can a paste pattern (literal pieces, null for a parameter wildcard that may
 * be empty) spell a name the project defines? Memoized per build.
 */
function patternSpellsProjectName(index, pieces) {
    const state = index._macroSpellable || (index._macroSpellable = { names: null, memo: new Map() });
    const key = pieces.map(piece => piece === null ? '\u0000' : piece).join('\u0001');
    if (state.memo.has(key)) return state.memo.get(key);
    const literal = pieces.filter(piece => piece !== null);
    let result = true;
    if (literal.length > 0) {
        if (!state.names) state.names = [...index.symbols.keys()];
        const pattern = new RegExp('^' + pieces.map(piece => piece === null ? '[A-Za-z0-9_$]*'
            : piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
        const longest = literal.reduce((a, b) => (b.length > a.length ? b : a));
        result = state.names.some(candidate => candidate.includes(longest) && pattern.test(candidate));
    }
    state.memo.set(key, result);
    return result;
}

function productiveMacros(index, templates, tokensOf) {
    // Can a paste of these operands spell a project name? Parameter operands
    // are wildcards (possibly empty: an empty argument is a placemarker);
    // a chain of literal operands only is checked by name directly below.
    const pasteCanSpell = (operands, paramIndex) => {
        if (operands.some(op => op.k !== 'id' && op.k !== 'num')) return true;
        return patternSpellsProjectName(index,
            operands.map(op => op.k === 'id' && paramIndex.has(op.v) ? null : op.v));
    };
    // Does some definition of `callee` copy its parameter at `argIndex` into
    // its output as written (not only pasted or stringized)?
    const passthrough = new Map();
    const passesThrough = (callee, argIndex) => {
        const key = `${callee}\0${argIndex}`;
        if (passthrough.has(key)) return passthrough.get(key);
        let result = false;
        for (const def of templates.get(callee) || []) {
            const params = def.ppParams || [];
            const position = def.ppVariadic && argIndex >= params.length - 1 ? params.length - 1 : argIndex;
            const param = params[position];
            if (param === undefined) continue;
            const body = tokensOf(def);
            if (body.some((token, i) => token.k === 'id' && token.v === param &&
                body[i - 1]?.v !== '#' && body[i - 1]?.v !== '##' && body[i + 1]?.v !== '##')) {
                result = true;
                break;
            }
        }
        passthrough.set(key, result);
        return result;
    };
    const productive = new Map();   // name -> Set of productive param indices
    const fixed = new Set();         // names with a literal paste spelling a project name
    const deps = [];                 // [name, paramIndex, calleeName, argIndex]
    const mark = (name, i) => {
        if (!productive.has(name)) productive.set(name, new Set());
        const set = productive.get(name);
        if (set.has(i)) return false;
        set.add(i);
        return true;
    };
    const variadicOf = new Map();
    for (const [name, defs] of templates) {
        for (const def of defs) {
            const tokens = tokensOf(def);
            const params = def.ppParams || [];
            if (def.ppVariadic) variadicOf.set(name, params.length - 1);
            const paramIndex = new Map(params.map((param, i) => [param, i]));
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if (t.k === 'punct' && t.v === '##') continue;
                if (tokens[i + 1]?.v === '##' && tokens[i + 1].k === 'punct') {
                    const operands = [t];
                    let j = i + 1;
                    while (tokens[j]?.v === '##' && tokens[j + 1]) {
                        operands.push(tokens[j + 1]);
                        j += 2;
                    }
                    const paramOperands = operands.filter(op => op.k === 'id' && paramIndex.has(op.v));
                    // A paste whose literal pieces no project name can
                    // contain (`suite##_##name##_Test` in a project with no
                    // `*_*_Test` symbol) produces no name worth expanding
                    // for (fix #385: gtest TEST(...) sites, a third of fmt's
                    // cold-build expansion work, produced nothing).
                    if (paramOperands.length > 0 && !pasteCanSpell(operands, paramIndex)) {
                        i = j - 1;
                        continue;
                    }
                    for (const op of paramOperands) mark(name, paramIndex.get(op.v));
                    if (paramOperands.length === 0 && index.symbols.has(operands.map(op => op.v).join(''))) {
                        fixed.add(name);
                    }
                    i = j - 1;
                    continue;
                }
                if (t.k !== 'id') continue;
                if (paramIndex.has(t.v)) {
                    const next = tokens[i + 1];
                    if (next?.v === '(' || (next?.k === 'id' && paramIndex.has(next.v))) {
                        mark(name, paramIndex.get(t.v));
                    }
                    continue;
                }
                if (tokens[i + 1]?.v !== '(' || !templates.has(t.v)) continue;
                const split = splitArguments(tokens, i + 1);
                if (!split) continue;
                split.args.forEach((arg, argIndex) => {
                    // A parameter inside a nested invocation in this argument
                    // (`OUTER(INNER(p))`) reaches OUTER's argument only when
                    // INNER passes that parameter through to its output; a
                    // pasted-only one (`INNER(a) = a##_Test`) does not (fix
                    // #385). Its own dependency on INNER is recorded when the
                    // scan reaches INNER.
                    const nestedAt = nestedInvocationSlots(arg, templates);
                    arg.forEach((token, k) => {
                        if (token.k !== 'id' || !paramIndex.has(token.v)) return;
                        const slot = nestedAt[k];
                        if (slot && !passesThrough(slot.name, slot.argIndex)) return;
                        deps.push([name, paramIndex.get(token.v), t.v, argIndex]);
                    });
                });
                deps.push([name, -1, t.v, -1]);
            }
        }
    }
    for (let changed = true; changed;) {
        changed = false;
        for (const [name, param, callee, argIndex] of deps) {
            if (param < 0) {
                if (fixed.has(callee) && !fixed.has(name)) {
                    fixed.add(name);
                    changed = true;
                }
                continue;
            }
            const calleeParams = productive.get(callee);
            if (!calleeParams) continue;
            const variadic = variadicOf.get(callee);
            const position = variadic != null && argIndex > variadic ? variadic : argIndex;
            if (calleeParams.has(position) && mark(name, param)) changed = true;
        }
    }
    return new Set([...productive.keys(), ...fixed]);
}

/**
 * For each token of a macro argument, the outermost template-macro
 * invocation within the argument that contains it: { name, argIndex }, or
 * undefined for a token at the argument's own level.
 */
function nestedInvocationSlots(arg, templates) {
    const slots = new Array(arg.length);
    for (let i = 0; i < arg.length; i++) {
        const token = arg[i];
        if (token.k !== 'id' || !templates.has(token.v) || arg[i + 1]?.v !== '(') continue;
        const split = splitArguments(arg, i + 1);
        if (!split) continue;
        let argIndex = 0;
        let depth = 0;
        for (let k = i + 2; k < split.close; k++) {
            const inner = arg[k];
            if (inner.k === 'punct' && inner.v === '(') depth++;
            else if (inner.k === 'punct' && inner.v === ')') depth--;
            else if (depth === 0 && inner.k === 'punct' && inner.v === ',') {
                argIndex++;
                continue;
            }
            slots[k] = { name: token.v, argIndex };
        }
        i = split.close;
    }
    return slots;
}

function defKey(def) {
    return `${def.relativePath || def.file}:${def.startLine}`;
}

/** `#undef NAME` lines of a file (directive tokens, not text matching). */
function undefLines(fileState, lines) {
    if (fileState.undefs) return fileState.undefs;
    const undefs = new Map();
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        const hash = line.indexOf('#');
        if (hash < 0 || line.slice(0, hash).trim() !== '') continue;
        const tokens = lexPP(line);
        if (tokens[0]?.v === '#' && tokens[1]?.v === 'undef' && tokens[2]?.k === 'id') {
            if (!undefs.has(tokens[2].v)) undefs.set(tokens[2].v, []);
            undefs.get(tokens[2].v).push(row + 1);
        }
    }
    fileState.undefs = undefs;
    return undefs;
}

/**
 * Macro definitions of `name` in effect at (file, line). Same-file
 * definitions win (nearest preceding; an earlier one with no `#undef`
 * between is a conditional alternative); otherwise definitions visible
 * through the file's #include closure. Returns { defs, ambiguous }.
 */
function definitionsInScope(index, state, site, name) {
    const memoKey = `${name}\0${site.line}`;
    const hit = site.lookupMemo.get(memoKey);
    if (hit) return hit;
    const all = state.macroDefs.get(name) || [];
    let result = { defs: [], ambiguous: false };
    if (all.length > 0) {
        const sameFile = all.filter(def => def.file === site.file && def.startLine < site.line)
            .sort((a, b) => b.startLine - a.startLine);
        if (sameFile.length > 0) {
            const undefs = undefLines(site.fileState, site.lines).get(name) || [];
            const chosen = [sameFile[0]];
            for (let i = 1; i < sameFile.length; i++) {
                const later = chosen[chosen.length - 1];
                if (undefs.some(line => line > sameFile[i].endLine && line < later.startLine)) break;
                chosen.push(sameFile[i]);
            }
            result = { defs: chosen, ambiguous: false };
        } else {
            const { _textualIncludeClosures } = require('./callers');
            const closure = _textualIncludeClosures(index, site.file).all;
            const visible = all.filter(def => def.file !== site.file && closure.has(def.file))
                .sort((a, b) => codeUnitCompare(defKey(a), defKey(b)));
            result = { defs: visible, ambiguous: false };
        }
        // Identical redefinitions are one definition; different bodies are
        // alternatives the preprocessor chooses between by configuration.
        const distinct = new Map();
        for (const def of result.defs) {
            const key = def.functionLike
                ? `f\0${(def.ppParams || []).join(',')}\0${def.ppVariadic ? 1 : 0}\0${def.ppBody}`
                : `o\0${def.startLine}\0${def.file}`;
            if (!distinct.has(key)) distinct.set(key, def);
        }
        const defs = [...distinct.values()];
        result = {
            defs: defs.slice(0, MAX_VARIANTS),
            ambiguous: defs.length > 1,
            truncated: defs.length > MAX_VARIANTS,
        };
    }
    site.lookupMemo.set(memoKey, result);
    return result;
}

/**
 * Preprocessor macro definitions of `name` in effect at a C/C++ source site
 * (fix #377): same-file definitions above the line (an intervening `#undef`
 * ends one), else definitions in the file's #include closure. A call spelled
 * NAME( there invokes the macro, not a same-named function. Returns
 * { defs, ambiguous, reach } with reach 'file' | 'include', or null when the
 * name has no macro definition or the file cannot be read.
 */
function macroDefinitionsAt(index, filePath, line, name) {
    const state = expansionState(index);
    const all = state.macroDefs.get(name);
    if (!all || all.length === 0) return null;
    let lines;
    try {
        lines = index._getFileLines(filePath);
    } catch {
        return null;
    }
    if (!state.shadowFileStates) state.shadowFileStates = new Map();
    let fileState = state.shadowFileStates.get(filePath);
    if (!fileState) {
        fileState = {};
        state.shadowFileStates.set(filePath, fileState);
    }
    const site = { file: filePath, line, lines, fileState, lookupMemo: new Map() };
    const result = definitionsInScope(index, state, site, name);
    if (result.defs.length === 0) return null;
    const sameFile = result.defs.every(def => def.file === filePath);
    return { ...result, reach: sameFile ? 'file' : 'include' };
}

/** Tokens of a macro's replacement list (function- or object-like). */
function macroBodyTokens(index, def) {
    if (typeof def.ppBody !== 'string') return null;
    return expansionState(index).tokensOf(def);
}

/** Does an invocation with `args` fit the macro's parameter list? */
function arityFits(def, args) {
    const params = def.ppParams || [];
    const count = params.length === 0 && args.length === 1 && args[0].length === 0 ? 0 : args.length;
    if (def.ppVariadic) return count >= params.length - 1;
    return count === params.length;
}

/** Expand one invocation of `def` with argument token lists `args`. */
function substitute(index, state, site, def, args, hide, depth) {
    if (depth > MAX_DEPTH) throw new BlindExpansion('expansion-depth');
    const params = def.ppParams || [];
    if (typeof def.ppBody !== 'string') throw new BlindExpansion('no-template');
    let actual = args;
    if (params.length === 0 && actual.length === 1 && actual[0].length === 0) actual = [];
    if (def.ppVariadic) {
        // The last parameter is the variadic one (`...` as __VA_ARGS__, or
        // GNU `name...`); it takes every remaining argument with its commas.
        const namedCount = params.length - 1;
        if (actual.length < namedCount) throw new BlindExpansion('argument-count');
        const joined = [];
        actual.slice(namedCount).forEach((arg, i) => {
            if (i > 0) joined.push({ v: ',', k: 'punct', o: 'arg' });
            joined.push(...arg);
        });
        actual = [...actual.slice(0, namedCount), joined];
    } else if (actual.length !== params.length) {
        throw new BlindExpansion('argument-count');
    }
    const paramIndex = new Map(params.map((p, i) => [p, i]));
    const body = state.tokensOf(def);
    const expandedArgs = new Map();
    const expandedArg = i => {
        if (!expandedArgs.has(i)) {
            expandedArgs.set(i, expandTokens(index, state, site, actual[i], hide, depth + 1));
        }
        return expandedArgs.get(i);
    };
    const out = [];
    for (let i = 0; i < body.length; i++) {
        const t = body[i];
        if (t.k === 'punct' && t.v === '#' && body[i + 1]?.k === 'id' && paramIndex.has(body[i + 1].v)) {
            const arg = actual[paramIndex.get(body[i + 1].v)];
            out.push({ v: JSON.stringify(arg.map(a => a.v).join(' ')), k: 'str', o: 'str' });
            i++;
            continue;
        }
        if (t.k === 'id' && t.v === '__VA_OPT__' && def.ppVariadic && body[i + 1]?.v === '(') {
            const split = splitArguments(body, i + 1);
            if (!split) throw new BlindExpansion('va-opt');
            const hasRest = actual[actual.length - 1].length > 0;
            if (hasRest) {
                const inner = body.slice(i + 2, split.close);
                for (const token of inner) out.push({ ...token, o: 'body' });
            }
            i = split.close;
            continue;
        }
        if (t.k === 'id' && paramIndex.has(t.v)) {
            const pasted = body[i - 1]?.v === '##' || body[i + 1]?.v === '##';
            const arg = pasted ? actual[paramIndex.get(t.v)] : expandedArg(paramIndex.get(t.v));
            if (arg.length === 0 && pasted) out.push({ v: '', k: 'placemarker', o: 'body' });
            for (const token of arg) out.push(token);
            continue;
        }
        if (t.k === 'punct' && t.v === '##') {
            out.push({ v: '##', k: 'paste-op', o: 'body' });
            continue;
        }
        out.push({ v: t.v, k: t.k, o: 'body' });
    }
    // Paste pass: `##` from the replacement list (never one that arrived in
    // an argument) joins its neighbours into one token.
    const pasted = [];
    for (let i = 0; i < out.length; i++) {
        const t = out[i];
        if (t.k !== 'paste-op') {
            pasted.push(t);
            continue;
        }
        const left = pasted.pop();
        const right = out[i + 1];
        i++;
        if (!left || !right) throw new BlindExpansion('paste-operand');
        if (left.k === 'placemarker') {
            pasted.push(right);
            continue;
        }
        if (right.k === 'placemarker') {
            pasted.push(left);
            continue;
        }
        if (left.opaque || right.opaque) throw new BlindExpansion('opaque-paste-operand');
        const text = left.v + right.v;
        const relexed = lexPP(text);
        const token = relexed.length === 1 && relexed[0].v === text
            ? { v: text, k: relexed[0].k, o: 'paste' }
            // An invalid paste is undefined behavior; keep the spelling so
            // no name is invented from it.
            : { v: text, k: 'invalid', o: 'paste' };
        pasted.push(token);
    }
    const result = pasted.filter(t => t.k !== 'placemarker');
    site.budget -= result.length;
    if (site.budget < 0) throw new BlindExpansion('expansion-budget');
    const inner = new Set(hide);
    inner.add(def.name);
    return expandTokens(index, state, site, result, inner, depth + 1);
}

/** Rescan a token list, expanding invocations of project function-like macros. */
function expandTokens(index, state, site, tokens, hide, depth) {
    if (depth > MAX_DEPTH) throw new BlindExpansion('expansion-depth');
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.k !== 'id' || t.noexpand || !state.macroDefs.has(t.v)) {
            out.push(t);
            continue;
        }
        if (hide.has(t.v)) {
            out.push({ ...t, noexpand: true });
            continue;
        }
        const scope = definitionsInScope(index, state, site, t.v);
        let def = scope.defs[0];
        if (!def) {
            out.push(t);
            continue;
        }
        if (!def.functionLike) {
            // An object-like macro expands to its replacement list when every
            // definition in scope agrees on it; otherwise (or without a kept
            // list) the token stays as spelled and may not take part in a
            // paste. Tokens replacing an argument-spelled name are produced,
            // not spelled at the site.
            const bodies = new Set(scope.defs.map(other =>
                !other.functionLike && typeof other.ppBody === 'string' ? other.ppBody : null));
            if (scope.truncated || bodies.size !== 1 || bodies.has(null)) {
                out.push({ ...t, opaque: true });
                continue;
            }
            const origin = t.o === 'arg' || t.o === 'paste' ? 'paste' : t.o;
            const replaced = lexPP(def.ppBody).map(token => ({ v: token.v, k: token.k, o: origin }));
            site.budget -= replaced.length;
            if (site.budget < 0) throw new BlindExpansion('expansion-budget');
            const inner = new Set(hide);
            inner.add(t.v);
            out.push(...expandTokens(index, state, site, replaced, inner, depth + 1));
            continue;
        }
        if (tokens[i + 1]?.v !== '(') {
            out.push(t);
            continue;
        }
        const split = splitArguments(tokens, i + 1);
        if (!split) throw new BlindExpansion('unbalanced-arguments');
        // A configuration alternative whose parameter list cannot take these
        // arguments is not the definition in effect (it would not compile).
        if (!arityFits(def, split.args)) {
            def = scope.defs.find(other => other.functionLike && arityFits(other, split.args)) || def;
        }
        // Only alternatives of a macro that is actually expanded can change
        // the produced names (an ambiguous object-like attribute cannot).
        if (scope.ambiguous) site.ambiguous = true;
        site.usedDefs.add(defKey(def));
        out.push(...substitute(index, state, site, def, split.args, hide, depth + 1));
        i = split.close;
    }
    return out;
}

function countErrors(root) {
    if (!root.hasError) return 0;
    let count = 0;
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (node.type === 'ERROR' || node.isMissing) count++;
        if (!node.hasError && node.type !== 'ERROR') continue;
        for (let i = 0; i < node.childCount; i++) stack.push(node.child(i));
    }
    return count;
}

const DECLARATOR_PARENTS = new Set([
    'function_declarator', 'init_declarator', 'pointer_declarator',
    'array_declarator', 'parameter_declaration', 'declaration',
    'field_declaration', 'reference_declarator', 'parenthesized_declarator',
    'optional_parameter_declaration', 'variadic_declarator',
]);

function calleeNameNode(fn) {
    let node = fn;
    for (let guard = 0; node && guard < 8; guard++) {
        if (node.type === 'identifier') return node;
        if (node.type === 'qualified_identifier' || node.type === 'template_function') {
            node = node.childForFieldName('name');
            continue;
        }
        return null;
    }
    return null;
}

function producesProjectName(index, tokens) {
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.k !== 'id' || !index.symbols.has(t.v)) continue;
        if (t.o === 'paste' || t.foreign) return true;
        if (t.o === 'arg' && !t.srcCall && tokens[i + 1]?.v === '(') return true;
    }
    return false;
}

/**
 * Parse the substituted token stream and classify the identifiers the
 * expansion produced (not the replacement list's own literal tokens, which
 * the macro-body scan already attributes to the definition).
 */
function classifyExpansion(parser, tokens, preferred) {
    const pieces = [];
    const spans = [];
    let offset = 0;
    for (const t of tokens) {
        if (t.k === 'placemarker') continue;
        if (pieces.length) offset += 1;
        spans.push({ start: offset, token: t });
        pieces.push(t.v);
        offset += t.v.length;
    }
    const text = pieces.join(' ');
    let best = null;
    for (const wrapper of preferred) {
        const [prefix, suffix] = WRAPPERS[wrapper];
        const tree = safeParse(parser, prefix + text + suffix, undefined, PARSE_OPTIONS);
        const errors = countErrors(tree.rootNode);
        if (!best || errors < best.errors) {
            best?.tree.delete?.();
            best = { tree, prefix, errors };
        } else {
            tree.delete?.();
        }
        if (errors === 0) break;
    }
    const tokenAt = new Map(spans.map(span => [span.start, span.token]));
    const calls = [];
    const refs = [];
    const produced = (node) => {
        const token = tokenAt.get(node.startIndex - best.prefix.length);
        if (!token || token.v !== node.text) return null;
        return token.o === 'paste' || token.o === 'arg' ? token : null;
    };
    const callees = new Set();
    const stack = [best.tree.rootNode];
    const found = [];
    while (stack.length) {
        const node = stack.pop();
        if (node.type === 'call_expression') {
            const nameNode = calleeNameNode(node.childForFieldName('function'));
            if (nameNode) {
                callees.add(nameNode.startIndex);
                const token = produced(nameNode);
                if (token) {
                    const args = node.childForFieldName('arguments');
                    const argCount = (args?.namedChildren || [])
                        .filter(child => child.type !== 'comment').length;
                    found.push({ kind: 'call', token, argCount, at: nameNode.startIndex });
                }
            }
        } else if (node.type === 'identifier' && !callees.has(node.startIndex)) {
            const parent = node.parent;
            const declarator = parent && DECLARATOR_PARENTS.has(parent.type) &&
                parent.childForFieldName('declarator')?.startIndex === node.startIndex;
            const token = !declarator && produced(node);
            if (token && (token.o === 'paste' || token.foreign)) {
                found.push({ kind: 'ref', token, at: node.startIndex });
            }
        }
        for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
    }
    for (const item of found) {
        if (item.kind === 'call') calls.push(item);
        else if (!callees.has(item.at)) refs.push(item);
    }
    best.tree.delete?.();
    return { calls, refs };
}

/**
 * classifyExpansion memoized per build (fix #365): the classification
 * depends only on the stream's token texts and origins and the wrapper
 * order, and invocations repeat (`cJSON_Add...ToObject(...)`, list
 * entries). Results are stored as stream positions and rebound to the
 * current tokens, whose source offsets differ per invocation.
 */
function classifyExpansionMemo(state, parser, tokens, preferred) {
    const kept = tokens.filter(t => t.k !== 'placemarker');
    const key = preferred.join(',') + '\u0002' + kept.map(t =>
        `${t.v}\u0001${t.o || ''}\u0001${t.foreign ? 1 : 0}`).join('\u0002');
    if (!state.classifyMemo) state.classifyMemo = new Map();
    let memo = state.classifyMemo.get(key);
    if (!memo) {
        const result = classifyExpansion(parser, tokens, preferred);
        const position = new Map(kept.map((t, i) => [t, i]));
        memo = {
            calls: result.calls.map(c => ({ ...c, token: position.get(c.token) })),
            refs: result.refs.map(r => ({ ...r, token: position.get(r.token) })),
        };
        state.classifyMemo.set(key, memo);
    }
    return {
        calls: memo.calls.map(c => ({ ...c, token: kept[c.token] })),
        refs: memo.refs.map(r => ({ ...r, token: kept[r.token] })),
    };
}

function lineStarts(content) {
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function positionOf(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] };
}

/**
 * Names of relevant (name-producing) macros a file can invoke: its own
 * definitions and those of every file in its #include closure.
 */
/** Identifier-shaped words of a file (a prefilter; invocations are token-checked). */
function wordsOf(state, filePath, text) {
    let words = state.words.get(filePath);
    if (!words) {
        words = new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
        state.words.set(filePath, words);
    }
    return words;
}

/**
 * The visible relevant macro names a file spells as whole identifiers: one
 * alternation scan instead of collecting every identifier of the file into a
 * set (fix #365; same identifier boundaries as wordsOf).
 */
function namesSpelled(state, filePath, content, names) {
    const cached = state.words.get(filePath);
    if (cached) return new Set(names.filter(name => cached.has(name)));
    if (names.length === 0) return new Set();
    // A word is the part of a maximal [A-Za-z0-9_] run from its first
    // non-digit on (`12ab` spells `ab`), exactly as wordsOf tokenizes.
    const isWord = code => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || code === 95;
    const isDigit = code => code >= 48 && code <= 57;
    const found = new Set();
    for (const name of names) {
        for (let at = content.indexOf(name); at >= 0; at = content.indexOf(name, at + 1)) {
            const after = at + name.length;
            if (after < content.length && isWord(content.charCodeAt(after))) continue;
            let before = at - 1;
            while (before >= 0 && isDigit(content.charCodeAt(before))) before--;
            if (before >= 0 && isWord(content.charCodeAt(before))) continue;
            found.add(name);
            break;
        }
    }
    return new Set(names.filter(name => found.has(name)));
}

function relevantNamesVisibleFrom(index, state, filePath) {
    const memo = state.visibleMemo.get(filePath);
    if (memo) return memo;
    const result = relevantNamesVisibleFromUncached(index, state, filePath);
    state.visibleMemo.set(filePath, result);
    return result;
}

function relevantNamesVisibleFromUncached(index, state, filePath) {
    if (!state.relevantFiles) {
        state.relevantFiles = new Map();
        for (const name of state.relevant) {
            for (const def of state.templates.get(name) || []) {
                if (!state.relevantFiles.has(def.file)) state.relevantFiles.set(def.file, new Set());
                state.relevantFiles.get(def.file).add(name);
            }
        }
    }
    if (state.relevantFiles.size === 0) return [];
    const names = new Set(state.relevantFiles.get(filePath) || []);
    const { _textualIncludeClosures } = require('./callers');
    for (const file of _textualIncludeClosures(index, filePath).all) {
        for (const name of state.relevantFiles.get(file) || []) names.add(name);
    }
    return [...names].sort(codeUnitCompare);
}

/** Preprocessing tokens of a file outside directive lines. */
function codeTokens(content, lines) {
    const directive = new Uint8Array(lines.length + 1);
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        let k = 0;
        while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
        if (line[k] !== '#') continue;
        directive[row] = 1;
        while (row + 1 < lines.length && /\\\s*$/.test(lines[row])) directive[++row] = 1;
    }
    const starts = [0];
    for (let row = 0; row < lines.length; row++) starts.push(starts[row] + lines[row].length + 1);
    const tokens = [];
    let row = 0;
    for (const token of lexPP(content)) {
        while (row + 1 < starts.length && starts[row + 1] <= token.start) row++;
        if (!directive[row]) tokens.push(token);
    }
    return tokens;
}

function enclosingFunctionAt(fileEntry, line) {
    let best = null;
    for (const symbol of fileEntry?.symbols || []) {
        if (symbol.type === 'macro' || symbol.startLine > line || symbol.endLine < line) continue;
        if (!['function', 'method', 'constructor', 'destructor', 'static'].includes(symbol.type) &&
            !symbol.isMethod) continue;
        if (!best || symbol.startLine >= best.startLine) best = symbol;
    }
    return best ? {
        name: best.name, startLine: best.startLine, endLine: best.endLine,
        ...(best.className && { className: best.className }),
    } : null;
}

/**
 * Expand one invocation (tokens of `NAME ( args )`) in the given site
 * context. Returns { calls, refs, defs } or throws BlindExpansion.
 */
function expandInvocation(index, state, site, tokens, parser, preferred, trailing = []) {
    const scope = definitionsInScope(index, state, site, tokens[0].v);
    const functionDefs = scope.defs.filter(def => def.functionLike);
    if (functionDefs.length === 0) return null;
    const split = splitArguments(tokens, 1);
    if (!split) throw new BlindExpansion('unbalanced-arguments');
    // Alternatives whose parameter list cannot take these arguments are not
    // the definition in effect; no fitting alternative is a blind site.
    const fitting = functionDefs.filter(def => arityFits(def, split.args));
    if (fitting.length === 0) throw new BlindExpansion('argument-count');
    const variants = [];
    for (const def of fitting) {
        site.budget = MAX_TOKENS;
        site.usedDefs.add(defKey(def));
        const expanded = substitute(index, state, site, def, split.args, new Set(), 0);
        // Parsing is the expensive step. Only an expansion that produced a
        // project name by pasting, or moved an argument identifier into
        // call position, can yield an edge the source does not spell.
        // The preprocessor rescans the expansion together with the source
        // that follows it: `CAT(uv_, run)()` calls uv_run with the `()`
        // written after the invocation.
        const stream = trailing.length > 0 ? expanded.concat(trailing) : expanded;
        variants.push({ def, ...(producesProjectName(index, stream)
            ? classifyExpansionMemo(state, parser, stream, preferred) : { calls: [], refs: [] }) });
    }
    // Top-level alternatives are all expanded; a name every alternative
    // produces is unambiguous. Unexpanded alternatives (object-like, over
    // the variant cap) or ambiguous nested macros leave every name open.
    const ambiguous = scope.truncated || functionDefs.length !== scope.defs.length || site.ambiguous;
    return { variants, ambiguous };
}

function fileExpansion(index, filePath, rawCalls) {
    const state = expansionState(index);
    let fileState = state.byFile.get(filePath);
    if (fileState && fileState.raw === rawCalls) return fileState;
    fileState = {
        raw: rawCalls, calls: rawCalls, refs: [], blind: [], usedDefs: new Set(), sites: 0,
        records: [], targets: [],
    };
    state.byFile.set(filePath, fileState);
    state.summary = null;
    if (state.relevant.size === 0 || !Array.isArray(rawCalls)) return fileState;
    const fileEntry = index.files.get(filePath);
    if (!langTraits(fileEntry?.language)?.textualIncludes) return fileState;
    const reused = persistedFileExpansion(index, state, fileEntry);
    if (reused) {
        Object.assign(fileState, reused, {
            calls: reused.records.length > 0 ? rawCalls.concat(reused.records) : rawCalls,
        });
        state.persistOut.set(fileEntry.relativePath, persistRecord(fileEntry, fileState));
        return fileState;
    }
    computeFileExpansion(index, state, filePath, rawCalls, fileState, fileEntry);
    state.persistOut.set(fileEntry.relativePath, persistRecord(fileEntry, fileState));
    index.macroExpansionDirty = true;
    return fileState;
}

/** Persisted shape of one file's expansion (index cache, fix #362). */
function persistRecord(fileEntry, fileState) {
    return {
        hash: fileEntry.hash,
        targets: fileState.targets,
        records: fileState.records,
        refs: fileState.refs,
        blind: fileState.blind,
        usedDefs: [...fileState.usedDefs].sort(codeUnitCompare),
        sites: fileState.sites,
    };
}

/** Version token of an include target: indexed content hash, else size+mtime. */
function targetVersion(index, target) {
    const entry = index.files.get(target);
    if (entry) return `h:${entry.hash}`;
    try {
        const stat = fs.statSync(target);
        return `s:${stat.size}:${stat.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

/**
 * A persisted expansion is reused only when every input is unchanged: the
 * file's content hash, each include target it read, and the project-wide
 * signature of macro definitions and the include graph.
 */
function persistedFileExpansion(index, state, fileEntry) {
    const persisted = index._macroExpansionPersisted;
    if (!persisted || persisted.signature !== expansionSignature(index, state)) return null;
    const entry = persisted.byFile?.[fileEntry.relativePath];
    if (!entry || entry.hash !== fileEntry.hash) return null;
    for (const [rel, version] of entry.targets || []) {
        if (targetVersion(index, path.join(index.root, rel)) !== version) return null;
    }
    return {
        records: entry.records || [],
        refs: entry.refs || [],
        blind: entry.blind || [],
        usedDefs: new Set(entry.usedDefs || []),
        sites: entry.sites || 0,
        targets: entry.targets || [],
    };
}

/** Hash of every C/C++ macro definition and the C/C++ include graph. */
function expansionSignature(index, state) {
    if (state.signature) return state.signature;
    const hash = crypto.createHash('md5');
    for (const name of [...state.macroDefs.keys()].sort(codeUnitCompare)) {
        for (const def of state.macroDefs.get(name)) {
            hash.update(`${name}\0${def.relativePath}\0${def.startLine}\0${def.endLine}\0` +
                `${def.functionLike ? 1 : 0}\0${(def.ppParams || []).join(',')}\0` +
                `${def.ppVariadic ? 1 : 0}\0${def.ppBody ?? ''}\n`);
        }
    }
    const files = [...index.files.values()]
        .filter(entry => langTraits(entry.language)?.textualIncludes)
        .map(entry => entry.path).sort(codeUnitCompare);
    for (const file of files) {
        const edges = [...(index.importGraph?.get(file) || [])].sort(codeUnitCompare)
            .map(target => path.relative(index.root, target));
        hash.update(`${path.relative(index.root, file)}>${edges.join(',')}\n`);
    }
    state.signature = hash.digest('hex');
    return state.signature;
}

/** Index-cache payload: every file expansion known this session. */
function persistableMacroExpansion(index) {
    const state = index._macroExpansion;
    const persisted = index._macroExpansionPersisted;
    if (!state) return persisted || null;
    const byFile = {};
    // Carry forward persisted entries this session did not touch; their
    // own validity checks run when they are next used.
    if (persisted && persisted.signature === expansionSignature(index, state)) {
        for (const [rel, entry] of Object.entries(persisted.byFile || {})) byFile[rel] = entry;
    }
    for (const [rel, entry] of state.persistOut) byFile[rel] = entry;
    return { signature: expansionSignature(index, state), byFile };
}

function computeFileExpansion(index, state, filePath, rawCalls, fileState, fileEntry) {
    // Invocation recognition is the preprocessor's own: a macro name token
    // followed by `(` outside directive lines. Call records are not enough:
    // statement-position invocations (`switch (e) { LIST(X) default: ... }`)
    // are recovered as declarations or blanked by macro recovery.
    const visibleRelevant = relevantNamesVisibleFrom(index, state, filePath);
    // Quoted includes whose text may invoke a macro this file can see but
    // the included file cannot (`#define X ...` + `#include "list.def"`, or
    // a list header included after the header defining its macro).
    const includeSites = visibleRelevant.length === 0 ? [] : (fileEntry.importDetails || [])
        .filter(detail => detail.type === 'include' && Number.isInteger(detail.line));
    if (visibleRelevant.length === 0 && includeSites.length === 0) return fileState;

    let content;
    try {
        content = index._readFile(filePath);
    } catch {
        return fileState;
    }
    // Own words are needed once; only include targets are revisited.
    const namesHere = namesSpelled(state, filePath, content, visibleRelevant);
    if (namesHere.size === 0 && includeSites.length === 0) return fileState;
    const lines = content.split('\n');
    const starts = lineStarts(content);
    const parser = getParser(fileEntry.language);
    const records = [];
    // An argument-substituted call the parser already recorded at its own
    // spelling (`X(CLOSE, uv__fs_close(fd))`) is not a second call.
    let seenKeys = null; // built on first use: most files emit nothing (fix #365)
    const seen = {
        has: key => (seenKeys ||= new Set(rawCalls.map(call =>
            `${call.name}\0${call.line}\0${call.column}`))).has(key),
        add: key => (seenKeys ||= new Set(rawCalls.map(call =>
            `${call.name}\0${call.line}\0${call.column}`))).add(key),
    };
    const makeSite = line => ({
        file: filePath, line, lines, fileState, lookupMemo: new Map(),
        usedDefs: fileState.usedDefs, budget: MAX_TOKENS, ambiguous: false,
    });
    const emit = (result, invocationName, anchor, enclosingFunction) => {
        const byName = new Map();
        for (const variant of result.variants) {
            for (const call of variant.calls) {
                const token = call.token;
                const position = token.o === 'arg' && Number.isInteger(token.pos)
                    ? positionOf(starts, token.pos) : anchor;
                const key = `${token.v}\0${position.line}\0${position.column}`;
                if (!byName.has(key)) {
                    byName.set(key, { call, token, position, defs: new Set(), count: 0 });
                }
                const entry = byName.get(key);
                if (!entry.defs.has(variant.def)) entry.count++;
                entry.defs.add(variant.def);
            }
            for (const ref of variant.refs) fileState.refs.push(ref.token.v);
        }
        for (const [key, entry] of byName) {
            if (seen.has(key)) continue;
            // A macro name the expansion could not expand further is an
            // unresolved invocation, not a call of a function.
            if (!entry.token.noexpand && state.macroDefs.has(entry.token.v) &&
                (index.symbols.get(entry.token.v) || []).every(def => def.type === 'macro')) continue;
            seen.add(key);
            const def = [...entry.defs][0];
            const ambiguous = result.ambiguous || entry.count !== result.variants.length;
            records.push({
                name: entry.token.v,
                line: entry.position.line,
                column: entry.position.column,
                isMethod: false,
                argCount: entry.call.argCount,
                ...(enclosingFunction && { enclosingFunction }),
                macroExpansion: {
                    macro: invocationName,
                    definition: defKey(def),
                    origin: entry.token.o === 'arg' ? 'argument' : 'paste',
                    ...(ambiguous && { ambiguous: true }),
                },
            });
        }
    };
    if (namesHere.size > 0) {
        const tokens = codeTokens(content, lines);
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.k !== 'id' || !namesHere.has(t.v) || tokens[i + 1]?.v !== '(') continue;
            // A macro invoked inside another invocation's arguments is
            // expanded with that invocation (argument pre-expansion).
            const split = splitArguments(tokens, i + 1);
            const anchor = positionOf(starts, t.start);
            if (!split) {
                fileState.blind.push({ line: anchor.line, macro: t.v, reason: 'unbalanced-arguments' });
                continue;
            }
            const invocation = [];
            for (let j = i; j <= split.close; j++) {
                const token = tokens[j];
                invocation.push({
                    v: token.v, k: token.k, o: j === i ? 'site' : 'arg', pos: token.start,
                    // Already spelled as a call where it is written: the
                    // parser recorded that call at this position.
                    ...(token.k === 'id' && tokens[j + 1]?.v === '(' && { srcCall: true }),
                });
            }
            const site = makeSite(anchor.line);
            const enclosingFunction = enclosingFunctionAt(fileEntry, anchor.line);
            try {
                const after = splitArguments(tokens, split.close + 1);
                const trailing = after
                    ? tokens.slice(split.close + 1, after.close + 1).map(token =>
                        ({ v: token.v, k: token.k, o: 'trail' }))
                    : [];
                const result = expandInvocation(index, state, site, invocation, parser,
                    enclosingFunction ? ['statement', 'initializer', 'file']
                        : ['file', 'initializer', 'statement'], trailing);
                if (!result) continue;
                fileState.sites++;
                emit(result, t.v, anchor, enclosingFunction);
                i = split.close;
            } catch (error) {
                if (!(error instanceof BlindExpansion)) throw error;
                fileState.blind.push({ line: anchor.line, macro: t.v, reason: error.reason });
                i = split.close;
            }
        }
    }

    // Includer-defined macros: `#define X(n) {#n, handle_##n},` then
    // `#include "list.def"` expands the included file's `X(...)` lines with
    // the includer's definition (the X-macro table pattern).
    for (const detail of includeSites) {
        const resolvedRel = fileEntry.moduleResolved?.[detail.module];
        const target = resolvedRel ? path.join(index.root, resolvedRel)
            : path.resolve(path.dirname(filePath), detail.module);
        if (!target.startsWith(index.root + path.sep) || target === filePath) continue;
        let text;
        try {
            text = index.files.has(target) ? index._readFile(target) : fs.readFileSync(target, 'utf-8');
        } catch {
            continue;
        }
        fileState.targets.push([path.relative(index.root, target), targetVersion(index, target)]);
        const targetWords = wordsOf(state, target, text);
        const candidates = visibleRelevant.filter(name => targetWords.has(name));
        if (candidates.length === 0) continue;
        const ownNames = new Set(relevantNamesVisibleFrom(index, state, target));
        const names = new Set(candidates.filter(name => !ownNames.has(name)));
        if (names.size === 0) continue;
        let tokens = state.includeTokens.get(target);
        if (!tokens) {
            tokens = codeTokens(text, text.split('\n'));
            state.includeTokens.set(target, tokens);
        }
        const enclosingFunction = enclosingFunctionAt(fileEntry, detail.line);
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.k !== 'id' || !names.has(t.v) || tokens[i + 1]?.v !== '(') continue;
            const split = splitArguments(tokens, i + 1);
            const site = makeSite(detail.line);
            if (!split) {
                fileState.blind.push({ line: detail.line, macro: t.v, reason: 'unbalanced-arguments' });
                continue;
            }
            // Tokens of an unindexed included file (`list.def`) are seen by no
            // other scan, so identifiers it passes in value position count
            // as produced references too.
            const foreign = !index.files.has(target);
            const invocation = [];
            for (let j = i; j <= split.close; j++) {
                const token = tokens[j];
                invocation.push(j === i ? { ...token, o: 'site' } : {
                    ...token, o: 'arg',
                    ...(foreign && { foreign: true }),
                    ...(!foreign && token.k === 'id' && tokens[j + 1]?.v === '(' && { srcCall: true }),
                });
            }
            try {
                const result = expandInvocation(index, state, site, invocation, parser,
                    enclosingFunction ? ['statement', 'initializer', 'file']
                        : ['initializer', 'file', 'statement']);
                if (result) {
                    fileState.sites++;
                    emit(result, t.v, { line: detail.line, column: 0 }, enclosingFunction);
                }
            } catch (error) {
                if (!(error instanceof BlindExpansion)) throw error;
                fileState.blind.push({ line: detail.line, macro: t.v, reason: error.reason });
            }
            i = split.close;
        }
    }
    if (records.length > 0) {
        records.sort((a, b) => a.line - b.line || a.column - b.column ||
            codeUnitCompare(a.name, b.name));
        fileState.records = records;
        fileState.calls = rawCalls.concat(records);
    }
    fileState.refs = [...new Set(fileState.refs)].sort(codeUnitCompare);
    return fileState;
}

/**
 * Paste chains of a function-like macro: each `a ## b ## c` run that
 * involves a parameter, as operands `{ param }` / `{ literal }`.
 */
function pasteChains(params, body) {
    const tokens = lexPP(body);
    const paramSet = new Set(params);
    const chains = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i + 1]?.v !== '##') continue;
        const operands = [tokens[i]];
        let j = i + 1;
        while (tokens[j]?.v === '##' && tokens[j + 1]) {
            operands.push(tokens[j + 1]);
            j += 2;
        }
        i = j - 1;
        if (operands.some(op => op.k !== 'id' && op.k !== 'num')) continue;
        if (!operands.some(op => op.k === 'id' && paramSet.has(op.v))) continue;
        chains.push(operands.map(op => (op.k === 'id' && paramSet.has(op.v)
            ? { param: op.v } : { literal: op.v })));
    }
    return chains;
}

/**
 * Arguments of the invocation whose `(` is at `open`, read from the raw
 * text: [argText] with whitespace removed, or null when the text holds a
 * literal or a comment there (the caller then lexes the file) or the list
 * does not close within a bound.
 */
function rawInvocationArguments(content, open) {
    const args = [];
    let depth = 0;
    let current = '';
    for (let k = open + 1; k < content.length && k - open < 4096; k++) {
        const ch = content[k];
        if (ch === '"' || ch === "'" || (ch === '/' && (content[k + 1] === '/' || content[k + 1] === '*'))) return null;
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) {
                if (ch !== ')') return null;
                args.push(current);
                return args;
            }
            depth--;
        } else if (ch === ',' && depth === 0) {
            args.push(current);
            current = '';
            continue;
        }
        if (!/\s/.test(ch)) current += ch;
    }
    return null;
}

/** May an invocation in `content` of a macro in `byName` paste `name`? */
function mayPasteName(content, byName, name) {
    for (const [macroName, macros] of byName) {
        for (let at = content.indexOf(macroName); at >= 0; at = content.indexOf(macroName, at + 1)) {
            if (at > 0 && /[A-Za-z0-9_]/.test(content[at - 1])) continue;
            let k = at + macroName.length;
            if (/[A-Za-z0-9_]/.test(content[k] || '')) continue;
            while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
            if (content[k] !== '(') continue;
            const args = rawInvocationArguments(content, k);
            if (!args) return true;
            for (const macro of macros) {
                const params = macro.symbol.ppParams;
                const argText = param => {
                    const index = params.indexOf(param);
                    return index >= 0 && args[index] ? args[index] : '';
                };
                if (macro.chains.some(chain => chain.map(op => op.literal ?? argText(op.param)).join('') === name)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * fix #396: where token pasting can spell `name` without writing it. Returns
 * { macros: [{ symbol, spelling }], sites: [{ file, line, macro }] }: the
 * project function-like macros whose replacement list pastes a parameter
 * into a token that can be `name` (`struct sdshdr##T`), and their
 * invocations (outside directive lines) whose arguments make it exactly
 * `name` (`SDS_HDR_VAR(8, s)`). Arguments next to `##` are pasted as
 * written (C11 6.10.3.3), so no expansion is needed. Memoized per operation.
 */
function pastedNameSites(index, name) {
    const memo = index._opMemo?.('pastedNameSites', () => new Map());
    if (memo?.has(name)) return memo.get(name);
    const { matchesPastePattern } = require('../languages/c-preprocessor');
    const macros = [];
    for (const defs of index.symbols.values()) {
        for (const symbol of defs) {
            if (symbol.type !== 'macro' || !Array.isArray(symbol.ppParams) ||
                typeof symbol.ppBody !== 'string' || !symbol.ppBody.includes('##')) continue;
            const chains = pasteChains(symbol.ppParams, symbol.ppBody).filter(chain =>
                matchesPastePattern(chain.map(op => op.literal ?? null), name));
            if (chains.length === 0) continue;
            macros.push({
                symbol, chains,
                spelling: chains[0].map(op => op.literal ?? op.param).join(' ## '),
            });
        }
    }
    macros.sort((a, b) => codeUnitCompare(a.symbol.file, b.symbol.file) ||
        a.symbol.startLine - b.symbol.startLine);
    const sites = [];
    const byName = new Map();
    for (const macro of macros) {
        if (!byName.has(macro.symbol.name)) byName.set(macro.symbol.name, []);
        byName.get(macro.symbol.name).push(macro);
    }
    if (byName.size > 0) {
        const files = [...index.files.keys()].sort(codeUnitCompare);
        for (const file of files) {
            const entry = index.files.get(file);
            if (!langTraits(entry?.language)?.textualIncludes) continue;
            let content;
            try {
                content = index._readFile(file);
            } catch {
                continue;
            }
            if (![...byName.keys()].some(macroName => content.includes(macroName))) continue;
            // Lex the file only when an invocation there may paste `name`:
            // most files invoke a generic pasting macro with other arguments.
            if (!mayPasteName(content, byName, name)) continue;
            const lines = content.split('\n');
            const starts = lineStarts(content);
            const tokens = codeTokens(content, lines);
            for (let i = 0; i < tokens.length; i++) {
                const candidates = byName.get(tokens[i].v);
                if (!candidates || tokens[i + 1]?.v !== '(') continue;
                const split = splitArguments(tokens, i + 1);
                if (!split) continue;
                const line = positionOf(starts, tokens[i].start).line;
                for (const macro of candidates) {
                    const params = macro.symbol.ppParams;
                    const argText = param => {
                        const at = params.indexOf(param);
                        return at >= 0 && split.args[at] ? split.args[at].map(token => token.v).join('') : '';
                    };
                    if (macro.chains.some(chain => chain.map(op => op.literal ?? argText(op.param)).join('') === name)) {
                        sites.push({ file, line, macro: macro.symbol.name });
                        break;
                    }
                }
                i = split.close;
            }
        }
    }
    const result = { macros, sites };
    memo?.set(name, result);
    return result;
}

/** Calls of a file including the call records its macro invocations expand to. */
function withMacroExpansion(index, filePath, rawCalls, options = {}) {
    if (!Array.isArray(rawCalls) || !index?.symbols) return rawCalls;
    // Rust macro_rules! expansions (fix #374) derive their calls on first use.
    if (index.files.get(filePath)?.rustMacroExpansion?.callsPending) {
        return require('./rust-macro-expansion').rustExpandedCalls(index, filePath, rawCalls, options);
    }
    if (!langTraits(index.files.get(filePath)?.language)?.textualIncludes) return rawCalls;
    return fileExpansion(index, filePath, rawCalls).calls;
}

/**
 * Project-wide inventory for deadcode and health: expanded invocation sites,
 * names produced in value position, blind invocations, and the paste
 * patterns whose produced names cannot be enumerated (a pasting macro with
 * a blind invocation or with no expandable invocation at all).
 */
function macroExpansionSummary(index) {
    const state = expansionState(index);
    if (state.summary) return state.summary;
    const summary = {
        sites: 0, calls: 0, refNames: new Set(),
        blind: { count: 0, fileCount: 0, files: [], sample: [] },
        patterns: [],
    };
    if (state.relevant.size === 0) {
        state.summary = summary;
        return summary;
    }
    const { getCachedCalls } = require('./callers');
    const usedDefs = new Set();
    const blindDefs = new Set();
    const files = [...index.files.keys()].sort(codeUnitCompare);
    for (const filePath of files) {
        const fileEntry = index.files.get(filePath);
        if (!langTraits(fileEntry?.language)?.textualIncludes) continue;
        getCachedCalls(index, filePath);
        const fileState = state.byFile.get(filePath);
        if (!fileState) continue;
        summary.sites += fileState.sites;
        summary.calls += fileState.calls.length - fileState.raw.length;
        for (const name of fileState.refs) summary.refNames.add(name);
        for (const key of fileState.usedDefs) usedDefs.add(key);
        if (fileState.blind.length > 0) {
            summary.blind.count += fileState.blind.length;
            summary.blind.fileCount++;
            if (summary.blind.files.length < 10) summary.blind.files.push(fileEntry.relativePath);
            for (const site of fileState.blind) {
                blindDefs.add(site.macro);
                if (summary.blind.sample.length < 10) {
                    summary.blind.sample.push({ file: fileEntry.relativePath, ...site });
                }
            }
        }
    }
    for (const [name, defs] of state.templates) {
        for (const def of defs) {
            // A pattern no project name matches withholds nothing.
            const patterns = pastePatterns({ params: def.ppParams || [], body: def.ppBody })
                .filter(pattern => patternSpellsProjectName(index, pattern));
            if (patterns.length === 0) continue;
            const unexpanded = !usedDefs.has(defKey(def));
            if (!unexpanded && !blindDefs.has(name)) continue;
            for (const pattern of patterns) {
                summary.patterns.push({
                    pattern, macro: name, file: def.relativePath, line: def.startLine,
                    reason: unexpanded ? 'no-expanded-invocation' : 'blind-invocation',
                });
            }
        }
    }
    state.summary = summary;
    return summary;
}

module.exports = { withMacroExpansion, macroExpansionSummary, expansionState, persistableMacroExpansion,
    macroDefinitionsAt, macroBodyTokens, codeTokens, pastedNameSites };
