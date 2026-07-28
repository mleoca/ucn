# UCN trust contract

Use this reference when an agent, CI job, or script will make decisions from UCN output.

## Evidence classes

`confirmed` means UCN found positive identity evidence such as an exact binding, a same-class target, a validated receiver type, or an owned import/export chain. It does not mean the edge has a calibrated probability.

`unverified` means a syntactic candidate could reach the target but identity could not be established. Preserve and expose these edges. Do not silently treat them as negatives.

`excluded` means the engine found evidence for a different definition, an incompatible receiver, an external package, an unrelated runtime-language boundary, an arity mismatch, or another stated reason. Inspect excluded reasons when investigating an accuracy issue.

`non-call` means the literal name occurred as a definition, import, type reference, property, comment/string, or other text. Use `usages` for the underlying sites.

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

Even when all seven hold, `account.contract.semanticComplete` remains false. Use compiler/type-checker, test, runtime, and framework evidence for semantic decisions.

`account.contract.observedTextZero` is safe only for the claim “the complete observed literal-name ground set contained no caller candidates or beyond-text edges.” It is explicitly not safe-delete proof.

## Numeric fields

`evidenceScore` (and the legacy `confidence` alias where present) is an ordinal weight used for ordering and thresholding evidence classes. `scoreKind` is `ordinal-evidence-not-probability`. Never display it as measured accuracy or use it as a probability in risk calculations.

## Unverified review burden

Semantic recall can be complete while the result is still impractical: a true edge may be present only in a large unverified set. Release evaluation therefore measures both placement and the amount of review an agent must perform.

- `trueEdgeUnverifiedRate` is the share of semantic oracle edges found only in the unverified tier.
- `zeroActionableUnverifiedTargetRate` is the share of reviewed targets with no actionable ambiguity.
- `actionableUnverifiedCandidatesP50`, `actionableUnverifiedCandidatesP95`, and `actionableUnverifiedCandidatesMax` measure actionable candidate-set size per target.
- `unverifiedReviewItemsPerOracleEdge` measures effective review work relative to the oracle workload. Actionable false candidates count individually; each named runtime-dispatch family counts once.
- `rawFalseUnverifiedPerOracleEdge` preserves the ungrouped false-candidate amplification for auditability.
- `unverifiedReasons` groups candidates by the engine reason that kept them out of the confirmed tier.

Configuration-gated candidates remain visible but are not labeled false when the compiler/LSP oracle did not score them. The raw JSON rollup is the source of truth for these fields; the Markdown report is generated from the same data.

## Truncation

MCP results may include:

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
- the change is still validated by the language toolchain and relevant tests.

Never auto-delete from a UCN-only signal. Require usages, entry-point review, public API review, and external validation.
