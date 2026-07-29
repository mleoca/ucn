'use strict';

/**
 * Human- and agent-facing command contracts.
 *
 * Registry.js owns command/parameter spelling. trust-matrix.js owns the proof
 * and decision-safety classification. This module owns the question each
 * command answers, its explicit modes, boundaries, defaults, and workflow
 * guidance. CLI help, MCP discovery, tracked docs, and contract tests consume
 * these records so the public surface stays honest across every adapter.
 */

const { CANONICAL_COMMANDS, FLAG_APPLICABILITY, toCliName } = require('./registry');
const { COMMAND_TRUST_MATRIX } = require('./trust-matrix');

function contract(spec) {
    return Object.freeze({
        ...spec,
        primaryQuestion: spec.primaryQuestion || spec.question,
        modes: Object.freeze(spec.modes || []),
        defaults: Object.freeze(spec.defaults || []),
        nonGoals: Object.freeze(spec.nonGoals || []),
        invalidCombinations: Object.freeze(spec.invalidCombinations || []),
        examples: Object.freeze(spec.examples || []),
        next: Object.freeze(spec.next || []),
    });
}

const COMMAND_CONTRACTS = Object.freeze({
    show: contract({
        question: 'What must I know about this exact symbol?',
        purpose: 'Return a compact symbol briefing with selectable evidence projections.',
        target: 'Required symbol name or stable `file:line:name` handle.',
        modes: [
            { name: 'projection', when: '`sections` selects summary, callers, callees, source, dependencies, tests, types, example, or related.', answer: 'Only the requested sections are rendered; caller-bearing sections retain accounting metadata.' },
        ],
        defaults: ['`sections=summary,callers,callees`', 'Compact relationship formatting.'],
        truth: 'The definition is index-backed. Caller/callee relationships are tiered by target-identity evidence and conserve the observed literal-name account where provided.',
        nonGoals: ['Runtime behavior or framework reflection.', 'Semantic completeness beyond indexed/static evidence.'],
        invalidCombinations: ['A missing symbol target is rejected.', 'Unknown section names are rejected.'],
        examples: ['ucn show src/parser.ts:42:parseRequest', 'ucn show parseRequest --sections=summary,source,tests'],
        jsonData: '`data.summary` plus the requested projection fields; relationships include evidence/account metadata.',
        output: 'Targeted output; use `sections` before increasing output limits.',
        next: ['`impact <handle>` before a change.', '`source <handle>` for exact code.', '`tests <handle> --depth=3` for test planning.'],
        benchmark: 'A03',
    }),
    find: contract({
        question: 'Which indexed definition or type does this name identify?',
        purpose: 'Locate definitions, disambiguate duplicates, and produce reusable symbol identity.',
        target: 'Required name; filters may narrow by file, class, directory, or kind.',
        modes: [
            { name: 'definition', when: 'Default or `type` is a symbol kind such as function/class.', answer: 'Matching indexed definitions with location and signature metadata.' },
            { name: 'type lookup', when: '`type=type`.', answer: 'Type-definition records rather than general name matches.' },
        ],
        defaults: ['Substring matching unless `exact=true`.', 'Tests excluded unless `includeTests=true`.', '`limit` is the single result cap; `withSource=true` attaches exact bodies.'],
        truth: 'Results are exact records from the static symbol index; usage counts are static indexed occurrences.',
        nonGoals: ['Text search inside comments or configuration.', 'Compiler overload resolution across external dependencies.'],
        invalidCombinations: ['A missing name is rejected.'],
        examples: ['ucn find parseRequest --exact --limit=20', 'ucn find Result --type=type --with-source'],
        jsonData: 'Array of symbol or type records with stable file/line identity.',
        output: 'Symbol query; narrow by `file`, `in`, `className`, or `type` when ambiguous.',
        next: ['Pass the resulting handle to `show`, `impact`, or `source`.'],
        benchmark: 'A02',
    }),
    usages: contract({
        question: 'Where does this literal name occur in indexed code, and what kind of use is each site?',
        purpose: 'Inventory definitions, imports, calls, references, and literal comment/string/docstring text without pretending every occurrence binds to one target.',
        target: 'Required literal symbol name.',
        modes: [
            { name: 'inventory', when: 'Always.', answer: 'Occurrence records classified by usage kind.' },
        ],
        defaults: ['Tests excluded unless `includeTests=true`.', 'Comments/strings included unless `codeOnly=true`.'],
        truth: 'The command reports the indexed literal-name occurrence universe, not exact semantic references to one definition. Classification is by syntax alone; show/impact ACCOUNT lines are engine-adjudicated, so the two breakdowns can legitimately differ (a method reference is a `reference` here but may be a confirmed caller there).',
        nonGoals: ['Alias-only references whose source line does not contain the queried name.', 'Safe-delete proof.'],
        invalidCombinations: ['A missing name is rejected.'],
        examples: ['ucn usages parseRequest --include-tests', 'ucn usages parseRequest --code-only --file=src'],
        jsonData: 'Definition/reference records plus separately classified text occurrences, each with file, line, and content.',
        output: 'Broad output; narrow with `file`, `in`, `exclude`, or `limit`.',
        next: ['Use `find` plus `impact` when target identity matters.', 'Use `search` for arbitrary text.'],
        benchmark: 'A04',
    }),
    search: contract({
        question: 'Where does text or an AST-indexed shape match?',
        purpose: 'Search literal/regex text or filter indexed structural records.',
        target: 'Text mode accepts a term; structural mode is selected by structural filters.',
        modes: [
            { name: 'text', when: 'A term is supplied without structural filters.', answer: 'File/line text matches, optionally excluding comments and strings.' },
            { name: 'structural', when: '`type`, `param`, `receiver`, `returns`, `decorator`, `exported`, or `unused` is supplied.', answer: 'AST/index records matching the requested shape.' },
        ],
        defaults: ['Text term is literal unless `regex=true`.', 'Case-insensitive unless `caseSensitive=true`.'],
        truth: 'Text mode is text-ground exact for the configured regex/literal semantics; structural mode is an index-shape query, not compiler binding.',
        nonGoals: ['Exact target references.', 'Data flow or arbitrary semantic predicates.'],
        invalidCombinations: ['A request with neither a term nor structural filters is rejected.', '`receiver` requires a call-oriented structural query.'],
        examples: ['ucn search "$scope.$apply" --code-only', 'ucn search "TODO|FIXME" --regex', 'ucn search --type=call --receiver=db'],
        jsonData: 'Text mode returns files with line matches; structural mode returns indexed match records and mode metadata.',
        output: 'Project scan; narrow with `file`, `in`, `exclude`, `type`, or `limit`.',
        next: [
            'Use `find` to pin a matched definition.',
            'Use `source` to inspect a selected result.',
            'Use grep/ripgrep for simple literals, messages, configuration, filenames, Markdown, or unsupported languages.',
        ],
        benchmark: 'A05',
    }),
    source: contract({
        question: 'What is the exact indexed source for this symbol or line range?',
        purpose: 'Extract a function, class-like declaration, or literal file range without reading the whole file.',
        target: 'Required symbol/handle, `file:range`, or `file` plus `range`.',
        modes: [
            { name: 'symbol', when: 'A name or stable handle is supplied.', answer: 'Exact declaration source with resolved symbol identity.' },
            { name: 'range', when: 'A file and line/range are supplied.', answer: 'Exact requested file lines.' },
        ],
        defaults: ['Large declarations respect the `maxLines` safety limit.'],
        truth: 'Returned code is sliced from the validated indexed project file and reports its extraction mode.',
        nonGoals: ['Source-map reconstruction.', 'Generated or dependency source outside the project root.'],
        invalidCombinations: ['A line range without a file is rejected.', 'A symbol target and range cannot be combined.', 'Paths outside the project root are rejected.'],
        examples: ['ucn source src/parser.ts:42:parseRequest', 'ucn source src/parser.ts:40-80'],
        jsonData: 'Symbol mode returns resolved entries and code; range mode returns numbered lines.',
        output: 'Targeted extraction; use `maxLines` for large class-like declarations.',
        next: ['Use `show` for relationships.', 'Use `impact` before editing the extracted symbol.'],
        benchmark: 'A06',
    }),
    trace: contract({
        question: 'What static call path goes down, up, or toward an entry point?',
        purpose: 'Traverse tiered call relationships while preserving uncertainty at each expansion.',
        target: 'Required symbol name or stable handle.',
        modes: [
            { name: 'callees', when: '`direction=callees` (default).', answer: 'Downstream call tree.' },
            { name: 'callers', when: '`direction=callers`.', answer: 'Upstream caller tree.' },
            { name: 'entrypoint paths', when: '`direction=callers` and `to=entrypoints`.', answer: 'Caller paths toward detected static roots.' },
        ],
        defaults: ['Depth is bounded.', 'Unverified branches are shown but not recursively expanded unless `expandUnverified=true`.'],
        truth: 'Each visible edge carries static evidence; tree-account metadata reconciles indexed call sites where available.',
        nonGoals: ['A complete runtime call graph.', 'Dynamic/reflection edges not represented in the index.'],
        invalidCombinations: ['`to=entrypoints` requires caller direction.', 'A missing symbol is rejected.'],
        examples: ['ucn trace parseRequest --direction=callees --depth=3', 'ucn trace parseRequest --direction=callers --to=entrypoints'],
        jsonData: 'Root identity, direction/depth metadata, and a nested evidence-bearing tree.',
        output: 'Targeted graph output; control breadth with `depth` and `expandUnverified`.',
        next: ['Use `impact` for editable call sites.', 'Use `tests` to find test paths.'],
        benchmark: 'A07',
    }),
    impact: contract({
        question: 'What indexed code may be affected by changing this symbol or Git diff?',
        purpose: 'List direct symbol call sites or compose repository impact from changed lines.',
        target: 'Optional symbol/handle. Omitting it selects Git-diff mode.',
        modes: [
            { name: 'symbol', when: 'A symbol target is supplied.', answer: 'Tiered direct call sites grouped by file with patterns/accounting.' },
            { name: 'diff', when: 'No symbol is supplied; `base` or `staged` selects the diff.', answer: 'Changed definitions and their composed impact.' },
        ],
        defaults: ['Symbol output is compact.', 'Diff base defaults to the repository default used by the Git analysis layer.'],
        truth: 'Symbol impact is static tiered caller evidence; diff impact composes indexed changed definitions and does not imply runtime reachability completeness.',
        nonGoals: ['Automatic edits.', 'Behavioral equivalence or deployment impact.'],
        invalidCombinations: [
            'A named symbol cannot also select staged/diff scope.',
            '`base` and `staged` cannot both select the diff.',
        ],
        examples: ['ucn impact src/parser.ts:42:parseRequest', 'ucn impact --staged'],
        jsonData: 'Symbol mode returns call sites/accounting; diff mode returns changed functions and aggregate impact.',
        output: 'Potentially broad; narrow symbol mode by file/exclude and diff mode by a focused base.',
        next: ['Use `plan` for a concrete refactor preview.', 'Use `tests` for affected tests.', 'Use `check` after editing.'],
        benchmark: 'A08',
    }),
    tests: contract({
        question: 'Which indexed tests directly or transitively exercise this target?',
        purpose: 'Select test evidence for a symbol and show whether it is direct or reached through callers.',
        target: 'Required symbol name or stable handle.',
        modes: [
            { name: 'direct', when: 'Depth is omitted or zero.', answer: 'Test files containing direct imports, calls, or matching test references.' },
            { name: 'affected', when: '`depth>0`.', answer: 'Tests reached through the caller graph up to the requested depth.' },
        ],
        defaults: ['Direct mode by default.'],
        truth: 'Selections are static code/reference or caller-path evidence; absence is not proof that no runtime test covers the symbol.',
        nonGoals: ['Runtime coverage percentages.', 'Executing the tests.'],
        invalidCombinations: ['A missing symbol is rejected.', 'Depth must be a non-negative integer.', '`callsOnly` applies only to direct mode.'],
        examples: ['ucn tests parseRequest', 'ucn tests parseRequest --depth=3'],
        jsonData: 'Direct mode returns test files and matches; affected mode returns root/path and tiered test results.',
        output: 'Broad command; control traversal with `depth`, `file`, and `exclude`.',
        next: ['Run the selected tests with the project test runner.', 'Use `trace --direction=callers` to inspect paths without static test links.'],
        benchmark: 'A09',
    }),
    check: contract({
        question: 'What indexed inconsistency should be fixed before I commit?',
        purpose: 'Validate a symbol signature against call sites or compose checks over a Git diff.',
        target: 'Optional symbol/handle. Omitting it selects diff/precommit mode.',
        modes: [
            { name: 'symbol', when: 'A symbol target is supplied.', answer: 'Argument-count compatibility, uncertain sites, and the caller account.' },
            { name: 'diff', when: 'No target is supplied; `base` or `staged` selects changes.', answer: 'Composed diff impact, signature checks, and affected tests.' },
        ],
        defaults: ['Symbol mode checks static arity, not compiler type compatibility.'],
        truth: 'Findings are static diagnostics with explicit uncertainty; a clean result is not a compiler/test pass.',
        nonGoals: ['Full type checking.', 'Linting or executing project tests.'],
        invalidCombinations: [
            'A named symbol cannot also select staged/diff scope.',
            '`base` and `staged` cannot both select the diff.',
        ],
        examples: ['ucn check publishOrderCreated', 'ucn check --staged'],
        jsonData: 'Symbol mode returns signature, valid/mismatched/uncertain sites and accounting; diff mode returns composed diagnostics.',
        output: 'Broad diagnostic; scope to a symbol or focused Git diff.',
        next: ['Run the language compiler/type checker and selected tests.', 'Use `plan` before a signature refactor.'],
        benchmark: 'A10',
    }),
    plan: contract({
        question: 'What exact indexed edits would this proposed refactor require?',
        purpose: 'Preview rename or parameter-shape edits without mutating files.',
        target: 'Required symbol name or stable handle plus one refactor operation.',
        modes: [
            { name: 'rename', when: '`renameTo` is supplied.', answer: 'Selected declaration plus indexed call/import/export edit previews.' },
            { name: 'add parameter', when: '`addParam` is supplied.', answer: 'Selected declaration and call-site preview, optionally with a default.' },
            { name: 'remove parameter', when: '`removeParam` is supplied.', answer: 'Selected declaration and affected call-site preview.' },
        ],
        defaults: ['Preview only; no file writes.'],
        truth: 'Changes are derived from indexed definitions/usages, include the selected declaration, and retain unverified/blocked or needs-review evidence separately.',
        nonGoals: ['Applying edits.', 'Guaranteeing the preview compiles.'],
        invalidCombinations: ['Exactly one of rename, add-parameter, or remove-parameter is required.', '`defaultValue` only applies to add-parameter.'],
        examples: ['ucn plan parseRequest --rename-to=parseIncoming', 'ucn plan parseRequest --add-param=context --default-value=null'],
        jsonData: 'Before/after signatures, concrete declaration/call/import/export previews, changeSummary, needsReview markers, unverified sites, and account metadata.',
        output: 'Targeted refactor preview; inspect every unverified or warning entry.',
        next: ['Use `impact` before editing.', 'Use `check` and the compiler after applying the change manually.'],
        benchmark: 'A11',
    }),
    repo: contract({
        question: 'What is this repository, and is UCN ready for my task?',
        purpose: 'Compose repository orientation, file inventory, statistics, and health/readiness.',
        target: 'Project directory; optional file/directory filters narrow the index view.',
        modes: [
            { name: 'summary', when: 'Default or `sections` includes summary.', answer: 'Languages, files, symbols, hot code, entry points, and trust headline.' },
            { name: 'files', when: '`sections` includes files.', answer: 'Table of contents.' },
            { name: 'stats', when: '`sections` includes stats.', answer: 'Repository and optional function/hot statistics.' },
            { name: 'health', when: '`sections` includes health or `deep=true`.', answer: 'Index blind spots, cache state, command proof classification, and readiness dimensions.' },
        ],
        defaults: ['Compact summary.', '`deep=false`, so evidence readiness remains unknown until sampled.'],
        truth: 'Counts and health are static index diagnostics. Trust level is task readiness, not measured accuracy.',
        nonGoals: ['A compiler build.', 'A universal repository quality score.'],
        invalidCombinations: ['Unknown section names are rejected.'],
        examples: ['ucn repo', 'ucn repo --sections=summary,health --deep'],
        jsonData: 'Selected summary/files/stats/health projections under one envelope.',
        output: 'Broad output; use `sections`, `in`, and `limit` before increasing caps.',
        next: ['Use the suggested `find`/`show` target.', 'Resolve health warnings before a risky change.'],
        benchmark: 'A01',
    }),
    deps: contract({
        question: 'What does this file import, what imports it, or which static cycles exist?',
        purpose: 'Inspect the static project dependency graph.',
        target: 'File target for graph modes; cycles mode can scan the project.',
        modes: [
            { name: 'imports', when: '`direction=imports`.', answer: 'Downstream imported files.' },
            { name: 'importers', when: '`direction=importers`.', answer: 'Upstream importing files.' },
            { name: 'both', when: '`direction=both`.', answer: 'Both graph directions.' },
            { name: 'cycles', when: '`cycles=true`.', answer: 'Detected static circular dependencies.' },
        ],
        defaults: ['Direction defaults to both.', 'Traversal depth is bounded.'],
        truth: 'Edges are resolved static import/include relationships inside the indexed project.',
        nonGoals: ['Dynamic imports that cannot be resolved statically.', 'Package-manager or runtime dependency graphs.'],
        invalidCombinations: ['A file is required outside cycles mode.', 'Cycle mode does not combine with a file-direction question.'],
        examples: ['ucn deps src/server.ts --direction=both --depth=2', 'ucn deps --cycles'],
        jsonData: 'Graph mode returns nodes/edges by direction; cycles mode returns cycle records.',
        output: 'Broad graph output; use `depth=1`, one direction, or a file target.',
        next: ['Use `api` on a dependency boundary.', 'Use `show` on a symbol crossing the edge.'],
        benchmark: 'A12',
    }),
    api: contract({
        question: 'What static public surface does this project or file export?',
        purpose: 'List indexed exports with signatures.',
        target: 'Optional file target; omission scans the project.',
        modes: [
            { name: 'file', when: 'A file is supplied.', answer: 'Exports from that file.' },
            { name: 'project', when: 'No file is supplied.', answer: 'Indexed project exports up to the result limit.' },
        ],
        defaults: ['Static exports only.'],
        truth: 'The result is the index-visible export/public declaration universe.',
        nonGoals: ['External consumer inventory.', 'Runtime exports or reflection.'],
        invalidCombinations: [],
        examples: ['ucn api src/payments/stripe.ts', 'ucn api --limit=200'],
        jsonData: 'Array of exported symbol records with signatures and source identity.',
        output: 'Project mode can be broad; narrow by file or limit.',
        next: ['Use `usages` and `impact` before changing a public symbol.'],
        benchmark: 'A13',
    }),
    entrypoints: contract({
        question: 'Which static roots can invoke indexed project code?',
        purpose: 'Detect framework registrations, tests, mains, and other static entry-point patterns.',
        target: 'Project scope with optional file, framework, or type filters.',
        modes: [
            { name: 'inventory', when: 'Always; filters select a subset.', answer: 'Detected roots with framework, pattern, registration site, and evidence.' },
        ],
        defaults: ['Includes supported framework and runtime patterns.'],
        truth: 'Positive findings match declared static framework/name/file patterns and are advisory.',
        nonGoals: ['All runtime registration/reflection roots.', 'Proof that an unlisted function is unreachable.'],
        invalidCombinations: ['Unsupported `type` or `framework` filters are rejected or return an explicit empty filtered inventory.'],
        examples: ['ucn entrypoints', 'ucn entrypoints --type=http --framework=express'],
        jsonData: 'Array of entry-point records with pattern/framework evidence and registration location.',
        output: 'Broad inventory; narrow by file, type, framework, or exclude.',
        next: ['Use `trace --direction=callers --to=entrypoints` for a target path.', 'Use `endpoints` for HTTP boundaries.'],
        benchmark: 'A14',
    }),
    endpoints: contract({
        question: 'Which supported HTTP server/client boundaries exist, and which ones match?',
        purpose: 'Extract framework-specific routes and client requests and optionally bridge them.',
        target: 'Project scope with optional file/framework/path/method filters.',
        modes: [
            { name: 'inventory', when: 'Default.', answer: 'Server routes and client requests.' },
            { name: 'bridge', when: '`bridge=true`.', answer: 'Exact/parameterized route-request matches plus unmatched sides.' },
            { name: 'unmatched', when: '`unmatched=true`.', answer: 'Only unmatched supported boundaries.' },
        ],
        defaults: ['Framework-specific static extraction.', 'Interpolated-path uncertainty remains visible unless hidden explicitly.'],
        truth: 'Findings are static matches for supported framework call/decorator shapes; bridge confidence is match quality, not runtime probability.',
        nonGoals: ['Network discovery.', 'Frameworks not represented by an endpoint adapter.'],
        invalidCombinations: ['`serverOnly` and `clientOnly` cannot both describe a useful result.'],
        examples: ['ucn endpoints', 'ucn endpoints --bridge --prefix=/api'],
        jsonData: 'Routes, requests, bridges, unmatched records, and aggregate framework metadata.',
        output: 'Broad inventory; narrow by method, prefix, framework, file, or one side.',
        next: ['Use `show` on a handler/caller.', 'Use `entrypoints` for non-HTTP roots.'],
        benchmark: 'A15',
    }),
    deadcode: contract({
        question: 'Which indexed symbols are conservative cleanup candidates?',
        purpose: 'Find symbols with no modeled usage while protecting common entry/public/decorated shapes by default.',
        target: 'Project scope with optional file/directory and exclusion filters.',
        modes: [
            { name: 'candidates', when: 'Always; include flags can reveal protected categories.', answer: 'Static zero-usage candidates and usage count.' },
        ],
        defaults: ['Exported and decorated symbols excluded.', 'Tests excluded unless requested.'],
        truth: 'A result means no modeled usage survived the command policy; known computed-dispatch registry members are withheld, and the result is explicitly not safe-delete proof.',
        nonGoals: ['External consumers, reflection, generated registration, unresolved computed dispatch, or runtime reachability proof.'],
        invalidCombinations: [],
        examples: ['ucn deadcode --exclude=test', 'ucn deadcode --include-exported --limit=100'],
        jsonData: 'Candidate records plus computed-dispatch/deletion-safety metadata and any registry members withheld from candidates.',
        output: 'Broad candidate list; narrow by file/in/exclude/limit.',
        next: ['Review `usages`, `impact`, `entrypoints`, and `api`, then run compiler/tests before deletion.'],
        benchmark: 'A16',
    }),
    auditAsync: contract({
        question: 'Which supported async call sites deserve missing-await review?',
        purpose: 'Find calls to indexed async functions whose syntax does not await/return/otherwise consume the promise.',
        target: 'Project scope with optional file and exclusion filters.',
        modes: [
            { name: 'missing-await candidates', when: 'Always.', answer: 'Caller/callee locations for supported async syntax.' },
        ],
        defaults: ['Advisory findings only.'],
        truth: 'Positive findings are static syntax/index candidates for supported languages; framework promise handling can make them benign.',
        nonGoals: ['Complete async correctness.', 'Languages or call shapes without implemented async analysis.'],
        invalidCombinations: [],
        examples: ['ucn audit-async', 'ucn audit-async --file=src/api'],
        jsonData: 'Issue array plus total issue and affected-file counts.',
        output: 'Broad audit; narrow by file, exclude, or limit.',
        next: ['Use `show`/`source` on the caller and callee.', 'Run the language compiler/linter.'],
        benchmark: 'A17',
    }),
    stacktrace: contract({
        question: 'Which indexed source locations best match these runtime frames?',
        purpose: 'Parse supported stack formats and enrich frames with source context and enclosing symbols.',
        target: 'Required stack trace text.',
        modes: [
            { name: 'frame resolution', when: 'Always.', answer: 'Resolved and unresolved frames in input order.' },
        ],
        defaults: ['Best-effort path/function matching.', 'Context lines are included for resolved frames.'],
        truth: 'Found frames are matched to current indexed source; unresolved frames remain visible and confidence is advisory match quality.',
        nonGoals: ['Source-map loading.', 'Guaranteeing source matches the deployed artifact.'],
        invalidCombinations: ['Empty stack text is rejected.'],
        examples: ['ucn stacktrace "at handle (src/server.ts:42:7)"'],
        jsonData: 'Advisory marker, frame count, and ordered frame records with resolution/context.',
        output: 'Targeted runtime evidence; large multi-frame traces remain bounded by transport limits.',
        next: ['Use `show` on the resolved function.', 'Use `tests` and `impact` when fixing the failure.'],
        benchmark: 'A18',
    }),
});

function validateCommandContracts() {
    const failures = [];
    const contractNames = Object.keys(COMMAND_CONTRACTS);
    for (const command of CANONICAL_COMMANDS) {
        const spec = COMMAND_CONTRACTS[command];
        if (!spec) {
            failures.push(`${command}: missing contract`);
            continue;
        }
        for (const field of ['question', 'purpose', 'target', 'truth', 'jsonData',
            'output', 'benchmark']) {
            if (typeof spec[field] !== 'string' || !spec[field].trim()) {
                failures.push(`${command}: missing ${field}`);
            }
        }
        for (const field of ['modes', 'defaults', 'nonGoals', 'invalidCombinations',
            'examples', 'next']) {
            if (!Array.isArray(spec[field])) failures.push(`${command}: ${field} must be an array`);
        }
        if (!spec.modes.length) failures.push(`${command}: requires an explicit mode`);
        if (!spec.examples.length) failures.push(`${command}: requires an example`);
        for (const example of spec.examples) {
            if (!example.startsWith(`ucn ${toCliName(command)}`)) {
                failures.push(`${command}: example does not use its CLI command: ${example}`);
            }
        }
        if (!COMMAND_TRUST_MATRIX[command]) failures.push(`${command}: missing trust row`);
        if (!FLAG_APPLICABILITY[command]) failures.push(`${command}: missing flag applicability`);
    }
    for (const extra of contractNames.filter(name => !CANONICAL_COMMANDS.includes(name))) {
        failures.push(`${extra}: contract is not a public command`);
    }
    return failures;
}

module.exports = { COMMAND_CONTRACTS, validateCommandContracts };
