# Conservation baseline — 2026-06-11

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
grep-reliability contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | avg ms/account |
|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 4 | 27 | 57 | 186.2 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 35.8 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 38 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 1 | 31.6 |
| ripgrep | rust | 100 | 24 | 100.0% | 11 | 175 | 0 | 147 |
| gson | java | 210 | 24 | 100.0% | 2 | 31 | 11 | 40.9 |
