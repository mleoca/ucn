# Conservation baseline — 2026-06-12

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 0/20 | 47.7 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 7.9 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 15.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30.5 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 12.1 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 287.9 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30.3 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 0/20 | 16.9 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.4 |
