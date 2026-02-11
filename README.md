# UCN - Universal Code Navigator

AI agents working with large codebases often read entire files just to understand a single function. UCN uses tree-sitter ASTs to extract exactly what you need — functions, callers, callees, dependencies — without wasting context.

## Examples

**Extract a function** from a large file without reading it:
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

**See who calls a function and what it calls:**
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

**See what breaks if you change a function:**
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

**Get a function with all its dependencies inline:**
```
$ ucn smart shouldIgnore
shouldIgnore (/Users/mihail/ucn/core/discovery.js:289)
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

**Trace the call tree:**
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

**Find unused code:**
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

**See a file's dependencies:**
```
$ ucn imports core/project.js
Imports in core/project.js:

INTERNAL:
  ./discovery
    -> core/discovery.js
    expandGlob, findProjectRoot, detectProjectPattern, isTestFile
  ./imports
    -> core/imports.js
    extractImports, extractExports, resolveImport
  ./parser
    -> core/parser.js
    parseFile
  ../languages
    -> languages/index.js
    detectLanguage, getParser, getLanguageModule, PARSE_OPTIONS, safeParse

EXTERNAL:
  fs, path, crypto
```

## Workflows

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

**Periodic cleanup:**
```bash
ucn deadcode --exclude=test             # What can be deleted?
ucn toc                                 # Project overview
```
## Supported Languages

JavaScript, TypeScript, Python, Go, Rust, Java

## Install

```bash
npm install -g ucn
```

### MCP Server

UCN includes a built-in [MCP](https://modelcontextprotocol.io) server, so any MCP-compatible AI client can use it as a tool.

**Claude Code** (`~/.claude/mcp-config.json`):
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

**Claude Desktop** (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
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

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in project):
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

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
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

**VS Code Copilot** (`.vscode/mcp.json`):
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

**Zed** (Settings > `settings.json`):
```json
{
  "context_servers": {
    "ucn": {
      "command": "npx",
      "args": ["-y", "ucn", "--mcp"]
    }
  }
}
```

The MCP server exposes 27 tools: `ucn_about`, `ucn_context`, `ucn_impact`, `ucn_smart`, `ucn_trace`, `ucn_find`, `ucn_usages`, `ucn_toc`, `ucn_deadcode`, `ucn_fn`, `ucn_class`, `ucn_verify`, `ucn_imports`, `ucn_exporters`, `ucn_tests`, `ucn_related`, `ucn_graph`, `ucn_file_exports`, `ucn_search`, `ucn_plan`, `ucn_typedef`, `ucn_stacktrace`, `ucn_example`, `ucn_expand`, `ucn_lines`, `ucn_api`, `ucn_stats`.

### Claude Code Skill (alternative)

To use UCN as a skill in Claude Code (alternative to MCP):

```bash
mkdir -p ~/.claude/skills

# If installed via npm:
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.claude/skills/

# If cloned from git:
git clone https://github.com/mleoca/ucn.git
cp -r ucn/.claude/skills/ucn ~/.claude/skills/
```

### Codex (optional)

To use UCN as a skill in OpenAI Codex:

```bash
mkdir -p ~/.agents/skills

# If installed via npm:
cp -r "$(npm root -g)/ucn/.claude/skills/ucn" ~/.agents/skills/

# If cloned from git:
git clone https://github.com/mleoca/ucn.git
cp -r ucn/.claude/skills/ucn ~/.agents/skills/
```

## Usage

```
UCN - Universal Code Navigator

Supported: JavaScript, TypeScript, Python, Go, Rust, Java

Usage:
  ucn [command] [args]            Project mode (current directory)
  ucn <file> [command] [args]     Single file mode
  ucn <dir> [command] [args]      Project mode (specific directory)
  ucn "pattern" [command] [args]  Glob pattern mode

═══════════════════════════════════════════════════════════════════════════════
UNDERSTAND CODE (UCN's strength - semantic analysis)
═══════════════════════════════════════════════════════════════════════════════
  about <name>        RECOMMENDED: Full picture (definition, callers, callees, tests, code)
  context <name>      Who calls this + what it calls (numbered for expand)
  smart <name>        Function + all dependencies inline
  impact <name>       What breaks if changed (call sites grouped by file)
  trace <name>        Call tree visualization (--depth=N)

═══════════════════════════════════════════════════════════════════════════════
FIND CODE
═══════════════════════════════════════════════════════════════════════════════
  find <name>         Find symbol definitions (top 5 by usage count)
  usages <name>       All usages grouped: definitions, calls, imports, references
  toc                 Table of contents (compact; --detailed lists all symbols)
  search <term>       Text search (for simple patterns, consider grep instead)
  tests <name>        Find test files for a function

═══════════════════════════════════════════════════════════════════════════════
EXTRACT CODE
═══════════════════════════════════════════════════════════════════════════════
  fn <name>           Extract function (--file to disambiguate)
  class <name>        Extract class
  lines <range>       Extract line range (e.g., lines 50-100)
  expand <N>          Show code for item N from context output

═══════════════════════════════════════════════════════════════════════════════
FILE DEPENDENCIES
═══════════════════════════════════════════════════════════════════════════════
  imports <file>      What does file import
  exporters <file>    Who imports this file
  file-exports <file> What does file export
  graph <file>        Full dependency tree (--depth=N)

═══════════════════════════════════════════════════════════════════════════════
REFACTORING HELPERS
═══════════════════════════════════════════════════════════════════════════════
  plan <name>         Preview refactoring (--add-param, --remove-param, --rename-to)
  verify <name>       Check all call sites match signature
  deadcode            Find unused functions/classes
  related <name>      Find similar functions (same file, shared deps)

═══════════════════════════════════════════════════════════════════════════════
OTHER
═══════════════════════════════════════════════════════════════════════════════
  api                 Show exported/public symbols
  typedef <name>      Find type definitions
  stats               Project statistics
  stacktrace <text>   Parse stack trace, show code at each frame (alias: stack)
  example <name>      Best usage example with context

Common Flags:
  --file <pattern>    Filter by file path (e.g., --file=routes)
  --exclude=a,b       Exclude patterns (e.g., --exclude=test,mock)
  --in=<path>         Only in path (e.g., --in=src/core)
  --depth=N           Trace/graph depth (default: 3)
  --context=N         Lines of context around matches
  --json              Machine-readable output
  --code-only         Filter out comments and strings
  --with-types        Include type definitions
  --top=N / --all     Limit or show all results
  --include-tests     Include test files
  --include-methods   Include method calls (obj.fn) in caller/callee analysis
  --include-uncertain Include ambiguous/uncertain call matches
  --include-exported  Include exported symbols in deadcode
  --detailed          List all symbols in toc (compact counts by default)
  --no-cache          Disable caching
  --clear-cache       Clear cache before running
  --no-follow-symlinks  Don't follow symbolic links
  -i, --interactive   Keep index in memory for multiple queries
  --mcp               Start as MCP server (stdio transport)

Quick Start:
  ucn toc                             # See project structure (compact)
  ucn toc --detailed                  # List all functions/classes
  ucn about handleRequest             # Understand a function
  ucn impact handleRequest            # Before modifying
  ucn fn handleRequest --file api     # Extract specific function
  ucn --interactive                   # Multiple queries
```

## License

MIT
