# UCN - Universal Code Navigator

See what code does before you touch it.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

If you work with AI Agents, add UCN as a [Skill or MCP tool](#ai-setup). One tool
gives the agent compact, source-linked answers to caller, impact, and test
questions, with uncertainty labeled instead of guessed.

Find symbols, trace callers, check impact, pick the right tests, extract exact
source, and spot dead code - from your terminal or your AI agent.

Supports JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C, C++, C#,
and HTML inline scripts. All commands, one engine, three ways to use it:

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

Your tools can already find text. UCN finds *the function* - its definition,
its callers, its blast radius, its tests - and tells you how sure it is. It
parses code the way a compiler does (tree-sitter ASTs, not regex) and answers
the questions you actually have: who calls this? what breaks if I change it?
which tests should I run? is this dead?

It's deliberately lightweight:

- **No required background process** - the CLI parses on demand, answers, and
  exits. MCP stays warm only when you choose to run it.
- **No HTTP or network stack** - MCP uses a local, dependency-free stdio
  transport; UCN never opens a port.
- **No language servers, no compilation** - tree-sitter does the analysis
  without building the project.
- **No config** - point it at a directory and ask.

And it's built for auditable trust. grep hands you raw matches to sift
yourself; UCN separates proven edges from possible ones, explains every
exclusion, and reconciles every occurrence of the name it searched. It never
turns a zero into a deletion claim. CI re-derives its answers from real
compilers and language servers (ts-morph, Pyright, gopls, rust-analyzer,
JDT LS, Roslyn, clangd) on pinned production repositories. See
[Answers you can trust](#answers-you-can-trust).

<img src="https://raw.githubusercontent.com/mleoca/ucn/main/assets/demo.svg" alt="ucn show on ripgrep: signature, 123 confirmed callers with evidence types, and the ACCOUNT line reconciling all 136 occurrences of the name" width="100%">

<sub>Real output: one `ucn show` on [ripgrep](https://github.com/BurntSushi/ripgrep) - signature, 123 proven callers with their evidence, and an account of every occurrence of the name. No files opened.</sub>

## Start here

```bash
npm install -g ucn                    # Node.js 20+

cd your-project
ucn repo                              # what is this codebase?
ucn find handleRequest                # exact definitions, stable handles
ucn show src/server.ts:42:handleRequest              # the full picture
ucn trace src/server.ts:42:handleRequest --direction=callers
ucn impact src/server.ts:42:handleRequest            # every call site, with evidence
ucn tests src/server.ts:42:handleRequest --depth=3   # which tests to run
```

The first command builds an incremental index; the rest reuse it. The cache
lives outside your project directory, so there's nothing to gitignore.

## Understand code you didn't write

What does this function do, who calls it, and how sure is the answer?
`ucn show` gathers everything useful about one symbol: signature, source,
callers, callees, tests, types, dependencies, examples. Project it down to
just the sections you need:

```text
$ ucn show detectLanguage --sections=summary,callers,callees --compact

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
  evidence: scope-match (all)
  [1] cli/index.js:604 [runFileCommand]: const language = detectLanguage(filePath);
  [7] core/build-worker.js:39 [processFile]: const language = detectLanguage(filePath, rootDir);
  [17] core/project.js:472 [build]: const language = detectLanguage(filePath, this.root);
  [34] test/parser-unit.test.js:19: assert.strictEqual(detectLanguage('file.js'), 'javascript');
  ... 47 more callers

CALLEES (1):
  evidence: exact-binding (all)
  [52] detectHeaderLanguage {fs} - core/compilation-database.js:217
CALLEES — UNVERIFIED (1) — call syntax, receiver/binding unresolved:
  toLowerCase ×1 — possible-dispatch L422

ACCOUNT: "detectLanguage" occurs on 79 lines in 20 files: 51 confirmed, 0 unverified,
  28 non-call (18 import, 1 definition, 3 reference, 6 other-text), 0 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed
  (aliases, indirect calls, generated code, and runtime dispatch may exist).
```

`find` returns stable handles in `file:line:name` form. Pass a handle to any
command to pin the answer to one definition, even when several files or classes
reuse the same name.

## Follow the execution path

What happens when `build()` runs?

```text
$ ucn trace build --depth=2

build
├── compareNames (core/discovery.js:293) [regular] 3x
├── recordDiscoveryIssue (core/project.js:346) 2x
│   └── [unverified] push — method-ambiguous L351
├── detectProjectPattern (core/discovery.js:760) [utility] 1x
├── parseGitignore (core/discovery.js:253) [utility] 1x
│   ├── gitignoreFiles (core/discovery.js:234) [utility] 1x
│   ├── compareNames (core/discovery.js:293) [utility] 1x (see above)
│   └── parseGitignoreFile (core/discovery.js:152) [utility] 1x
├── gitTrackedPaths (core/discovery.js:266) [utility] 1x
│   ├── hasGitMetadata (core/discovery.js:224) [utility] 1x
│   └── [unverified] dirname — method-ambiguous L281,L284
└── ... more callees

CALLEE ACCOUNT: 11 nodes expanded · 210 call sites = 31 confirmed + 33 unverified
  (25 method-ambiguous, 1 possible-dispatch, 7 uncertain-receiver) + 86 external/builtin + 60 excluded
```

`trace` walks callees, callers, or callers all the way up to runtime entry
points (`--direction=callers --to=entrypoints`). Proven edges form the tree;
calls UCN can't prove a receiver for show up as `[unverified]` leaves with a
reason. The account line reconciles every call site in the expanded tree, so
unresolved dispatch stays visible and counted instead of quietly vanishing.

## Answers you can trust

UCN doesn't turn every matching name into a semantic claim. Watch it work
through a name with two definitions and a pile of ambiguous method calls:

```text
$ ucn impact saveCache

Impact analysis for saveCache
core/cache.js:610
Note: Found 2 definitions for "saveCache". Using core/cache.js:610. Also in: core/project.js:2380. Use file= to disambiguate.
CALL SITES: 5 confirmed + 15 unverified
  Files affected: 3
BY FILE:
  core/project.js:2380 [saveCache]: saveCache(cachePath) { return indexCache.saveCache(this, cachePath); }
  test/prerelease-audit.test.js:1493: saveCache(built, cacheFile);
  ... (3 more)
UNVERIFIED CALL SITES (15) — call syntax, no binding/receiver evidence:
  mcp/server.js:517: try { index.saveCache(); } catch (_) { /* best-effort */ } (possible-dispatch via local receiver)
  test/cache.test.js:124: index.saveCache(); (possible-dispatch via local receiver)
  (+13 more)
ACCOUNT: "saveCache" occurs on 68 lines in 11 files: 5 confirmed, 15 unverified,
  12 non-call (3 import, 1 definition, 1 reference, 7 other-text), 36 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed
  (aliases, indirect calls, generated code, and runtime dispatch may exist).
```

UCN sorted all 68 places the name appears:

- **5 confirmed** - call sites it can *prove* resolve to this `saveCache`,
  via a binding, import, receiver type, qualified path, or same-class evidence.
- **15 unverified** - real call syntax it refuses to claim. `index.saveCache()`
  sits on an untyped receiver, so the site stays visible with its reason
  (`possible-dispatch via local receiver`) instead of being guessed or dropped.
- **36 other-target** - occurrences that belong to the *other* `saveCache`,
  kept out of the answer instead of quietly inflating it.
- **12 non-call** - imports, the definition, comments, strings.
- **0 unaccounted** - every observed line landed in exactly one bucket.

That's the payoff: an answer you (or your agent) can audit, instead of an
opaque match count. A confirmed edge is evidence about the pinned target. An
unverified edge is a review item with a stated reason. And a clean zero is an
*observed-text* zero, not a safe-to-delete claim: aliases, generated code,
reflection, runtime registration, and external consumers can live beyond the
indexed evidence, and `ucn repo --sections=health --deep` reports exactly those
blind spots. Even when output is truncated to fit an agent's budget, the
ACCOUNT, CONTRACT, and WARNING lines survive the cut.

### Measured against ground truth

Don't take the tiers on faith. Release gates re-derive UCN's answers from real
compilers and language servers on a ten-repository board of pinned production
codebases, and publishing is blocked unless they pass. The latest full
release-board run (2026-08-24):

| Repository | Pinned commit | Oracle | Caller precision | Caller recall | Callee prec / recall | Command checks |
|---|---|---|---:|---:|---:|---:|
| [preact-signals](https://github.com/preactjs/signals) | [`e0ce9fdf`](https://github.com/preactjs/signals/commit/e0ce9fdf92df7f0ece2c89d44554c39f36dc6882) | ts-morph | 100% | 100% | 100% / 100% | 100% |
| [httpx](https://github.com/encode/httpx) | [`b5addb64`](https://github.com/encode/httpx/commit/b5addb64f0161ff6bfe94c124ef76f6a1fba5254) | Pyright | 100% | 100% | 100% / 100% | 100% |
| [cobra](https://github.com/spf13/cobra) | [`ad460ea8`](https://github.com/spf13/cobra/commit/ad460ea8f249db69c943a365fb84f3a59042d54e) | gopls | 100% | 100% | 100% / 100% | 100% |
| [viper](https://github.com/spf13/viper) | [`528f7416`](https://github.com/spf13/viper/commit/528f7416c4b56a4948673984b190bf8713f0c3c4) | gopls | 100% | 100% | 100% / 100% | 100% |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | [`82313cf9`](https://github.com/BurntSushi/ripgrep/commit/82313cf95849bfe425109ad9506a52154879b1b1) | rust-analyzer | 100% | 100% | 100% / 100% | 100% |
| [clap](https://github.com/clap-rs/clap) | [`d3e59a9a`](https://github.com/clap-rs/clap/commit/d3e59a9ab214910b9dad02921b7ef42c6400de9b) | rust-analyzer | 100% | 100% | 100% / 100% | 100% |
| [javapoet](https://github.com/square/javapoet) | [`b9017a95`](https://github.com/square/javapoet/commit/b9017a9503b76e11b4ad4c1a9f050e2d29112cb0) | JDT LS | 100% | 100% | 100% / 100% | 100% |
| [newtonsoft-json](https://github.com/JamesNK/Newtonsoft.Json) | [`4f73e743`](https://github.com/JamesNK/Newtonsoft.Json/commit/4f73e74372445108d2c1bda37b36e6f5e43402e0) | Roslyn | 100% | 100% | 100% / 100% | 100% |
| [cjson](https://github.com/DaveGamble/cJSON) | [`c859b25d`](https://github.com/DaveGamble/cJSON/commit/c859b25da02955fef659d658b8f324b5cde87be3) | clangd | 100% | 100% | 100% / 100% | 100% |
| [fmt](https://github.com/fmtlib/fmt) | [`e424e3f2`](https://github.com/fmtlib/fmt/commit/e424e3f2e607da02742f73db84873b8084fc714c) | clangd | 100% | 100% | 100% / 100% | 100% |

On the same run: **zero** in-scope oracle call edges missing from the answer
(the release gate) on every repository, **zero** false-dead `deadcode` claims
in the oracle-visible sample, **8,000 / 8,000** cross-command consistency
comparisons in agreement, **10 / 10** repositories inside the performance
budget (slowest normalized median cold build 17.4K lines/second by wall time,
worst query p95 83.0 ms, highest peak RSS 908.5 MB), and 3,609 automated tests with no
failures or skips. The same gates run in CI (the scheduled
[Eval workflow](https://github.com/mleoca/ucn/actions/workflows/eval.yml) and
every release tag), and `npm run trust:gate` reproduces the release board
locally. Pinned sources: [`eval/lib/repos.js`](eval/lib/repos.js).

Semantic runs draw a deterministic, reference-stratified sample of up to 50
compiler/LSP symbols per repository, then check caller identity, callee
identity, account conservation, review burden, and the public commands `find`,
`show`, `source`, `trace`, `impact`, `usages`, and `tests` against that same
external population. Unverified precision is reported separately and is
intentionally much lower on dispatch-heavy code: those entries are review
candidates, never confirmed claims.

Beyond the publish gate, a scheduled board re-checks 24 pinned repositories
across every supported oracle language (zod, express, hono, zustand, fastify,
rich, click, attrs, grpc-go, chi, cursive, itertools, gson, jsoup, and
friends), plus a rotating fresh-repo arm of codebases the engine was never
tuned on. Repositories that
expose a gap stay on the board; they don't get removed to keep a table pretty.
These are measured results on pinned code, not a claim of universal program
understanding or identical performance on every machine.

## Change code without breaking things

Will this change break a call site you've never seen? Check before you edit:

```text
$ ucn check expandGlob

Verification: expandGlob
════════════════════════════════════════════════════════════
core/discovery.js:314
expandGlob (pattern: string, options: number = {}) : string[]

Expected arguments: 1-2

STATUS: ✓ All calls valid
  Total calls: 7
  Valid: 7
  Mismatches: 0
  Uncertain: 0
  Patterns: 4 in try, 4 in callback

ACCOUNT: "expandGlob" occurs on 14 lines in 6 files: 7 confirmed, 0 unverified,
  7 non-call (4 import, 1 definition, 2 reference, 0 other-text), 0 other-target, 0 unaccounted
```

The `Patterns:` line classifies call-site structure (`inLoop`, `inTry`,
`inCallback`, `awaited`) so risky sites stand out. Then preview the refactor.
UCN shows exactly what would need to change and where:

```text
$ ucn plan expandGlob --rename-to=expandGlobPattern

Refactoring plan: rename
════════════════════════════════════════════════════════════
core/discovery.js:314

SIGNATURE CHANGE:
  Before: expandGlob (pattern: string, options: number = {}) : string[]
  After:  expandGlobPattern (pattern: string, options: number = {}) : string[]

CHANGES NEEDED: 12
  Files affected: 5
  Definition 1, calls/references 7, imports 4, exports 0; manual review required for 0 of these changes

BY FILE:

cli/index.js (2 changes)
  :771 [call]
    const files = expandGlob(pattern);
    → Rename to: const files = expandGlobPattern(pattern);
  :15 [import]
    const { expandGlob, findProjectRoot } = require('../core/discovery');
    → Update import: const { expandGlobPattern, findProjectRoot } = require('../core/discovery');

... (more changes in core/discovery.js, core/cache.js, core/project.js, test/integration.test.js)
```

For a rename, `plan` closes the change over every relationship the index can
prove: overload/signature groups, base and override declarations, Rust trait
slots, Go interface slots and their satisfiers, exact call and value-reference
tokens, imports/exports, Python `__all__` strings, and module-attribute
references. It edits exact token or expression spans, so another same-named
call on the same line is not swept up accidentally.

Open external interfaces, incomplete ownership, unresolved dispatch, or an
inexact token are marked `needsReview` instead of receiving a synthesized
edit. `plan` previews changes; it does not modify files or replace the
compiler and test suite. Before committing, point the same machinery at your
Git diff:

```bash
ucn impact --staged     # what did I change, and who depends on it?
ucn check --staged      # signature drift, orphaned functions, tests to run
```

## Pick the right tests

Which tests actually exercise this function, directly or three hops away?

```text
$ ucn tests expandGlob --depth=3

affected-tests: expandGlob
════════════════════════════════════════════════════════════
core/discovery.js:314
1 function changed → 12 functions affected (depth 3)

Test files to run (30):

  test/integration.test.js (links: expandGlob, build, idx, setupProject)
    L169: const files = expandGlob('**/*.go', { root: tmpDir });  [call]
  test/prerelease-audit.test.js (links: isCacheStale, runInteractive, build, idx)
    L39: const index = idx(dir);  [call]
  ...

Summary: 12 affected → 30 statically linked test files, 5/12 functions linked (42%) · 1 possibly affected (unverified chains)
```

`tests` reports static call/reference linkage, not runtime coverage. Functions
reached only through unverified edges are listed separately as *possibly
affected*, and empty results warn about subprocess tests, reflection, and
external harnesses that may still exercise the target.

## Get the lay of the land

One command answers "what is this codebase?" Here it is on ripgrep:

```text
$ ucn repo

PROJECT ORIENTATION — ripgrep
════════════════════════════════════════════════════════════
100 files · 4755 symbols · language mix by symbols: rust 100%

TOP DIRS (by symbols):
  crates/core/flags             1510 symbols · 6 file(s)
  crates/printer/src            677 symbols · 11 file(s)
  crates/ignore/src             607 symbols · 8 file(s)
  crates/globset/src            331 symbols · 5 file(s)

HOT (most-called production functions, top 8 of 2238 raw candidates):
  parse_low_raw — 545 call(s) · crates/core/flags/parse.rs:139
  SearcherBuilder.build — 123 call(s) · crates/searcher/src/searcher/mod.rs:315
  Searcher.search_reader — 123 call(s) · crates/searcher/src/searcher/mod.rs:727
  RegexMatcher.new — 100 call(s) · crates/regex/src/matcher.rs:385
  ...

ENTRY POINTS: 426 — test 421, runtime 5
TRUST: PARTIAL — 48 glob import(s), 5 unsupported source file(s)  (ucn repo --sections=health --deep for detail)
SKIPPED SOURCE: 5 file(s) (Shell 4, Ruby 1) — use grep/ripgrep plus a language-native analyzer.

Next: ucn show parse_low_raw · ucn repo --sections=files --detailed · ucn repo --sections=health --deep
```

Size, layout, hot spots, entry points, and an honest trust line. Note the
`SKIPPED SOURCE` handoff: when a repo mixes in languages UCN can't parse, it
says so and points you at the right tool, instead of presenting a clean-looking
answer over a partial index.

## Find dead code you can act on

```text
$ ucn deadcode --exclude=test        # run on ripgrep

Dead code: 3 unused symbol(s)

crates/globset/src/serde_impl.rs
  [  38-  42] Glob.deserialize (method)
  [  70-  74] GlobSet.deserialize (method)
crates/matcher/src/lib.rs
  [ 397- 399] Captures.as_match (method)

33 decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.

903 exported symbol(s) excluded from the audit (public API may have external callers). Use --include-exported to audit them.

WARNING: source coverage is incomplete (5 unsupported-language); 17 candidate name(s) found in skipped source were suppressed.
```

Three claims, and every one is re-checked against rust-analyzer in CI: a
default-audit claim with an oracle-visible reference fails the build. Notice
what it *didn't* claim: exported API that external code may call,
framework-registered symbols, and anything whose name appears in files UCN
couldn't parse. `deadcode` is deliberately a candidate generator. Before
deleting, corroborate with `usages`, `impact`, `api`, and your compiler and
tests.

For missing-await bugs, `ucn audit-async` lists async calls inside async
functions that lack `await` (JS/TS/Python).

## Map dependencies and API surfaces

```bash
ucn deps src/server.ts --direction=imports --detailed
ucn deps src/server.ts --direction=importers --depth=3
ucn deps --cycles                      # circular imports
ucn api                                # public surface of the project
ucn entrypoints --type=http            # runtime and framework roots
ucn endpoints --bridge --unmatched     # server routes with no client, and vice versa
```

`endpoints --bridge` matches server routes to client requests across
languages: Express/Fastify/Koa/NestJS/Next.js, Flask/FastAPI, Spring/JAX-RS,
Go net/http (Gin/Echo/Chi/Fiber), axum/actix-web, and ASP.NET on the server
side; fetch/axios, requests/httpx, RestTemplate/WebClient, reqwest, and .NET
HttpClient on the client side. Exact, partial, and uncertain matches stay in
separate tiers.

## Extract and search without opening whole files

```bash
ucn source core/discovery.js:314:expandGlob    # exactly one function
ucn source core/discovery.js --range=314-364   # exactly one range
ucn search '$scope.$apply'                     # literal by default
ucn search 'TODO|FIXME' --regex                # regex is explicit
ucn search --type=call --receiver=client       # structural search
ucn usages expandGlob --include-tests          # every occurrence, classified
```

`usages` is the escape hatch: the complete literal-name inventory (calls,
definitions, imports, references, comments, strings), for when you want
everything the text contains, not just what the engine can prove. Regex search runs on an
RE2-compatible linear-time engine; hostile nested repetition is rejected up
front instead of hanging your terminal.

## The 18 commands

| Task | Command |
|---|---|
| Repository orientation and health | `repo [--sections=summary,files,stats,health] [--deep]` |
| Symbol summary and relationships | `show <symbol> [--sections=...]` |
| Definition lookup | `find <name> [--type=type] [--with-source]` |
| Complete literal-name inventory | `usages <name>` |
| Literal, regex, or structural search | `search [term] [--regex] [structural flags]` |
| Exact source extraction | `source <symbol\|file:range>` |
| Call trees: down, up, or to entry points | `trace <symbol> [--direction=...] [--to=entrypoints]` |
| Symbol or Git-diff impact | `impact [symbol] [--staged]` |
| Direct or transitively linked tests | `tests <symbol> [--depth=N]` |
| Signature or pre-commit validation | `check [symbol] [--staged]` |
| Refactor preview | `plan <symbol> --rename-to=...` |
| Imports, importers, and cycles | `deps [file] [--direction=...] [--cycles]` |
| Project or file public API | `api [file]` |
| Runtime and framework roots | `entrypoints` |
| Server/client HTTP surface | `endpoints [--bridge]` |
| Conservative dead-code candidates | `deadcode` |
| Likely missing awaits | `audit-async` |
| Stack-trace frame resolution | `stacktrace <text>` |

Run `ucn --help` for every flag. Related modes live behind parameters rather
than extra verbs: `trace` handles down, up, and to-entry-points;
`impact`/`check` handle a symbol or the current Git diff; `show` projects any
subset of sections. Flags that don't apply to a command produce an explicit
warning instead of silently changing the task.

## Same engine, different transport

CLI, MCP, file mode, project mode, glob mode, and interactive mode resolve
commands through the same registry, handlers, index, cache, and formatters:
same answers everywhere, different delivery.

- The CLI prints readable text; `--json` returns a stable machine envelope.
- MCP exposes exactly one tool named `ucn`. Its `command` enum lists the 18
  tasks, snake_cased where needed (`audit_async`, `project_dir`, `class_name`).
  A persistent MCP process keeps the index warm across calls.
- Targeted text answers default to a 10K-character budget, broad ones to 3K,
  ceiling 100K (`--max-chars` / `max_chars`). Truncation preserves ACCOUNT,
  CONTRACT, and WARNING lines; JSON is never text-truncated.

```json
{
  "meta": { "command": "audit-async", "canonicalCommand": "auditAsync", "ok": true, "contract": {} },
  "data": {}
}
```

Failures keep the envelope: `meta.ok: false`, `data: null`, and an `error`
string, with the command contract when known.

## A cache that stays out of your project

The incremental index lives under your user cache root, not in the repo:
`UCN_CACHE_DIR` if set, else `$XDG_CACHE_HOME/ucn`, `~/Library/Caches/ucn`
(macOS), `%LOCALAPPDATA%/ucn/cache` (Windows), or `~/.cache/ucn`. Canonical
path hashes keep same-named checkouts separate. `--no-cache` bypasses,
`--clear-cache` clears the current project, `--clear-cache --all` clears every
bounded UCN cache. Old in-project `.ucn-cache` directories are migrated out
automatically on first use.

## Language coverage

All parsers feed the same versioned language IR and index path, and sequential
and worker builds are tested to produce identical symbols, calls, imports, and
evidence.

- **JavaScript / TypeScript / JSX / TSX** - functions, classes,
  imports/exports, typed receivers, aliases, callbacks, async flow, framework
  roots.
- **Python** - functions, classes, annotations, decorators, imports,
  comprehensions, context-manager bindings, async flow, framework roots.
- **Go, Rust, Java** - nominal receivers, methods,
  inheritance/traits/interfaces, package and path ownership, overload/arity
  discipline, framework roots.
- **C** - functions, structs, macros, includes, calls, entry points, API
  analysis.
- **C++** - C coverage plus classes, methods, constructors, inheritance,
  namespaces, overloads, templates, typed field receivers, static array-shape
  selection, and macro requalification. Conditional macro disagreement stays
  visible as unverified.
- **C#** - namespaces, classes/interfaces/records, fields/properties,
  attributes, declared property/field receiver types, overload and hiding
  discipline, async flow, top-level programs, .NET stack frames, and
  ASP.NET/HttpClient endpoints.
- **HTML** - inline JavaScript and `on*` event handlers.

For C and C++, a `compile_commands.json` improves header-language,
include-path, and ownership context when available. UCN keeps AST-proven
definitions from recoverable preprocessor branches without claiming which
branch a particular build activates.

## Testing and reliability

- **Regression discipline** - every fixed defect gets a focused test.
- **Surface coverage** - all 18 commands run through CLI text, CLI JSON, and
  MCP; parity between them is guarded by architecture tests.
- **External ground truth** - real compilers and language servers adjudicate
  caller, callee, command, and dead-code claims on pinned repositories
  ([see the board](#measured-against-ground-truth)).
- **Release-blocking budgets** - publishing requires 100% in-scope semantic
  recall, ≥98% confirmed precision, a conserved account for every sample, zero
  cross-command disagreements, zero default-arm false-dead claims, and the
  performance gate (≥10K lines/second cold build by wall time and ≥3K by CPU
  time, query p50 ≤75 ms, p95 ≤250 ms, bounded peak RSS), all on the actual
  release board.

```bash
npm run verify                 # lint + full test suite
npm run trust:gate             # the release board: semantic, dead-code, consistency, performance
```

Gate runs write their reports under `eval/reports/` as local run artifacts;
the pinned manifest is [`eval/lib/repos.js`](eval/lib/repos.js). Before a tag,
the Eval workflow's pre-tag dry run must pass on the actual CI runner.

## AI setup

One tool, 18 commands, compact source-linked answers that keep their trust
metadata even when truncated.

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
useful command, interpret the evidence tiers, and recover from incomplete
answers. It's guidance over the same engine, not a second implementation.

## Limitations

- Static, single-project analysis - dependencies like `node_modules` and
  `site-packages` aren't indexed, and nothing is executed.
- Reflection, generated code, runtime registration, dynamic property access,
  and external consumers can be invisible. UCN reports these blind spots
  (`repo --sections=health --deep`) rather than pretending they don't exist.
- Interface, trait, template, overload, and untyped-receiver dispatch may stay
  in the UNVERIFIED tier with a reason instead of being guessed. When
  same-name definitions compete, `show` lists their stable handles once so
  agents can see exactly what needs disambiguation.
- C/C++ analysis doesn't run the preprocessor or compiler; build-specific
  branches, advanced templates, and macro expansion can remain unresolved. C#
  analysis doesn't run Roslyn; source generators and external assembly
  semantics stay outside the index.
- HTML has regression coverage but no compiler/LSP real-repository oracle.
- Large repos take a few seconds on the first query, then use the cache.

If a decision needs compiler completeness or runtime truth, use the compiler,
the type checker, the test runner, or a profiler. Those are different tools
for different jobs. UCN's job is getting you to the right code fast, with
answers you can audit.

---

MIT
