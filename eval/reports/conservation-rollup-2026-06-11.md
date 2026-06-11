# Conservation baseline — 2026-06-11

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 3 | 23 | 23 | 183.4 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 33 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 31.4 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 1 | 27.7 |
| ripgrep | rust | 100 | 24 | 100.0% | 11 | 175 | 0 | 151.2 |
| gson | java | 210 | 24 | 100.0% | 2 | 31 | 11 | 39.9 |
