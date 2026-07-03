# Conservation baseline — 2026-07-03

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 40.5 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 1 | 0/20 | 8.7 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16.5 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.8 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30.1 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 13.1 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 131.5 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 39 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.2 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 21.8 |
| clap | rust | 330 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 52.6 |
| hono | typescript | 367 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 32.3 |
| zustand | typescript | 52 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 10.6 |
| viper | go | 33 | 24 | 100.0% | 11 | 11 | 0 | 0/20 | 13 |
