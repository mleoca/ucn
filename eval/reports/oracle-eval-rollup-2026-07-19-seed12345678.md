# Oracle eval — 2026-07-19

UCN tiered caller answers scored against compiler/LSP ground truth.
`semantic-missing` is the release gate: every indexed, in-scope oracle
call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it
inside a non-call/excluded count is not enough. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 821 | 97.7% | 100.0% | **0** | 30.3% | 100.0% (6) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 31 | 609 | 100.0% (204/204) | 26.5% (405/1529) | 0.7351 | {"confirmed":204,"unverified":405,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 15 | 198 | 91.3% (73/80) | 56.2% (127/226) | 0.3506 | {"confirmed":71,"unverified":127,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 14 | 100.0% (14/14) | n/a (0/0) | n/a | {"confirmed":14,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the exact site as confirmed or unverified. Account-only and
same-name-other-definition placements are semantic misses.

| repo | callee precision | semantic recall | semantic missing | confirmed | other-def | unverified | accounted | module-level | beyond-text |
|---|---|---|---|---|---|---|---|---|---|
| zod | 100.0% (258/258) | 95.5% | **16** | 256 | 16 | 81 | 0 | 468 | 0 |
