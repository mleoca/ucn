# Oracle eval: 2026-07-20

UCN tiered caller answers scored against compiler/LSP ground truth.
`semantic-missing` is the release gate: every indexed, in-scope oracle
call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it
inside a non-call/excluded count is not enough. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |
|---|---|---|---|---|---|---|---|---|---|
| chi | gopls | 50 | 837 | 100.0% | 100.0% | **0** | 37.8% | 100.0% (10) | 100.0% |
| clap | rust-analyzer | 50 | 2814 | 100.0% | 100.0% | **0** | 66.6% | 100.0% (13) | 100.0% |
| click | pyright | 50 | 1276 | 100.0% | 100.0% | **0** | 1.6% | 100.0% (7) | 100.0% |
| cobra | gopls | 50 | 1551 | 100.0% | 100.0% | **0** | 20.3% | 100.0% (13) | 100.0% |
| cursive | rust-analyzer | 50 | 643 | 100.0% | 100.0% | **0** | 39.0% | 100.0% (6) | 100.0% |
| express | ts-morph | 39 | 262 | 100.0% | 100.0% | **0** | 0.2% | 100.0% (1) | 100.0% |
| fastify | ts-morph | 45 | 1459 | 100.0% | 100.0% | **0** | 26.8% | 100.0% (1) | 100.0% |
| grpc-go | gopls | 50 | 508 | 100.0% | 100.0% | **0** | 1.7% | 100.0% (13) | 100.0% |
| gson | jdtls | 50 | 511 | 100.0% | 100.0% | **0** | 13.1% | 100.0% (10) | 100.0% |
| hono | ts-morph | 50 | 717 | 100.0% | 100.0% | **0** | 12.7% | 100.0% (7) | 100.0% |
| httpx | pyright | 50 | 879 | 100.0% | 100.0% | **0** | 37.0% | 100.0% (6) | 100.0% |
| javapoet | jdtls | 50 | 794 | 100.0% | 100.0% | **0** | 8.9% | 100.0% (6) | 100.0% |
| jsoup | jdtls | 50 | 467 | 98.0% | 100.0% | **0** | 10.1% | 100.0% (3) | 100.0% |
| preact-signals | ts-morph | 25 | 24 | 100.0% | 100.0% | **0** | 4.3% | 100.0% (3) | 100.0% |
| rich | pyright | 50 | 501 | 99.4% | 100.0% | **0** | 21.0% | 100.0% (7) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 100.0% | **0** | 22.9% | 100.0% (1) | 100.0% |
| viper | gopls | 50 | 641 | 100.0% | 100.0% | **0** | 41.8% | 100.0% (7) | 100.0% |
| zod | ts-morph | 50 | 1861 | 98.9% | 100.0% | **0** | 30.4% | 100.0% (8) | 100.0% |
| zustand | ts-morph | 17 | 208 | 100.0% | 100.0% | **0** | 0.0% | 100.0% (1) | 100.0% |

## Oracle-backed command surface

The sampled compiler/LSP symbols and references also gate exact definition
discovery, `find`, source extraction (`fn`/`class`), `brief`, `typedef`,
literal code-reference recall in `usages`, direct test-reference recall in
`tests`, and compiler-true selection by `example`. Command execution errors
are failures; they can no longer silently reduce the evaluated sample.

| repo | evaluated | definition | find | extract | brief | typedef | usages | tests | example | execution errors | failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chi | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (5/5) | 100.0% (239/239) | 100.0% (153/153) | 100.0% (29/29) | **0** | **0** |
| clap | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (3/3) | 100.0% (728/728) | 100.0% (582/582) | 100.0% (34/34) | **0** | **0** |
| click | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (7/7) | 100.0% (838/838) | 100.0% (541/541) | 100.0% (30/30) | **0** | **0** |
| cobra | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (3/3) | 100.0% (1820/1820) | 100.0% (1350/1350) | 100.0% (34/34) | **0** | **0** |
| cursive | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (5/5) | 100.0% (279/279) | 100.0% (23/23) | 100.0% (32/32) | **0** | **0** |
| express | 39/39 | 100.0% (39/39) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (0/0) | 100.0% (59/59) | 100.0% (0/0) | 100.0% (25/25) | **0** | **0** |
| fastify | 45/45 | 100.0% (45/45) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (1/1) | 100.0% (248/248) | 100.0% (181/181) | 100.0% (27/27) | **0** | **0** |
| grpc-go | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (8/8) | 100.0% (245/245) | 100.0% (196/196) | 100.0% (15/15) | **0** | **0** |
| gson | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (10/10) | 100.0% (529/529) | 100.0% (319/319) | 100.0% (25/25) | **0** | **0** |
| hono | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (16/16) | 100.0% (246/246) | 100.0% (147/147) | 100.0% (23/23) | **0** | **0** |
| httpx | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (12/12) | 100.0% (760/760) | 100.0% (608/608) | 100.0% (27/27) | **0** | **0** |
| javapoet | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (2/2) | 100.0% (130/130) | 100.0% (6/6) | 100.0% (29/29) | **0** | **0** |
| jsoup | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (11/11) | 100.0% (752/752) | 100.0% (326/326) | 100.0% (31/31) | **0** | **0** |
| preact-signals | 25/25 | 100.0% (25/25) | 100.0% (25/25) | 100.0% (25/25) | 100.0% (25/25) | 100.0% (1/1) | 100.0% (24/24) | 100.0% (0/0) | 100.0% (11/11) | **0** | **0** |
| rich | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (12/12) | 100.0% (413/413) | 100.0% (129/129) | 100.0% (25/25) | **0** | **0** |
| ripgrep | 41/41 | 100.0% (41/41) | 100.0% (41/41) | 100.0% (41/41) | 100.0% (41/41) | 100.0% (4/4) | 100.0% (693/693) | 100.0% (0/0) | 100.0% (23/23) | **0** | **0** |
| viper | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (1/1) | 100.0% (184/184) | 100.0% (157/157) | 100.0% (29/29) | **0** | **0** |
| zod | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (4/4) | 100.0% (196/196) | 100.0% (144/144) | 100.0% (23/23) | **0** | **0** |
| zustand | 17/17 | 100.0% (17/17) | 100.0% (17/17) | 100.0% (17/17) | 100.0% (17/17) | 100.0% (0/0) | 100.0% (222/222) | 100.0% (212/212) | 100.0% (14/14) | **0** | **0** |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps, such as method-name conflation where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |
|---|---|---|---|---|---|---|---|---|---|
| chi | function | 22 | 293 | 100.0% (301/301) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":293,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | method | 23 | 519 | 100.0% (264/264) | 0 | 37.8% (278/736) | 115 | 0.6223 | {"confirmed":242,"unverified":277,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | class | 5 | 25 | 100.0% (25/25) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":25,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | function | 14 | 252 | 100.0% (252/252) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":252,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | method | 33 | 2562 | 100.0% (1766/1766) | 8 | 66.6% (934/1402) | 159 | 0.3338 | {"confirmed":1766,"unverified":796,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | class | 3 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | function | 27 | 806 | 100.0% (814/814) | 0 | 1.0% (1/96) | 0 | 0.9896 | {"confirmed":805,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | method | 16 | 365 | 100.0% (351/351) | 0 | 1.6% (14/853) | 0 | 0.9836 | {"confirmed":351,"unverified":14,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | class | 7 | 105 | 100.0% (106/106) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":105,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 100.0% (575/575) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":575,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 100.0% (557/557) | 0 | 20.3% (12/59) | 0 | 0.7966 | {"confirmed":556,"unverified":11,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 100.0% (409/409) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":409,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 6 | 103 | 100.0% (103/103) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":103,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 39 | 519 | 100.0% (315/315) | 0 | 37.9% (204/538) | 48 | 0.6208 | {"confirmed":315,"unverified":204,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 5 | 21 | 100.0% (6/6) | 0 | 65.2% (15/23) | 3 | 0.3478 | {"confirmed":6,"unverified":15,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 39 | 262 | 100.0% (276/276) | 0 | 0.2% (2/846) | 0 | 0.9976 | {"confirmed":261,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | function | 42 | 1401 | 100.0% (196/196) | 0 | 27.2% (1245/4575) | 0 | 0.7279 | {"confirmed":154,"unverified":1245,"accountedNotShown":0,"missingExplained":2,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | method | 2 | 28 | 100.0% (6/6) | 0 | 13.7% (22/161) | 0 | 0.8634 | {"confirmed":6,"unverified":22,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | class | 1 | 30 | 100.0% (31/31) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":30,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 12 | 101 | 100.0% (101/101) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":101,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 30 | 19 | 100.0% (7/7) | 0 | 1.7% (12/725) | 1205 | 0.9834 | {"confirmed":7,"unverified":12,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 8 | 388 | 100.0% (388/388) | 0 | 0.0% (0/3) | 2 | 1 | {"confirmed":388,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| gson | method | 40 | 477 | 100.0% (288/288) | 0 | 13.1% (90/685) | 0 | 0.8686 | {"confirmed":277,"unverified":87,"accountedNotShown":0,"missingExplained":113,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (34/34) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":34,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | function | 14 | 92 | 100.0% (92/92) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":92,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | method | 20 | 391 | 100.0% (287/287) | 0 | 12.7% (104/820) | 0 | 0.8732 | {"confirmed":287,"unverified":104,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | class | 16 | 234 | 100.0% (235/235) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":234,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 100.0% (39/39) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":38,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 100.0% (356/356) | 0 | 4.1% (9/218) | 0 | 0.9587 | {"confirmed":356,"unverified":9,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 100.0% (364/364) | 0 | 100.0% (114/114) | 0 | 0 | {"confirmed":362,"unverified":114,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | method | 48 | 794 | 100.0% (533/533) | 0 | 8.9% (281/3153) | 0 | 0.9109 | {"confirmed":531,"unverified":263,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | class | 2 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | method | 39 | 427 | 97.7% (380/389) | 0 | 10.1% (52/515) | 0 | 0.8759 | {"confirmed":379,"unverified":48,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | class | 11 | 40 | 100.0% (61/61) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":40,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 13 | 17 | 100.0% (19/19) | 0 | 0.0% (0/2) | 0 | 1 | {"confirmed":17,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 11 | 5 | 100.0% (5/5) | 0 | 4.7% (2/43) | 0 | 0.9535 | {"confirmed":3,"unverified":2,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 100.0% (3/3) | 0 | 0.0% (0/2) | 0 | 1 | {"confirmed":2,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 6 | 80 | 100.0% (81/81) | 0 | 2.9% (1/34) | 0 | 0.9706 | {"confirmed":79,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 32 | 312 | 98.9% (275/278) | 5 | 23.4% (59/252) | 0 | 0.7551 | {"confirmed":275,"unverified":37,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 12 | 109 | 100.0% (121/121) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":109,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":568,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (164/164) | 0 | 19.5% (22/113) | 38 | 0.8053 | {"confirmed":164,"unverified":22,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (6/6) | 0 | 100.0% (5/5) | 0 | 0 | {"confirmed":6,"unverified":5,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | function | 20 | 158 | 100.0% (158/158) | 0 | 100.0% (6/6) | 0 | 0 | {"confirmed":158,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | method | 29 | 479 | 100.0% (442/442) | 0 | 38.1% (37/97) | 0 | 0.6186 | {"confirmed":442,"unverified":37,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | class | 1 | 4 | 100.0% (4/4) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":4,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | function | 36 | 1655 | 100.0% (145/145) | 0 | 29.6% (1510/5107) | 0 | 0.7043 | {"confirmed":145,"unverified":1510,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 199 | 94.6% (35/37) | 0 | 41.1% (166/404) | 0 | 0.535 | {"confirmed":33,"unverified":166,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0 | 0.0% (0/1) | 0 | 1 | {"confirmed":7,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zustand | function | 17 | 208 | 100.0% (213/213) | 0 | 0.0% (0/18) | 0 | 1 | {"confirmed":208,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount, the trace-down engine path) must show
the exact site as confirmed or unverified. Account-only and
same-name-other-definition placements are semantic misses unless
exact definition lookup proves the reference search expanded a
virtual-method family and UCN selected the actual static target.

| repo | callee precision | semantic recall | semantic missing | confirmed | oracle-broad | other-def | unverified | unverified+other | accounted | module-level | beyond-text |
|---|---|---|---|---|---|---|---|---|---|---|---|
| chi | 100.0% (360/360) | 100.0% | **0** | 359 | 0 | 0 | 473 | 0 | 0 | 5 | 0 |
| clap | 100.0% (2269/2269) | 100.0% | **0** | 2268 | 0 | 0 | 526 | 20 | 0 | 0 | 0 |
| click | 100.0% (1050/1050) | 100.0% | **0** | 1043 | 0 | 0 | 233 | 0 | 0 | 0 | 0 |
| cobra | 100.0% (1531/1531) | 100.0% | **0** | 1531 | 0 | 0 | 13 | 0 | 0 | 7 | 0 |
| cursive | 100.0% (481/481) | 100.0% | **0** | 479 | 0 | 0 | 162 | 0 | 0 | 2 | 0 |
| express | 100.0% (15/15) | 100.0% | **0** | 15 | 0 | 0 | 0 | 0 | 0 | 247 | 0 |
| fastify | 100.0% (67/67) | 100.0% | **0** | 65 | 0 | 0 | 83 | 0 | 0 | 1309 | 0 |
| grpc-go | 100.0% (508/508) | 100.0% | **0** | 487 | 0 | 0 | 14 | 0 | 0 | 7 | 0 |
| gson | 100.0% (188/188) | 100.0% | **0** | 187 | 0 | 0 | 200 | 0 | 0 | 11 | 0 |
| hono | 100.0% (56/56) | 100.0% | **0** | 56 | 0 | 0 | 49 | 0 | 0 | 612 | 0 |
| httpx | 100.0% (424/424) | 100.0% | **0** | 422 | 0 | 0 | 457 | 0 | 0 | 0 | 0 |
| javapoet | 100.0% (434/434) | 100.0% | **0** | 431 | 0 | 0 | 312 | 2 | 0 | 49 | 0 |
| jsoup | 100.0% (402/402) | 100.0% | **0** | 402 | 0 | 0 | 49 | 0 | 0 | 16 | 0 |
| preact-signals | 100.0% (13/13) | 100.0% | **0** | 13 | 0 | 0 | 7 | 0 | 0 | 4 | 0 |
| rich | 100.0% (351/351) | 100.0% | **0** | 347 | 0 | 0 | 32 | 0 | 0 | 122 | 0 |
| ripgrep | 100.0% (724/724) | 100.0% | **0** | 724 | 0 | 0 | 41 | 0 | 0 | 0 | 0 |
| viper | 100.0% (580/580) | 100.0% | **0** | 569 | 0 | 0 | 72 | 0 | 0 | 0 | 0 |
| zod | 100.0% (82/82) | 100.0% | **0** | 81 | 0 | 0 | 91 | 0 | 0 | 1689 | 0 |
| zustand | 100.0% (18/18) | 100.0% | **0** | 18 | 0 | 0 | 2 | 0 | 0 | 188 | 0 |

## Exact-definition adjudication

For repeated project symbol names, reference-search hits are checked
against `textDocument/definition`. References statically bound to
another definition are excluded from this target's ground truth.
Unresolved lookups remain in the conservative reference-search set;
request errors fail the gate instead of silently weakening it.
For Rust, unresolved precision edges inside syn-confirmed `#[cfg]`
owners are reported as unscored because one rust-analyzer process
cannot activate mutually exclusive feature/platform projections.

| repo | confirmed edges validated | unverified edges validated | oracle calls validated | broad-family refs excluded | unresolved refs | lookup errors | cfg-unscored precision edges | cfg-unscored callee sites | source-status errors |
|---|---|---|---|---|---|---|---|---|---|
| chi | 393 | 8 | 372 | 89 | 269 | **0** | 115 | 0 | **0** |
| clap | 1899 | 472 | 2233 | 0 | 0 | **0** | 167 | 2 | **0** |
| click | 678 | 11 | 684 | 0 | 0 | **0** | 0 | 0 | **0** |
| cobra | 135 | 0 | 134 | 0 | 0 | **0** | 0 | 0 | **0** |
| cursive | 201 | 168 | 369 | 0 | 8 | **0** | 51 | 0 | **0** |
| express | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| fastify | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| grpc-go | 293 | 12 | 305 | 332 | 0 | **0** | 1207 | 0 | **0** |
| gson | 209 | 34 | 243 | 138 | 87 | **0** | 0 | 0 | **0** |
| hono | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| httpx | 230 | 7 | 237 | 0 | 0 | **0** | 0 | 0 | **0** |
| javapoet | 414 | 272 | 668 | 42 | 3 | **0** | 0 | 0 | **0** |
| jsoup | 286 | 12 | 293 | 200 | 14 | **0** | 0 | 0 | **0** |
| preact-signals | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| rich | 206 | 46 | 228 | 0 | 0 | **0** | 5 | 0 | **0** |
| ripgrep | 47 | 26 | 73 | 0 | 0 | **0** | 38 | 0 | **0** |
| viper | 426 | 29 | 449 | 27 | 14 | **0** | 0 | 0 | **0** |
| zod | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| zustand | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
