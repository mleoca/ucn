# Oracle eval — 2026-06-11

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 97.1% | 29.4% | 0.6768 | **0** | 100.0% (8) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 88.0% | 0.0% | 0.88 | **0** | n/a (0) | 100.0% |
| httpx | pyright | 50 | 879 | 89.6% | 33.6% | 0.56 | **0** | 100.0% (5) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 97.4% (152/156) | 29.1% (1500/5151) | 0.6832 | {"confirmed":152,"unverified":1500,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 96.1% (74/77) | 33.2% (125/377) | 0.6294 | {"confirmed":74,"unverified":125,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0.0% (0/0) | n/a | {"confirmed":7,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 85.0% (17/20) | 0.0% (0/437) | 0.85 | {"confirmed":17,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (5/5) | 0.0% (0/57) | 1 | {"confirmed":5,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 88.4% (38/43) | 0.0% (0/0) | n/a | {"confirmed":38,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 83.0% (360/434) | 2.1% (5/240) | 0.8087 | {"confirmed":360,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 97.6% (362/371) | 100.0% (114/114) | -0.0243 | {"confirmed":362,"unverified":114,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
