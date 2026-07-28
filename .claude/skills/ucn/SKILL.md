---
name: ucn
description: AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML. Use in repositories over roughly 500 LOC to orient, extract symbols, trace callers or callees, assess change impact, validate call sites, select tests, inspect dependencies, or investigate dead code. Prefer it over repeated grep-and-read cycles for semantic questions; use text search for literals, messages, configuration, and unsupported languages.
---

# UCN

Use UCN to gather compact, auditable code evidence before reading large files or changing a symbol.

## Core workflow

1. Run `ucn repo` in an unfamiliar repository. Add `--deep` when readiness or index health matters. If it reports skipped unsupported source, use grep/ripgrep and a language-native analyzer for those files; never interpret an `UNSUPPORTED` or `PARTIAL` scope as a semantic zero.
2. Pin a symbol with `ucn find <name>`, then pass its `path:line:name` handle to later commands.
3. Run `ucn show <handle>` for the default summary, callers, and callees. Request extra projections with `--sections=source,tests,types,dependencies,example,related`.
4. Before a change, run `ucn impact <handle>` and `ucn tests <handle> --depth=3`.
5. After a signature change, run `ucn check <handle>`. Before committing, run target-less `ucn check`.
6. Read exact code with `ucn source <handle>` or `ucn source path/to/file:10-30` only when inspection is needed.

Prefer `--json` for automation. Every CLI JSON response uses `{ meta, data }`;
`meta.command` uses the native surface spelling and may include the internal
`canonicalCommand`. MCP returns text through one `ucn` tool and keeps contract
metadata visible when truncating results.

## One contract across surfaces

CLI, MCP, and interactive mode resolve the same 18 public commands through one registry, execute the same handlers, and use the same public formatters. CLI spells multiword commands with hyphens; MCP uses snake case. For example, use `audit-async` in CLI and `audit_async` in MCP.

The release board independently cross-checks overlapping stable-handle answers from `find`, `show`, `source`, `impact`, `tests`, `check`, and caller `trace`. Target identity, source and direct-test projections, caller tiers, evidence reasons, totals, and accounting must agree exactly; a mismatch is a failing witness rather than an interpretation left to an agent.

MCP keeps its process and project index warm across calls. CLI and MCP share
the same text budget: targeted commands default to 10K output characters,
broad commands to 3K, with a 100K hard ceiling. Use CLI `--max-chars`, MCP
`max_chars`, a narrower file/directory scope, or a smaller section projection
when necessary. Truncation must retain the accounting/contract lines needed to
interpret the answer.

Persistent indexes live in a per-user, project-keyed cache rather than the analyzed repository. Set `UCN_CACHE_DIR` to override the cache root; CLI `--no-cache` bypasses persistence and `--clear-cache` removes the current project's cache. Legacy `<project>/.ucn-cache` directories are migrated on first use.

Supported source families are JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, and HTML inline JavaScript/event handlers. C/C++ uses `compile_commands.json` when available to classify headers and resolve include paths. This is portable AST analysis, not a compiler build; macros, templates, generated code, reflection, and external dependency semantics can remain unverified.

`repo` readiness is task-specific. Its headline is navigation readiness;
refactor, deletion, semantic recall, and the sampled evidence mix are separate
dimensions. The confirmed/unverified percentage is a classification profile,
not an accuracy grade.

## Interpret evidence correctly

For caller-bearing `show`, `impact`, `trace`, `tests`, and `check` views:

- `CONFIRMED` has binding, receiver, import, or ownership evidence for the pinned target.
- `UNVERIFIED` is a possible target with insufficient identity evidence. Review it before a breaking change.
- `ACCOUNT` partitions observed literal-name lines into confirmed, unverified, non-call, excluded, and unresolved buckets.
- `CONTRACT` states the scope and completeness of that observed-text partition.
- `WARNING` identifies unreadable, unparsed, or partially indexed files.
- `FILTERED` means query options hid evidence.

An observed-text zero is not semantic zero or safe-delete proof. Numeric evidence values are ordinal ranking weights, not probabilities.

## Choose a command

| Decision | Command |
|---|---|
| Orient or diagnose a repository | `ucn repo [--sections=files,stats,health] [--deep]` |
| Understand one symbol | `ucn show <handle> [--sections=...]` |
| Locate definitions or types | `ucn find <name> [--type=type]` |
| Inspect literal-name occurrence kinds | `ucn usages <name>` |
| Search literal text, explicit regex, or AST structure | `ucn search [term] [--regex] [--type=...]` |
| Extract exact source | `ucn source <handle\|file:range>` |
| Follow calls down or up | `ucn trace <handle> --direction=callees\|callers` |
| Find paths to roots | `ucn trace <handle> --direction=callers --to=entrypoints` |
| Assess direct or Git-diff impact | `ucn impact [handle]` |
| Select direct or transitive tests | `ucn tests <handle> [--depth=N]` |
| Validate a symbol or pending diff | `ucn check [handle]` |
| Preview a refactor | `ucn plan <handle> --rename-to=X` |
| Inspect file dependencies | `ucn deps <file> [--direction=...] [--cycles]` |
| Inspect public surface | `ucn api [file]` |
| Review entry points or HTTP routes | `ucn entrypoints`; `ucn endpoints` |
| Generate review candidates | `ucn deadcode`; `ucn audit-async` |
| Resolve runtime frames | `ucn stacktrace <text>` |

## Breaking-change protocol

1. Pin the exact definition with `find`.
2. Run `impact`; review every unverified, excluded, filtered, and warning entry.
3. Run `trace --direction=callers` for transitive behavioral impact.
4. Run `tests --depth=3`; treat paths without static test links as test-planning signals, not runtime coverage proof.
5. Make the change.
6. Run `check <handle>`, the relevant compiler/type checker, and selected tests.
7. Run target-less `check` to reconcile the repository diff.

## Deletion protocol

Treat `deadcode` as a candidate generator. Before deletion, inspect `usages`, `impact`, `entrypoints`, `api`, and `repo --sections=health --deep`; then corroborate with the compiler/type checker and tests. Computed dispatch such as `handlers[key]()` is a reported blind spot; registry members reached by a modeled computed receiver are withheld, but all remaining candidates are still review-only. Never delete solely from `deadcode` or an observed-text-zero result.

`usages` includes comment/string/docstring occurrences in an `OTHER TEXT` section unless
`--code-only` is set. This is a literal-name inventory, not exact target
binding. `search` treats its term literally by default; pass `--regex` only
when regular-expression semantics are intended.

`plan` always includes the selected declaration plus indexed call/import/export
previews. Read `changeSummary`, and manually review any edit marked
`needsReview`; the command previews changes but does not apply or compile them.

## Efficient use

- Prefer handles over plain names. Use `--class-name` or `--file` only when a handle is unavailable.
- Use `--sections` to request only the `show` or `repo` evidence needed.
- Use `--expand-unverified` only when deliberately exploring possible caller chains; those descendants remain possible, not confirmed.
- Use `--all` only when that command's output reports a supported cap; otherwise narrow the query or raise `--max-chars`.
- Use `search` or ordinary repository search for text, filenames, configuration, and unsupported syntax.

Read [references/commands.md](references/commands.md) for all public commands and flags. Read [references/trust-contract.md](references/trust-contract.md) before building automation that gates changes on UCN output.
