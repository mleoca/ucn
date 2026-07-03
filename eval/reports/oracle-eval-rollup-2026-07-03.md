# Oracle eval — 2026-07-03

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 99.4% | 30.7% | 0.687 | **0** | 100.0% (9) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 100.0% | 8.3% | 0.9167 | **0** | 66.7% (3) | 100.0% |
| express | ts-morph | 39 | 262 | 100.0% | 0.3% | 0.9975 | **0** | 100.0% (1) | 100.0% |
| httpx | pyright | 50 | 879 | 99.9% | 37.3% | 0.6256 | **0** | 100.0% (7) | 100.0% |
| rich | pyright | 50 | 501 | 97.7% | 17.5% | 0.8013 | **0** | 100.0% (7) | 100.0% |
| cobra | gopls | 50 | 1551 | 99.9% | 6.0% | 0.9394 | **0** | 100.0% (13) | 100.0% |
| grpc-go | gopls | 50 | 840 | 100.0% | 14.9% | 0.8509 | **0** | 100.0% (13) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 17.0% | 0.8301 | **0** | 100.0% (1) | 100.0% |
| cursive | rust-analyzer | 50 | 637 | 99.0% | 49.8% | 0.4918 | **0** | 100.0% (6) | 100.0% |
| gson | jdtls | 50 | 649 | 96.6% | 30.4% | 0.6616 | **0** | 100.0% (9) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 36 | 1655 | 100.0% (142/142) | 29.9% (1510/5050) | 0.701 | {"confirmed":142,"unverified":1510,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 96.8% (30/31) | 40.8% (171/419) | 0.5596 | {"confirmed":28,"unverified":171,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0.0% (0/0) | n/a | {"confirmed":7,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 100.0% (15/15) | 0.0% (0/3) | 1 | {"confirmed":14,"unverified":0,"reportedNonCall":3,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 10 | 5 | 100.0% (3/3) | 9.3% (4/43) | 0.907 | {"confirmed":3,"unverified":2,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 100.0% (3/3) | 0.0% (0/2) | 1 | {"confirmed":2,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 37 | 262 | 100.0% (274/274) | 0.3% (2/802) | 0.9975 | {"confirmed":259,"unverified":1,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":2,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 100.0% (38/38) | 0.0% (0/0) | n/a | {"confirmed":38,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 99.7% (357/358) | 3.8% (8/213) | 0.9596 | {"confirmed":357,"unverified":8,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 100.0% (364/364) | 100.0% (114/114) | 0 | {"confirmed":362,"unverified":114,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 6 | 80 | 98.8% (79/80) | 2.9% (1/34) | 0.9581 | {"confirmed":79,"unverified":1,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 32 | 312 | 96.7% (263/272) | 19.5% (49/251) | 0.7717 | {"confirmed":263,"unverified":49,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 12 | 109 | 99.2% (120/121) | 0.0% (0/0) | n/a | {"confirmed":109,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 100.0% (575/575) | 0.0% (0/0) | n/a | {"confirmed":575,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 99.8% (557/558) | 6.0% (3/50) | 0.9382 | {"confirmed":557,"unverified":2,"reportedNonCall":8,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 100.0% (409/409) | 0.0% (0/0) | n/a | {"confirmed":409,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 12 | 101 | 100.0% (101/101) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 30 | 351 | 100.0% (7/7) | 15.0% (204/1361) | 0.8501 | {"confirmed":7,"unverified":204,"reportedNonCall":140,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 8 | 388 | 100.0% (388/388) | 0.0% (0/7) | 1 | {"confirmed":388,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0.0% (0/0) | n/a | {"confirmed":568,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (161/161) | 14.2% (21/148) | 0.8581 | {"confirmed":161,"unverified":21,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 100.0% (5/5) | 0 | {"confirmed":6,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 6 | 101 | 98.1% (101/103) | 0.0% (0/0) | n/a | {"confirmed":101,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 39 | 519 | 99.5% (182/183) | 50.3% (335/666) | 0.4915 | {"confirmed":182,"unverified":335,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 5 | 17 | 100.0% (3/3) | 31.6% (6/19) | 0.6842 | {"confirmed":3,"unverified":6,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":8,"missingUnexplained":0} |
| gson | method | 40 | 615 | 96.2% (275/286) | 30.4% (197/648) | 0.6575 | {"confirmed":275,"unverified":195,"reportedNonCall":13,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (34/34) | 0.0% (0/0) | n/a | {"confirmed":34,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| zod | 100.0% (41/41) | 41 | 22 | 95 | 0 | 1703 | 0 | **0** |
| preact-signals | 100.0% (15/15) | 15 | 0 | 4 | 1 | 4 | 0 | **0** |
| express | 100.0% (4/4) | 4 | 0 | 0 | 0 | 258 | 0 | **0** |
| httpx | 100.0% (380/380) | 379 | 1 | 466 | 33 | 0 | 0 | **0** |
| rich | 98.8% (237/240) | 236 | 27 | 76 | 40 | 122 | 0 | **0** |
| cobra | 99.9% (1537/1538) | 1536 | 0 | 8 | 0 | 7 | 0 | **0** |
| grpc-go | 98.1% (356/363) | 356 | 372 | 100 | 0 | 12 | 0 | **0** |
| ripgrep | 100.0% (729/729) | 729 | 0 | 32 | 4 | 0 | 0 | **0** |
| cursive | 100.0% (387/387) | 383 | 2 | 244 | 0 | 0 | 8 | **0** |
| gson | 97.1% (271/279) | 271 | 141 | 67 | 0 | 38 | 0 | **0** |
