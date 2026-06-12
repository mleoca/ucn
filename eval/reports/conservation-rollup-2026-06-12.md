# Conservation baseline — 2026-06-12

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 46.8 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 7.9 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 15.4 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 15.4 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 27.2 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 11.3 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 290.4 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 30.8 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 18.1 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 17.8 |
