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
| `find <name>` | Locate definitions and stable handles. Activity counts are pinned call candidates (confirmed + visible unverified); proved other-target calls are separate. Use `--type=type`, `--limit=N`, and `--with-source` as needed. |
| `usages <name>` | Inventory definitions, calls, imports, type references, and literal comment/string/docstring text. Those text sites appear under `OTHER TEXT` unless `--code-only`. |
| `search [pattern]` | Literal text search by default; add `--regex` for RE2-compatible linear-time regular expressions, or use structural filters such as `--type`, `--param`, `--receiver`, `--returns`, or `--decorator`. Unsafe nested repetition is rejected; use ripgrep for unsupported advanced syntax. |
| `source <handle\|file:range>` | Extract a function, class-like declaration, or exact line range. |
| `trace <handle>` | Traverse callees by default. Use `--direction=callers` for blast radius and add `--to=entrypoints` for paths to roots. |

## Change and validation

| Command | Purpose |
|---|---|
| `impact [handle]` | Show direct symbol impact when given a handle; accessor targets include receiver-tiered property reads/writes as a separate dependency band. Without a handle, analyze the Git diff. |
| `tests <handle\|file>` | Find statically linked direct tests. Set `--depth=N` for transitive affected tests. Empty results are not runtime coverage proof. |
| `check [handle]` | Validate confirmed call-site arity for a symbol; without one, run the composed pre-commit diagnostic. |
| `plan <handle>` | Preview `--rename-to`, `--add-param`, or `--remove-param` edits. For renames, the proven closure can include overload/signature groups, inheritance/trait/Go-interface slots, accessor reads/writes, exact call/reference tokens, imports/exports, Python `__all__` strings, and module-attribute references. Source comments/strings are explicit `reviewItems`; non-source files get a search handoff. Open ownership or method sets stay `needsReview`; the command never applies or compiles edits. |

## Repository and architecture

| Command | Purpose |
|---|---|
| `repo` | Repository orientation. Select `summary,files,stats,health` with `--sections`; `--deep` includes readiness evidence. Skipped unsupported source is listed with a grep/language-tool handoff. |
| `deps <file>` | File dependency graph. Use `--direction=imports\|importers\|both`, `--detailed`, or `--cycles`. Cycles distinguish eager edges from function-local, Python typing-guarded, and TypeScript type-only edges. Complete cycle groups remain visible when enumeration is capped. |
| `api [file]` | Static exported/public surface for a project or file. An exact file includes tests; broader scans exclude tests with a count. Use `--include-tests` to include them. |
| `entrypoints` | Framework, route, task, test, and runtime entry points. |
| `endpoints` | Server/client HTTP surface; `--bridge` adds advisory matching. |

## Focused audits and runtime evidence

| Command | Purpose |
|---|---|
| `deadcode` | Conservative unreferenced-symbol candidates for review. Statically named reflection targets, modeled computed-dispatch members, unknown decorated/annotated callables, and member-assigned event handlers are withheld by default. Recognized dynamic reflection is counted and warned because it cannot be attributed. |
| `audit-async` | Potential missing-await sites in JavaScript/TypeScript/Python and C#. MCP spelling: `audit_async`. |
| `stacktrace <text>` | Advisory stack-frame parsing and source lookup. |

## Stable symbol identity

Symbol-listing commands emit handles such as `src/api.ts:42:handler`. Pass the full handle to symbol commands. `path:line` also works. Handles prevent same-named definitions from being silently combined.

Definition handles and source spans start at the first decorator or annotation when present; literal usages point at the actual token line. Use a symbol's `nameLine` (when present, otherwise `startLine`) to compare declaration tokens with usages.

Structural `search --param` matches parameter names, types, and defaults; `--returns` matches return annotations. Both exclude AST comments and preserve string contents. `--unused` lists callable symbols without call edges, not safe-delete candidates; decorated runtime registrations may still appear. Its safety note and decorator tags are retained in `--lines` output. Use `deadcode` and `usages` before deletion.

`repo` summary/stats `buildTime` is the duration of the last index build (discovery, parsing, and graphs), retained in the cache. It excludes cache loading/saving and query execution, so it is not command wall time; `buildTimeNote` states this boundary.

`--lines` writes one record per output line. `usages` records occurrences, so multiple tokens on the same source line can produce repeated `path:line` values. Deduplicate those values when counting source lines.

Public JSON source paths (`file`, caller files, dependency roots and edges) are project-relative, with the absolute base in `meta.pathBase`. Project roots and external paths remain absolute. Indexed absolute handles are accepted as well as relative handles.

Default test exclusions follow language conventions. Python `spec.py` and `*_spec.py` are included; `test_*.py`, `*_test.py`, and test directories are excluded. Structural search reports hidden test-file counts, including on empty results. `--include-tests` disables these defaults; explicit `--exclude` patterns still apply.

`audit-async` checks recognized async producers, including captured JS/TS/HTML promises used as resolved values in the same lexical scope. Promise returns and handlers are valid; alias flow and unknown receivers require compiler/type-checker review.

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
| `--max-chars=N` | Set the hard CLI text budget, including notices and preserved trust metadata (10K targeted / 3K broad by default; 100K ceiling). MCP spelling: `max_chars`. JSON is not transport-truncated. |
| `--compact` / `--no-compact` | Select token-efficient or full semantic output. |
| `--range=N-M` | Extract an explicit line range with `source --file=<path>`. |
| `--json` | Emit the stable CLI `{ meta, data }` envelope; `meta.contract` carries the truth boundary, decision safety, and next actions. |
| `--lines` | `find/usages/search/show/impact`: uncapped `path:line:text` listings, with tier tags after a tab. `show` accepts callers/callees sections; default callers. Accounting and notes go to stderr. Exit 0 for records, 1 for none, 2 for errors. Explicit row limits disclose omissions. |
| `--raw` | `source`: code only, including full large classes. Notes and explicit `--max-lines` truncation travel on stderr. In CLI shell modes, exceeding an explicit `--max-chars` fails before stdout instead of truncating it. |
| `--expand-unverified` | Follow possible caller edges while preserving their unverified status. |
| `--base=<ref>` / `--staged` | Scope Git-diff `impact` or target-less `check`. |
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
completed checks, and 2 when the check could not run. Working-tree `impact`
and `check` count untracked documentation/configuration in their non-source
path note; `--staged` excludes all untracked paths.

## Language notes

Supported source families are JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, and HTML inline JavaScript/event handlers. C/C++ consumes `compile_commands.json` when present for header-language and include-path context, and retains AST-proven facts across recoverable preprocessor branches. C++ call identity uses namespace ownership, static overload shape (including arrays), and macro requalification; disagreeing conditional macro definitions remain visible as unverified. C# uses declared property/field receiver types and overload/hiding discipline. UCN remains portable AST analysis: it does not run a compiler, preprocessor, Roslyn, or an LSP during normal queries, and it does not assert which conditional branch a build activates.
