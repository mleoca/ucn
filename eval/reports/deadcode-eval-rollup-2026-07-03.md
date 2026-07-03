# Deadcode eval — 2026-07-03

Every symbol UCN deadcode reports unused is checked against compiler/LSP
ground truth. `false-dead` = the oracle found a reference UCN's usage
scan missed — deleting the symbol breaks the code. Gate: default-arm
false-dead = 0.

| repo | oracle | arm | claims | sampled | agreed-dead | false-dead | outside-universe | unpinnable |
|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| zod | ts-morph | exported | 48 | 48 | 36 | **0** | 0 | 12 |
| preact-signals | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| preact-signals | ts-morph | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| express | ts-morph | exported | 2 | 2 | 2 | **0** | 0 | 0 |
| httpx | pyright | default | 0 | 0 | 0 | **0** | 0 | 0 |
| httpx | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| rich | pyright | default | 34 | 34 | 34 | **0** | 0 | 0 |
| rich | pyright | exported | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | default | 0 | 0 | 0 | **0** | 0 | 0 |
| cobra | gopls | exported | 25 | 25 | 25 | **0** | 0 | 0 |
| grpc-go | gopls | default | 84 | 60 | 60 | **0** | 0 | 0 |
| grpc-go | gopls | exported | 842 | 60 | 59 | **0** | 0 | 1 |
| ripgrep | rust-analyzer | default | 2 | 2 | 2 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | exported | 16 | 16 | 16 | **0** | 0 | 0 |
| cursive | rust-analyzer | default | 0 | 0 | 0 | **0** | 0 | 0 |
| cursive | rust-analyzer | exported | 147 | 60 | 60 | **0** | 0 | 0 |
| gson | jdtls | default | 2 | 2 | 2 | **0** | 0 | 0 |
| gson | jdtls | exported | 0 | 0 | 0 | **0** | 0 | 0 |
