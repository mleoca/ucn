# Conservation baseline — 2026-07-02

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 15 | 0/20 | 48.8 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 10.4 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16.1 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.8 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 11.9 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 317.1 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 36.8 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16.8 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 21.2 |
