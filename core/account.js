/**
 * core/account.js - Conservation accounting for caller queries
 *
 * Implements the "never silently hide an occurrence" contract: the answer to
 * "who calls X" must be a PARTITION of the text-occurrence ground set, never a
 * subset. Every line that word-boundary-matches the symbol name is assigned to
 * exactly one bucket:
 *
 *   confirmed     - claimed by an engine caller edge with confirmed-tier evidence
 *   unverified    - claimed with unverified-tier evidence, or an AST call line
 *                   no engine candidate claimed (reason: call-not-resolved)
 *   excluded      - engine positively determined the call targets a DIFFERENT
 *                   symbol (receiver-type mismatch, other definition, ...)
 *   nonCall       - import / definition / reference per AST usage type, plus
 *                   unclassifiedText (no AST usage at the line: comments,
 *                   strings, and scanner-skipped tokens such as JS builtins —
 *                   deliberately named "unclassified", not "comment")
 *   unparsed      - line in a file that failed to parse (still readable text)
 *   unaccounted   - residual; 0 when the arithmetic is conserved
 *
 * Conservation invariant:
 *   groundTotal === confirmed + unverified + nonCall.total + excluded.total
 *                   + unparsed.lines + unaccounted
 *
 * Engine finds that grep would MISS (alias-resolved call sites whose line does
 * not word-boundary-match the name) are reported in `beyondText` — additive
 * information OUTSIDE the invariant, like `unreadableFiles`.
 *
 * Ground-set semantics are grep `-n -w`: unit is the (file, line) pair, each
 * line with >= 1 word-boundary match counts once, case-sensitive.
 *
 * Performance: the ground scan is one `includes()`-gated read per project file
 * per caller-command — the same I/O profile as the existing `search`/`usages`
 * commands. Deriving counts from callsCache (zero reads) was rejected because
 * comments/strings/references are not in the calls cache and the contract's
 * ground set is text-defined. AST parsing (the expensive part) is restricted
 * to files containing UNCLAIMED ground lines, via the op-cached
 * `index._getCachedUsages`. No file is read twice in one command because
 * context/about/impact run inside `index._beginOp()`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { escapeRegExp } = require('./shared');

/**
 * Compute the text-occurrence ground set for a symbol name.
 *
 * @param {object} index - ProjectIndex
 * @param {string} name - Symbol name (matched with \b word boundaries)
 * @returns {{
 *   total: number,                      // matching lines incl. unparsed files
 *   fileCount: number,                  // files (indexed + unparsed) with >= 1 matching line
 *   perFile: Map<string, number[]>,     // absPath -> sorted 1-indexed line numbers (indexed files only)
 *   unparsed: { fileCount: number, lines: number, files: string[] },  // relative paths
 *   unreadableFiles: string[]           // relative paths; OUTSIDE the arithmetic
 * }}
 */
function computeGroundSet(index, name) {
    const wordRe = new RegExp('\\b' + escapeRegExp(name) + '\\b');
    const perFile = new Map();
    let total = 0;
    let fileCount = 0;

    for (const [filePath] of index.files) {
        let content;
        try {
            content = index._readFile(filePath);
        } catch (e) {
            continue; // deleted since indexing; not part of the universe anymore
        }
        if (!content.includes(name)) continue;
        // Shared read-only lines array — split once per file per operation,
        // reused across the symbols of a multi-symbol command (diff-impact).
        const lines = index._getFileLines(filePath);
        const matched = [];
        for (let i = 0; i < lines.length; i++) {
            if (wordRe.test(lines[i])) matched.push(i + 1);
        }
        if (matched.length > 0) {
            perFile.set(filePath, matched);
            total += matched.length;
            fileCount++;
        }
    }

    // Failed-to-parse files are still text: their matching lines are part of
    // the ground set, classified as `unparsed` (loud degradation, not silence).
    const unparsed = { fileCount: 0, lines: 0, files: [] };
    const unreadableFiles = [];
    if (index.failedFiles && index.failedFiles.size > 0) {
        for (const failedPath of index.failedFiles) {
            if (index.files.has(failedPath)) continue; // indexed despite earlier failure
            let content;
            try {
                content = fs.readFileSync(failedPath, 'utf-8');
            } catch (e) {
                unreadableFiles.push(path.relative(index.root, failedPath));
                continue;
            }
            if (!content.includes(name)) continue;
            const lines = content.split('\n');
            let matched = 0;
            for (let i = 0; i < lines.length; i++) {
                if (wordRe.test(lines[i])) matched++;
            }
            if (matched > 0) {
                unparsed.fileCount++;
                unparsed.lines += matched;
                unparsed.files.push(path.relative(index.root, failedPath));
            }
        }
        unparsed.files.sort();
    }
    unreadableFiles.sort();

    return {
        total: total + unparsed.lines,
        fileCount: fileCount + unparsed.fileCount,
        perFile,
        unparsed,
        unreadableFiles,
    };
}

/**
 * Classify ground lines not claimed by engine results.
 *
 * Precedence per line (first match wins):
 *   call       -> unverified, reason `call-not-resolved`
 *   import     -> nonCall.imports
 *   definition -> nonCall.definitions
 *   reference  -> nonCall.references
 *   (none)     -> nonCall.unclassifiedText
 *
 * @param {object} index - ProjectIndex
 * @param {string} name - Symbol name
 * @param {object} groundSet - from computeGroundSet
 * @param {Set<string>} claimedKeys - `${absPath}:${line}` keys already claimed
 *   (confirmed + unverified + excluded engine lines)
 * @returns {{
 *   nonCall: { imports: number, definitions: number, references: number, unclassifiedText: number, total: number },
 *   callNotResolved: Array<{file: string, relativePath: string, line: number}>
 * }}
 */
function classifyGroundLines(index, name, groundSet, claimedKeys) {
    const nonCall = { imports: 0, definitions: 0, references: 0, unclassifiedText: 0, total: 0 };
    const callNotResolved = [];

    // Cheap-first sources that need NO parsing: call lines from the calls
    // cache (populated at index build) and definition lines from the symbol
    // table. Only lines neither source explains fall through to the AST
    // usage scan — typically comment/string/reference lines in test files.
    // Same output as parse-everything, far fewer tree-sitter parses.
    const defLinesByFile = new Map();
    for (const def of index.symbols.get(name) || []) {
        if (!def.file) continue;
        if (!defLinesByFile.has(def.file)) defLinesByFile.set(def.file, new Set());
        defLinesByFile.get(def.file).add(def.startLine);
    }
    let getCachedCalls = null; // lazy require to avoid cycle at module load

    for (const [filePath, lineNumbers] of groundSet.perFile) {
        let unclaimed = null;
        for (const line of lineNumbers) {
            if (claimedKeys.has(`${filePath}:${line}`)) continue;
            (unclaimed || (unclaimed = [])).push(line);
        }
        if (!unclaimed) continue;

        const fileEntry = index.files.get(filePath);
        const relativePath = fileEntry ? fileEntry.relativePath : path.relative(index.root, filePath);

        // Cheap pass: calls cache + symbol table
        if (!getCachedCalls) getCachedCalls = require('./callers').getCachedCalls;
        const cachedCalls = getCachedCalls(index, filePath);
        const callLines = new Set();
        if (Array.isArray(cachedCalls)) {
            for (const c of cachedCalls) {
                if (c.name === name || c.resolvedName === name ||
                    (c.resolvedNames && c.resolvedNames.includes(name))) {
                    callLines.add(c.line);
                }
            }
        }
        const defLines = defLinesByFile.get(filePath);

        let needsParse = null;
        for (const line of unclaimed) {
            if (callLines.has(line)) {
                callNotResolved.push({ file: filePath, relativePath, line });
            } else if (defLines && defLines.has(line)) {
                nonCall.definitions++;
            } else {
                (needsParse || (needsParse = [])).push(line);
            }
        }
        if (!needsParse) continue;

        // Remainder: AST usage scan distinguishes import/definition/reference
        // from comment/string/skipped-token lines.
        const usages = index._getCachedUsages(filePath, name);
        const byLine = new Map();
        if (Array.isArray(usages)) {
            for (const u of usages) {
                const existing = byLine.get(u.line);
                // call outranks import outranks definition outranks reference
                if (!existing || RANK[u.usageType] < RANK[existing]) {
                    byLine.set(u.line, u.usageType);
                }
            }
        }
        for (const line of needsParse) {
            const usageType = byLine.get(line);
            if (usageType === 'call') {
                callNotResolved.push({ file: filePath, relativePath, line });
            } else if (usageType === 'import') {
                nonCall.imports++;
            } else if (usageType === 'definition') {
                nonCall.definitions++;
            } else if (usageType === 'reference') {
                nonCall.references++;
            } else {
                // No AST usage at this line (or parse returned null): comment,
                // string, or a token the usage scanner deliberately skips.
                nonCall.unclassifiedText++;
            }
        }
    }

    nonCall.total = nonCall.imports + nonCall.definitions + nonCall.references + nonCall.unclassifiedText;
    return { nonCall, callNotResolved };
}

const RANK = { call: 0, import: 1, definition: 2, reference: 3 };

/**
 * Build the account object from the ground set plus engine claims.
 *
 * Claims whose lines are NOT in the ground set (alias-resolved call sites —
 * lines that don't word-boundary-match the name) go to `beyondText` instead
 * of the conservation arithmetic: they are finds grep would miss.
 *
 * @param {object} index - ProjectIndex
 * @param {string} name - Symbol name
 * @param {object} parts
 * @param {object} parts.groundSet - from computeGroundSet
 * @param {Array<{file: string, line: number}>} [parts.confirmedEntries] - engine confirmed-tier caller lines
 * @param {Array<{file: string, line: number, reason?: string}>} [parts.unverifiedEntries] - engine unverified-tier lines
 * @param {Array<{file: string, line: number, reason: string}>} [parts.excludedEntries] - engine excluded lines (FULL list, not samples)
 * @param {object} [parts.filtered] - display-level hide counts { total, byFlag } (explanatory, outside invariant)
 * @returns {object} account (see file header for shape)
 */
function buildAccount(index, name, parts) {
    const { groundSet } = parts;
    const confirmedEntries = parts.confirmedEntries || [];
    const unverifiedEntries = parts.unverifiedEntries || [];
    const excludedEntries = parts.excludedEntries || [];

    const groundKeys = new Set();
    for (const [filePath, lineNumbers] of groundSet.perFile) {
        for (const line of lineNumbers) groundKeys.add(`${filePath}:${line}`);
    }

    const claimedKeys = new Set();
    const beyondText = { count: 0, sample: [] };
    let confirmed = 0;
    let unverified = 0;

    const claim = (entry, bucket) => {
        const key = `${entry.file}:${entry.line}`;
        if (claimedKeys.has(key)) return; // one bucket per line; first claim wins
        if (!groundKeys.has(key)) {
            // Engine found a call site grep would miss (alias / indirect name).
            beyondText.count++;
            if (beyondText.sample.length < 3) {
                beyondText.sample.push({
                    file: relPath(index, entry.file),
                    line: entry.line,
                });
            }
            claimedKeys.add(key);
            return;
        }
        claimedKeys.add(key);
        bucket();
    };

    for (const e of confirmedEntries) claim(e, () => { confirmed++; });
    for (const e of unverifiedEntries) claim(e, () => { unverified++; });

    const excludedByReason = {};
    let excludedTotal = 0;
    for (const e of excludedEntries) {
        const key = `${e.file}:${e.line}`;
        if (claimedKeys.has(key)) continue;
        claimedKeys.add(key);
        if (!groundKeys.has(key)) continue; // excluded non-ground line: irrelevant to both grep and display
        excludedTotal++;
        const r = e.reason || 'excluded';
        if (!excludedByReason[r]) excludedByReason[r] = { count: 0, sample: [] };
        excludedByReason[r].count++;
        if (excludedByReason[r].sample.length < 3) {
            excludedByReason[r].sample.push({ file: relPath(index, e.file), line: e.line });
        }
    }

    const { nonCall, callNotResolved } = classifyGroundLines(index, name, groundSet, claimedKeys);
    // Ground call-lines nobody claimed are unverified by contract: the engine
    // saw call syntax it didn't resolve. This converts engine misses into
    // visible entries instead of silent gaps.
    unverified += callNotResolved.length;

    const accountedTotal = confirmed + unverified + nonCall.total + excludedTotal + groundSet.unparsed.lines;
    const unaccounted = groundSet.total - accountedTotal;

    const textComplete = unaccounted === 0 &&
        groundSet.unparsed.fileCount === 0 &&
        groundSet.unreadableFiles.length === 0;
    const observedTextZero = textComplete && confirmed === 0 && unverified === 0 &&
        beyondText.count === 0;

    const account = {
        symbol: name,
        groundTotal: groundSet.total,
        fileCount: groundSet.fileCount,
        confirmed,
        unverified,
        nonCall,
        excluded: { total: excludedTotal, byReason: excludedByReason },
        unparsed: groundSet.unparsed,
        unreadableFiles: groundSet.unreadableFiles,
        beyondText,
        unaccounted,
        conserved: unaccounted === 0,
        // This deliberately describes a narrower guarantee than "all callers".
        // The conservation model proves that every literal-name text line was
        // classified. It cannot prove that aliases, indirect calls, generated
        // code, or runtime dispatch contain no additional semantic references.
        contract: {
            kind: 'literal-name-text-partition',
            textComplete,
            observedTextZero,
            semanticComplete: false,
            safeToDelete: false,
            requiresUsageReview: nonCall.references > 0 || nonCall.unclassifiedText > 0,
        },
    };
    if (parts.filtered && parts.filtered.total > 0) {
        account.filtered = parts.filtered;
    }
    // Internal (non-enumerable): unclaimed call lines, for engine diagnostics
    // and the Phase-1 baseline gap report. Not part of the JSON surface.
    Object.defineProperty(account, 'callNotResolved', {
        value: callNotResolved,
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return account;
}

function relPath(index, filePath) {
    const fileEntry = index.files.get(filePath);
    return fileEntry ? fileEntry.relativePath : path.relative(index.root, filePath);
}

module.exports = {
    computeGroundSet,
    classifyGroundLines,
    buildAccount,
};
