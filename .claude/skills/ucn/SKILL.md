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
```

### 4. `trace` — Understand execution flow (downward)

Draws the call tree downward from any function. Compact by default; setting `--depth=N` shows the full tree to that depth with all children expanded.

```bash
ucn trace generate_report            # compact (depth 3, limited breadth)
ucn trace generate_report --depth=5  # full tree to depth 5, all children shown
ucn trace generate_report --all      # all children at default depth
```

Shows the entire pipeline — what `generate_report` calls, what those functions call, etc. — as an indented tree. No file reading needed. Invaluable for understanding orchestrator functions or entry points.

### 5. `fn` / `class` — Extract without reading the whole file

Pull one or more functions out of a large file. Supports comma-separated names for bulk extraction.

```bash
ucn fn handle_request --file=api    # --file disambiguates when name exists in multiple files
ucn fn parse,format,validate        # Extract multiple functions in one call
ucn class MarketDataFetcher
```

### 6. `deadcode` — Find unused code

Lists all functions and classes with zero callers across the project. Framework entry points (Express routes, Spring controllers, Celery tasks, etc.) are automatically excluded.

```bash
ucn deadcode                        # Everything
ucn deadcode --exclude=test         # Skip test files (most useful)
ucn deadcode --include-decorated    # Include framework-registered functions
```

### 7. `entrypoints` — Detect framework entry points

Lists functions registered as framework handlers (HTTP routes, DI beans, job schedulers, etc.). Detects patterns across Express, FastAPI, Flask, Spring, Gin, Actix, Celery, pytest, and more.

```bash
ucn entrypoints                          # All detected entry points
ucn entrypoints --type=http              # HTTP routes only
ucn entrypoints --framework=express      # Specific framework
ucn entrypoints --file=routes/           # Scoped to files
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
| Project complexity stats | `ucn stats` | File counts, symbol counts, lines by language. `--functions` for per-function line counts |
| Find by glob pattern | `ucn find "handle*"` | Locate definitions matching a glob (supports * and ?) |
| Text search with context | `ucn search term --context=3` | Like grep -C 3, shows surrounding lines |
| Regex search (default) | `ucn search '\d+'` | Search supports regex by default (alternation, character classes, etc.) |
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
| Find which tests cover a function | `ucn tests <name>` | Test files and test function names |
| Extract specific lines from a file | `ucn lines --file=<file> --range=10-20` | Pull a line range without reading the whole file |
| Find type definitions | `ucn typedef <name>` | Interfaces, enums, structs, traits, type aliases |
| See a project's public API | `ucn api` or `ucn api --file=<file>` | All exported/public symbols with signatures |
| Drill into context results | `ucn expand <N>` | Show source code for item N from a previous `context` call |
| Best usage example of a function | `ucn example <name>` | Finds and scores the best call site with surrounding context |
| Debug a stack trace | `ucn stacktrace --stack="<trace>"` | Parses stack frames and shows source context per frame |

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
| `--class-name=X` | Scope to specific class (e.g., `--class-name=Repository` for method `save`) |
| `--file=<pattern>` | Disambiguate when a name exists in multiple files (e.g., `--file=api`) |
| `--exclude=test,mock` | Focus on production code only |
| `--in=src/core` | Limit search to a subdirectory |
| `--depth=N` | Control tree depth for `trace` and `graph` (default 3). Also expands all children — no breadth limit |
| `--all` | Expand truncated sections in `about`, `trace`, `graph`, `related` |
| `--include-tests` | Include test files in results (excluded by default) |
| `--include-methods` | Include `obj.method()` calls in `context`/`smart` (only direct calls shown by default) |
| `--base=<ref>` | Git ref for diff-impact (default: HEAD) |
| `--staged` | Analyze staged changes (diff-impact) |
| `--no-cache` | Force re-index after editing files |
| `--clear-cache` | Delete cached index entirely before running |
| `--context=N` | Lines of surrounding context in `usages`/`search` output |
| `--no-regex` | Force plain text search (regex is default) |
| `--functions` | Show per-function line counts in `stats` (complexity audit) |
| `--json` | Machine-readable JSON output (wrapped in `{meta, data}`) |
| `--code-only` | Exclude matches in comments and strings (`search`/`usages`) |
| `--with-types` | Include related type definitions in `smart`/`about` output |
| `--detailed` | Show full symbol listing per file in `toc` |
| `--top-level` | Show only top-level functions in `toc` (exclude nested/indented) |
| `--top=N` | Limit result count (default: 10 for most commands) |
| `--limit=N` | Limit result count for `find`, `usages`, `search`, `deadcode`, `api`, `toc` |
| `--max-files=N` | Max files to index (for large projects with 10K+ files) |
| `--max-lines=N` | Max source lines for `class` (large classes show summary by default) |
| `--case-sensitive` | Case-sensitive text search (default: case-insensitive) |
| `--exact` | Exact name match only in `find`/`typedef` (no substring) |
| `--include-uncertain` | Include ambiguous/uncertain matches in `context`/`smart`/`about` |
| `--show-confidence` | Show confidence scores (0.0–1.0) per caller/callee edge in `context`/`about` |
| `--min-confidence=N` | Filter edges below confidence threshold (e.g., `--min-confidence=0.7` keeps only high-confidence edges) |
| `--calls-only` | Only show call/test-case matches in `tests` (skip file-level results) |
| `--add-param=<name>` | Add a parameter (`plan` command). Combine with `--default=<value>` |
| `--remove-param=<name>` | Remove a parameter (`plan` command) |
| `--rename-to=<name>` | Rename a function (`plan` command) |
| `--include-exported` | Include exported symbols in `deadcode` results |
| `--include-decorated` | Include decorated/annotated symbols in `deadcode` results |
| `--framework=X` | Filter `entrypoints` by framework (e.g., `express`, `spring`, `celery`) |
| `--type=<kind>` | Structural search: `function`, `class`, `call`, `method`, `type`. Triggers index query instead of text grep |
| `--param=<name>` | Structural search: filter by parameter name or type (e.g., `--param=Request`) |
| `--receiver=<name>` | Structural search: filter calls by receiver (e.g., `--receiver=db` for all db.* calls) |
| `--returns=<type>` | Structural search: filter by return type (e.g., `--returns=error`) |
| `--decorator=<name>` | Structural search: filter by decorator/annotation (e.g., `--decorator=Route`) |
| `--exported` | Structural search: only exported/public symbols |
| `--unused` | Structural search: only symbols with zero callers |

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
