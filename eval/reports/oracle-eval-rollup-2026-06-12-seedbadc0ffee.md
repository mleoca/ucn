# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 100 | 2917 | 99.7% | 27.9% | 0.7181 | **0** | 100.0% (14) | 100.0% |
| preact-signals | ts-morph | 36 | 45 | 100.0% | 12.1% | 0.8788 | **0** | 50.0% (4) | 100.0% |
| express | ts-morph | 63 | 285 | 99.3% | 0.4% | 0.9888 | **0** | 85.7% (7) | 100.0% |
| httpx | pyright | 92 | 1440 | 99.8% | 25.1% | 0.7464 | **0** | 100.0% (17) | 100.0% |
| rich | pyright | 100 | 2173 | 97.8% | 19.3% | 0.7846 | **0** | 100.0% (18) | 100.0% |
| cobra | gopls | 92 | 2028 | 99.9% | 3.1% | 0.9672 | **0** | 100.0% (24) | 100.0% |
| grpc-go | gopls | 100 | 1787 | 100.0% | 17.4% | 0.8262 | **0** | 100.0% (23) | 100.0% |
| ripgrep | rust-analyzer | 65 | 790 | 100.0% | 9.6% | 0.9038 | **0** | 85.7% (7) | 100.0% |
| cursive | rust-analyzer | 100 | 1304 | 97.7% | 46.7% | 0.5099 | **0** | 100.0% (12) | 100.0% |
| gson | jdtls | 100 | 1899 | 97.0% | 51.6% | 0.454 | **0** | 100.0% (20) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 76 | 1687 | 100.0% (316/316) | 27.8% (1364/4908) | 0.7221 | {"confirmed":316,"unverified":1364,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 20 | 1225 | 98.0% (49/50) | 28.1% (1181/4206) | 0.6992 | {"confirmed":44,"unverified":1181,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 5 | 100.0% (5/5) | 0.0% (0/0) | n/a | {"confirmed":5,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 19 | 29 | 100.0% (31/31) | 0.0% (0/3) | 1 | {"confirmed":29,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 14 | 12 | 100.0% (8/8) | 13.1% (8/61) | 0.8689 | {"confirmed":7,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 3 | 4 | 0.0% (0/0) | 0.0% (0/2) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 60 | 285 | 99.3% (297/299) | 0.4% (3/668) | 0.9888 | {"confirmed":281,"unverified":2,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":2,"missingUnexplained":0} |
| httpx | function | 15 | 50 | 100.0% (50/50) | 0.0% (0/48) | 1 | {"confirmed":50,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 51 | 471 | 99.3% (438/441) | 8.3% (34/412) | 0.9107 | {"confirmed":438,"unverified":33,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 26 | 919 | 100.0% (827/827) | 100.0% (109/109) | 0 | {"confirmed":810,"unverified":109,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 16 | 146 | 97.8% (132/135) | 36.8% (14/38) | 0.6094 | {"confirmed":132,"unverified":14,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 52 | 622 | 96.7% (527/545) | 18.0% (95/527) | 0.7867 | {"confirmed":527,"unverified":95,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 32 | 1405 | 98.2% (1430/1457) | 0.0% (0/0) | n/a | {"confirmed":1405,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 47 | 755 | 100.0% (757/757) | 0.0% (0/0) | n/a | {"confirmed":755,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 42 | 857 | 99.7% (847/850) | 3.1% (2/64) | 0.9652 | {"confirmed":847,"unverified":2,"reportedNonCall":8,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 416 | 100.0% (416/416) | 0.0% (0/0) | n/a | {"confirmed":416,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 30 | 533 | 100.0% (535/535) | 0.0% (0/0) | n/a | {"confirmed":533,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 48 | 767 | 100.0% (44/44) | 16.9% (478/2829) | 0.831 | {"confirmed":39,"unverified":476,"reportedNonCall":252,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 22 | 487 | 100.0% (468/468) | 89.5% (17/19) | 0.1053 | {"confirmed":468,"unverified":17,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 16 | 588 | 100.0% (587/587) | 100.0% (1/1) | 0 | {"confirmed":587,"unverified":1,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 43 | 191 | 100.0% (161/161) | 8.9% (25/281) | 0.911 | {"confirmed":161,"unverified":25,"reportedNonCall":5,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 6 | 11 | 100.0% (9/9) | 22.2% (2/9) | 0.7778 | {"confirmed":9,"unverified":2,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 9 | 53 | 50.0% (4/8) | 92.5% (49/53) | -0.4245 | {"confirmed":4,"unverified":49,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 85 | 1222 | 98.7% (367/372) | 45.4% (830/1828) | 0.5326 | {"confirmed":367,"unverified":829,"reportedNonCall":26,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 6 | 29 | 100.0% (3/3) | 38.9% (7/18) | 0.6111 | {"confirmed":3,"unverified":7,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":19,"missingUnexplained":0} |
| gson | method | 77 | 1506 | 95.5% (317/332) | 49.9% (678/1359) | 0.4559 | {"confirmed":317,"unverified":674,"reportedNonCall":142,"missingExplained":373,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 23 | 393 | 98.5% (336/341) | 100.0% (49/49) | -0.0147 | {"confirmed":336,"unverified":49,"reportedNonCall":0,"missingExplained":8,"missingBeyondText":0,"missingUnexplained":0} |
