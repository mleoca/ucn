# UCN trust contract

Use this reference when an agent, CI job, or script will make decisions from UCN output.

## Evidence classes

`confirmed` means UCN found positive identity evidence such as an exact binding, a same-class target, a validated receiver type, or an owned import/export chain. It does not mean the edge has a calibrated probability.

`unverified` means a syntactic candidate could reach the target but identity could not be established. Preserve and expose these edges. Do not silently treat them as negatives.

`excluded` means the engine found evidence for a different definition, an incompatible receiver, an external package, an unrelated runtime-language boundary, an arity mismatch, or another stated reason. Inspect excluded reasons when investigating an accuracy issue.

`non-call` means the literal name occurred as a definition, import, type reference, property, comment/string, or other text. Use `usages` for the underlying sites; comment/string occurrences appear under `OTHER TEXT` unless `codeOnly=true`.

`beyond-text` means semantic binding or alias evidence produced an edge that a literal-name ground set could not observe.

## Conservation scope

The caller account partitions a literal-name text-occurrence ground set. A conserved account answers: “Did UCN explain every observed literal-name line?” It does not answer: “Did UCN discover every semantically possible runtime caller?”

Required automation checks:

1. `account.conserved` is true.
2. `account.contract.textComplete` is true.
3. No unreadable or unparsed files are reported.
4. No contract metadata was lost to truncation.
5. Unverified and excluded reasons are retained for review.
6. Compiler/LSP evaluation reports keep configuration-unscored evidence below the release ceiling; a high-precision result from an undersized scored subset is not accepted.
7. The release review-burden board passes: true edges left unverified, zero-actionable-ambiguity target rate, actionable candidate p95, and effective unverified review items per oracle edge all remain within the published budget. Raw false candidates remain reported separately.
8. The deterministic cross-command board reports zero disagreements: overlapping `find`, `show`, `source`, `impact`, `tests`, `check`, and caller `trace` claims resolve the same stable handle to the same identity, projections, caller tiers, evidence reasons, totals, and caller account.

Even when all eight hold, `account.contract.semanticComplete` remains false. Use compiler/type-checker, test, runtime, and framework evidence for semantic decisions.

`account.contract.observedTextZero` is safe only for the claim “the complete observed literal-name ground set contained no caller candidates or beyond-text edges.” It is explicitly not safe-delete proof.

## Numeric fields

`evidenceScore` (and the legacy `confidence` alias where present) is an ordinal weight used for ordering and thresholding evidence classes. `scoreKind` is `ordinal-evidence-not-probability`. Never display it as measured accuracy or use it as a probability in risk calculations.

## Unverified review burden

Semantic recall can be complete while the result is still impractical: a true edge may be present only in a large unverified set. Release evaluation therefore measures both placement and the amount of review an agent must perform.

- `trueEdgeUnverifiedRate` is the share of statically exact oracle edges found only in the unverified tier. Runtime-polymorphic, compiler-dependent template, and oracle-unresolved references remain in the all-oracle view but never inflate the exact denominator.
- `zeroActionableUnverifiedTargetRate` is the share of reviewed targets with no actionable ambiguity.
- `actionableUnverifiedCandidatesP50`, `actionableUnverifiedCandidatesP95`, and `actionableUnverifiedCandidatesMax` measure actionable candidate-set size per target.
- `unverifiedReviewItemsPerOracleEdge` measures effective review work relative to the oracle workload. Actionable false candidates count individually; each named runtime-dispatch family counts once.
- `rawFalseUnverifiedPerOracleEdge` preserves the ungrouped false-candidate amplification for auditability.
- `runtimeDependentOracleEdges`, `compilerDependentOracleEdges`, and `oracleAbstentionEdges` disclose why all-oracle coverage is broader than exact target identity.
- `unverifiedReasons` groups candidates by the engine reason that kept them out of the confirmed tier.

Configuration-gated candidates remain visible but are not labeled false when the compiler/LSP oracle did not score them. The raw JSON rollup is the source of truth for these fields; the Markdown report is generated from the same data.

The publish-blocking portable-AST ceilings are: at most 10% of exact true edges left unverified, at most 20% within any sufficiently sampled symbol kind, at least 80% of targets with zero actionable ambiguity, actionable-candidate p95 at most five, and at most 0.10 effective review items per oracle edge. The semantic gate separately requires 100% in-scope recall, at least 98% confirmed-tier precision, full conservation, and 100% public-command proof recall. Three class-aware floors gate at zero: unaccounted oracle edges of the exact, runtime-dispatch, and oracle-unresolved classes (caller and callee arms; compile-time-dispatch attributions stay report-only because their non-exact band varies with the compiler oracle's environment), runtime-dispatch oracle edges excluded with reason (possible-dispatch routing is demote-only), and deferred oracle-unresolved edges that exact definition lookup pins to the target re-enter the gate-bearing universe. Passing these sampled floors is release evidence, not runtime-completeness proof.

The performance gate runs each pinned repository in three independent processes with a fixed worker shape. Publish and PR gates require both CPU and wall-throughput floors on the median run, pin the expected file/LOC workload, and use the worst observed build/full-board peak RSS so memory failures cannot be averaged away. Exploratory one-process runs keep wall throughput diagnostic. Scoped reports are separate from the full release artifact; the dated rollup is release-qualified only when every required row came from a full release invocation. The composite release gate runs this stage first so verbose compiler-oracle output and report consumers cannot perturb its samples.

## Truncation

CLI and MCP text share the same 10K targeted / 3K broad default budgets and
100K ceiling. CLI truncation appends preserved contract lines directly. MCP
results may additionally include:

```json
{
  "truncated": true,
  "contractMetadata": ["ACCOUNT: ...", "CONTRACT: ..."],
  "contractMetadataComplete": true
}
```

When `contractMetadataComplete` is false, narrow the query or increase the output budget. A truncated result without complete contract metadata cannot support an automated breaking-change decision.

## Suggested machine policy

Allow an automated change to proceed to compiler/tests only when:

- the exact target is pinned by handle;
- the account is conserved and text-complete;
- warnings and filtered counts are zero;
- unverified sites are either zero or explicitly reviewed;
- `ucn repo --sections=health --deep` reports no parse failure/recovery and its task-specific readiness has been reviewed;
- the repo health report lists no unsupported source handoff relevant to the change;
- the change is still validated by the language toolchain and relevant tests.

Never auto-delete from a UCN-only signal. Computed dispatch is reported as a
health blind spot, and modeled registry members are withheld from candidates,
but neither protection proves runtime reachability. Require usages, entry-point
review, public API review, and external validation.
