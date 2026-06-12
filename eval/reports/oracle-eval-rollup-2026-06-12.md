# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 97.1% | 29.8% | 0.6723 | **0** | 100.0% (8) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 91.7% | 0.0% | 0.9167 | **0** | n/a (0) | 100.0% |
| httpx | pyright | 50 | 879 | 89.9% | 33.6% | 0.5632 | **0** | 100.0% (6) | 100.0% |
| cobra | gopls | 50 | 1551 | 99.2% | 0.0% | n/a | **0** | 100.0% (12) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 7.7% | 0.9233 | **0** | 100.0% (1) | 100.0% |
| gson | jdtls | 50 | 649 | 64.8% | 14.5% | 0.5033 | **0** | 100.0% (9) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 97.4% (152/156) | 29.6% (1500/5066) | 0.6783 | {"confirmed":152,"unverified":1500,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 96.1% (74/77) | 33.2% (125/377) | 0.6294 | {"confirmed":74,"unverified":125,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0.0% (0/0) | n/a | {"confirmed":7,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 89.5% (17/19) | 0.0% (0/437) | 0.8947 | {"confirmed":17,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (5/5) | 0.0% (0/57) | 1 | {"confirmed":5,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 88.4% (38/43) | 0.0% (0/0) | n/a | {"confirmed":38,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 83.5% (360/431) | 2.1% (5/240) | 0.8145 | {"confirmed":360,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 97.6% (362/371) | 100.0% (114/114) | -0.0243 | {"confirmed":362,"unverified":114,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 99.7% (575/577) | 0.0% (0/0) | n/a | {"confirmed":575,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 98.8% (560/567) | 0.0% (0/0) | n/a | {"confirmed":560,"unverified":0,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 99.0% (409/413) | 0.0% (0/0) | n/a | {"confirmed":409,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0.0% (0/0) | n/a | {"confirmed":568,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (160/160) | 6.3% (22/347) | 0.9366 | {"confirmed":160,"unverified":22,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 100.0% (5/5) | 0 | {"confirmed":6,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| gson | method | 40 | 615 | 64.2% (276/430) | 12.8% (171/1332) | 0.5135 | {"confirmed":276,"unverified":171,"reportedNonCall":36,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (8/8) | 100.0% (26/26) | 0 | {"confirmed":8,"unverified":26,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
