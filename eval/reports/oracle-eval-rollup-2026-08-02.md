# Oracle eval: 2026-08-02

UCN tiered caller answers scored against compiler/LSP ground truth.
`semantic-missing` is the release gate: every indexed, in-scope oracle
call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it
inside a non-call/excluded count is not enough. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |
|---|---|---|---|---|---|---|---|---|---|
| chi | gopls | 50 | 568 | 99.7% | 100.0% | **0** | 1.3% | 100.0% (10) | 100.0% |
| cjson | clangd | 50 | 1301 | 100.0% | 100.0% | **0** | 100.0% | 100.0% (17) | 100.0% |
| clap | rust-analyzer | 50 | 2814 | 100.0% | 100.0% | **0** | 90.9% | 100.0% (13) | 100.0% |
| click | pyright | 50 | 1276 | 99.9% | 100.0% | **0** | 3.5% | 100.0% (7) | 100.0% |
| cobra | gopls | 50 | 1551 | 100.0% | 100.0% | **0** | 20.3% | 100.0% (13) | 100.0% |
| cursive | rust-analyzer | 50 | 635 | 100.0% | 99.8% | **1** | 31.1% | 100.0% (7) | 100.0% |
| express | ts-morph | 39 | 262 | 100.0% | 100.0% | **0** | 100.0% | 100.0% (1) | 100.0% |
| fastify | ts-morph | 49 | 1548 | 100.0% | 97.2% | **43** | 30.2% | 50.0% (2) | 100.0% |
| fmt | clangd | 50 | 1833 | 100.0% | 100.0% | **0** | 57.2% | 100.0% (6) | 100.0% |
| grpc-go | gopls | 50 | 508 | 100.0% | 100.0% | **0** | 1.7% | 100.0% (13) | 100.0% |
| gson | jdtls | 50 | 424 | 100.0% | 100.0% | **0** | 7.5% | 100.0% (7) | 100.0% |
| hono | ts-morph | 50 | 938 | 100.0% | 100.0% | **0** | 65.4% | 100.0% (7) | 100.0% |
| httpx | pyright | 50 | 879 | 100.0% | 100.0% | **0** | 0.0% | 100.0% (7) | 100.0% |
| javapoet | jdtls | 50 | 791 | 100.0% | 100.0% | **0** | 9.7% | 100.0% (7) | 100.0% |
| jsoup | jdtls | 50 | 453 | 98.8% | 99.8% | **1** | 8.7% | n/a (0) | 100.0% |
| newtonsoft-json | roslyn | 50 | 1065 | 99.4% | 100.0% | **0** | 2.8% | 100.0% (3) | 100.0% |
| preact-signals | ts-morph | 27 | 519 | 100.0% | 100.0% | **0** | 46.2% | n/a (0) | 100.0% |
| rich | pyright | 50 | 501 | 99.8% | 100.0% | **0** | 35.8% | 100.0% (7) | 100.0% |
| ripgrep | rust-analyzer | 41 | 765 | 100.0% | 100.0% | **0** | 4.0% | 100.0% (1) | 100.0% |
| viper | gopls | 50 | 627 | 100.0% | 100.0% | **0** | 5.9% | 100.0% (13) | 100.0% |
| zod | ts-morph | 50 | 1929 | 100.0% | 99.1% | **18** | 9.2% | 100.0% (8) | 100.0% |
| zustand | ts-morph | 17 | 208 | 100.0% | 100.0% | **0** | 0.0% | 100.0% (1) | 100.0% |

## Unverified review burden

Recall is not enough when an agent must inspect a large abstention band.
This board measures how much candidate review remains, how often a pinned
target has no actionable ambiguity, and how many effective review items
the engine creates. Actionable false candidates count individually; named
runtime-dispatch and compiler-dependent template families count once because
that is how agents receive them. Exact and compiler-dependent oracle edges
remain separate so a dependent may-reach result is never called exact.
Raw candidates and raw false counts remain visible. Configuration-unscored
candidates stay visible but are not labeled false.

| repo | exact true-edge unverified | all oracle-edge unverified | zero actionable ambiguity | actionable p50/p95/max | runtime sites/families | compile-time sites/families | compiler-dependent oracle edges | raw unverified | raw false | effective review items | items/oracle edge | top reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| chi | 1.4% (8/568) | 1.4% (8/568) | 82.0% (41/50) | 0/7/33 | 787/54 | 0/0 | 0 | 849 | 705 | 107 | 0.1884 | possible-dispatch (787), method-ambiguous (59), call-not-resolved (3) |
| cjson | 0.3% (1/339) | 0.3% (1/339) | 98.0% (49/50) | 0/0/1 | 0/0 | 0/0 | 0 | 1 | 0 | 0 | 0 | name-only (1) |
| clap | 0.3% (9/2814) | 0.3% (9/2814) | 86.0% (43/50) | 0/2/3 | 0/0 | 0/0 | 0 | 12 | 1 | 1 | 0.0004 | method-ambiguous (12) |
| click | 0.4% (5/1276) | 0.4% (5/1276) | 82.0% (41/50) | 0/93/373 | 22/7 | 0/0 | 0 | 903 | 139 | 128 | 0.1003 | method-ambiguous (865), possible-dispatch (22), method-no-evidence (16) |
| cobra | 0.7% (11/1551) | 0.7% (11/1551) | 100.0% (50/50) | 0/0/0 | 59/5 | 0/0 | 0 | 59 | 47 | 5 | 0.0032 | possible-dispatch (59) |
| cursive | 20.3% (129/635) | 20.3% (129/635) | 58.0% (29/50) | 0/33/191 | 14/8 | 0/0 | 0 | 463 | 290 | 284 | 0.4472 | method-ambiguous (409), name-only (29), possible-dispatch (14) |
| express | 0.4% (1/262) | 0.4% (1/262) | 66.7% (26/39) | 0/47/123 | 551/4 | 0/0 | 0 | 829 | 0 | 4 | 0.0153 | possible-dispatch (551), method-ambiguous (272), method-no-evidence (6) |
| fastify | 85.3% (1315/1542) | 85.3% (1315/1542) | 55.1% (27/49) | 0/1233/1267 | 734/27 | 0/0 | 0 | 4804 | 3035 | 2449 | 1.5882 | method-ambiguous (4041), possible-dispatch (734), method-no-evidence (24) |
| fmt | 0.6% (1/171) | 19.7% (341/1735) | 96.0% (48/50) | 0/0/2 | 42/10 | 726/54 | 1564 | 771 | 305 | 66 | 0.038 | overload-ambiguous (549), method-ambiguous (79), compile-time-only (64) |
| grpc-go | 2.4% (12/508) | 2.4% (12/508) | 70.0% (35/50) | 0/97/294 | 1288/83 | 0/0 | 0 | 1933 | 714 | 325 | 0.6398 | possible-dispatch (1288), method-ambiguous (639), call-not-resolved (6) |
| gson | 10.4% (37/354) | 10.4% (37/354) | 80.0% (40/50) | 0/28/32 | 517/30 | 0/0 | 0 | 628 | 457 | 76 | 0.2147 | possible-dispatch (518), overload-ambiguous (57), method-ambiguous (47) |
| hono | 56.2% (527/938) | 56.2% (527/938) | 68.0% (34/50) | 0/35/139 | 608/20 | 0/0 | 0 | 900 | 279 | 69 | 0.0736 | possible-dispatch (608), method-ambiguous (261), method-no-evidence (31) |
| httpx | 0.0% (0/879) | 0.0% (0/879) | 80.0% (40/50) | 0/3/12 | 22/14 | 0/0 | 0 | 65 | 26 | 33 | 0.0375 | method-ambiguous (24), possible-dispatch (22), method-no-evidence (19) |
| javapoet | 1.4% (11/791) | 1.4% (11/791) | 80.0% (40/50) | 0/1/4 | 179/22 | 0/0 | 0 | 194 | 139 | 30 | 0.0379 | possible-dispatch (179), method-ambiguous (8), overload-ambiguous (7) |
| jsoup | 6.6% (30/453) | 6.6% (30/453) | 82.0% (41/50) | 0/22/23 | 377/32 | 0/0 | 0 | 472 | 346 | 101 | 0.223 | possible-dispatch (377), method-ambiguous (92), method-no-evidence (2) |
| newtonsoft-json | 0.4% (4/1065) | 0.4% (4/1065) | 86.0% (43/50) | 0/4/5 | 180/21 | 0/0 | 0 | 198 | 138 | 28 | 0.0263 | possible-dispatch (180), method-ambiguous (13), overload-ambiguous (5) |
| preact-signals | 1.2% (6/519) | 1.2% (6/519) | 88.9% (24/27) | 0/2/5 | 4/1 | 0/0 | 0 | 13 | 7 | 8 | 0.0154 | method-no-evidence (5), method-ambiguous (4), possible-dispatch (4) |
| rich | 7.2% (36/501) | 7.2% (36/501) | 68.0% (34/50) | 0/19/20 | 28/11 | 0/0 | 0 | 164 | 104 | 93 | 0.1856 | method-no-evidence (65), method-ambiguous (49), possible-dispatch (28) |
| ripgrep | 0.4% (3/765) | 0.4% (3/765) | 85.4% (35/41) | 0/1/13 | 75/12 | 0/0 | 0 | 98 | 72 | 28 | 0.0366 | possible-dispatch (75), method-ambiguous (23) |
| viper | 0.5% (3/627) | 0.5% (3/627) | 88.0% (44/50) | 0/2/22 | 16/7 | 0/0 | 0 | 55 | 48 | 43 | 0.0686 | method-ambiguous (39), possible-dispatch (16) |
| zod | 19.9% (383/1929) | 19.9% (383/1929) | 40.0% (20/50) | 6/641/1929 | 76/16 | 0/0 | 0 | 4151 | 3766 | 3747 | 1.9425 | no-import-link (2953), method-ambiguous (1110), possible-dispatch (76) |
| zustand | 0.0% (0/208) | 0.0% (0/208) | 94.1% (16/17) | 0/2/2 | 0/0 | 0/0 | 0 | 2 | 2 | 2 | 0.0096 | ambiguous-binding (2) |

## Oracle-backed command surface

The sampled compiler/LSP symbols and references gate only commands an agent
can invoke on the v5 public surface: exact `find`, composed `show`, exact
`source`, caller `trace`, symbol `impact`, literal reference recall in
`usages`, and direct test-reference recall in `tests`. Removed internal
commands cannot make this gate pass. Command execution errors are failures.

| repo | evaluated | find | show | source | trace | impact | usages | tests | execution errors | failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chi | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (239/239) | 100.0% (153/153) | **0** | **0** |
| cjson | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (46/46) | 100.0% (46/46) | 100.0% (228/228) | 100.0% (88/88) | **0** | **0** |
| clap | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (47/47) | 100.0% (47/47) | 100.0% (728/728) | 100.0% (582/582) | **0** | **0** |
| click | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (43/43) | 100.0% (43/43) | 100.0% (838/838) | 100.0% (541/541) | **0** | **0** |
| cobra | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (47/47) | 100.0% (47/47) | 100.0% (1820/1820) | 100.0% (1350/1350) | **0** | **0** |
| cursive | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (279/279) | 100.0% (23/23) | **0** | **0** |
| express | 39/39 | 100.0% (39/39) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (59/59) | 100.0% (39/39) | **0** | **0** |
| fastify | 49/49 | 100.0% (49/49) | 100.0% (49/49) | 100.0% (49/49) | 100.0% (48/48) | 100.0% (48/48) | 100.0% (342/342) | 100.0% (272/272) | **0** | **0** |
| fmt | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (73/73) | 100.0% (53/53) | **0** | **0** |
| grpc-go | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (42/42) | 100.0% (42/42) | 100.0% (245/245) | 100.0% (196/196) | **0** | **0** |
| gson | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (40/40) | 100.0% (40/40) | 100.0% (529/529) | 100.0% (319/319) | **0** | **0** |
| hono | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (35/35) | 100.0% (35/35) | 100.0% (266/266) | 100.0% (165/165) | **0** | **0** |
| httpx | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (38/38) | 100.0% (38/38) | 100.0% (760/760) | 100.0% (608/608) | **0** | **0** |
| javapoet | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (48/48) | 100.0% (48/48) | 100.0% (130/130) | 100.0% (6/6) | **0** | **0** |
| jsoup | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (39/39) | 100.0% (39/39) | 100.0% (752/752) | 100.0% (326/326) | **0** | **0** |
| newtonsoft-json | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (46/46) | 100.0% (46/46) | 100.0% (383/383) | 100.0% (0/0) | **0** | **0** |
| preact-signals | 27/27 | 100.0% (27/27) | 100.0% (27/27) | 100.0% (27/27) | 100.0% (25/25) | 100.0% (25/25) | 100.0% (304/304) | 100.0% (278/278) | **0** | **0** |
| rich | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (38/38) | 100.0% (38/38) | 100.0% (413/413) | 100.0% (129/129) | **0** | **0** |
| ripgrep | 41/41 | 100.0% (41/41) | 100.0% (41/41) | 100.0% (41/41) | 100.0% (37/37) | 100.0% (37/37) | 100.0% (693/693) | 100.0% (0/0) | **0** | **0** |
| viper | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (49/49) | 100.0% (49/49) | 100.0% (184/184) | 100.0% (157/157) | **0** | **0** |
| zod | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (46/46) | 100.0% (46/46) | 100.0% (264/264) | 100.0% (144/144) | **0** | **0** |
| zustand | 17/17 | 100.0% (17/17) | 100.0% (17/17) | 100.0% (17/17) | 100.0% (17/17) | 100.0% (17/17) | 100.0% (222/222) | 100.0% (212/212) | **0** | **0** |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps, such as method-name conflation where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |
|---|---|---|---|---|---|---|---|---|---|
| chi | function | 22 | 293 | 100.0% (301/301) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":293,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | method | 23 | 250 | 99.3% (264/266) | 0 | 1.3% (9/714) | 135 | 0.9799 | {"confirmed":242,"unverified":8,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | class | 5 | 25 | 100.0% (25/25) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":25,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cjson | function | 46 | 1301 | 100.0% (339/339) | 0 | 100.0% (1/1) | 0 | 0 | {"confirmed":338,"unverified":1,"accountedNotShown":0,"missingExplained":962,"missingBeyondText":0,"missingUnexplained":0} |
| cjson | class | 4 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | function | 14 | 252 | 100.0% (252/252) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":252,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | method | 33 | 2562 | 100.0% (2691/2691) | 21 | 90.9% (10/11) | 1 | 0.0909 | {"confirmed":2553,"unverified":9,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | class | 3 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | function | 27 | 806 | 100.0% (815/815) | 0 | 0.0% (0/95) | 0 | 1 | {"confirmed":806,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | method | 16 | 365 | 99.7% (360/361) | 1 | 10.2% (5/49) | 759 | 0.8952 | {"confirmed":360,"unverified":5,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | class | 7 | 105 | 100.0% (106/106) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":105,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 100.0% (575/575) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":575,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 100.0% (557/557) | 0 | 20.3% (12/59) | 0 | 0.7966 | {"confirmed":556,"unverified":11,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 100.0% (409/409) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":409,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | function | 6 | 103 | 100.0% (103/103) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":103,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | method | 39 | 519 | 100.0% (395/395) | 0 | 29.9% (124/414) | 39 | 0.7005 | {"confirmed":395,"unverified":124,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cursive | class | 5 | 13 | 100.0% (12/12) | 0 | 100.0% (7/7) | 3 | 0 | {"confirmed":7,"unverified":5,"accountedNotShown":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| express | function | 39 | 262 | 100.0% (276/276) | 0 | 100.0% (4/4) | 825 | 0 | {"confirmed":261,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | function | 41 | 1395 | 100.0% (190/190) | 0 | 28.8% (1202/4168) | 353 | 0.7116 | {"confirmed":148,"unverified":1202,"accountedNotShown":43,"missingExplained":2,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | method | 7 | 123 | 100.0% (6/6) | 0 | 62.1% (113/182) | 101 | 0.3791 | {"confirmed":6,"unverified":113,"accountedNotShown":0,"missingExplained":4,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | class | 1 | 30 | 100.0% (31/31) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":30,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fmt | function | 30 | 1740 | 100.0% (1407/1407) | 36 | 68.2% (380/557) | 30 | 0.3178 | {"confirmed":1353,"unverified":316,"accountedNotShown":4,"missingExplained":67,"missingBeyondText":0,"missingUnexplained":0} |
| fmt | method | 15 | 93 | 100.0% (36/36) | 3 | 17.8% (27/152) | 28 | 0.8224 | {"confirmed":34,"unverified":25,"accountedNotShown":3,"missingExplained":31,"missingBeyondText":0,"missingUnexplained":0} |
| fmt | class | 5 | 0 | 100.0% (2/2) | 0 | 25.0% (1/4) | 0 | 0.75 | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | function | 12 | 101 | 100.0% (101/101) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":101,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | method | 30 | 19 | 100.0% (7/7) | 0 | 1.7% (12/723) | 1205 | 0.9834 | {"confirmed":7,"unverified":12,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| grpc-go | class | 8 | 388 | 100.0% (388/388) | 0 | 0.0% (0/3) | 2 | 1 | {"confirmed":388,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| gson | method | 40 | 390 | 100.0% (294/294) | 9 | 7.5% (37/494) | 134 | 0.9251 | {"confirmed":283,"unverified":37,"accountedNotShown":0,"missingExplained":70,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (123/123) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":34,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | function | 15 | 92 | 100.0% (93/93) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":92,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | method | 20 | 659 | 100.0% (132/132) | 0 | 65.4% (527/806) | 94 | 0.3462 | {"confirmed":132,"unverified":527,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| hono | class | 15 | 187 | 100.0% (188/188) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":187,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 100.0% (39/39) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":38,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 100.0% (365/365) | 2 | 0.0% (0/26) | 39 | 1 | {"confirmed":365,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 100.0% (478/478) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":476,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | method | 48 | 791 | 100.0% (782/782) | 0 | 9.7% (15/154) | 40 | 0.9026 | {"confirmed":780,"unverified":11,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | class | 2 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | method | 39 | 413 | 97.7% (383/392) | 0 | 8.7% (33/379) | 93 | 0.8899 | {"confirmed":382,"unverified":30,"accountedNotShown":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | class | 11 | 40 | 100.0% (346/346) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":40,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| newtonsoft-json | method | 46 | 1042 | 99.3% (1038/1045) | 49 | 2.8% (4/142) | 56 | 0.9651 | {"confirmed":1038,"unverified":4,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| newtonsoft-json | class | 4 | 23 | 100.0% (59/59) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":23,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | function | 14 | 475 | 100.0% (480/480) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":475,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 11 | 41 | 100.0% (38/38) | 11 | 46.2% (6/13) | 0 | 0.5385 | {"confirmed":35,"unverified":6,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 2 | 3 | 100.0% (6/6) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":3,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | function | 6 | 80 | 100.0% (81/81) | 0 | 3.3% (1/30) | 0 | 0.9667 | {"confirmed":79,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | method | 32 | 312 | 99.6% (277/278) | 8 | 43.2% (57/132) | 2 | 0.5646 | {"confirmed":277,"unverified":35,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| rich | class | 12 | 109 | 100.0% (121/121) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":109,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | function | 6 | 568 | 100.0% (568/568) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":568,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | method | 31 | 186 | 100.0% (183/183) | 0 | 4.0% (3/75) | 23 | 0.96 | {"confirmed":183,"unverified":3,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| ripgrep | class | 4 | 11 | 100.0% (11/11) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":11,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | function | 20 | 158 | 100.0% (158/158) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":158,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | method | 29 | 465 | 100.0% (462/462) | 0 | 5.9% (3/51) | 4 | 0.9412 | {"confirmed":462,"unverified":3,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| viper | class | 1 | 4 | 100.0% (4/4) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":4,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | function | 36 | 1655 | 100.0% (1442/1442) | 0 | 5.6% (213/3808) | 2 | 0.9441 | {"confirmed":1442,"unverified":213,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | method | 10 | 267 | 100.0% (81/81) | 0 | 50.0% (170/340) | 0 | 0.5 | {"confirmed":79,"unverified":170,"accountedNotShown":18,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zod | class | 4 | 7 | 100.0% (7/7) | 0 | 0.0% (0/1) | 0 | 1 | {"confirmed":7,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| zustand | function | 17 | 208 | 100.0% (213/213) | 0 | 0.0% (0/2) | 0 | 1 | {"confirmed":208,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

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
| chi | 100.0% (360/360) | 100.0% | **0** | 359 | 0 | 0 | 204 | 0 | 0 | 5 | 0 |
| cjson | 100.0% (340/340) | 100.0% | **0** | 339 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| clap | 100.0% (2528/2528) | 100.0% | **0** | 2527 | 0 | 0 | 287 | 0 | 0 | 0 | 0 |
| click | 100.0% (1050/1050) | 100.0% | **0** | 1043 | 0 | 0 | 233 | 0 | 0 | 0 | 0 |
| cobra | 100.0% (1531/1531) | 100.0% | **0** | 1531 | 0 | 0 | 13 | 0 | 0 | 7 | 0 |
| cursive | 100.0% (496/496) | 99.8% | **1** | 494 | 0 | 1 | 138 | 0 | 0 | 2 | 0 |
| express | 100.0% (15/15) | 100.0% | **0** | 15 | 0 | 0 | 0 | 0 | 0 | 247 | 0 |
| fastify | 100.0% (64/64) | 100.0% | **0** | 62 | 0 | 0 | 100 | 0 | 0 | 1380 | 0 |
| fmt | 100.0% (89/89) | 100.0% | **0** | 89 | 2 | 0 | 1632 | 0 | 0 | 12 | 0 |
| grpc-go | 100.0% (510/510) | 100.0% | **0** | 489 | 0 | 0 | 12 | 0 | 0 | 7 | 0 |
| gson | 100.0% (188/188) | 100.0% | **0** | 187 | 0 | 0 | 157 | 0 | 0 | 10 | 0 |
| hono | 100.0% (56/56) | 100.0% | **0** | 56 | 0 | 0 | 326 | 0 | 0 | 556 | 0 |
| httpx | 100.0% (432/432) | 100.0% | **0** | 430 | 0 | 0 | 449 | 0 | 0 | 0 | 0 |
| javapoet | 100.0% (593/593) | 100.0% | **0** | 590 | 0 | 0 | 152 | 0 | 0 | 49 | 0 |
| jsoup | 100.0% (398/398) | 100.0% | **0** | 398 | 0 | 0 | 39 | 0 | 0 | 16 | 0 |
| newtonsoft-json | 100.0% (1048/1048) | 100.0% | **0** | 1048 | 0 | 0 | 7 | 0 | 0 | 10 | 0 |
| preact-signals | 100.0% (16/16) | 100.0% | **0** | 16 | 0 | 0 | 12 | 0 | 0 | 491 | 0 |
| rich | 100.0% (353/353) | 100.0% | **0** | 349 | 0 | 0 | 30 | 0 | 0 | 122 | 0 |
| ripgrep | 100.0% (738/738) | 100.0% | **0** | 738 | 0 | 0 | 27 | 0 | 0 | 0 | 0 |
| viper | 100.0% (600/600) | 100.0% | **0** | 589 | 0 | 0 | 38 | 0 | 0 | 0 | 0 |
| zod | 100.0% (81/81) | 100.0% | **0** | 80 | 0 | 0 | 93 | 0 | 0 | 1756 | 0 |
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
| chi | 393 | 8 | 372 | 359 | 0 | **0** | 135 | 0 | **0** |
| cjson | 1 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| clap | 2363 | 9 | 2234 | 0 | 0 | **0** | 22 | 2 | **0** |
| click | 684 | 5 | 684 | 0 | 0 | **0** | 760 | 0 | **0** |
| cobra | 135 | 0 | 134 | 0 | 0 | **0** | 0 | 0 | **0** |
| cursive | 239 | 129 | 372 | 8 | 0 | **0** | 42 | 0 | **0** |
| express | 218 | 2 | 204 | 0 | 0 | **0** | 825 | 0 | **0** |
| fastify | 62 | 1219 | 1312 | 14 | 109 | **0** | 454 | 0 | **0** |
| fmt | 56 | 67 | 0 | 0 | 0 | **0** | 97 | 0 | **0** |
| grpc-go | 293 | 12 | 326 | 333 | 0 | **0** | 1207 | 0 | **0** |
| gson | 215 | 27 | 243 | 136 | 91 | **0** | 143 | 0 | **0** |
| hono | 237 | 527 | 770 | 0 | 59 | **0** | 94 | 0 | **0** |
| httpx | 237 | 0 | 237 | 0 | 0 | **0** | 41 | 2 | **0** |
| javapoet | 657 | 15 | 671 | 21 | 27 | **0** | 40 | 0 | **0** |
| jsoup | 290 | 8 | 293 | 201 | 14 | **0** | 93 | 0 | **0** |
| newtonsoft-json | 725 | 4 | 693 | 0 | 0 | **0** | 105 | 4 | **0** |
| preact-signals | 234 | 6 | 232 | 5 | 11 | **0** | 11 | 0 | **0** |
| rich | 206 | 46 | 228 | 0 | 0 | **0** | 10 | 0 | **0** |
| ripgrep | 70 | 3 | 74 | 0 | 0 | **0** | 23 | 0 | **0** |
| viper | 446 | 3 | 458 | 41 | 0 | **0** | 4 | 0 | **0** |
| zod | 1316 | 357 | 1765 | 13 | 0 | **0** | 2 | 0 | **0** |
| zustand | 5 | 0 | 2 | 0 | 0 | **0** | 0 | 0 | **0** |
