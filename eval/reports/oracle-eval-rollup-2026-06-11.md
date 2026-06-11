# Oracle eval — 2026-06-11

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| cobra | gopls | 50 | 1551 | 99.2% | 0.0% | n/a | **0** | 100.0% (12) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 96.9% | 3.4% | 0.9348 | **0** | 100.0% (11) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| cobra | function | 29 | 575 | 99.7% (575/577) | 0.0% (0/0) | n/a | {"confirmed":575,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 98.8% (560/567) | 0.0% (0/0) | n/a | {"confirmed":560,"unverified":0,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 99.0% (409/413) | 0.0% (0/0) | n/a | {"confirmed":409,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0.0% (0/0) | n/a | {"confirmed":568,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 88.2% (179/203) | 1.3% (3/228) | 0.8686 | {"confirmed":179,"unverified":3,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 100.0% (5/5) | 0 | {"confirmed":6,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
