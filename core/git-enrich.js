/**
 * core/git-enrich.js — Optional git enrichment for about/brief output.
 *
 * Pure shell-out to `git log` — no parsing libraries, no LLM. Returns
 * `{ available: false }` for any failure (not a repo, file untracked,
 * git missing) so callers can render gracefully.
 *
 * Cached per (root, relPath) for the lifetime of the process — git history
 * doesn't change mid-command, and `about` / `brief` may be invoked many
 * times against the same files in interactive/MCP sessions.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// Module-level cache: `${projectRoot}::${relPath}` → enrichment object.
// Process-lifetime is correct here — across-process invocations re-shell-out,
// which is fine (git is fast enough), and within a process the cache prevents
// hammering git for the same file when an agent runs `about` then `brief`.
const _cache = new Map();

const GIT_TIMEOUT_MS = 2000;

/**
 * Get git info for a file path inside a project.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} relativeFilePath - Relative path inside the project
 * @returns {{ available: boolean, lastModified?: string, author?: string, recentChanges?: number, error?: string }}
 */
function getGitInfo(projectRoot, relativeFilePath) {
    if (!projectRoot || !relativeFilePath) {
        return { available: false, error: 'missing projectRoot or path' };
    }
    // Normalize to forward slashes for git on Windows
    const relPath = relativeFilePath.split(path.sep).join('/');
    const cacheKey = `${projectRoot}::${relPath}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    let info;
    try {
        // Last commit touching this file: ISO timestamp + author name.
        // Use --follow to track renames, but only if the file exists in history.
        const lastLine = execFileSync(
            'git',
            ['log', '-1', '--format=%aI|%an', '--', relPath],
            {
                cwd: projectRoot,
                encoding: 'utf-8',
                timeout: GIT_TIMEOUT_MS,
                stdio: ['ignore', 'pipe', 'ignore'],
            }
        ).trim();

        if (!lastLine) {
            // File exists but no git history — likely untracked
            info = { available: false, error: 'untracked or no history' };
        } else {
            const [lastModified, author] = lastLine.split('|');

            // Count of commits in the last 30 days that touched this file.
            // We use a one-line --format and count rather than --oneline | wc -l
            // to avoid platform shell differences.
            const recentLines = execFileSync(
                'git',
                ['log', '--since=30 days ago', '--format=%H', '--', relPath],
                {
                    cwd: projectRoot,
                    encoding: 'utf-8',
                    timeout: GIT_TIMEOUT_MS,
                    stdio: ['ignore', 'pipe', 'ignore'],
                }
            ).trim();
            const recentChanges = recentLines === '' ? 0 : recentLines.split('\n').length;

            info = {
                available: true,
                lastModified: lastModified || null,
                author: author || null,
                recentChanges,
            };
        }
    } catch (e) {
        // Not a git repo, git not installed, file outside repo, timeout, etc.
        info = { available: false, error: e?.message || String(e) };
    }

    _cache.set(cacheKey, info);
    return info;
}

/** Test helper: clear the in-process cache. */
function _clearCache() {
    _cache.clear();
}

module.exports = { getGitInfo, _clearCache };
