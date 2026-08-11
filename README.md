# UCN — Universal Code Navigator

See what code does before you touch it.

Find symbols, follow execution, inspect impact, select tests, map dependencies,
extract source, and audit cleanup candidates—from the terminal or an AI agent.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

All commands, one engine, three ways to use it:

```text
  Terminal              AI Agents           Agent Skills
       │                    │                    │
      CLI                  MCP                 Skill
       └────────────────────┼────────────────────┘
                            │
                     ┌──────┴──────┐
                     │ UCN Engine  │
                     │  commands   │
                     │ tree-sitter │
                     └─────────────┘
```

Supports JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C, C++, C#,
and HTML inline scripts.

If you work with AI, add UCN as a [Skill or MCP tool](#ai-setup). The agent gets
compact, source-linked code intelligence through one tool instead of loading
whole files to reconstruct every relationship.

UCN is deliberately lightweight:

- **No required background process** - the CLI parses on demand, answers, and
  exits; MCP stays warm only when you choose to run it.
- **No language servers** - tree-sitter performs the analysis without building
  or compiling the project.
- **MCP is optional** - it is only needed to connect UCN directly to an AI agent;
  the CLI, interactive mode, and Agent Skill work without an MCP server.

## Start here

```bash
npm install -g ucn                    # Node.js 20+

cd your-project
ucn repo                              # repository map and health
ucn find handleRequest                # exact definitions and stable handles
ucn show src/server.ts:42:handleRequest
ucn trace src/server.ts:42:handleRequest --direction=callers
ucn impact src/server.ts:42:handleRequest
ucn tests src/server.ts:42:handleRequest --depth=3
```

The first command builds an incremental project index. Later commands reuse it.
No configuration is required, and the cache stays outside the project directory.

## Understand code you did not write

`ucn show` gathers the useful context around one symbol: signature, source,
callers, callees, tests, types, dependencies, examples, and related code. Ask for
everything or project it down to the sections you need.

```text
$ ucn show detectLanguage --sections=summary,callers,callees,tests --compact

SUMMARY
───────
detectLanguage(filePath: string, projectRoot = null): string|null
  languages/index.js:420-428  (9 lines)
  handle: languages/index.js:420:detectLanguage
  "Detect language from file path"
  async: no  |  side_effects: [none]  |  complexity: branches=1, depth=1

RELATIONSHIPS
─────────────
CALLERS — CONFIRMED (51, 30 prod + 21 test):
  cli/index.js:604 [runFileCommand]: const language = detectLanguage(filePath);
  core/build-worker.js:39 [processFile]: const language = detectLanguage(filePath, rootDir);
  core/project.js:472 [build]: const language = detectLanguage(filePath, this.root);
  test/parser-unit.test.js:19: assert.strictEqual(detectLanguage('file.js'), 'javascript');
  test/parser-unit.test.js:46: assert.strictEqual(detectLanguage('file.c'), 'c');
  test/parser-unit.test.js:50: assert.strictEqual(detectLanguage('file.cs'), 'csharp');
  ... 45 more callers

CALLEES (1):
  detectHeaderLanguage {fs} - core/compilation-database.js:217
CALLEES — UNVERIFIED (1):
  toLowerCase ×1 — possible-dispatch L422

ACCOUNT: "detectLanguage" occurs on 79 lines in 20 files: 51 confirmed,
  0 unverified, 28 non-call, 0 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed.

TESTS: 27 matches in 6 test files
```

`find` returns stable handles in `file:line:name` form. Pass the handle to any
symbol command to pin the answer to one definition, even when several files or
classes use the same name.

## Follow the execution path

`trace` walks callees, callers, or callers toward runtime entry points. The tree
keeps proven edges and unresolved dispatch visibly separate.

```text
$ ucn trace build --depth=2

build
├── detectProjectPattern (core/discovery.js:760) 1x
├── parseGitignore (core/discovery.js:253) 1x
│   ├── gitignoreFiles (core/discovery.js:234) 1x
│   └── parseGitignoreFile (core/discovery.js:152) 1x
├── expandGlob (core/discovery.js:314) 1x
│   ├── parseGlobPattern (core/discovery.js:369) 1x
│   ├── walkDir (core/discovery.js:426) 1x
│   └── compareNames (core/discovery.js:293) 1x
├── parallelBuild (core/parallel-build.js:48) 1x
│   ├── partitionFiles (core/parallel-build.js:16) 1x
│   ├── removeFileSymbols (core/project.js:675) 1x
│   └── [unverified] set — method-ambiguous L171,L176,L180
└── ... more callees

CALLEE ACCOUNT: 11 nodes expanded · 210 call sites = 31 confirmed +
  33 unverified + 86 external/builtin + 60 excluded
```

The account line makes the tree auditable: unresolved sites remain visible and
quantified instead of disappearing from the result.

## Answers you can trust

UCN does not turn every matching name into a semantic claim. Caller-bearing
answers separate evidence into clear tiers:

- **CONFIRMED** - target identity is supported by a binding, import, receiver
  type, qualified path, same-class resolution, or equivalent evidence.
- **UNVERIFIED** - call syntax exists, but UCN cannot prove the target. The site
  stays visible with a reason such as `method-ambiguous` or `possible-dispatch`.
- **NON-CALL, OTHER-TARGET, and EXCLUDED** - observed lines classified away from
  the selected target.
- **ACCOUNT** - every observed literal-name line is reconciled across the tiers.
- **CONTRACT** - states the boundary of the answer and what it does not prove.

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

An observed-text zero is not a safe-deletion claim. Aliases, generated code,
reflection, runtime registration, dynamic dispatch, and external consumers can
exist beyond the indexed evidence. UCN reports those blind spots through
`repo --sections=health --deep` and keeps risky decisions review-only.

### Measured against ground truth

Release gates compare UCN with ts-morph, Pyright, gopls, rust-analyzer, JDT LS,
Roslyn, and clangd on ten pinned production repositories. The latest full v5
release-board run produced:

| Release-board result | Measurement |
|---|---:|
| In-scope caller and callee semantic recall | **100%** on all 10 repositories |
| Confirmed caller precision | **99.4–100%** per repository |
| Oracle-backed public-command recall | **100%**, with 0 execution errors |
| Cross-command agreement | **8,000 / 8,000**, with 0 disagreements |
| Default `deadcode` false-dead findings | **0** in the oracle-visible sample |
| Automated suite | **3,383 tests** across 981 suites, 0 failures or skips |
| Performance board | **10 / 10 repositories passed** |

On that run, the slowest median cold build indexed 15.4K lines/second by wall
time, the worst repository query p95 was 73.8 ms, and the highest measured peak
RSS was 771 MB. Each repository ran in an isolated process with three cold
samples and a fixed four-worker ceiling.

These are measured release-board results, not a claim of universal program
understanding or identical performance on every machine. The sources are pinned,
the sampling policy is deterministic, and repositories that expose gaps remain
on the wider scheduled board.

## Change code with a map

Inspect a symbol before editing it, preview the refactor, then check the current
Git change:

```bash
ucn show parseRequest --sections=summary,callers,callees,tests
ucn check parseRequest
ucn plan parseRequest --rename-to=parseIncomingRequest
ucn impact --staged
ucn check --staged
```

`check <symbol>` validates known call sites against the signature. `plan`
previews declaration, import/export, and call-site edits; anything that cannot be
represented safely is marked `needsReview`. Without a symbol, `impact` and
`check` analyze the Git diff.

## Get the lay of the land

`repo` gives a fast project orientation: language mix, important directories,
hot symbols, entry points, and analysis health.

```text
$ ucn repo

PROJECT ORIENTATION — /path/to/project
════════════════════════════════════════════════════════════
202 files · 3043 symbols · language mix by symbols:
  javascript 72%, typescript 8%, rust 6%, java 5%, go 4%, python 3%, csharp 2%

TOP DIRS (by symbols):
  core                828 symbols · 38 file(s)
  languages           529 symbols · 13 file(s)
  test                266 symbols · 39 file(s)

HOT (most-called production functions):
  langTraits — 117 call(s) · languages/index.js:560
  nodeToLocation — 87 call(s) · languages/utils.js:32
  codeUnitCompare — 73 call(s) · core/shared.js:15

ENTRY POINTS: 46 — runtime 46
TRUST: HIGH — 13 dynamic imports, 13 eval, 8 reflection, 5 computed dispatch

Next: ucn show langTraits · ucn repo --sections=files --detailed ·
  ucn repo --sections=health --deep
```

Project-wide discovery also records recognizable source files UCN cannot parse.
Mixed scopes are marked `PARTIAL`; all-unsupported scopes are marked
`UNSUPPORTED`. Skipped files are listed with a plain-text and language-native
analysis handoff instead of being presented as a clean zero-file project.

## Map dependencies and API surfaces

```bash
ucn deps src/server.ts --direction=imports --detailed
ucn deps src/server.ts --direction=importers --depth=3
ucn deps --cycles
ucn api
ucn entrypoints --type=http
ucn endpoints --bridge --unmatched
```

`deps` follows imports, importers, or both directions and reports cycles. `api`
lists public symbols. `entrypoints` finds runtime and framework roots.
`endpoints --bridge` matches server routes with client requests across supported
frameworks and languages, while keeping exact, partial, and uncertain matches
separate.

## Select tests and audit cleanup candidates

```bash
ucn tests expandGlob                   # direct static links
ucn tests expandGlob --depth=3         # tests across the impact closure
ucn deadcode --exclude=test
ucn usages candidateName
ucn impact candidateName
ucn audit-async
```

`tests` reports static call/reference linkage, not runtime coverage. Empty
results warn about subprocess tests, reflection, generated code, and external
harnesses that may still exercise the target.

`deadcode` is deliberately conservative and remains a candidate generator.
Before deleting, inspect `usages`, `impact`, `entrypoints`, `api`, and repository
health, then run the native compiler or type checker and tests.

## Extract and search without opening whole files

```bash
ucn source core/discovery.js:314:expandGlob
ucn source core/discovery.js --range=314-364
ucn search '$scope.$apply'             # literal by default
ucn search 'TODO|FIXME' --regex        # regex is explicit
ucn search --type=call --receiver=client
ucn usages expandGlob --include-tests
```

`source` extracts an exact function, class, or line range. `search` handles
literal text, explicit regular expressions, and structural filters. `usages`
provides the full literal-name inventory—calls, definitions, imports, references,
comments, and strings—with `--code-only` available when only code is relevant.

Regular-expression search uses an RE2-compatible linear-time engine for ordinary
patterns. Unsafe nested repetition is rejected instead of running an unbounded
expression.

## The 18-command surface

| Task | Command |
|---|---|
| Repository orientation and health | `repo [--sections=summary,files,stats,health] [--deep]` |
| Symbol summary and relationships | `show <symbol> [--sections=...]` |
| Definition lookup | `find <name> [--type=type] [--with-source]` |
| Complete literal-name inventory | `usages <name>` |
| Literal, regex, or structural search | `search [term] [--regex] [structural flags]` |
| Exact source extraction | `source <symbol\|file:range>` |
| Downstream, upstream, or entry-point call trees | `trace <symbol> [--direction=...] [--to=entrypoints]` |
| Symbol or Git-diff impact | `impact [symbol]` |
| Direct or transitively linked tests | `tests <symbol> [--depth=N]` |
| Signature or pre-commit validation | `check [symbol]` |
| Refactor preview | `plan <symbol> --rename-to=...` |
| Imports, importers, and cycles | `deps [file] [--direction=...] [--cycles]` |
| Project or file public API | `api [file]` |
| Runtime and framework roots | `entrypoints` |
| Server/client HTTP surface | `endpoints [--bridge]` |
| Conservative dead-code candidates | `deadcode` |
| Likely missing awaits | `audit-async` |
| Runtime frame resolution | `stacktrace <text>` |

Run `ucn --help` for every accepted flag. Flags that do not apply to a command
produce an explicit warning or MCP note instead of silently changing the task.

Several commands cover related modes through parameters rather than separate
verbs:

```bash
ucn show parseRequest --sections=summary,callers,callees
ucn show parseRequest --sections=source,tests,types

ucn trace parseRequest --direction=callees --depth=3
ucn trace parseRequest --direction=callers --depth=3
ucn trace parseRequest --direction=callers --to=entrypoints

ucn impact parseRequest
ucn impact --staged

ucn check parseRequest
ucn check --staged
```

## Same engine, different transport

CLI, MCP, file mode, project mode, glob mode, and interactive mode resolve
commands through the same registry, parameter normalization, execution handlers,
project index, cache, and public formatters.

- The CLI prints readable text by default. `--json` returns a stable machine-
  readable envelope.
- MCP exposes exactly one tool named `ucn`; its `command` enum contains the 18
  public tasks and its generated description lists each task's parameters.
- CLI commands and flags use hyphenated spelling. MCP uses snake case where
  needed, such as `audit_async`, `project_dir`, and `class_name`.
- A persistent MCP process keeps the index warm across calls. CLI invocations
  reuse the same incremental disk cache.

CLI JSON always uses one envelope:

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

Targeted text commands default to a 10K-character budget and broad commands to
3K, with a 100K ceiling. Set `--max-chars=N` in CLI or `max_chars` in MCP.
`--all` / `all=true` removes formatter item caps while retaining the transport
ceiling. Truncation preserves `ACCOUNT`, `CONTRACT`, `WARNING`, and related trust
metadata. JSON remains complete and is not text-truncated.

## Cache that stays out of the project

UCN stores its incremental cache under the user's cache root:

- `UCN_CACHE_DIR` when explicitly set
- `$XDG_CACHE_HOME/ucn` on XDG systems
- `~/Library/Caches/ucn` on macOS
- `%LOCALAPPDATA%/ucn/cache` on Windows
- `~/.cache/ucn` on other systems

Canonical path hashes isolate same-named checkouts. `--no-cache` bypasses
persistence, `--clear-cache` clears the current project, and
`--clear-cache --all` clears all bounded UCN project caches. On first use, UCN
migrates and removes the old `<project>/.ucn-cache` directory.

## Language coverage

All parsers feed the same versioned, data-only language IR and index path.
Sequential and worker builds are tested for equivalent symbols, calls, imports,
and evidence.

- **JavaScript / TypeScript / JSX / TSX** - functions, classes, imports/exports,
  typed receivers, aliases, callbacks, async flow, and common framework roots.
- **Python** - functions, classes, annotations, decorators, imports,
  comprehensions, context-manager bindings, async flow, and framework roots.
- **Go, Rust, and Java** - nominal receivers, methods,
  inheritance/traits/interfaces, package or path ownership, overload/arity
  discipline, and framework roots.
- **C** - functions, structs, macros, includes, calls, entry points, and API
  analysis.
- **C++** - C coverage plus classes, methods, constructors, inheritance,
  namespaces, overloads, templates, and typed field receivers.
- **C#** - namespaces, classes/interfaces/records, fields/properties, attributes,
  overload-aware calls, async flow, top-level programs, .NET stack frames, and
  ASP.NET/HttpClient endpoint analysis.
- **HTML** - inline JavaScript and `on*` event handlers.

For C and C++, `compile_commands.json` improves header-language, include-path,
and ownership context when available. UCN retains AST-proven definitions, calls,
and usages from recoverable conditional-preprocessor branches without claiming
which branch a particular build activates.

## Testing and reliability

- **Regression discipline** - every fixed defect gets a focused test.
- **Surface coverage** - all 18 commands run through CLI JSON, CLI text, and MCP.
- **Language coverage** - parser and semantic regressions span every supported
  source family.
- **Architecture guards** - sequential/parallel build, cache round-trip, command
  registry, handler, formatter, and transport parity are checked automatically.
- **External ground truth** - real compilers and language servers adjudicate
  caller, callee, command, and dead-code claims.
- **Performance gates** - cold build, warm query, worker count, and peak memory
  are release-blocking measurements.

The publish policy requires 100% in-scope semantic recall and oracle-backed
public-command recall, at least 98% confirmed precision, a conserved account for
every sample, zero cross-command disagreements, and bounded ambiguity. The
performance gate requires at least 10K indexed lines/second by wall time and 3K
by CPU time, query p50 at most 75 ms, query p95 at most 250 ms, and separate
1.5 GiB build and board peak-RSS ceilings.

The semantic board draws a deterministic, reference-stratified sample of up to
50 oracle symbols per repository. It records confirmed precision, semantic
recall across confirmed plus visible unverified edges, observed-zero agreement,
account conservation, review burden, callee behavior, and the oracle-backed
public commands `find`, `show`, `source`, `trace`, `impact`, `usages`, and
`tests`.

The consistency board independently compares overlapping claims from `find`,
`show`, `source`, `impact`, `tests`, `check`, and caller `trace`. Identity,
source, tests, confirmed and unverified sites, evidence reasons, totals, and
accounting must agree exactly. Any mismatch fails with a minimal witness.

The public-surface agent harness executes all 18 commands and checks selection,
parameters, answer shape, transport parity, latency, and output size. Its
checked-in plans are reference contract-conformance cases, not a claim that every
live agent will choose perfectly; captured live-agent plans can be scored
separately.

Reproduce the local checks and full release board with:

```bash
npm run verify
npm run benchmark:agent:gate
npm run trust:gate
```

The gates write human-readable and raw reports under `eval/reports`; pinned
sources live in [`eval/lib/repos.js`](eval/lib/repos.js). Before tagging, the
**Eval** GitHub workflow must pass its **Pre-tag release dry run** on the actual
Ubuntu runner.

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

<details>
<summary>Manual MCP configuration</summary>

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

VS Code uses `.vscode/mcp.json`:

```json
{
  "servers": {
    "ucn": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ucn", "--mcp"]
    }
  }
}
```

</details>

### Agent Skill (no server needed)

macOS / Linux:

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

Windows PowerShell:

```powershell
$npmRoot = npm root -g
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills"
Copy-Item -Recurse "$npmRoot\ucn\.claude\skills\ucn" "$env:USERPROFILE\.claude\skills\"

New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills"
Copy-Item -Recurse "$npmRoot\ucn\.claude\skills\ucn" "$env:USERPROFILE\.agents\skills\"
```

The skill teaches an agent how to orient, pin symbols, choose the smallest
useful command, interpret evidence, and recover from incomplete answers. It is
guidance over the same engine, not a separate implementation.

## Limitations

- Static, single-project analysis; dependencies such as `node_modules` and
  `site-packages` are not indexed.
- No runtime execution or compiler diagnostics.
- Reflection, generated code, runtime registration, dynamic property access,
  and external consumers can be invisible.
- Interface, trait, template, macro, overload, and untyped-receiver dispatch may
  remain unverified instead of being guessed.
- HTML has regression coverage but no independent compiler/LSP real-repository
  oracle.
- C/C++ analysis does not run the preprocessor or compiler. Build-specific
  branch activation, advanced templates, generated headers, and macro expansion
  can remain unresolved.
- C# analysis does not run Roslyn. Source generators, dynamic/reflection
  dispatch, and external assembly semantics remain outside the static index.
- Large repositories can take a few seconds on the first query. Later questions
  use the incremental cache.

UCN is built for fast, portable, auditable code navigation. Use the native
compiler, type checker, test runner, or profiler when a decision requires
compiler completeness or runtime truth.

---

MIT
