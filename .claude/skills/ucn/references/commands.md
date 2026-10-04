# UCN command reference

UCN exposes exactly 18 task-oriented public commands. CLI uses hyphenated names; MCP uses snake case.

Use grep/ripgrep for simple literals, error messages, configuration, filenames,
Markdown, and unsupported languages. Use UCN for exact symbol identity,
callers/callees, change impact, test linkage, dependency/API questions, and AST
structural or code-only search.

## Understand and navigate

| Command | Purpose |
|---|---|
| `show <handle>` | Default symbol summary, callers, and callees. Select `summary,callers,callees,source,dependencies,tests,types,example,related` with `--sections`. |
| `find <name>` | Locate definitions and stable handles. Activity counts are pinned call candidates (confirmed + visible unverified); proved other-target calls are separate. Text shows the top 5 in detail and counts the rest; JSON returns up to 500; `--limit=N` raises both (`--compact` prints one line per shown result). Use `--type=type`, `--limit=N`, and `--with-source` as needed. |
| `usages <name>` | Inventory definitions, calls, imports, type references, and literal comment/string/docstring text, test files included. Those text sites appear under `OTHER TEXT` unless `--code-only`; `--exclude-tests` hides test files and states how many usages it hid. |
| `search [pattern]` | Literal text search by default; add `--regex` for RE2-compatible linear-time regular expressions, or use structural filters such as `--type`, `--param`, `--receiver`, `--returns`, or `--decorator`. Unsafe nested repetition is rejected; use ripgrep for unsupported advanced syntax. |
| `source <handle\|file:range>` | Extract a function, class-like declaration, or exact line range. |
| `trace <handle>` | Traverse callees by default. Use `--direction=callers` for blast radius and add `--to=entrypoints` for paths to roots. |

## Change and validation

| Command | Purpose |
|---|---|
| `impact [handle]` | Show direct symbol impact when given a handle; accessor targets include receiver-tiered property reads/writes as a separate dependency band. Without a handle, analyze the Git diff. |
| `tests <handle\|file>` | Find statically linked direct tests, through the same re-export and rename chains callers follow (`export * from`). Every test-file call site the caller engine attributes to the target is listed in its tier (unverified ones for a uniquely named target), whatever its shape or the file layout: implicit-`this` and static-import calls, calls in `TEST_F` bodies, receivers a pytest fixture injects. A property or getter target lists test reads whose receiver is typed as its owner (`result = runner.invoke(); result.stdout` with `invoke() -> Result`). Set `--depth=N` for transitive affected tests. Empty results are not runtime coverage proof. |
| `check [handle]` | Validate confirmed call-site arity for a symbol; without one, run the composed pre-commit diagnostic. A declaration whose parameters changed since `--base` (default `HEAD`) is also checked on the call sites its old declaration bound: one that fits no remaining overload is a mismatch, one another overload may now take is uncertain. |
| `plan <handle>` | Preview `--rename-to`, `--add-param`, or `--remove-param` edits. For renames, the proven closure can include overload/signature groups, inheritance slots across the whole resolved hierarchy (generic base clauses substituted; anonymous-class and class-expression overrides included), trait/Go-interface slots, `#[cfg]`/`#if` configuration alternatives, Python alternative bindings of one scope variable (conditional `def`s, import fallbacks, class-body aliases), accessor reads/writes (a getter and setter of one class or object-literal property together), JS/TS destructured members (the pattern key, keeping the local), object-literal shorthands (`{ gen: renamed }`, keys kept), bound and stored methods (`obj.m.bind(obj)`), exact call/reference tokens (references decided by the language's scoping, each same-name call on a line by its own call node; C# method groups by simple-name lookup, Java `this::m`/`super::m` by the enclosing class), imports/exports, Python `__all__` strings, and module-attribute references. Source comments/strings are explicit `reviewItems` (C# `cref`s resolving to the renamed member are edited); non-source files get a search handoff. Go examples bound by name (`Example<Type>_<Method>`) are renamed with their member or identifier (`editKind: "example"`). Renaming a type edits every token its language's name lookup resolves to it (type positions, constructors/destructors, static qualifiers, qualified spellings, imports and `use` trees, forward-reference strings, C# `cref`s, Go embedded-field selectors); unresolvable tokens are `needsReview` changes, and Java returns `fileRenames` for the type's `.java` file. C/C++: other external definitions of a declared free function are renamed with it (one no declaration reaches is a review item), a type name a `##` paste produces lists the pasting macro and each invocation (`macro-paste`), and a call excluded inside a parse-recovery region is a review item (`parse-recovery`). A finding repeated at many sites is printed once with its sites. Open ownership or method sets stay `needsReview`; a decorator that may bind the callable by name makes the definition a review item (`decorator-name-binding`), except a pytest fixture, whose requesting parameters (resolved by class, module and `conftest.py` scope) are renamed with it; members of contracts outside the project set `contract.blocked` (no edits) or list `contractDependency` sites (JS/TS and Python: also `_`-named members of a class deriving from an outside base and members of an object literal declared with an outside type; Go: also values passed to out-of-project functions or stored in out-of-project fields); an import alias keeps its local name (`import { g as f }`, `const f = require('m').g`); the command never applies or compiles edits. |

## Repository and architecture

| Command | Purpose |
|---|---|
| `repo` | Repository orientation. Select `summary,files,stats,health` with `--sections`; `--deep` includes readiness evidence. Skipped unsupported source is listed with a grep/language-tool handoff. |
| `deps <file>` | File dependency graph. Use `--direction=imports\|importers\|both`, `--detailed`, or `--cycles`. Cycles distinguish eager edges from function-local, Python typing-guarded, and TypeScript type-only edges. Complete cycle groups remain visible when enumeration is capped. |
| `api [file]` | Static exported/public surface for a project or file. An exact file includes tests; broader scans exclude tests with a count. Use `--include-tests` to include them. |
| `entrypoints` | Framework, route, task, test, and runtime entry points. |
| `endpoints` | Server/client HTTP surface; `--bridge` adds advisory matching. Route paths include composed router mount prefixes (an unprovable prefix shows as `{?expr}` and matches only as uncertain); declarative route tables count (Django URLconfs and DRF routers, Starlette route lists, Flask `add_url_rule`, aiohttp tables), with methods from the view and derived routes tagged `[regex]`/`[drf-router]`/`[static]`/`[include]`/`[mount]`; request-configuration calls count as clients when the helper provably performs HTTP. Prefixes join by each framework's rule (Django include patterns, echo groups and koa-router prefixes concatenate). Labels name the imported router framework, handlers come from the registration's handler argument, axum routes carry their method router's methods, and catch-all parameters span segments (`**`). A request through an in-process test client built from an app (`TestClient(app)`, `app.test_client()`, supertest `request(app).get(..)` with `request` bound to the `supertest` module) bridges only to that app's routes; an unresolved app keeps every path match, marked `[unscoped]`. Test sites carry `[test]`; `--exclude-tests` removes them and `--in=DIR` scopes the inventory. |

## Focused audits and runtime evidence

| Command | Purpose |
|---|---|
| `deadcode` | Conservative unreferenced-symbol candidates for review. Statically named reflection targets, members a reflective name pattern can spell (`"_get_%s_perms" % src`, `"get" + name`, `obj["on" + evt]`; counted per pattern), runtime protocol members (dunders, Enum hooks, serialization callbacks, C# pattern members, JS `toJSON`/`then`), modeled computed-dispatch members, unknown decorated/annotated callables, member-assigned event handlers, members of classes deriving from an outside base (`_`-named hooks such as `_transform` included) and members of object literals declared with an outside type are withheld by default. Reflection with no specific literal part is counted and warned because it cannot be attributed. C/C++ names produced by expanded token-pasting macros are live; names a never-expanded pasting macro could spell are withheld, and unexpandable invocations are warned. Rust definitions generated by project `macro_rules!` invocations are never candidates; unexpandable invocations are warned. |
| `audit-async` | Potential missing-await sites in JavaScript/TypeScript/Python and C#, and unpolled futures in Rust. MCP spelling: `audit_async`. |
| `stacktrace <text>` | Advisory stack-frame parsing and source lookup. |

## Stable symbol identity

Symbol-listing commands emit handles such as `src/api.ts:42:handler`. Pass the full handle to symbol commands. `path:line` also works. Handles prevent same-named definitions from being silently combined.

Definition handles and source spans start at the first decorator or annotation when present; literal usages point at the actual token line. Use a symbol's `nameLine` (when present, otherwise `startLine`) to compare declaration tokens with usages.

Structural `search --param` matches parameter names, types, and defaults; `--returns` matches return annotations. Both exclude AST comments and preserve string contents. `--unused` lists callable symbols without call edges, not safe-delete candidates; decorated runtime registrations may still appear. Its safety note and decorator tags are retained in `--lines` output. Use `deadcode` and `usages` before deletion.

`repo` summary/stats `buildTime` is the duration of the last index build (discovery, parsing, and graphs), retained in the cache. It excludes cache loading/saving and query execution, so it is not command wall time; `buildTimeNote` states this boundary.

`--lines` writes one record per output line. `usages --lines` groups occurrences by source line and tags their kinds and counts. JSON retains individual occurrence records.

Public JSON source paths (`file`, caller files, dependency roots and edges) are project-relative, with the absolute base in `meta.pathBase`. Project roots and external paths remain absolute. Indexed absolute handles are accepted as well as relative handles.

Default test exclusions follow language conventions. Python `spec.py` and `*_spec.py` are included; `test_*.py`, `*_test.py`, and test directories are excluded. Structural search reports hidden test-file counts, including on empty results. `--include-tests` disables these defaults; explicit `--exclude` patterns still apply.

`audit-async` checks recognized async producers, including Python coroutine calls in synchronous functions (discarded ones at module scope too), Python locals assigned straight from a coroutine call and used as its result where they can hold nothing else (`stored-coroutine-used-as-value`), and captured JS/TS/HTML promises used as resolved values in the same lexical scope. Bare calls must reach the producer through lexical scope or import identity; a same-name function elsewhere in the project is not one. A finding is a lost value (bare statement, or a local never read) or one used as if resolved; values passed as arguments, placed in collections/generators/spreads, returned, or chosen by a ternary/logical expression flow on. Promise returns and handlers are valid. Async iterators and async context managers are flagged only when discarded; async functions behind an unrecognized decorator are counted as not audited. Rust futures (`async fn`, `impl Future`/boxed/aliased future returns, local `|| async {}` closures) are flagged when discarded (`future-discarded`), dropped by `let _ =` (`future-dropped`), bound to a local never used (`future-unused`), or used as their Output (`async-result-used-as-value`, `stored-future-used-as-value`); calls in sync functions count. Only engine-confirmed call targets are audited; `skippedFutures` counts futures of types implementing `Future` or of fns behind a non-builtin attribute. Alias flow and unknown receivers require compiler/type-checker review.

## Common flags

| Flag | Meaning |
|---|---|
| `--sections=a,b` | Select `show` or `repo` projections. |
| `--file=<pattern>` | Scope or disambiguate by file. |
| `--class-name=<name>` | Scope a member when no handle is available. |
| `--in=<directory>` | Limit query scope to a directory. |
| `--exclude=<patterns>` | Exclude matching paths. |
| `--limit=N` | Default maximum of 500 results for `find`, text `search`, `deadcode`, `api`, and `repo` files; structural `search` defaults to 50. Explicit limits override these caps; `usages` and `--lines` are uncapped by default. |
| `--include-bundled` | Include `*.min.js` and `*.bundle.js` in discovery, respecting user exclusions and bypassing the shared cache. By default these and `*.map` are disclosed as skipped sources and completeness is partial. Source maps remain unindexed. MCP: `include_bundled=true`. |
| `--depth=N` | Set trace/dependency/test traversal depth. |
| `--direction=<value>` | Select trace or dependency direction. |
| `--all` | Lift result and formatter caps where supported. It is recommended only for commands that accept it. |
| `--max-chars=N` | Set the hard CLI text budget, including notices and preserved trust metadata (10K targeted / 3K broad by default; 100K ceiling). Trust lines are reserved first; a limit too small for them withholds the answer and names the budget that carries them. MCP spelling: `max_chars`. JSON is not transport-truncated. |
| `--compact` / `--no-compact` | Select token-efficient or full semantic output. |
| `--range=N-M` | Extract an explicit line range with `source --file=<path>`. |
| `--json` | Emit the stable CLI `{ meta, data }` envelope; `meta.contract` carries the truth boundary, decision safety, and next actions. |
| `--lines` | `find/usages/search/show/impact`: uncapped `path:line:text` listings, with tier tags after a tab. `show` accepts callers/callees sections; default callers. Accounting and notes go to stderr. Exit 0 for records, 1 for none, 2 for errors. Explicit row limits disclose omissions. |
| `--raw` | `source`: code only, including full large classes. Notes and explicit `--max-lines` truncation travel on stderr. In CLI shell modes, exceeding an explicit `--max-chars` fails before stdout instead of truncating it. |
| `--expand-unverified` | Follow possible caller edges while preserving their unverified status. |
| `--base=<ref>` / `--staged` | Scope Git-diff `impact` or target-less `check`. `check <handle> --base=<ref>` reads the old declaration at that ref; `impact <handle>` takes neither, nor does `check <handle>` take `--staged`. |
| `--no-cache` / `--clear-cache` | Bypass or clear the current project's per-user cache. Set `UCN_CACHE_DIR` to override its root. |
| `--workers=N` | Set build workers; `0` disables parallel build. |
| `--include-exported` | Include exported symbols in `deadcode`. |
| `--include-decorated` | Include decorated symbols in `deadcode`. |
| `--code-only` | Exclude comments and strings in `search`/`usages`. |
| `--regex` | Interpret a `search` term as a regular expression. Without it, the term is literal. |

## Target forms

```text
ucn [target] <command> [argument] [flags]
```

Omit the target for the current project. A target may be a file, directory, or quoted glob such as `"src/**/*.py"`.

Ordinary text and shell command errors exit 2. JSON command errors retain
exit 1 with `meta.ok: false` and an `error` field; successful empty JSON
results exit 0. Target-less `check` exits 1 for `TRUST: BLOCKED`, 0 for other
completed checks, and 2 when the check could not run. An exception inside UCN
is an internal error: the message starts `Internal error:` on every surface and
CLI JSON adds `meta.internalError: true`; the exit code is that of any command
error. Working-tree `impact`
and `check` count untracked documentation/configuration in their non-source
path note; `--staged` excludes all untracked paths.

## Language notes

Supported source families are JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, and HTML inline JavaScript/event handlers. C/C++ consumes `compile_commands.json` when present for header-language and include-path context, and retains AST-proven facts across recoverable preprocessor branches. C++ call identity uses namespace ownership, static overload shape (including arrays), and macro requalification; disagreeing conditional macro definitions remain visible as unverified. C# uses declared property/field receiver types and overload/hiding discipline; `using` directives resolve from the namespace they sit in, and a C# `#if` that splits a declaration is read one configuration at a time. An overload whose parameters differ where the argument type is unknown stays `overload-ambiguous` (Java, C#). C++ `friend` functions are namespace functions, and a namespace-scope `MACRO(args) { body }` defines a callable named from its arguments (`generatedByMacro`). Rust invocations of project `macro_rules!` macros are expanded, and what they generate is indexed at the invocation (`[via macro NAME]`). UCN remains portable AST analysis: it does not run a compiler, preprocessor, Roslyn, or an LSP during normal queries, and it does not assert which conditional branch a build activates.
