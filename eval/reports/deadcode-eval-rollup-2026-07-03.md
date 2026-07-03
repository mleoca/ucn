# Deadcode eval — 2026-07-03

Every symbol UCN deadcode reports unused is checked against compiler/LSP
ground truth. `false-dead` = the oracle found a reference UCN's usage
scan missed — deleting the symbol breaks the code. Gate: default-arm
false-dead = 0.

| repo | oracle | arm | claims | sampled | agreed-dead | false-dead | outside-universe | unpinnable |
|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| zod | ts-morph | exported | 72 | 60 | 60 | **0** | 0 | 0 |
| preact-signals | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| preact-signals | ts-morph | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | exported | 4 | 4 | 4 | **0** | 0 | 0 |
| httpx | pyright | default | 1 | 1 | 1 | **0** | 0 | 0 |
| httpx | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| rich | pyright | default | 45 | 45 | 45 | **0** | 0 | 0 |
| rich | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | default | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | exported | 28 | 28 | 28 | **0** | 0 | 0 |
| grpc-go | gopls | default | 84 | 60 | 60 | **0** | 0 | 0 |
| grpc-go | gopls | exported | 868 | 60 | 60 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | default | 8 | 8 | 8 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | exported | 28 | 28 | 28 | **0** | 0 | 0 |
| cursive | rust-analyzer | default | 7 | 7 | 7 | **0** | 0 | 0 |
| cursive | rust-analyzer | exported | 154 | 60 | 60 | **0** | 0 | 0 |
| gson | jdtls | default | 2 | 2 | 2 | **0** | 0 | 0 |
| gson | jdtls | exported | 1 | 1 | 1 | **0** | 0 | 0 |
