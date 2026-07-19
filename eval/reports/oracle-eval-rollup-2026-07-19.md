# Oracle eval — 2026-07-19

UCN tiered caller answers scored against compiler/LSP ground truth.
`semantic-missing` is the release gate: every indexed, in-scope oracle
call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it
inside a non-call/excluded count is not enough. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |
|---|---|---|---|---|---|---|---|---|---|
| preact-signals | ts-morph | 25 | 24 | 100.0% | 100.0% | **0** | 4.3% | 100.0% (3) | 100.0% |
| httpx | pyright | 50 | 879 | 100.0% | 100.0% | **0** | 36.9% | 100.0% (7) | 100.0% |
| cobra | gopls | 50 | 1551 | 100.0% | 100.0% | **0** | 20.3% | 100.0% (13) | 100.0% |
| clap | rust-analyzer | 50 | 2814 | 100.0% | 100.0% | **0** | 66.5% | 100.0% (13) | 100.0% |
| javapoet | jdtls | 50 | 794 | 100.0% | 100.0% | **0** | 8.5% | 100.0% (6) | 100.0% |

## Oracle-backed command surface

The sampled compiler/LSP symbols and references also gate exact definition
discovery, `find`, source extraction (`fn`/`class`), `brief`, `typedef`,
literal code-reference recall in `usages`, direct test-reference recall in
`tests`, and compiler-true selection by `example`. Command execution errors
are failures; they can no longer silently reduce the evaluated sample.

| repo | evaluated | definition | find | extract | brief | typedef | usages | tests | example | execution errors | failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| preact-signals | 25/25 | 100.0% (25/25) | 100.0% (25/25) | 100.0% (25/25) | 100.0% (25/25) | 100.0% (1/1) | 100.0% (24/24) | 100.0% (0/0) | 100.0% (11/11) | **0** | **0** |
| httpx | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (12/12) | 100.0% (760/760) | 100.0% (608/608) | 100.0% (27/27) | **0** | **0** |
| cobra | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (3/3) | 100.0% (1820/1820) | 100.0% (1350/1350) | 100.0% (34/34) | **0** | **0** |
| clap | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (3/3) | 100.0% (728/728) | 100.0% (582/582) | 100.0% (35/35) | **0** | **0** |
| javapoet | 50/50 | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (50/50) | 100.0% (2/2) | 100.0% (130/130) | 100.0% (6/6) | 100.0% (32/32) | **0** | **0** |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |
|---|---|---|---|---|---|---|---|---|---|
| preact-signals | function | 13 | 17 | 100.0% (19/19) | 0 | 0.0% (0/2) | 0 | 1 | {"confirmed":17,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | method | 11 | 5 | 100.0% (5/5) | 0 | 4.7% (2/43) | 0 | 0.9535 | {"confirmed":3,"unverified":2,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| preact-signals | class | 1 | 2 | 100.0% (3/3) | 0 | 0.0% (0/2) | 0 | 1 | {"confirmed":2,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | function | 8 | 38 | 100.0% (38/38) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":38,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | method | 30 | 365 | 100.0% (357/357) | 0 | 3.7% (8/217) | 0 | 0.9631 | {"confirmed":357,"unverified":8,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| httpx | class | 12 | 476 | 100.0% (364/364) | 0 | 100.0% (114/114) | 0 | 0 | {"confirmed":362,"unverified":114,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | function | 29 | 575 | 100.0% (575/575) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":575,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | method | 18 | 567 | 100.0% (557/557) | 0 | 20.3% (12/59) | 0 | 0.7966 | {"confirmed":556,"unverified":11,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| cobra | class | 3 | 409 | 100.0% (409/409) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":409,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | function | 14 | 252 | 100.0% (252/252) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":252,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | method | 33 | 2562 | 100.0% (1772/1772) | 8 | 66.5% (928/1396) | 159 | 0.3352 | {"confirmed":1772,"unverified":790,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| clap | class | 3 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | method | 48 | 794 | 100.0% (548/548) | 0 | 8.5% (266/3138) | 0 | 0.9152 | {"confirmed":546,"unverified":248,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | class | 2 | 0 | n/a (0/0) | 0 | n/a (0/0) | 0 | n/a | {"confirmed":0,"unverified":0,"accountedNotShown":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the exact site as confirmed or unverified. Account-only and
same-name-other-definition placements are semantic misses unless
exact definition lookup proves the reference search expanded a
virtual-method family and UCN selected the actual static target.

| repo | callee precision | semantic recall | semantic missing | confirmed | oracle-broad | other-def | unverified | unverified+other | accounted | module-level | beyond-text |
|---|---|---|---|---|---|---|---|---|---|---|---|
| preact-signals | 100.0% (13/13) | 100.0% | **0** | 13 | 0 | 0 | 7 | 0 | 0 | 4 | 0 |
| httpx | 100.0% (424/424) | 100.0% | **0** | 422 | 0 | 0 | 457 | 0 | 0 | 0 | 0 |
| cobra | 100.0% (1531/1531) | 100.0% | **0** | 1531 | 0 | 0 | 13 | 0 | 0 | 7 | 0 |
| clap | 100.0% (2274/2274) | 100.0% | **0** | 2273 | 0 | 0 | 521 | 20 | 0 | 0 | 0 |
| javapoet | 100.0% (434/434) | 100.0% | **0** | 431 | 0 | 0 | 312 | 2 | 0 | 49 | 0 |

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
| preact-signals | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| httpx | 0 | 0 | 0 | 0 | 0 | **0** | 0 | 0 | **0** |
| cobra | 135 | 0 | 134 | 0 | 0 | **0** | 0 | 0 | **0** |
| clap | 1904 | 467 | 2233 | 0 | 0 | **0** | 167 | 2 | **0** |
| javapoet | 423 | 263 | 668 | 42 | 3 | **0** | 0 | 0 | **0** |
