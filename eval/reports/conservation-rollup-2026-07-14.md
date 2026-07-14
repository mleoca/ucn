# Conservation baseline — 2026-07-14

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| jsoup | java | 223 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 49.6 |
