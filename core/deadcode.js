/**
 * core/deadcode.js - Dead code detection (unused functions/classes)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageModule, safeParse } = require('../languages');
const { isTestFile } = require('./discovery');
const { escapeRegExp } = require('./shared');
const { isFrameworkEntrypoint } = require('./entrypoints');

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
    const potentiallyDeadNames = new Set();
    for (const name of callableNames) {
        if (!index.calleeIndex.has(name)) {
            potentiallyDeadNames.add(name);
        }
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
                const lines = content.split('\n');
                for (const name of potentiallyDeadNames) {
                    if (!content.includes(name)) continue;
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
                            // Skip property/field access: preceded by '.' unless followed by '(' (method call)
                            if (pos > 0 && line[pos - 1] === '.' &&
                                (pos + nameLen >= line.length || line[pos + nameLen] !== '(')) continue;
                            // Skip object literal key: name followed by ':' (not '::' for Rust paths)
                            const afterChar = pos + nameLen < line.length ? line[pos + nameLen] : '';
                            const afterChar2 = pos + nameLen + 1 < line.length ? line[pos + nameLen + 1] : '';
                            if (afterChar === ':' && afterChar2 !== ':') continue;
                            // Valid reference found
                            if (!usageIndex.has(name)) usageIndex.set(name, []);
                            usageIndex.get(name).push({
                                file: filePath,
                                line: i + 1,
                                relativePath: fileEntry.relativePath
                            });
                            break; // one match per line is enough for deadcode
                        }
                    }
                }
            } catch {}
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

            // Language-specific entry points (called by runtime, no AST-visible callers)
            // Go: main() and init() are called by runtime
            const isGoEntryPoint = lang === 'go' && (name === 'main' || name === 'init');

            // Java: public static void main(String[] args) is the entry point
            const isJavaEntryPoint = lang === 'java' && name === 'main' &&
                mods.includes('public') && mods.includes('static');

            // Python: Magic/dunder methods are called by the interpreter, not user code
            // test_* functions/methods are called by pytest/unittest via reflection
            // setUp/tearDown are unittest.TestCase framework methods called by test runner
            // pytest_* are pytest plugin hooks called by the framework
            const isPythonEntryPoint = lang === 'python' &&
                (/^__\w+__$/.test(name) || /^test_/.test(name) ||
                 /^(setUp|tearDown)(Class|Module)?$/.test(name) ||
                 /^pytest_/.test(name));

            // Rust: main() is entry point, #[test] and #[bench] functions are called by test/bench runner
            const isRustEntryPoint = lang === 'rust' &&
                (name === 'main' || mods.includes('test') || mods.includes('bench'));

            // Rust: trait impl methods are invoked via trait dispatch, not direct calls
            // They can never be "dead" - the trait contract requires them to exist
            const isRustTraitImpl = lang === 'rust' && symbol.isMethod &&
                symbol.className && symbol.traitImpl;

            // Go: Test*, Benchmark*, Example* functions are called by go test
            const isGoTestFunc = lang === 'go' &&
                /^(Test|Benchmark|Example)[A-Z]/.test(name);

            // Java: @Test annotated methods are called by JUnit
            const isJavaTestMethod = lang === 'java' && mods.includes('test');

            // Java: @Override methods are invoked via polymorphic dispatch
            // They implement interface/superclass contracts and can't be dead
            const isJavaOverride = lang === 'java' && mods.includes('override');

            // Skip trait impl / @Override methods entirely - they're required by the type system
            if (isRustTraitImpl || isJavaOverride) {
                continue;
            }

            // JavaScript/TypeScript: framework lifecycle methods called by runtime
            // React class components, Web Components, Angular, Vue
            const jsLifecycleMethods = new Set([
                // React class component lifecycle
                'render', 'componentDidMount', 'componentDidUpdate', 'componentWillUnmount',
                'getDerivedStateFromProps', 'getDerivedStateFromError', 'componentDidCatch',
                'getSnapshotBeforeUpdate', 'shouldComponentUpdate',
                // Web Components lifecycle
                'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback', 'adoptedCallback'
            ]);
            const isJsEntryPoint = (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') &&
                symbol.isMethod && jsLifecycleMethods.has(name);

            const isEntryPoint = isGoEntryPoint || isGoTestFunc ||
                isJavaEntryPoint || isJavaTestMethod ||
                isPythonEntryPoint || isRustEntryPoint || isJsEntryPoint;

            // Entry points are always excluded — they're invoked by the runtime, not user code
            if (isEntryPoint) {
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

            const isExported = fileEntry && (
                fileEntry.exports.includes(name) ||
                mods.includes('export') ||
                mods.includes('public') ||
                (lang === 'go' && /^[A-Z]/.test(name))
            );

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
            let nonDefUsages = allUsages.filter(u =>
                !(u.file === symbol.file && (u.line === symbol.startLine || u.line === symbol.nameLine))
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
                // Collect decorators/annotations for hint display
                // Python: symbol.decorators (e.g., ['app.route("/path")', 'login_required'])
                // Java/Rust/Go: symbol.modifiers may contain annotations (e.g., 'bean', 'scheduled')
                const decorators = symbol.decorators || [];
                // For Java, extract annotation-like modifiers
                const javaKw = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default']);
                const annotations = lang === 'java'
                    ? mods.filter(m => !javaKw.has(m))
                    : [];

                results.push({
                    name: symbol.name,
                    type: symbol.type,
                    file: symbol.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    isExported,
                    usageCount: 0,
                    ...(decorators.length > 0 && { decorators }),
                    ...(annotations.length > 0 && { annotations })
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

    return results;
    } finally { index._endOp(); }
}

module.exports = { buildUsageIndex, deadcode };
