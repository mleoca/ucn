/**
 * eval/lib/repos.js - Pinned-commit clone harness for eval runs.
 *
 * Unlike test/real-repo-stress-analysis.js (shallow clone of HEAD), eval runs
 * must be reproducible: every repo is pinned to a commit SHA so metric drift
 * means UCN changed, not the repo. SHAs pinned 2026-06-11.
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
        name: 'httpx',
        url: 'https://github.com/encode/httpx',
        commit: 'b5addb64f0161ff6bfe94c124ef76f6a1fba5254',
        language: 'python',
        targetCandidates: ['httpx'],
    },
    {
        name: 'cobra',
        url: 'https://github.com/spf13/cobra',
        commit: 'ad460ea8f249db69c943a365fb84f3a59042d54e',
        language: 'go',
        targetCandidates: ['.'],
    },
    {
        name: 'ripgrep',
        url: 'https://github.com/BurntSushi/ripgrep',
        commit: '82313cf95849bfe425109ad9506a52154879b1b1',
        language: 'rust',
        targetCandidates: ['crates/core'],
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
