# Conservation baseline — 2026-07-02

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 15 | 0/20 | 49.1 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 9 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 15.5 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.5 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 32.6 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 14 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 320.3 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 36.8 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 0/20 | 18.9 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 21 |
