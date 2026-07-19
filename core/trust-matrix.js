'use strict';

/**
 * Command trust matrix — executable inventory of what proves each command.
 *
 * This is intentionally not a table of accuracy percentages.  It records the
 * independent evidence or invariant that is capable of falsifying each
 * command's documented claim.  test/trust-matrix.test.js fails closed when a
 * canonical command is added without an entry or when a referenced proof
 * artifact disappears.
 */

const PROOF_CATALOG = Object.freeze({
    'oracle-callers': {
        kind: 'external-oracle',
        artifact: 'eval/run-oracle-eval.js',
        claim: 'Compiler/LSP references score confirmed/unverified caller edges and semantic recall.',
    },
    'oracle-callees': {
        kind: 'external-oracle',
        artifact: 'eval/run-oracle-eval.js',
        claim: 'The same compiler/LSP edges are re-read from caller scope to score callee answers.',
    },
    'oracle-symbols': {
        kind: 'external-oracle',
        artifact: 'eval/run-oracle-eval.js',
        claim: 'Compiler/LSP symbols gate definition discovery, pinning, and extraction.',
    },
    'oracle-references': {
        kind: 'external-oracle',
        artifact: 'eval/run-oracle-eval.js',
        claim: 'Compiler/LSP code references gate usages, direct tests, and confirmed examples.',
    },
    'oracle-deadcode': {
        kind: 'external-oracle',
        artifact: 'eval/run-deadcode-eval.js',
        claim: 'Every sampled dead-code claim is challenged with compiler/LSP references.',
    },
    conservation: {
        kind: 'accounting-invariant',
        artifact: 'test/conservation.test.js',
        claim: 'Observed text occurrences partition without unexplained loss.',
    },
    'cross-language-fixtures': {
        kind: 'independent-fixture',
        artifact: 'test/cross-language.test.js',
        claim: 'Equivalent language fixtures assert the command contract across supported parsers.',
    },
    'command-fixtures': {
        kind: 'independent-fixture',
        artifact: 'test/command-coverage.test.js',
        claim: 'Behavioral fixtures assert output semantics and negative cases.',
    },
    'graph-invariants': {
        kind: 'algebraic-invariant',
        artifact: 'test/command-coverage.test.js',
        claim: 'Dependency duality, traversal depth, cycle, and export invariants are checked.',
    },
    'surface-parity': {
        kind: 'architecture-invariant',
        artifact: 'test/parity-test.js',
        claim: 'CLI, MCP, and interactive surfaces dispatch the same canonical handler.',
    },
    'systematic-options': {
        kind: 'combinatorial-invariant',
        artifact: 'test/systematic-test.js',
        claim: 'Supported command/flag combinations execute with stable envelopes.',
    },
    'git-fixtures': {
        kind: 'integration-fixture',
        artifact: 'test/command-coverage.test.js',
        claim: 'Temporary Git histories assert diff attribution and composed checks.',
    },
    'framework-fixtures': {
        kind: 'adversarial-fixture',
        artifact: 'test/feature.test.js',
        claim: 'Positive and confusable framework shapes test advisory detection.',
    },
    'protocol-fixtures': {
        kind: 'protocol-invariant',
        artifact: 'test/regression-mcp.test.js',
        claim: 'Stateful expansion and MCP envelopes are checked end-to-end.',
    },
    'performance-budget': {
        kind: 'performance-gate',
        artifact: 'eval/run-performance-gate.js',
        claim: 'Cold indexing, warm cache, semantic-query p95, and memory stay within budgets.',
    },
});

function row(claim, proofs, performanceClass, decisionSafety, oracleReason = null) {
    return Object.freeze({ claim, proofs: Object.freeze(proofs), performanceClass, decisionSafety, oracleReason });
}

const COMMAND_TRUST_MATRIX = Object.freeze({
    about: row('tiered-semantic', ['oracle-callers', 'oracle-callees', 'conservation', 'surface-parity'], 'semantic-query', 'review-required'),
    context: row('tiered-semantic', ['oracle-callers', 'oracle-callees', 'conservation', 'surface-parity'], 'semantic-query', 'review-required'),
    impact: row('tiered-semantic', ['oracle-callers', 'conservation', 'surface-parity'], 'semantic-query', 'review-required'),
    blast: row('tiered-derived', ['oracle-callers', 'conservation', 'command-fixtures', 'surface-parity'], 'graph-query', 'review-required'),
    smart: row('tiered-derived', ['oracle-callees', 'oracle-symbols', 'command-fixtures', 'surface-parity'], 'semantic-query', 'review-required'),
    trace: row('tiered-derived', ['oracle-callees', 'conservation', 'command-fixtures', 'surface-parity'], 'graph-query', 'review-required'),
    reverseTrace: row('tiered-derived', ['oracle-callers', 'conservation', 'command-fixtures', 'surface-parity'], 'graph-query', 'review-required'),
    example: row('confirmed-or-abstain-advisory', ['oracle-references', 'command-fixtures', 'surface-parity'], 'semantic-query', 'advisory-only'),
    related: row('advisory-ranking', ['oracle-callers', 'oracle-callees', 'command-fixtures', 'surface-parity'], 'semantic-query', 'advisory-only'),
    brief: row('ast-fact-summary', ['oracle-symbols', 'command-fixtures', 'surface-parity'], 'source-query', 'navigation'),

    find: row('exact-indexed-definition', ['oracle-symbols', 'cross-language-fixtures', 'surface-parity'], 'symbol-query', 'navigation'),
    usages: row('literal-code-reference-inventory', ['oracle-references', 'cross-language-fixtures', 'surface-parity'], 'project-scan', 'review-required'),
    toc: row('indexed-symbol-accounting', ['cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'project-scan', 'navigation', 'No compiler exposes a portable table-of-contents contract; symbol totals and filters use fixture/accounting invariants.'),
    search: row('literal-or-structural-match', ['cross-language-fixtures', 'command-fixtures', 'systematic-options', 'surface-parity'], 'project-scan', 'navigation', 'Literal results are text-ground exact; structural filters are AST fixture-checked rather than semantic identity claims.'),
    tests: row('tiered-direct-test-evidence', ['oracle-references', 'cross-language-fixtures', 'surface-parity'], 'semantic-query', 'review-required'),
    affectedTests: row('tiered-transitive-test-evidence', ['oracle-callers', 'oracle-references', 'conservation', 'command-fixtures', 'surface-parity'], 'graph-query', 'review-required'),
    deadcode: row('candidate-not-safe-delete', ['oracle-deadcode', 'cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'project-scan', 'advisory-only'),
    entrypoints: row('framework-advisory', ['framework-fixtures', 'cross-language-fixtures', 'surface-parity'], 'project-scan', 'advisory-only', 'Framework registration/reflection has no universal compiler oracle; positive and confusable framework fixtures define the static claim.'),
    endpoints: row('framework-advisory', ['framework-fixtures', 'cross-language-fixtures', 'surface-parity'], 'project-scan', 'advisory-only', 'Route/client matching is framework-specific and explicitly advisory.'),

    fn: row('exact-source-extraction', ['oracle-symbols', 'cross-language-fixtures', 'surface-parity'], 'source-query', 'navigation'),
    class: row('exact-source-extraction', ['oracle-symbols', 'cross-language-fixtures', 'surface-parity'], 'source-query', 'navigation'),
    lines: row('exact-file-slice', ['command-fixtures', 'systematic-options', 'surface-parity'], 'source-query', 'navigation', 'The file bytes and validated line bounds are the direct oracle.'),
    expand: row('stateful-protocol', ['protocol-fixtures', 'surface-parity'], 'source-query', 'navigation', 'Expansion is a cache/protocol contract, not a semantic-analysis claim.'),

    imports: row('static-import-inventory', ['graph-invariants', 'cross-language-fixtures', 'surface-parity'], 'graph-query', 'navigation', 'File import syntax/resolution is checked with language fixtures and graph duality; dynamic imports remain explicit blind spots.'),
    exporters: row('reverse-static-import-inventory', ['graph-invariants', 'cross-language-fixtures', 'surface-parity'], 'graph-query', 'navigation', 'Reverse edges are proven by import/export graph duality.'),
    fileExports: row('static-export-inventory', ['graph-invariants', 'cross-language-fixtures', 'surface-parity'], 'graph-query', 'navigation', 'Static visibility/export shapes use language fixtures; runtime mutation remains outside the claim.'),
    graph: row('static-dependency-traversal', ['graph-invariants', 'cross-language-fixtures', 'surface-parity'], 'graph-query', 'navigation', 'Traversal is an algebraic derivative of the static import graph.'),
    circularDeps: row('static-cycle-detection', ['graph-invariants', 'command-fixtures', 'surface-parity'], 'graph-query', 'navigation', 'Cycle output is checked against known graph fixtures and traversal invariants.'),

    verify: row('tiered-signature-check', ['oracle-callers', 'cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'semantic-query', 'review-required'),
    plan: row('refactor-preview', ['oracle-callers', 'cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'semantic-query', 'review-required'),
    diffImpact: row('git-diff-derived-impact', ['oracle-callers', 'git-fixtures', 'command-fixtures', 'surface-parity'], 'git-query', 'review-required'),
    check: row('composed-precommit-diagnostic', ['oracle-callers', 'oracle-references', 'git-fixtures', 'command-fixtures', 'surface-parity'], 'git-query', 'review-required'),

    typedef: row('exact-indexed-type', ['oracle-symbols', 'cross-language-fixtures', 'surface-parity'], 'symbol-query', 'navigation'),
    stacktrace: row('advisory-frame-resolution', ['command-fixtures', 'surface-parity'], 'source-query', 'advisory-only', 'Stack formats and source-map/runtime availability are environment-specific; unresolved frames remain visible.'),
    api: row('static-public-surface', ['graph-invariants', 'cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'project-scan', 'review-required', 'Static exports are the claim; reflection and external consumers are explicitly outside the universe.'),
    stats: row('index-accounting', ['command-fixtures', 'systematic-options', 'surface-parity'], 'project-scan', 'navigation', 'Counts are checked against the built index and deterministic fixture totals.'),
    doctor: row('diagnostic-not-accuracy', ['command-fixtures', 'systematic-options', 'surface-parity'], 'project-scan', 'advisory-only', 'Doctor reports index/evidence limitations and never presents itself as an accuracy oracle.'),
    auditAsync: row('async-advisory', ['cross-language-fixtures', 'command-fixtures', 'surface-parity'], 'project-scan', 'advisory-only', 'Missing-await semantics depend on framework/type flow; findings are advisory and fixture-tested.'),
    orient: row('diagnostic-composition', ['command-fixtures', 'systematic-options', 'surface-parity'], 'project-scan', 'navigation', 'Orient composes index counts, entrypoint hints, and doctor limitations.'),
});

function summarizeCommandTrust() {
    const commands = Object.entries(COMMAND_TRUST_MATRIX);
    const oracleBacked = commands.filter(([, spec]) =>
        spec.proofs.some(id => PROOF_CATALOG[id]?.kind === 'external-oracle')).length;
    const advisoryOnly = commands.filter(([, spec]) => spec.decisionSafety === 'advisory-only').length;
    return {
        commands: commands.length,
        classified: commands.length,
        oracleBacked,
        invariantOrFixtureBacked: commands.length - oracleBacked,
        advisoryOnly,
        unclassified: 0,
        contract: 'proof-classification-not-runtime-accuracy',
    };
}

module.exports = { PROOF_CATALOG, COMMAND_TRUST_MATRIX, summarizeCommandTrust };
