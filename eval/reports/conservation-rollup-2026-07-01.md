# Conservation baseline — 2026-07-01

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 0/20 | 371 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 41.3 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 90.3 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 73.2 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 211.8 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 69.5 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 867.8 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 73.3 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 0/20 | 48.6 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 27.9 |
