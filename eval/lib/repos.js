/**
 * eval/lib/repos.js - Pinned-commit clone harness for eval runs.
 *
 * Unlike test/real-repo-stress-analysis.js (shallow clone of HEAD), eval runs
 * must be reproducible: every repo is pinned to a commit SHA so metric drift
 * means UCN changed, not the repo. SHAs pinned 2026-06-11 (grpc-go/cursive
 * 2026-06-12 — dispatch-heavy second repos per nominal language, so precision
 * numbers can't look good by dispatch-light style accident).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EVAL_TEMP_DIR = path.join(os.tmpdir(), 'ucn-eval-repos');

const REPOS = [
    {
        name: 'zod',
        url: 'https://github.com/colinhacks/zod',
        commit: '912f0f51b0ced654d0069741e7160834dca742ee',
        language: 'typescript',
        targetCandidates: ['packages/zod/src', 'src'],
    },
    {
        name: 'preact-signals',
        url: 'https://github.com/preactjs/signals',
        commit: 'e0ce9fdf92df7f0ece2c89d44554c39f36dc6882',
        language: 'typescript',
        targetCandidates: ['packages/core/src'],
        performanceWorkload: { files: 2, lines: 4196 },
    },
    {
        // Plain JavaScript (no annotations, no tsconfig): CJS, prototype
        // augmentation, property-assigned functions. TS numbers do not
        // transfer to annotation-free receiver physics — this is the
        // measurement for it. Pinned @ v5.2.1.
        //
        // KNOWN ORACLE-BLIND FAMILY (F1, decision 2026-06-12: documented, not
        // sampled out): ts-morph with checkJs:false cannot resolve references
        // to property-assigned CJS methods (`proto.use = function use() {}` —
        // `app.use(...)` call sites return no refs), so true UCN edges on
        // those symbols count as misses and express's tier-1 UNDERSTATES real
        // precision. Same family: the zeroTrust n=2 artifact is the CJS
        // default-export rename (`module.exports = createApplication` →
        // `express()` calls are beyond-text). Precedents: gson's jdtls
        // var-lambda blindness, cursive's cfg(feature) macro blindness.
        name: 'express',
        url: 'https://github.com/expressjs/express',
        commit: 'dbac741a49a5a64336b70c06e85c2e2706e36336',
        language: 'javascript',
        targetCandidates: ['.'],
    },
    {
        name: 'httpx',
        url: 'https://github.com/encode/httpx',
        commit: 'b5addb64f0161ff6bfe94c124ef76f6a1fba5254',
        language: 'python',
        targetCandidates: ['httpx'],
        performanceWorkload: { files: 61, lines: 17807 },
    },
    {
        // Dispatch-heavy second Python repo (the grpc-go/cursive analog):
        // console-protocol rendering — dozens of types share render/measure
        // method names, called through protocol-typed receivers. Style-
        // different from httpx (deep class hierarchies vs flat clients).
        // Pinned @ v15.0.0.
        name: 'rich',
        url: 'https://github.com/Textualize/rich',
        commit: '6ac483cbea39cab124dfd3483bba70ffafb71050',
        language: 'python',
        targetCandidates: ['rich'],
    },
    {
        name: 'cobra',
        url: 'https://github.com/spf13/cobra',
        commit: 'ad460ea8f249db69c943a365fb84f3a59042d54e',
        language: 'go',
        targetCandidates: ['.'],
        performanceWorkload: { files: 36, lines: 16765 },
    },
    {
        // Dispatch-heavy Go: interface-registry dispatch (resource-type
        // registries, balancer/resolver Builders, httpfilter registries).
        // Target is internal/xds ONLY — grpc-go has 10 nested Go modules
        // (examples/, interop/xds/, ...) that gopls rooted at the main module
        // does not load; internal/xds is nested-module-free, so the oracle
        // universe covers UCN's whole indexed universe.
        name: 'grpc-go',
        url: 'https://github.com/grpc/grpc-go',
        commit: '9a130aad0775eec6d573e1c83a558f9039073b9c',
        language: 'go',
        targetCandidates: ['internal/xds'],
    },
    {
        name: 'ripgrep',
        url: 'https://github.com/BurntSushi/ripgrep',
        commit: '82313cf95849bfe425109ad9506a52154879b1b1',
        language: 'rust',
        targetCandidates: ['crates/core'],
        performanceWorkload: { files: 100, lines: 52338 },
    },
    {
        // Dispatch-heavy Rust: Box<dyn View> registry — dozens of View/
        // ViewWrapper impls called through trait objects (the TypeAdapter
        // shape in Rust). Whole workspace (core + wrapper crate + examples):
        // builder-API callers live in cursive/ and examples/, so a core-only
        // target leaves real callers outside the measured universe
        // (zero-trust artifact — measured 2026-06-12).
        name: 'cursive',
        url: 'https://github.com/gyscos/cursive',
        commit: 'b41c5ad050c85c0f37095b439c31f223c7ff4759',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        name: 'gson',
        url: 'https://github.com/google/gson',
        commit: '004e7a4949e08b430e3c8996998ee5a17ff9423a',
        language: 'java',
        targetCandidates: ['gson/src/main/java'],
    },
    {
        // Builder-chain-heavy Rust (graduated from FRESH_POOL 2026-07-03 —
        // used to tune fix #258, so it joins the pinned board per the
        // fresh-repo protocol). Command::new("x").author(a).arg(b).arg(c)
        // chains dominate the caller population: before the chained-receiver
        // fold, Command::arg had 1686 method-ambiguous callers (1524
        // oracle-true); the fold + workspace crate-name imports confirm them.
        // Whole workspace (clap_builder + clap_bench + tests + examples).
        name: 'clap',
        url: 'https://github.com/clap-rs/clap',
        commit: 'd3e59a9ab214910b9dad02921b7ef42c6400de9b',
        language: 'rust',
        targetCandidates: ['.'],
        performanceWorkload: { files: 330, lines: 83356 },
    },
    {
        // Handler-callback-heavy TypeScript (graduated from FRESH_POOL
        // 2026-07-03 — used to tune fix #265, so it joins the pinned board
        // per the fresh-repo protocol). Motivated the field-hop hardening
        // (this.store.keys() on a Map-aliased field confirmed 'exact-binding'
        // against MockCache.keys), the Object.prototype universal-name rule
        // (183 untyped x.toString() single-owner confirms, 6 oracle-false),
        // and the getter-hop extension (Context.req). Residual: the big
        // c.req.param() band has UNANNOTATED callback roots — typing them
        // needs tsc-grade generic inference, not grep-reliability evidence;
        // stays honestly visible.
        name: 'hono',
        url: 'https://github.com/honojs/hono',
        commit: '82b321b5b0e7a57cdaab45f2f90671ec0737795b',
        language: 'typescript',
        targetCandidates: ['.'],
    },
    {
        // Overload-heavy TypeScript (graduated from FRESH_POOL 2026-07-03 —
        // used to tune fix #265). Motivated the overload-signature identity
        // (useStore's only true caller excluded other-definition under the
        // implementation pin — a false ZERO-caller answer, zeroTrust 33.3%)
        // and the JSX functionReference labeling (<App />, <Counter />).
        name: 'zustand',
        url: 'https://github.com/pmndrs/zustand',
        commit: 'a1f685ca744e56a982b1c5029620e0925c3ee996',
        language: 'typescript',
        targetCandidates: ['.'],
    },
    {
        // Config-heavy Go (graduated from FRESH_POOL 2026-07-03 — used to
        // tune fix #266). Motivated the caller-side member-reference
        // exclusion (delete(v.override, alias) on Viper's map field claimed
        // the test-file function 'override') and the New*-prefix guess
        // discipline (registry := NewCodecRegistry() guessed the INTERFACE
        // 'CodecRegistry' against the *DefaultCodecRegistry annotation —
        // a false zero-caller answer for RegisterCodec).
        name: 'viper',
        url: 'https://github.com/spf13/viper',
        commit: '528f7416c4b56a4948673984b190bf8713f0c3c4',
        language: 'go',
        targetCandidates: ['.'],
        performanceWorkload: { files: 33, lines: 7194 },
    },
    {
        // Router-interface Go (graduated from FRESH_POOL 2026-07-03 — used
        // to tune fix #268). Motivated the callee-side external-identity
        // families: qualified field types (mx.pool.Get on *sync.Pool,
        // mx.handler.ServeHTTP on http.Handler bare-name-matched an
        // _examples type), non-method package-qualified records
        // (context.WithValue confirmed the project's only WithValue), and
        // chained external returns (m.NotFoundHandler().ServeHTTP self-edge).
        // Known oracle blind spot: _examples/ is a separate underscore-dir
        // module the Go toolchain ignores — gopls cannot see its true
        // NewRouter callers (~6 caller-precision FPs are this, not engine).
        name: 'chi',
        url: 'https://github.com/go-chi/chi',
        commit: 'd7b767bcbea51e486bdc9fd06d25136767ec14b5',
        language: 'go',
        targetCandidates: ['.'],
    },
    {
        // Overload-heavy Java builder API (graduated from FRESH_POOL
        // 2026-07-03 — used to tune fix #268). Motivated the Java bare
        // same-class overload family (the Builder.defaultValue delegation
        // excluded other-definition — a false zero-caller answer) and the
        // inherited-sibling overload discipline (ClassName.annotated(List)
        // vs TypeName's final annotated(AnnotationSpec...)).
        name: 'javapoet',
        url: 'https://github.com/square/javapoet',
        commit: 'b9017a9503b76e11b4ad4c1a9f050e2d29112cb0',
        language: 'java',
        targetCandidates: ['javapoet/src/main/java', 'src/main/java'],
        performanceWorkload: { files: 39, lines: 12212 },
    },
    {
        // State-machine-dispatch Java (graduated from FRESH_POOL 2026-07-03
        // — used to tune fix #268). Motivated the callee-side same-class
        // overload arity selection (all 71 tb.process(...) sites confirmed
        // to the 1-arg overload) and the eval's super-constructor
        // by-construction verification (LeafNode's subclass super(data)
        // sites — jdtls emits no type reference at those lines). Its first
        // deadcode gate run motivated the eval's doc-ref classification
        // (jdtls resolves Javadoc @see links as references — fix #269).
        name: 'jsoup',
        url: 'https://github.com/jhy/jsoup',
        commit: 'd8c49e5ec72a08ca1ac4e08740e70dc0f47ad911',
        language: 'java',
        targetCandidates: ['src/main/java'],
    },
    {
        // PEP-517 src-layout Python (graduated from FRESH_POOL 2026-07-03 —
        // used to tune fix #269). Motivated src-layout import resolution:
        // `import click` from tests/ resolves src/click/__init__.py, and
        // src/* packages join the top-level never-exclude names — the
        // module-ownership machinery had judged the project's OWN package
        // provably external (two false zero-caller answers).
        name: 'click',
        url: 'https://github.com/pallets/click',
        commit: '16fc00e2f4a2717a521084f193709a6058afc693',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        // CJS prototype-idiom JavaScript (graduated from FRESH_POOL
        // 2026-07-03 — used to tune fix #269). Motivated the
        // property-assignment binding discipline (Reply.prototype.serialize
        // stole the module-scope binding from the free serialize below it)
        // and the renamed-destructure module pairing ({ validate:
        // validateSchema } = require('./validation') scope-confirmed
        // hooks.js's unrelated validate). Known honest residual:
        // conditional self-coercion retyping (ContentType.toString —
        // classified, deferred).
        name: 'fastify',
        url: 'https://github.com/fastify/fastify',
        commit: '44e4c970fe379eedf954877c9f9634bd2e95a2b8',
        language: 'javascript',
        targetCandidates: ['.'],
    },
    {
        // Mature, overload- and inheritance-heavy C# library. Roslyn builds
        // one semantic compilation over the production source tree, so this
        // board independently checks C# caller identity, overload selection,
        // constructors/type usages, and cross-file resolution without
        // relying on UCN's tree-sitter parser.
        name: 'newtonsoft-json',
        url: 'https://github.com/JamesNK/Newtonsoft.Json',
        commit: '4f73e74372445108d2c1bda37b36e6f5e43402e0',
        language: 'csharp',
        targetCandidates: ['Src/Newtonsoft.Json'],
        performanceWorkload: { files: 240, lines: 69132 },
    },
    {
        // Widely embedded ANSI C library with public-header declarations,
        // macro configuration, recursive parsing, callbacks, and allocator
        // indirection. clangd supplies the compiler-semantic release oracle.
        name: 'cjson',
        url: 'https://github.com/DaveGamble/cJSON',
        commit: 'c859b25da02955fef659d658b8f324b5cde87be3',
        language: 'c',
        targetCandidates: ['.'],
        clangFlags: ['-DCJSON_HIDE_SYMBOLS=0'],
        // Git-tracked files intentionally outrank built-in artifact ignores.
        // This includes 46 C files under the vendored Unity tree; pin the
        // resulting workload so discovery changes cannot silently recalibrate
        // performance evidence.
        performanceWorkload: { files: 101, lines: 22652 },
        // Reference-host throughput, from the full release board (see the
        // performanceBaseline note on fmt below).
        performanceBaseline: { locPerSec: 22063.733, locPerCpuSec: 6525.627 },
        // Per-host-class pins (see the fmt note below for the model).
        performanceBaselineByHost: {
            'linux-x64': { locPerSec: 10352.722, locPerCpuSec: 3244.233 },
        },
        // cJSON vendors the Unity test framework (including generated
        // expectdata and Unity's own examples). Semantic/deadcode oracle rows
        // measure the cJSON library rather than a second unrelated C
        // framework, so those evaluators remove Unity from both universes.
        // The performance board intentionally keeps every tracked source and
        // pins that larger workload above.
        oracleExclude: ['tests/unity'],
    },
    {
        // Template-heavy modern C++ library spanning headers and source
        // implementations. This exercises overloads, constructors, methods,
        // namespaces, macros, and header/source declaration identity.
        name: 'fmt',
        url: 'https://github.com/fmtlib/fmt',
        commit: 'e424e3f2e607da02742f73db84873b8084fc714c',
        language: 'cpp',
        targetCandidates: ['.'],
        performanceWorkload: { files: 75, lines: 69630 },
        // Demonstrated healthy throughput on REFERENCE hardware: best of the
        // isolated cold-build samples, host-normalized. The gate allows a 13%
        // loss against this (minCpuThroughputRatio) before failing.
        //
        // Pin from a full `--release` board on a quiet reference machine, and
        // ALWAYS from host-normalized values -- an un-normalized baseline
        // records the machine's mood rather than the engine's speed. Measured
        // 2026-08-11: healthy re-runs land at 0.975-1.00 of these, while
        // disabling the C-family recovery bound lands at 0.76, so the 0.87
        // floor sits with ~12% clearance on both sides. Re-pin only alongside
        // a deliberate, explained speed change; lowering a baseline to clear a
        // red gate makes the regression the new normal.
        performanceBaseline: { locPerSec: 19341.363, locPerCpuSec: 5918.444 },
        // Per-host-class pins (fix #279). The probe factor bridges SKU
        // variation WITHIN a class but cannot bridge ACROSS classes: on
        // ubuntu-latest the probe reads 1.08-1.15 while the engine measures
        // 2.0-2.7x below reference (single-thread JavaScript cannot see
        // 4-workers-on-2-cores hyperthread contention or native parse
        // bandwidth), so each non-reference class carries its own pins and the
        // absolute floors go advisory there. Pinned from the two 2026-08-11
        // ubuntu runs (31510902344, 31510897360) as probe-normalized best
        // samples: the two runner SKUs disagreed by 11% raw and 3.4%
        // normalized, which is the probe doing its intra-class job. Same
        // discipline as above: normalized values, best isolated sample, never
        // re-pin to clear a red gate.
        performanceBaselineByHost: {
            'linux-x64': { locPerSec: 9346.428, locPerCpuSec: 2908.951 },
        },
        // fmt vendors GoogleTest under test/gtest and its test translation
        // units include "gmock/..." from that include root. Without this,
        // clangd treats TEST(...) and other macros as undeclared functions,
        // contaminating the oracle with synthetic source symbols.
        clangFlags: ['-Itest/gtest'],
        // The release board measures fmt itself, not the bundled GoogleTest
        // implementation. Keep the directory available as an include root so
        // clangd compiles fmt's tests faithfully, but never sample GTest's
        // declarations as target symbols.
        oracleExclude: ['test/gtest'],
    },
    {
        // Function-local test-subclass Python (graduated from FRESH_POOL
        // 2026-08-20 — used to tune fix #300C). Every test function defines
        // its own local `class C2Slots(C1Slots)` with DIFFERENT parents
        // sharing one name; motivated per-def extendsGraph startLine anchors
        // + the scope-correct first hop in structural identity and the
        // callee ancestor walk, plus the typed-project-receiver exemption in
        // the builtin-name filter (`c2.classmethod()`). Known honest
        // residual: `C2Slots = attr.s(...)(SimpleOrdinaryClass)` local
        // variable assignments type the receiver by constructor NAME
        // (classified, deferred).
        name: 'attrs',
        url: 'https://github.com/python-attrs/attrs',
        commit: '30fd617c45854a5555550c9a0bf921bc3ee28786',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        // Iterator-adaptor Rust with free-fn/trait-method name pairs
        // (graduated from FRESH_POOL 2026-08-20 — used to tune fixes
        // #300A/B/D). Motivated the cross-case receiver-name exclusion
        // demotion (test-file `struct Iter` poisoned every `iter` receiver),
        // the `mod powerset;` self-containment guard, and the callee-side
        // bare-call ownership + kind discipline (`use free::merge_join_by`
        // resolves the free fn; the trait wrapper's own body never
        // self-edges). Known honest residual: heavy method-ambiguous band on
        // `next`/`size_hint` (dozens of iterator impls — untyped receivers
        // stay visible by design).
        name: 'itertools',
        url: 'https://github.com/rust-itertools/itertools',
        commit: 'af6d17d3f4a963c087e81b327b957966e1169ff5',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        // Trait-dispatch-heavy Rust (graduated from FRESH_POOL 2026-09-24 -
        // used to tune fix #368): dozens of same-name iterator types, closure
        // parameters typed only by `F: Fn(Ctx)` bounds, `Self::Assoc` returns,
        // generic-bounded `self.base.split_at()` fields, range/vec receivers.
        // Known honest residual: blanket-impl members (`par_iter_mut` on
        // std collections) stay possible-dispatch.
        name: 'rayon',
        url: 'https://github.com/rayon-rs/rayon',
        commit: 'ee0a00bdb1ab039e178a215ad5712fb7fa58e58f',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        // Closure-heavy plain JavaScript (graduated from FRESH_POOL
        // 2026-10-30 - its fresh-arm callee recall drove fix #403): plugins
        // wrap prototype methods inside closures that call helpers declared
        // in the enclosing function (`max`/`min` -> `sortBy`, `localeData`
        // -> `getShort`), the shape behind the shared local-shadow rule.
        // Target is the whole repository: its callers live in test/. Known
        // oracle limit: calls through the package importing itself by name
        // (`import dayjs from 'dayjs'` in tests) resolve to the project
        // source in UCN and not in ts-morph.
        name: 'dayjs',
        url: 'https://github.com/iamkun/dayjs',
        commit: '436bde0bcded312781cbe45dc2b0ef079a36d8e3',
        language: 'javascript',
        targetCandidates: ['.'],
    },
    {
        // macro_rules!-heavy Rust (graduated from FRESH_POOL 2026-10-30 -
        // its fresh-arm coverage ratio drove the eval change of fix #406):
        // distribution impls generated by templates, a nested benches/
        // Cargo workspace, `simd_support` code active under all features.
        name: 'rand',
        url: 'https://github.com/rust-random/rand',
        commit: '9e7d328f60d6372ae22927f37d1a816fc980f25e',
        language: 'rust',
        targetCandidates: ['.'],
    },
    // Source families used for engine development belong on the reproducible
    // board. Both deadcode arms were checked before these graduations.
    {
        name: 'pino',
        url: 'https://github.com/pinojs/pino',
        commit: 'b29dbe97820630e7128e464c50263b427965ec99',
        language: 'javascript',
        targetCandidates: ['.'],
    },
    {
        name: 'tanstack-form',
        url: 'https://github.com/TanStack/form',
        commit: '2216fdedf0a5ff17e4ef8567e1321442639b96ca',
        language: 'typescript',
        targetCandidates: ['.'],
        // Workspace package exports name dist files. These are the source
        // entry points of the packages' builds.
        // Keep the clean checkout intact and give the compiler those inputs.
        tsPaths: {
            '@tanstack/angular-form': ['packages/angular-form/src/index.ts'],
            '@tanstack/form-core': ['packages/form-core/src/index.ts'],
            '@tanstack/form-devtools': ['packages/form-devtools/src/index.ts'],
            '@tanstack/lit-form': ['packages/lit-form/src/index.ts'],
            '@tanstack/preact-form': ['packages/preact-form/src/index.ts'],
            '@tanstack/react-form': ['packages/react-form/src/index.ts'],
            '@tanstack/react-form-devtools': ['packages/react-form-devtools/src/index.ts'],
            '@tanstack/react-form-nextjs': ['packages/react-form-nextjs/src/index.ts'],
            '@tanstack/react-form-remix': ['packages/react-form-remix/src/index.ts'],
            '@tanstack/react-form-start': ['packages/react-form-start/src/index.ts'],
            '@tanstack/solid-form': ['packages/solid-form/src/index.tsx'],
            '@tanstack/solid-form-devtools': ['packages/solid-form-devtools/src/index.ts'],
            '@tanstack/svelte-form': ['packages/svelte-form/src/index.ts'],
            '@tanstack/vue-form': ['packages/vue-form/src/index.ts'],
        },
    },
    {
        name: 'tqdm',
        url: 'https://github.com/tqdm/tqdm',
        commit: '9cf5a12b1f955468a17f0ba3c59092b23e4258ac',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        name: 'zap',
        url: 'https://github.com/uber-go/zap',
        commit: '4892335e05f14bce8a98a69a577fcf3844a42623',
        language: 'go',
        targetCandidates: ['.'],
    },
    {
        name: 'nom',
        url: 'https://github.com/rust-bakery/nom',
        commit: '51c3c4e44fa78a8a09b413419372b97b2cc2a787',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        name: 'guice',
        url: 'https://github.com/google/guice',
        commit: 'b8cab7e4e947adb82e343586c267c5c367cf5cf1',
        language: 'java',
        targetCandidates: ['core'],
    },
    {
        name: 'dapper',
        url: 'https://github.com/DapperLib/Dapper',
        commit: 'eb47546a408bbf6c178bda4f04dc205bc51ffbfe',
        language: 'csharp',
        targetCandidates: ['Dapper'],
    },
    {
        name: 'lz4',
        url: 'https://github.com/lz4/lz4',
        commit: '48bfbfe351c5d6ea87d4af5557705e87755844e0',
        language: 'c',
        targetCandidates: ['.'],
        clangFlags: ['-Ilib', '-Iprograms', '-Itests', '-Iossfuzz'],
    },
    {
        name: 'pugixml',
        url: 'https://github.com/zeux/pugixml',
        commit: '61421263d199c749b21fb1907b23d79ddd8285a1',
        language: 'cpp',
        targetCandidates: ['.'],
        clangFlags: ['-Isrc', '-Itests', '-std=c++17'],
    },
    {
        // Partial generic state machines, nested types and constructor
        // delegation. This former holdout now supplies regression evidence.
        name: 'stateless',
        url: 'https://github.com/dotnet-state-machine/stateless',
        commit: '39060018baadd6c992ed1aea926921bce4630fce',
        language: 'csharp',
        targetCandidates: ['.'],
    },
    // Former holdouts used to repair declaration, producer and receiver
    // identity. Keep the measured revisions as permanent regression inputs.
    {
        name: 'luxon',
        url: 'https://github.com/moment/luxon',
        commit: 'f427515a38f6a671f8de663e6bcc040ed81f114e',
        language: 'javascript',
        targetCandidates: ['.'],
    },
    {
        name: 'arrow',
        url: 'https://github.com/arrow-py/arrow',
        commit: '2224255c4acc594d734cef0bbc83360452a67983',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        name: 'more-itertools',
        url: 'https://github.com/more-itertools/more-itertools',
        commit: '4aeb4338ae1407d8da9723e86da99efeb446f719',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        name: 'rust-url',
        url: 'https://github.com/servo/rust-url',
        commit: 'cad4a844d8de6100f18b0ca17603ac3866a13c1f',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        name: 'indicatif',
        url: 'https://github.com/console-rs/indicatif',
        commit: '4925bce2ec5ffc8deaccc5658585d3fa30f23ec6',
        language: 'rust',
        targetCandidates: ['.'],
    },
    {
        // A fresh finding in Python base order and lexical receiver bindings.
        name: 'cachetools',
        url: 'https://github.com/tkem/cachetools',
        commit: 'f314dfaa49fe646427581e16bea33112a2140eb2',
        language: 'python',
        targetCandidates: ['.'],
    },
    {
        // An APPLICATION, not a library: a Django site whose static assets
        // vendor two bundled `*.min.js` files beside its Python and
        // JavaScript sources. The board had no repository where unindexed
        // text sits next to indexed source, which is the shape where a
        // completeness claim has to be made per name.
        name: 'djangoproject',
        url: 'https://github.com/django/djangoproject.com',
        commit: '83a027bb6aac5bb36b9ef48dad8cb4ff45a2e84f',
        language: 'python',
        targetCandidates: ['.'],
    },
];

// Publish-blocking board. Keep this as a named subset of REPOS so every
// release runner consumes one source of truth instead of repeating a comma-
// separated list in package scripts. The board includes one repository per
// compiler/LSP oracle plus second, style-different Go and Rust repositories.
const RELEASE_REPO_NAMES = Object.freeze([
    'preact-signals',
    'httpx',
    'cobra',
    'viper',
    'ripgrep',
    'clap',
    'javapoet',
    'newtonsoft-json',
    'cjson',
    'fmt',
]);
const RELEASE_REPOS = Object.freeze(RELEASE_REPO_NAMES.map(name => {
    const repo = REPOS.find(candidate => candidate.name === name);
    if (!repo) throw new Error(`Release repository "${name}" is not in REPOS`);
    return repo;
}));

// ============================================================================
// FRESH-REPO ARM (generalization guard)
// ============================================================================
// The pinned board proves stability; the fresh arm proves the receiver
// physics generalize to code the engine was never tuned on (the untuned-repo
// stress test found the deadcode base-override family exactly this way).
// Repos here are UNPINNED — each run resolves HEAD via ls-remote, records the
// SHA in the report (reproducible after the fact), and rotates through the
// pool by seven-day UTC intervals since the Unix epoch. None of these
// appear in REPOS, and none should ever be used to tune a fix — a fresh repo
// that surfaces a family graduates INTO the pinned board if it's used for
// engineering, and gets replaced here.
// Target rule (dayjs-measured, the cursive lesson): the oracle roots at the
// TARGET, UCN roots at its detected project root — so the target must cover
// the repo's CALLER universe (dayjs callers live in test/, outside 'src';
// every UCN edge there counted as an unverifiable claim and tier-1 cratered
// to 2.1% by universe mismatch, not engine physics). Default '.'; narrower
// only where the language server needs a specific project-model root (Java).
// Graduations so far: flask and serde_json (2026-08-20, outcome-board
// findings drove fixes #293-#296; pinned in OUTCOME_TUNED), attrs and
// itertools (2026-08-20, fix #300), rayon (2026-09-24, fix #368), dayjs
// (2026-10-30, fix #403) and rand (2026-10-30, fix #406); all pinned in
// REPOS. The 2026-10-30 replacements cover every supported language, are
// 6k-31k LOC each, and their oracles need no generated headers, build step
// or installed dependencies (a TypeScript repo with npm dependencies left
// ts-morph unable to resolve 66% of its definitions without `npm install`,
// so the TypeScript holdout is dependency-free).
// The 2026-11-04 replacements for luxon, arrow, more-itertools, rust-url and
// indicatif were selected from source/build metadata, without engine-score
// screening. A failed fresh draw remains a failure until investigated; do
// not rotate it away or weaken the gate. Tuning it triggers graduation.
// Packaging replaces the repaired cachetools draw using source/build
// eligibility only; it has not been screened for passing answers.
const FRESH_POOL = [
    { name: 'jinja', url: 'https://github.com/pallets/jinja', language: 'python', targetCandidates: ['.'] },
    { name: 'papaparse', url: 'https://github.com/mholt/PapaParse', language: 'javascript', targetCandidates: ['.'] },
    { name: 'superstruct', url: 'https://github.com/ianstormtaylor/superstruct', language: 'typescript', targetCandidates: ['.'] },
    { name: 'packaging', url: 'https://github.com/pypa/packaging', language: 'python', targetCandidates: ['.'] },
    { name: 'python-dateutil', url: 'https://github.com/dateutil/dateutil', language: 'python', targetCandidates: ['.'] },
    { name: 'toml', url: 'https://github.com/BurntSushi/toml', language: 'go', targetCandidates: ['.'] },
    { name: 'resty', url: 'https://github.com/go-resty/resty', language: 'go', targetCandidates: ['.'] },
    { name: 'semver', url: 'https://github.com/dtolnay/semver', language: 'rust', targetCandidates: ['.'] },
    { name: 'humantime', url: 'https://github.com/chronotope/humantime', language: 'rust', targetCandidates: ['.'] },
    { name: 'commons-csv', url: 'https://github.com/apache/commons-csv', language: 'java', targetCandidates: ['.'] },
    { name: 'sprache', url: 'https://github.com/sprache/Sprache', language: 'csharp', targetCandidates: ['.'] },
    { name: 'http-parser', url: 'https://github.com/nodejs/http-parser', language: 'c', targetCandidates: ['.'] },
    { name: 'tinyxml2', url: 'https://github.com/leethomason/tinyxml2', language: 'cpp', targetCandidates: ['.'] },
];

// ============================================================================
// OUTCOME-EVAL POOL (task-outcome instrument)
// ============================================================================
// Repos for eval/run-outcome-eval.js: the same mechanical task (rename /
// safe-delete) executed by fixed scripted policies that differ only in the
// discovery tool (text grep vs UCN's public CLI), judged by the language
// toolchain — never by the engine's own metrics. Same holdout discipline as
// FRESH_POOL: unpinned (HEAD resolved per run, SHA recorded in the report)
// and NEVER used to tune a fix. The graduation trigger is the FIRST time a
// repo's findings drive engineering, not repeated iteration — the original
// websocket/flask/serde_json pool drove fixes #293-#298 across several
// board reruns while still labeled "held out", which made their scores
// training-set validation (the 2026-08-20 review finding). A graduated repo
// moves to OUTCOME_TUNED (pinned, gate-bearing regression rows) and leaves
// BOTH pools. Only languages with a working toolchain judge belong here
// (go vet / cargo check / pyright); plain-JS repos have no static judge and
// TS repos need installed deps for a meaningful tsc run, so both stay out
// until a safe judge exists.
const OUTCOME_POOL = [
    // mux and requests graduated OUT 2026-08-20: their holdout-board rows
    // drove fix #300 families E (plan export-pass symbol identity +
    // name-token-only def renames — mux BuildVarsFunc), F (__all__ string
    // entries — requests put) and G (Go range-element typing — mux Match's
    // caller placement). Pinned in OUTCOME_TUNED. rust-csv stays: its rows
    // classified family H (ambiguity-application policy), which is not yet
    // engineered.
    { name: 'rust-csv', url: 'https://github.com/BurntSushi/rust-csv', language: 'rust', targetCandidates: ['.'] },
    { name: 'httprouter', url: 'https://github.com/julienschmidt/httprouter', language: 'go', targetCandidates: ['.'] },
    { name: 'werkzeug', url: 'https://github.com/pallets/werkzeug', language: 'python', targetCandidates: ['.'] },
];

// Graduated outcome repos: PINNED at the commits their 2026-08-19 boards
// measured, run by `eval:outcome --tuned` and gated by `--gate` (pinned
// commit + fixed seed → deterministic tasks, so the board is a regression
// pin, deterministic up to toolchain version). These repos' findings drove
// fixes #293-#298; their rows are regression evidence, never holdout
// evidence, and the reports mark them tunedRepo:true.
const OUTCOME_TUNED = [
    { name: 'websocket', url: 'https://github.com/gorilla/websocket', language: 'go', commit: 'e064f32e3674d9d79a8fd417b5bc06fa5c6cad8f', targetCandidates: ['.'] },
    { name: 'flask', url: 'https://github.com/pallets/flask', language: 'python', commit: 'd318b683471101618febed18996405ad26462110', targetCandidates: ['.'] },
    { name: 'serde_json', url: 'https://github.com/serde-rs/json', language: 'rust', commit: 'afdf6fc67247dd7fa4fcde1381e6ecc6bcc7a30e', targetCandidates: ['.'] },
    // Graduated 2026-08-20 (drove fix #300 E/F/G) at their board SHAs.
    // gate: false — their remaining contract-broken rows are CLASSIFIED
    // engine gaps (mux Match: Go interface-slot rename closure; mux
    // PathPrefix + rust-csv escape/quoting: family H ambiguity-application;
    // requests put: module-attribute references in plan's reference pass),
    // so per-repo contract≤grep would red the CI gate by construction. They
    // run under --tuned as pinned measurement rows; they join the gate only
    // after those families land AND a green run on the enforcing
    // environment (#292b).
    { name: 'mux', url: 'https://github.com/gorilla/mux', language: 'go', commit: 'db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265', targetCandidates: ['.'], gate: false },
    { name: 'requests', url: 'https://github.com/psf/requests', language: 'python', commit: '8f8b212de8c2129d7954c6cd373762880375620a', targetCandidates: ['.'], gate: false },
    // Pinned 2026-11-10 as a measurement row (gate: false): a small
    // APPLICATION that vendors bundled assets (two `*.min.js` under static/)
    // beside its Python and JavaScript sources. One skipped file withdraws
    // every contract on such a repo, so it carries the before/after numbers
    // for the precommit-check tasks and the answer tax. It joins the gate
    // after that behavior changes AND a green run on the enforcing
    // environment (#292b).
    { name: 'djangoproject', url: 'https://github.com/django/djangoproject.com', language: 'python', commit: '83a027bb6aac5bb36b9ef48dad8cb4ff45a2e84f', targetCandidates: ['.'], gate: false },
];

/**
 * Resolve a fresh repo's current HEAD SHA (no clone — ls-remote) and pin the
 * repo object to it, so cloneAtCommit and the report machinery work
 * unchanged. Returns the SHA.
 */
function resolveFreshCommit(repo) {
    const out = execSync(`git ls-remote ${repo.url} HEAD`, { stdio: 'pipe', timeout: 60000 }).toString();
    const sha = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`ls-remote gave no usable SHA for ${repo.url}: ${out.slice(0, 120)}`);
    }
    repo.commit = sha;
    return sha;
}

/**
 * Deterministic weekly rotation over FRESH_POOL: the same UTC week picks the
 * same repos (re-runs reproduce), successive weeks advance the window.
 */
function selectFreshRepos(count, now = Date.now()) {
    const week = Math.floor(now / (7 * 24 * 3600 * 1000));
    const start = week % FRESH_POOL.length;
    const picked = [];
    for (let i = 0; i < Math.min(count, FRESH_POOL.length); i++) {
        picked.push(FRESH_POOL[(start + i) % FRESH_POOL.length]);
    }
    return picked;
}

/**
 * Clone a repo at its pinned commit (or reuse an existing checkout of that
 * commit). Returns the absolute repo path.
 */
function cloneAtCommit(repo, baseDir = EVAL_TEMP_DIR) {
    const repoPath = path.join(baseDir, repo.name);
    const markerPath = path.join(repoPath, '.ucn-eval-commit');

    if (fs.existsSync(markerPath)) {
        const pinned = fs.readFileSync(markerPath, 'utf-8').trim();
        if (pinned === repo.commit) return repoPath;
        fs.rmSync(repoPath, { recursive: true, force: true }); // wrong commit cached
    } else if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true }); // unpinned leftover
    }

    fs.mkdirSync(repoPath, { recursive: true });
    const run = (cmd) => execSync(cmd, { cwd: repoPath, stdio: 'pipe', timeout: 300000 });
    run('git init -q');
    run(`git fetch -q --depth 1 ${repo.url} ${repo.commit}`);
    run('git checkout -q FETCH_HEAD');
    fs.writeFileSync(markerPath, repo.commit + '\n');
    return repoPath;
}

/** Resolve the analysis target subdirectory inside a cloned repo. */
function resolveTarget(repoPath, repo) {
    for (const candidate of repo.targetCandidates || ['.']) {
        const resolved = path.resolve(repoPath, candidate);
        if (fs.existsSync(resolved)) return resolved;
    }
    return repoPath;
}

/** Deterministic PRNG (mulberry32) — eval sampling must be reproducible. */
function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

module.exports = {
    REPOS,
    RELEASE_REPOS,
    RELEASE_REPO_NAMES,
    FRESH_POOL,
    OUTCOME_POOL,
    OUTCOME_TUNED,
    EVAL_TEMP_DIR,
    cloneAtCommit,
    resolveTarget,
    seededRandom,
    resolveFreshCommit,
    selectFreshRepos,
};
