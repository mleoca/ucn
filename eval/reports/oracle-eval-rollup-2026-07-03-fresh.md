# Oracle eval — 2026-07-03 (fresh-repo arm: unpinned rotation)

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| hono | ts-morph | 50 | 1213 | 99.7% | 60.4% | 0.393 | **0** | 100.0% (6) | 100.0% |
| zustand | ts-morph | 17 | 208 | 100.0% | 0.0% | 1 | **0** | 100.0% (1) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| hono | function | 15 | 91 | 98.9% (92/93) | 0.0% (0/25) | 0.9892 | {"confirmed":91,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | method | 18 | 935 | 100.0% (109/109) | 62.6% (440/703) | 0.3741 | {"confirmed":109,"unverified":440,"reportedNonCall":386,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | class | 14 | 187 | 100.0% (188/188) | n/a (0/0) | n/a | {"confirmed":187,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zustand | function | 17 | 208 | 100.0% (213/213) | 0.0% (0/18) | 1 | {"confirmed":208,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| hono | 100.0% (54/54) | 54 | 309 | 33 | 0 | 817 | 0 | **0** |
| zustand | 100.0% (17/17) | 17 | 0 | 2 | 0 | 189 | 0 | **0** |
