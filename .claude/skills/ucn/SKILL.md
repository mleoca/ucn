---
name: ucn
description: AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, and HTML. Use in repositories over roughly 500 LOC to orient, extract symbols, trace callers or callees, assess impact, verify call sites, select tests, or investigate dead code. Prefer it over repeated grep-and-read cycles for semantic questions; use text search for literals, messages, configuration, and unsupported languages.
---

# UCN

Use UCN to gather compact, auditable code evidence before reading large files or changing a symbol.

## Start here

1. Run `ucn orient` in an unfamiliar repository.
2. Pin the symbol. Use `ucn find <name>` when a name is ambiguous, then pass the emitted `path:line:name` handle to later commands.
3. Run `ucn about <handle> --compact` for definition, direct callers, callees, tests, and contract metadata.
4. Before a change, run `ucn impact <handle>` and `ucn affected-tests <handle>`.
5. After a signature change, run `ucn verify <handle>`. Before committing, run `ucn check`.
6. Read source with `ucn fn`, `ucn class`, or `ucn lines` only when the evidence indicates that source inspection is needed.

Prefer `--json` when another tool or script will consume the answer. MCP `about`, `context`, and `impact` default to compact output; request `compact=false` only when source and previews are necessary.

## CLI, MCP, and skill behavior

The skill is guidance, not a separate analysis engine. It tells the agent when and how to call UCN through the CLI or MCP.

CLI and MCP resolve commands through the same registry, execute the same handlers, use the same project index and persisted cache, and call the same output formatters. Their defaults differ by transport:

- CLI uses full text by default and emits raw JSON with `--json`.
- MCP defaults `about`, `context`, and `impact` to compact text. It uses a 10K character default for targeted commands, 3K for broad commands, and a 100K hard ceiling. Contract metadata is preserved when output is truncated.
- MCP uses snake_case command and parameter names. CLI uses hyphenated command and flag names.
- To compare text, align compact/full settings and result caps. Surface-specific retry hints may still use CLI or MCP spelling.

MCP keeps the process and project index warm across calls, so repeated MCP queries usually avoid CLI process startup. The semantic work and cache format are otherwise shared.

## Read every answer as evidence, not proof

For `about`, `context`, and `impact`, interpret caller results in two bands:

- `CONFIRMED`: the call site has binding, receiver, import, or ownership evidence for the pinned target.
- `UNVERIFIED`: the syntax could call the target, but the engine cannot prove the identity. Review these sites before a breaking change.

Then inspect all contract signals:

- `ACCOUNT` partitions literal-name text occurrences into confirmed, unverified, non-call, excluded, and unresolved buckets. It is an arithmetic conservation check, not a semantic-completeness claim.
- `CONTRACT` states whether that literal-name partition is complete. `observed-text zero` means no caller was found in that observed text set. It does not prove semantic zero and is never safe-delete proof.
- `WARNING` means parsing, reading, or indexing was incomplete. Inspect the named files with text search or the compiler.
- `FILTERED` means flags hid evidence from display. Remove the filters before a breaking change.
- `beyond-text callers` are alias- or binding-resolved edges that a literal grep would miss.
- Numeric evidence scores are ordinal ranking weights, not calibrated probabilities or accuracy percentages.
- Truncated MCP output preserves contract metadata when possible. If `contractMetadataComplete` is false, rerun with a larger output budget or narrower scope.

Do not claim “no callers,” “safe to delete,” or “safe to refactor” from a zero result alone.

## Match the command to the decision

| Decision | Command |
|---|---|
| Understand one symbol | `ucn about <handle> --compact` |
| Direct change impact | `ucn impact <handle>` |
| Transitive callers | `ucn blast <handle> --depth=3` |
| Downward execution flow | `ucn trace <handle> --depth=3` |
| Paths from entry points | `ucn reverse-trace <handle>` |
| Tests affected by a change | `ucn affected-tests <handle>` |
| Validate call-site arity | `ucn verify <handle>` |
| Pre-commit review | `ucn check [--base=main]` |
| Exact source extraction | `ucn fn <handle>` or `ucn class <handle>` |
| All references, not only calls | `ucn usages <name>` |
| Potentially unreachable code | `ucn deadcode` |
| Index limitations and readiness | `ucn doctor --deep` |

Use `trace` instead of repeatedly calling `about` down a pipeline. Use `blast` instead of repeatedly calling `impact` up a caller chain.

## Breaking-change protocol

Before renaming, changing parameters, or changing behavior:

1. Pin the exact definition with a handle.
2. Run `impact`; review every unverified and warning entry.
3. Run `blast` for transitive impact when behavior changes.
4. Run `affected-tests`; treat “uncovered” as a test-planning signal, not proof of no coverage.
5. Make the change.
6. Run `verify`, the relevant compiler or type checker, and the selected tests.
7. Run `ucn check` to reconcile the repository diff.

UCN augments the compiler and tests; it does not replace them.

## Deletion protocol

Treat `deadcode` as a candidate generator. Before deleting a symbol:

1. Run `ucn deadcode`, then pin the candidate.
2. Run `ucn usages <name>` to inspect calls, imports, type references, and non-call references.
3. Run `ucn impact <handle>` and inspect `ACCOUNT`, `CONTRACT`, warnings, unverified sites, and beyond-text callers.
4. Run `ucn entrypoints` and consider framework registration, reflection, serialization, dependency injection, public API use, and external consumers.
5. Run `ucn doctor --deep`; inspect index health, evidence readiness, and the deletion review requirement.
6. Delete only with corroborating compiler/type-checker and test evidence.

Never delete solely because `deadcode` or an observed-text-zero contract reports zero callers.

## Ambiguity and dispatch

- Prefer handles over a plain symbol name.
- Use `--class-name=<Class>` or `--file=<pattern>` only when a handle is unavailable.
- Treat `possible-dispatch`, `method-ambiguous`, `alias-call`, and `call-not-resolved` as review-required.
- Tree trunks contain confirmed edges. Unverified edges are separate and are not expanded unless `--expand-unverified` is requested.
- Following an unverified edge produces a possible-impact chain, not a confirmed chain.

## Efficient output

- Use `--compact` for agent context and `--json` for automation.
- Use `--exclude=test` only for a production-only view; rerun without it before a breaking change.
- Use `--all` when a section says results were capped.
- Use `--no-cache` after edits if cache freshness is in doubt.
- Use `ucn search` for text or structural queries; use ordinary repository search for file names and unsupported syntax.

Read [references/commands.md](references/commands.md) when a less common command or flag is needed. Read [references/trust-contract.md](references/trust-contract.md) before building automation that gates changes on UCN output.
