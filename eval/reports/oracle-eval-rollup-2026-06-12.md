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
| cobra | gopls | 50 | 1551 | 99.3% | 0.0% | n/a | **0** | 100.0% (13) | 100.0% |
| grpc-go | gopls | 50 | 840 | 100.0% | 13.9% | 0.8613 | **0** | 100.0% (13) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 7.7% | 0.9229 | **0** | 100.0% (1) | 100.0% |
| cursive | rust-analyzer | 50 | 637 | 94.9% | 49.9% | 0.4499 | **0** | 85.7% (7) | 100.0% |
| gson | jdtls | 50 | 649 | 94.2% | 29.9% | 0.6425 | **0** | 100.0% (9) | 100.0% |

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
| cobra | function | 29 | 575 | 100.0% (575/575) | 0.0% (0/0) | n/a | {"confirmed":575,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 98.8% (560/567) | 0.0% (0/0) | n/a | {"confirmed":560,"unverified":0,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 99.0% (409/413) | 0.0% (0/0) | n/a | {"confirmed":409,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 12 | 101 | 100.0% (101/101) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 30 | 351 | 100.0% (19/19) | 13.9% (191/1371) | 0.8607 | {"confirmed":19,"unverified":191,"reportedNonCall":141,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 8 | 388 | 100.0% (388/388) | 0.0% (0/6) | 1 | {"confirmed":388,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0.0% (0/0) | n/a | {"confirmed":568,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (160/160) | 6.4% (22/345) | 0.9362 | {"confirmed":160,"unverified":22,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 100.0% (5/5) | 0 | {"confirmed":6,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 6 | 101 | 98.1% (101/103) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 39 | 519 | 92.7% (139/150) | 51.3% (346/674) | 0.4133 | {"confirmed":139,"unverified":346,"reportedNonCall":34,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 5 | 17 | 100.0% (3/3) | 19.4% (6/31) | 0.8065 | {"confirmed":3,"unverified":6,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":8,"missingUnexplained":0} |
| gson | method | 40 | 615 | 94.0% (252/268) | 27.4% (195/712) | 0.6664 | {"confirmed":252,"unverified":195,"reportedNonCall":36,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (8/8) | 100.0% (26/26) | 0 | {"confirmed":8,"unverified":26,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
