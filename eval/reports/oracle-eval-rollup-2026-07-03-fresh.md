# Oracle eval — 2026-07-03 (fresh-repo arm: unpinned rotation)

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| chi | gopls | 50 | 926 | 98.8% | 57.1% | 0.4165 | **0** | 100.0% (11) | 100.0% |
| javapoet | jdtls | 50 | 836 | 100.0% | 16.7% | 0.8335 | **0** | 100.0% (6) | 100.0% |
| jsoup | jdtls | 50 | 667 | 100.0% | 46.5% | 0.5354 | **0** | 100.0% (3) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| chi | function | 22 | 293 | 98.0% (295/301) | n/a (0/0) | n/a | {"confirmed":293,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | method | 23 | 608 | 100.0% (154/154) | 57.1% (197/345) | 0.429 | {"confirmed":154,"unverified":196,"reportedNonCall":258,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| chi | class | 5 | 25 | 100.0% (25/25) | n/a (0/0) | n/a | {"confirmed":25,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | method | 48 | 836 | 100.0% (429/429) | 16.7% (384/2306) | 0.8335 | {"confirmed":427,"unverified":378,"reportedNonCall":31,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| javapoet | class | 2 | 0 | n/a (0/0) | n/a (0/0) | n/a | {"confirmed":0,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | method | 39 | 627 | 100.0% (355/355) | 46.5% (236/508) | 0.5354 | {"confirmed":355,"unverified":235,"reportedNonCall":37,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| jsoup | class | 11 | 40 | 100.0% (61/61) | n/a (0/0) | n/a | {"confirmed":40,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| chi | 100.0% (355/355) | 354 | 327 | 240 | 0 | 5 | 0 | **0** |
| javapoet | 99.1% (344/347) | 340 | 277 | 170 | 0 | 49 | 0 | **0** |
| jsoup | 99.8% (418/419) | 418 | 143 | 83 | 4 | 19 | 0 | **0** |
