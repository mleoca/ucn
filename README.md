# UCN — Universal Code Navigator

**grep finds the line. UCN follows the code.**

UCN is local, AST-based code intelligence for humans and AI agents. It answers
the questions that usually come *after* a text search:

- Which definition does this name refer to?
- Who calls it, and what does it call?
- What could change if I edit it?
- Which tests are connected to it?
- How do these files, entry points, and public APIs fit together?

The answer is compact, source-linked, and honest about uncertainty. Use it from
the terminal, interactive mode, or one MCP tool. The analysis needs no running
language server, project build, background daemon, or per-project setup.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

JavaScript · TypeScript · Python · Go · Rust · Java · C · C++ · C# · HTML

## Start with one minute

```bash
npm install -g ucn                    # Node.js 20+

cd your-project
ucn repo                              # understand the repository
ucn find handleRequest                # find the exact definition
ucn show src/server.ts:42:handleRequest
ucn impact src/server.ts:42:handleRequest
ucn tests src/server.ts:42:handleRequest --depth=3
ucn source src/server.ts:42:handleRequest
```

`find` returns stable handles in `file:line:name` form. Reuse the handle to pin
later questions to one definition, even when the repository contains several
functions with the same name.

## Where UCN fits

UCN belongs beside grep, not in its place.

| Question | Reach for |
|---|---|
| “Where does this text, error, key, or filename occur?” | `grep` / `rg` |
| “Which symbol is this, who calls it, and what depends on it?” | UCN |
| “Will this compile, pass at runtime, or behave the same in production?” | Compiler, type checker, tests, or profiler |

Use grep for literals, logs, configuration, Markdown, and languages UCN does not
parse. Use UCN when identity and relationships matter. It removes much of the
repeated `grep → open file → infer binding → chase imports → repeat` loop without
pretending to be a compiler.

## Useful answers without invented certainty

A code-navigation tool is only helpful if you know which parts of its answer to
trust. UCN keeps proven and possible edges separate:

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

- **CONFIRMED** means UCN has target-identity evidence: a binding, import,
  receiver type, qualified path, or same-class resolution.
- **UNVERIFIED** means a possible edge remains, but UCN cannot prove its target.
  The site stays visible with a reason instead of being guessed or discarded.
- **ACCOUNT** reconciles every observed literal-name line across confirmed,
  unverified, non-call, other-target, and excluded buckets.
- **CONTRACT** states the boundary of the answer. A clean text account is not a
  claim that reflection, generated code, aliases, or runtime registration do not
  exist.

That distinction is especially useful to an agent: it can act on strong evidence,
review a small uncertainty band, and know when to fall back to grep or a native
toolchain.

## Measured, not merely claimed

UCN's release gates compare its answers with real compiler and language-server
oracles on pinned repositories. The latest full v5 release-board run covered
TypeScript, Python, Go, Rust, Java, C#, C, and C++ through ts-morph, Pyright,
gopls, rust-analyzer, JDT LS, Roslyn, and clangd.

| Latest release-board result | Measurement |
|---|---:|
| In-scope caller and callee semantic recall | **100%** on all 10 repositories |
| Confirmed caller precision | **99.4–100%** per repository |
| Oracle-backed public-command recall | **100%**, with 0 execution errors |
| Cross-command agreement | **8,000 / 8,000**, with 0 disagreements |
| Default `deadcode` false-dead findings | **0** in the oracle-visible sample |
| Automated suite | **3,383 tests** across 981 suites, 0 failures or skips |
| Performance board | **10 / 10 repositories passed** |

On that performance run, the slowest median cold build still indexed 15.4K
lines/second by wall time, the worst repository query p95 was 73.8 ms, and the
highest measured peak RSS was 771 MB. Each repository ran in an isolated process
with three cold samples and a fixed four-worker ceiling.

These are measurements of a deterministic, stratified release board—not a promise
of universal program understanding or identical speed on every machine. The gate
requires 100% in-scope semantic recall, at least 98% confirmed precision, a fully
conserved account, zero cross-command disagreements, bounded ambiguity, at least
10K indexed lines/second by wall time, and bounded query latency and memory. Repos
that expose gaps stay in the wider scheduled matrix instead of being removed to
protect a perfect score.

See [How the release evidence works](#how-the-release-evidence-works) for scope,
reproduction commands, and the exact limitations of these numbers.

## Why agents reach for it

- **One MCP tool, 18 explicit tasks.** The agent chooses a command and only the
  parameters that command accepts; it does not have to discover a large toolbox.
- **Small answers first.** Symbol handles, section projection, compact formatting,
  limits, and output budgets keep repository exploration within context.
- **Same facts everywhere.** CLI, MCP, and interactive mode share the command
  registry, engine, cache, and formatters.
- **Auditable uncertainty.** Confirmed and unverified edges never collapse into one
  opaque confidence score.
- **Useful next actions.** Machine-readable contracts explain the question answered,
  the truth boundary, decision safety, and the next command worth running.
- **Fast follow-up questions.** A persistent MCP process and incremental cache keep
  the index warm without writing generated state into the repository.
- **No toolchain ceremony.** UCN works across mixed-language repositories without
  setting up nine language servers. Native tools remain the final authority when
  compiler or runtime truth is required.

Humans get the same advantages from the CLI: readable text by default, stable JSON
with `--json`, and an interactive mode with `ucn --interactive`.

## What you can ask

The public vocabulary is intentionally task-shaped:

| Need | Command |
|---|---|
| Orient in a repository | `repo [--sections=summary,files,stats,health] [--deep]` |
| Understand one symbol | `show <symbol> [--sections=...]` |
| Find definitions | `find <name> [--type=type] [--with-source]` |
| Inventory every literal-name occurrence | `usages <name>` |
| Search literal text, regex, or AST shapes | `search [term] [--regex] [structural flags]` |
| Extract exact source | `source <symbol\|file:range>` |
| Follow calls up or down | `trace <symbol> [--direction=callees\|callers]` |
| Assess symbol or Git-diff impact | `impact [symbol]` |
| Select directly or transitively linked tests | `tests <symbol> [--depth=N]` |
| Validate a symbol or staged diff | `check [symbol]` |
| Preview a refactor | `plan <symbol> --rename-to=...` |
| Inspect imports, importers, or cycles | `deps [file] [--direction=...] [--cycles]` |
| List public API | `api [file]` |
| Find runtime roots | `entrypoints` |
| Match server and client HTTP surfaces | `endpoints [--bridge]` |
| Find conservative dead-code candidates | `deadcode` |
| Audit likely missing awaits | `audit-async` |
| Resolve runtime frames to source | `stacktrace <text>` |

Run `ucn --help` for every accepted flag. A flag that does not apply to a
command produces an explicit warning or MCP note instead of silently changing
the question.

### Compose broad questions with parameters

```bash
# Ask only for the parts of a symbol you need
ucn show parseRequest --sections=summary,callers,callees
ucn show parseRequest --sections=source,tests,types

# Follow execution down, callers up, or callers toward runtime roots
ucn trace parseRequest --direction=callees --depth=3
ucn trace parseRequest --direction=callers --depth=3
ucn trace parseRequest --direction=callers --to=entrypoints

# Direct tests versus the transitive impact closure
ucn tests parseRequest
ucn tests parseRequest --depth=3

# A named symbol, or the current Git change when no symbol is given
ucn impact parseRequest
ucn impact --staged
ucn check parseRequest
ucn check --staged

# Repository and dependency projections
ucn repo --sections=files,stats,health --deep
ucn deps src/server.ts --direction=both --depth=3
ucn deps --cycles
```

`tests` reports static call/reference linkage, not runtime coverage. An empty
answer warns about subprocess tests, reflection, generated code, and external
harnesses that may still exercise the target.

## Common workflows

### Understand code before editing

```bash
ucn find parseRequest
ucn show src/parser.ts:42:parseRequest
ucn impact src/parser.ts:42:parseRequest
ucn tests src/parser.ts:42:parseRequest --depth=3
ucn source src/parser.ts:42:parseRequest
```

`show` can combine definition, signature, source, callers, callees, tests,
types, dependencies, examples, and related symbols. Use `--sections` when you
only need part of that answer.

### Preview and check a refactor

```bash
ucn check parseRequest
ucn plan parseRequest --rename-to=parseIncomingRequest
ucn impact --staged
ucn check --staged
```

`plan` previews declaration, import/export, and call-site edits. Anything that
cannot be represented as a safe one-line edit is marked `needsReview` rather
than silently omitted.

### Search without changing the meaning of the query

```bash
ucn search '$scope.$apply'             # literal by default
ucn search 'TODO|FIXME' --regex        # regex is explicit
ucn usages parseRequest --include-tests
ucn search --type=call --receiver=client
```

Use `--code-only` to omit comments, strings, and docstrings. `usages` is the raw
literal-name inventory and the escape hatch when you want to inspect every name
match without semantic filtering. Regex search uses an RE2-compatible linear-time
engine for ordinary patterns; unsafe nested repetition is rejected.

### Inspect architecture and runtime roots

```bash
ucn repo --sections=files,stats,health --deep
ucn deps src/server.ts --direction=both --depth=3
ucn entrypoints --type=http
ucn endpoints --bridge --unmatched
ucn api src/server.ts
```

`repo` reports language coverage and trust blind spots. If a scope contains
unsupported source, it is marked `PARTIAL` or `UNSUPPORTED` and handed off to
grep plus a language-native analyzer; skipped files are not presented as a
clean result.

### Audit cleanup risks

```bash
ucn deadcode --exclude=test
ucn usages candidateName
ucn impact candidateName
ucn audit-async
```

`deadcode` is deliberately conservative and remains a candidate generator.
Before deleting, inspect `usages`, `impact`, `entrypoints`, `api`, and
`repo --sections=health --deep`, then run the native compiler/type checker and
tests.

## AI setup

### MCP: one tool named `ucn`

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

The MCP server exposes exactly one tool, `ucn`. Its `command` enum contains the
18 public tasks, and its generated description lists the parameters accepted by
each task. MCP uses snake-case names where needed, such as `audit_async`,
`project_dir`, and `class_name`.

### Agent skill

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

The skill teaches an agent when to use UCN, when grep is better, how to pin
symbols, and how to interpret confirmed, unverified, account, and completeness
signals. It is guidance over the same engine, not a separate implementation.

## Language coverage

All parsers feed the same versioned, data-only language IR and index path.
Sequential and worker builds are tested for equivalent symbols, calls, imports,
and evidence.

- **JavaScript / TypeScript / JSX / TSX**: functions, classes, imports/exports,
  typed receivers, aliases, callbacks, async flow, and common framework roots.
- **Python**: functions, classes, annotations, decorators, imports, comprehensions,
  context-manager bindings, async flow, and framework roots.
- **Go, Rust, and Java**: nominal receivers, methods, inheritance/traits/interfaces,
  package or path ownership, overload/arity discipline, and framework roots.
- **C**: functions, structs, macros, includes, calls, entry points, and API analysis.
- **C++**: C coverage plus classes, methods, constructors, inheritance, namespaces,
  overloads, templates, and typed field receivers.
- **C#**: namespaces, classes/interfaces/records, fields/properties, attributes,
  overload-aware calls, async flow, top-level programs, .NET stack frames, and
  ASP.NET/HttpClient endpoint analysis.
- **HTML**: inline JavaScript and `on*` event handlers.

For C and C++, `compile_commands.json` improves header-language, include-path,
and ownership context when available. UCN also retains AST-proven definitions,
calls, and usages from recoverable conditional-preprocessor branches, while
making no claim about which branch a particular build activates.

## CLI, JSON, MCP, and output limits

Every surface resolves through the same registry, parameter normalization,
execution handler, and formatter. CLI JSON uses a stable envelope:

```json
{
  "meta": {
    "command": "audit-async",
    "canonicalCommand": "auditAsync",
    "ok": true,
    "contract": {}
  },
  "data": {}
}
```

Failures keep the envelope with `data: null`, `meta.ok: false`, the command
contract when known, and an `error` string.

Text output defaults to 10K characters for targeted commands and 3K for broad
commands, with a 100K ceiling. Set `--max-chars=N` in the CLI or `max_chars` in
MCP. `--all` / `all=true` removes formatter item caps while retaining the hard
transport ceiling. Truncated output preserves `ACCOUNT`, `CONTRACT`, `WARNING`,
and related trust metadata. JSON remains complete and is not text-truncated.

## Cache that stays out of the repository

UCN keeps its incremental cache under the user's cache root, not inside the
project:

- `UCN_CACHE_DIR` when explicitly set
- `$XDG_CACHE_HOME/ucn` on XDG systems
- `~/Library/Caches/ucn` on macOS
- `%LOCALAPPDATA%/ucn/cache` on Windows
- `~/.cache/ucn` on other systems

Canonical path hashes isolate same-named checkouts. `--no-cache` bypasses
persistence, `--clear-cache` clears the current project's cache, and
`--clear-cache --all` clears all bounded UCN project caches. On first use, UCN
migrates and removes the old `<project>/.ucn-cache` directory.

## How the release evidence works

The ten-repository publish board is:

- preact-signals / ts-morph
- httpx / Pyright
- cobra and viper / gopls
- ripgrep and clap / rust-analyzer
- javapoet / JDT LS
- newtonsoft-json / Roslyn
- cjson and fmt / clangd

Each semantic run selects a deterministic, reference-stratified sample of up to
50 oracle symbols per repository. It measures confirmed precision, semantic
recall across confirmed plus visible unverified edges, observed-zero agreement,
account conservation, unverified review burden, callee behavior, and the
oracle-backed public commands `find`, `show`, `source`, `trace`, `impact`,
`usages`, and `tests`.

The consistency gate independently compares overlapping claims from `find`,
`show`, `source`, `impact`, `tests`, `check`, and caller `trace` using stable
handles. Identity, source, tests, confirmed/unverified sites, evidence reasons,
totals, and accounting must agree exactly. A mismatch fails with a minimal
handle-and-field witness.

The dead-code arm checks default candidates against the same oracles and fails
on an oracle-visible reference. The performance arm uses pinned file/line
workloads, isolated processes, three cold builds, warm query samples, a fixed
worker ceiling, and separate build/board memory gates. The public-surface agent
harness executes all 18 commands through CLI JSON, CLI text, and MCP and checks
selection, parameters, answer shape, parity, latency, and output size.

The checked-in agent plans are reference contract-conformance cases, not a claim
that every live agent will choose perfectly. Plans captured from real agents can
be scored separately by the same harness.

The wider scheduled matrix contains 22 pinned repositories plus rotating fresh
targets. Configuration-dependent edges are reported separately and do not count
as confirmed proof. Unverified precision is intentionally not presented as
confirmed accuracy: those entries are review candidates.

Reproduce the local checks and release gates with:

```bash
npm run verify
npm run benchmark:agent:gate
npm run trust:gate
```

The gate writes human-readable and raw reports under `eval/reports`; pinned
sources live in [`eval/lib/repos.js`](eval/lib/repos.js). Before tagging, the
**Eval** GitHub workflow must also pass its **Pre-tag release dry run** on the
actual Ubuntu runner.

## Limits worth knowing

- UCN performs static, single-project analysis. Dependencies such as
  `node_modules` and `site-packages` are not indexed.
- It does not execute code or provide compiler diagnostics.
- Reflection, generated code, runtime registration, dynamic property access, and
  external consumers can be invisible.
- Interface, trait, template, macro, overload, and untyped-receiver dispatch may
  remain unverified instead of being guessed.
- HTML has regression coverage but no independent compiler/LSP real-repository
  oracle.
- C/C++ analysis does not run the preprocessor or compiler. Build-specific branch
  activation, advanced templates, generated headers, and macro expansion can
  remain unresolved.
- C# analysis does not run Roslyn. Source generators, dynamic/reflection dispatch,
  and external assembly semantics remain outside the static index.
- Large repositories can take a few seconds on the first query. Later questions
  use the incremental cache.

UCN is for fast, portable, auditable navigation. Use the compiler, type checker,
test runner, or profiler when the decision requires compiler completeness or
runtime truth.

---

MIT
