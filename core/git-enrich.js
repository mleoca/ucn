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
        // We capture stderr so we can classify failure modes (not-a-repo,
        // file-not-tracked, timeout) instead of leaking the raw shell error
        // to the caller (MEDIUM-9).
        const lastLine = execFileSync(
            'git',
            ['log', '-1', '--format=%aI|%an', '--', relPath],
            {
                cwd: projectRoot,
                encoding: 'utf-8',
                timeout: GIT_TIMEOUT_MS,
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        ).trim();

        if (!lastLine) {
            // File exists but no git history — likely untracked
            info = { available: false, error: 'File not tracked' };
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
                    stdio: ['ignore', 'pipe', 'pipe'],
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
        // MEDIUM-9: never leak the raw shell command back to the user (which
        // includes the path being queried — looks like a stack trace and is
        // surface-level confusing in JSON output). Classify and translate.
        info = { available: false, error: classifyGitError(e) };
    }

    _cache.set(cacheKey, info);
    return info;
}

/**
 * Translate a git execFileSync exception into a user-friendly error string.
 * Inspects exit code, signal, and (when captured) stderr text to pick the
 * right category. Falls back to a generic "Git unavailable" rather than
 * leaking the underlying command — the caller renders this as JSON / text.
 */
function classifyGitError(e) {
    if (!e) return 'Git unavailable';
    // Timeout: child_process throws ENOENT-like errors with `signal: 'SIGTERM'`
    // or `killed: true` when the timeout fires.
    if (e.signal === 'SIGTERM' || e.killed === true) return 'Git timed out';
    // git binary not installed
    if (e.code === 'ENOENT') return 'Git not installed';
    // Inspect stderr if captured
    const stderr = e.stderr ? String(e.stderr) : '';
    const lower = stderr.toLowerCase();
    if (lower.includes('not a git repository')) return 'Not a git repository';
    if (lower.includes("did not match any file") ||
        lower.includes('pathspec') && lower.includes('did not match')) {
        return 'File not tracked';
    }
    // Exit 128 commonly means "fatal" git error — we already caught the
    // common cases above, so anything else is generic.
    return 'Git unavailable';
}

/** Test helper: clear the in-process cache. */
function _clearCache() {
    _cache.clear();
}

module.exports = { getGitInfo, _clearCache };
