# UCN — Universal Code Navigator

Ask code questions without loading the whole repository.

Version 5 unifies the public surface around 18 task-oriented commands, one MCP
tool, and one shared execution/formatting path. It also adds a versioned
language IR/adapter boundary and first-class C, C++, and C# indexing.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

UCN is a tree-sitter code-intelligence engine for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML inline scripts. It exposes the same 18 task-oriented commands through the CLI, interactive mode, and one MCP tool for AI agents.

UCN complements grep rather than replacing it. Use grep/ripgrep for simple
literals, error messages, configuration, filenames, Markdown, and unsupported
languages. Reach for UCN when the question is semantic: which exact definition
is this, who calls it, what can it call, what changes with it, which tests are
statically linked, or how files and public surfaces connect. Use UCN `search`
when AST structure, code-only filtering, or the shared agent contract matters.

```bash
npm install -g ucn # Node.js 20+

ucn repo
ucn show handleRequest
ucn trace handleRequest --direction=callers
ucn impact handleRequest
ucn tests handleRequest --depth=3
ucn source handleRequest
```

UCN parses on demand, needs no language server, and keeps a persistent incremental cache. MCP is optional; the CLI works on its own.

## One surface built around tasks

UCN has no legacy command aliases. The public vocabulary is deliberately small, while the narrow analysis operations remain internal engine primitives.

| Task | Command |
|---|---|
| Orient in a repository | `repo [--sections=summary,files,stats,health] [--deep]` |
| Understand one symbol | `show <symbol> [--sections=...]` |
| Find definitions | `find <name> [--type=type] [--with-source]` |
| Inspect all literal-name occurrences | `usages <name>` |
| Search literal text, regex, or AST shapes | `search [term] [--regex] [structural flags]` |
| Extract exact source | `source <symbol\|file:range>` |
| Follow calls | `trace <symbol> [--direction=callees\|callers] [--to=entrypoints]` |
| Assess change impact | `impact [symbol]` |
| Select tests | `tests <symbol> [--depth=N]` |
| Validate a symbol or diff | `check [symbol]` |
| Preview a refactor | `plan <symbol> --rename-to=...` |
| Inspect file dependencies | `deps <file> [--direction=imports\|importers\|both] [--cycles]` |
| List public API | `api [file]` |
| Find runtime roots | `entrypoints` |
| Match HTTP surfaces | `endpoints [--bridge]` |
| Find dead-code candidates | `deadcode` |
| Audit missing awaits | `audit-async` |
| Resolve runtime frames | `stacktrace <text>` |

Run `ucn --help` for the accepted flags. Flags that do not apply to a command are ignored with an explicit warning or MCP note.

Project-wide discovery also records common source languages that UCN cannot
parse. `repo` and its health view list those skipped files, mark an all-
unsupported scope `UNSUPPORTED` and a mixed scope `PARTIAL`, and explicitly
hand them to grep/ripgrep plus a language-native analyzer. They are never
reported as a clean zero-file project.

The command registry contains machine-checked contracts for every public command: its primary question, explicit modes, truth boundary, output shape, safety class, examples, proof coverage, and next useful command. Every parser feeds the same versioned, data-only language IR through one adapter and one index-ingestion path; sequential and worker builds therefore preserve the same symbols, calls, imports, and evidence fields.

C support includes functions, structs, macros, includes, calls, entry points, and public/API analysis. C++ adds classes, methods, constructors, inheritance, namespaces, and typed field receivers. C/C++ recovery retains AST-proven definitions, calls, and usages from mutually exclusive preprocessor branches instead of silently selecting one source inventory; it still does not claim which branch a particular build activates. C# adds namespaces, classes/interfaces/records, fields/properties, attributes, overload-aware calls, async flow, top-level programs, .NET stack frames, and ASP.NET/HttpClient endpoint analysis. When available, `compile_commands.json` supplies C/C++ header-language and include-path context.

### Composable commands

The few commands that cover several related questions use parameters instead of separate verbs:

```bash
# One symbol, projected to only what the agent needs
ucn show parseRequest --sections=summary,callers,callees
ucn show parseRequest --sections=source,tests,types
ucn show parseRequest --sections=dependencies,example,related

# Downstream, upstream, or roots
ucn trace parseRequest --direction=callees --depth=3
ucn trace parseRequest --direction=callers --depth=3
ucn trace parseRequest --direction=callers --to=entrypoints

# Direct versus transitively affected tests
ucn tests parseRequest
ucn tests parseRequest --depth=3
ucn tests src/parser.ts

# A symbol when named; the Git diff when unnamed
ucn impact parseRequest
ucn impact --staged

# Signature consistency when named; precommit checks when unnamed
ucn check parseRequest
ucn check --staged

# Repository and dependency projections
ucn repo --sections=files,stats,health --deep
ucn deps src/server.ts --direction=imports --detailed
ucn deps --cycles
```

`tests` reports static call/reference linkage, not runtime coverage. A file target is resolved through imports and exact caller evidence; it is never reduced to a generic basename search. Empty results explicitly warn that subprocess/black-box tests, reflection, generated code, or external harnesses may still exercise the target.

## CLI and MCP parity

All surfaces resolve a public command through the same registry, normalize parameters once, call the same `execute()` handler, and use the same public formatter. File, project, glob, and interactive CLI modes use that route too. CLI JSON includes `meta.contract` with the command question, decision-safety class, truth boundary, and suggested next actions.

Engine facts and trust metadata are equivalent for equivalent parameters.
Presentation guidance uses the native surface syntax (`--all` in CLI,
`all=true` in MCP), and only recommends `all` for commands that support it.
`--json` always returns one stable envelope:

```json
{
  "meta": { "command": "audit-async", "canonicalCommand": "auditAsync", "mode": "..." },
  "data": {}
}
```

Failed CLI JSON requests retain the same shape with `data: null`,
`meta.ok: false`, the command contract when known, and an `error` string.

CLI commands and flags use hyphenated spelling. MCP commands and parameters use snake case where needed, such as `audit_async`, `project_dir`, and `class_name`.
JSON `meta.command` follows that native spelling; `canonicalCommand` is included
only when the internal camel-case name differs.

The MCP server publishes exactly one tool named `ucn`. Its `command` enum contains the 18 commands, and its generated description lists the parameters accepted by each command. A warm MCP process reuses the same index cache and is normally faster than starting a CLI process for each question.

CLI and MCP text use one shared output budget: targeted commands default to
10K characters, broad commands to 3K, and both have a 100K ceiling. CLI can
set `--max-chars=N`; MCP can set `max_chars`. `--all`/`all=true` lifts
formatter caps while retaining the ceiling. Truncation preserves omitted
`ACCOUNT`, `CONTRACT`, `WARNING`, and related trust lines. The requested limit
is a hard transport ceiling that includes the truncation notice and preserved
metadata; JSON remains complete and is not text-truncated.

## Cache location

UCN does not write its default cache into the analyzed project. Each canonical
project path gets an isolated directory under the user's cache root:

- `UCN_CACHE_DIR` when explicitly set;
- `$XDG_CACHE_HOME/ucn` on XDG systems;
- `~/Library/Caches/ucn` on macOS;
- `%LOCALAPPDATA%/ucn/cache` on Windows;
- `~/.cache/ucn` on other systems.

The project directory name is combined with a path hash, so same-named
checkouts do not share state. `--no-cache` bypasses persistence and
`--clear-cache` clears the current project's user cache. On first use, UCN
migrates and removes its legacy `<project>/.ucn-cache` directory.

## Evidence you can audit

UCN does not turn a name match into a certainty claim. Caller-bearing answers from `show`, `impact`, and related trace workflows separate:

- `CONFIRMED`: the edge has target-identity evidence such as a binding, import, receiver type, or same-class resolution.
- `UNVERIFIED`: call syntax exists, but dispatch or binding cannot be proved. Every candidate stays visible with a reason.
- `NON-CALL`, `OTHER-TARGET`, and `EXCLUDED`: observed lines classified away from the target.
- `ACCOUNT`: reconciles every observed literal-name line into those buckets.
- `CONTRACT`: states that text conservation is not semantic completeness.

An observed-text zero does not prove that aliases, generated code, reflection, runtime registration, or external consumers are absent. Evidence weights are ordinal, not probabilities.

```text
CALLERS — CONFIRMED (2):
  evidence: exact-binding (all)
  src/app.ts:18 [main]: parseRequest(input)

CALLERS — UNVERIFIED (1) — call syntax, no binding/receiver evidence:
  src/plugin.ts:41 [run]: parser.parseRequest(input) — method-ambiguous

ACCOUNT: "parseRequest" occurs on 8 lines: 2 confirmed, 1 unverified,
  4 non-call, 1 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed.
```

Treat `deadcode` as a candidate generator. Before deleting, inspect `usages`, `impact`, `entrypoints`, `api`, and `repo --sections=health --deep`, then corroborate with the compiler/type checker and tests.
Computed/indexed dispatch such as `handlers[key]()` is reported as a health
blind spot. Object-literal registry members reached through that shape are
withheld from dead-code candidates, and any remaining result is still
review-only. Unknown decorators/annotations and member-assigned event handlers
are withheld by default because the annotation or assignment may itself be the
only runtime registration evidence. Language-local descriptor mechanics such
as Python `@property` remain auditable instead of being blanket-excluded.

## Common workflows

### Understand code before editing

```bash
ucn find parseRequest
ucn show src/parser.ts:42:parseRequest
ucn impact src/parser.ts:42:parseRequest
ucn tests src/parser.ts:42:parseRequest --depth=3
ucn source src/parser.ts:42:parseRequest
```

Stable handles (`file:line:name`) pin duplicate names to one definition.
`find` activity is also pinned: its call count is confirmed plus visibly
unverified candidates for that definition. Same-name calls proved to belong to
another target are disclosed separately and never inflate the total.

### Preview and check a refactor

```bash
ucn check parseRequest
ucn plan parseRequest --rename-to=parseIncomingRequest
ucn impact --staged
ucn check --staged
```

`plan` includes the selected declaration, owned imports/exports, and call-site
previews. `changeSummary` separates those edit classes. A declaration edit that
cannot be rendered as a safe one-line replacement is marked `needsReview`
rather than silently omitted.

### Search and occurrence inventory

```bash
# Literal by default: punctuation is not regex syntax
ucn search '$scope.$apply'

# Regex is explicit
ucn search 'TODO|FIXME' --regex

# Includes comment/string/docstring occurrences in a separate OTHER TEXT section
ucn usages parseRequest --include-tests
```

Use `--code-only` to omit comment/string/docstring text. `usages` is a literal-name
inventory, not proof that every occurrence binds to one selected definition.
Regex search uses an RE2-compatible linear-time engine for ordinary patterns.
Advanced JavaScript-only constructs use a guarded compatibility path; unsafe
nested repetition is rejected with a recommendation to simplify it or use
ripgrep.

### Inspect architecture

```bash
ucn repo --sections=files,stats,health --deep
ucn deps src/server.ts --direction=both --depth=3
ucn entrypoints --type=http
ucn endpoints --bridge --unmatched
ucn api src/server.ts
```

### Audit cleanup risks

```bash
ucn deadcode --exclude=test
ucn usages candidateName
ucn audit-async
```

## AI setup

### MCP

```bash
# Claude Code
claude mcp add ucn -- npx -y ucn --mcp

# OpenAI Codex CLI
codex mcp add ucn -- npx -y ucn --mcp

# VS Code Copilot
code --add-mcp '{"name":"ucn","command":"npx","args":["-y","ucn","--mcp"]}'
```

Manual configuration:

```json
{
  "mcpServers": {
    "ucn": {
      "command": "npx",
      "args": ["-y", "ucn", "--mcp"]
    }
  }
}
```

### Agent skill

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

The skill teaches an agent when to use each command and how to interpret confirmed, unverified, account, and completeness signals. It does not provide a separate analysis engine.

## Reliability and performance

The suite covers parsers, the shared IR/adapter boundary, index/cache equivalence, command composition, CLI/MCP/interactive parity, formatters, security edge cases, conservation accounting, adversarial release-surface regressions, and language-specific regressions. The cross-language matrix covers all supported source families; the public-surface benchmark executes and scores all 18 commands through CLI JSON, CLI text, and MCP.

Release gates compare semantic answers with ts-morph, Pyright, gopls, rust-analyzer, JDT LS, clangd, and Roslyn on pinned real repositories, limit unverified review burden, audit dead-code claims, and enforce cold/warm latency and peak-memory policies. A deterministic, stratified stable-handle board also requires overlapping `find`, `show`, `source`, `impact`, `tests`, `check`, and caller `trace` claims to agree exactly: target identity, source and direct-test projections, confirmed and unverified caller-site multisets, evidence reasons, totals, and caller accounting. Any disagreement fails with a minimal handle-and-field witness. The semantic board publishes both the human-readable report and its raw JSON source, including true edges left unverified, actionable candidate-set p50/p95/max, zero-actionable-ambiguity target rate, effective review items, raw false-candidate amplification, and reason families. Actionable false candidates count individually; a named runtime-dispatch family counts as one agent-facing review item while every raw site remains auditable.

The publish-blocking policy requires 100% in-scope semantic recall and public-command recall, at least 98% confirmed-tier precision, a conserved account for every sample, zero cross-command disagreements, and bounded ambiguity (at most 10% exact true edges left unverified, p95 at most five actionable candidates, and at most 0.10 effective review items per oracle edge). The portable performance board uses three independent process-isolated runs per repository with a fixed four-worker build shape. Cold CPU throughput is the host-invariant gate; wall throughput remains a visible 10K LOC/s warning so runner contention or lost parallelism cannot masquerade as engine CPU cost. Build-phase and full-board peak RSS are gated independently at 1.5 GiB, and the worst sample is never averaged away. Query p50 must remain at most 75 ms and p95 at most 250 ms. These are release floors, not claims that every repository or dynamic runtime behavior is covered.

The ten-repository publish-blocking board is preact-signals, httpx, cobra, viper, ripgrep, clap, javapoet, newtonsoft-json, cjson, and fmt. The wider scheduled semantic matrix contains 22 pinned repositories: zod, preact-signals, express, httpx, rich, cobra, grpc-go, ripgrep, cursive, gson, clap, hono, zustand, viper, chi, javapoet, jsoup, click, fastify, newtonsoft-json, cjson, and fmt.

The public-surface agent harness replays task plans through CLI JSON, CLI text,
and MCP, and records command/parameter selection, answer checks, semantic text
parity, tool calls, latency, and output size. Its default checked-in plans are
labeled `reference-plan-contract-conformance`; their selection score is not a
live-agent measurement. Plans captured from an actual agent can be scored with
`--plans=<file>` and are labeled separately.
The checked-in fixture must contain at least 500 source lines, so the benchmark
cannot accidentally pass on a toy repository below the skill's recommended
usage threshold.

Reproduce the gates with:

```bash
npm run verify
npm run benchmark:agent:gate
npm run trust:gate
```

Before creating a version commit or tag, manually dispatch the **Eval** GitHub
workflow from `main` and require its **Pre-tag release dry run** to pass on the
actual Ubuntu runner. Only then run `npm version <version>` and push with
`git push --follow-tags`; this prevents a tag from becoming the first CI
measurement of the release board.

Published evidence lives under [`eval/reports`](eval/reports), with pinned sources in [`eval/lib/repos.js`](eval/lib/repos.js). Agent and caller-profile reports are generated by their benchmark commands rather than maintained as additional documentation.

## Limitations

- Static, single-project analysis; dependencies such as `node_modules` and `site-packages` are not indexed.
- No runtime execution or compiler diagnostics.
- Reflection and generated/runtime-registered edges can be invisible.
- Interface, trait, and untyped-receiver dispatch may remain unverified rather than being guessed.
- HTML support covers inline JavaScript and event handlers; it has no independent compiler/LSP real-repository oracle.
- C/C++ analysis does not run the preprocessor or compiler. It inventories AST-proven facts across recoverable conditional branches, but build-specific activation, advanced templates, generated headers, and macro expansion can remain unresolved. `compile_commands.json` improves header/include ownership when present.
- C# analysis does not run Roslyn; source generators, dynamic/reflection dispatch, and external assembly semantics remain outside the static index.
- Large repositories can take a few seconds on the first query; later queries use the incremental cache.

UCN is for fast, portable, auditable navigation. Use a compiler, type checker, or runtime profiler when the task requires compiler completeness or runtime truth.

---

MIT
