# UCN performance gate — 2026-07-19

Real pinned repositories; cold AST build, persisted-index load, first semantic query, and steady-state pinned `context` board.

| repo | files | LOC | cold | LOC/s | cache load | first query | warm/cold | query p50 | query p95 | RSS | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| preact-signals | 2 | 4196 | 195.435ms | 21470.054 | 1.024ms | 12.395ms | 0.069 | 1.951ms | 18.108ms | 260.8MB | PASS |
| httpx | 61 | 17807 | 757.213ms | 23516.501 | 5.483ms | 155.624ms | 0.213 | 3.612ms | 29.347ms | 492MB | PASS |
| cobra | 36 | 16765 | 663.281ms | 25275.863 | 2.821ms | 62.077ms | 0.098 | 2.39ms | 5.559ms | 557.8MB | PASS |
| clap | 330 | 83356 | 1325.387ms | 62891.82 | 16.735ms | 453.348ms | 0.355 | 18.361ms | 139.647ms | 994.9MB | PASS |
| javapoet | 39 | 12212 | 488.099ms | 25019.514 | 3.698ms | 38.733ms | 0.087 | 3.528ms | 45.546ms | 1120.7MB | PASS |

Budgets: {"minColdLocPerSec":10000,"maxCacheLoadMs":1500,"maxFirstQueryMs":500,"maxWarmColdRatio":0.65,"maxQueryP50Ms":75,"maxQueryP95Ms":250,"maxRssMb":1536}.