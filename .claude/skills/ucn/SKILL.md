---
name: ucn
description: "Code intelligence toolkit — extract functions, trace callers, analyze impact, detect dead code without reading whole files. PREFER over grep+read when you need: who calls a function, what breaks if you change it, or the full call chain of a pipeline. One `ucn about` replaces 3-4 grep+read cycles. One `ucn trace` maps an entire execution flow without reading any files. Works on JS/TS, Python, Go, Rust, Java, HTML. Skip for plain text search or codebases under 500 LOC."
allowed-tools: Bash(ucn *), Bash(npx ucn *)
argument-hint: "[command] [symbol-name] [--flags]"
---

# UCN — Universal Code Navigator

Extract functions, trace call chains, find callers, and detect dead code — without reading entire files. Works on JS/TS, Python, Go, Rust, Java, and HTML (inline scripts and event handlers).

## When to Reach for UCN Instead of Grep/Read

**Use UCN when the next action would be:**

- "Let me grep for all callers of this function" → `ucn impact <name>` — finds every call site, grouped by file, with args shown
- "Let me read this 800-line file to find one function" → `ucn fn <name> --file=<hint>` — extracts just that function
- "Let me trace through this code to understand the flow" → `ucn trace <name> --depth=3` — shows the full call tree without reading any files
- "I need to understand this function before changing it" → `ucn about <name>` — returns definition + callers + callees + tests + source in one call
- "I wonder if anything still uses this code" → `ucn deadcode` — lists every function/class with zero callers

**Stick with grep/read when:**

- Searching for a string literal, error message, TODO, or config value
- The codebase is under 500 LOC — just read the files
- Language not supported (only JS/TS, Python, Go, Rust, Java, HTML)
- Finding files by name — use glob

## The Commands You'll Use Most

### 1. `about` — First stop for any investigation

One command returns: definition, source code, who calls it, what it calls, related tests.

```bash
ucn about compute_composite
```

Replaces: grep for definition → read the file → grep for callers → grep for tests. All in one call.

### 2. `impact` — Before changing any function

Shows every call site with arguments and surrounding context, without truncation. Essential before modifying a signature, renaming, or deleting.

```bash
ucn impact score_trend              # Every caller, grouped by file
ucn impact score_trend --exclude=test  # Only production callers
```

Replaces: grep for the function name → manually filtering definitions vs calls vs imports → reading context around each match.

### 3. `blast` — Transitive blast radius

Walks UP the caller chain recursively. Shows the full tree of functions affected transitively if you change something. Like `impact` but recursive — answers "what breaks if I change this, including indirect callers?"

```bash
ucn blast helper                     # callers of callers (depth 3)
ucn blast helper --depth=5           # deeper chain
ucn blast helper --exclude=test      # skip test callers
ucn blast helper --expand-unverified # follow unverified edges too (marked ⚠, possible impact)
```

The tree trunk is confirmed-evidence-only; dispatch-possible/ambiguous caller candidates appear in an `UNVERIFIED EDGES` section (see "Reading Tiered Output" below).

### 4. `trace` — Understand execution flow (downward)

Draws the call tree downward from any function. Compact by default; setting `--depth=N` shows the full tree to that depth with all children expanded.

```bash
ucn trace generate_report            # compact (depth 3, limited breadth)
ucn trace generate_report --depth=5  # full tree to depth 5, all children shown
ucn trace generate_report --all      # all children at default depth
```

Shows the entire pipeline — what `generate_report` calls, what those functions call, etc. — as an indented tree. No file reading needed. Invaluable for understanding orchestrator functions or entry points.

**Prefer `trace` over chained `about` calls.** If you find yourself running `ucn about` 4–5 times in a row to follow a call chain (entry → leaves), one `ucn trace <fn> --depth=N` returns the same information in a single call. Use `--depth=N` to limit how deep the tree goes.

### 5. `fn` / `class` — Extract without reading the whole file

Pull one or more functions out of a large file. Supports comma-separated names for bulk extraction.

```bash
ucn fn handle_request --file=api    # --file disambiguates when name exists in multiple files
ucn fn parse,format,validate        # Extract multiple functions in one call
ucn class MarketDataFetcher
```

### 6. `deadcode` — Find unused code

Lists all functions and classes with zero callers across the project. Framework entry points (Express routes, Spring controllers, Celery tasks, etc.) and exported/public API symbols — including methods of exported classes in JS/TS/Python — are automatically excluded (`--include-exported` audits them). Interface/trait method declarations are labeled `[declared on interface X — contract surface, not executable code]`: unreferenced is true, but deleting one changes the API contract, not dead logic.

```bash
ucn deadcode                        # Everything
ucn deadcode --exclude=test         # Skip test files (most useful)
ucn deadcode --include-decorated    # Include framework-registered functions
ucn deadcode --include-exported     # Audit exported/public API symbols too
```

### 7. `brief` — One-screen "before-I-touch-this" summary

AST-only summary of a function: typed signature, first sentence of docstring,
side-effect classification (fs/network/process/global_mutation), and complexity
metrics (branches, depth, line count). Lighter than `about`, more useful than
`fn` when you don't need the body.

```bash
ucn brief fetch_user
# fetch_user(user_id: int): dict
#   svc.py:4-8  (5 lines)
#   "Fetch a user from the API."
#   async: no  |  side_effects: [fs, network, process]  |  complexity: branches=2, depth=2
```

### 8. `doctor` — Project trust report

One command that tells you how much UCN trusts the index for this project:
file/symbol counts, language breakdown, dynamic-import / eval / reflection
blind spots, parse failures, and a verdict (HIGH/MEDIUM/LOW). Add `--deep` to
sample resolution coverage and bucket edges by confidence.

```bash
ucn doctor                # fast: counts + blind spots + verdict
ucn doctor --deep         # also samples resolution coverage
ucn doctor --in=src/core  # scope to a subtree
```

### 9. `check` — Pre-commit summary

Composes `diff-impact` + `verify` + `affected-tests` into one output. Lists
changed/added/deleted functions, flags signature drift across call sites,
calls out new functions with no callers, and recommends which tests to run.

```bash
ucn check                  # vs HEAD
ucn check --base=main      # vs main branch
ucn check --staged         # only staged changes
```

### 10. `entrypoints` — Detect framework entry points

Lists functions registered as framework handlers (HTTP routes, DI beans, job schedulers, etc.). Detects patterns across Express, FastAPI, Flask, Spring, Gin, Actix, Celery, pytest, and more.

```bash
ucn entrypoints                          # All detected entry points (tests included by default)
ucn entrypoints --type=http              # HTTP routes only
ucn entrypoints --framework=express      # Specific framework
ucn entrypoints --file=routes/           # Scoped to files
ucn entrypoints --exclude-tests          # Hide test fixtures (JUnit @Test, pytest, Rust #[test], etc.)
```

## When to Use the Other Commands

| Situation | Command | What it does |
|-----------|---------|-------------|
| Quick callers + callees list | `ucn context <name>` | Who calls it and what it calls. Results are numbered for `expand`. Use instead of `about` when you just need the call graph, not source code |
| Need function + all its helpers inline | `ucn smart <name>` | Returns function source with every helper it calls expanded below it. Use instead of `about` when you need code, not metadata |
| Full transitive blast radius | `ucn blast <name> --depth=5` | Callers of callers — the full chain of what breaks if you change something |
| How execution reaches a function | `ucn reverse-trace <name>` | Walk UP callers to entry points (★ marked). Shows how code flows to this function. Default depth=5 |
| Which tests to run after a change | `ucn affected-tests <name>` | Blast + test detection: shows test files, coverage %, uncovered functions. Use `--depth=N` to control depth |
| What changed and who's affected | `ucn diff-impact --base=main` | Shows changed functions + their callers from git diff |
| Checking if a refactor broke signatures | `ucn verify <name>` | Validates all call sites match the function's parameter count |
| Understanding a file's role in the project | `ucn imports <file>` | What it depends on |
| Understanding who depends on a file | `ucn exporters <file>` | Which files import it |
| See what a file exports | `ucn file-exports <file>` | All exported functions, classes, variables with signatures |
| Quick project overview | `ucn toc` | Every file with function/class counts and line counts |
| Project complexity stats | `ucn stats` | File counts, symbol counts, lines by language. `--functions` for per-function line counts. `--hot --top=N` for the most-called functions (orientation primitive on a new repo) |
| Find by glob pattern | `ucn find "handle*"` | Locate definitions matching a glob (supports * and ?) |
| Text search with context | `ucn search term --context=3` | Like grep -C 3, shows surrounding lines |
| Regex search (default) | `ucn search '\d+'` | JavaScript regex (V8 engine). See "Regex notes" below for syntax — alternation is `a|b`, not grep-style |
| Text search filtered | `ucn search term --exclude=test` | Search only in matching files |
| Structural search (index) | `ucn search --type=function --param=Request` | Query the symbol table, not text. Finds functions by param, return type, decorator, etc. |
| Find all db.* calls | `ucn search --type=call --receiver=db` | Search call sites by receiver — something grep can't do |
| Find exported functions | `ucn search --type=function --exported` | Only exported/public symbols |
| Find unused symbols | `ucn search --type=function --unused` | Mini deadcode: zero callers |
| Find decorated functions | `ucn search --decorator=Route` | Functions/classes with a specific decorator/annotation |
| Finding all usages (not just calls) | `ucn usages <name>` | Groups into: definitions, calls, imports, type references |
| Finding sibling/related functions | `ucn related <name>` | Name-based + structural matching (same file, shared deps). Not semantic — best for parse/format pairs |
| Preview a rename or param change | `ucn plan <name> --rename-to=new_name` | Shows what would change without doing it |
| File-level dependency tree | `ucn graph <file> --depth=1` | Visual import tree. Setting `--depth=N` expands all children. Can be noisy — use depth=1 for large projects. For function-level flow, use `trace` instead |
| Are there circular dependencies? | `ucn circular-deps` | Detect circular import chains. `--file=<pattern>` filters to cycles involving a file. `--exclude=test` skips test files |
| What are the framework entry points? | `ucn entrypoints` | Lists all detected routes, DI beans, tasks, etc. Filter: `--type=http`, `--framework=express` |
| Polyglot route ↔ request matching | `ucn endpoints --bridge` | Server routes (Express/Fastify/Koa/NestJS/Flask/FastAPI/Spring/JAX-RS/Gin/Echo/Chi/Fiber/axum/actix/Next.js) ↔ client requests (fetch/axios/requests/httpx/RestTemplate/WebClient/reqwest). Match confidence: EXACT, PARTIAL, UNCERTAIN. Filter with `--method`, `--prefix`, `--server-only`, `--client-only`, `--unmatched`, `--hide-uncertain` |
| Find which tests cover a function | `ucn tests <name>` | Test files and test function names. Scope with `--file`, `--class-name`, `--exclude`, `--calls-only` |
| Extract specific lines from a file | `ucn lines 10-20 --file=<file>` | Pull a line range without reading the whole file |
| Find type definitions | `ucn typedef <name>` | Interfaces, enums, structs, traits, type aliases |
| See a project's public API | `ucn api` or `ucn api --file=<file>` | All exported/public symbols with signatures |
| Drill into context results | `ucn expand <N>` | Show source code for item N from a previous `context` call |
| Best usage example of a function | `ucn example <name>` | Finds and scores the best call site with surrounding context |
| Debug a stack trace | `ucn stacktrace --stack="<trace>"` | Parses stack frames and shows source context per frame |
| Quick look before touching a function | `ucn brief <name>` | Signature + docstring + side effects + complexity, one screen |
| Project trust report | `ucn doctor [--deep]` | Index coverage, blind spots, parse failures, verdict |
| Pre-commit summary | `ucn check [--base=main]` | Changed funcs + signature drift + affected tests in one shot |
| Find missing-await bugs | `ucn audit-async` | Lists async calls inside async functions that lack `await`. JS/TS/Python only. Filter with `--file`, `--exclude`, `--limit` |

## Regex Notes (`search` command)

`search` uses **JavaScript regex** (the V8 engine), not grep BRE/ERE. Common gotchas:

- Alternation is `a|b`, **not** `a\|b`. `ucn search "flask|fastapi|django"` works; `ucn search "flask\|fastapi\|django"` matches the literal string.
- `(`, `[`, `{` outside character classes do **not** need escaping for literal match in most cases — but normal JS regex semantics apply (you can still escape them for clarity).
- Wrap the pattern in single quotes so the shell does not interpret special characters (`*`, `?`, `\`, `$`, etc.).
- Default is case-insensitive; pass `--case-sensitive` to flip.
- `--no-regex` forces literal-string search if you need to match regex metacharacters as text without escaping.

## Reading Call-Site Patterns

`verify`, `impact`, and `about` annotate call sites with structural classification flags. Watch for these in summary lines (`Patterns: 4 in try, 4 in callback`) and per-call-site entries:

| Flag | What it means | Why it matters |
|------|--------------|---------------|
| `inLoop` | Call is inside a `for`/`while`/comprehension | N+1 query risk, repeated work, performance hot path |
| `inTry` | Call is wrapped in try/catch (or equivalent) | Errors are handled — different from "must fix" code paths |
| `inCallback` | Call sits inside a callback/lambda/closure that's not the enclosing function | Async deferred work, may run on a different stack frame |
| `inTestCase` | Call originates from inside a test function | Isolate production callers from test setup |
| `awaited` | Call's parent is `await` / `Promise.then` (JS/TS/Python) | Confirms async coordination — its absence on async callees signals a missing-await bug |

`audit-async` is the focused tool for the `awaited=false` case across an entire async function body.

## Reading Tiered Output (about / context / impact / trace / blast / reverse-trace / affected-tests / diff-impact / verify / plan / check)

Caller answers are a **partition of every text occurrence** of the symbol — nothing is silently hidden. Sections:

- `CALLERS — CONFIRMED (N, X prod + Y test):` — edges with binding/receiver/import evidence. Prod callers listed first, then a `test callers:` subheader. An `evidence:` line aggregates resolution labels for the section.
- `CALLERS — UNVERIFIED (N) — call syntax, no binding/receiver evidence:` — name-matched call sites the engine could not verify, one line each with the reason (`method-no-evidence`, `ambiguous-binding`, `call-not-resolved`). Capped at 10; `--all` lifts the cap. **Treat these as possible callers when refactoring.**
- `NON-CALL OCCURRENCES: N (...)` — imports/definitions/references/other-text, counts only (drill in with `ucn usages <name>`).
- `ACCOUNT:` — the reconciliation line. Every ground line is in exactly one bucket; `0 unaccounted` means the partition is complete. `+N beyond-text callers` are alias-resolved call sites plain text search would miss.
- `WARNING: N unparsed file(s) ...` — files containing the symbol that failed to parse. Their lines were NOT analyzed — fall back to text search for those files.
- `FILTERED: N hidden by flags` — entries your display flags hid (they still count in ACCOUNT).

**Trust rules:** a CONFIRMED(0) + UNVERIFIED(0) answer with `0 unaccounted` and no WARNING means the symbol genuinely has no callers — safe to act on, same as a clean grep. Any UNVERIFIED entries or WARNINGs mean: verify those sites before a breaking change.

Resolution labels in `evidence:` lines (high to low): `exact-binding` (0.98, import/binding evidence) · `same-class` (0.92) · `receiver-hint` (0.80, inferred receiver type) · `scope-match` (0.65, import/receiver-binding scope evidence) · `name-only` (0.40) · `uncertain` (0.25). Confirmed tier = scope-match and above. JSON output keeps per-edge decimals plus `tier`.

Flags: `--min-confidence=0.7` filters confirmed edges (hidden count appears in FILTERED). `--include-uncertain` and `--include-methods` have **no effect** on tiered commands (about/context/impact/trace/blast/reverse-trace/affected-tests/diff-impact/verify/plan/smart) — everything is always shown, tiered by evidence.

### Refactor commands run the same contract (v4)

- `verify` arg-checks the **confirmed** band only; candidates without evidence render in `UNVERIFIED CALL SITES (N)` with reasons and are NOT arg-checked (they may target another symbol). A wrong-arity method call with binding evidence is flagged **by default** now. The `ACCOUNT:` line reconciles.
- `plan` plans changes for confirmed sites; `UNVERIFIED CALL SITES` lists sites that MAY also need the change — review them before refactoring. Plan and verify agree by construction.
- `diff-impact` reports per-changed-function confirmed `Callers` + `Unverified call sites` + a per-symbol `ACCOUNT:` line. `check` shows `N callers (+M unverified)` per changed function; ORPHAN requires zero candidates in BOTH tiers.
- `context`/`smart` also account the **callee** side: `CALLEES — UNVERIFIED (N)` entries + a `CALLEE ACCOUNT:` arithmetic line.

### Advisory commands self-label

`related`, `example`, `stacktrace`, and `endpoints --bridge` print an `Advisory:` line (and carry an `advisory` field in JSON): their answers are ranked heuristics, not verified claims. Contracted commands carry accounts; advisory commands say so — there is no third category.

### Tree commands (trace / blast / reverse-trace / affected-tests)

The tree trunk holds **confirmed edges only**. Unverified caller candidates render in an `UNVERIFIED EDGES` section with parent attribution (`at <node> (hop N): file:line [enclosing fn] (reason)`) and are **not expanded by default** — pass `--expand-unverified` to follow them; every downstream node is then marked `[⚠ via <reason>]` / `[⚠ unverified chain]` and counted as *possibly affected*, never confirmed. Unresolved callee calls (`trace` down) render as `[unverified] name — reason` leaves under their node. Reconciliation lines:

- `ACCOUNT:` — the root hop's text-ground partition (same as context/impact).
- `TREE ACCOUNT:` — interior conservation: nodes expanded, confirmed/unverified/excluded edge counts by reason, depth-limit cuts.
- `CALLEE ACCOUNT:` (trace down) — every call site in every expanded node lands in confirmed/unverified/external/excluded/filtered.

`reverse-trace` marks `★ entry point` only when a node has **zero candidates in both tiers**; zero confirmed with unverified candidates shows `⚠ no confirmed callers — N unverified` instead. `affected-tests` splits its answer into the confirmed band (`Test files to run`, coverage, `Uncovered`) and a `POSSIBLY AFFECTED` band (functions + test files reachable only through unverified chains).

## Symbol Handles (stable IDs)

Every result that lists a symbol emits a **handle** in the form `relativePath:line:name` (e.g. `core/api.ts:42:handler`). Pass it back to any name-accepting command and resolution is pinned to that exact definition — no name disambiguation, no `--file` needed.

```bash
ucn find handler                  # → emits  src/api.ts:42:handler
ucn brief src/api.ts:42:handler   # pins to that exact one
ucn impact src/api.ts:42:handler  # same
```

The shorter `relativePath:line` form (no `:name`) also works — UCN looks up the symbol by location. Plain names (`handler`) still work for the fuzzy/heuristic path.

## Command Format

```
ucn [target] <command> [name] [--flags]
```

**Target** (optional, defaults to current directory):
- Omit — scans current project (most common)
- `path/to/file.py` — single file
- `path/to/dir` — specific directory
- `"src/**/*.py"` — glob pattern (quote it)

## Key Flags

| Flag | When to use it |
|------|---------------|
| `--class-name=X` | Scope to specific class (e.g., `--class-name=Repository` for method `save`). Works with `about`, `context`, `impact`, `blast`, `smart`, `trace`, `reverse-trace`, `example`, `related`, `brief`, `find`, `usages`, `tests`, `affected-tests`, `fn`, `verify`, `plan`, `typedef` |
| `--file=<pattern>` | Disambiguate when a name exists in multiple files (e.g., `--file=api`) |
| `--exclude=test,mock` | Focus on production code only |
| `--in=src/core` | Limit search to a subdirectory |
| `--depth=N` | Control tree depth for `trace`, `graph`, and detail level for `find` (default 3). Also expands all children — no breadth limit |
| `--all` | Expand truncated sections. Applies to `about`, `blast`, `trace`, `reverse-trace`, `related`, `find`, `toc`, `fn`, `class`, `graph`, `diff-impact` |
| `--expand-unverified` | `blast`/`reverse-trace`: follow unverified caller edges in the tree. Downstream nodes are marked as unverified chains — possible, not confirmed, impact |
| `--include-tests` | Include test files in usage counts (`about`) and results (`find`, `usages`, `deadcode`). Callers always include tests. |
| `--exclude-tests` | Exclude test entries from `entrypoints` (tests are included by default since they ARE entry points). |
| `--include-methods` | Include `obj.method()` callee expansion in `trace`/`blast`/`smart`/`affected-tests`. No effect on `about`/`context`/`impact`/`verify` — method calls are always analyzed and tiered by receiver evidence |
| `--base=<ref>` | Git ref for diff-impact (default: HEAD) |
| `--staged` | Analyze staged changes (diff-impact) |
| `--no-cache` | Force re-index after editing files |
| `--clear-cache` | Delete cached index entirely before running |
| `--context=N` | Lines of surrounding context in `usages`/`search` output |
| `--no-regex` | Force plain text search (regex is default) |
| `--functions` | Show per-function line counts in `stats` (complexity audit) |
| `--hot` | List top N most-called functions in `stats` (use with `--top=N`, default 10). Best orientation primitive when entering a new repo |
| `--diverse` | Cluster `example` call sites by argument shape and return one representative per cluster (use with `--top=N`, default 3) |
| `--git` | Attach git enrichment to `about` / `brief`: last commit (ISO + author) and recent change count (last 30 days). Skipped silently when not a git repo |
| `--json` | Machine-readable JSON output. Some commands wrap in `{meta, data}` (e.g., `find`, `deadcode`); others return flat objects (e.g., `about`, `impact`, `verify`, `plan`, `imports`) — check each command's output shape |
| `--code-only` | Exclude matches in comments and strings (`search`/`usages`) |
| `--with-types` | Include related type definitions in `smart`/`about` output |
| `--detailed` | Show full symbol listing per file in `toc` |
| `--top-level` | Show only top-level functions in `toc` (exclude nested/indented) |
| `--top=N` | Limit result count (default: 10 for most commands) |
| `--limit=N` | Limit result count for `find`, `usages`, `toc`, `search`, `deadcode`, `entrypoints`, `endpoints`, `diff-impact`, `check`, `api`, `doctor`, `audit-async` |
| `--max-files=N` | Max files to index (for large projects with 10K+ files) |
| `--max-lines=N` | Max source lines for `class` (large classes show summary by default) |
| `--case-sensitive` | Case-sensitive text search (default: case-insensitive) |
| `--exact` | Exact name match only in `find`/`typedef` (no substring) |
| `--include-uncertain` | No effect on tiered commands — unverified candidates are always shown in their own section with reasons |
| `--hide-confidence` | Hide confidence scores (shown by default) in `context`/`about` |
| `--min-confidence=N` | Filter edges below confidence threshold (e.g., `--min-confidence=0.7` keeps only high-confidence edges) |
| `--calls-only` | Only show call/test-case matches in `tests` (skip file-level results) |
| `--add-param=<name>` | Add a parameter (`plan` command). Combine with `--default=<value>` |
| `--remove-param=<name>` | Remove a parameter (`plan` command) |
| `--rename-to=<name>` | Rename a function (`plan` command) |
| `--include-exported` | Include exported symbols in `deadcode` results |
| `--include-decorated` | Include decorated/annotated symbols in `deadcode` results |
| `--framework=X` | Filter `entrypoints` by framework (e.g., `express`, `spring`, `celery`) |
| `--bridge` | Match server routes to client requests (`endpoints`). Confidence tiers: EXACT, PARTIAL, UNCERTAIN |
| `--server-only` | Only list server routes (`endpoints`) |
| `--client-only` | Only list client requests (`endpoints`) |
| `--unmatched` | Only show routes/requests with no match (`endpoints`, pair with `--bridge`) |
| `--method=GET` | Filter by HTTP method (`endpoints`) |
| `--prefix=/api` | Filter routes/requests by path prefix (`endpoints`) |
| `--hide-uncertain` | Hide UNCERTAIN-confidence bridges (`endpoints`) |
| `--type=<kind>` | Structural search: `function`, `class`, `call`, `method`, `type`. Triggers index query instead of text grep |
| `--param=<name>` | Structural search: filter by parameter name or type (e.g., `--param=Request`) |
| `--receiver=<name>` | Structural search: filter calls by receiver (e.g., `--receiver=db` for all db.* calls) |
| `--returns=<type>` | Structural search: filter by return type (e.g., `--returns=error`) |
| `--decorator=<name>` | Structural search: filter by decorator/annotation (e.g., `--decorator=Route`) |
| `--exported` | Structural search: only exported/public symbols |
| `--unused` | Structural search: only symbols with zero callers |
| `--no-follow-symlinks` | Don't follow symbolic links during file discovery |
| `--workers=N` | Parallel build workers (auto-detect by default; `0` to disable; env: `UCN_WORKERS`) |
| `--deep` | `doctor` only: sample resolution coverage. Slower but produces confidence histogram. |
| `--compact` | One-line-per-item output for `about`/`context`/`find`/`usages`/`impact`. Halves token cost; same info. |

## Workflow Integration

**Investigating a bug:**
```bash
ucn about problematic_function          # Understand it fully
ucn trace problematic_function --depth=2  # See what it calls
```

**Before modifying a function:**
```bash
ucn impact the_function                 # Who will break? (direct callers)
ucn blast the_function                  # Who will break? (full transitive chain)
ucn affected-tests the_function         # Which tests to run after the change?
ucn smart the_function                  # See it + its helpers
# ... make changes ...
ucn verify the_function                 # Did all call sites survive?
```

**Before committing:**
```bash
ucn diff-impact                         # What changed vs HEAD + who calls it
ucn diff-impact --base=main             # What changed vs main branch
ucn diff-impact --staged                # Only staged changes
```

**Periodic maintenance:**
```bash
ucn deadcode --exclude=test             # What can be deleted?
ucn toc                                 # Project overview
```
