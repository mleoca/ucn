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
├── detectProjectPattern (core/discovery.js:431) 1x
├── parseGitignore (core/discovery.js:131) 1x
├── expandGlob (core/discovery.js:191) 1x
│   ├── parseGlobPattern (core/discovery.js:227) 1x
│   ├── walkDir (core/discovery.js:284) 1x
│   └── compareNames (core/discovery.js:170) 1x
├── parallelBuild (core/parallel-build.js:25) 1x
├── indexFile (core/project.js:310) 1x
│   ├── addSymbol (core/project.js:398) 4x
│   ├── detectLanguage (languages/index.js:209) 1x
│   ├── parse (core/parser.js:69) 1x
│   ├── extractImports (core/imports.js:19) 1x
│   └── extractExports (core/imports.js:44) 1x
├── buildImportGraph (core/project.js:631) 1x
└── buildInheritanceGraph (core/project.js:636) 1x
```

One command. No files opened. Every function located by file and line.

---

## Understand code you didn't write

`ucn about` gives you everything about a function in one shot - who calls it, what it calls, which tests cover it, and the source code.

```
$ ucn about expandGlob

expandGlob (function)
════════════════════════════════════════════════════════════
core/discovery.js:191-222  →  core/discovery.js:191:expandGlob
expandGlob (pattern: string, options: number = {}) : string[]

CALLERS (7):
  confidence: 0 high (>0.8), 7 medium (0.5-0.8), 0 low (<0.5)
  cli/index.js:1190 [runGlobCommand]
    const files = expandGlob(pattern);
    confidence: 0.65 (scope-match)
  core/cache.js:417 [isCacheStale]
    const currentFiles = expandGlob(pattern, globOpts);
    confidence: 0.65 (scope-match)
  ... (5 more)

CALLEES (3):
  parseGlobPattern [utility] - core/discovery.js:227
  walkDir [utility] {fs} - core/discovery.js:284
  compareNames [utility] - core/discovery.js:170

TESTS: 5 matches in 1 file(s)
```

Each caller comes with a confidence score (`exact-binding`, `same-class`, `receiver-hint`, `scope-match`, `name-only`) so you can tell direct calls from name-only matches. Add `--hide-confidence` to silence the scores, or `--min-confidence=0.7` to drop everything below `same-class`. Add `--git` to see who last touched the function. Need to trace execution upward instead? `ucn reverse-trace fn` walks the caller chain back to entry points.

## Change code without breaking things

Before touching a function, check if all existing call sites match its signature:

```
$ ucn verify expandGlob

Verification: expandGlob
════════════════════════════════════════════════════════════
core/discovery.js:191
expandGlob (pattern: string, options: number = {}) : string[]

Expected arguments: 1-2

STATUS: ✓ All calls valid
  Total calls: 7
  Valid: 7
  Mismatches: 0
  Uncertain: 0
  Patterns: 4 in try, 4 in callback
```

The `Patterns:` line surfaces structural classification of each call site — `inLoop`, `inTry`, `inCallback`, `inTestCase`, `awaited` — so you can spot risky call sites (e.g., calls inside loops, missing `await`) at a glance. Same line appears on `impact` and inside `about`.

Then preview the refactoring. UCN shows exactly what needs to change and where:

```
$ ucn plan expandGlob --rename-to=expandGlobPattern

Refactoring plan: rename
════════════════════════════════════════════════════════════
core/discovery.js:191

SIGNATURE CHANGE:
  Before: expandGlob (pattern: string, options: number = {}) : string[]
  After:  expandGlobPattern (pattern: string, options: number = {}) : string[]

CHANGES NEEDED: 11
  Files affected: 4

BY FILE:

cli/index.js (2 changes)
  :1190
    const files = expandGlob(pattern);
    → Rename to: const files = expandGlobPattern(pattern);
  :15
    const { expandGlob, findProjectRoot } = require('../core/discovery');
    → Update import: const { expandGlobPattern, findProjectRoot } = require('../core/discovery');

... (more changes in core/cache.js, core/project.js, test/integration.test.js)
```

Run `ucn diff-impact --staged` before committing to see what you changed and who calls it.

Or wrap the same checks in a single command:

```
$ ucn check --staged

Pre-commit Check vs HEAD
════════════════════════════════════════════════════════════
Changed: 3 functions
  parseFlags (cli/index.js:165) [MODIFIED]  2 callers
  ...
```

`ucn check` composes `diff-impact` + `verify` + `affected-tests` in one shot — flags ADDED functions with no callers, signature drift across call sites, and recommends which tests to run.

## Get the lay of the land in a new repo

```
$ ucn brief fetch_user
fetch_user(user_id: int): dict
  svc.py:4-8  (5 lines)
  "Fetch a user from the API."
  async: no  |  side_effects: [fs, network, process]  |  complexity: branches=2, depth=2
```

`brief` is the lighter alternative to `about` — typed signature, first sentence of the docstring, side-effect classification, and complexity, all in one screen. Pair with `--git` to see who last touched it and how often.

```
$ ucn doctor

UCN Trust Report — /path/to/project
Index: 144 files, 1569 symbols
Languages: javascript (74%), typescript (13%), java (4%), python (3%), rust (3%), go (3%)
Cache: fresh, 221ms build
...
Trust level: HIGH
```

`doctor` reports how much UCN trusts the index — file/symbol counts, blind spots (dynamic imports, eval, reflection), parse failures, and a verdict. Use `--deep` to also sample resolution coverage.

`entrypoints` lists detected framework handlers (HTTP routes, DI beans, jobs, tests):

```
ucn entrypoints --type=http --framework=spring   # narrow to one framework
ucn entrypoints --exclude-tests                  # tests are included by default
```

## Find what to clean up

Which tests should you run after a change? `affected-tests` walks the blast radius and finds every test that touches the affected functions:

```
$ ucn affected-tests expandGlob

affected-tests: expandGlob
════════════════════════════════════════════════════════════
core/discovery.js:191
1 function changed → 15 functions affected (depth 3)

Test files to run (19):

  test/integration.test.js (covers: expandGlob, build, idx, setupProject)
    L47: index.build(null, { quiet: true });  [call]
    L167: const files = expandGlob('**/*.go', { root: tmpDir });  [call]
    ...

Uncovered (10): runGlobCommand, main, runProjectCommand, ...
  ⚠ These affected functions have no test references

Summary: 15 affected → 19 test files, 5/15 functions covered (33%)
```

## Find unused code

```
$ ucn deadcode --exclude=test

Dead code: 3 unused symbol(s)

core/bridge.js
  [  90-  92] endsWithWildcard (function)
  [ 258- 265] parsePythonDecorator (function)
core/search.js
  [1409-1445] _testBodyReferencesClass (function)

325 exported symbol(s) excluded (all have callers). Use --include-exported to audit them.
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

core/discovery.js:170
[ 170- 178] compareNames(a, b)
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
