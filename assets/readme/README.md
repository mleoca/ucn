# README animations

`ucn-connected-scope.gif` is the conceptual overview. Its nodes and timing
are illustrative. The editable fragment is `ucn-connected-scope.html`;
`render-animation.cjs` renders it at 2208 × 1200, 20 frames per second,
with an 8.5-second loop. It needs `sharp` and `ffmpeg` for authoring only.
The PNG is a still alternative.

`ucn-evidence-graph.gif` is Fable's real-data demonstration, preserved with
its HTML source, still PNG, and captured data in `ucn-evidence-graph.json`.
The layout and animation sequence are a presentation of captured findings,
not a recording of the engine's execution order or speed. The drawing shows
a subset of import edges, alongside all 29 literal-name occurrence lines.

Source repository: https://github.com/BurntSushi/ripgrep

Pinned commit: `82313cf95849bfe425109ad9506a52154879b1b1`.

Selected definition: `crates/ignore/src/pathutil.rs:113:file_name`.

From that checkout, these commands reproduce the underlying evidence:

```sh
ucn impact crates/ignore/src/pathutil.rs:113:file_name --json
ucn show crates/ignore/src/pathutil.rs:113:file_name --json
ucn usages file_name --json
ucn deps crates/ignore/src/lib.rs --json
ucn deps crates/ignore/src/types.rs --json
ucn deps crates/ignore/src/pathutil.rs --json
ucn deps crates/ignore/src/dir.rs --json
ucn deps crates/ignore/src/walk.rs --json
ucn deps crates/globset/src/lib.rs --json
ucn deps crates/globset/src/pathutil.rs --json
```

The captured partition is 4 confirmed calls, 1 unverified candidate,
17 non-call lines, 7 other-target lines, and 0 unaccounted. The non-call
partition is 8 definitions, 2 imports, 2 references, and 5 other-text lines.
The imported illustration was checked against the live local CLI on
2026-09-06: source text, partition totals, its ten import edges, and the
displayed owner definitions matched. This is UCN evidence, not an independent
compiler/oracle certification of this individual answer.

This directory is excluded from npm packages. Keep it with the README in
the repository when promoting the proposal.
