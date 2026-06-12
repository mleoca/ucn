# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 100 | 2917 | 95.5% | 27.8% | 0.6776 | **0** | 100.0% (14) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 76 | 1687 | 98.2% (335/341) | 27.5% (1345/4886) | 0.7071 | {"confirmed":335,"unverified":1345,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 20 | 1225 | 78.6% (44/56) | 28.0% (1181/4212) | 0.5053 | {"confirmed":44,"unverified":1181,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 5 | 100.0% (5/5) | 0.0% (0/0) | n/a | {"confirmed":5,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
