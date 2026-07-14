/**
 * core/deadcode.js - Dead code detection (unused functions/classes)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageModule, safeParse, langTraits } = require('../languages');
const { dirname: pathDirname } = require('path');
const { isTestFile } = require('./discovery');
const { isFrameworkEntrypoint } = require('./entrypoints');
const { splitParentList } = require('./graph-build');
const { isOverrideMarked, codeUnitCompare, lineInRanges, maskBlockComments } = require('./shared');

const _CLASS_KINDS = ['class', 'struct', 'interface', 'trait', 'record'];

// Class-like kinds the audit claims directly (fix #253a — unused classes were
// never reported: the audit surface had no class kinds). 'impl' stays out (an
// impl block belongs to its struct — the struct claim covers it); 'type'
// aliases and macros stay out (deferred — each is its own claim family).
const CLASS_AUDIT_KINDS = ['class', 'struct', 'interface', 'trait', 'record', 'enum', 'namespace'];

/** Strip a base-type expression to its bare name: `Mapping[str, int]`→Mapping, `java.util.List<Foo>`→List, `a::b::C`→C. */
function _bareBaseName(raw) {
    return String(raw).replace(/[<[(].*$/s, '').split('.').pop().split('::').pop().trim();
}

// The universal object root (Python `object`, Java/JS `Object`) has a fixed,
// known method surface — Object/dunder methods, themselves entry points — so it
// never dispatches an arbitrary subclass method by name or override. It is NOT
// an external *dispatching* base: `class Foo(object)` must still report its
// genuinely-dead inherent methods, exactly like `class Foo`, instead of
// diverging on a purely cosmetic base declaration. (Java `Object` is the
// universalSupertype trait; `object` is the Python equivalent — a language
// convention, rule #9.)
const _UNIVERSAL_ROOTS = new Set(['object', 'Object']);

// Python typing bases with a fixed, known surface that never dispatch an
// arbitrary subclass method by name (fix #253b): `class DataService(Generic[T])`
// is exactly `class DataService` for dispatch purposes — Generic contributes
// __class_getitem__ machinery, nothing that calls subclass methods. Without
// this, the external-base shield hid every public method of every generic
// class. Python-gated: an external class literally named Generic in another
// language could genuinely dispatch. Protocol stays OUT — protocol classes
// are contract surface, and their members' "deadness" is a different claim.
const _PY_NON_DISPATCHING_BASES = new Set(['Generic']);

/** True when a base name resolves to NO in-project class/struct/interface/trait/record (an out-of-tree type). */
function _baseIsExternal(index, bare, lang) {
    if (!bare || _UNIVERSAL_ROOTS.has(bare)) return false;
    if (lang === 'python' && _PY_NON_DISPATCHING_BASES.has(bare)) return false;
    const defs = index.symbols.get(bare);
    return !(defs && defs.some(d => _CLASS_KINDS.includes(d.type)));
}

// Bounded heritage-closure depth (fix #270) — matches the engine's other
// inheritance walks.
const _HERITAGE_WALK_DEPTH = 8;

/**
 * Does this CLASS DEF reach at least one base that is NOT in the project
 * index, walking `extends` chains transitively THROUGH resolved project types
 * (fix #270)? One level was not enough — fastify-measured: CustomLoggerImpl
 * implements CustomLogger (project) extends FastifyBaseLogger (project,
 * .d.ts) extends Pick<BaseLogger, ...'silent'> (pino — external). The member
 * surface the class must provide comes from the OUT-OF-TREE end of the chain,
 * invisible without tsc, so a zero-usage impl member (`silent`) is contract
 * surface — deleting it breaks the build. Same dispatch physics as one level;
 * only the verdict moved from "direct parent external" to "heritage closure
 * reaches external".
 *
 * `followImplements` additionally walks the def's OWN `implements` clause
 * (first hop only — the measured family; deeper implements hops are
 * classified-deferred). Method claims pass true only when the member sits
 * INSIDE the def's source range: TS/Java members live in the class body, so
 * the implements contract constrains them. Rust surfaces trait impls as
 * `implements` on the struct (rust.js), but inherent methods live in separate
 * `impl X` blocks OUTSIDE the struct's range — an unrelated `impl Display
 * for X` must never shield a genuinely-dead inherent method (the original
 * reason implements was not consulted here at all; trait-impl members
 * themselves carry traitImpl/@Override markers → Rule A). Class-kind claims
 * pass false: deleting the whole class removes its implements clause with it.
 */
function _heritageReachesExternalBase(index, classDef, lang, followImplements) {
    const seen = new Set();
    let frontier = [classDef];
    for (let depth = 0; depth < _HERITAGE_WALK_DEPTH && frontier.length; depth++) {
        const next = [];
        for (const def of frontier) {
            // Copy array-shaped extends — the implements push below must
            // never mutate the symbol's own heritage data in the index.
            const parents = def.extends
                ? (Array.isArray(def.extends) ? [...def.extends] : splitParentList(def.extends))
                : [];
            if (depth === 0 && followImplements && Array.isArray(def.implements)) {
                parents.push(...def.implements);
            }
            for (const raw of parents) {
                const bare = _bareBaseName(raw);
                if (!bare || seen.has(bare)) continue;
                seen.add(bare);
                if (_baseIsExternal(index, bare, lang)) return true;
                for (const pd of index.symbols.get(bare) || []) {
                    if (_CLASS_KINDS.includes(pd.type)) next.push(pd);
                }
            }
        }
        frontier = next;
    }
    return false;
}

/**
 * Does the method's enclosing class reach at least one base that is NOT in
 * the project index through its heritage closure? An out-of-tree base is a
 * framework/library type UCN can't see; via inheritance it may dispatch into
 * a public method of the subclass polymorphically (Starlette →
 * build_middleware_stack), by name convention (Pydantic → bytes_schema), or
 * REQUIRE the member outright (fastify → CustomLoggerImpl.silent, via an
 * implements chain ending in pino). The class def is matched in the method's
 * own file; `implements` is walked only when the member sits inside the class
 * def's own range (see _heritageReachesExternalBase — the Rust guard).
 */
function _classHasExternalBase(index, symbol) {
    const lang = index.files.get(symbol.file)?.language;
    // The implements hop shields only contract-SATISFIABLE members: an
    // interface implementation must be public, so in explicit-visibility
    // languages a package-private/non-pub member provably cannot implement
    // any interface member (javac rejects it) — `implements Runnable` never
    // shields a package-private helper. Implicit-public languages satisfy
    // contracts with unmarked members; the caller's public-by-shape check
    // already screened those. Compiler physics, not a heuristic.
    const contractSatisfiable = langTraits(lang)?.implicitlyPublicMembers ||
        (symbol.modifiers || []).includes('public');
    const classDefs = (index.symbols.get(symbol.className) || []).filter(c =>
        c.file === symbol.file && _CLASS_KINDS.includes(c.type));
    return classDefs.some(cd => _heritageReachesExternalBase(index, cd, lang,
        contractSatisfiable &&
        symbol.startLine >= cd.startLine && symbol.startLine <= cd.endLine));
}

/**
 * A method that may be reached through an out-of-tree base class — the deadcode
 * analog of fix #210's external-contract methods. A zero in-project usage count
 * is NOT evidence of deadness here; claiming the symbol dead invites deleting a
 * live framework override (e.g. FastAPI.build_middleware_stack overriding
 * Starlette, or GenerateJsonSchema.bytes_schema name-dispatched by Pydantic —
 * the only caller lives in an unindexed dependency).
 *   (A) explicit override marker (@Override / `override` / typing.@override /
 *       Rust `impl Trait for X`) AND a single project-wide method owner of the
 *       name (no in-project supertype defines it → the contract is external —
 *       the #210 ownerCount===1 rule).
 *   (B) a public-by-shape method whose class reaches an unresolved base
 *       through its heritage closure (extends chains walked transitively,
 *       plus the class's own `implements` clause when the member sits in the
 *       class body — fix #270). Private/underscore members are never
 *       external-contract surface, so a genuinely-dead one stays claimable
 *       (the fix #211 shape predicate).
 * Data-driven, not language-keyed: classes without an `extends` clause (Go
 * embedding, Rust structs / inherent impls) never trip (B), and Rust trait
 * impls trip (A) via traitImpl — so new languages inherit correct behavior.
 */
function overridesOutOfTreeBase(index, symbol) {
    if (!symbol.className) return false; // standalone function can't override
    if (isOverrideMarked(symbol)) {
        const owners = (index.symbols.get(symbol.name) || []).filter(s => s.className);
        if (owners.length <= 1) return true;
    }
    const mods = symbol.modifiers || [];
    const publicByShape = !mods.includes('private') &&
        !symbol.name.startsWith('#') && !symbol.name.startsWith('_');
    if (publicByShape && _classHasExternalBase(index, symbol)) return true;
    return false;
}

// Symbol types whose definition NAME line provably cannot reference a
// same-name VALUE — used to stop same-name defs keeping each other alive
// (fix #243). 'state' and 'field' stay OUT: `helper = other.helper` and
// Java `int helper = Other.helper();` genuinely reference the name.
const DEF_NAME_LINE_KINDS = new Set([
    'function', 'method', 'static', 'public', 'abstract', 'constructor',
    'private', 'classmethod', 'property', 'setter', 'deleter', 'get', 'set',
    'override', 'static get', 'static set', 'override get', 'override set',
    'static override', 'static override get', 'static override set',
    'class', 'struct', 'interface', 'trait', 'record', 'enum', 'namespace', 'impl',
]);

/**
 * Is EVERY call site of `name` inside the body of a same-name definition?
 * Recursion is not liveness (fix #253c): if no code outside defs of the name
 * calls the name, the whole same-name group is unreachable from outside —
 * `function retry() { ...retry()... }` with no external caller is dead, but
 * the calleeIndex fast path saw a call site and skipped it. Transitively
 * sound for the group: a same-name def called only by another same-name def
 * is dead exactly when its caller is. findCallees already excludes
 * self-recursion; this mirrors that rule at the deadcode pre-filter.
 * Conservative on any uncertainty: unknown def ranges or an outside site
 * keep the name "used".
 */
function nameOnlySelfRecursive(index, name) {
    const files = index.calleeIndex && index.calleeIndex.get(name);
    if (!files || files.size === 0) return false;
    const defs = (index.symbols.get(name) || []).filter(d => DEF_NAME_LINE_KINDS.has(d.type));
    if (defs.length === 0) return false;
    const defFiles = new Set(defs.map(d => d.file));
    for (const f of files) {
        if (!defFiles.has(f)) return false; // call site in a def-less file — external
    }
    const { getCachedCalls } = require('./callers');
    for (const f of files) {
        let calls;
        try { calls = getCachedCalls(index, f); } catch { return false; }
        if (!calls) return false;
        for (const call of calls) {
            if (call.name !== name && call.resolvedName !== name &&
                !(call.resolvedNames && call.resolvedNames.includes(name))) continue;
            const inside = defs.some(d => d.file === f &&
                call.line >= d.startLine && call.line <= d.endLine);
            if (!inside) return false;
        }
    }
    return true;
}

/** Check if a position in a line is inside a string literal (quotes/backticks).
 *  Language-aware (fix #259, clap-measured): a Rust apostrophe is a LIFETIME
 *  unless it closes as a char literal within a few chars — `impl<E: Send +
 *  'static> MyTrait` read everything after 'static as "inside a string" and
 *  dropped the line's only reference to MyTrait (FALSE-DEAD on clap's
 *  autoref-specialization traits). */
function isInsideString(line, pos, language) {
    let inSingle = false, inDouble = false, inBacktick = false;
    // Template-literal interpolations are CODE (fix #267, hono-measured:
    // `${this.activeRouter.name}` was the getter's ONLY read — masked as
    // string interior, the symbol claimed FALSE-DEAD). JS family only: Go
    // backtick strings are raw, no interpolation. Brace-depth tracked so
    // `${ {a: 1} }` closes at the right brace; quotes inside interpolations
    // are not tracked — the misjudgment direction is UNMASK (counting a
    // usage keeps the symbol alive), never masking code (#253 rule).
    let interpDepth = 0;
    const jsTemplates = language === 'javascript' || language === 'typescript' ||
        language === 'tsx' || language === 'html';
    for (let j = 0; j < pos; j++) {
        const ch = line[j];
        if (ch === '\\') { j++; continue; }
        if (inBacktick && jsTemplates) {
            if (interpDepth === 0) {
                if (ch === '$' && line[j + 1] === '{') { interpDepth = 1; j++; }
                else if (ch === '`') inBacktick = false;
                continue;
            }
            if (ch === '{') interpDepth++;
            else if (ch === '}') interpDepth--;
            continue;
        }
        if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
        if (ch === "'" && !inDouble && !inBacktick) {
            if (language === 'rust') {
                // Char literal ('x', '\n', '\u{1F600}') — skip past it; a
                // non-closing apostrophe is a lifetime and never opens a
                // string (Rust strings are double-quoted only).
                const m = line.slice(j).match(/^'(?:\\u\{[0-9a-fA-F_]+\}|\\.|[^'\\])'/);
                if (m) j += m[0].length - 1;
            } else {
                inSingle = !inSingle;
            }
        }
        if (ch === '`' && !inDouble && !inSingle) inBacktick = !inBacktick;
    }
    return inSingle || inDouble || (inBacktick && interpDepth === 0);
}

/**
 * Build a usage index for identifiers in the codebase (optimized for deadcode)
 * Scans all files ONCE and builds a reverse index: name -> [usages]
 * @param {object} index - ProjectIndex instance
 * @param {Set<string>} [filterNames] - If provided, only track these names (reduces memory)
 * @returns {Map<string, Array>} Usage index
 */
function buildUsageIndex(index, filterNames) {
    const usageIndex = new Map(); // name -> [{file, line}]

    for (const [filePath, fileEntry] of index.files) {
        try {
            const language = detectLanguage(filePath);
            if (!language) continue;

            const content = index._readFile(filePath);

            // Text pre-filter: skip files that don't contain any target names
            // (avoids expensive tree-sitter parse + AST traversal for irrelevant files)
            if (filterNames && filterNames.size > 0) {
                let hasAny = false;
                for (const name of filterNames) {
                    if (content.includes(name)) {
                        hasAny = true;
                        break;
                    }
                }
                if (!hasAny) continue;
            }

            // For HTML files, parse the virtual JS content instead of raw HTML
            // (HTML tree-sitter sees script content as raw_text, not JS identifiers)
            let tree;
            if (language === 'html') {
                const htmlModule = getLanguageModule('html');
                const htmlParser = getParser('html');
                const jsParser = getParser('javascript');
                const blocks = htmlModule.extractScriptBlocks(content, htmlParser);
                if (blocks.length === 0 && !htmlModule.extractEventHandlerCalls) continue;
                if (blocks.length > 0) {
                    const virtualJS = htmlModule.buildVirtualJSContent(content, blocks);
                    tree = safeParse(jsParser, virtualJS);
                }
            } else {
                const parser = getParser(language);
                if (!parser) continue;
                tree = safeParse(parser, content);
            }

            // Collect all identifiers from this file in one pass
            const traverse = (node) => {
                // Match all identifier-like nodes across languages
                if (node.type === 'identifier' ||
                    node.type === 'property_identifier' ||
                    node.type === 'type_identifier' ||
                    node.type === 'shorthand_property_identifier' ||
                    node.type === 'shorthand_property_identifier_pattern' ||
                    node.type === 'field_identifier') {
                    // Skip property_identifier/field_identifier when they're:
                    // 1. The property part of a member expression (e.g., obj.Separator)
                    // 2. An object literal key (e.g., { Separator: value })
                    // These are NOT references to standalone symbols.
                    // Shorthand properties ({ Separator }) use shorthand_property_identifier instead.
                    if ((node.type === 'property_identifier' || node.type === 'field_identifier') && node.parent) {
                        const parentType = node.parent.type;
                        // Object literal key: { Separator: 'value' } — not a reference
                        if (parentType === 'pair' || parentType === 'key_value_pair' ||
                            parentType === 'dictionary_entry' || parentType === 'field_declaration') {
                            // Check if this is the key (first child) of the pair
                            const firstChild = node.parent.child(0);
                            if (firstChild === node) {
                                for (let i = 0; i < node.childCount; i++) {
                                    traverse(node.child(i));
                                }
                                return;
                            }
                        }
                        // Member expression property: obj.Separator — not a standalone reference
                        // EXCEPTION: If the selector/member expression is part of a call_expression,
                        // this IS a method call (e.g., dc.syncDeployment()) and should count as usage.
                        if (parentType === 'member_expression' ||
                            parentType === 'field_expression' ||
                            parentType === 'member_access_expression' ||
                            parentType === 'selector_expression' ||       // Go
                            parentType === 'field_access_expression' ||   // Rust
                            parentType === 'scoped_identifier') {         // Rust
                            // Check if this is the property (right side) of the member expression
                            // by checking if it's NOT the object (left side)
                            const firstChild = node.parent.child(0);
                            if (firstChild !== node) {
                                // Check if this member expression is part of a call or
                                // used as a function reference (callback argument)
                                const grandparent = node.parent.parent;
                                const isCall = grandparent &&
                                    (grandparent.type === 'call_expression' ||
                                     grandparent.type === 'argument_list' ||
                                     grandparent.type === 'arguments');
                                if (!isCall) {
                                    // Pure field access — skip for deadcode counting
                                    for (let i = 0; i < node.childCount; i++) {
                                        traverse(node.child(i));
                                    }
                                    return;
                                }
                                // Method call or callback — fall through to count as usage
                            }
                        }
                    }
                    const name = node.text;
                    if (filterNames && !filterNames.has(name)) {
                        for (let i = 0; i < node.childCount; i++) {
                            traverse(node.child(i));
                        }
                        return;
                    }
                    if (!usageIndex.has(name)) {
                        usageIndex.set(name, []);
                    }
                    usageIndex.get(name).push({
                        file: filePath,
                        line: node.startPosition.row + 1,
                        relativePath: fileEntry.relativePath
                    });
                }
                for (let i = 0; i < node.childCount; i++) {
                    traverse(node.child(i));
                }
            };
            if (tree) traverse(tree.rootNode);

            // For HTML files, also extract identifiers from event handler attributes
            // (onclick="foo()" etc. — these are in HTML, not in <script> blocks)
            if (language === 'html') {
                const htmlModule = getLanguageModule('html');
                const htmlParser = getParser('html');
                const handlerCalls = htmlModule.extractEventHandlerCalls(content, htmlParser);
                for (const call of handlerCalls) {
                    if (!usageIndex.has(call.name)) {
                        usageIndex.set(call.name, []);
                    }
                    usageIndex.get(call.name).push({
                        file: filePath,
                        line: call.line,
                        relativePath: fileEntry.relativePath
                    });
                }
            }
        } catch (e) {
            // Skip files that can't be processed
        }
    }

    return usageIndex;
}

/**
 * Is a symbol part of the public/exported API surface?
 *
 * Beyond direct evidence (export list, export/public modifiers, Go
 * capitalization), methods of an exported class count as exported in
 * languages where class members are public by default (implicitlyPublicMembers
 * trait — JS/TS/Python): they are reachable through the class from outside
 * the project, so claiming them dead invites deleting public API (fix #211 —
 * zod's `strictImplement` is called by zero project files but is documented
 * public API). Private-by-shape members (#name, _name, `private` modifier)
 * stay claimable.
 */
function symbolIsExported(index, symbol, fileEntry) {
    if (!fileEntry) return false;
    const name = symbol.name;
    const mods = symbol.modifiers || [];
    if (fileEntry.exports.includes(name) || mods.includes('export') || mods.includes('public')) {
        return true;
    }
    const traits = langTraits(fileEntry.language);
    if (traits?.exportVisibility === 'capitalization') {
        return /^[A-Z]/.test(name);
    }
    if (traits?.implicitlyPublicMembers && symbol.className &&
        !mods.includes('private') && !name.startsWith('#') && !name.startsWith('_')) {
        const classSyms = index.symbols.get(symbol.className) || [];
        const cls = classSyms.find(c => c.file === symbol.file &&
            (c.type === 'class' || c.type === 'interface'));
        if (cls) {
            const cmods = cls.modifiers || [];
            if (fileEntry.exports.includes(symbol.className) ||
                cmods.includes('export') || cmods.includes('public')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Find dead code (unused functions/classes)
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { includeExported, includeTests }
 * @returns {Array} Unused symbols
 */
function deadcode(index, options = {}) {
    index._beginOp();
    try {
    const results = [];
    let excludedDecorated = 0;
    let excludedExported = 0;
    let excludedExternalContract = 0;

    // Ensure callee index is built (lazy, reused across operations)
    if (!index.calleeIndex) {
        index.buildCalleeIndex();
    }

    // Collect callable symbol names to reduce usage index scope.
    // Accessor and visibility kinds joined in fix #247 — #private methods,
    // getters/setters, Python underscore/@property/@classmethod/@x.setter/
    // @x.deleter members were silently unaudited in BOTH modes (no exclusion
    // counter said so). Property accessors count reads/writes as usage: the
    // scan totals ALL usage types, so `obj.value` keeps a getter alive.
    const callableTypes = ['function', 'method', 'static', 'public', 'abstract', 'constructor',
        'private', 'get', 'set', 'property', 'setter', 'deleter', 'classmethod',
        'override', 'static get', 'static set', 'override get', 'override set',
        'static override', 'static override get', 'static override set',
        // Class-like kinds joined in fix #253a — unused classes/structs/
        // interfaces were never audited in either mode.
        ...CLASS_AUDIT_KINDS];
    const auditTypeSet = new Set(callableTypes);
    const classAuditSet = new Set(CLASS_AUDIT_KINDS);
    const callableNames = new Set();
    for (const [symbolName, symbols] of index.symbols) {
        if (symbols.some(s => auditTypeSet.has(s.type))) {
            callableNames.add(symbolName);
        }
    }

    // Pre-filter: names in the callee index have call sites → definitely used → not dead.
    // Exception (fix #253c): a name whose EVERY call site sits inside a
    // same-name definition's own body is only self-recursive — recursion is
    // not liveness. Those names fall through to the text scan, which excludes
    // in-body references for them (selfRecursiveNames below).
    let potentiallyDeadNames = new Set();
    const selfRecursiveNames = new Set();
    for (const name of callableNames) {
        if (!index.calleeIndex.has(name)) {
            potentiallyDeadNames.add(name);
        } else if (nameOnlySelfRecursive(index, name)) {
            selfRecursiveNames.add(name);
            potentiallyDeadNames.add(name);
        }
    }

    // Pre-filter exported symbols from the scan set when not auditing exports.
    // Go exports ~63K capitalized names on K8s — scanning these in Phase 2 only to
    // skip them in Phase 3 wastes O(63K × 11K files) = ~700M comparisons.
    if (!options.includeExported) {
        const narrowed = new Set();
        for (const name of potentiallyDeadNames) {
            const syms = index.symbols.get(name) || [];
            // Keep the name only if at least one definition is NOT exported
            const allExported = syms.every(s => symbolIsExported(index, s, index.files.get(s.file)));
            if (!allExported) narrowed.add(name);
        }
        potentiallyDeadNames = narrowed;
    }

    // When --file is provided, pre-filter to only names of symbols in the target scope.
    // The text scan below is O(potentiallyDeadNames × files) — narrowing the name set
    // avoids scanning all files for names that will be filtered out at the result stage.
    if (options.file) {
        const filteredNames = new Set();
        for (const name of potentiallyDeadNames) {
            const syms = index.symbols.get(name) || [];
            if (syms.some(s => s.relativePath && s.relativePath.includes(options.file))) {
                filteredNames.add(name);
            }
        }
        potentiallyDeadNames = filteredNames;
    }

    // Export-site line ranges per file (lazy, --include-exported only): the
    // precise AST regions where a name's appearance is a re-statement of the
    // export, not consumption (fix #247 — the line-prefix check missed
    // multi-line `export { a,\n b }` blocks, so every symbol exported that
    // way was silently absent from the audit). Ranges are identifier-pure by
    // construction: export clauses, `export default <identifier>`, and
    // identifier/shorthand values of module.exports/exports.* object maps —
    // a function body inside an export assignment still counts as usage.
    const exportRangeCache = new Map();
    const exportSiteRanges = (filePath) => {
        let ranges = exportRangeCache.get(filePath);
        if (ranges) return ranges;
        ranges = [];
        exportRangeCache.set(filePath, ranges);
        const fe = index.files.get(filePath);
        if (!fe || !['javascript', 'typescript', 'tsx'].includes(fe.language)) return ranges;
        let content;
        try { content = index._readFile(filePath); } catch { return ranges; }
        const tree = index._getParsedTree(filePath, content, fe.language);
        if (!tree) return ranges;
        const push = (node) => ranges.push([node.startPosition.row + 1, node.endPosition.row + 1]);
        // A re-statement is filterable only when consumers reach the symbol
        // under ITS OWN NAME (text-visible elsewhere). Renaming surfaces are
        // consumption wiring, never filtered: `export { x as y }` (consumers
        // use y), `module.exports = x` and `export default x` (consumers
        // rename at require/import) — the eval measured all three as
        // FALSE-DEAD when filtered (express createApplication, zod
        // instanceOfType).
        const visit = (node) => {
            if (node.type === 'export_statement') {
                for (const child of node.namedChildren) {
                    if (child.type === 'export_clause') {
                        for (const spec of child.namedChildren) {
                            if (spec.type !== 'export_specifier') continue;
                            if (spec.childForFieldName('alias')) continue;
                            push(spec);
                        }
                    }
                }
                return; // never descend into exported declarations
            }
            if (node.type === 'assignment_expression') {
                const lhs = node.childForFieldName('left');
                const rhs = node.childForFieldName('right');
                const lhsText = lhs ? lhs.text : '';
                const wholeModule = lhsText === 'module.exports' || lhsText === 'exports';
                const namedExport = lhsText.startsWith('module.exports.') || lhsText.startsWith('exports.');
                if (rhs && (wholeModule || namedExport)) {
                    if (rhs.type === 'identifier') {
                        if (namedExport) push(rhs); // exports.helper = helper — name-preserving
                    } else if (rhs.type === 'object') {
                        for (const prop of rhs.namedChildren) {
                            if (prop.type === 'shorthand_property_identifier') push(prop);
                            else if (prop.type === 'pair') {
                                const v = prop.childForFieldName('value');
                                const k = prop.childForFieldName('key');
                                // `{ helper: helper }` filters; `{ other: helper }`
                                // renames — consumption wiring.
                                if (v && v.type === 'identifier' && k && k.text === v.text) push(v);
                            }
                        }
                    }
                    if (!wholeModule) return;
                    // exports = module.exports = X chains: descend the RHS.
                }
            }
            for (const child of node.namedChildren) visit(child);
        };
        try { visit(tree.rootNode); } catch { /* partial ranges are fine */ }
        return ranges;
    };

    // Build usage index for potentially dead names using text scan (no tree-sitter reparsing).
    // The callee index already covers all call-based usages. For remaining names, a word-boundary
    // text scan catches imports, exports, shorthand properties, type refs, and variable refs.
    // Trade-off: may match names in comments/strings (false "used" → fewer dead code reports),
    // but avoids ~1.9s of tree-sitter re-parsing. buildUsageIndex() is kept for direct callers.
    // Names owned by an ACCESSOR-kind definition (getter/setter/@property):
    // their entire consumption form is a paren-less attribute read
    // (`response.num_bytes_downloaded`), whose receiver is usually a local
    // the #123/#216 dotted discipline can't resolve. Dropping those reads
    // claimed 15 live properties dead across httpx/rich (fix #247, eval-
    // measured) — for these names the read keeps the usage UNSCOPED
    // (conservative: keeps every same-name symbol alive), exactly the #243
    // decorator rule. Non-accessor names keep the strict discipline.
    const ACCESSOR_KINDS = new Set(['property', 'setter', 'deleter', 'get', 'set',
        'static get', 'static set', 'override get', 'override set',
        'static override get', 'static override set']);
    const accessorNames = new Set();
    // Names owned by a class-kind definition (fix #253a): in PYTHON files,
    // string-interior matches count as usage for these — PEP 484 forward
    // references (`x: "Foo"`, `Optional["Foo"]`) are real type references
    // the type checker resolves; skipping them claimed live classes dead.
    // Conservative direction only (docstring mentions also keep the class
    // alive). Other languages keep the string skip: their in-string names
    // are reflection (a documented limitation), not a language feature.
    const classKindNames = new Set();
    for (const name of potentiallyDeadNames) {
        const defs = index.symbols.get(name) || [];
        if (defs.some(s => ACCESSOR_KINDS.has(s.type))) {
            accessorNames.add(name);
        }
        if (defs.some(s => classAuditSet.has(s.type))) {
            classKindNames.add(name);
        }
    }

    const usageIndex = new Map();
    if (potentiallyDeadNames.size > 0) {
        for (const [filePath, fileEntry] of index.files) {
            try {
                const content = index._readFile(filePath);
                // Fast pre-filter: extract identifiers from file, intersect with target names.
                // One regex pass over content (O(content)) vs O(names × content) substring searches.
                // Names the identifier regex can never produce — quoted member names
                // (zod's `"~validate"`), $-containing JS names — fall back to a substring
                // check, or they would scan as zero-usage and be falsely claimed dead
                // (fix #211: `this["~validate"](data)` is a real usage; the quotes in
                // the symbol name make the substring search self-delimiting).
                const fileIdentifiers = new Set(content.match(/\b[a-zA-Z_]\w*\b/g));
                const namesInFile = [];
                for (const name of potentiallyDeadNames) {
                    const present = /^[a-zA-Z_]\w*$/.test(name)
                        ? fileIdentifiers.has(name)
                        : content.includes(name);
                    if (present) namesInFile.push(name);
                }
                if (namesInFile.length === 0) continue;
                // Block-comment interiors masked to spaces (fix #253d): the
                // per-line skip below only handles // and # comments, so a
                // name inside /* ... */ counted as usage — commented-out code
                // silently kept its symbols "alive" and hid true dead claims.
                const lines = maskBlockComments(content, fileEntry.language).split('\n');
                for (const name of namesInFile) {
                    const nameLen = name.length;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (!line.includes(name)) continue;
                        // Skip line if entirely inside a line comment — the
                        // markers are language-shaped (fix #259, clap-measured):
                        // `#` comments PYTHON ONLY (a Rust attribute line
                        // `#[arg(value_parser = helper)]` is code, and the old
                        // skip dropped every reference on it — clap's derive-
                        // attribute callbacks claimed FALSE-DEAD); `//` comments
                        // everywhere EXCEPT Python, where it is floor division.
                        const isPython = fileEntry.language === 'python';
                        const commentIdx = isPython ? -1 : line.indexOf('//');
                        const hashIdx = isPython ? line.indexOf('#') : -1;
                        let searchFrom = 0;
                        while (searchFrom < line.length) {
                            const pos = line.indexOf(name, searchFrom);
                            if (pos === -1) break;
                            searchFrom = pos + 1;
                            // Word boundary check
                            if (pos > 0 && /\w/.test(line[pos - 1])) continue;
                            if (pos + nameLen < line.length && /\w/.test(line[pos + nameLen])) continue;
                            // Skip if inside a // comment (not :// URL)
                            if (commentIdx !== -1 && commentIdx < pos &&
                                (commentIdx === 0 || line[commentIdx - 1] !== ':')) continue;
                            // Skip if inside a # comment (Python — # preceded by whitespace or at start)
                            if (hashIdx !== -1 && hashIdx < pos &&
                                (hashIdx === 0 || /\s/.test(line[hashIdx - 1]))) continue;
                            // Skip if inside a string literal — EXCEPT class-
                            // kind names in Python (fix #253a): `x: "Foo"`
                            // forward references are real type references.
                            if (isInsideString(line, pos, fileEntry.language) &&
                                !(fileEntry.language === 'python' && classKindNames.has(name))) continue;
                            // Property/field access (preceded by '.'), not a
                            // call: resolve the RECEIVER (fix #216, express-
                            // measured false-dead — `app.all(route, user.load)`
                            // is a callback reference to user.js's load, and
                            // deleting it breaks the route).
                            //   - import-bound module receiver → usage scoped
                            //     to the module's resolved file
                            //   - this/self/cls receiver → usage scoped to the
                            //     same file (same-class member reference)
                            //   - any other receiver (local object literal,
                            //     instance) → NOT a usage of a standalone
                            //     symbol (fix #123: `Primitives.Separator` has
                            //     its own key; must not keep the export alive)
                            let dottedScope;
                            if (pos > 0 && line[pos - 1] === '.' &&
                                (pos + nameLen >= line.length || line[pos + nameLen] !== '(')) {
                                // Bare dotted DECORATOR application (@bus.subscribe,
                                // @a.b.helper) executes at import time — always a
                                // usage, whatever the receiver is (fix #243,
                                // FALSE-DEAD: deleting @bus.subscribe's subscribe
                                // breaks the module at import; the receiver `bus`
                                // is a local instance, not an import binding).
                                const before = line.slice(0, pos);
                                const atIdx = before.lastIndexOf('@');
                                const isDecoratorRef = atIdx !== -1 &&
                                    /^[\w$.]*$/.test(before.slice(atIdx + 1)) &&
                                    before.slice(0, atIdx).trim() === '';
                                let r = pos - 2;
                                while (r >= 0 && /[\w$]/.test(line[r])) r--;
                                const receiver = line.slice(r + 1, pos - 1);
                                // A CHAINED receiver (`z.string().email().isEmail`)
                                // extracts as empty — for accessor-kind names
                                // that read is still the consumption form, so
                                // the #247 unscoped fallback below must get
                                // its chance (zod-measured false-dead: eight
                                // v3 getters whose only references are
                                // chained reads; the empty-receiver drop
                                // fired before the accessor exemption).
                                if (!receiver && !isDecoratorRef && !accessorNames.has(name)) continue;
                                if (['this', 'self', 'cls'].includes(receiver)) {
                                    dottedScope = 'same-file';
                                } else {
                                    const binding = (fileEntry.importBindings || [])
                                        .find(b => b.name === receiver);
                                    const resolved = binding && fileEntry.moduleResolved &&
                                        fileEntry.moduleResolved[binding.module];
                                    if (resolved) {
                                        dottedScope = resolved;
                                    } else if (!isDecoratorRef && !accessorNames.has(name)) {
                                        continue;
                                    }
                                    // decorator with unresolvable receiver, or
                                    // an attribute read of an ACCESSOR-kind
                                    // name (fix #247 — the read IS how
                                    // getters/properties are consumed): keep
                                    // the usage UNSCOPED (conservative —
                                    // keeps every same-name symbol alive)
                                }
                            }
                            // Skip object literal key: name followed by ':' (not '::' for Rust paths).
                            // A DOTTED access is never a literal key — object keys are bare
                            // (fix #247, eval-measured: Python's block colon made
                            // `if merge_url.is_relative_url:` read as a key, dropping the
                            // property's only consumption).
                            // Python is exempt entirely (fix #253a): it has NO
                            // bare-identifier-key syntax where the name is not
                            // an expression — dict keys are expressions, and
                            // `except Foo:` / `-> Foo:` / `while Foo:` are all
                            // real usages the skip was dropping. `case Foo:`
                            // (switch/match) is likewise an expression usage in
                            // every language.
                            const afterChar = pos + nameLen < line.length ? line[pos + nameLen] : '';
                            const afterChar2 = pos + nameLen + 1 < line.length ? line[pos + nameLen + 1] : '';
                            if (afterChar === ':' && afterChar2 !== ':' &&
                                fileEntry.language !== 'python' &&
                                !(pos > 0 && line[pos - 1] === '.') &&
                                !/(^|[^\w$])case\s+$/.test(line.slice(0, pos))) continue;
                            // Valid reference found
                            if (!usageIndex.has(name)) usageIndex.set(name, []);
                            usageIndex.get(name).push({
                                file: filePath,
                                line: i + 1,
                                relativePath: fileEntry.relativePath,
                                ...(dottedScope && { dottedScope })
                            });
                            break; // one match per line is enough for deadcode
                        }
                    }
                }
            } catch { /* skip unreadable files */ }
        }
    }

    for (const [name, symbols] of index.symbols) {
        // Definition NAME lines of same-name def-kind symbols are
        // declarations, not usages — two never-called same-name methods used
        // to keep each other alive (fix #243: three unreferenced `delete`
        // methods invisible). nameLine only (never a decorated def's
        // startLine — a `@helper` decorator line IS a usage of the name).
        let sameNameDefLines = null;
        const defNameLines = () => {
            if (sameNameDefLines) return sameNameDefLines;
            sameNameDefLines = new Map();
            for (const other of symbols) {
                if (!DEF_NAME_LINE_KINDS.has(other.type)) continue;
                const ln = other.nameLine ?? other.startLine;
                if (ln == null) continue;
                let set = sameNameDefLines.get(other.file);
                if (!set) { set = new Set(); sameNameDefLines.set(other.file, set); }
                set.add(ln);
            }
            return sameNameDefLines;
        };

        // Same-name definition BODY ranges — consulted only for names the
        // self-recursion carve-out (fix #253c) admitted: for those, a usage
        // inside a same-name def's own body is the recursion itself, never
        // outside liveness. Scoped to carve-out names so a sibling-method
        // call (`self.f()` from another method) keeps counting elsewhere.
        let sameNameDefRanges = null;
        const defRanges = () => {
            if (sameNameDefRanges) return sameNameDefRanges;
            sameNameDefRanges = new Map();
            for (const other of symbols) {
                if (!DEF_NAME_LINE_KINDS.has(other.type)) continue;
                let arr = sameNameDefRanges.get(other.file);
                if (!arr) { arr = []; sameNameDefRanges.set(other.file, arr); }
                arr.push([other.startLine, other.endLine]);
            }
            return sameNameDefRanges;
        };

        for (const symbol of symbols) {
            // Skip non-audited types (callableTypes defined above)
            if (!auditTypeSet.has(symbol.type)) {
                continue;
            }

            const fileEntry = index.files.get(symbol.file);
            const lang = fileEntry?.language;

            // Skip bundled/minified files (webpack bundles, build artifacts)
            if (fileEntry?.isBundled) {
                continue;
            }

            // Skip test files unless requested
            if (!options.includeTests && isTestFile(symbol.relativePath, lang)) {
                continue;
            }

            // Apply file filter (scopes deadcode to matching files)
            if (options.file && !symbol.relativePath.includes(options.file)) {
                continue;
            }

            // Apply exclude and in filters
            if ((options.exclude && options.exclude.length > 0) || options.in) {
                if (!index.matchesFilters(symbol.relativePath, { exclude: options.exclude, in: options.in })) {
                    continue;
                }
            }

            const mods = symbol.modifiers || [];

            // Ambient declaration files are never dead CODE (fix #267,
            // zustand-measured: `interface ImportMeta` in src/types.d.ts —
            // global lib merging UCN cannot see): .d.ts content is erased at
            // compile time and describes external/global shapes — nothing in
            // it is deletable code, so nothing in it is claimable.
            if (symbol.relativePath.endsWith('.d.ts')) {
                continue;
            }

            // Language-specific entry points (called by runtime/test runner, not user code)
            // Each language module declares its own isEntryPoint() rules.
            const langModule = getLanguageModule(lang);
            if (langModule.isEntryPoint?.(symbol)) {
                continue;
            }

            // Framework entry point detection — excluded by default to reduce noise
            // Detects decorator/annotation patterns (Python, Java, Rust, JS/TS) and
            // call-pattern-based registration (Express routes, Gin handlers, etc.)
            // These functions are invoked by frameworks, not by user code.
            const hasFrameworkEntrypoint = isFrameworkEntrypoint(symbol, index);

            if (hasFrameworkEntrypoint && !options.includeDecorated) {
                excludedDecorated++;
                continue;
            }

            const isExported = symbolIsExported(index, symbol, fileEntry);

            // Skip exported unless requested
            if (isExported && !options.includeExported) {
                excludedExported++;
                continue;
            }

            // Fast path: name has call sites in callee index → definitely used → not dead
            // (unless every site is the name's own recursion — fix #253c).
            if (index.calleeIndex.has(name) && !selfRecursiveNames.has(name)) {
                continue;
            }
            // Constructor members are invoked through the CLASS name
            // (fix #239, G2-js-measured: `new Widget()` indexes under
            // 'Widget' — the member lookup claimed every instantiated
            // class's constructor dead).
            if (symbol.className &&
                (symbol.type === 'constructor' || name === 'constructor' || name === '__init__') &&
                index.calleeIndex.has(symbol.className) &&
                !selfRecursiveNames.has(symbol.className)) {
                continue;
            }

            // Class-kind claims (fix #253a): a class whose member the runtime
            // or a framework invokes is live with zero textual references of
            // the class NAME — `class Main { public static void main }`,
            // a class with @app.route methods. Deleting the class deletes the
            // entry point. Framework-registered members follow the same
            // --include-decorated reveal as directly decorated symbols.
            if (classAuditSet.has(symbol.type)) {
                const members = (fileEntry?.symbols || []).filter(s =>
                    s !== symbol && s.className === name);
                if (members.some(m => langModule.isEntryPoint?.(m))) {
                    continue;
                }
                if (members.some(m => isFrameworkEntrypoint(m, index))) {
                    if (!options.includeDecorated) {
                        excludedDecorated++;
                        continue;
                    }
                }
            }

            // Slow path: check AST-based usage index for remaining names
            const allUsages = usageIndex.get(name) || [];

            // Filter out usages that are at the definition location
            // nameLine: when decorators/annotations are present, startLine is the decorator line
            // but the name identifier is on a different line (nameLine). Check both.
            // Dotted usages (fix #216) are scoped to the file their receiver
            // resolves to — `user.load` keeps user.js's load alive, never an
            // unrelated module's same-name symbol.
            let nonDefUsages = allUsages.filter(u =>
                !(u.file === symbol.file && (u.line === symbol.startLine || u.line === symbol.nameLine)) &&
                !(defNameLines().get(u.file)?.has(u.line)) &&
                // Self-recursion carve-out names (fix #253c): a reference
                // inside a same-name def's own body is the recursion itself.
                !(selfRecursiveNames.has(name) &&
                    lineInRanges(u.line, defRanges().get(u.file) || [])) &&
                (!u.dottedScope ||
                    (u.dottedScope === 'same-file'
                        ? u.file === symbol.file
                        // Directory-scoped packages (Go): the import binds the
                        // package DIRECTORY, so the resolved module file may
                        // be any sibling of the symbol's file (fix #253,
                        // grpc-go-measured false-dead: the only usages of
                        // `internal.EnforceSubConnEmbedding` resolved to a
                        // sibling of internal/internal.go and were dropped).
                        : (u.dottedScope === symbol.relativePath ||
                            (langTraits(lang)?.packageScope === 'directory' &&
                                pathDirname(u.dottedScope) === pathDirname(symbol.relativePath)))))
            );

            // For exported symbols in --include-exported mode, also filter out export-site
            // references (e.g., `module.exports = { helperC }` or `export { helperC }`).
            // These are just re-statements of the export, not actual consumption.
            // AST ranges, not line prefixes (fix #247): a multi-line
            // `export { a,\n b }` block's continuation lines counted as
            // consumption, silently hiding every symbol exported that way.
            if (isExported && options.includeExported) {
                nonDefUsages = nonDefUsages.filter(u => {
                    if (u.file !== symbol.file) return true; // cross-file usage always counts
                    const ranges = exportSiteRanges(u.file);
                    return !lineInRanges(u.line, ranges);
                });
            }

            // Total includes all usage types (calls, references, callbacks, re-exports)
            const totalUsages = nonDefUsages.length;

            if (totalUsages === 0) {
                // External-contract override: the method may be invoked through
                // an out-of-tree base class UCN can't index (deadcode analog of
                // fix #210). A zero usage count is not evidence of deadness.
                // Hidden by default; revealed under --include-exported, since
                // it is external-reachable surface, not internal dead code.
                // Class-kind claims (fix #253a) get the same shield when the
                // class itself EXTENDS an unresolved base: frameworks discover
                // such subclasses non-textually (django `Command(BaseCommand)`
                // by module path, pytest plugins by registration) — zero
                // in-project references is not evidence of deadness there.
                const isExternalContract = classAuditSet.has(symbol.type)
                    ? _heritageReachesExternalBase(index, symbol, lang, false)
                    : overridesOutOfTreeBase(index, symbol);
                if (isExternalContract && !options.includeExported) {
                    excludedExternalContract++;
                    continue;
                }
                // Collect decorators/annotations for hint display
                // Python: symbol.decorators (e.g., ['app.route("/path")', 'login_required'])
                // Java/Rust/Go: symbol.modifiers may contain annotations (e.g., 'bean', 'scheduled')
                const decorators = symbol.decorators || [];
                // For Java, extract annotation-like modifiers
                const javaKw = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default']);
                const annotations = lang === 'java'
                    ? mods.filter(m => !javaKw.has(m))
                    : [];

                // Interface/trait member declarations are contract surface, not
                // executable code: "unreferenced" is true, but deleting one
                // changes the API contract rather than removing dead logic (Go
                // marker interfaces exist SOLELY as uncallable declarations —
                // grpc-go-measured: its entire default deadcode output was this
                // family). Label so the claim self-explains (fix #211). Only
                // body-less declarations qualify — Java `default` and Rust
                // default-bodied trait methods are executable code, detected
                // generically by a brace in the member's source range.
                const declaredOn = (() => {
                    if (!symbol.className) return null;
                    const enclosing = (index.symbols.get(symbol.className) || []).find(c =>
                        c.file === symbol.file && (c.type === 'interface' || c.type === 'trait'));
                    if (!enclosing) return null;
                    try {
                        const content = index._readFile(symbol.file);
                        const range = content.split('\n').slice(symbol.startLine - 1, symbol.endLine).join('\n');
                        if (range.includes('{')) return null;
                    } catch { return null; }
                    return { kind: enclosing.type, name: symbol.className };
                })();

                results.push({
                    name: symbol.name,
                    type: symbol.type,
                    file: symbol.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    // Two dead constructors in one file rendered identically
                    // without their class (fix #247).
                    ...(symbol.className && { className: symbol.className }),
                    isExported,
                    usageCount: 0,
                    // The name's only references are its own recursion
                    // (fix #253c) — say so, the reader will see call sites.
                    ...(selfRecursiveNames.has(name) && { selfRecursive: true }),
                    ...(decorators.length > 0 && { decorators }),
                    ...(annotations.length > 0 && { annotations }),
                    ...(declaredOn && { declaredOn }),
                    ...(isExternalContract && { externalContract: true })
                });
            }
        }
    }

    // Sort by file then line
    results.sort((a, b) => {
        if (a.file !== b.file) return codeUnitCompare(a.file, b.file);
        return a.startLine - b.startLine;
    });

    // Attach exclusion counts as array properties (backwards-compatible)
    results.excludedDecorated = excludedDecorated;
    results.excludedExported = excludedExported;
    results.excludedExternalContract = excludedExternalContract;

    return results;
    } finally { index._endOp(); }
}

module.exports = { buildUsageIndex, deadcode, nameOnlySelfRecursive, DEF_NAME_LINE_KINDS };
