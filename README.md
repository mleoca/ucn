# UCN - Universal Code Navigator

When working with large codebases or even vibe coding all into a single large file, AI agents often need to read entire files just to understand a single function. This eats up the context rather fast, so the intent is to keep the agents perform better with their context clean than rather cluttered.

## Example

You have a 2000-line file and need to understand `handleRequest`:

```bash
$ ucn fn handleRequest
src/api/routes.js:145
[145-162] handleRequest(req, res)
────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const validated = validateInput(req.body);
  const result = processData(validated);
  return sendResponse(res, result);
}

$ ucn context handleRequest
CALLERS (3):
  src/server.js:45 [startServer]
  src/middleware.js:23 [authMiddleware]
  test/api.test.js:67 [testHandler]

CALLEES (3):
  validateInput - src/utils/validation.js:12
  processData - src/services/data.js:89
  sendResponse - src/utils/response.js:34
```

18 lines of context instead of 2000.

## Supported Languages
The supported languages can grow as tree-sitter supports many, but for my use cases I've added support for:  

JavaScript, TypeScript, Python, Go, Rust, Java

## Install

Not published to npm yet. Install from source:

```bash
git clone https://github.com/mleoca/ucn.git
cd ucn
npm install
npm link  # makes 'ucn' available globally
```

### Claude Code (optional)

To use UCN as a skill in Claude Code:

```bash
cp -r ucn/.claude/skills/ucn ~/.claude/skills/
```

### Codex (optional)

To use UCN as a skill in OpenAI Codex:

```bash
cp -r ucn/.claude/skills/ucn ~/.agents/skills/
```

## Usage

```
Usage:
  ucn [command] [args]            Project mode (current directory)
  ucn <file> [command] [args]     Single file mode
  ucn <dir> [command] [args]      Project mode (specific directory)
  ucn "pattern" [command] [args]  Glob pattern mode

UNDERSTAND CODE
  about <name>        Full picture (definition, callers, callees, tests, code)
  context <name>      Who calls this + what it calls
  smart <name>        Function + all dependencies inline
  impact <name>       What breaks if changed (call sites grouped by file)
  trace <name>        Call tree visualization (--depth=N)

FIND CODE
  find <name>         Find symbol definitions (top 5 by usage count)
  usages <name>       All usages grouped: definitions, calls, imports, references
  toc                 Table of contents (functions, classes, state)
  search <term>       Text search
  tests <name>        Find test files for a function

EXTRACT CODE
  fn <name>           Extract function (--file to disambiguate)
  class <name>        Extract class
  lines <range>       Extract line range (e.g., lines 50-100)
  expand <N>          Show code for item N from context output

FILE DEPENDENCIES
  imports <file>      What does file import
  exporters <file>    Who imports this file
  file-exports <file> What does file export
  graph <file>        Full dependency tree (--depth=N)

REFACTORING HELPERS
  plan <name>         Preview refactoring (--add-param, --remove-param, --rename-to)
  verify <name>       Check all call sites match signature
  deadcode            Find unused functions/classes
  related <name>      Find similar functions (same file, shared deps)

OTHER
  api                 Show exported/public symbols
  typedef <name>      Find type definitions
  stats               Project statistics
  stacktrace <text>   Parse stack trace, show code at each frame
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
  --no-cache          Disable caching
  --clear-cache       Clear cache before running
  -i, --interactive   Keep index in memory for multiple queries
```

## License

MIT
