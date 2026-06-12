# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 96.1% | 30.6% | 0.6549 | **0** | 100.0% (8) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 90.9% | 3.1% | 0.8778 | **0** | 100.0% (2) | 100.0% |
| httpx | pyright | 50 | 879 | 99.2% | 29.2% | 0.7002 | **0** | 100.0% (6) | 100.0% |
| cobra | gopls | 50 | 1551 | 99.3% | 0.0% | n/a | **0** | 100.0% (13) | 100.0% |
| grpc-go | gopls | 50 | 840 | 100.0% | 15.0% | 0.8504 | **0** | 100.0% (13) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 17.5% | 0.8247 | **0** | 100.0% (1) | 100.0% |
| cursive | rust-analyzer | 50 | 637 | 98.9% | 49.7% | 0.4913 | **0** | 100.0% (6) | 100.0% |
| gson | jdtls | 50 | 649 | 94.7% | 29.4% | 0.6529 | **0** | 100.0% (9) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 97.4% (152/156) | 29.6% (1500/5066) | 0.6783 | {"confirmed":152,"unverified":1500,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 82.3% (14/17) | 42.3% (185/437) | 0.4002 | {"confirmed":14,"unverified":185,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0.0% (0/0) | n/a | {"confirmed":7,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 89.5% (17/19) | 0.0% (0/3) | 0.8947 | {"confirmed":17,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (3/3) | 3.4% (2/59) | 0.9661 | {"confirmed":3,"unverified":2,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 97.4% (38/39) | 0.0% (0/0) | n/a | {"confirmed":38,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 99.2% (357/360) | 2.6% (8/304) | 0.9654 | {"confirmed":357,"unverified":8,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 99.5% (362/364) | 100.0% (114/114) | -0.0055 | {"confirmed":362,"unverified":114,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 100.0% (575/575) | 0.0% (0/0) | n/a | {"confirmed":575,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 98.8% (560/567) | 0.0% (0/0) | n/a | {"confirmed":560,"unverified":0,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 99.0% (409/413) | 0.0% (0/0) | n/a | {"confirmed":409,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 12 | 101 | 100.0% (101/101) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 30 | 351 | 100.0% (5/5) | 15.0% (206/1370) | 0.8496 | {"confirmed":5,"unverified":206,"reportedNonCall":140,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 8 | 388 | 100.0% (388/388) | 0.0% (0/7) | 1 | {"confirmed":388,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0.0% (0/0) | n/a | {"confirmed":568,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (160/160) | 14.8% (22/149) | 0.8523 | {"confirmed":160,"unverified":22,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 100.0% (5/5) | 0 | {"confirmed":6,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 6 | 101 | 98.1% (101/103) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 39 | 519 | 99.4% (153/154) | 51.1% (353/691) | 0.4826 | {"confirmed":153,"unverified":353,"reportedNonCall":13,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 5 | 17 | 100.0% (3/3) | 19.4% (6/31) | 0.8065 | {"confirmed":3,"unverified":6,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":8,"missingUnexplained":0} |
| gson | method | 40 | 615 | 94.5% (275/291) | 26.4% (161/611) | 0.6815 | {"confirmed":275,"unverified":161,"reportedNonCall":47,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (8/8) | 100.0% (26/26) | 0 | {"confirmed":8,"unverified":26,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
