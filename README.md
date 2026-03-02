# UCN — Universal Code Navigator

AST-powered code intelligence from the terminal.

UCN answers structural code questions instantly:
- Who calls this function?
- What breaks if I change this signature?
- What changed in this diff, and who depends on it?
- What code is safe to delete?

Instead of reading full files, UCN gives precise, AST-verified answers.

[![npm](https://img.shields.io/npm/v/ucn)](https://www.npmjs.com/package/ucn)
[![license](https://img.shields.io/npm/l/ucn)](LICENSE)

---

## 60-Second Quickstart

```bash
npm install -g ucn

ucn about handleRequest       # full picture: definition, callers, callees, tests
ucn impact handleRequest      # all call sites with arguments
ucn trace main --depth=3      # call tree, no file reads
ucn deadcode                  # unused functions, AST-verified
```

Parses JS/TS, Python, Go, Rust, Java, and HTML with tree-sitter. Runs locally.

```
  Terminal              AI Agents              Agent Skills
       │                    │                       │
      CLI                  MCP                    Skill
       └────────────────────┼───────────────────────┘
                            │
                     ┌──────┴──────┐
                     │ UCN Engine  │
                     │ 28 commands │
                     │ tree-sitter │
                     └─────────────┘
```

---

## Why UCN

UCN uses tree-sitter to parse code into an AST, then builds a call graph and symbol table on top of it. Instead of matching text, it understands which functions call which, what depends on what, and what's unused. Everything runs locally.

"What happens when `build()` runs?"

```
$ ucn trace build --depth=2

build
├── detectProjectPattern (discovery.js:392) 1x
│   ├── checkDir (discovery.js:396) 2x
│   └── shouldIgnore (discovery.js:340) 1x
├── parseGitignore (discovery.js:123) 1x
├── expandGlob (discovery.js:183) 1x
│   ├── parseGlobPattern (discovery.js:219) 1x
│   ├── walkDir (discovery.js:276) 1x
│   └── compareNames (discovery.js:162) 1x
├── indexFile (project.js:236) 1x
│   ├── addSymbol (project.js:293) 4x
│   ├── detectLanguage (languages/index.js:157) 1x
│   ├── parseFile (parser.js:93) 1x
│   └── extractImports (imports.js:19) 1x
├── buildImportGraph (project.js:419) 1x
└── buildInheritanceGraph (project.js:465) 1x
```

One command. No files opened. The full execution flow with every function located by file and line.

---

## What it does

| Task | Command | Output |
|------|---------|--------|
| Understand one symbol deeply | `ucn about expandGlob` | Definition, callers, callees, tests |
| Who calls this and what do they pass? | `ucn impact shouldIgnore` | Call sites with argument context |
| Map an execution path | `ucn trace expandGlob --depth=2` | Call tree |
| Extract just one function | `ucn fn expandGlob` | Surgical snippet, no file read |
| Check all call sites match signature | `ucn verify expandGlob` | Mismatch/uncertain call sites |
| Review branch impact | `ucn diff-impact --base=main` | Changed functions + downstream callers |
| Find deletable code | `ucn deadcode` | Unused symbols, AST-verified |
| Get function + helpers inline | `ucn smart shouldIgnore` | Source with dependencies expanded |

---

## Setup

### CLI

Already installed above. A few more examples:

```bash
ucn fn handleRequest --file api     # extract function from specific file
ucn toc                             # project overview
ucn --interactive                   # REPL mode, index stays in memory
```

### MCP Server (for AI agents)

One-line setup:

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

All 28 commands ship as a single MCP tool, under 2KB of schema in the agent's context.

### Agent Skill (no server needed)

Drop-in for Claude Code or Codex CLI:

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

---

## Examples

**Extract a function** without reading the file:

```
$ ucn fn expandGlob

core/discovery.js:183
[ 183- 214] expandGlob(pattern, options = {})
────────────────────────────────────────────────────────────
function expandGlob(pattern, options = {}) {
    const root = path.resolve(options.root || process.cwd());
    const ignores = options.ignores || DEFAULT_IGNORES;
    ...
    return files.sort(compareNames);
}
```

**See callers and callees:**

```
$ ucn context expandGlob

CALLERS (7):
  [1] cli/index.js:785 [runGlobCommand]
    const files = expandGlob(pattern);
  [2] core/cache.js:149 [isCacheStale]
    const currentFiles = expandGlob(pattern, globOpts);
  [3] core/project.js:171 [build]
    const files = expandGlob(pattern, globOpts);
  ...

CALLEES (3):
  [8] parseGlobPattern [utility] - core/discovery.js:219
  [9] walkDir [utility] - core/discovery.js:276
  [10] compareNames [utility] - core/discovery.js:162
```

**See impact of recent edits:**

```
$ ucn diff-impact --base=HEAD~1

3 modified, 1 new, 12 call sites across 4 files

MODIFIED FUNCTIONS:

  processOrder
  src/orders/service.ts:45
  Lines added: 48-52, Lines deleted: 49
  Callers (3):
    src/api/checkout.ts:89 [handleCheckout]
      await processOrder(cart.items, req.user)
    src/workers/batch.ts:12 [batchProcess]
      processOrder(order.items, systemUser)
    src/jobs/daily.ts:88 [runDailyOrders]
      results.push(await processOrder(items, admin))
```

**Trace a call tree:**

```
$ ucn trace expandGlob --depth=2

expandGlob
├── parseGlobPattern (core/discovery.js:219) [utility] 1x
│   └── globToRegex (core/discovery.js:256) [utility] 1x
├── walkDir (core/discovery.js:276) [utility] 1x
│   ├── compareNames (core/discovery.js:162) [utility] 1x
│   ├── shouldIgnore (core/discovery.js:340) [utility] 1x
│   └── walkDir (core/discovery.js:276) [utility] 1x (see above)
└── compareNames (core/discovery.js:162) [utility] 1x (see above)
```

**Find unused code:**

```
$ ucn deadcode --exclude=test

Dead code: 1 unused symbol(s)

core/discovery.js
  [ 162- 166] legacyResolve (function)
```

---

## Workflows

```bash
# Investigating a bug
ucn about buggyFunction                    # understand it fully
ucn trace buggyFunction --depth=2          # see what it calls

# Before modifying code
ucn impact theFunction                     # who will break?
ucn smart theFunction                      # function + its helpers inline
# ... make changes ...
ucn verify theFunction                     # do all call sites still match?

# Before committing
ucn diff-impact --staged                   # what I changed + who calls it

# Cleanup
ucn deadcode --exclude=test                # what can be deleted?
```

---

## All 28 commands

```
  UNDERSTAND                          MODIFY SAFELY
  ─────────────────────               ─────────────────────
  about         full picture          impact          all call sites
  context       callers + callees     diff-impact     git diff + callers
  smart         function + helpers    verify          signature check
  trace         call tree             plan            refactor preview

  FIND & EXTRACT                      ARCHITECTURE
  ─────────────────────               ─────────────────────
  find          locate definitions    imports         file dependencies
  usages        all occurrences       exporters       reverse dependencies
  fn            extract function      graph           dependency tree
  class         extract class         related         sibling functions
  toc           project overview      tests           find test coverage
  deadcode      unused code           stacktrace      error trace context
  search        text search           api             public API surface
  example       best usage example    typedef         type definitions
  lines         extract line range    file-exports    file's exports
  expand        drill into context    stats           project stats
```

---

## Limitations

UCN is static AST analysis, not runtime instrumentation.

- **5 languages + HTML** — JS/TS, Python, Go, Rust, Java. Falls back to text search for others.
- **Static analysis only** — Can't follow `eval()`, `getattr()`, reflection, or other dynamic dispatch.
- **Duck-typed methods** — `obj.method()` in JS/TS/Python is marked "uncertain" when the receiver type is ambiguous. Go/Rust/Java resolve with high confidence.
- **Single project scope** — Follows imports within the project but not into `node_modules` or `site-packages`.
- **First-query index time** — A few seconds on large projects. Cached incrementally after that.

---

## License

MIT
