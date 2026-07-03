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
];

// ============================================================================
// FRESH-REPO ARM (generalization guard)
// ============================================================================
// The pinned board proves stability; the fresh arm proves the receiver
// physics generalize to code the engine was never tuned on (the untuned-repo
// stress test found the deadcode base-override family exactly this way).
// Repos here are UNPINNED — each run resolves HEAD via ls-remote, records the
// SHA in the report (reproducible after the fact), and rotates through the
// pool by ISO week so successive runs cover different repos. None of these
// appear in REPOS, and none should ever be used to tune a fix — a fresh repo
// that surfaces a family graduates INTO the pinned board if it's used for
// engineering, and gets replaced here.
// Target rule (dayjs-measured, the cursive lesson): the oracle roots at the
// TARGET, UCN roots at its detected project root — so the target must cover
// the repo's CALLER universe (dayjs callers live in test/, outside 'src';
// every UCN edge there counted as an unverifiable claim and tier-1 cratered
// to 2.1% by universe mismatch, not engine physics). Default '.'; narrower
// only where the language server needs a specific project-model root (Java).
const FRESH_POOL = [
    { name: 'dayjs', url: 'https://github.com/iamkun/dayjs', language: 'javascript', targetCandidates: ['.'] },
    { name: 'flask', url: 'https://github.com/pallets/flask', language: 'python', targetCandidates: ['.'] },
    { name: 'serde_json', url: 'https://github.com/serde-rs/json', language: 'rust', targetCandidates: ['.'] },
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

module.exports = { REPOS, FRESH_POOL, EVAL_TEMP_DIR, cloneAtCommit, resolveTarget, seededRandom, resolveFreshCommit, selectFreshRepos };
