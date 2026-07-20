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

And it's built for **auditable trust**. grep hands you raw text matches to verify yourself; UCN separates target-backed edges from possible edges, explains exclusions, and reconciles its observed text set. It does not turn a zero into a deletion claim. CI re-derives answers from real compilers and language servers (ts-morph, pyright, gopls, rust-analyzer, jdtls). Publishing is gated on a representative five-repository board; the scheduled board covers nineteen plus rotating fresh repositories. See [Answers you can trust](#answers-you-can-trust).

### Same engine, different transport

The CLI and MCP tool use the same command registry, handlers, project index, persisted cache, and output formatters. The skill is guidance for choosing and interpreting those commands; it is not a third analysis engine.

The transports intentionally have different defaults:

- CLI prints full text unless `--compact` is passed. `--json` emits raw machine-readable JSON.
- MCP defaults `about`, `context`, and `impact` to compact text. Targeted commands have a 10K character default, broad commands have a 3K default, and the hard ceiling is 100K. Truncated answers retain contract metadata.
- MCP commands and parameters use snake_case. CLI commands and flags use hyphenated names.
- A persistent MCP server keeps the process and index warm across calls. Repeated calls are normally faster than launching the CLI for every query, while semantic execution and cache behavior remain shared.

When comparing text output, use equivalent flags and compact settings. Transport-specific retry hints use the spelling appropriate to that surface, so the final hint line may differ.

---

```bash
npm install -g ucn             # Node.js 20+

ucn orient                     # first look at any repo: size, hot spots, trust
ucn trace main --depth=3       # full execution flow
ucn about handleRequest        # definition + callers + callees + tests
ucn impact handleRequest       # every call site with arguments
ucn deadcode --exclude=test    # unused code, AST-verified
```

"What happens when `build()` runs?"

```
$ ucn trace build --depth=2

build
├── detectProjectPattern (core/discovery.js:450) 1x
├── parseGitignore (core/discovery.js:131) 1x
├── expandGlob (core/discovery.js:199) 1x
│   ├── parseGlobPattern (core/discovery.js:238) 1x
│   ├── walkDir (core/discovery.js:295) 1x
│   └── compareNames (core/discovery.js:178) 1x
├── parallelBuild (core/parallel-build.js:25) 1x
├── indexFile (core/project.js:397) 1x
│   ├── addSymbol (core/project.js:502) 4x
│   ├── detectLanguage (languages/index.js:344) 1x
│   ├── parse (core/parser.js:69) 1x
│   ├── extractImports (core/imports.js:19) 1x
│   └── extractExports (core/imports.js:44) 1x
├── buildImportGraph (core/project.js:798) 1x
└── buildInheritanceGraph (core/project.js:803) 1x
    … calls UCN can't prove a receiver for (arr.push(), obj.get()) show as
      [unverified] leaves (abridged here)

CALLEE ACCOUNT: 26 nodes expanded · 394 call sites = 61 confirmed + 162 unverified (162 uncertain-receiver) + 68 external/builtin + 103 excluded
```

One command, no files opened. The `CALLEE ACCOUNT:` line reconciles all 394 indexed call sites into explicit buckets.

---

## Understand code you didn't write

`ucn about` gives you everything about a function in one shot - who calls it, what it calls, which tests cover it, and the source code.

```
$ ucn about expandGlob

expandGlob (function)
════════════════════════════════════════════════════════════
core/discovery.js:199-233  →  core/discovery.js:199:expandGlob
expandGlob (pattern: string, options: number = {}) : string[]

USAGES: 8 total
  3 calls, 3 imports, 2 references

CALLERS: CONFIRMED (7, 3 prod + 4 test):
  evidence: scope-match (all)
  cli/index.js:1267 [runGlobCommand]
    const files = expandGlob(pattern);
  core/cache.js:548 [isCacheStale] [unreachable]
    const currentFiles = expandGlob(pattern, globOpts);
  core/project.js:257 [build]
    files = expandGlob(pattern, globOpts);
  test callers:
  test/integration.test.js:167
    const files = expandGlob('**/*.go', { root: tmpDir });
  ... (3 more test callers)

CALLEES (3):
  evidence: exact-binding (all)
  parseGlobPattern [utility] - core/discovery.js:238 (1x)
  walkDir [utility] {fs} - core/discovery.js:295 (1x)
  compareNames [utility] - core/discovery.js:178 (1x)

ACCOUNT: "expandGlob" occurs on 14 lines in 6 files: 7 confirmed, 0 unverified,
  7 non-call (4 import, 1 definition, 2 reference, 0 other-text), 0 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed

TESTS: 5 matches in 1 file(s)
```

Callers split into **CONFIRMED** (binding/receiver/import evidence, with production before tests) and **UNVERIFIED** (found but unproven, each with a reason). `ACCOUNT:` reconciles the literal-name text set; `CONTRACT:` states its scope and completeness. Neither claims that aliases, generated code, reflection, runtime registration, or external consumers do not exist. Tune the evidence display with `--min-confidence` / `--hide-confidence` / `--git`; walk callers *upward* with `ucn reverse-trace fn`.

## Answers you can trust

UCN doesn't just find a name. It shows the identity evidence it has and the uncertainty it retains. Every answer from `about`, `context`, and `impact` partitions *every observed literal-name occurrence* into auditable buckets:

```
$ ucn impact saveCache

CALL SITES: 2 confirmed + 11 unverified

test/regression-go.test.js (2 calls)
  :2007
    saveCache(index, cachePath);

UNVERIFIED CALL SITES (11): call syntax, no binding/receiver evidence
  core/project.js:2126: saveCache(cachePath) { ... } (call-not-resolved)
  mcp/server.js:810: try { index.saveCache(); } catch (_) ... (method-ambiguous)
  test/cache.test.js:1804: index.saveCache(); (method-ambiguous)
  ... (8 more)

ACCOUNT: "saveCache" occurs on 55 lines in 8 files: 2 confirmed, 11 unverified,
  11 non-call (2 import, 1 definition, 1 reference, 7 other-text), 31 other-target, 0 unaccounted
CONTRACT: literal-name text partition complete; semantic completeness is not claimed
```

UCN sorts every one of the 55 places the name appears:

- **2 confirmed**: call sites it can prove resolve to *this* `saveCache`.
- **11 unverified**: real call sites it found but won't claim. `index.saveCache()` has an untyped receiver, so UCN can't prove which `saveCache` runs; it shows the site and the reason (`method-ambiguous`) instead of guessing.
- **31 other-target**: occurrences that belong to a *different* `saveCache`, kept separate so they never pollute the answer.
- **11 non-call**: imports, the definition, plain text.
- **`0 unaccounted`**: every line in the observed literal-name set was assigned to a bucket.

The payoff is an answer an agent can audit instead of a single opaque match count. A confirmed edge is evidence for the pinned target; an unverified edge requires review. A clean account with no callers is an **observed-text zero**, not semantic-zero or safe-delete proof. Before deleting anything, run `ucn usages`, inspect entry points and public API exposure, check `ucn doctor --deep` deletion readiness, and corroborate with the compiler/type checker and tests.

### Measured against ground truth

This is a release gate, not a promise of universal program understanding. CI re-derives UCN answers from real compilers and language servers. The pinned release board must pass at least 98% confirmed precision, zero semantically missing in-scope edges, a conserved caller account, command-surface checks, dead-code checks, and performance budgets.

Current pinned release-board results:

| Repository | Language oracle | Confirmed caller precision | Caller recall | Callee precision/recall | Command checks |
|---|---|---:|---:|---:|---:|
| preact-signals | ts-morph | 100% | 100% | 100% / 100% | 100% |
| httpx | pyright | 100% | 100% | 100% / 100% | 100% |
| cobra | gopls | 100% | 100% | 100% / 100% | 100% |
| clap | rust-analyzer | 100% | 100% | 100% / 100% | 100% |
| javapoet | jdtls | 100% | 100% | 100% / 100% | 100% |

The command checks cover exact definition lookup, `find`, `fn`/`class`, `brief`, `typedef`, `usages`, `tests`, and `example` against the same external oracle population. The dead-code arm currently has zero false-dead claims on the release board. The semantic gate also caps configuration-unscored caller and callee evidence at 10%, so platform filtering cannot silently make a small scored subset look representative. The performance arm runs every repository in an isolated process, takes three fresh-cache startup samples, reports median and maximum first-query latency, and independently gates steady-state p50/p95 and peak memory.

Unverified precision is reported separately and is intentionally much lower on dispatch-heavy code. Unverified entries are review candidates, not confirmed claims. Rust feature-gated sites that one compiler configuration cannot load are reported as unscored rather than counted as passes.

The scheduled board covers nineteen pinned repositories, multiple sampling seeds, and a rotating fresh-repository arm. It is broader than the five-repository publish gate and is used to expose regressions and overfitting. The tree commands `trace`, `blast`, `reverse-trace`, and `affected-tests` follow the same evidence discipline. Run `ucn doctor --deep` for task-specific readiness on your repository.

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

The `Patterns:` line surfaces structural classification of each call site (`inLoop`, `inTry`, `inCallback`, `inTestCase`, `awaited`) so you can spot risky call sites such as calls inside loops or missing `await`. The same line appears on `impact` and inside `about`.

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

`ucn check` composes `diff-impact` + `verify` + `affected-tests` in one shot. It flags added functions with no callers, signature drift across call sites, and recommends which tests to run.

## Get the lay of the land in a new repo

One command answers "what is this codebase?": size and language mix, where the code lives, the most-called production functions, entry points, and how far to trust the index.

```
$ ucn orient

PROJECT ORIENTATION: /path/to/project
════════════════════════════════════════════════════════════
169 files · 2111 symbols · javascript 67%, rust 8%, typescript 8%, java 7%, go 5%, python 5%

TOP DIRS (by symbols):
  core            516 symbols · 29 file(s)
  languages       282 symbols · 8 file(s)
  test            209 symbols · 29 file(s)
  core/output     142 symbols · 14 file(s)
  ...

HOT (most-called production functions, top 8 of 1028):
  execute: 1124 call(s) · core/execute.js:1608
  ProjectIndex.build: 340 call(s) · core/project.js:221
  getParser: 150 call(s) · languages/index.js:312
  ...

ENTRY POINTS: 389; test 284, runtime 72, http 32, di 1
TRUST: MEDIUM; 41 dynamic import(s), 13 eval, 6 reflection  (ucn doctor for detail)

Next: ucn about execute · ucn toc --detailed · ucn stats --hot --top=20 · ucn doctor --deep
```

Then drill in:

```
$ ucn brief fetch_user
fetch_user(user_id: int): dict
  svc.py:4-8  (5 lines)
  "Fetch a user from the API."
  async: no  |  side_effects: [fs, network, process]  |  complexity: branches=2, depth=2
```

`brief` is the lighter alternative to `about`: typed signature, first sentence of the docstring, side-effect classification, and complexity, all in one screen. Pair with `--git` to see who last touched it and how often.

```
$ ucn doctor

UCN Trust Report: /path/to/project
Index: 169 files, 2104 symbols
Languages: javascript (72%), typescript (14%), java (4%), python (4%), rust (4%), go (3%)
Cache: fresh, 344ms build
Command proofs: 39/39 classified, 22 external-oracle-backed, 0 unclassified

Readiness:
  navigation: HIGH: fresh index; no parse failures
  refactor: UNKNOWN: run --deep; review unverified and non-call occurrences
  deletion: REVIEW: usages, public API, compiler, and tests are still required
```

`doctor` reports task-specific readiness for the index: file/symbol counts, blind spots (dynamic imports, eval, reflection), parse failures, command-proof classification, and separate navigation/refactor/deletion levels. Use `--deep` to sample the resolution evidence profile. This profile is not measured accuracy; use the oracle reports for accuracy.

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

POSSIBLY AFFECTED (1): reachable only through unverified call edges
  doctor

Uncovered (12): runGlobCommand, main, isCacheStale, runProjectCommand, runFileCommand, ...
  ⚠ These affected functions have no test references

Summary: 15 affected → 20 test files, 3/15 functions covered (20%) · 1 possibly affected (unverified chains)
```

The confirmed closure is what you run; `POSSIBLY AFFECTED` lists functions reached only through unverified edges. These extra tests are worth reviewing and remain separate.

## Find unused code

```
$ ucn deadcode --exclude=test        # run on ripgrep

Dead code: 8 unused symbol(s)

crates/globset/src/serde_impl.rs
  [  38-  42] Glob.deserialize (method)
  [  70-  74] GlobSet.deserialize (method)
crates/matcher/src/lib.rs
  [ 397- 399] Captures.as_match (method)
  [ 669- 678] Matcher.try_find_iter (method) [only self-references, recursive]
  [ 796- 806] Matcher.try_captures_iter (method) [only self-references, recursive]
  ...

921 exported symbol(s) excluded from the audit (public API may have external callers). Use --include-exported to audit them.
```

Classes, structs, traits, and enums are audited alongside functions. Symbols whose only call sites live inside their own definitions are claimed too, marked `[only self-references, recursive]`. Deadcode claims are re-derived against compiler/LSP ground truth in CI. A default-audit claim with an oracle-visible reference fails the build.

Find missing-await bugs:

```
ucn audit-async
```

Lists async calls inside async functions that lack `await` (JS/TS/Python).

## Map your API surface across languages

UCN can match server routes to client requests across the supported languages: Express/Fastify/Koa/NestJS/Next.js, Flask/FastAPI, Spring/JAX-RS, Go net/http (Gin/Echo/Chi/Fiber), and axum/actix-web on the server side; fetch/axios, requests/httpx, RestTemplate/WebClient, and reqwest on the client side.

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
- **Ground truth** - caller, callee, and oracle-judgable command behavior is measured against ts-morph, pyright, gopls, rust-analyzer, and jdtls. The publish gate uses five representative repositories; the scheduled board uses nineteen plus a rotating fresh-repository arm. Gates track confirmed precision, semantic recall, conservation, observed-zero agreement, oracle configuration coverage, dead-code false positives, isolated startup latency, steady-state latency, and peak memory (see [Answers you can trust](#answers-you-can-trust))

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
