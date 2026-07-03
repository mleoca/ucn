# Conservation baseline — 2026-07-03

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 15 | 0/20 | 51.9 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 8.3 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16.1 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.2 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 29.5 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 15.4 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 133.6 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 35.5 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16.4 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 19.3 |
| clap | rust | 330 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 45 |
