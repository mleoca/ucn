# Oracle eval — 2026-07-14 (Java repos only)

Scope: gson / javapoet / jsoup — the three Java pinned repos, re-swept
because fix #270 changed the Java parser (interface extends recorded).
Not a full 19-repo board; the last full sweep is the previous dated
rollup.

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| gson | jdtls | 50 | 649 | 96.6% | 30.4% | 0.6618 | **0** | 100.0% (9) | 100.0% |
| javapoet | jdtls | 50 | 836 | 100.0% | 16.7% | 0.8335 | **0** | 100.0% (6) | 100.0% |
| jsoup | jdtls | 50 | 667 | 100.0% | 47.7% | 0.5233 | **0** | 100.0% (3) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| gson | method | 40 | 615 | 96.2% (281/292) | 30.4% (197/647) | 0.6578 | {"confirmed":281,"unverified":195,"reportedNonCall":7,"missingExplained":132,"missingBeyondText":0,"missingUnexplained":0} |
| gson | class | 10 | 34 | 100.0% (34/34) | n/a (0/0) | n/a | {"confirmed":34,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | method | 48 | 836 | 100.0% (429/429) | 16.7% (384/2306) | 0.8335 | {"confirmed":427,"unverified":378,"reportedNonCall":31,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | class | 2 | 0 | n/a (0/0) | n/a (0/0) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | method | 39 | 627 | 100.0% (355/355) | 47.7% (245/514) | 0.5233 | {"confirmed":355,"unverified":244,"reportedNonCall":28,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | class | 11 | 40 | 100.0% (61/61) | n/a (0/0) | n/a | {"confirmed":40,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| gson | 97.5% (307/315) | 307 | 69 | 103 | 0 | 38 | 0 | **0** |
| javapoet | 99.1% (344/347) | 340 | 277 | 170 | 0 | 49 | 0 | **0** |
| jsoup | 99.8% (418/419) | 418 | 143 | 83 | 4 | 19 | 0 | **0** |
