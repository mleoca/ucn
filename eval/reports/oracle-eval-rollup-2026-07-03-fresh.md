# Oracle eval — 2026-07-03 (fresh-repo arm: unpinned rotation)

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the tiered caller contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| click | pyright | 50 | 1276 | 99.0% | 5.4% | 0.9354 | **0** | 100.0% (12) | 100.0% |
| fastify | ts-morph | 45 | 215 | 99.6% | 1.8% | 0.9775 | **0** | 100.0% (2) | 100.0% |

## Per-kind breakdown

Same metrics split by symbol kind (function / method / class), to
localize precision gaps — e.g. method-name conflation, where import
evidence confirms the file but not the receiver type.

| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |
|---|---|---|---|---|---|---|---|
| click | function | 27 | 806 | 100.0% (785/785) | 18.5% (22/119) | 0.8151 | {"confirmed":784,"unverified":22,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | method | 16 | 365 | 96.2% (329/342) | 3.4% (26/768) | 0.9281 | {"confirmed":329,"unverified":26,"reportedNonCall":10,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| click | class | 7 | 105 | 100.0% (106/106) | n/a (0/0) | n/a | {"confirmed":105,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | function | 36 | 157 | 100.0% (195/195) | 0.1% (2/1321) | 0.9985 | {"confirmed":154,"unverified":2,"reportedNonCall":1,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | method | 2 | 28 | 75.0% (3/4) | 15.3% (25/163) | 0.5966 | {"confirmed":3,"unverified":25,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |
| fastify | class | 1 | 30 | 100.0% (31/31) | n/a (0/0) | n/a | {"confirmed":30,"unverified":0,"reportedNonCall":0,"missingExplained":0,"missingBeyondText":0,"missingUnexplained":0} |

## Callee arm (trace-down contract)

The same oracle edges re-read from the CALLER side: for each oracle
call ref of a sampled symbol, the enclosing function's callee answer
(findCallees collectAccount — the trace-down engine path) must show
the site (confirmed edge / unverified entry) or account for it
(conserved bucket). `callee-missing-unexplained` gates at 0.

| repo | callee precision | confirmed | other-def | unverified | accounted | module-level | beyond-text | **missing-unexplained** |
|---|---|---|---|---|---|---|---|---|
| click | 99.0% (191/193) | 187 | 54 | 1014 | 21 | 0 | 0 | **0** |
| fastify | 93.2% (55/59) | 53 | 2 | 4 | 5 | 151 | 0 | **0** |
