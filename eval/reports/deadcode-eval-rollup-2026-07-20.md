# Deadcode eval: 2026-07-20

Every symbol UCN deadcode reports unused is checked against compiler/LSP
ground truth. `false-dead` = the oracle found a reference UCN's usage
scan missed; deleting the symbol breaks the code. Gate: default-arm
false-dead = 0.

| repo | oracle | arm | claims | sampled | agreed-dead | false-dead | outside-universe | unpinnable |
|---|---|---|---|---|---|---|---|---|
| preact-signals | ts-morph | default | 0 | 0 | 0 | **0** | 0 | 0 |
| httpx | pyright | default | 1 | 1 | 1 | **0** | 0 | 0 |
| cobra | gopls | default | 0 | 0 | 0 | **0** | 0 | 0 |
| viper | gopls | default | 2 | 2 | 2 | **0** | 0 | 0 |
| ripgrep | rust-analyzer | default | 8 | 8 | 8 | **0** | 0 | 0 |
| clap | rust-analyzer | default | 7 | 7 | 7 | **0** | 0 | 0 |
| javapoet | jdtls | default | 1 | 1 | 1 | **0** | 0 | 0 |
