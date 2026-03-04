/**
 * core/deadcode.js - Dead code detection (unused functions/classes)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageModule, safeParse } = require('../languages');
const { isTestFile } = require('./discovery');

/**
 * Build a usage index for all identifiers in the codebase (optimized for deadcode)
 * Scans all files ONCE and builds a reverse index: name -> [usages]
 * @param {object} index - ProjectIndex instance
 * @returns {Map<string, Array>} Usage index
 */
function buildUsageIndex(index) {
    const usageIndex = new Map(); // name -> [{file, line}]

    for (const [filePath, fileEntry] of index.files) {
        try {
            const language = detectLanguage(filePath);
            if (!language) continue;

            const content = index._readFile(filePath);

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
                                // This is the property part — skip it for deadcode counting
                                for (let i = 0; i < node.childCount; i++) {
                                    traverse(node.child(i));
                                }
                                return;
                            }
                        }
                    }
                    const name = node.text;
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

    // Build usage index once (instead of per-symbol)
    const usageIndex = buildUsageIndex(index);

    for (const [name, symbols] of index.symbols) {
        for (const symbol of symbols) {
            // Skip non-function/class types
            // Include various method types from different languages:
            // - function: standalone functions
            // - class, struct, interface: type definitions (skip them in deadcode)
            // - method: class methods
            // - static, public, abstract: Java method modifiers used as types
            // - constructor: constructors
            const callableTypes = ['function', 'method', 'static', 'public', 'abstract', 'constructor'];
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
            // className for trait impls contains " for " (e.g., "PartialEq for Glob")
            const isRustTraitImpl = lang === 'rust' && symbol.isMethod &&
                symbol.className && symbol.className.includes(' for ');

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

            // Framework registration decorators — excluded by default to reduce noise
            // Python: decorators with '.' (attribute access) like @router.get, @app.route, @celery.task
            // Java: non-standard annotations like @Bean, @Scheduled, @GetMapping
            // These functions are invoked by frameworks, not by user code — AST can't see the call path
            const javaKeywords = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default']);
            const hasRegistrationDecorator = (() => {
                if (lang === 'python') {
                    const decorators = symbol.decorators || [];
                    return decorators.some(d => d.includes('.'));
                }
                if (lang === 'java') {
                    return mods.some(m => !javaKeywords.has(m));
                }
                return false;
            })();

            if (hasRegistrationDecorator && !options.includeDecorated) {
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

            // Use pre-built index for O(1) lookup instead of O(files) scan
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
                // For Java, extract annotation-like modifiers (javaKeywords defined above)
                const annotations = lang === 'java'
                    ? mods.filter(m => !javaKeywords.has(m))
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
