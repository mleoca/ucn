/**
 * core/deadcode.js - Dead code detection (unused functions/classes)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageModule, safeParse, langTraits } = require('../languages');
const { isTestFile } = require('./discovery');
const { isFrameworkEntrypoint } = require('./entrypoints');
const { splitParentList } = require('./graph-build');
const { isOverrideMarked } = require('./shared');

const _CLASS_KINDS = ['class', 'struct', 'interface', 'trait', 'record'];

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

/** True when a base name resolves to NO in-project class/struct/interface/trait/record (an out-of-tree type). */
function _baseIsExternal(index, bare) {
    if (!bare || _UNIVERSAL_ROOTS.has(bare)) return false;
    const defs = index.symbols.get(bare);
    return !(defs && defs.some(d => _CLASS_KINDS.includes(d.type)));
}

/**
 * Does the method's enclosing class EXTEND at least one base that is NOT in the
 * project index? An out-of-tree base is a framework/library type UCN can't see;
 * via inheritance it may dispatch into a public method of the subclass
 * polymorphically (Starlette → build_middleware_stack) or by name convention
 * (Pydantic → bytes_schema). The class def is matched in the method's own file.
 *
 * `implements` is deliberately NOT consulted: implementing an external
 * interface/trait makes only the INTERFACE'S OWN methods a contract (those
 * carry traitImpl/@Override markers → handled by Rule A), not the class's
 * unrelated inherent methods. Counting it would wrongly shield, e.g., a Rust
 * struct's genuinely-dead inherent method just because the struct also
 * `impl Display for`s.
 */
function _classHasExternalBase(index, symbol) {
    const classDefs = (index.symbols.get(symbol.className) || []).filter(c =>
        c.file === symbol.file && _CLASS_KINDS.includes(c.type));
    for (const cd of classDefs) {
        if (!cd.extends) continue;
        const supers = Array.isArray(cd.extends) ? cd.extends : splitParentList(cd.extends);
        for (const raw of supers) {
            if (_baseIsExternal(index, _bareBaseName(raw))) return true;
        }
    }
    return false;
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
 *   (B) a public-by-shape method whose class EXTENDS an unresolved base.
 *       Private/underscore members are never external-contract surface, so a
 *       genuinely-dead one stays claimable (the fix #211 shape predicate).
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

/** Check if a position in a line is inside a string literal (quotes/backticks) */
function isInsideString(line, pos) {
    let inSingle = false, inDouble = false, inBacktick = false;
    for (let j = 0; j < pos; j++) {
        const ch = line[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
        if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
        if (ch === '`' && !inDouble && !inSingle) inBacktick = !inBacktick;
    }
    return inSingle || inDouble || inBacktick;
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

    // Collect callable symbol names to reduce usage index scope
    const callableTypes = ['function', 'method', 'static', 'public', 'abstract', 'constructor'];
    const callableNames = new Set();
    for (const [symbolName, symbols] of index.symbols) {
        if (symbols.some(s => callableTypes.includes(s.type))) {
            callableNames.add(symbolName);
        }
    }

    // Pre-filter: names in the callee index have call sites → definitely used → not dead.
    let potentiallyDeadNames = new Set();
    for (const name of callableNames) {
        if (!index.calleeIndex.has(name)) {
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

    // Build usage index for potentially dead names using text scan (no tree-sitter reparsing).
    // The callee index already covers all call-based usages. For remaining names, a word-boundary
    // text scan catches imports, exports, shorthand properties, type refs, and variable refs.
    // Trade-off: may match names in comments/strings (false "used" → fewer dead code reports),
    // but avoids ~1.9s of tree-sitter re-parsing. buildUsageIndex() is kept for direct callers.
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
                const lines = content.split('\n');
                for (const name of namesInFile) {
                    const nameLen = name.length;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (!line.includes(name)) continue;
                        // Skip line if entirely inside a line comment (// or #)
                        const commentIdx = line.indexOf('//');
                        const hashIdx = line.indexOf('#');
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
                            // Skip if inside a string literal
                            if (isInsideString(line, pos)) continue;
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
                                let r = pos - 2;
                                while (r >= 0 && /[\w$]/.test(line[r])) r--;
                                const receiver = line.slice(r + 1, pos - 1);
                                if (!receiver) continue;
                                if (['this', 'self', 'cls'].includes(receiver)) {
                                    dottedScope = 'same-file';
                                } else {
                                    const binding = (fileEntry.importBindings || [])
                                        .find(b => b.name === receiver);
                                    const resolved = binding && fileEntry.moduleResolved &&
                                        fileEntry.moduleResolved[binding.module];
                                    if (!resolved) continue;
                                    dottedScope = resolved;
                                }
                            }
                            // Skip object literal key: name followed by ':' (not '::' for Rust paths)
                            const afterChar = pos + nameLen < line.length ? line[pos + nameLen] : '';
                            const afterChar2 = pos + nameLen + 1 < line.length ? line[pos + nameLen + 1] : '';
                            if (afterChar === ':' && afterChar2 !== ':') continue;
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
        for (const symbol of symbols) {
            // Skip non-function/class types (callableTypes defined above)
            if (!callableTypes.includes(symbol.type)) {
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
            if (index.calleeIndex.has(name)) {
                continue;
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
                (!u.dottedScope ||
                    (u.dottedScope === 'same-file'
                        ? u.file === symbol.file
                        : u.dottedScope === symbol.relativePath))
            );

            // For exported symbols in --include-exported mode, also filter out export-site
            // references (e.g., `module.exports = { helperC }` or `export { helperC }`).
            // These are just re-statements of the export, not actual consumption.
            if (isExported && options.includeExported) {
                nonDefUsages = nonDefUsages.filter(u => {
                    if (u.file !== symbol.file) return true; // cross-file usage always counts
                    // Check if same-file usage is on an export line
                    let content;
                    try { content = index._readFile(u.file); } catch { return true; }
                    if (!content) return true;
                    const lines = content.split('\n');
                    const line = lines[u.line - 1] || '';
                    const trimmed = line.trim();
                    // CJS: module.exports = { ... } or exports.name = ...
                    if (trimmed.startsWith('module.exports') || /^exports\.\w+\s*=/.test(trimmed)) return false;
                    // ESM: export { ... } or export default
                    if (/^export\s*\{/.test(trimmed) || /^export\s+default\s/.test(trimmed)) return false;
                    return true;
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
                const isExternalContract = overridesOutOfTreeBase(index, symbol);
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
                    isExported,
                    usageCount: 0,
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
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.startLine - b.startLine;
    });

    // Attach exclusion counts as array properties (backwards-compatible)
    results.excludedDecorated = excludedDecorated;
    results.excludedExported = excludedExported;
    results.excludedExternalContract = excludedExternalContract;

    return results;
    } finally { index._endOp(); }
}

module.exports = { buildUsageIndex, deadcode };
