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
];

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

module.exports = { REPOS, EVAL_TEMP_DIR, cloneAtCommit, resolveTarget, seededRandom };
