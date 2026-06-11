# Oracle eval — 2026-06-11

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 98.7% | 28.7% | 0.7006 | **0** | 64.3% (14) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 81.5% | 0.0% | 0.8148 | **0** | n/a (0) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 100.0% (91/91) | 28.0% (1444/5149) | 0.7196 | {"confirmed":91,"unverified":1444,"reportedNonCall":102,"missingExplained":0,"missingBeyondText":18,"missingUnexplained":0} |
| zod | method | 10 | 199 | 97.0% (65/67) | 37.6% (127/338) | 0.5944 | {"confirmed":65,"unverified":127,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 0.0% (0/0) | 100.0% (3/3) | n/a | {"confirmed":0,"unverified":3,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 77.3% (17/22) | 0.0% (0/437) | 0.7727 | {"confirmed":17,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (5/5) | 0.0% (0/57) | 1 | {"confirmed":5,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
