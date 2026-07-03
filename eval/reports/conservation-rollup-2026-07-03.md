# Conservation baseline — 2026-07-03

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 15 | 0/20 | 47.3 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 10.7 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 15.9 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 29.5 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 11.8 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 313.3 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 36.7 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 18.7 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 18.8 |
