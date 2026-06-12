# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 98.3% | 30.6% | 0.6775 | **0** | 100.0% (8) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 90.9% | 4.2% | 0.8674 | **0** | 100.0% (2) | 100.0% |
| express | ts-morph | 39 | 262 | 94.2% | 0.1% | 0.9406 | **0** | 50.0% (2) | 100.0% |
| httpx | pyright | 50 | 879 | 99.9% | 29.3% | 0.7061 | **0** | 100.0% (7) | 100.0% |
| rich | pyright | 50 | 501 | 97.7% | 17.5% | 0.8013 | **0** | 100.0% (7) | 100.0% |
| cobra | gopls | 50 | 1551 | 99.3% | 0.0% | n/a | **0** | 100.0% (13) | 100.0% |
| grpc-go | gopls | 50 | 840 | 100.0% | 15.0% | 0.8504 | **0** | 100.0% (13) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 17.5% | 0.8247 | **0** | 100.0% (1) | 100.0% |
| cursive | rust-analyzer | 50 | 637 | 98.9% | 49.7% | 0.4913 | **0** | 100.0% (6) | 100.0% |
| gson | jdtls | 50 | 649 | 96.2% | 33.1% | 0.6304 | **0** | 100.0% (9) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 100.0% (142/142) | 29.7% (1510/5081) | 0.7028 | {"confirmed":142,"unverified":1510,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 90.0% (27/30) | 40.8% (172/422) | 0.4924 | {"confirmed":27,"unverified":172,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0.0% (0/0) | n/a | {"confirmed":7,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 89.5% (17/19) | 0.0% (0/3) | 0.8947 | {"confirmed":17,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (3/3) | 4.7% (2/43) | 0.9535 | {"confirmed":3,"unverified":2,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 37 | 262 | 94.2% (259/275) | 0.1% (1/802) | 0.9406 | {"confirmed":259,"unverified":1,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":2,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 100.0% (38/38) | 0.0% (0/0) | n/a | {"confirmed":38,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 99.7% (357/358) | 2.6% (8/303) | 0.9708 | {"confirmed":357,"unverified":8,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 100.0% (364/364) | 100.0% (114/114) | 0 | {"confirmed":362,"unverified":114,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 6 | 80 | 98.7% (78/79) | 2.9% (1/34) | 0.9579 | {"confirmed":78,"unverified":1,"reportedNonCall":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 32 | 312 | 96.7% (263/272) | 19.5% (49/251) | 0.7717 | {"confirmed":263,"unverified":49,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 12 | 109 | 99.2% (120/121) | 0.0% (0/0) | n/a | {"confirmed":109,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
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
| gson | method | 40 | 615 | 96.1% (269/280) | 30.5% (201/659) | 0.6557 | {"confirmed":269,"unverified":201,"reportedNonCall":13,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (8/8) | 100.0% (26/26) | 0 | {"confirmed":8,"unverified":26,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
