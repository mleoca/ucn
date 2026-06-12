# Conservation baseline — 2026-06-12

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 45.8 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 8.3 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 19.3 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 16.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 27.5 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 12.8 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 283.7 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 30.5 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 21.3 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 16.5 |
