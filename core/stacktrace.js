/**
 * core/stacktrace.js - Stack trace parsing and file matching
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Calculate path similarity score between two file paths
 * Higher score = better match
 * @param {string} query - The path from stack trace
 * @param {string} candidate - The candidate file path
 * @returns {number} Similarity score
 */
function calculatePathSimilarity(query, candidate) {
    // Normalize paths for comparison
    const queryParts = query.replace(/\\/g, '/').split('/').filter(Boolean);
    const candidateParts = candidate.replace(/\\/g, '/').split('/').filter(Boolean);

    let score = 0;

    // Exact match on full path
    if (candidate.endsWith(query)) {
        score += 100;
    }

    // Compare from the end (most important part)
    let matches = 0;
    const minLen = Math.min(queryParts.length, candidateParts.length);
    for (let i = 0; i < minLen; i++) {
        const queryPart = queryParts[queryParts.length - 1 - i];
        const candPart = candidateParts[candidateParts.length - 1 - i];
        if (queryPart === candPart) {
            matches++;
            // Earlier parts (closer to filename) score more
            score += (10 - i) * 5;
        } else {
            break; // Stop at first mismatch
        }
    }

    // Bonus for matching most of the query path
    if (matches === queryParts.length) {
        score += 50;
    }

    // Filename match is essential
    const queryFile = queryParts[queryParts.length - 1];
    const candFile = candidateParts[candidateParts.length - 1];
    if (queryFile !== candFile) {
        score = 0; // No match if filename doesn't match
    }

    return score;
}

/**
 * Find the best matching file for a stack trace path
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - Path from stack trace
 * @param {string|null} funcName - Function name for verification
 * @param {number} lineNum - Line number for verification
 * @returns {{path: string, relativePath: string, confidence: number}|null}
 */
function findBestMatchingFile(index, filePath, funcName, lineNum) {
    const candidates = [];

    // Collect all potential matches with scores
    for (const [absPath, fileEntry] of index.files) {
        const score = calculatePathSimilarity(filePath, absPath);
        const relScore = calculatePathSimilarity(filePath, fileEntry.relativePath);
        const bestScore = Math.max(score, relScore);

        if (bestScore > 0) {
            candidates.push({
                absPath,
                relativePath: fileEntry.relativePath,
                score: bestScore,
                fileEntry
            });
        }
    }

    if (candidates.length === 0) {
        // Try absolute path
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(index.root, filePath);
        if (fs.existsSync(absPath)) {
            return {
                path: absPath,
                relativePath: path.relative(index.root, absPath),
                confidence: 0.5 // Low confidence for unindexed files
            };
        }
        return null;
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // If there's a function name, verify it exists at the line
    if (funcName && candidates.length > 1) {
        for (const cand of candidates) {
            const symbols = index.symbols.get(funcName);
            if (symbols) {
                const match = symbols.find(s =>
                    s.file === cand.absPath &&
                    s.startLine <= lineNum && s.endLine >= lineNum
                );
                if (match) {
                    // This candidate has the function at the right line - strong match
                    return {
                        path: cand.absPath,
                        relativePath: cand.relativePath,
                        confidence: 1.0,
                        verifiedFunction: true
                    };
                }
            }
        }
    }

    // Return best scoring candidate
    const best = candidates[0];
    const confidence = candidates.length === 1 ? 0.9 :
                      (best.score > 100 ? 0.8 : 0.6);

    return {
        path: best.absPath,
        relativePath: best.relativePath,
        confidence
    };
}

/**
 * Create a stack frame with code context
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File path from stack trace
 * @param {number} lineNum - Line number
 * @param {string|null} funcName - Function name
 * @param {number|null} col - Column number
 * @param {string} rawLine - Raw stack trace line
 * @returns {object} Stack frame with code context
 */
function createStackFrame(index, filePath, lineNum, funcName, col, rawLine) {
    const frame = {
        file: filePath,
        line: lineNum,
        function: funcName,
        column: col,
        raw: rawLine,
        found: false,
        code: null,
        context: null,
        confidence: 0
    };

    // Find the best matching file using improved algorithm
    const match = findBestMatchingFile(index, filePath, funcName, lineNum);

    if (match) {
        const resolvedPath = match.path;
        frame.found = true;
        frame.resolvedFile = match.relativePath;
        frame.confidence = match.confidence;
        if (match.verifiedFunction) {
            frame.verifiedFunction = true;
        }

        try {
            const content = index._readFile(resolvedPath);
            const lines = content.split('\n');

            // Get the exact line
            if (lineNum > 0 && lineNum <= lines.length) {
                frame.code = lines[lineNum - 1];

                // Get context (2 lines before, 2 after)
                const contextLines = [];
                for (let i = Math.max(0, lineNum - 3); i < Math.min(lines.length, lineNum + 2); i++) {
                    contextLines.push({
                        line: i + 1,
                        code: lines[i],
                        isCurrent: i + 1 === lineNum
                    });
                }
                frame.context = contextLines;
            }

            // Try to find function info — always use AST to find enclosing function at this line,
            // then verify against the parsed function name from the stack trace
            const enclosing = index.findEnclosingFunction(resolvedPath, lineNum, true);
            if (funcName) {
                const symbols = index.symbols.get(funcName);
                if (symbols) {
                    const funcMatch = symbols.find(s =>
                        s.file === resolvedPath &&
                        s.startLine <= lineNum && s.endLine >= lineNum
                    );
                    if (funcMatch) {
                        frame.functionInfo = {
                            name: funcMatch.name,
                            startLine: funcMatch.startLine,
                            endLine: funcMatch.endLine,
                            params: funcMatch.params
                        };
                        frame.confidence = 1.0; // High confidence when function verified
                    } else if (enclosing) {
                        // Stack trace function name doesn't match — use AST-resolved function
                        // (source may have changed, or the name was from a transpiled/minified trace)
                        frame.functionInfo = {
                            name: enclosing.name,
                            startLine: enclosing.startLine,
                            endLine: enclosing.endLine,
                            params: enclosing.params,
                            inferred: true,
                            traceName: funcName  // preserve original name from stack trace
                        };
                        frame.confidence = Math.min(frame.confidence, 0.7);
                    } else {
                        // Function name doesn't match AND no enclosing function found
                        const anyMatch = symbols?.find(s => s.file === resolvedPath);
                        if (anyMatch) {
                            frame.functionInfo = {
                                name: anyMatch.name,
                                startLine: anyMatch.startLine,
                                endLine: anyMatch.endLine,
                                params: anyMatch.params,
                                lineMismatch: true
                            };
                            frame.confidence = Math.min(frame.confidence, 0.5);
                        }
                    }
                } else if (enclosing) {
                    // funcName not in symbol table — use AST enclosing function
                    frame.functionInfo = {
                        name: enclosing.name,
                        startLine: enclosing.startLine,
                        endLine: enclosing.endLine,
                        params: enclosing.params,
                        inferred: true,
                        traceName: funcName
                    };
                    frame.confidence = Math.min(frame.confidence, 0.6);
                }
            } else if (enclosing) {
                // No function name in stack - find enclosing function
                frame.functionInfo = {
                    name: enclosing.name,
                    startLine: enclosing.startLine,
                    endLine: enclosing.endLine,
                    params: enclosing.params,
                    inferred: true
                };
            }
        } catch (e) {
            frame.error = e.message;
        }
    }

    return frame;
}

/**
 * Parse a stack trace and show code for each frame
 * @param {object} index - ProjectIndex instance
 * @param {string} stackText - Stack trace text
 * @returns {object} Parsed frames with code context
 */
function parseStackTrace(index, stackText) {
    const frames = [];
    const lines = stackText.split(/\\n|\n/);

    // Stack trace patterns for different languages/runtimes
    // Order matters - more specific patterns first
    const patterns = [
        // JavaScript Node.js: "at functionName (file.js:line:col)" or "at file.js:line:col"
        { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?([^():]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
        // Deno: "at functionName (file:///path/to/file.ts:line:col)"
        { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?file:\/\/([^:]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
        // Bun: "at functionName (file.js:line:col)" - similar to Node but may have different formatting
        { regex: /^\s+at\s+(.+?)\s+\[as\s+\w+\]\s+\(([^:]+):(\d+):(\d+)\)/, extract: (m) => ({ funcName: m[1], file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) }) },
        // Browser Chrome/V8: "at functionName (http://... or file:// ...)"
        { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?(?:https?:\/\/[^/]+)?([^():]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
        // Firefox: "functionName@file:line:col"
        { regex: /^(.+)@(.+):(\d+):(\d+)$/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) }) },
        // Safari: "functionName@file:line:col" (similar to Firefox)
        { regex: /^(.+)@(?:https?:\/\/[^/]+)?([^:]+):(\d+)(?::(\d+))?$/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
        // Python: "File \"file.py\", line N, in function"
        { regex: /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), funcName: m[3] || null, col: null }) },
        // Go: "file.go:line" or "package/file.go:line +0x..."
        { regex: /^\s*([^\s:]+\.go):(\d+)(?:\s|$)/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), funcName: null, col: null }) },
        // Go with function: "package.FunctionName()\n\tfile.go:line"
        { regex: /^\s*([^\s(]+)\(\)$/, extract: null }, // Skip function-only lines
        // Java: "at package.Class.method(File.java:line)"
        { regex: /at\s+([^\(]+)\(([^:]+):(\d+)\)/, extract: (m) => ({ funcName: m[1].split('.').pop(), file: m[2], line: parseInt(m[3]), col: null }) },
        // Rust: "at src/main.rs:line:col" or panic location
        { regex: /(?:at\s+)?([^\s:]+\.rs):(\d+)(?::(\d+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), col: m[3] ? parseInt(m[3]) : null, funcName: null }) },
        // Generic: "file:line" as last resort
        { regex: /([^\s:]+\.\w+):(\d+)(?::(\d+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), col: m[3] ? parseInt(m[3]) : null, funcName: null }) }
    ];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try each pattern until one matches
        for (const pattern of patterns) {
            const match = pattern.regex.exec(trimmed);
            if (match && pattern.extract) {
                const extracted = pattern.extract(match);
                if (extracted && extracted.file && extracted.line) {
                    frames.push(createStackFrame(
                        index,
                        extracted.file,
                        extracted.line,
                        extracted.funcName,
                        extracted.col,
                        trimmed
                    ));
                    break; // Move to next line
                }
            }
        }
    }

    return {
        frameCount: frames.length,
        frames
    };
}

module.exports = { parseStackTrace, findBestMatchingFile, createStackFrame, calculatePathSimilarity };
