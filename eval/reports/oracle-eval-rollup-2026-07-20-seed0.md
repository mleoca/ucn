# Oracle eval: 2026-07-20

UCN tiered caller answers scored against compiler/LSP ground truth.
`semantic-missing` is the release gate: every indexed, in-scope oracle
call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it
inside a non-call/excluded count is not enough. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |
|---|---|---|---|---|---|---|---|---|---|
| clap | rust-analyzer | 50 | 2209 | 100.0% | 100.0% | **0** | 45.3% | 100.0% (12) | 100.0% |
| fastify | ts-morph | 45 | 1443 | 100.0% | 100.0% | **0** | 79.6% | n/a (0) | 100.0% |
| jsoup | jdtls | 50 | 432 | 96.1% | 100.0% | **0** | 7.1% | 100.0% (3) | 100.0% |

## Oracle-backed command surface

The sampled compiler/LSP symbols and references also gate exact definition
discovery, `find`, source extraction (`fn`/`class`), `brief`, `typedef`,
literal code-reference recall in `usages`, direct test-reference recall in
`tests`, and compiler-true selection by `example`. Command execution errors
are failures; they can no longer silently reduce the evaluated sample.

| repo | evaluated | definition | find | extract | brief | typedef | usages | tests | example | execution errors | failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| clap | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (2/2) | 100.0% (256/256) | 100.0% (132/132) | 100.0% (33/33) | **0** | **0** |
| fastify | 45/45 | 100.0% (45/45) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (45/45) | 100.0% (1/1) | 100.0% (149/149) | 100.0% (77/77) | 100.0% (24/24) | **0** | **0** |
| jsoup | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (7/7) | 100.0% (94/94) | 100.0% (43/43) | 93.3% (28/30) | **0** | **2** |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps, such as method-name conflation where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |
|---|---|---|---|---|---|---|---|---|---|
| clap | function | 17 | 28 | 100.0% (20/20) | 0 | 61.5% (8/13) | 0 | 0.3846 | {"confirmed":20,"unverified":8,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | method | 31 | 2180 | 100.0% (1774/1774) | 6 | 45.0% (407/905) | 54 | 0.5503 | {"confirmed":1774,"unverified":406,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | class | 2 | 1 | n/a (0/0) | 0 | 100.0% (1/1) | 0 | n/a | {"confirmed":0,"unverified":1,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | function | 40 | 1377 | 100.0% (137/137) | 0 | 89.8% (1255/1397) | 0 | 0.1016 | {"confirmed":121,"unverified":1254,"accountedNotShown":0,"missingExplained":2,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | method | 4 | 36 | 100.0% (6/6) | 0 | 13.8% (30/217) | 0 | 0.8618 | {"confirmed":6,"unverified":30,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | class | 1 | 30 | 100.0% (31/31) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":30,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | method | 43 | 412 | 95.6% (285/298) | 0 | 7.1% (130/1837) | 0 | 0.8856 | {"confirmed":284,"unverified":128,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | class | 7 | 20 | 100.0% (34/34) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":20,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

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
| clap | 100.0% (1911/1912) | 99.7% | **6** | 1908 | 0 | 6 | 275 | 20 | 0 | 0 | 0 |
| fastify | 100.0% (62/62) | 100.0% | **0** | 60 | 0 | 0 | 81 | 0 | 0 | 1300 | 0 |
| jsoup | 100.0% (236/236) | 100.0% | **0** | 234 | 0 | 0 | 196 | 0 | 0 | 2 | 0 |

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
| clap | 1643 | 316 | 1958 | 0 | 0 | **0** | 60 | 0 | **0** |
| fastify | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| jsoup | 255 | 115 | 357 | 150 | 14 | **0** | 0 | 0 | **0** |
