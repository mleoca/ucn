# Deadcode eval — 2026-06-12

Every symbol UCN deadcode reports unused is checked against compiler/LSP
ground truth. `false-dead` = the oracle found a reference UCN's usage
scan missed — deleting the symbol breaks the code. Gate: default-arm
false-dead = 0.

| repo | oracle | arm | claims | sampled | agreed-dead | false-dead | outside-universe | unpinnable |
|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| zod | ts-morph | exported | 30 | 30 | 30 | **0** | 0 | 0 |
| preact-signals | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| preact-signals | ts-morph | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | exported | 2 | 2 | 2 | **0** | 0 | 0 |
| httpx | pyright | default | 0 | 0 | 0 | **0** | 0 | 0 |
| httpx | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| rich | pyright | default | 27 | 27 | 27 | **0** | 0 | 0 |
| rich | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | default | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | exported | 20 | 20 | 20 | **0** | 0 | 0 |
| grpc-go | gopls | default | 11 | 11 | 11 | **0** | 0 | 0 |
| grpc-go | gopls | exported | 280 | 280 | 280 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | default | 0 | 0 | 0 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | exported | 13 | 13 | 13 | **0** | 0 | 0 |
| cursive | rust-analyzer | default | 0 | 0 | 0 | **0** | 0 | 0 |
| cursive | rust-analyzer | exported | 130 | 130 | 130 | **0** | 0 | 0 |
| gson | jdtls | default | 0 | 0 | 0 | **0** | 0 | 0 |
| gson | jdtls | exported | 0 | 0 | 0 | **0** | 0 | 0 |
