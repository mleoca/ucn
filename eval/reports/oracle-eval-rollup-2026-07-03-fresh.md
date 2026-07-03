# Oracle eval — 2026-07-03 (fresh-repo arm: unpinned rotation)

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| viper | gopls | 50 | 668 | 98.8% | 80.0% | 0.1878 | **0** | 87.5% (8) | 100.0% |
| serde_json | rust-analyzer | 50 | 586 | 93.6% | 44.0% | 0.4956 | **0** | 100.0% (8) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| viper | function | 20 | 158 | 95.8% (158/165) | 0.0% (0/6) | 0.9576 | {"confirmed":158,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | method | 29 | 506 | 100.0% (406/406) | 87.0% (60/69) | 0.1304 | {"confirmed":406,"unverified":58,"reportedNonCall":42,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | class | 1 | 4 | 100.0% (4/4) | n/a (0/0) | n/a | {"confirmed":4,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| serde_json | function | 21 | 246 | 99.6% (232/233) | 73.7% (14/19) | 0.2589 | {"confirmed":232,"unverified":14,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| serde_json | method | 27 | 231 | 80.5% (128/159) | 41.7% (103/247) | 0.388 | {"confirmed":128,"unverified":103,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| serde_json | class | 2 | 109 | 100.0% (107/107) | 50.0% (1/2) | 0.5 | {"confirmed":107,"unverified":1,"reportedNonCall":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| viper | 100.0% (239/239) | 237 | 33 | 398 | 0 | 0 | 0 | **0** |
| serde_json | 99.4% (471/474) | 471 | 1 | 114 | 0 | 0 | 0 | **0** |
