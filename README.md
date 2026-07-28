# UCN — Universal Code Navigator

Ask code questions without loading the whole repository.

Version 5 unifies the public surface around 18 task-oriented commands, one MCP
tool, and one shared execution/formatting path. It also adds a versioned
language IR/adapter boundary and first-class C, C++, and C# indexing.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

UCN is a tree-sitter code-intelligence engine for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML inline scripts. It exposes the same 18 task-oriented commands through the CLI, interactive mode, and one MCP tool for AI agents.

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
| Inspect all name usages | `usages <name>` |
| Search text or AST shapes | `search [term] [structural flags]` |
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

The command registry contains machine-checked contracts for every public command: its primary question, explicit modes, truth boundary, output shape, safety class, examples, proof coverage, and next useful command. Every parser feeds the same versioned, data-only language IR through one adapter and one index-ingestion path; sequential and worker builds therefore preserve the same symbols, calls, imports, and evidence fields.

C support includes functions, structs, macros, includes, calls, entry points, and public/API analysis. C++ adds classes, methods, constructors, inheritance, namespaces, and typed field receivers. C# adds namespaces, classes/interfaces/records, fields/properties, attributes, overload-aware calls, async flow, top-level programs, .NET stack frames, and ASP.NET/HttpClient endpoint analysis. When available, `compile_commands.json` supplies C/C++ header-language and include-path context.

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

## CLI and MCP parity

All surfaces resolve a public command through the same registry, normalize parameters once, call the same `execute()` handler, and use the same public formatter. File, project, glob, and interactive CLI modes use that route too.

Text output is equivalent for equivalent parameters. `--json` always returns one stable envelope:

```json
{
  "meta": { "command": "show", "mode": "..." },
  "data": {}
}
```

CLI commands and flags use hyphenated spelling. MCP commands and parameters use snake case where needed, such as `audit_async`, `project_dir`, and `class_name`.

The MCP server publishes exactly one tool named `ucn`. Its `command` enum contains the 18 commands, and its generated description lists the parameters accepted by each command. A warm MCP process reuses the same index cache and is normally faster than starting a CLI process for each question.

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

### Preview and check a refactor

```bash
ucn check parseRequest
ucn plan parseRequest --rename-to=parseIncomingRequest
ucn impact --staged
ucn check --staged
```

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

The suite covers parsers, the shared IR/adapter boundary, index/cache equivalence, command composition, CLI/MCP/interactive parity, formatters, security edge cases, conservation accounting, and language-specific regressions. The cross-language matrix covers all supported source families; the public-surface benchmark executes and scores all 18 commands through CLI JSON, CLI text, and MCP.

Release gates additionally compare semantic answers with ts-morph, pyright, gopls, rust-analyzer, and jdtls on pinned real repositories, limit unverified review burden, audit dead-code claims, and enforce cold/warm latency and peak-memory policies. C/C++/C# currently use parser, conformance, cross-surface, conservation, and adversarial fixture gates rather than a compiler/LSP real-repository oracle. The semantic board publishes both the human-readable report and its raw JSON source, including true edges left unverified, actionable candidate-set p50/p95/max, zero-actionable-ambiguity target rate, effective review items, raw false-candidate amplification, and reason families. Actionable false candidates count individually; a named runtime-dispatch family counts as one agent-facing review item while every raw site remains auditable.

The seven-repository release board is preact-signals, httpx, cobra, viper, ripgrep, clap, and javapoet. The wider scheduled semantic matrix contains nineteen pinned repositories: zod, preact-signals, express, httpx, rich, cobra, grpc-go, ripgrep, cursive, gson, clap, hono, zustand, viper, chi, javapoet, jsoup, click, and fastify.

The public-surface agent harness replays task plans through CLI JSON, CLI text, and MCP, and records command/parameter selection, answer checks, parity, tool calls, latency, and output size. Its checked-in plan is a deterministic contract baseline; captured agent plans can be scored with `--plans=<file>`.

Reproduce the gates with:

```bash
npm run verify
npm run benchmark:agent:gate
npm run trust:gate
```

Published evidence lives under [`eval/reports`](eval/reports), with pinned sources in [`eval/lib/repos.js`](eval/lib/repos.js). Agent and caller-profile reports are generated by their benchmark commands rather than maintained as additional documentation.

## Limitations

- Static, single-project analysis; dependencies such as `node_modules` and `site-packages` are not indexed.
- No runtime execution or compiler diagnostics.
- Reflection and generated/runtime-registered edges can be invisible.
- Interface, trait, and untyped-receiver dispatch may remain unverified rather than being guessed.
- HTML support covers inline JavaScript and event handlers; it has no compiler/LSP real-repository oracle.
- C/C++ analysis does not run the preprocessor or compiler; build-specific macros, advanced templates, generated headers, and conditional compilation can remain unresolved. `compile_commands.json` improves header/include ownership when present.
- C# analysis does not run Roslyn; source generators, dynamic/reflection dispatch, and external assembly semantics remain outside the static index.
- Large repositories can take a few seconds on the first query; later queries use the incremental cache.

UCN is for fast, portable, auditable navigation. Use a compiler, type checker, or runtime profiler when the task requires compiler completeness or runtime truth.

---

MIT
