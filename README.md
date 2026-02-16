# UCN - Universal Code Navigator

UCN is designed to work with large files and codebases, helping AI agents ingest exactly the data they need. Its surgical output discourages agents from cutting corners, and without UCN, agents working with large codebases tend to skip parts of the code structure, assuming they have "enough data."

---

## Three Ways to Use UCN

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                                                                      │
  │   1. CLI                    Use it directly from the terminal.       │
  │      $ ucn about myFunc     Works standalone, no agent required.     │
  │                                                                      │
  │   2. MCP Server             Any MCP-compatible AI agent connects     │
  │      $ ucn --mcp            and gets 28 tools automatically.         │
  │                                                                      │
  │   3. Agent Skill            Drop-in skill for Claude Code and        │
  │      /ucn about myFunc      OpenAI Codex CLI. No server needed.      │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## The Problem

Typically, AI agents working with code do something like this:

```
  grep "functionName"      →  47 matches, 23 files
       │
       ▼
  read file1.ts            →  2000 lines... wrong function
       │
       ▼
  read file2.ts            →  1500 lines... still not it
       │
       ▼
  read file3.ts            →  found it, finally
       │
       ▼
  grep "whoCallsThis"      →  start over
       │
       ▼
  ┌─────────────────────────────────────────┐
  │  Half the context window is gone.       │
  │  The agent hasn't changed a single line.│
  └─────────────────────────────────────────┘
```

---

## The Solution

UCN parses the code with tree-sitter and offers semantic navigation tools.

Instead of reading entire files, ask precise questions:

```
  ┌──────────────────────────────────────┐
  │                                      │
  │   "Who calls this function?"         │──→  list of actual callers
  │                                      │
  │   "What breaks if I change this?"    │──→  every call site, with arguments
  │                                      │
  │   "Show me this function and         │──→  source + dependencies inline
  │    everything it depends on"         │
  │                                      │
  └──────────────────────────────────────┘
```

---

## How It Works

```
  ┌──────────────────────────────────────────────┐
  │              Any AI Agent                    │
  │  Claude Code · Cursor · Windsurf · Copilot   │
  └───────────────────────┬──────────────────────┘
                          │
                         MCP
                          │
                          ▼
                 ┌───────────────────┐
                 │   UCN MCP Server  │
                 │   28 tools        │
                 │   runs locally    │
                 └────────┬──────────┘
                          │
                    tree-sitter AST
                          │
              ┌───────────┼───────────┐
              │           │           │
          ┌───┴───┐  ┌────┴────┐  ┌───┴──┐
          │ JS/TS │  │ Python  │  │  Go  │
          └───────┘  └─────────┘  └──────┘
              ┌───────────┼───────────┐
          ┌───┴───┐              ┌────┴───┐
          │ Rust  │              │  Java  │
          └───────┘              └────────┘
```

No cloud. No API keys. Parses locally, stays local.

---

## Before & After

```
  WITHOUT UCN                              WITH UCN
  ──────────────────────                   ──────────────────────

  grep "processOrder"                      ucn_impact "processOrder"
       │                                        │
       ▼                                        ▼
  34 matches, mostly noise                 8 call sites, grouped by file,
       │                                   with actual arguments passed
       ▼                                        │
  read service.ts  (800 lines)                  │
       │                                        │
       ▼                                        │
  read handler.ts  (600 lines)             ucn_smart "processOrder"
       │                                        │
       ▼                                        ▼
  read batch.ts    (400 lines)             function + all dependencies
       │                                   expanded inline
       ▼                                        │
  read orders.test (500 lines)                  │
       │                                        ▼
       ▼                                   Done. Full picture.
  grep "import.*processOrder"              Ready to make the change.
       │
       ▼
  read routes.ts   (300 lines)
       │
       ▼
  ... still not sure about full impact


  8+ tool calls                            2 tool calls
  Reads thousands of lines                 Reads zero full files
  Context spent on file contents           Context spent on reasoning
```

After editing code:

```
  WITHOUT UCN                              WITH UCN
  ──────────────────────                   ──────────────────────

  git diff                                 ucn_diff_impact
       │                                        │
       ▼                                        ▼
  see changed lines, but which             13 modified functions
  functions do they belong to?             8 new functions
       │                                   22 call sites across 9 files
       ▼                                        │
  read each file to map hunks                   ▼
  to function boundaries                   Each function shown with:
       │                                     • which lines changed
       ▼                                     • every downstream caller
  ucn_impact on each function                • caller context
  you identified (repeat 5-10x)                 │
       │                                        ▼
       ▼                                   Done. Full blast radius.
  hope you didn't miss one                 One command.


  10+ tool calls                            1 tool call
```

---

## grep vs AST

```
  Code: processOrder(items, user)


  ┌─────────────────────────────────────────────────────────────────┐
  │  grep "processOrder"                                            │
  │                                                                 │
  │    ✓  processOrder(items, user)          ← the actual call      │
  │    ✗  // TODO: refactor processOrder     ← comment, not a call  │
  │    ✗  const processOrder = "label"       ← string, not a call   │
  │    ✗  order.processOrder()               ← different class      │
  │    ✗  import { processOrder }            ← import, not a call   │
  │                                                                 │
  │  5 results. 1 is what you wanted.                               │
  └─────────────────────────────────────────────────────────────────┘


  ┌─────────────────────────────────────────────────────────────────┐
  │  ucn_context "processOrder"                                     │
  │                                                                 │
  │    Callers:                                                     │
  │      handleCheckout    src/api/checkout.ts:45                   │
  │      batchProcess      src/workers/batch.ts:12                  │
  │      runDailyOrders    src/jobs/daily.ts:88                     │
  │                                                                 │
  │    Callees:                                                     │
  │      validateItems     src/orders/validate.ts:20                │
  │      calculateTotal    src/orders/pricing.ts:55                 │
  │      saveOrder         src/db/orders.ts:30                      │
  │                                                                 │
  │  3 callers, 3 callees. Verified from the AST.                   │
  └─────────────────────────────────────────────────────────────────┘
```

The tradeoff: grep works on any language and any text. UCN only works on supported languages but gives structural understanding within those.

---

## See It in Action

Extract a function from a large file without reading it:

```
$ ucn fn expandGlob

core/discovery.js:135
[ 135- 166] expandGlob(pattern, options = {})
────────────────────────────────────────────────────────────
function expandGlob(pattern, options = {}) {
    const root = path.resolve(options.root || process.cwd());
    const ignores = options.ignores || DEFAULT_IGNORES;
    ...
    return files.sort(compareNames);
}
```

See who calls it and what it calls:

```
$ ucn context expandGlob

Context for expandGlob:
════════════════════════════════════════════════════════════

CALLERS (7):
  [1] cli/index.js:1847 [runGlobCommand]
    const files = expandGlob(pattern);
  [2] core/project.js:81
    const files = expandGlob(pattern, {
  [3] core/project.js:3434
    const currentFiles = expandGlob(pattern, { root: this.root });
  ...

CALLEES (2):
  [8] parseGlobPattern [utility] - core/discovery.js:171
  [9] walkDir [utility] - core/discovery.js:227
```

See what breaks if you change it:

```
$ ucn impact shouldIgnore

Impact analysis for shouldIgnore
════════════════════════════════════════════════════════════
core/discovery.js:289
shouldIgnore (name, ignores, parentDir)

CALL SITES: 2
  Files affected: 1

BY FILE:

core/discovery.js (2 calls)
  :255 [walkDir]
    if (shouldIgnore(entry.name, options.ignores, dir)) continue;
    args: entry.name, options.ignores, dir
  :373 [detectProjectPattern]
    !shouldIgnore(entry.name, DEFAULT_IGNORES)) {
    args: entry.name, DEFAULT_IGNORES
```

Get a function with all its dependencies inline:

```
$ ucn smart shouldIgnore

shouldIgnore (core/discovery.js:289)
════════════════════════════════════════════════════════════
function shouldIgnore(name, ignores, parentDir) {
    for (const pattern of ignores) {
        if (pattern.includes('*')) {
            const regex = globToRegex(pattern);
            ...
        }
    }
    ...
}

─── DEPENDENCIES ───

// globToRegex [utility] (core/discovery.js:208)
function globToRegex(glob) {
    let regex = glob.replace(/[.+^$[\]\\]/g, '\\$&');
    ...
    return new RegExp('^' + regex + '$');
}
```

Trace the call tree:

```
$ ucn trace expandGlob --depth=2

Call tree for expandGlob
════════════════════════════════════════════════════════════

expandGlob
├── parseGlobPattern (core/discovery.js:171) [utility] 1x
│   └── globToRegex (core/discovery.js:208) [utility] 1x
└── walkDir (core/discovery.js:227) [utility] 1x
    └── shouldIgnore (core/discovery.js:289) [utility] 1x
```

See the impact of your recent edits:

```
$ ucn diff-impact --base=HEAD~1

Diff Impact Analysis (vs HEAD~1)
════════════════════════════════════════════════════════════
3 modified, 1 new, 12 call sites across 4 files

MODIFIED FUNCTIONS:

  processOrder
  src/orders/service.ts:45
  processOrder (items: Item[], user: User): Promise<Order>
  Lines added: 48-52
  Lines deleted: 49
  Callers (3):
    src/api/checkout.ts:89 [handleCheckout]
      await processOrder(cart.items, req.user)
    src/workers/batch.ts:12 [batchProcess]
      processOrder(order.items, systemUser)
    src/jobs/daily.ts:88 [runDailyOrders]
      results.push(await processOrder(items, admin))

  validateItems
  src/orders/validate.ts:20
  validateItems (items: Item[]): ValidationResult
  Lines added: 25-30
  Callers (2):
    src/orders/service.ts:46 [processOrder]
      const valid = validateItems(items)
    src/api/admin.ts:55 [bulkValidate]
      return items.map(i => validateItems([i]))

NEW FUNCTIONS:
  calculateShipping — src/orders/shipping.ts:10
  calculateShipping (items: Item[], region: Region): number

MODULE-LEVEL CHANGES:
  src/orders/service.ts: +5 lines, -1 lines
```

Scoped to staged changes or a specific file:

```
$ ucn diff-impact --staged                 # Only what's staged for commit
$ ucn diff-impact --base=main              # Everything since branching from main
$ ucn diff-impact --file=src/orders        # Only changes in this path
```

Find unused code:

```
$ ucn deadcode

Dead code: 15 unused symbol(s)

cli/index.js
  [1649-1654] extractFunctionNameFromContent (function)
core/project.js
  [1664-1694] findReExportsOf (method)
  [1998-2020] withCompleteness (method)
...
```

---

## Install

```bash
npm install -g ucn
```

### As an MCP Server

One-line setup for supported clients:

```bash
# Claude Code
claude mcp add ucn -- npx -y ucn --mcp

# OpenAI Codex CLI
codex mcp add ucn -- npx -y ucn --mcp

# VS Code Copilot
code --add-mcp '{"name":"ucn","command":"npx","args":["-y","ucn","--mcp"]}'
```

Or add to your client's MCP config file manually:

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

<details>
<summary>VS Code Copilot uses a slightly different format (.vscode/mcp.json)</summary>

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

### As a Claude Code / Codex Skill

When MCP server is not needed, drop it in as a native skill:

```bash
# Claude Code
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.agents/skills
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/
```

### As a CLI Tool

Works standalone from the terminal — no agent required:

```bash
ucn toc                             # Project overview
ucn about handleRequest             # Understand a function
ucn impact handleRequest            # Before modifying
ucn fn handleRequest --file api     # Extract specific function
ucn --interactive                   # Multiple queries, index stays in memory
```

---

## Workflows

Investigating a bug:
```bash
ucn about problematic_function            # Understand it fully
ucn trace problematic_function --depth=2  # See what it calls
```

Before modifying a function:
```bash
ucn impact the_function                   # Who will break?
ucn smart the_function                    # See it + its helpers
# ... make your changes ...
ucn verify the_function                   # Did all call sites survive?
```

Before committing:
```bash
ucn diff-impact                           # What did I change + who calls it?
ucn diff-impact --base=main               # Full branch impact vs main
ucn diff-impact --staged                  # Only staged changes
```

Periodic cleanup:
```bash
ucn deadcode --exclude=test               # What can be deleted?
ucn toc                                   # Project overview
```

---

## Limitations (and how we handle them)

```
  ┌──────────────────────────┬──────────────────────────────────────────┐
  │  Limitation              │  What happens                            │
  ├──────────────────────────┼──────────────────────────────────────────┤
  │                          │                                          │
  │  5 languages only        │  JS/TS, Python, Go, Rust, Java.          │
  │  (no C, Ruby, PHP, etc.) │  Agents fall back to grep for the rest.  │
  │                          │  UCN complements, doesn't replace.       │
  │                          │                                          │
  ├──────────────────────────┼──────────────────────────────────────────┤
  │                          │                                          │
  │  Dynamic dispatch        │  getattr(), reflection, eval() — UCN     │
  │                          │  does static analysis and can't follow   │
  │                          │  calls that only exist at runtime.       │
  │                          │                                          │
  ├──────────────────────────┼──────────────────────────────────────────┤
  │                          │                                          │
  │  Duck-typed methods      │  obj.method() in JS/TS/Python — when     │
  │                          │  the receiver type is ambiguous, results │
  │                          │  are marked "uncertain" so the agent     │
  │                          │  knows to verify. Go/Rust/Java resolve   │
  │                          │  with high confidence.                   │
  │                          │                                          │
  ├──────────────────────────┼──────────────────────────────────────────┤
  │                          │                                          │
  │  Single project scope    │  UCN follows imports within the project  │
  │                          │  but stops at the boundary — no tracing  │
  │                          │  into node_modules or site-packages.     │
  │                          │                                          │
  ├──────────────────────────┼──────────────────────────────────────────┤
  │                          │                                          │
  │  First-query index time  │  Tree-sitter index is built on first     │
  │                          │  query. A few seconds on large projects. │
  │                          │  Cached and incrementally updated —      │
  │                          │  only changed files are re-indexed.      │
  │                          │                                          │
  └──────────────────────────┴──────────────────────────────────────────┘
```

---

## All 28 Tools

```
  UNDERSTAND                          MODIFY SAFELY
  ─────────────────────               ─────────────────────
  ucn_about     everything in one     ucn_impact      all call sites
                call: definition,                     with arguments
                callers, callees,
                tests, source         ucn_diff_impact what changed in a
                                                      git diff + who
  ucn_context   callers + callees                     calls it
                (quick overview)
                                      ucn_verify      check all sites
  ucn_smart     function + helpers                    match signature
                expanded inline
                                      ucn_plan        preview a refactor
  ucn_trace     call tree — map                       before doing it
                a whole pipeline


  FIND & NAVIGATE                     ARCHITECTURE
  ─────────────────────               ─────────────────────
  ucn_find      locate definitions    ucn_imports     file dependencies
  ucn_usages    all occurrences       ucn_exporters   who depends on it
  ucn_fn        extract a function    ucn_graph       dependency tree
  ucn_class     extract a class       ucn_related     sibling functions
  ucn_toc       project overview      ucn_tests       find tests
  ucn_deadcode  unused functions      ucn_stacktrace  error trace context
  ucn_search    text search           ucn_api         public API surface
  ucn_example   best usage example    ucn_typedef     type definitions
  ucn_lines     extract line range    ucn_file_exports file's exports
  ucn_expand    drill into context    ucn_stats       project size stats
```

---

## License

MIT

UCN - Universal Code Navigator
