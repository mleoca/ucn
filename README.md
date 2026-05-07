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

Find missing-await bugs:

```
ucn audit-async
```

Lists async calls inside async functions that lack `await` (JS/TS/Python).

## Map your API surface across languages

UCN can match server routes to client requests across the supported languages — Express/Fastify/Koa/NestJS/Next.js, Flask/FastAPI, Spring/JAX-RS, Go net/http (Gin/Echo/Chi/Fiber), axum/actix-web on the server side; fetch/axios, requests/httpx, RestTemplate/WebClient, reqwest on the client side.

```bash
ucn endpoints --bridge

# Filters
ucn endpoints --bridge --unmatched          # routes with no client / clients with no server
ucn endpoints --bridge --method=POST
ucn endpoints --bridge --prefix=/api
```

Match confidence: `EXACT` (literal-literal), `PARTIAL` (server param ↔ client literal), `UNCERTAIN` (template-literal client). Use `--hide-uncertain` to drop the noisy tier.

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

Run `ucn --help` for the full command list and flags.

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
