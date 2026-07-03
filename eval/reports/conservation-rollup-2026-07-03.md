# Conservation baseline — 2026-07-03

Symbols sampled per repo, stratified by usage count. `gap symbols` are
symbols where the ground set contains AST call lines the engine did not
claim — callers an agent would never see (the silent false negatives the
tiered caller contract eliminates).

| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |
|---|---|---|---|---|---|---|---|---|---|
| zod | typescript | 287 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 37.4 |
| preact-signals | typescript | 2 | 23 | 100.0% | 0 | 0 | 0 | 0/20 | 10.1 |
| express | javascript | 150 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 16 |
| httpx | python | 61 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 17.7 |
| rich | python | 213 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 29.6 |
| cobra | go | 36 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 12.4 |
| grpc-go | go | 1037 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 125.3 |
| ripgrep | rust | 100 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 37.2 |
| cursive | rust | 187 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 18.2 |
| gson | java | 210 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 24.7 |
| clap | rust | 330 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 47.2 |
| hono | typescript | 367 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 30 |
| zustand | typescript | 52 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 7.5 |
| viper | go | 33 | 24 | 100.0% | 11 | 11 | 0 | 0/20 | 10.7 |
| chi | go | 78 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 9 |
| javapoet | java | 39 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 10 |
| jsoup | java | 223 | 24 | 100.0% | 0 | 0 | 0 | 0/20 | 41 |
