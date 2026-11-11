---
name: ucn
description: AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML. Use in repositories over roughly 500 LOC to orient, extract symbols, trace callers or callees, assess change impact, validate call sites, select tests, inspect dependencies, or investigate dead code. Prefer it over repeated grep-and-read cycles for semantic questions; use text search for literals, messages, configuration, and unsupported languages.
---

# UCN

UCN answers semantic questions about a codebase from a tree-sitter index: where a symbol is defined, who calls it, what it calls, what a change touches, which tests reach it. Caller and impact answers label uncertain relationships and account for observed name occurrences. Other commands expose their own scope and evidence limits.

## When to use it

- Semantic questions in a supported language (JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, HTML inline scripts): definitions, callers, callees, impact, tests, dependencies, public API, dead code.
- Use text search for literals, messages, configuration, filenames, Markdown, and unsupported languages. Below roughly 500 LOC, reading the files directly is usually faster.
- An empty UCN result is a statement about the indexed text, never proof that nothing reaches a symbol at runtime.

## Core workflow

1. `ucn repo` in an unfamiliar repository; `--deep` adds index health and readiness. Skipped unsupported source is listed with a handoff: use text search and a language-native tool for those files. An `UNSUPPORTED` or `PARTIAL` scope is never a semantic zero.
2. `ucn find <name>` pins a definition. Pass its `path:line:name` handle to every later command. A plain name that matches several definitions carries an ambiguity warning in `show`, `source`, `trace`, `impact`, `tests`, `check` and `plan`; never treat the auto-selected definition as the repository-wide target.
3. `ucn show <handle>` gives the summary, callers and callees. `--sections` replaces that selection; for example, `--sections=summary,source,tests` requests those three sections.
4. Before a change: `ucn impact <handle>` and `ucn tests <handle> --depth=3`.
5. After a signature change: `ucn check <handle>`; before committing: target-less `ucn check`. Both compare a changed declaration with its parameters at `--base` (default `HEAD`), so the call sites bound to the old declaration are checked against the new one; a site that fits no remaining overload is a mismatch, never an excluded other-target line. Target-less `check` gives each changed symbol a verdict by what the change did. `BLOCKED`: a break was observed (a call site that no longer fits, an import or bare call of a deleted name, an import of a name its module no longer exports, an import of a deleted file, an object literal declared as a type that gained a member it lacks); every site is listed. A site the toolchain does not look at (a line under `// @ts-ignore` or `# type: ignore`, a module loaded by a call the compiler does not resolve) is listed and is `REVIEW`, never what blocks. `REVIEW`: the change can reach existing code and the engine cannot settle it (a changed header, generator kind or body-inferred return; an added name already in use or a member that overrides, is required, is a new member of a TypeScript class other code can hold or enumerate, is an operator or conversion, or is invoked by a runtime or framework; a deletion a shield holds; a `(module)` item for changed exports, removed imports, loose module code or a new file an existing import can resolve to), with the reason named. `READY`: nothing that existed depends on it (a body edit that leaves the contract alone, new code under new names, a deletion with no static dependents). `TRUST` is the worst verdict. `--staged` describes the git index, not the worktree: files, `.gitignore` and `.ucn.json` come from the index, including paths marked skip-worktree or assume-unchanged; when the index cannot be exported, `check` and `impact` decline.
6. `ucn source <handle>` or `ucn source path/to/file:10-30` for exact code, only when inspection is needed.

The direct tests in `show <handle> --sections=tests` match `tests <handle>`. Equivalent file and line parameters preserve the same exact declaration, including overloads.

Rust calls to trait implementations on external types require review when unseen inherent methods could win. This applies even when a query includes several target definitions.

Python inherited members respect base order. Unknown earlier bases and explicit `super(Class, value)` receivers can keep calls unverified. A lambda's own `self` or `cls` parameter does not prove a field owner; captured method receivers retain their binding.

An explicit constructor has its own handle, including Java overloads, compact record constructors and C++ constructors defined outside their class. Proven construction calls appear under that handle and supply arguments to `check`. Review unverified construction sites before changing the signature. A function that constructs a class lists the class as a callee and, when proven, the constructor body it runs `(constructs C)`. C++ template calls inside parenthesized object initializers remain visible.

C# `this(...)` and `base(...)` initializers keep the generic type's arity. Nested constructions under a generic containing type stay visible for review when that owner's identity is unproven. `tests` also includes nested-type annotation and qualifier references, with their evidence tier. Arguments such as `Outer<T>.Inner<U>` can keep C# overload choices unverified when the enclosing type identity is unresolved.

C++ overload checks resolve standard string types by qualified name and inspect project constructors and constraints. A sole surviving overload can be confirmed; unknown constraints or several viable conversions stay unverified. C# implicit operators keep potentially reachable overloads visible.

C++ integer literals with value zero keep pointer overloads reachable as null pointer constants.

## Choose a command

| Decision | Command |
|---|---|
| Orient or diagnose a repository | `ucn repo [--sections=files,stats,health] [--deep]` |
| Understand one symbol | `ucn show <handle> [--sections=...]` |
| Locate definitions or types | `ucn find <name> [--type=type]` |
| Inspect literal-name occurrence kinds | `ucn usages <name>` |
| Search literal text, explicit regex, or AST structure | `ucn search [term] [--regex] [--type=...]` |
| Extract exact source | `ucn source <handle\|file:range>` |
| Follow calls down or up | `ucn trace <handle> --direction=callees\|callers` |
| Find paths to roots | `ucn trace <handle> --direction=callers --to=entrypoints` |
| Assess direct or Git-diff impact | `ucn impact [handle]` |
| Select direct or transitive tests | `ucn tests <handle> [--depth=N]` |
| Validate a symbol or pending diff | `ucn check [handle]` |
| Preview a refactor | `ucn plan <handle> --rename-to=X` |
| Can this be deleted? | `ucn plan <handle> --delete` |
| Inspect file dependencies | `ucn deps <file> [--direction=...]` |
| Find circular imports | `ucn deps --cycles` (project-wide; no file target) |
| Inspect public surface | `ucn api [file]` |
| Review entry points or HTTP routes | `ucn entrypoints`; `ucn endpoints` |
| Generate review candidates | `ucn deadcode`; `ucn audit-async` |
| Resolve runtime frames | `ucn stacktrace <text>` |

## Read the evidence

Caller candidates in `show`, `impact`, `trace` and `check` carry evidence tiers:

- `CONFIRMED`: binding, receiver, import, or ownership evidence for the pinned target.
- `UNVERIFIED`: call syntax that may reach the target, with the reason identity could not be established. Review it before a breaking change. When same-name definitions compete, `show` lists their stable handles once above the sites.
- Excluded sites (another definition's caller, an incompatible receiver, an external package, an arity mismatch) are counted as other-target lines in `ACCOUNT`, each with its reason in JSON.

Caller, callee and trace views carry the applicable trust lines below, preserved through truncation. A source extraction, definition list or test-reference list does not provide a caller account; use `show` or `impact` when that account is needed.

- `ACCOUNT` partitions every line where the name occurs: confirmed, unverified, non-call (definition, import, reference, other text), other-target, unaccounted. In mixed-language repositories it also counts occurrences in unsupported-language source files.
- `CONTRACT` states what that partition covers. Semantic completeness is never claimed: aliases, generated code, reflection and runtime dispatch may exist.
- `WARNING` lists unreadable, unparsed or partially indexed files and unsupported-language occurrence sites with their line text, so nothing text search would show is hidden. `usages` and `tests` carry the same disclosure as a note.
- `FILTERED` means query options hid evidence. `CALLEE ACCOUNT` and `TREE ACCOUNT` do the same for callees and `trace` trees.

A field, constant, enum member or module value adds `VALUE ACCESS SITES` and a `VALUE ACCOUNT` to `impact`. Conditional value reexports and unresolved implementation owners stay visible for review. Its rename plan edits proven references by the language's own lookup and lists unresolved bindings for review.

Functions in a JavaScript/TypeScript declaration list have separate handles and extents, including inline HTML scripts. Neighboring module values retain their module scope. A Python construction keyword can name a field of a local dataclass or named tuple; an unresolved class binding remains a review item. Instance writes that wrap an inherited method remain indexed as fields. Later calls can still invoke that method through the wrapper, so callers and callees require review (`instance-attribute-wraps-method`); renames also review reads before the write. Qualified method values used in tests stay visible with their evidence tier.

Return-type flow follows imported aliases and declared field owners. An unresolved field hop or an unknown result on a known receiver cannot borrow an unrelated method's return annotation. Qualified methods remain visible even when their name is also a language builtin.

Rust chains follow the produced value through recorded field hops and proven standard lock guards. A trait impl on an external type cannot prove that `self.method()` or `Self::method(self)` calls itself: an unseen inherent method may win, so the call requires review. Struct constructions name the type declaration, never its impl block.

A property/getter/setter target adds `PROPERTY ACCESS SITES` to `impact` (reads and writes with access kind; receiver identity confirms, an unresolved receiver stays unverified). A type target (class, struct, interface, enum, trait, record, union, alias) adds `TYPE REFERENCE SITES`: every token naming the type outside its call sites (annotations, bases, casts, qualifiers, imports), decided by the language's own name lookup; constructions and static calls through the type stay in `CALL SITES`, and a `TYPE ACCOUNT` line partitions every name token (confirmed, unverified with a reason, excluded with a reason, at call sites, declaration). `DEPENDENCY SITES` counts each token once. Target-less `impact` and `check` diff the working tree against `HEAD` (`--staged` for the index), include untracked non-ignored source as whole-file additions, and put classes, interfaces, types and fields in declaration bands; a modified type or value is `REVIEW` (shape is not checked), and a deleted one is `BLOCKED` when an import still names it, otherwise `REVIEW`. Validate these changes with the language toolchain.

`tests` distinguishes calls and unverified calls from imports, references, strings and test-case matches. Those other match kinds are discovery hints, not confirmed call edges.

A test is a unit: its file, the suites around it, its name and its line, read from what the language's runner collects. `tests` puts a `[test]` row above the calls a test holds, counts tests per file, and prints the command for the file (`run:`); `--json` carries each unit with its own command (`units[].selector`). A test a class inherits is listed at the class that runs it (`inheritedFrom`). A command is printed only when the runner is proven (the test file imports the runner, or the nearest manifest names it) and its selection syntax is modeled: pytest, node:test, jest, vitest, mocha, go test, cargo test, dotnet test, Maven. Otherwise the unit is listed with `selectorWithheld` and the reason (`no-runner-evidence`, `runner-not-modeled`, `ambiguous-runner`, `name-not-literal`, `generated-cases`, `declared-indirectly`, `name-not-unique`, `path-not-unique`, `build-constraint`, `conditional-compilation`, `custom-targets`, `target-unknown`, `loader-unknown`). The command runs the unit; whether it passes, and anything the project's own configuration adds, is the runner's to say. Test-path files that declare no test (helpers, fixtures, shared setup) are listed as support and are never something to run. C, C++ and HTML tests are not read as units.

`check` selects tests for every changed symbol by its declaration, counts each test once (`Tests potentially affected: N in M files`) and prints the runner's command under `Run tests:`.

Numeric evidence values are ordinal ranking weights, not probabilities. An observed-text zero is not a semantic zero or safe-delete proof.

## In a shell

`--lines` and `--raw` make `ucn` compose like `grep -n`:

```bash
ucn find handleRequest --lines            # path:line:signature   # kind
ucn show handleRequest --lines            # callers as path:line:text; unverified ones end in "\t# unverified: <reason>"
ucn show handleRequest --lines --sections=callees
ucn usages handleRequest --lines          # every literal-name line; kinds tagged "# import" / "# definition" / "# reference"
ucn search 'retry(' --lines               # grep -n output, code-aware scope
ucn impact handleRequest --lines
ucn source handleRequest --raw            # the code and nothing else, ready for an exact-string edit
ucn source src/server.js:40-80 --raw
```

Records go to stdout; `ACCOUNT`/`CONTRACT`, notes and same-name disambiguation go to stderr as `# ` lines (MCP keeps them in the one text block; `--raw` appends its note as one trailing `# ` line there). `--lines` has no default row cap; explicit `--top`/`--limit` disclose what they omit; an explicit `--max-chars` fails before any output instead of truncating records. On `show --lines` caller or callee records, `grep -v '# unverified'` keeps the confirmed tier. `usages --lines` emits one record per source line and tags combined kinds; JSON keeps individual occurrences. `show --lines` accepts only the callers/callees sections (default callers); target-less `impact --lines` lists Git-diff callers with per-target accounting. `source --raw` extracts whole functions and large classes; `--max-lines` truncation is disclosed on stderr. Unusual path characters (backslash, tab, CR, LF) are escaped; use `--json` for exact filenames, and for `trace`/`tests` scripting. Closing the pipe with `head` is supported.

Exit codes: 0 success; 1 for an empty `--lines` listing, a blocking `check` (target-less `check` with `TRUST: BLOCKED`, or with `TRUST: REVIEW_REQUIRED` under `--strict`; `check <handle>` reporting a mismatch or an unverified call site), or a JSON command error (`meta.ok: false` plus `error`); 2 for a text-mode command error or a `check` that could not run. An exception inside UCN prints `Internal error: ...` on every surface (CLI JSON adds `meta.internalError: true`); it says nothing about the code, so rerun with a narrower target or report it.

File export queries report source-read and import-parser failures as errors. A failed query does not establish an empty public API.

## Surfaces, JSON and output budgets

CLI, MCP and interactive mode run the same 18 commands through one registry, the same handlers and the same formatters. CLI spells multiword commands with hyphens (`audit-async`), MCP uses snake case (`audit_async`) through one `ucn` tool. `--json` returns `{ meta, data }`: `meta.command` keeps the surface spelling and may add `canonicalCommand`, `meta.contract` carries the truth boundary, and public `file` paths are relative to `meta.pathBase`. Definition handles start at a decorator when present; `nameLine` is the declaration token's line.

Text output has a character budget on both CLI and MCP: 3K for broad sweeps (`repo`, `entrypoints`, `endpoints`, `deadcode`, `deps`, `check`, `audit-async`), 10K for every other command, 100K ceiling (`--max-chars=N` / `max_chars`; `--all` lifts caps where a command supports it). Room for every trust line is reserved before any body text. A truncated answer keeps its head, a notice with the full size and the limit, and the trust lines; `show` and `impact` keep a head of every tier with a `+N more` line each, so a long confirmed list never hides the unverified band. A budget too small for the trust lines withholds the answer and names the budget that would carry them (`answer withheld; 0 of 3 trust line(s) shown. Raise --max-chars to at least 498.`). Narrow with a handle, `--file`, `--in` or `--sections` before raising the budget.

## Index and discovery

Indexes live in a per-user, project-keyed cache outside the repository (`UCN_CACHE_DIR` overrides the root; `--no-cache` bypasses it; `--clear-cache` removes the project's cache; a `.ucn-cache` directory left in a project is migrated on first use). MCP keeps the process and index warm across calls. Concurrent cold starts share one build: the first process takes a build lock and the others wait for its cache (with `--verbose`, `Waiting for another ucn process building the index...` on stderr); a lock left by a dead process is broken automatically.

Discovery applies the project's `.gitignore` files (root and nested) with git's own matching rules; git-tracked files are indexed even when a rule matches them, and a failing `git ls-files` is disclosed as a partial index (`git-listing-failed` in `repo --sections=health` and in caller contracts), never a silently smaller one. Source UCN reads without analyzing (`*.min.js`, `*.bundle.js`, paths excluded in `.ucn.json`, files over the size limit, unsupported languages) is searched for each name: an answer lists such an occurrence and limits its claim to indexed source only when the name occurs there, and says nothing otherwise. A path that cannot be read degrades every caller account. `*.map` files are data, outside every claim. `--include-bundled` (MCP `include_bundled=true`) indexes the JavaScript bundles, respecting user exclusions and bypassing the shared cache. `.ucn.json` keys: `exclude` (not indexed, still searched per name), `outsideProject` (not part of the project; listed in `repo --sections=health`), `kind` (`"application"`: nothing outside the repository consumes its exports, so `deadcode` and `plan --delete` assess exported symbols), `maxFiles`, `maxDepth`, `maxFileSize`, `textScanBudgetBytes`, `aliases`, `includePaths`.

C/C++ uses `compile_commands.json` when present for header classification and include paths. Project C/C++ function-like macros and Rust `macro_rules!` invocations are expanded, and what they generate is indexed at the invocation (`[via macro NAME]`). This is portable AST analysis, not a compiler build: macros, templates, generated code, reflection and external dependency semantics can stay unverified, and no conditional branch is asserted as the one a build activates.

## Breaking-change protocol

1. Pin the exact definition with `find`.
2. Run `impact`; review every unverified, excluded, filtered, and warning entry.
3. Run `ucn trace <handle> --direction=callers` for transitive behavioral impact.
4. Run `ucn tests <handle> --depth=3`; treat paths without static test links as test-planning signals, not runtime coverage proof.
5. Make the change.
6. Run `check <handle>`, the relevant compiler/type checker, and selected tests.
7. Run target-less `check` to reconcile the repository diff.

## Deletion protocol

`deadcode` is a candidate generator, never deletion proof. Before deleting, inspect `usages`, `impact`, `entrypoints`, `api`, and `repo --sections=health --deep`, then corroborate with the compiler/type checker and tests. Members that reflection (exact names or literal-fragment patterns), computed dispatch, runtime protocols (Python dunders, Java serialization callbacks, C# pattern members, JS `toJSON`/`then`), unknown decorators, event-handler assignment, an outside base class, or macro expansion may reach are withheld or warned; the `deadcode` notes in the command reference list them. Never delete solely from `deadcode` or an observed-text-zero result.

## Efficient use

- Prefer handles over plain names. Use `--class-name` or `--file` only when a handle is unavailable.
- Use `--sections` to request only the `show` or `repo` evidence needed.
- Use `--expand-unverified` only when deliberately exploring possible caller chains; those descendants remain possible, not confirmed.
- Use `--all` only when that command's output reports a supported cap; otherwise narrow the query or raise `--max-chars`.
- Use `search` or ordinary repository search for text, filenames, configuration, and unsupported syntax.

## References

- [references/commands.md](references/commands.md): every command, flag and default, exit codes, and per-command notes (`find` activity counts, `usages` inventory, `plan` rename closure, `endpoints` matching, `deadcode` withholding, `audit-async` findings, `deps --cycles`).
- [references/trust-contract.md](references/trust-contract.md): evidence classes, trust lines, account fields, provenance, truncation metadata, and a machine policy for automation that gates changes on UCN output.
- [references/resolution-rules.md](references/resolution-rules.md): how UCN decides identity per language (what confirms, what stays unverified with which reason, what is excluded).
