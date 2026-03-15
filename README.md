# UCN - Universal Code Navigator

See what code does before you touch it.

Find symbols, trace callers, check impact, pick the right tests, extract code and spot what's dead - from the terminal.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/mleoca/0e10a790e16ab61ddd233e05645e203e/raw/ucn-tests.json)](https://github.com/mleoca/ucn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

All commands, one engine, three surfaces:

```
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

Supports JavaScript, TypeScript, Python, Go, Rust, Java, and HTML inline scripts.

If you work with AI, add UCN as a [Skill or MCP](#ai-setup) and let the agent ask better code questions instead of reading whole files.
All commands ship as a single tool.

UCN is deliberately lightweight:

- **No background processes** - parses on demand, answers, exits
- **No language servers** - tree-sitter does the parsing, no compilation needed
- **MCP is optional** - only needed if you connect UCN to an AI agent, the CLI and Skill work on their own

---

```bash
npm install -g ucn

ucn trace main --depth=3       # full execution flow
ucn about handleRequest        # definition + callers + callees + tests
ucn impact handleRequest       # every call site with arguments
ucn deadcode --exclude=test    # unused code, AST-verified
```

"What happens when `build()` runs?"

```
$ ucn trace build --depth=2

build
├── detectProjectPattern (core/discovery.js:399) 1x
│   ├── checkDir (core/discovery.js:403) 2x
│   └── shouldIgnore (core/discovery.js:347) 1x
├── parseGitignore (core/discovery.js:130) 1x
├── expandGlob (core/discovery.js:190) 1x
│   ├── parseGlobPattern (core/discovery.js:226) 1x
│   ├── walkDir (core/discovery.js:283) 1x
│   └── compareNames (core/discovery.js:169) 1x
├── indexFile (core/project.js:273) 1x
│   ├── addSymbol (core/project.js:343) 4x
│   ├── detectLanguage (languages/index.js:157) 1x
│   ├── parse (core/parser.js:69) 1x
│   └── extractImports (core/imports.js:19) 1x
├── buildImportGraph (core/project.js:549) 1x
└── buildInheritanceGraph (core/project.js:627) 1x
```

One command. No files opened. Every function located by file and line.

---

## Understand code you didn't write

`ucn about` gives you everything about a function in one shot - who calls it, what it calls, which tests cover it, and the source code.

```
$ ucn about expandGlob

expandGlob (function)
════════════════════════════════════════════════════════════
core/discovery.js:190-221
expandGlob (pattern, options = {})

CALLERS (3):
  cli/index.js:859 [runGlobCommand]
    const files = expandGlob(pattern);
  core/cache.js:274 [isCacheStale]
    const currentFiles = expandGlob(pattern, globOpts);
  core/project.js:195 [build]
    const files = expandGlob(pattern, globOpts);

CALLEES (3):
  parseGlobPattern [utility] - core/discovery.js:226
  walkDir [utility] - core/discovery.js:283
  compareNames [utility] - core/discovery.js:169

TESTS: 6 matches in 2 file(s)
```

Need to trace execution upward instead? `ucn reverse-trace fn` walks the caller chain back to entry points.

## Change code without breaking things

Before touching a function, check if all existing call sites match its signature:

```
$ ucn verify expandGlob

expandGlob (pattern, options = {})
Expected arguments: 1-2

STATUS: ✓ All calls valid (7 calls, 0 mismatches)
```

Then preview the refactoring. UCN shows exactly what needs to change and where:

```
$ ucn plan expandGlob --rename-to=expandGlobPattern

SIGNATURE CHANGE:
  Before: expandGlob (pattern, options = {})
  After:  expandGlobPattern (pattern, options = {})

CHANGES NEEDED: 7 across 4 files

cli/index.js :859
  const files = expandGlob(pattern);
  → const files = expandGlobPattern(pattern);

core/cache.js :274
  const currentFiles = expandGlob(pattern, globOpts);
  → const currentFiles = expandGlobPattern(pattern, globOpts);

core/project.js :195
  const files = expandGlob(pattern, globOpts);
  → const files = expandGlobPattern(pattern, globOpts);
```

Run `ucn diff-impact --staged` before committing to see what you changed and who calls it.

## Find what to clean up

Which tests should you run after a change? `affected-tests` walks the blast radius and finds every test that touches the affected functions:

```
$ ucn affected-tests expandGlob

1 function changed → 18 functions affected (depth 3)
Summary: 18 affected → 12 test files, 11/18 functions covered (61%)

Uncovered (7): runGlobCommand, runProjectCommand, ...
  ⚠ These affected functions have no test references
```

## Find unused code

```
$ ucn deadcode --exclude=test

Dead code: 1 unused symbol(s)

core/discovery.js
  [ 162- 166] legacyResolve (function)
```

## Extract without reading the whole file

```
$ ucn fn compareNames

core/discovery.js:169
[ 169- 177] compareNames(a, b)
────────────────────────────────────────────────────────────
function compareNames(a, b) {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower < bLower) return -1;
    if (aLower > bLower) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}
```

---

## Testing and reliability

- **Fast** - uses incremental cache for optimal performance
- **Discipline** - every bug fix gets a regression test, test code is ~3x the source
- **Coverage** - every command, every supported language, every surface (CLI, MCP, interactive)
- **Systematic** - a harness exercises all command and flag combinations against real multi-language fixtures
- **Test types** - unit, integration, per-language regression, formatter, cache, MCP edge cases, architecture parity guards

---

## AI Setup

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
<summary>Or add to the MCP config file manually</summary>

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

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

---

## Full help

```text
UCN - Universal Code Navigator

Supported: JavaScript, TypeScript, Python, Go, Rust, Java, HTML

Usage:
  ucn [command] [args]            Project mode (current directory)
  ucn <file> [command] [args]     Single file mode
  ucn <dir> [command] [args]      Project mode (specific directory)
  ucn "pattern" [command] [args]  Glob pattern mode
  (Default output is text; add --json for machine-readable JSON)

═══════════════════════════════════════════════════════════════════════════════
UNDERSTAND CODE
═══════════════════════════════════════════════════════════════════════════════
  about <name>        Full picture (definition, callers, callees, tests, code)
  context <name>      Who calls this + what it calls (numbered for expand)
  smart <name>        Function + all dependencies inline
  impact <name>       What breaks if changed (call sites grouped by file)
  blast <name>        Transitive blast radius (callers of callers, --depth=N)
  trace <name>        Call tree visualization (--depth=N expands all children)
  reverse-trace <name> Upward call chain to entry points (--depth=N, default 5)
  related <name>      Find similar functions (same file, shared deps)
  example <name>      Best usage example with context

═══════════════════════════════════════════════════════════════════════════════
FIND CODE
═══════════════════════════════════════════════════════════════════════════════
  find <name>         Find symbol definitions (supports glob: find "handle*")
  usages <name>       All usages grouped: definitions, calls, imports, references
  toc                 Table of contents (compact; --detailed lists all symbols)
  search <term>       Text search (regex default, --context=N, --exclude=, --in=)
                      Structural: --type=function|class|call --param= --returns= --decorator= --exported --unused
  tests <name>        Find test files for a function
  affected-tests <n>  Tests affected by a change (blast + test detection, --depth=N)

═══════════════════════════════════════════════════════════════════════════════
EXTRACT CODE
═══════════════════════════════════════════════════════════════════════════════
  fn <name>[,n2,...]  Extract function(s) (comma-separated for bulk, --file)
  class <name>        Extract class
  lines <range>       Extract line range (e.g., lines 50-100)
  expand <N>          Show code for item N from context output

═══════════════════════════════════════════════════════════════════════════════
FILE DEPENDENCIES
═══════════════════════════════════════════════════════════════════════════════
  imports <file>      What does file import
  exporters <file>    Who imports this file
  file-exports <file> What does file export
  graph <file>        Full dependency tree (--depth=N, --direction=imports|importers|both)
  circular-deps       Detect circular import chains (--file=, --exclude=)

═══════════════════════════════════════════════════════════════════════════════
REFACTORING HELPERS
═══════════════════════════════════════════════════════════════════════════════
  plan <name>         Preview refactoring (--add-param, --remove-param, --rename-to)
  verify <name>       Check all call sites match signature
  diff-impact         What changed in git diff and who calls it (--base, --staged)
  deadcode            Find unused functions/classes
  entrypoints         Detect framework entry points (routes, DI, tasks)

═══════════════════════════════════════════════════════════════════════════════
OTHER
═══════════════════════════════════════════════════════════════════════════════
  api                 Show exported/public symbols
  typedef <name>      Find type definitions
  stats               Project statistics (--functions for per-function line counts)
  stacktrace <text>   Parse stack trace, show code at each frame (alias: stack)

Common Flags:
  --file <pattern>    Filter by file path (e.g., --file=routes)
  --exclude=a,b       Exclude patterns (e.g., --exclude=test,mock)
  --in=<path>         Only in path (e.g., --in=src/core)
  --depth=N           Trace/graph depth (default: 3, also expands all children)
  --direction=X       Graph direction: imports, importers, or both (default: both)
  --all               Expand truncated sections (about, trace, graph, related)
  --top=N             Limit results (find, deadcode)
  --limit=N           Limit result count (find, usages, search, deadcode, api, toc)
  --max-files=N       Max files to index (large projects)
  --context=N         Lines of context around matches
  --json              Machine-readable output
  --code-only         Filter out comments and strings
  --with-types        Include type definitions
  --include-tests     Include test files
  --class-name=X      Scope to specific class (e.g., --class-name=Repository)
  --include-methods   Include method calls (obj.fn) in caller/callee analysis
  --include-uncertain Include ambiguous/uncertain matches
  --no-confidence     Hide confidence scores (shown by default)
  --min-confidence=N  Filter edges below confidence threshold (0.0-1.0)
  --include-exported  Include exported symbols in deadcode
  --no-regex          Force plain text search (regex is default)
  --functions         Show per-function line counts (stats command)
  --include-decorated Include decorated/annotated symbols in deadcode
  --framework=X       Filter entrypoints by framework (e.g., --framework=express,spring)
  --exact             Exact name match only (find)
  --calls-only        Only show call/test-case matches (tests)
  --case-sensitive    Case-sensitive text search (search)
  --detailed          List all symbols in toc (compact by default)
  --top-level         Show only top-level functions in toc
  --max-lines=N       Max source lines for class (large classes show summary)
  --no-cache          Disable caching
  --clear-cache       Clear cache before running
  --base=<ref>        Git ref for diff-impact (default: HEAD)
  --staged            Analyze staged changes (diff-impact)
  --no-follow-symlinks  Don't follow symbolic links
  -i, --interactive   Keep index in memory for multiple queries
```

---

## Limitations

- Single-project scope - follows imports within the project, not into `node_modules` or `site-packages`
- No runtime execution - static analysis only
- Dynamic dispatch and reflection are only partially visible or invisible
- JS, TS, and Python method calls can be uncertain when receiver type is unknown
- Large repos take a few seconds on the first query, then use cache

If you need compiler diagnostics, taint analysis, or runtime semantics, those are different tools for different jobs. UCN trades that depth for speed, portability, and zero setup.

---

MIT
