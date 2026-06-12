# Conservation baseline — 2026-06-12

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 176.1 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 35.4 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 34.1 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 27.8 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 347.4 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 83.6 |
| cursive | rust | 187 | 24 | 100.0% | 1 | 1 | 0 | 57.9 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 32.7 |
