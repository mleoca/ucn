# Conservation baseline — 2026-06-12

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 45.7 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 7.7 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 18 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 16.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 26.7 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 11.2 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 285.3 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 30.1 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 20.6 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 16.6 |
