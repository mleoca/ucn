# Conservation baseline — 2026-06-11

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 30 | 175.3 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 32.6 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 31 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 1 | 29.5 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 83.6 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 36.3 |
