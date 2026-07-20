# UCN performance gate - 2026-07-20

Real pinned repositories; cold AST build, 3 isolated persisted-index startup samples, and a steady-state pinned `context` board.

| repo | files | LOC | cold | LOC/s | cache load median | first query median/max | warm/cold | query p50 | query p95 | peak RSS | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| preact-signals | 2 | 4196 | 194.962ms | 21522.143 | 0.602ms | 4.032/13.385ms | 0.024 | 3.171ms | 17.808ms | 284.6MB | PASS |
| httpx | 61 | 17807 | 1635.041ms | 10890.858 | 10.979ms | 260.49/349.353ms | 0.166 | 7.698ms | 68.513ms | 359.1MB | PASS |
| cobra | 36 | 16765 | 679.798ms | 24661.738 | 2.547ms | 56.664/75.038ms | 0.087 | 2.393ms | 4.152ms | 309.4MB | PASS |
| viper | 33 | 7194 | 319.286ms | 22531.523 | 1.995ms | 9.12/14.802ms | 0.035 | 3.044ms | 10.948ms | 254.4MB | PASS |
| ripgrep | 100 | 52338 | 1669.438ms | 31350.67 | 13.978ms | 192.936/227.838ms | 0.124 | 10.592ms | 153.891ms | 903.5MB | PASS |
| clap | 330 | 83356 | 987.598ms | 84402.763 | 17.343ms | 299.449/418.177ms | 0.321 | 17.745ms | 122.486ms | 892.6MB | PASS |
| javapoet | 39 | 12212 | 466.367ms | 26185.386 | 3.329ms | 35.102/41.9ms | 0.082 | 3.329ms | 32.587ms | 334.7MB | PASS |

Budgets: {"minColdLocPerSec":10000,"maxCacheLoadMs":1500,"maxFirstQueryMs":500,"maxWarmColdRatio":0.65,"maxQueryP50Ms":75,"maxQueryP95Ms":250,"maxRssMb":1536}.