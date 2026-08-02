# UCN performance gate - 2026-08-02

Real pinned repositories; cold AST build, 3 isolated persisted-index startup samples, and a steady-state pinned `context` board.

| repo | files | LOC | cold | LOC/s | cache load median | first query median/max | warm/cold | query p50 | query p95 | peak RSS | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| preact-signals | 2 | 4196 | 219.977ms | 19074.721 | 0.656ms | 5.09/13.641ms | 0.026 | 2.658ms | 10.687ms | 166.3MB | PASS |
| httpx | 61 | 17807 | 1146.845ms | 15526.946 | 5.033ms | 13.399/20.823ms | 0.016 | 2.788ms | 22.11ms | 292.5MB | PASS |
| cobra | 36 | 16765 | 595.327ms | 28160.994 | 2.589ms | 12.842/21.526ms | 0.026 | 2.335ms | 5.339ms | 263.5MB | PASS |
| viper | 33 | 7194 | 317.442ms | 22662.408 | 1.837ms | 8.084/14.381ms | 0.031 | 2.671ms | 5.06ms | 194.8MB | PASS |
| ripgrep | 100 | 52338 | 1462.821ms | 35778.814 | 15.629ms | 67.101/69.38ms | 0.057 | 8.596ms | 45.659ms | 564.6MB | PASS |
| clap | 330 | 83356 | 1226.382ms | 67969.034 | 16.843ms | 100.334/136.363ms | 0.096 | 14.531ms | 42.98ms | 597.8MB | PASS |
| javapoet | 39 | 12212 | 565.003ms | 21614.045 | 3.428ms | 34.125/41.221ms | 0.066 | 2.863ms | 16.024ms | 253.5MB | PASS |
| newtonsoft-json | 240 | 69132 | 2021.814ms | 34193.056 | 19.106ms | 22.073/44.518ms | 0.02 | 9.458ms | 28.77ms | 391.2MB | PASS |
| cjson | 55 | 14199 | 855.018ms | 16606.668 | 4.051ms | 7.488/17.959ms | 0.013 | 2.921ms | 11.739ms | 236.6MB | PASS |
| fmt | 75 | 69630 | 6473.274ms | 10756.535 | 25.445ms | 33.3/43.56ms | 0.009 | 10.055ms | 76.283ms | 644.2MB | PASS |

Budgets: {"minColdLocPerSec":10000,"maxCacheLoadMs":1500,"maxFirstQueryMs":500,"maxWarmColdRatio":0.65,"maxQueryP50Ms":75,"maxQueryP95Ms":250,"maxRssMb":1536}.