# Changelog

One section per released version, written from the commit subjects by `scripts/changelog.js` when the version is cut.

## 5.6.0 - 2026-11-14

### Features

- one parameter table writes the MCP schema, the CLI parser and the engine's refusals and defaults, a line listing under a budget keeps the rows that fit, and each version gets its notes from the commits (9dd9646)
- one model of a test, and the command that runs it only where the runner is proven (3adc8e4)
- check answers by what a change did, and --staged reads the git index (a86c449)
- plan --delete answers whether a declaration can be deleted (69adaf6)
- one deletion rule for the audit and for a single declaration (eda1e6e)

### Fixes

- bind repo summaries to saved state and preserve reflection syntax (7025e00)
- preserve bounded surface contracts and release version identity (0032bda)
- preserve constructor uncertainty and complete unverified output (78efe1b)
- a constructed receiver has the class its name denotes where it is written, every unverified list takes its rows from --top and --all, and each unverified reason says how often it was a real call (93f74b9)
- find reference-only tests and honor inherited JUnit runners (d7efdc4)
- a type inside generic types is the nesting it is written in, a method's modifiers do to its mark what each framework says, and what a test executes is test code whatever its file is called (c666151)
- a parameter type and a base are what their names denote where they are written, a test a method may have replaced says so, and two inherited tests of one name are two (5c1ea4e)
- a method of the same name with other parameters is another method, and each runner says what an override does to an inherited test (c810e87)
- a declaration is kept apart from its state, a class has what its lookup order finds first, and a table runs a test only through a row that does (7b32ad2)
- an unknown switch is not an absent one, a configuration is read only as one written-out object, and a count says when tests are missing from it (3d445ca)
- a test is what its names hold after every write, its body any expression, and its command what the runner's own configuration leaves (9d41a4e)
- a test's marks and names are read as syntax, in the scope of the call, by each runner's own rule (48485f8)
- a test is one declaration, runs where its class is, and is the runner's by binding (35e8339)
- a suppression belongs to the call that was measured, and the last file pragma decides (0b0775c)
- check reads a suppression as the checker does, holds a constructor to its statics, and keeps nothing between checks (ab067d5)
- check claims a break only where the toolchain looks, and ready only where nothing can hold the change (ef25de7)
- check reads what ends a path, a type's shape and the whole git index (6060e66)
- contract shapes the deletion verdict cleared, judged by the compilers (fc2ad44)
- a member a project contract requires is not dead (db52388)
- bound the site sample and let a readable-again file be searched again (979c4be)
- close four gaps in the per-name completeness model (c15e395)
- make completeness a claim about one name, not about the repository (8f7a8d4)

### Performance

- repo reads its HOT ranking and its eval and reflection counts from the index instead of recomputing them, and a chain of reflective accesses records every access (c06afe0)

### Refactoring

- one count of what there is to review (b56a49b)

### Documentation

- the README states the test-unit matrix result under the matrix's rules for skipped and conditional tests and each runner's selection scope (1855204)
- the README reports the November 14 release dry run and the three toolchain matrices, states the live partition of the ripgrep example, and the skill and tool description name the per-test commands and the deletion assessment (1d1d514)

### Tests

- reject altered or bypassed release gate commands (d1edfca)
- the release-gate guard reads each job's steps and time limit for every planned runner, so a partial enrolment of the matrices and the outcome gate fails and a complete one passes (47fa591)
- a declaration whose whole file is gone is assessed by what still names it (6ff794d)

### Evaluation

- a query class under one second blocks a release only above both 20% and 100 ms (71a00ba)
- pin an application with vendored bundles on the scheduled board (7d793b0)
- score outcome tasks only where the judge looks, pin exceptions exactly (bfc1188)
- measure whether answers can be acted on (f349427)

### Maintenance

- the release gate runs the three toolchain matrices and the outcome gate, in the publish job and in the pre-tag dry run, with the toolchains they were qualified with (e35c42c)
- the test-unit matrix runs every case without a marker of continuous integration, so a runner on GitHub Actions accepts what it accepts on a developer's machine (de29521)
- the deletion, check and test-unit matrices run in the Eval workflow on a runner of their own, and each report names the toolchain versions that judged (e2d520b)

## 5.5.3 - 2026-11-09

### Fixes

- harden HTTP detection and reflective dead-code handling (0ceefbe)

### Tests

- allow small latency changes while guarding second-scale regressions (7f0f044)

## 5.5.2 - 2026-11-06

### Fixes

- reuse constructor aliases until the index changes (cceec7f)
- resolve C++ conversions from qualified type evidence (5f419f8)
- preserve integer zero in pointer overload checks (df83156)
- cache implicit conversion owners for each build (c390347)
- keep alias pointees uncertain in overload checks (5490e69)
- surface import and export extraction failures (a9debca)
- require proof when overloads need user-defined conversions (6aaacc5)
- retain template calls in ambiguous direct initializers (d25fbde)
- preserve overload review for constructed enclosing types (3e1cd42)
- keep external method review stable across target pins (966cf29)
- dispatch method precedence and field dereference through traits (43c2d8a)
- retain possible calls through wrapped instance methods (3f217d3)
- preserve Python base order and receiver bindings (c0a36ed)
- preserve definition pins in composed test queries (f342565)
- resolve produced Rust receivers and external method uncertainty (35df447)
- preserve producer ownership and instance writes (4d8c1f3)
- preserve declarator scopes and local construction owners (631957a)
- preserve value owners and interface dispatch uncertainty (573c618)
- preserve C# construction identity and canonical Roslyn project references (fe5f23c)
- read a file's indexed language whatever the process directory; perf: build-time dispatch inventory, byte-bounded trees, type-query record index (c75685b)
- own-class constructions, one-language constructor identity, import-chased owners and constraint-aware C# overloads (c88b8c9)
- caller answers independent of index history, loaded symbols in build key order (79b3730)
- value accesses by what each token reads, slot accesses tiered like callers (1b17cdb)
- index instance attributes and nested members, bind C# receivers and partial constructors, agree callers and callees on overloads (cf4eeb1)
- type references for every type, validation that agrees with the tier, overloads decided by argument evidence (291387b)
- resolve C/C++ names, declarations and receivers by the languages' own rules (e62d774)
- close Java/C# rename slots over every holder and decide alternatives by evidence (48790ac)
- resolve Go names by package clause, build configuration and method expression (9507b71)
- resolve Python names by their own module and scope (418de8d)
- resolve JS/TS names by their own scope and import (4ebe69e)
- resolve Rust names by item scope and namespace (f057175)
- keep class edges beside constructor bodies (2976d29)
- rename value members by each language's name lookup (12cb8e3)
- bind constructor delegation and configuration renames by owner (4f8dfe0)
- bind construction calls to constructor declarations (fe4183e)
- resolve constructor rename handles to declaring types (9f39cfd)
- rename value references by lexical owner (5b7259c)
- preserve primitive receiver identity through return flow (8bdc1e2)
- preserve conditional using bindings in C++ (2773d7a)
- preserve lexical member lookup in local callables (29460e1)
- preserve generic call and method value identities (e36f24f)
- resolve implicit property references by lexical owner (d7a3d27)
- retain value references beside their declarations (b8d89c7)
- retain distinct same-line calls across renamed method slots (211cd5e)

### Performance

- narrow scope evidence in overload proofs (35a8a77)
- reuse map facades within proof views (caae55a)
- compare Java Unicode changes by lexical region (4c338ed)
- skip unrelated constructor checks in occurrence accounts (cb19ab2)
- omit unused receiver facts from occurrence accounts (926ae3d)
- count brief members from the indexed file (fc2269f)
- reuse construction alias closures within a command (a3e032f)
- skip redundant macro recovery in occurrence accounts (342c285)
- share lazy field accessors across proof views (0ef3fad)
- avoid splitting text for occurrence accounts (db5e00a)
- retain raw C++ base syntax for construction lookups (0ae0687)
- share producer method lookup across argument shapes (abb14b0)
- skip disproven C++ construction proof captures (be1ce6a)
- share type-group inputs across proof captures (98d1b25)
- reuse known traversal parents in cached node facts (d41d94a)
- share C++ construction and include lookup evidence (4d4f7c9)
- share Java producer return proofs across witnesses (fd2b3a7)
- share command source reads and streamline witness copies (0395e97)
- query-board costs after the correctness batch, answers unchanged (d7d4fe2)
- share witness facts and record project facts once (dd7c8f7)

### Documentation

- refresh measured conversion accuracy (2d94e5d)
- refresh measured release accuracy (edfc6df)
- refresh accuracy results for the native compiler board (a51fb48)
- drop local performance notes from the README (a9e378c)
- clarify construction records and current validation (16783be)
- align release evidence and agent guidance (d7aca18)
- command reference, resolution rules and trust contract match behavior (da7cf96)

### Tests

- expose indexed facts in re-export failure tests (688e171)
- canonicalize temporary paths in compiler mocks (36e5922)

### Evaluation

- run independent pre-tag checks on parallel runners (1d8b0ce)
- retain constructor declaration positions in class references (eff207d)
- classify macro calls from the expanded compiler tree (c9bee7a)
- graduate repaired Python holdout and refill the pool (9a473c4)
- compare newly indexed constructor declarations fairly (8e7835d)
- compare impact capabilities against their first working revisions (5bb945f)
- graduate repaired holdouts and retain independent weekly reports (afd7440)
- graduate tuning repositories with reproducible compiler inputs (693574c)
- query-class performance board against the last release, graduated fresh repos, new holdout pool (7621ae9)
- value-member arm, named handles, whole-solution Roslyn, truthful jdtls/clangd projections, oracle-blind deadcode verdicts (ddca9a0)

## 5.5.1 - 2026-10-15

### Performance

- choose Rust macro-expansion groups from build records, keep per-record answers across orientation (2a0fc2a)
- derive Rust macro-expansion calls by groups of units on demand (b2d8fa0)

### Documentation

- state the README's accounting and determinism guarantees (eb1ff6f)

### Evaluation

- classify unscored oracle edges by the oracle's own projection (e01f789)

## 5.5.0 - 2026-10-04

### Fixes

- match a non-segment ** in .gitignore path rules as git 2.52+ does (2e4c059)
- share the local-shadow rule between callers and callees, allow check <symbol> --base, cut Rust query costs (5b1e926)
- list engine-attributed test sites, resolve Python inherited fields and fixtures, audit typed async member calls (cc39e36)
- resolve deref wrappers, macro item bodies, C++ name hiding and C#/Java scoping residuals (e864722)
- resolve module-attribute type references, Go import names and C# target-typed arguments (2acef1a)
- resolve Go dot imports, package variables and Rust method probing (471b1a2)
- model Python configuration alternatives, module values and string-annotation calls (97eaed2)
- check stored coroutines at their uses and resolve async producers by import identity (a585e27)
- respect lexical ownership of imported function aliases (c638890)
- resolve local class members by lexical identity (99e7a21)
- resolve inherited calls through imported Python modules (0fca542)
- preserve type renames through aliases and module paths (865aa20)
- caller identity, complete renames, endpoints and faster builds across languages (3d098fa)

### Performance

- avoid repeated C-family recovery and binding scans (5bf8d1f)

### Documentation

- restructure the agent skill for accuracy and fast loading (c4d0f93)
- refresh release evaluation results and align check/base wording (b46bc68)

### Maintenance

- keep local agent skills out of the package and the repo (4507206)

## 5.4.2 - 2026-09-20

### Fixes

- budget MCP notes and clarify review output (2c27e1c)

## 5.4.1 - 2026-09-20

### Fixes

- distinguish declaration changes from member body edits (18638e2)

### Other

- Fix UCN 5.4.0 audit findings across diff checks and output (6bbf57e)

## 5.4.0 - 2026-09-19

### Other

- Fix fresh audit findings in references, filters and async analysis (b763ac8)

## 5.3.8 - 2026-09-18

### Other

- Fix second-pass audit findings in API and structural search (26d6a39)

## 5.3.7 - 2026-09-18

### Other

- usages keeps no default row cap: the escape-hatch listing must show every site (release command-surface gate) (3659fad)
- Fix audit regressions in query limits and source coverage (30b3a69)

## 5.3.6 - 2026-09-13

### Fixes

- Rust same-name `use ... as` renames pair with their own module in both directions (78dc6c0)

## 5.3.5 - 2026-09-13

### Fixes

- recover receiver coverage with validated evidence (42773b3)
- validated receiver provenance; single-owner demoted to visible; per-rule oracle tables (6c3a2f9)

## 5.3.4 - 2026-09-07

### Fixes

- cross-process build lock ends the cold-cache stampede; prune spares live locks (057f3e2)

## 5.3.3 - 2026-09-07

### Fixes

- $ boundary, scope-granular imports, JSX attrs; Rust alias + Java/C# qualifier identity (87ff714)

## 5.3.2 - 2026-09-07

### Fixes

- Python alias pairing, endpoints client evidence + uncertain band, usages text lines, Unicode identifier boundaries (e58814a)

## 5.3.1 - 2026-09-06

### Fixes

- Python scope-name memo, impact type-reference band, untracked files in check, hub/endpoint disclosure (051c370)

## 5.3.0 - 2026-09-06

### Fixes

- 5.3.0 batch (b3fb8cc)
- README example is two ucn commands; --lines records drop indentation (a9e33e7)
- README shows the shell session; show --lines lists callers only by default (bd119c8)
- --lines lists the whole band with text; fold signatures; structural search; raw keeps its note (800cc4d)
- shell-native output modes — grep-shaped --lines and code-only --raw (3b39ed2)
- bound orientation HOT refinement; share findCallers derivations per operation (7928d0d)
- import-binding identity, deferred-edge physics, complete cycle enumeration (f1a4844)

### Documentation

- README example uses the bare symbol name (595689f)

## 5.2.2 - 2026-09-03

### Fixes

- isolate Go tuple return flow (2b8b5c1)
- resolve cross-file Go index flow (85fc44d)
- type Go indexed container values (5a06f2c)
- capture Go var return flow (19935f2)
- preserve Go closure return flow (2a35efc)
- prefer compiler flow over receiver guesses (849ee44)
- narrow nullable branch joins (e7dd3e3)
- recognize private Python constructors (042ac99)
- resolve union-narrowed field flow (a3db0d3)
- resolve lifecycle field constructors (e6c0b45)
- resolve forward module receiver types (14bb1df)
- preserve assigned indexed receiver flow (af6e9c6)
- resolve Python indexed receiver flow (3f0eba6)
- resolve Python dotted module calls (11fd0a6)
- resolve Python class factory flow (cc5fdf4)
- resolve Python class value aliases (d2791f2)
- resolve Python factory field flow (90d220a)
- unwrap Python field contracts (8bea85b)
- preserve generic field return flow (170621f)
- infer arrow factory result flow (6fad5de)
- preserve overload return contracts (5af11cb)
- type namespace exported values (d195481)
- resolve namespace spread ownership (3ac55dd)
- preserve static factory forwarding (9a52519)
- preserve assigned structural chain flow (684a95e)
- preserve overloaded factory flow identity (23d5721)
- improve return-flow accuracy and reuse (6767ef7)
- improve barrel flow accuracy and query caching (60a3e3f)
- improve caller accuracy and query performance (5d67502)

## 5.2.1 - 2026-08-25

### Fixes

- accessor impact dependencies, reflection liveness, deferred cycles, plan text review (f115788)

## 5.2.0 - 2026-08-24

### Fixes

- make C++ call identity compiler-exact (d91db34)
- make C# receiver and overload identity exact (4b965d5)
- reject shadowed Python constructor guesses (19357cc)
- make rename plans compiler-exact (f6b505a)
- close Go interface rename slots (5e22ecf)
- close module-qualified rename references (a2edb30)
- fresh/holdout engine batch — receiver-name guess demotion, scope-correct local subclasses, callee bare-call ownership, plan rename closure, Go range typing (2afbf35)
- overload-ambiguous promotion — C++/Java static-shape families (f250068)
- Go composite-literal receivers + value-position method references (7b656c1)
- memoize universal null results in the chained-receiver fold + reuse plan's ground set (3e5184e)
- trait-declaration pins + trait-slot rename closure (661809b)
- contract-arm non-slot deferral + method-value references (64e6a0b)
- structural module-receiver physics (flask outcome-eval families) (d41de4b)
- plan --rename-to closes the rename set (outcome-eval-measured) (0630a68)

### Documentation

- refresh v5.2 release evidence and agent guidance (c962018)

### Tests

- isolate MCP protocol fixtures from repository load (45e8282)

### Evaluation

- task-outcome instrument (paired toolchain-judged tasks) + unverified-tier census (aa43fd4)

### Other

- harden MCP supply chain and stdio transport (f925938)
- outcome-eval: oracle-enumerated targets, multi-seed boards, javac judge (d1fcc60)
- outcome-eval hardening: pool graduation, tri-state delete verdict, outcome gate (386f8bf)

## 5.1.1 - 2026-08-18

### Fixes

- compile-time-dispatch stays report-only in the hard floors (564e1d1)

## 5.1.0 - 2026-08-18

### Fixes

- CJS reassignment exclusions and oracle gate restoration (c7b3ed0)

### Other

- Release UCN 5.1.0 reliability improvements (d7259af)
- Preserve callable factory alias return types (5385162)
- Preserve ESM namespace member ownership (94040cd)
- Improve CommonJS ownership and ambiguity guidance (6cdcc2e)
- Harden oracle gates and semantic identity (1d5b24f)

## 5.0.6 - 2026-08-13

### Maintenance

- harden mcp-publisher install against transient/upstream download failures (6575499)

## 5.0.5 - 2026-08-13

### Fixes

- block file disclosure outside project root in stacktrace (\#285) (f4303c8)

## 5.0.4 - 2026-08-12

### Fixes

- keep truncated MCP payload in the text block, retier usages/tests (\#284) (c53f5c8)

## 5.0.3 - 2026-08-12

### Fixes

- keyword-binding validation, router mount prefixes, surface trust (\#281-\#283) (56d16ab)

## 5.0.2 - 2026-08-12

### Fixes

- keep server.json inside MCP registry validation limits (ca4bde9)

## 5.0.1 - 2026-08-11

### Features

- harden UCN v5 prerelease reliability (a26919d)
- complete UCN v5 release-grade engine (d28e1ae)
- gate cross-command disagreements (de228f0)
- harden v5 agent workflows (d3008e1)
- release UCN v5 (c3700ae)

### Fixes

- pin Roslyn helper SDK selection to the 9.x band (32c2ad3)
- complete the C++ operator name canon engine+oracle; surface Roslyn build errors (ef13026)
- per-host-class throughput baselines; floors stay a reference-class claim (3d84936)
- state throughput budgets on reference hardware via a frozen host probe (ba2e7cb)
- make v5 performance evidence release-blocking (d3743aa)
- close final v5 release gaps (ac840b6)
- close v5 release-readiness audit (e84f112)
- mixed-language account contract + v4 command migration guidance (5a57266)
- v5 release-audit repair — 16 findings + verified remainder (9c25faa)
- close v5 agent trust gaps (32596ea)
- harden v5 agent trust surface (5b24314)
- align semantic commands and grep handoff (58eab11)

### Documentation

- absolute demo image URL so npm renders it (56d792d)
- link CI eval workflow instead of local reports (d4481aa)
- update README for v5 (072d5a8)
- restore the README visual product story (97b45da)
- make the README value-first (bd27979)
