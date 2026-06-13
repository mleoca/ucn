# Oracle eval — 2026-06-12

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 100 | 2692 | 100.0% | 22.4% | 0.7765 | **0** | 100.0% (12) | 100.0% |
| preact-signals | ts-morph | 36 | 47 | 100.0% | 11.1% | 0.8889 | **0** | 50.0% (4) | 100.0% |
| express | ts-morph | 63 | 282 | 88.2% | 0.4% | 0.8776 | **0** | 75.0% (4) | 100.0% |
| httpx | pyright | 92 | 1429 | 99.9% | 24.4% | 0.7555 | **0** | 100.0% (18) | 100.0% |
| rich | pyright | 100 | 2593 | 95.6% | 24.9% | 0.7063 | **0** | 100.0% (15) | 100.0% |
| cobra | gopls | 92 | 2021 | 99.8% | 10.0% | 0.898 | **0** | 100.0% (24) | 100.0% |
| grpc-go | gopls | 100 | 1859 | 99.8% | 30.4% | 0.6943 | **0** | 100.0% (23) | 100.0% |
| ripgrep | rust-analyzer | 65 | 782 | 99.9% | 7.1% | 0.9278 | **0** | 100.0% (2) | 100.0% |
| cursive | rust-analyzer | 100 | 1275 | 96.3% | 49.9% | 0.4636 | **0** | 92.3% (13) | 100.0% |
| gson | jdtls | 100 | 2153 | 97.6% | 50.5% | 0.4718 | **0** | 95.0% (20) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| zod | function | 68 | 1420 | 100.0% (574/574) | 16.8% (842/5018) | 0.8322 | {"confirmed":574,"unverified":842,"reportedNonCall":4,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 25 | 1246 | 100.0% (129/129) | 29.8% (1120/3761) | 0.7022 | {"confirmed":121,"unverified":1120,"reportedNonCall":5,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 7 | 26 | 100.0% (26/26) | 27.3% (3/11) | 0.7273 | {"confirmed":26,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 21 | 35 | 100.0% (37/37) | 0.0% (0/3) | 1 | {"confirmed":35,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 13 | 10 | 100.0% (6/6) | 11.7% (7/60) | 0.8833 | {"confirmed":5,"unverified":5,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 2 | 2 | 0.0% (0/0) | 0.0% (0/0) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":2,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 60 | 282 | 88.2% (291/330) | 0.4% (4/954) | 0.8776 | {"confirmed":277,"unverified":3,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":2,"missingUnexplained":0} |
| httpx | function | 9 | 40 | 100.0% (40/40) | 0.0% (0/24) | 1 | {"confirmed":40,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 58 | 484 | 99.8% (450/451) | 7.0% (34/488) | 0.9281 | {"confirmed":450,"unverified":34,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 25 | 905 | 100.0% (797/797) | 100.0% (120/120) | 0 | {"confirmed":785,"unverified":120,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 13 | 164 | 94.1% (143/152) | 24.1% (20/83) | 0.6998 | {"confirmed":143,"unverified":20,"reportedNonCall":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 54 | 766 | 94.9% (684/721) | 25.2% (81/322) | 0.6971 | {"confirmed":684,"unverified":81,"reportedNonCall":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 33 | 1663 | 96.0% (1678/1748) | 0.0% (0/0) | n/a | {"confirmed":1663,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 52 | 766 | 100.0% (771/771) | 0.0% (0/0) | n/a | {"confirmed":766,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 38 | 840 | 99.5% (830/834) | 10.0% (2/20) | 0.8952 | {"confirmed":830,"unverified":2,"reportedNonCall":8,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 2 | 415 | 100.0% (415/415) | 0.0% (0/0) | n/a | {"confirmed":415,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 31 | 453 | 100.0% (454/454) | 0.0% (0/0) | n/a | {"confirmed":453,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 52 | 927 | 96.4% (53/55) | 30.9% (496/1608) | 0.6551 | {"confirmed":53,"unverified":496,"reportedNonCall":378,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 17 | 479 | 100.0% (479/479) | 0.0% (0/25) | 1 | {"confirmed":479,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 14 | 576 | 99.8% (576/577) | 0.0% (0/0) | n/a | {"confirmed":576,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 42 | 190 | 100.0% (161/161) | 5.1% (22/427) | 0.9485 | {"confirmed":161,"unverified":22,"reportedNonCall":7,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 9 | 16 | 100.0% (7/7) | 90.0% (9/10) | 0.1 | {"confirmed":7,"unverified":9,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 8 | 48 | 98.0% (48/49) | 0.0% (0/0) | n/a | {"confirmed":48,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 88 | 1218 | 96.0% (365/380) | 50.0% (826/1653) | 0.4608 | {"confirmed":365,"unverified":825,"reportedNonCall":28,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 4 | 9 | 0.0% (0/0) | 40.0% (4/10) | n/a | {"confirmed":0,"unverified":4,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":5,"missingUnexplained":0} |
| gson | method | 82 | 2065 | 97.7% (705/722) | 49.2% (896/1821) | 0.4845 | {"confirmed":703,"unverified":887,"reportedNonCall":78,"missingExplained":397,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 18 | 88 | 97.6% (40/41) | 100.0% (46/46) | -0.0244 | {"confirmed":40,"unverified":46,"reportedNonCall":0,"missingExplained":2,"missingBeyondText":0,"missingUnexplained":0} |
