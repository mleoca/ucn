# Performance capability comparisons

The query board keeps its original 5.5.1 handles, timings and limits. Every
report still shows that raw release comparison. A new reference band or newly indexed declarations change
the work a command performs, so its enforcing comparison uses the earliest
working implementation of that capability.

The 120 pinned impact handles partition into these cohorts:

| Capability | Handles | Reference revision |
|---|---:|---|
| Existing type references | 12 | `a274a48` (5.5.1) |
| Existing property accesses | 2 | `a274a48` (5.5.1) |
| New class and struct type references | 48 | `291387b` |
| New value accesses | 57 | `5b7259c` |
| Value access whose introducing revision errors | 1 | `cf4eeb1` |

The last row is fmt's `include/fmt/format.h:3882:separator_`. An error is not
a timing reference. Its reference is the first revision that successfully
returns the band; the other five fmt value handles retain their introducing
revision. Full commits, host factors, process counts, runner hashes and
per-handle measurements are in [the reference data](lib/performance-capabilities.json).

Five javapoet class-find queries gained eleven explicit constructor declarations
at `fe4183e` (parent `9f39cfd`). That first revision returns the same seventeen
declarations as the current inventory, while its parent matches the release.
Those five complete commands use the introducing revision; the sixth query,
the unchanged `FlushType` enum, retains its original release sample. Comparing
all sixty class-find queries across the ten repositories found no other added
declaration locations. Kind reclassifications and constructor markers on
existing C++ or C# declarations do not qualify.

Each cohort times the entire command, including its existing caller work.
It uses the same pinned order, 40-query context prefix, three startup samples
and three isolated process samples. The best sample per handle is normalized
by the measured host factor. A cohort fails if its p50 or p95 exceeds its
reference by both 20% and 50 ms while both times remain below one second.
Once either time reaches one second, the relative limit is 15%, still with
the 50 ms minimum increase. Adding a full second always fails, even below
the relative limit. Smaller increases over 15% and 5 ms are warnings.
The same policy applies to ordinary release comparisons and capability
cohorts. Indexing throughput, memory and absolute latency limits remain
separate checks. Existing capabilities retain their original
release measurements, reconstructed from the two original three-process runs.
No existing release pin is replaced.

Every process must return the expected band with consistent site counts and
conserved accounting when supplied. Missing bands, mismatched handles or
revisions, incomplete cohorts and missing host references fail the comparison.
Each declaration comparison also checks the exact file, line, name, kind and
constructor marker, rejects missing, duplicate or extra rows, and requires
consistent nonnegative usage counts and their conservation equations. These
checks run after each command timer, including slower process samples.
Confirmed-site counts are not frozen: a correctness fix may move a site to
review. Query errors always fail. Hosts without release query baselines remain
explicitly unmeasured, as on the original board.

Historical measurements use the current runner with an immutable checkout:

```sh
UCN_WORKERS=4 node --expose-gc eval/run-performance-gate.js \
  --engine-root ../historical-ucn --repo fmt \
  --samples 3 --startup-samples 3 --queries 40
```

Use the full pinned board for each measured repository, including its context
prefix; do not time a selected handle in isolation. Historical runs supply
measurements, never release qualification. A timing-protocol change requires
new historical measurements with that protocol, preserving the earlier data.

Other find queries, plus show, constructor and overload queries, keep their
release comparisons. More callers, changed confidence, additional proof work,
or reclassification of an existing declaration does not qualify.
At a release boundary, remeasure from the released tree and retire or revise
these explicit exceptions; they cannot silently apply to a later baseline.
