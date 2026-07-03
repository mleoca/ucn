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

And it's built to be **trusted**: every "who calls this?" splits into what UCN can prove and what it can't — each flagged with a reason, nothing silently dropped, [measured in CI against real compilers and language servers](#answers-you-can-trust).

---

```bash
npm install -g ucn             # Node.js 20+

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
│   ├── addSymbol (core/project.js:410) 4x
│   ├── detectLanguage (languages/index.js:288) 1x
│   ├── parse (core/parser.js:69) 1x
│   ├── extractImports (core/imports.js:19) 1x
│   └── extractExports (core/imports.js:44) 1x
├── buildImportGraph (core/project.js:648) 1x
└── buildInheritanceGraph (core/project.js:653) 1x
    … calls UCN can't prove a receiver for (arr.push(), obj.get()) show as
      [unverified] leaves — abridged here

CALLEE ACCOUNT: 23 nodes · 329 call sites = 43 confirmed + 151 unverified + 34 builtin + 101 excluded
```

One command, no files opened — and the `CALLEE ACCOUNT:` line proves all 329 calls were sorted, nothing dropped.

---

## Understand code you didn't write

`ucn about` gives you everything about a function in one shot - who calls it, what it calls, which tests cover it, and the source code.

```
$ ucn about expandGlob

expandGlob (function)
════════════════════════════════════════════════════════════
core/discovery.js:191-222  →  core/discovery.js:191:expandGlob
expandGlob (pattern: string, options: number = {}) : string[]

USAGES: 6 total
  3 calls, 3 imports, 0 references

CALLERS — CONFIRMED (7, 3 prod + 4 test):
  evidence: scope-match (all)
  cli/index.js:1201 [runGlobCommand]
    const files = expandGlob(pattern);
  core/cache.js:466 [isCacheStale]
    const currentFiles = expandGlob(pattern, globOpts);
  core/project.js:192 [build]
    files = expandGlob(pattern, globOpts);
  test callers:
  test/integration.test.js:167
    const files = expandGlob('**/*.go', { root: tmpDir });
  ... (3 more test callers)

CALLEES (3):
  evidence: exact-binding (all)
  parseGlobPattern [utility] - core/discovery.js:227 (1x)
  walkDir [utility] {fs} - core/discovery.js:284 (1x)
  compareNames [utility] - core/discovery.js:170 (1x)

ACCOUNT: "expandGlob" occurs on 14 lines in 6 files: 7 confirmed, 0 unverified,
  7 non-call (4 import, 1 definition, 1 reference, 1 other-text), 0 other-target, 0 unaccounted

TESTS: 5 matches in 1 file(s)
```

Callers split into **CONFIRMED** (binding/receiver/import evidence — prod first, then tests) and **UNVERIFIED** (found but unproven, each with a reason). The `ACCOUNT:` line reconciles every occurrence; `0 unaccounted` means nothing was hidden. Tune with `--min-confidence` / `--hide-confidence` / `--git`; walk callers *upward* with `ucn reverse-trace fn`.

## Answers you can trust

UCN doesn't just find a name — it tells you how sure it is. Every answer from `about`, `context`, and `impact` partitions *every* place the name appears into buckets you can act on:

```
$ ucn impact saveCache

CALL SITES: 2 confirmed + 9 unverified

test/regression-go.test.js (2 calls)
  :2004
    saveCache(index, cachePath);

UNVERIFIED CALL SITES (9) — call syntax, no binding/receiver evidence:
  mcp/server.js:779: index.saveCache(); (method-ambiguous)
  test/cache.test.js:1779: index.saveCache(); (method-ambiguous)
  ... (7 more)

ACCOUNT: "saveCache" occurs on 47 lines in 8 files: 2 confirmed, 9 unverified,
  9 non-call (2 import, 1 definition, 0 reference, 6 other-text), 27 other-target, 0 unaccounted
```

UCN sorts every one of the 47 places the name appears:

- **2 confirmed** — call sites it can prove resolve to *this* `saveCache`.
- **9 unverified** — real call sites it found but won't claim. `index.saveCache()` has an untyped receiver, so UCN can't prove which `saveCache` runs; it shows the site and the reason (`method-ambiguous`) instead of guessing.
- **27 other-target** — occurrences that belong to a *different* `saveCache`, kept separate so they never pollute the answer.
- **9 non-call** — imports, the definition, plain text.
- **`0 unaccounted`** — the partition is complete. Nothing was dropped on the floor.

The payoff: a **confirmed** answer is safe to refactor against, and an empty result with `0 unaccounted` means the symbol truly has no callers. UCN never hides a caller — and never invents one.

### Measured against ground truth

This isn't a promise — it's a gate. CI re-derives UCN's caller answers from real compilers and language servers and fails the build if a single true call edge is neither shown nor accounted for:

| Language | Oracle | Confirmed-tier precision |
|---|---|---|
| TypeScript / JavaScript | ts-morph | 99.4–100% |
| Python | pyright (LSP) | 97.7–99.9% |
| Go | gopls | 99.9–100% |
| Rust | rust-analyzer | 99.0–100% |
| Java | jdtls | 96.6% |

Ten pinned real-world repos (zod, express, httpx, rich, cobra, grpc-go, ripgrep, cursive, gson, preact-signals), three sampling seeds, every run gated at `missing-unexplained = 0`. The tree commands — `trace`, `blast`, `reverse-trace`, `affected-tests` — follow the same rule: confirmed trunk, uncertain branches flagged (`--expand-unverified` to follow). Run `ucn doctor` for the trust report on *your* repo.

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

Test files to run (20):

  test/integration.test.js (covers: expandGlob, build, idx, setupProject)
    L47: index.build(null, { quiet: true });  [call]
    L167: const files = expandGlob('**/*.go', { root: tmpDir });  [call]
    ...

POSSIBLY AFFECTED (1) — reachable only through unverified call edges:
  doctor

Uncovered (10): runGlobCommand, main, runProjectCommand, runFileCommand, evaluateRepo, ...
  ⚠ These affected functions have no test references

Summary: 15 affected → 20 test files, 5/15 functions covered (33%) · 1 possibly affected (unverified chains)
```

The confirmed closure is what you run; `POSSIBLY AFFECTED` lists functions reached only through unverified edges — extra tests worth a look, kept separate.

## Find unused code

```
$ ucn deadcode --exclude=test        # run on ripgrep

Dead code: 8 unused symbol(s)

crates/globset/src/serde_impl.rs
  [  38-  42] Glob.deserialize (method)
  [  70-  74] GlobSet.deserialize (method)
crates/matcher/src/lib.rs
  [ 397- 399] Captures.as_match (method)
  [ 669- 678] Matcher.try_find_iter (method) [only self-references — recursive]
  [ 796- 806] Matcher.try_captures_iter (method) [only self-references — recursive]
  ...

921 exported symbol(s) excluded from the audit (public API may have external callers). Use --include-exported to audit them.
```

Classes, structs, traits, and enums are audited alongside functions. Symbols whose only call sites live inside their own definitions are claimed too, marked `[only self-references — recursive]`. Every claim class is checked against compiler/LSP ground truth in CI — a claim with an oracle-visible reference fails the build.

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
- **Ground truth** - caller accuracy is measured against ts-morph, pyright, gopls, rust-analyzer, and jdtls on 10 pinned real repos, gated on zero unexplained edges (see [Answers you can trust](#answers-you-can-trust))

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
- Reflection (Python `getattr`, Java reflection) is invisible - the target is built at runtime
- Interface/trait dispatch can't be resolved to a single impl, but candidates are surfaced as `possible-dispatch` in the unverified tier, never silently dropped
- JS, TS, and Python method calls on an untyped receiver can't always be proven - UCN surfaces these in the UNVERIFIED tier with a reason rather than dropping or guessing them ([Answers you can trust](#answers-you-can-trust))
- Large repos take a few seconds on the first query, then use cache

If you need compiler diagnostics, taint analysis, or runtime semantics, those are different tools for different jobs. UCN trades that depth for speed, portability, and zero setup.

---

MIT
