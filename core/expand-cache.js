/**
 * Shared expand cache for context → expand workflow.
 *
 * Used by MCP server (in-memory, multi-symbol) and interactive mode (in-memory, session-scoped).
 * CLI one-shot mode uses file-based persistence instead (separate processes).
 *
 * LRU eviction keeps memory bounded. Cache entries are keyed by project:symbol:file
 * to support multiple concurrent context results per project.
 */

'use strict';

const fs = require('fs');
const path = require('path');

class ExpandCache {
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxSize=50] - Maximum cached context results
     */
    constructor({ maxSize = 50 } = {}) {
        this.entries = new Map();     // cacheKey → { items, root, symbolName, usedAt }
        this.lastKey = new Map();     // projectRoot → most recent cacheKey
        this.maxSize = maxSize;
    }

    /**
     * Save expandable items from a context result.
     *
     * @param {string} root - Project root path
     * @param {string} name - Symbol name from the context call
     * @param {string} [file] - Optional file filter used in the context call
     * @param {Array} items - Expandable items from formatContext()
     */
    save(root, name, file, items) {
        if (!items || items.length === 0) return;

        const key = `${root}:${name}:${file || ''}`;

        // LRU eviction if at capacity
        if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [k, v] of this.entries) {
                if ((v.usedAt || 0) < oldestTime) {
                    oldestTime = v.usedAt || 0;
                    oldestKey = k;
                }
            }
            if (oldestKey) {
                this.entries.delete(oldestKey);
                // Clean up lastKey if it pointed to the evicted entry
                for (const [r, k] of this.lastKey) {
                    if (k === oldestKey) { this.lastKey.delete(r); break; }
                }
            }
        }

        this.entries.set(key, { items, root, symbolName: name, usedAt: Date.now() });
        this.lastKey.set(root, key);
    }

    /**
     * Look up an expandable item by number.
     * Tries the most recent context for the project first, then falls back to all entries.
     *
     * @param {string} root - Project root path
     * @param {number} itemNum - Item number to find
     * @returns {{ match: object|null, itemCount: number, symbolName: string|null }}
     */
    lookup(root, itemNum) {
        // Try most recent context for this project
        const recentKey = this.lastKey.get(root);
        const recent = recentKey ? this.entries.get(recentKey) : null;

        if (recent && recent.items) {
            const match = recent.items.find(i => i.num === itemNum);
            if (match) {
                recent.usedAt = Date.now();
                return { match, itemCount: recent.items.length, symbolName: recent.symbolName };
            }
        }

        // Fallback: scan all entries for this project
        let maxCount = recent?.items?.length || 0;
        let foundEntry = null;
        for (const [, cached] of this.entries) {
            if (cached.root === root && cached.items) {
                maxCount = Math.max(maxCount, cached.items.length);
                const found = cached.items.find(i => i.num === itemNum);
                if (found && !foundEntry) {
                    foundEntry = { match: found, cached };
                }
            }
        }
        if (foundEntry) {
            // Only refresh the entry that actually contains the match
            foundEntry.cached.usedAt = Date.now();
            return { match: foundEntry.match, itemCount: maxCount, symbolName: foundEntry.cached.symbolName };
        }

        return {
            match: null,
            itemCount: maxCount,
            symbolName: recent?.symbolName || null
        };
    }

    /**
     * Clear all expand cache entries for a project root.
     * Called when the project index is rebuilt (entries become stale).
     *
     * @param {string} root - Project root path
     */
    clearForRoot(root) {
        for (const [key, cached] of this.entries) {
            if (cached.root === root) this.entries.delete(key);
        }
        this.lastKey.delete(root);
    }

    /** Number of cached entries. */
    get size() {
        return this.entries.size;
    }
}

/**
 * Detect the end of a function/method body starting from startLine.
 * Uses brace/indent counting to find the closing boundary.
 * Falls back to startLine + 30 if detection fails.
 */
function _detectFunctionEnd(fileLines, startLine) {
    const maxScan = 500; // Avoid scanning huge files
    const idx = startLine - 1;
    if (idx >= fileLines.length) return startLine;

    const firstLine = fileLines[idx];

    // Python: indentation-based — find the first non-empty line at same or lesser indent
    if (/^\s*def\s|^\s*class\s|^\s*async\s+def\s/.test(firstLine)) {
        const baseIndent = firstLine.match(/^(\s*)/)[1].length;
        let end = startLine;
        for (let i = idx + 1; i < Math.min(idx + maxScan, fileLines.length); i++) {
            const line = fileLines[i];
            if (line.trim() === '') { end = i + 1; continue; } // blank lines are part of body
            const indent = line.match(/^(\s*)/)[1].length;
            if (indent <= baseIndent) break;
            end = i + 1;
        }
        return end;
    }

    // Brace-based languages (JS/TS/Go/Java/Rust): count braces
    let braceCount = 0;
    let foundBrace = false;
    for (let i = idx; i < Math.min(idx + maxScan, fileLines.length); i++) {
        const line = fileLines[i];
        for (const ch of line) {
            if (ch === '{') { braceCount++; foundBrace = true; }
            else if (ch === '}') { braceCount--; }
        }
        if (foundBrace && braceCount <= 0) {
            return i + 1;
        }
    }

    // Fallback: show 30 lines from start
    return Math.min(startLine + 30, fileLines.length);
}

/**
 * Render an expand match to text lines.
 * Shared by MCP and interactive mode to avoid duplicated rendering logic.
 *
 * @param {object} match - Expandable item from formatContext()
 * @param {string} root - Project root path
 * @param {object} [opts]
 * @param {boolean} [opts.validateRoot=false] - Validate file is within project root (MCP security)
 * @returns {{ ok: boolean, text?: string, error?: string }}
 */
function renderExpandItem(match, root, { validateRoot = false } = {}) {
    const filePath = match.file || (root && match.relativePath ? path.join(root, match.relativePath) : null);
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: `Cannot locate file for ${match.name}` };
    }

    if (validateRoot && root) {
        try {
            const realPath = fs.realpathSync(filePath);
            const realRoot = fs.realpathSync(root);
            if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
                return { ok: false, error: `File is outside project root: ${match.name}` };
            }
        } catch (e) {
            return { ok: false, error: `Cannot resolve file path for ${match.name}` };
        }
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const fileLines = content.split('\n');
    const startLine = match.startLine || match.line || 1;
    let endLine = match.endLine;

    // When endLine is missing or equals startLine, the expand would show only 1 line.
    // Scan forward from startLine to find the actual function/method body end.
    if (!endLine || endLine <= startLine) {
        endLine = _detectFunctionEnd(fileLines, startLine);
    }

    const lines = [];
    lines.push(`[${match.num}] ${match.name} (${match.type})`);
    lines.push(`${match.relativePath}:${startLine}-${endLine}`);
    lines.push('\u2550'.repeat(60));

    for (let i = startLine - 1; i < Math.min(endLine, fileLines.length); i++) {
        lines.push(fileLines[i]);
    }

    return { ok: true, text: lines.join('\n') };
}

module.exports = { ExpandCache, renderExpandItem };
