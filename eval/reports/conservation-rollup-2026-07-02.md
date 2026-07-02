# Conservation baseline — 2026-07-02

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 15 | 0/20 | 48.5 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 8.4 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 15.8 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30.8 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 12 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 314.7 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 38 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 18 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 21.3 |
