---
name: ucn
description: AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML. Use in repositories over roughly 500 LOC to orient, extract symbols, trace callers or callees, assess change impact, validate call sites, select tests, inspect dependencies, or investigate dead code. Prefer it over repeated grep-and-read cycles for semantic questions; use text search for literals, messages, configuration, and unsupported languages.
---

# UCN

UCN answers semantic questions about a codebase from a tree-sitter index: where a symbol is defined, who calls it, what it calls, what a change touches, which tests reach it. Every answer labels its evidence and accounts for every line it looked at; nothing is silently dropped.

## When to use it

- Semantic questions in a supported language (JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, HTML inline scripts): definitions, callers, callees, impact, tests, dependencies, public API, dead code.
- Use text search for literals, messages, configuration, filenames, Markdown, and unsupported languages. Below roughly 500 LOC, reading the files directly is usually faster.
- An empty UCN result is a statement about the indexed text, never proof that nothing reaches a symbol at runtime.

## Core workflow

1. `ucn repo` in an unfamiliar repository; `--deep` adds index health and readiness. Skipped unsupported source is listed with a handoff: use text search and a language-native tool for those files. An `UNSUPPORTED` or `PARTIAL` scope is never a semantic zero.
2. `ucn find <name>` pins a definition. Pass its `path:line:name` handle to every later command. A plain name that matches several definitions carries an ambiguity warning in `show`, `source`, `trace`, `impact`, `tests`, `check` and `plan`; never treat the auto-selected definition as the repository-wide target.
3. `ucn show <handle>` gives the summary, callers and callees. Add `--sections=source,tests,types,dependencies,example,related` for more.
4. Before a change: `ucn impact <handle>` and `ucn tests <handle> --depth=3`.
5. After a signature change: `ucn check <handle>`; before committing: target-less `ucn check`. Both compare a changed declaration with its parameters at `--base` (default `HEAD`), so the call sites bound to the old declaration are checked against the new one; a site that fits no remaining overload is a mismatch, never an excluded other-target line.
6. `ucn source <handle>` or `ucn source path/to/file:10-30` for exact code, only when inspection is needed.

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
| Inspect file dependencies | `ucn deps <file> [--direction=...]` |
| Find circular imports | `ucn deps --cycles` (project-wide; no file target) |
| Inspect public surface | `ucn api [file]` |
| Review entry points or HTTP routes | `ucn entrypoints`; `ucn endpoints` |
| Generate review candidates | `ucn deadcode`; `ucn audit-async` |
| Resolve runtime frames | `ucn stacktrace <text>` |

## Read the evidence

Caller-bearing views (`show`, `impact`, `trace`, `tests`, `check`) tier every candidate:

- `CONFIRMED`: binding, receiver, import, or ownership evidence for the pinned target.
- `UNVERIFIED`: call syntax that may reach the target, with the reason identity could not be established. Review it before a breaking change. When same-name definitions compete, `show` lists their stable handles once above the sites.
- Excluded sites (another definition's caller, an incompatible receiver, an external package, an arity mismatch) are counted as other-target lines in `ACCOUNT`, each with its reason in JSON.

Trust lines close every answer and survive truncation:

- `ACCOUNT` partitions every line where the name occurs: confirmed, unverified, non-call (definition, import, reference, other text), other-target, unaccounted. In mixed-language repositories it also counts occurrences in unsupported-language source files.
- `CONTRACT` states what that partition covers. Semantic completeness is never claimed: aliases, generated code, reflection and runtime dispatch may exist.
- `WARNING` lists unreadable, unparsed or partially indexed files and unsupported-language occurrence sites with their line text, so nothing text search would show is hidden. `usages` and `tests` carry the same disclosure as a note.
- `FILTERED` means query options hid evidence. `CALLEE ACCOUNT` and `TREE ACCOUNT` do the same for callees and `trace` trees.

A property/getter/setter target adds `PROPERTY ACCESS SITES` to `impact` (reads and writes with access kind; receiver identity confirms, an unresolved receiver stays unverified). A type target adds `TYPE REFERENCE SITES` (confirmed by an import link to the definition's file, or package scope in Go/Java). `DEPENDENCY SITES` counts them; `CALL SITES` stays call-shaped. Target-less `impact` and `check` diff the working tree against `HEAD` (`--staged` for the index), include untracked non-ignored source as whole-file additions, and put classes, interfaces, types and fields in declaration bands; a modified or deleted declaration makes `check` `BLOCKED` until reviewed with the language toolchain.

Numeric evidence values are ordinal ranking weights, not probabilities. An observed-text zero is not a semantic zero or safe-delete proof.

## In a shell

`--lines` and `--raw` make `ucn` compose like `grep -n`:

```bash
ucn find handleRequest --lines            # path:line:signature   # kind
ucn show handleRequest --lines            # callers as path:line:text; unverified ones end in "\t# unverified: <reason>"
ucn show handleRequest --lines --sections=callees
ucn usages handleRequest --lines          # every literal-name line; kinds tagged "# import" / "# definition" / "# reference"
ucn search 'retry(' --lines               # grep -n output, code-aware scope
ucn impact handleRequest --lines
ucn source handleRequest --raw            # the code and nothing else, ready for an exact-string edit
ucn source src/server.js:40-80 --raw
```

Records go to stdout; `ACCOUNT`/`CONTRACT`, notes and same-name disambiguation go to stderr as `# ` lines (MCP keeps them in the one text block; `--raw` appends its note as one trailing `# ` line there). `--lines` has no default row cap; explicit `--top`/`--limit` disclose what they omit; an explicit `--max-chars` fails before any output instead of truncating records. `grep -v '# unverified'` keeps the confirmed tier. `usages --lines` emits one record per source line and tags combined kinds; JSON keeps individual occurrences. `show --lines` accepts only the callers/callees sections (default callers); target-less `impact --lines` lists Git-diff callers with per-target accounting. `source --raw` extracts whole functions and large classes; `--max-lines` truncation is disclosed on stderr. Unusual path characters (backslash, tab, CR, LF) are escaped; use `--json` for exact filenames, and for `trace`/`tests` scripting. Closing the pipe with `head` is supported.

Exit codes: 0 success; 1 for an empty `--lines` listing, a blocking `check` (target-less `check` with `TRUST: BLOCKED`, or `check <handle>` reporting a mismatch or an unverified call site), or a JSON command error (`meta.ok: false` plus `error`); 2 for a text-mode command error or a `check` that could not run. An exception inside UCN prints `Internal error: ...` on every surface (CLI JSON adds `meta.internalError: true`); it says nothing about the code, so rerun with a narrower target or report it.

## Surfaces, JSON and output budgets

CLI, MCP and interactive mode run the same 18 commands through one registry, the same handlers and the same formatters. CLI spells multiword commands with hyphens (`audit-async`), MCP uses snake case (`audit_async`) through one `ucn` tool. `--json` returns `{ meta, data }`: `meta.command` keeps the surface spelling and may add `canonicalCommand`, `meta.contract` carries the truth boundary, and public `file` paths are relative to `meta.pathBase`. Definition handles start at a decorator when present; `nameLine` is the declaration token's line.

Text output has a character budget on both CLI and MCP: 3K for broad sweeps (`repo`, `entrypoints`, `endpoints`, `deadcode`, `deps`, `check`, `audit-async`), 10K for every other command, 100K ceiling (`--max-chars=N` / `max_chars`; `--all` lifts caps where a command supports it). Room for every trust line is reserved before any body text. A truncated answer keeps its head, a notice with the full size and the limit, and the trust lines; `show` and `impact` keep a head of every tier with a `+N more` line each, so a long confirmed list never hides the unverified band. A budget too small for the trust lines withholds the answer and names the budget that would carry them (`answer withheld; 0 of 3 trust line(s) shown. Raise --max-chars to at least 498.`). Narrow with a handle, `--file`, `--in` or `--sections` before raising the budget.

## Index and discovery

Indexes live in a per-user, project-keyed cache outside the repository (`UCN_CACHE_DIR` overrides the root; `--no-cache` bypasses it; `--clear-cache` removes the project's cache; a `.ucn-cache` directory left in a project is migrated on first use). MCP keeps the process and index warm across calls. Concurrent cold starts share one build: the first process takes a build lock and the others wait for its cache (`Waiting for another ucn process building the index...` on stderr); a lock left by a dead process is broken automatically.

Discovery applies the project's `.gitignore` files (root and nested) with git's own matching rules; git-tracked files are indexed even when a rule matches them, and a failing `git ls-files` is disclosed as a partial index (`git-listing-failed` in `repo --sections=health` and in caller contracts), never a silently smaller one. `*.min.js`, `*.bundle.js` and `*.map` are skipped and disclosed, which makes observed-text completeness partial; `--include-bundled` (MCP `include_bundled=true`) indexes the JavaScript bundles, respecting user exclusions and bypassing the shared cache. Source maps stay unindexed; inspect them with text tools.

C/C++ uses `compile_commands.json` when present for header classification and include paths. Project C/C++ function-like macros and Rust `macro_rules!` invocations are expanded, and what they generate is indexed at the invocation (`[via macro NAME]`). This is portable AST analysis, not a compiler build: macros, templates, generated code, reflection and external dependency semantics can stay unverified, and no conditional branch is asserted as the one a build activates.

## Breaking-change protocol

1. Pin the exact definition with `find`.
2. Run `impact`; review every unverified, excluded, filtered, and warning entry.
3. Run `trace --direction=callers` for transitive behavioral impact.
4. Run `tests --depth=3`; treat paths without static test links as test-planning signals, not runtime coverage proof.
5. Make the change.
6. Run `check <handle>`, the relevant compiler/type checker, and selected tests.
7. Run target-less `check` to reconcile the repository diff.

## Deletion protocol

`deadcode` is a candidate generator, never deletion proof. Before deleting, inspect `usages`, `impact`, `entrypoints`, `api`, and `repo --sections=health --deep`, then corroborate with the compiler/type checker and tests. Members that reflection (exact names or literal-fragment patterns), computed dispatch, runtime protocols (Python dunders, Java serialization callbacks, C# pattern members, JS `toJSON`/`then`), unknown decorators, event-handler assignment, an outside base class, or macro expansion may reach are withheld or warned; the `deadcode` notes in the command reference list them. Never delete solely from `deadcode` or an observed-text-zero result.

## Efficient use

- Prefer handles over plain names. Use `--class-name` or `--file` only when a handle is unavailable.
- Use `--sections` to request only the `show` or `repo` evidence needed.
- Use `--expand-unverified` only when deliberately exploring possible caller chains; those descendants remain possible, not confirmed.
- Use `--all` only when that command's output reports a supported cap; otherwise narrow the query or raise `--max-chars`.
- Use `search` or ordinary repository search for text, filenames, configuration, and unsupported syntax.

## References

- [references/commands.md](references/commands.md): every command, flag and default, exit codes, and per-command notes (`find` activity counts, `usages` inventory, `plan` rename closure, `endpoints` matching, `deadcode` withholding, `audit-async` findings, `deps --cycles`).
- [references/trust-contract.md](references/trust-contract.md): evidence classes, trust lines, account fields, provenance, truncation metadata, and a machine policy for automation that gates changes on UCN output.
- [references/resolution-rules.md](references/resolution-rules.md): how UCN decides identity per language (what confirms, what stays unverified with which reason, what is excluded).
