---
name: ucn
description: Semantic code navigation that understands code structure (functions, calls, dependencies) via AST parsing. Use when you need to understand relationships between code (who calls X, what does X call, what breaks if X changes). Better than text search for relationship questions in codebases 1000+ LOC. Supports JS/TS, Python, Go, Rust, Java only.
allowed-tools: Bash(ucn *), Bash(npx ucn *)
argument-hint: "[command] [symbol-name]"
---

# UCN - Semantic Code Navigation

## When to Use

UCN parses code into ASTs, so it understands structure - not just text patterns.

**Use UCN when:**
- You need to understand relationships (callers, callees, dependencies)
- You're about to modify code and need to know the impact
- You want to extract a specific function without reading the whole file
- Codebase is 1000+ LOC (indexing overhead pays off)

**Skip UCN when:**
- Simple text search (error messages, TODOs, literals)
- Codebase is tiny (< 500 LOC) - just read the files
- Language not supported (C, Ruby, PHP, etc.)

## Commands

### Understanding Code
```bash
ucn about <name>      # Definition, callers, callees, tests, code
ucn context <name>    # Callers + callees
ucn smart <name>      # Function + dependencies inline
ucn impact <name>     # All call sites by file
ucn trace <name>      # Call tree
ucn example <name>    # Best usage example with context
```

### Finding Code
```bash
ucn find <name>       # Find definitions
ucn usages <name>     # All usages by type
ucn toc               # Table of contents
ucn tests <name>      # Find tests for a function
ucn deadcode          # Find unused functions/classes
```

### Extracting Code
```bash
ucn fn <name>                    # Extract function
ucn fn <name> --file routes      # Disambiguate by path
ucn class <name>                 # Extract class
```

### Dependencies
```bash
ucn imports <file>      # What this file imports
ucn exporters <file>    # Who imports this file
ucn file-exports <file> # What this file exports
ucn graph <file>        # Dependency tree
```

## Flags

- `--file <pattern>` - Filter by file path
- `--exclude=test,mock` - Exclude files
- `--depth=N` - Tree depth
- `--context=N` - Lines of context around matches
- `--code-only` - Filter out comments and strings
- `--include-methods` - Include obj.method() calls
- `--include-tests` - Include test files
- `--no-cache` - Disable caching
- `--clear-cache` - Clear cache before running

## More Info

```bash
ucn --help            # Full command reference
```

## Installation

```bash
npm install -g ucn
```
