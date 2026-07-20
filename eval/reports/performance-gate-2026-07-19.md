# UCN performance gate - 2026-07-19

Real pinned repositories; cold AST build, 3 isolated persisted-index startup samples, and a steady-state pinned `context` board.

| repo | files | LOC | cold | LOC/s | cache load median | first query median/max | warm/cold | query p50 | query p95 | peak RSS | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| preact-signals | 2 | 4196 | 184.677ms | 22720.75 | 0.588ms | 4.146/13.72ms | 0.026 | 1.694ms | 16.901ms | 237.6MB | PASS |
| httpx | 61 | 17807 | 865.199ms | 20581.392 | 4.993ms | 172.109/222.798ms | 0.205 | 3.833ms | 26.173ms | 428.3MB | PASS |
| cobra | 36 | 16765 | 698.002ms | 24018.556 | 2.54ms | 54.358/71.946ms | 0.082 | 2.164ms | 4.357ms | 312.7MB | PASS |
| clap | 330 | 83356 | 1004.663ms | 82969.115 | 16.061ms | 290.523/390.497ms | 0.305 | 14.359ms | 148.354ms | 764.8MB | PASS |
| javapoet | 39 | 12212 | 432.533ms | 28233.684 | 3.356ms | 34.863/38.646ms | 0.088 | 2.803ms | 29.826ms | 336.9MB | PASS |

Budgets: {"minColdLocPerSec":10000,"maxCacheLoadMs":1500,"maxFirstQueryMs":500,"maxWarmColdRatio":0.65,"maxQueryP50Ms":75,"maxQueryP95Ms":250,"maxRssMb":1536}.