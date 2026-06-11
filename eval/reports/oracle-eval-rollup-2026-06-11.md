# Oracle eval — 2026-06-11

UCN tiered caller answers scored against compiler/LSP ground truth.
`missing-unexplained` is the release gate: an oracle call edge UCN
neither showed (confirmed/unverified) nor accounted for — the silent
lie the grep-reliability contract forbids. Target: 0.

| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |
|---|---|---|---|---|---|---|---|---|---|
| zod | ts-morph | 50 | 1861 | 63.6% | 26.0% | 0.3756 | **0** | 50.0% (18) | 100.0% |
| preact-signals | ts-morph | 24 | 24 | 75.9% | 0.0% | 0.7586 | **0** | 85.7% (7) | 100.0% |
