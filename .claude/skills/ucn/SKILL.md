---
name: ucn
description: "Code relationship analyzer (callers, call trees, impact, dead code) via tree-sitter AST. PREFER over grep+read when you need: who calls a function, what breaks if you change it, or the full call chain of a pipeline. One `ucn about` replaces 3-4 grep+read cycles. One `ucn trace` maps an entire execution flow without reading any files. Works on Python, JS/TS, Go, Rust, Java, HTML. Skip for plain text search or codebases under 500 LOC."
allowed-tools: Bash(ucn *), Bash(npx ucn *)
argument-hint: "[command] [symbol-name] [--flags]"
---

# UCN — Universal Code Navigator

Understands code structure via tree-sitter ASTs: who calls what, what breaks if you change something, full call trees, dead code. Works on Python, JS/TS, Go, Rust, Java, HTML (inline scripts).

## When to Reach for UCN Instead of Grep/Read

**Use UCN when your next action would be:**

- "Let me grep for all callers of this function" → `ucn impact <name>` — finds every call site, grouped by file, with args shown
- "Let me read this 800-line file to find one function" → `ucn fn <name> --file=<hint>` — extracts just that function
- "Let me trace through this code to understand the flow" → `ucn trace <name> --depth=3` — shows the full call tree without reading any files
- "I need to understand this function before changing it" → `ucn about <name>` — returns definition + callers + callees + tests + source in one call
- "I wonder if anything still uses this code" → `ucn deadcode` — lists every function/class with zero callers

**Stick with grep/read when:**

- Searching for a string literal, error message, TODO, or config value
- The codebase is under 500 LOC — just read the files
- Language not supported (only Python, JS/TS, Go, Rust, Java, HTML)
- Finding files by name — use glob

## The 5 Commands You'll Use Most

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

### 3. `trace` — Understand execution flow

Draws the call tree downward from any function. Compact by default; setting `--depth=N` shows the full tree to that depth with all children expanded.

```bash
ucn trace generate_report            # compact (depth 3, limited breadth)
ucn trace generate_report --depth=5  # full tree to depth 5, all children shown
ucn trace generate_report --all      # all children at default depth
```

Shows the entire pipeline — what `generate_report` calls, what those functions call, etc. — as an indented tree. No file reading needed. Invaluable for understanding orchestrator functions or entry points.

### 4. `fn` / `class` — Extract without reading the whole file

Pull one function or class out of a large file. Saves hundreds of lines of context window.

```bash
ucn fn handle_request --file=api    # --file disambiguates when name exists in multiple files
ucn class MarketDataFetcher
```

### 5. `deadcode` — Find unused code

Lists all functions and classes with zero callers across the project.

```bash
ucn deadcode                        # Everything
ucn deadcode --exclude=test         # Skip test files (most useful)
```

## When to Use the Other Commands

| Situation | Command | What it does |
|-----------|---------|-------------|
| Need function + all its helpers inline | `ucn smart <name>` | Returns function source with every helper it calls expanded below it. Use instead of `about` when you need code, not metadata |
| What changed and who's affected | `ucn diff-impact --base=main` | Shows changed functions + their callers from git diff |
| Checking if a refactor broke signatures | `ucn verify <name>` | Validates all call sites match the function's parameter count |
| Understanding a file's role in the project | `ucn imports <file>` | What it depends on |
| Understanding who depends on a file | `ucn exporters <file>` | Which files import it |
| Quick project overview | `ucn toc` | Every file with function/class counts and line counts |
| Finding all usages (not just calls) | `ucn usages <name>` | Groups into: definitions, calls, imports, type references |
| Finding sibling/related functions | `ucn related <name>` | Name-based + structural matching (same file, shared deps). Not semantic — best for parse/format pairs |
| Preview a rename or param change | `ucn plan <name> --rename-to=new_name` | Shows what would change without doing it |
| File-level dependency tree | `ucn graph <file> --depth=1` | Visual import tree. Setting `--depth=N` expands all children. Can be noisy — use depth=1 for large projects. For function-level flow, use `trace` instead |
| Find which tests cover a function | `ucn tests <name>` | Test files and test function names |

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
| `--context=N` | Lines of surrounding context in `usages`/`search` output |

## Workflow Integration

**Investigating a bug:**
```bash
ucn about problematic_function          # Understand it fully
ucn trace problematic_function --depth=2  # See what it calls
```

**Before modifying a function:**
```bash
ucn impact the_function                 # Who will break?
ucn smart the_function                  # See it + its helpers
# ... make your changes ...
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
