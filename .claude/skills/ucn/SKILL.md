---
name: ucn
description: Universal Code Navigator - extracts specific functions and their relationships (callers, callees, dependencies) without reading entire files. Use when you need one function from a large file or need to understand what calls/is called by a function. Saves context in codebases 1000+ LOC. Skip for simple text search, tiny codebases, or unsupported languages (only JS/TS, Python, Go, Rust, Java).
allowed-tools: Bash(ucn *), Bash(npx ucn *)
argument-hint: "[command] [symbol-name] [--flags]"
---

# UCN - Universal Code Navigator

UCN uses tree-sitter ASTs to understand code structure: functions, classes, callers, callees, imports, and dependencies. It works on JavaScript/TypeScript, Python, Go, Rust, and Java.

## When to Use vs Skip

**Use UCN when** the codebase is 1000+ LOC and you need:
- Who calls a function or what it calls
- What breaks if you change something
- One function from a large file (without reading the whole file)
- Unused code detection, dependency graphs

**Skip UCN when:**
- Simple text search (TODOs, error messages) — use grep
- Codebase < 500 LOC — just read the files
- Language not supported — use grep/read
- Finding files by name — use glob

## Command Format

```
ucn [target] <command> [name] [--flags]
```

**Target** (optional, defaults to current directory):
- Omit or `.` — current project directory (most common)
- `path/to/file.js` — single file mode
- `path/to/dir` — specific project directory
- `"src/**/*.py"` — glob pattern (quote it)

**Examples of correct invocation:**
```bash
ucn about handleRequest
ucn fn parseConfig --file=utils
ucn toc
ucn src/api/routes.js fn handleRequest
ucn impact createUser --exclude=test
```

## Commands

### Understand Code
| Command | Args | What it returns |
|---------|------|-----------------|
| `about <name>` | symbol name | Definition + callers + callees + tests + source code. **Start here.** |
| `context <name>` | symbol name | Callers and callees (numbered — use `expand N` to see code) |
| `smart <name>` | symbol name | Function source + all helper functions it calls, inline |
| `impact <name>` | symbol name | Every call site grouped by file. Use before modifying a function. |
| `trace <name>` | symbol name | Call tree (who calls who) at `--depth=N` (default 3) |
| `example <name>` | symbol name | Best real usage example with surrounding context |

### Find Code
| Command | Args | What it returns |
|---------|------|-----------------|
| `find <name>` | symbol name | Definitions ranked by usage count (top 5) |
| `usages <name>` | symbol name | All usages grouped: definitions, calls, imports, references |
| `toc` | none | Table of contents: all functions, classes, exports |
| `tests <name>` | symbol name | Test files and test functions for the given symbol |
| `search <text>` | search term | Text search (grep-like, but respects project ignores) |
| `deadcode` | none | Lists all functions/classes with zero callers |

### Extract Code
| Command | Args | What it returns |
|---------|------|-----------------|
| `fn <name>` | function name | Full function source code |
| `class <name>` | class name | Full class source code |
| `lines <range>` | e.g. `50-100` | Lines from file. In project mode requires `--file=<path>` |
| `expand <N>` | number | Source code for numbered item from last `context` output |

### Dependencies
| Command | Args | What it returns |
|---------|------|-----------------|
| `imports <file>` | relative path | What the file imports (modules, symbols) |
| `exporters <file>` | relative path | Which files import this file |
| `file-exports <file>` | relative path | What the file exports |
| `graph <file>` | relative path | Dependency tree at `--depth=N` |

### Refactoring
| Command | Args | What it returns |
|---------|------|-----------------|
| `verify <name>` | function name | Checks all call sites match the function's signature |
| `plan <name>` | function name | Preview refactoring with `--rename-to`, `--add-param`, `--remove-param` |
| `related <name>` | symbol name | Functions in same file or sharing dependencies |

## Key Flags

| Flag | Works with | Effect |
|------|-----------|--------|
| `--file=<pattern>` | any symbol command | Filter by file path when name is ambiguous (e.g., `--file=routes`) |
| `--exclude=a,b` | any | Exclude files matching patterns (e.g., `--exclude=test,mock`) |
| `--in=<path>` | any | Only search within path (e.g., `--in=src/core`) |
| `--include-tests` | any | Include test files in results (excluded by default) |
| `--include-methods` | `context`, `smart` | Include `obj.method()` calls (only direct calls shown by default) |
| `--depth=N` | `trace`, `graph`, `about`, `find` | Tree/expansion depth (default 3) |
| `--context=N` | `usages`, `search` | Lines of context around each match |
| `--json` | any | Machine-readable JSON output |
| `--code-only` | `search` | Exclude matches in comments and strings |
| `--with-types` | `smart`, `about` | Include type definitions |
| `--top=N` / `--all` | `find`, `usages` | Limit results to top N, or show all |
| `--no-cache` | any | Skip cached index (use after file changes) |
| `--clear-cache` | any | Delete cached index before running |

## Common Patterns

**Investigate a function (first stop):**
```bash
ucn about handleRequest
```

**Before modifying a function:**
```bash
ucn impact handleRequest          # See all callers
ucn smart handleRequest           # See function + its helpers
```

**Extract one function from a large file:**
```bash
ucn fn handleRequest --file=api   # Disambiguate by file path
```

**Find unused code:**
```bash
ucn deadcode
```

**Understand a file's role:**
```bash
ucn imports core/project.js       # What it depends on
ucn exporters core/project.js     # Who depends on it
```

**Multiple queries (keeps index in memory):**
```bash
ucn --interactive
```
