# Conservation baseline — 2026-07-03

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 39.1 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 8.8 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.7 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 19.3 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 31.2 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 11.6 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 136 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 34.7 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 21.1 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 18.3 |
| clap | rust | 330 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 46.5 |
| hono | typescript | 367 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 32.2 |
| zustand | typescript | 52 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 8.1 |
