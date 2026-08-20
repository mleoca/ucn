'use strict';

/**
 * Shared AST extraction for C and C++.
 *
 * This module deliberately works from tree-sitter node kinds and fields. Text
 * is read only from nodes already identified by the grammar; there is no regex
 * source fallback.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    extractJSDocstring,
    visitNameNodes,
    sameNode,
    extractStringArg,
} = require('./utils');
const { createHash } = require('crypto');
const { isMainThread } = require('worker_threads');
const { PARSE_OPTIONS, safeParse } = require('./index');

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

function macroInvocationRange(code, identifier) {
    if (!identifier || !isMacroToken(identifier.text)) return null;
    let cursor = identifier.endIndex;
    while (cursor < code.length &&
        (code[cursor] === ' ' || code[cursor] === '\t')) {
        cursor++;
    }
    if (code[cursor] !== '(') return null;
    let depth = 0;
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
        if (character === '(') depth++;
        else if (character === ')' && --depth === 0) {
            return [identifier.startIndex, index + 1];
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

function errorMacroRanges(node, code) {
    const ranges = [];
    if (node.type === 'ERROR') {
        const named = node.namedChildren || [];
        for (const child of named) {
            if (['class_specifier', 'struct_specifier',
                'union_specifier'].includes(child.type)) {
                const name = child.childForFieldName('name');
                const invocation = macroInvocationRange(code, name);
                if (invocation) ranges.push(invocation);
                continue;
            }
            if (!IDENTIFIER_NODES.has(child.type)) continue;
            const invocation = macroInvocationRange(code, child);
            if (invocation) ranges.push(invocation);
            else if (isStandaloneMacroLine(code, child)) {
                ranges.push([child.startIndex, child.endIndex]);
            } else if (child === named[0] &&
                child.startPosition.row === node.startPosition.row &&
                isMacroToken(child.text)) {
                // Prefix before a declaration fragment inside one ERROR:
                // `FMT_EXPORT template <...> class X`.
                ranges.push([child.startIndex, child.endIndex]);
            }
        }
    }
    if (node.type === 'function_definition' && node.hasError) {
        const type = node.childForFieldName('type');
        const declarator = node.childForFieldName('declarator');
        if (type && isStandaloneMacroLine(code, type) &&
            declarator &&
            declarator.startPosition.row > type.startPosition.row) {
            // A standalone namespace/opening macro followed by a declaration
            // can be swallowed as the return type of one enormous malformed
            // function. It cannot be a real multi-line C++ return type.
            ranges.push([type.startIndex, type.endIndex]);
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
            ranges.push([macro.startIndex, macro.endIndex]);
        }
    }
    return ranges;
}

function macroTypeRanges(tree, code) {
    const ranges = [];
    const treeHasError = tree.rootNode.hasError;
    traverseTree(tree.rootNode, node => {
        ranges.push(...errorMacroRanges(node, code));
        const classAttribute = classAttributeShape(node);
        if (!node.hasError && !classAttribute) {
            // In an errored tree a clean subtree cannot hide a recovery
            // candidate. A wholly clean tree still needs one traversal for
            // grammar-valid `class API Name` misparses.
            return treeHasError ? false : true;
        }
        if (!DECLARATION_NODES.has(node.type)) return true;
        const typeNode = node.childForFieldName('type');
        const declaratorNode = node.childForFieldName('declarator');
        const directErrorNode = (node.namedChildren || [])
            .find(child => child.type === 'ERROR');
        if (node.type === 'function_definition' && typeNode &&
            directErrorNode?.namedChildCount === 1 &&
            directErrorNode.namedChild(0)?.type === 'identifier' &&
            !RESERVED_TYPE_KEYWORDS.has(
                directErrorNode.namedChild(0).text) &&
            functionDeclarator(node)) {
            ranges.push([
                directErrorNode.namedChild(0).startIndex,
                directErrorNode.namedChild(0).endIndex,
            ]);
            return true;
        }
        // `class API Widget { ... }` is parsed as a malformed function:
        // type=`class API`, declarator=`Widget`, body=`{...}`. The bodyless
        // class-specifier plus a bare declarator cannot be a valid function
        // declaration, so the specifier's name is proven to be a class
        // attribute/visibility macro. Blank only that token; the reparse
        // recovers the real class and all member ownership.
        if (classAttribute) {
            ranges.push([classAttribute.startIndex, classAttribute.endIndex]);
            return true;
        }
        // Calling-convention/export macro between a builtin return type and
        // function name (`int CJSON_CDECL main(void)`) splits into a missing-;
        // declaration plus a malformed function_definition on the SAME line.
        // The declarator identifier is the macro token in that AST shape.
        const next = node.nextNamedSibling;
        if (typeNode && declaratorNode?.type === 'identifier' &&
            hasMissingChild(node) &&
            next?.type === 'function_definition' &&
            next.startPosition.row === node.startPosition.row) {
            ranges.push([declaratorNode.startIndex, declaratorNode.endIndex]);
            return true;
        }
        if (!typeNode || typeNode.type !== 'type_identifier') return true;
        const directError = !!directErrorNode;
        const identity = declaratorIdentity(functionDeclarator(node));
        // `MACRO Type::Type(...) : Base{...} { ... }` is parsed as a
        // declaration whose initializer consumes the base brace and whose
        // real body becomes a sibling compound_statement. A qualified
        // constructor cannot have a return type, so an all-caps type token is
        // compiler-proven decoration and may be blanked safely.
        const qualifiedConstructorMacro = node.type === 'declaration' &&
            node.hasError && isMacroToken(typeNode.text) &&
            identity?.className &&
            (identity.name === identity.className ||
             identity.name === `~${identity.className}`);
        // Stacked attribute macros (`A B extern void (*fp)(void *);`) split
        // into a fragment declaration [type_identifier, identifier,
        // MISSING ';'] plus a clean tail — no ERROR node, so the evidence is
        // the missing semicolon on a bare two-identifier fragment. Blanking
        // the type re-joins the pair (the next round handles the inner
        // macro) and removes the phantom state var the fragment indexed.
        const bareFragment = declaratorNode && declaratorNode.type === 'identifier' &&
            node.namedChildCount === 2 && hasMissingChild(node);
        if (directError || bareFragment || qualifiedConstructorMacro ||
            RESERVED_TYPE_KEYWORDS.has(identity?.name)) {
            ranges.push([typeNode.startIndex, typeNode.endIndex]);
        }
        return true;
    });
    return [...new Map(ranges.map(range => [
        `${range[0]}:${range[1]}`, range,
    ])).values()];
}

function countParseErrors(node) {
    let count = node.type === 'ERROR' ? 1 : 0;
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.isMissing) count++;
        else if (child.hasError || child.type === 'ERROR') count += countParseErrors(child);
    }
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

function macroDefinitionNodes(tree) {
    const cached = macroDefinitionsByTree.get(tree);
    if (cached) return cached;
    const definitions = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type === 'preproc_function_def' || node.type === 'preproc_def') {
            definitions.push(node);
            return false;
        }
        return true;
    });
    macroDefinitionsByTree.set(tree, definitions);
    return definitions;
}

function treeCacheKey(code) {
    return `${code.length}:${createHash('sha256').update(code).digest('base64url')}`;
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
    for (const directive of directives) {
        if (!directive || !['if', 'ifdef', 'ifndef', 'elif'].includes(directive.kind)) {
            continue;
        }
        const condition = directive.condition;
        if (!condition || condition === '0' || condition === '1') continue;
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

function treeStructureScore(tree) {
    let declarations = 0;
    let calls = 0;
    const declarationTypes = new Set([
        'function_definition', 'class_specifier', 'struct_specifier',
        'union_specifier', 'enum_specifier', 'type_definition',
    ]);
    const cursor = tree.walk();
    let entered = true;
    while (entered) {
        const type = cursor.nodeType;
        if (declarationTypes.has(type)) declarations++;
        else if (type === 'call_expression') calls++;
        if (cursor.gotoFirstChild()) continue;
        while (!cursor.gotoNextSibling()) {
            if (!cursor.gotoParent()) {
                entered = false;
                break;
            }
        }
    }
    cursor.delete?.();
    return declarations * 1000 + calls;
}

function parseTree(parser, code) {
    const cacheKey = treeCacheKey(code);
    const cached = cachedCFamilyTree(parser, cacheKey);
    if (cached) return cached;
    const tree = safeParse(parser, code, undefined, PARSE_OPTIONS);
    if (recoveryMemo.has(code) && !recoveryAppliedMemo.get(code)) {
        const blanked = recoveryMemo.get(code);
        const selected = blanked === null
            ? tree : safeParse(parser, blanked, undefined, PARSE_OPTIONS);
        if (selected !== tree) tree.delete?.();
        allSourceRecoveryByTree.set(selected, null);
        recoveryAppliedByTree.set(selected, selected.rootNode.hasError);
        cacheCFamilyTree(parser, cacheKey, selected, Buffer.byteLength(code));
        return selected;
    }
    const initialRanges = macroTypeRanges(tree, code);
    if (!tree.rootNode.hasError && initialRanges.length === 0) {
        recoveryMemo.set(code, null);
        recoveryAppliedMemo.set(code, false);
        allSourceRecoveryByTree.set(tree, null);
        recoveryAppliedByTree.set(tree, false);
        if (recoveryMemo.size > RECOVERY_MEMO_MAX) {
            const oldest = recoveryMemo.keys().next().value;
            recoveryMemo.delete(oldest);
            recoveryAppliedMemo.delete(oldest);
        }
        cacheCFamilyTree(parser, cacheKey, tree, Buffer.byteLength(code));
        return tree;
    }
    // Non-worsening rounds may continue (blanking a stacked macro can turn a
    // MISSING token into an ERROR before the next round clears it), but a
    // recovery is only ACCEPTED when it strictly improved on the original.
    let current = code;
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
    for (let attempt = 0; attempt < 8; attempt++) {
        const ranges = attempt === 0
            ? initialRanges : macroTypeRanges(workingTree, current);
        if (ranges.length === 0) break;
        let next = current;
        for (const [start, end] of ranges) {
            next = next.slice(0, start) + ' '.repeat(end - start) + next.slice(end);
        }
        const candidate = safeParse(parser, next, undefined, PARSE_OPTIONS);
        liveTrees.add(candidate);
        const errors = countParseErrors(candidate.rootNode);
        if (errors > bestErrors) {
            releaseTree(candidate);
            break;
        }
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
    const attributeSource = bestCode || code;
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
            let improves = errors < selectedErrors;
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
                if (previousBest && previousBest !== tree) {
                    releaseTree(previousBest);
                }
            } else {
                releaseTree(candidate);
            }
        }
    }
    recoveryMemo.set(code, best ? bestCode : null);
    // Deterministic attribute/visibility macro normalization is treated like
    // ordinary parser adaptation once it yields a clean tree. Conditional
    // configuration selection is inherently partial and must remain visible.
    recoveryAppliedMemo.set(code, conditionalApplied);
    if (recoveryMemo.size > RECOVERY_MEMO_MAX) {
        const oldest = recoveryMemo.keys().next().value;
        recoveryMemo.delete(oldest);
        recoveryAppliedMemo.delete(oldest);
    }
    const selected = best || tree;
    allSourceRecoveryByTree.set(
        selected,
        conditionalApplied && attributeSource !== code ? attributeSource :
            conditionalApplied ? code : null,
    );
    recoveryAppliedByTree.set(
        selected,
        conditionalApplied || selected.rootNode.hasError,
    );
    for (const parsed of liveTrees) {
        if (parsed !== selected) releaseTree(parsed);
    }
    cacheCFamilyTree(parser, cacheKey, selected, Buffer.byteLength(code));
    return selected;
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
        const nameNode = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const scopeNode = node.childForFieldName('scope') || node.namedChild(0);
        return {
            name: canonicalCallableName(nameNode?.text),
            className: scopeNode?.text?.split('::').pop(),
            nameNode,
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

function enclosingClassName(node) {
    const identity = enclosingClass(node);
    return identity?.ownerName || identity?.name || null;
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

function enclosingNamespace(node) {
    const parts = [];
    for (let parent = node?.parent; parent; parent = parent.parent) {
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

function classIdentity(node) {
    let nameNode = node.childForFieldName('name');
    if (!nameNode && node.parent?.type === 'type_definition') {
        nameNode = node.parent.childForFieldName('declarator');
    }
    if (!nameNode) return null;
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
    // virtual-dispatch facts without scraping declaration text.
    const stack = [...(node.namedChildren || [])];
    while (stack.length > 0) {
        const child = stack.pop();
        if (child.type === 'virtual_specifier') modifiers.add(child.text);
        else stack.push(...(child.namedChildren || []));
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
    const text = param.text.slice(0, end - base);
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
            name: identity.name || param.text.replace(/\s+/g, ' ').trim(),
        };
        if (typeNode && identity.name) {
            info.type = paramTypeText(param, identity) || typeNode.text;
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
            return type?.text || null;
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
    return stars > 0 ? `${typeNode.text} ${'*'.repeat(stars)}` : typeNode.text;
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
        params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
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
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        ...(enclosingNamespace(node) && {
            namespace: enclosingNamespace(node),
        }),
        className,
        ...(mode === 'cpp' && isTemplateDependentCallable(node) && {
            templateDependent: true,
        }),
        ...(mode === 'cpp' && isFullSpecializationCallable(node) && {
            isSpecialization: true,
        }),
        ...(mode === 'cpp' && cLanguageLinkage(node) && {
            linkage: cLanguageLinkage(node),
        }),
        ...(node.type !== 'function_definition' && { isSignature: true }),
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

function classMembers(node, lines, mode) {
    const identity = classIdentity(node);
    if (!identity) return [];
    const body = node.childForFieldName('body');
    if (!body) return [];
    let access = node.type === 'class_specifier' ? 'private' : 'public';
    const members = [];
    for (const child of body.namedChildren || []) {
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
            continue;
        }
        if (CLASS_NODES.has(child.type)) continue;
        const member = memberFromNode(
            child, identity.ownerName || identity.name, access, lines, mode);
        if (member) members.push(member);
        else members.push(...fieldMembers(child, access, lines));
    }
    return members;
}

function typedefEntries(node, lines) {
    // `typedef void (*cb)(int);` / `typedef int myint;` / `typedef struct A B;`
    // declare importable type names. Anonymous specifiers
    // (`typedef struct { … } Point;`) are named through classIdentity's
    // type_definition fallback, so only alias-style declarators are added here.
    const inner = node.childForFieldName('type');
    const innerIsClass = inner && CLASS_NODES.has(inner.type);
    const innerClassName = innerIsClass ? inner.childForFieldName('name')?.text : null;
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
            ...enclosingTypeScope(node),
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
                    child !== nameNode &&
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
                ...enclosingTypeScope(node),
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
            indent,
            modifiers: [...new Set(modifiers)],
            members: classMembers(node, lines, mode),
            ...(enclosingNamespace(node) && {
                namespace: enclosingNamespace(node),
            }),
            ...(bases.length > 0 && { extends: bases.join(', ') }),
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
        if (!FUNCTION_CONTAINERS.has(node.type)) return true;
        const declarator = functionDeclarator(node);
        if (!declarator) return true;
        const owner = enclosingClass(node);
        const identity = declaratorIdentity(declarator);
        if (!identity.name) return true;
        if (owner && !identity.className) return false;
        const key = `${node.startIndex}:${identity.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const paramsNode = parameterListOf(declarator);
        const location = nodeToLocation(node, lines);
        const startLine = location.startLine;
        const indent = location.indent;
        const isConstructor = mode === 'cpp' && !!identity.className &&
            (identity.name === identity.className || identity.name === `~${identity.className}`);
        const lexicalEnd = functionRangeEnd(
            code, node, paramsNode, isConstructor, mode);
        const endLine = lexicalEnd == null
            ? location.endLine
            : lineNumberAtIndex(lineStarts, Math.max(0, lexicalEnd - 1));
        const modifiers = modifiersOf(node);
        if (!modifiers.includes('static')) modifiers.push('export');
        const returnedConcreteType = mode === 'cpp' && variableTypes
            ? inferredAutoReturnType(node, variableTypes)
            : null;
        functions.push({
            name: identity.name,
            params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
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
            ...(enclosingNamespace(node) && {
                namespace: enclosingNamespace(node),
            }),
            ...(identity.className && {
                className: identity.className,
                receiver: identity.className,
                isMethod: true,
            }),
            ...(mode === 'cpp' && isTemplateDependentCallable(node) && {
                templateDependent: true,
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
            findFunctionsInTree(code, literal, mode),
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

function findMacrosInTree(tree, lines) {
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
            params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : undefined,
            paramsStructured: paramsNode
                ? (paramsNode.namedChildren || [])
                    .filter(child => child.type === 'identifier')
                    .map(child => ({ name: child.text }))
                : undefined,
            modifiers: [],
            functionLike: node.type === 'preproc_function_def',
            docstring: extractJSDocstring(lines, startLine),
        });
    }
    return macros;
}

function findMacros(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const primary = findMacrosInTree(tree, lines);
    const literal = literalRecoveryTree(parser, code, tree);
    return literal ? mergeExtracted(primary,
        findMacrosInTree(literal, lines),
        item => `${item.name}:${item.startLine}:${item.functionLike ? 1 : 0}`) : primary;
}

function enclosingFunctionOf(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_definition') {
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
    const addBindings = (node, type, pointeeType, scope, declarators) => {
        for (const declarator of declarators) {
            const identity = declaratorIdentity(declarator);
            if (!identity.name) continue;
            bindings.push({
                name: identity.name,
                type,
                ...(pointeeType && { pointeeType }),
                declaredAt: node.type === 'parameter_declaration'
                    ? scope.startIndex : declarator.startIndex,
                scopeStart: scope.startIndex,
                scopeEnd: scope.endIndex,
            });
        }
    };
    traverseTree(tree.rootNode, node => {
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
        if (!type || type === 'auto') return true;
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
        addBindings(node, type, pointeeType, scope, declarators);
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
    const resolveBinding = (name, atNode) => {
        if (!name || !atNode) return undefined;
        const at = atNode.startIndex;
        const candidates = bindings.filter(binding =>
            binding.name === name &&
            binding.scopeStart <= at && at < binding.scopeEnd &&
            binding.declaredAt <= at);
        candidates.sort((a, b) => {
            const aSpan = a.scopeEnd - a.scopeStart;
            const bSpan = b.scopeEnd - b.scopeStart;
            return aSpan - bSpan || b.declaredAt - a.declaredAt;
        });
        return candidates[0];
    };
    return {
        get: (name, atNode) => resolveBinding(name, atNode)?.type,
        getPointee: (name, atNode) =>
            resolveBinding(name, atNode)?.pointeeType,
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
        const type = variableTypes?.get(node.text, node);
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
        const nameNode = fnNode.childForFieldName('field') ||
            fnNode.namedChildren[fnNode.namedChildCount - 1];
        const receiverNode = fnNode.childForFieldName('argument') || fnNode.namedChild(0);
        return {
            name: nameNode?.text,
            nameNode,
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
        return {
            name: nested?.name || rawNameNode?.text,
            nameNode: nested?.nameNode || rawNameNode,
            isMethod: true,
            receiver: nested?.receiver
                ? `${scopeNode?.text}::${nested.receiver}`
                : scopeNode?.text,
            isPathCall: true,
            ...(nested?.explicitTemplateCall && { explicitTemplateCall: true }),
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

function findCallsInTree(code, parser, _options = {}, existingTree = null,
    includeMacroBodies = true) {
    const tree = existingTree || parseTree(parser, code);
    const variableTypes = buildVariableTypes(tree);
    const fieldTypes = variableTypes.fieldTypes;
    const calls = [];
    traverseTree(tree.rootNode, node => {
        const recoveredOperator = recoveredExplicitCallOperator(
            node, variableTypes);
        if (recoveredOperator) {
            calls.push(recoveredOperator);
            return true;
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
            let receiverRootType = receiverRoot
                ? ((identity.pointerAccess && receiverFields.length === 0
                    ? variableTypes.getPointee(receiverRoot, node) : undefined) ||
                   variableTypes.get(receiverRoot, node))
                : undefined;
            // A bare field inside a member function is implicitly rooted at
            // `this`; keep that field path so declared-field resolution can
            // type it without mistaking it for an unrelated local.
            if (owner && receiverNode?.type === 'identifier' &&
                !receiverRootType &&
                (fieldTypes.has(`${owner}.${receiverNode.text}`) ||
                 !variableTypes.get(receiverNode.text, node))) {
                receiverRoot = 'this';
                receiverFields = [receiverNode.text];
                receiverRootType = owner;
            }
            if (receiverRoot === 'this' && !receiverRootType) {
                receiverRootType = owner || undefined;
            }
            const directReceiverType = receiverPath &&
                receiverFields.length === 0 && receiverRoot
                ? ((identity.pointerAccess
                    ? variableTypes.getPointee(receiverRoot, node) : undefined) ||
                   variableTypes.get(receiverRoot, node))
                : undefined;
            const assignedTo = assignmentTargetOf(node);
            const compileTimeOnly = compileTimeOnlyContext(node);
            calls.push({
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                column: identity.nameNode?.startPosition.column,
                callStart: node.startIndex,
                callEnd: node.endIndex,
                isMethod: identity.isMethod,
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(identity.isPathCall && { isPathCall: true }),
                ...(identity.globalQualified && { globalQualified: true }),
                ...(identity.explicitTemplateCall && {
                    explicitTemplateCall: true,
                }),
                ...(compileTimeOnly && { compileTimeOnly }),
                ...(directReceiverType && { receiverType: directReceiverType }),
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

function findCallsInCode(code, parser, options = {}, existingTree = null,
    includeMacroBodies = true, mode = 'cpp') {
    // Synthetic macro-body parses and other explicit trees are already exact
    // views supplied by the caller.  Only whole-file extraction participates
    // in preprocessor-configuration conservation.
    if (existingTree) {
        const calls = findCallsInTree(
            code, parser, options, existingTree, includeMacroBodies);
        const functions = findFunctionsInTree(code, existingTree, mode);
        return attributeCallsToLexicalFunctions(calls, functions);
    }
    const tree = parseTree(parser, code);
    const primary = findCallsInTree(
        code, parser, options, tree, includeMacroBodies);
    const literal = literalRecoveryTree(parser, code, tree);
    if (!literal) {
        return attributeCallsToLexicalFunctions(
            primary, findFunctionsInTree(code, tree, mode));
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
            findFunctionsInTree(code, literal, mode),
            item => `${item.name}:${item.startLine}:${item.className || ''}:${item.isSignature ? 1 : 0}`,
        );
        return attributeCallsToLexicalFunctions(calls, functions);
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
        const parameters = new Set((paramsNode?.namedChildren || [])
            .filter(child => child.type === 'identifier')
            .map(child => child.text));
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
        const nestedTree = safeParse(parser, synthetic, undefined, PARSE_OPTIONS);
        let nested;
        try {
            nested = findCallsInCode(synthetic, parser, {}, nestedTree, false);
        } finally {
            nestedTree.delete?.();
        }
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
                ...call,
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
    traverseTreeCached(tree.rootNode, node => {
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

function findUsagesInCode(code, name, parser, existingTree) {
    // Usage is the raw literal-name inventory. The literal C/C++ tree retains
    // identifiers from every preprocessor branch and is sufficient for
    // occurrence kind/line classification; symbol ownership still comes from
    // the recovered index. Reusing ProjectIndex's raw tree avoids replaying
    // expensive conditional recovery for every queried name.
    const tree = existingTree ||
        safeParse(parser, code, undefined, PARSE_OPTIONS);
    const usages = [];
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
            const call = parent.type === 'call_expression'
                ? parent
                : parent.parent?.type === 'call_expression' ? parent.parent : null;
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
        addUsage({
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            usageType,
            ...(receiver && { receiver }),
        });
    });
    collectTreeUsages(tree);
    // Replacement lists are opaque preproc_arg nodes in the C grammars. The
    // call extractor reparses those AST-proven regions; surface the resulting
    // call usages here as well so callers/callees, usages, and tests share one
    // semantic fact set.
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
    return usages;
}

function getEntryPointKind(symbol) {
    if (symbol.name === 'main' || symbol.name === 'WinMain' ||
        symbol.name === 'wWinMain' || symbol.name === 'DllMain') return 'main';
    if (/^(test_|Test|TEST_)/.test(symbol.name)) return 'test';
    return null;
}

function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

function parse(code, parser, mode, options = {}) {
    const tree = parseTree(parser, code);
    const literal = literalRecoveryTree(parser, code, tree);
    try {
        const lines = code.split('\n');
        const functions = literal
            ? mergeExtracted(
                findFunctionsInTree(code, tree, mode, lines),
                findFunctionsInTree(code, literal, mode, lines),
                item => `${item.name}:${item.startLine}:${item.className || ''}:${item.isSignature ? 1 : 0}`,
            )
            : findFunctionsInTree(code, tree, mode, lines);
        const classes = literal
            ? mergeExtracted(
                findClassesInTree(code, tree, mode, lines),
                findClassesInTree(code, literal, mode, lines),
                item => `${item.name}:${item.startLine}:${item.type}:${item.namespace || ''}`,
            )
            : findClassesInTree(code, tree, mode, lines);
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
        attributeCallsToLexicalFunctions(calls, functions);
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
                ? mergeExtracted(findMacrosInTree(tree, lines),
                    findMacrosInTree(literal, lines),
                    item => `${item.name}:${item.startLine}:${item.functionLike ? 1 : 0}`)
                : findMacrosInTree(tree, lines),
            imports,
            exports: [
                ...functions
                    .filter(fn => !fn.modifiers.includes('static'))
                    .map(fn => ({ name: fn.name, type: 'export', line: fn.startLine })),
                ...classes.map(cls => ({ name: cls.name, type: 'export', line: cls.startLine })),
            ],
            ...(parseRecoveryApplied(code, tree) && { parseRecovery: true }),
        };
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
        findUsagesInCode,
        isEntryPoint,
        getEntryPointKind,
        parse: (code, parser, options) => parse(code, parser, mode, options),
    };
}

module.exports = {
    createCFamilyLanguage,
    // Deterministic test seams for the recovery memory/order contracts.
    conditionalRecoverySources,
    mergeExtracted,
};
