# UCN command reference

## Navigation and extraction

| Command | Purpose |
|---|---|
| `orient` | Repository size, languages, hot symbols, entry points, and readiness summary |
| `toc` | Files and symbol counts; add `--detailed` for symbol listings |
| `find <glob>` | Find definitions and obtain stable handles |
| `fn <handle>` | Extract a function without reading the whole file |
| `class <handle>` | Extract a class or class-like declaration |
| `lines <start-end> --file=<path>` | Extract an exact line range |
| `brief <handle>` | Signature, documentation sentence, effects, and complexity |
| `about <handle>` | Definition, callers, callees, tests, source, and contracts |
| `context <handle>` | Compact callers/callees without the full source body |
| `smart <handle>` | Symbol source plus directly used helpers |
| `example <handle>` | Best confirmed usage example; abstains when only unverified calls exist |
| `related <handle>` | Advisory sibling ranking from names, files, and shared dependencies |
| `expand <N>` | Expand a numbered item from a prior context result |

## Calls, impact, and refactoring

| Command | Purpose |
|---|---|
| `impact <handle>` | Direct callers grouped by evidence tier |
| `blast <handle>` | Transitive caller tree |
| `trace <handle>` | Transitive callee tree |
| `reverse-trace <handle>` | Caller paths toward entry points |
| `affected-tests <handle>` | Tests reachable from affected code |
| `verify <handle>` | Check confirmed call sites against the target signature |
| `plan <handle> --rename-to=X` | Preview a rename or parameter edit |
| `diff-impact [--base=REF]` | Changed symbols and caller impact from a Git diff |
| `check [--base=REF]` | Diff impact, signature checks, and affected tests |

## Search, graph, and maintenance

| Command | Purpose |
|---|---|
| `search <pattern>` | JavaScript-regex text search; add `--no-regex` for literal search |
| `search --type=function --param=X` | Structural symbol search |
| `search --type=call --receiver=db` | Structural call-site search |
| `usages <name>` | Definitions, calls, imports, types, and other references |
| `typedef <name>` | Type, interface, enum, struct, trait, class, and record definitions |
| `tests <name>` | Test files and test functions associated with a symbol |
| `imports <file>` | Dependencies of a file |
| `exporters <file>` | Files depending on a file |
| `file-exports <file>` | Symbols exported by a file |
| `graph <file> --depth=N` | File dependency tree |
| `circular-deps` | Import cycles |
| `api` | Exported/public project surface |
| `stats` | Project counts; add `--hot` or `--functions` for deeper reporting |
| `entrypoints` | Framework, route, task, test, and runtime entry points |
| `endpoints --bridge` | Advisory server-route/client-request matching |
| `deadcode` | Unreferenced-symbol candidates |
| `audit-async` | Potential missing-await sites in JS/TS/Python |
| `stacktrace <text>` | Advisory stack-frame parsing and source lookup |
| `doctor --deep` | Index health, blind spots, evidence profile, and task readiness |

## Stable symbol identity

Commands that list symbols emit handles such as `src/api.ts:42:handler`. Pass the full handle to any command accepting a symbol. `path:line` also works. Handles avoid silently combining same-named definitions.

## Common flags

| Flag | Meaning |
|---|---|
| `--file=<pattern>` | Scope or disambiguate by file |
| `--class-name=<name>` | Scope a member to a class |
| `--in=<directory>` | Limit indexing/query scope |
| `--exclude=<patterns>` | Exclude matching paths from displayed analysis |
| `--depth=N` | Control tree depth |
| `--all` | Lift output caps where supported |
| `--compact` | Reduce previews and source for agent-efficient output |
| `--json` | Machine-readable output |
| `--expand-unverified` | Follow possible caller edges and mark resulting chains unverified |
| `--base=<ref>` | Compare Git changes with a ref |
| `--staged` | Analyze staged changes |
| `--no-cache` | Rebuild instead of loading the project cache |
| `--clear-cache` | Remove the project cache before rebuilding |
| `--workers=N` | Set build-worker count; `0` disables parallel build |
| `--include-exported` | Audit exported symbols in `deadcode` |
| `--include-decorated` | Audit decorated symbols in `deadcode` |
| `--code-only` | Exclude comments and strings in text usage/search |

`--include-uncertain` and `--include-methods` do not reveal hidden caller evidence in contracted caller commands; those commands already show possible sites in the unverified band. Evidence filters can hide displayed results, so inspect `FILTERED` and rerun without filters before breaking changes.

## Target forms

```text
ucn [target] <command> [symbol] [flags]
```

Omit `target` for the current project. A target may be a file, directory, or quoted glob such as `"src/**/*.py"`.
