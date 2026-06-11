#!/usr/bin/env node

/**
 * Agent understanding benchmark:
 * compares AST-semantic UCN queries vs text/regex baseline heuristics
 * on the same challenging fixture project.
 *
 * Usage:
 *   node test/agent-understanding-benchmark.js
 *   node test/agent-understanding-benchmark.js --runs=5 --verbose
 *   node test/agent-understanding-benchmark.js --fixture test/fixtures/agent-benchmark
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ProjectIndex } = require('..');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const runs = Number(readArgValue(args, '--runs') || 3);
const fixtureArg = readArgValue(args, '--fixture');
const jsonArg = readArgValue(args, '--json');
const mdArg = readArgValue(args, '--md');

const FIXTURE_DIR = path.resolve(fixtureArg || path.join(__dirname, 'fixtures', 'agent-benchmark'));
const REPORT_JSON = path.resolve(jsonArg || path.join(__dirname, 'agent-understanding-benchmark-report.json'));
const REPORT_MD = path.resolve(mdArg || path.join(__dirname, 'agent-understanding-benchmark-report.md'));

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java']);
const TEST_FILE_RE = /(^|[/\\])(test|tests|__tests__|spec|specs)([/\\]|$)|\.(test|spec)\./i;
const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'await',
    'new', 'typeof', 'instanceof', 'in', 'of', 'function'
]);

const TASKS = [
    {
        id: 'T1',
        title: 'Callers of chargeCard (alias-sensitive)',
        kind: 'callers',
        target: 'chargeCard',
        expected: ['processCheckout'],
        comparison: 'exactSet'
    },
    {
        id: 'T2',
        title: 'Callees of processCheckout (semantic call graph)',
        kind: 'callees',
        target: 'processCheckout',
        expected: ['validateOrder', 'calculateTotal', 'withRetry', 'chargeCard', 'chargePaypal', 'save', 'publishOrderCreated', 'getById'],
        comparison: 'containsSet'
    },
    {
        id: 'T3',
        title: 'Verify mismatches for publishOrderCreated',
        kind: 'verify',
        target: 'publishOrderCreated',
        // Hand-verified ground truth: signature (bus, order, source, metadata={})
        // requires 3 args; only checkout-controller.ts:13 passes 2. The earlier
        // expectation of 2 was stale.
        expected: 1,
        comparison: 'numberExact'
    },
    {
        id: 'T4',
        title: 'Tests covering processRefund',
        kind: 'tests',
        target: 'processRefund',
        expected: ['tests/refund.spec.ts'],
        comparison: 'exactSet'
    },
    {
        id: 'T5',
        title: 'Deadcode includes hidden service/util functions',
        kind: 'deadcode',
        expected: ['experimentalFraudCheck', 'formatInternalSnapshot'],
        comparison: 'containsSet'
    }
];

// ── Refactor tasks: "add a parameter to X — find every call site needing an
// edit". Mechanical ground truth: requiredEdits = call-site lines that MUST
// be updated; nonEdits = lines that look relevant (comments, strings, other
// definitions' calls, imports) but must NOT be proposed.
// Three arms: text-baseline (grep), ucn-current (confirmed tier only —
// simulates the pre-contract answer), ucn-contract (confirmed + unverified +
// accounting-driven escalation into unparsed files).
// falseNegativeRate is THE trust metric: a missed required edit is a broken
// refactor an agent ships confidently.
const REFACTOR_TASKS = [
    {
        id: 'R1',
        title: 'Add param to dispatchNote (tiers + duplicate def + unparsed escalation)',
        target: 'dispatchNote',
        resolveOpts: { file: 'dispatcher' },
        unparsedInject: 'legacy/orders-legacy.js',
        requiredEdits: [
            'src/notifications/dispatcher.ts:13',
            'src/notifications/relay.ts:7',
            'src/notifications/forwarder.ts:5',
            'legacy/orders-legacy.js:8',
        ],
        nonEdits: [
            'src/notifications/relay.ts:4',
            'src/notifications/relay.ts:10',
            'src/notifications/relay.ts:11',
            'src/notifications/digest.ts:9',
            'legacy/orders-legacy.js:5',
        ],
    },
    {
        id: 'R2',
        title: 'Add param to applyRebate (alias call — beyond-text)',
        target: 'applyRebate',
        resolveOpts: {},
        requiredEdits: [
            'src/utils/discount.ts:10',
            'src/utils/discount.ts:14',
        ],
        nonEdits: [
            'src/utils/discount.ts:1',
            'src/utils/discount.ts:9',
        ],
    },
];

function readArgValue(argv, key) {
    const eq = argv.find(a => a.startsWith(key + '='));
    if (eq) return eq.slice(key.length + 1);
    const idx = argv.indexOf(key);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
        return argv[idx + 1];
    }
    return null;
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function timed(fn) {
    const started = nowMs();
    try {
        const value = fn();
        return { ok: true, ms: Number((nowMs() - started).toFixed(2)), value };
    } catch (error) {
        return {
            ok: false,
            ms: Number((nowMs() - started).toFixed(2)),
            error: {
                name: error.name || 'Error',
                message: error.message || String(error)
            }
        };
    }
}

function normalizeSet(values) {
    if (!Array.isArray(values)) return [];
    const set = new Set();
    for (const value of values) {
        if (!value) continue;
        set.add(String(value).trim());
    }
    return Array.from(set).sort();
}

function f1Score(predicted, expected) {
    const p = new Set(predicted);
    const e = new Set(expected);
    let intersection = 0;
    for (const item of p) {
        if (e.has(item)) intersection++;
    }
    const precision = p.size === 0 ? (e.size === 0 ? 1 : 0) : intersection / p.size;
    const recall = e.size === 0 ? (p.size === 0 ? 1 : 0) : intersection / e.size;
    const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return {
        precision: Number(precision.toFixed(4)),
        recall: Number(recall.toFixed(4)),
        f1: Number(f1.toFixed(4))
    };
}

function scoreTask(task, predicted) {
    if (task.comparison === 'numberExact') {
        const passed = predicted === task.expected;
        return {
            score: passed ? 1 : 0,
            passed,
            details: {
                expected: task.expected,
                predicted
            }
        };
    }

    const expected = normalizeSet(task.expected);
    const actual = normalizeSet(predicted);

    if (task.comparison === 'exactSet') {
        const { precision, recall, f1 } = f1Score(actual, expected);
        const passed = f1 === 1;
        return {
            score: f1,
            passed,
            details: {
                expected,
                predicted: actual,
                precision,
                recall,
                f1
            }
        };
    }

    if (task.comparison === 'containsSet') {
        const required = new Set(expected);
        let hit = 0;
        for (const item of actual) {
            if (required.has(item)) hit++;
        }
        const coverage = expected.length === 0 ? 1 : hit / expected.length;
        return {
            score: Number(coverage.toFixed(4)),
            passed: coverage === 1,
            details: {
                required: expected,
                predicted: actual,
                coverage: Number(coverage.toFixed(4))
            }
        };
    }

    return { score: 0, passed: false, details: { error: 'Unknown comparison mode' } };
}

function collectSourceFiles(rootDir) {
    const out = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.ucn-cache') continue;
                stack.push(full);
                continue;
            }
            const ext = path.extname(entry.name);
            if (SOURCE_EXTENSIONS.has(ext)) out.push(full);
        }
    }
    out.sort();
    return out;
}

class MeteredReader {
    constructor() {
        this.bytesRead = 0;
        this.readCount = 0;
        this._cache = new Map();
    }

    read(filePath) {
        const cached = this._cache.get(filePath);
        if (cached !== undefined) return cached;
        const content = fs.readFileSync(filePath, 'utf-8');
        this._cache.set(filePath, content);
        this.bytesRead += Buffer.byteLength(content, 'utf-8');
        this.readCount += 1;
        return content;
    }
}

function normalizeLineEnding(text) {
    return text.replace(/\r\n/g, '\n');
}

function findEnclosingFunctionName(lines, idx) {
    for (let i = idx; i >= 0; i--) {
        const line = lines[i];
        let m = line.match(/\bfunction\s+([A-Za-z_]\w*)\s*\(/);
        if (m) return m[1];
        m = line.match(/\bconst\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/);
        if (m) return m[1];
        m = line.match(/\bexport\s+async\s+function\s+([A-Za-z_]\w*)\s*\(/);
        if (m) return m[1];
        m = line.match(/\bexport\s+function\s+([A-Za-z_]\w*)\s*\(/);
        if (m) return m[1];
        m = line.match(/^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*{/);
        if (m) return m[1];
    }
    return null;
}

function parseArgsList(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(',').map(v => v.trim()).filter(Boolean);
}

function extractFunctionBodyByName(reader, files, functionName) {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRegexes = [
        new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
        new RegExp(`\\bexport\\s+function\\s+${escaped}\\s*\\(`),
        new RegExp(`\\bexport\\s+async\\s+function\\s+${escaped}\\s*\\(`)
    ];

    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const lines = content.split('\n');
        let startLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (declRegexes.some(re => re.test(lines[i]))) {
                startLine = i;
                break;
            }
        }
        if (startLine === -1) continue;

        let inBody = false;
        let depth = 0;
        const bodyLines = [];

        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') {
                    depth++;
                    inBody = true;
                } else if (ch === '}') {
                    depth--;
                }
            }
            if (inBody) bodyLines.push(line);
            if (inBody && depth === 0) {
                return bodyLines.join('\n');
            }
        }
    }
    return '';
}

function baselineFindCallers(reader, files, symbolName) {
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(`\\b${escaped}\\s*\\(`);
    const definitionPattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
    const callers = new Set();

    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!callPattern.test(line)) continue;
            if (definitionPattern.test(line)) continue;
            if (/\bimport\b/.test(line) || /\brequire\s*\(/.test(line)) continue;
            const callerName = findEnclosingFunctionName(lines, i);
            if (callerName) callers.add(callerName);
        }
    }

    return normalizeSet(Array.from(callers));
}

function baselineFindCallees(reader, files, functionName) {
    const body = extractFunctionBodyByName(reader, files, functionName);
    if (!body) return [];

    const callees = new Set();
    const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
    let match;
    while ((match = callPattern.exec(body)) !== null) {
        const name = match[1];
        if (!name || KEYWORDS.has(name) || name === functionName) continue;
        callees.add(name);
    }
    return normalizeSet(Array.from(callees));
}

function countRequiredParams(paramsRaw) {
    const params = parseArgsList(paramsRaw);
    let required = 0;
    for (const p of params) {
        if (p.includes('=') || p.includes('?') || p.startsWith('...')) continue;
        required++;
    }
    return { required, total: params.length };
}

function baselineVerifyArity(reader, files, functionName) {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const signaturePattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(([^)]*)\\)`);
    let minArgs = 0;
    let maxArgs = 0;
    let hasSignature = false;

    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const lines = content.split('\n');
        for (const line of lines) {
            const m = line.match(signaturePattern);
            if (m) {
                const counts = countRequiredParams(m[1]);
                minArgs = counts.required;
                maxArgs = counts.total;
                hasSignature = true;
                break;
            }
        }
        if (hasSignature) break;
    }

    if (!hasSignature) return { mismatches: 0 };

    const callPattern = new RegExp(`\\b${escaped}\\s*\\(([^)]*)\\)`, 'g');
    const defPattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
    let mismatches = 0;

    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const lines = content.split('\n');
        for (const line of lines) {
            if (defPattern.test(line)) continue;
            let match;
            while ((match = callPattern.exec(line)) !== null) {
                const args = parseArgsList(match[1]);
                const count = args.length;
                if (count < minArgs || count > maxArgs) {
                    mismatches++;
                }
            }
        }
    }

    return { mismatches };
}

function baselineDeadcode(reader, files) {
    const definitions = new Set();

    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const lines = content.split('\n');
        for (const line of lines) {
            let m = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
            if (m) definitions.add(m[1]);
            m = line.match(/\bconst\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
            if (m) definitions.add(m[1]);
        }
    }

    const dead = [];
    for (const name of definitions) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const callPattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
        let count = 0;
        for (const file of files) {
            const content = normalizeLineEnding(reader.read(file));
            const matches = content.match(callPattern);
            if (matches) count += matches.length;
        }
        if (count <= 1) dead.push(name);
    }

    return normalizeSet(dead);
}

function baselineTestsForSymbol(reader, files, symbolName, projectRoot) {
    const found = new Set();
    const pattern = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

    for (const file of files) {
        const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
        if (!TEST_FILE_RE.test(rel)) continue;
        const content = normalizeLineEnding(reader.read(file));
        if (pattern.test(content)) {
            found.add(rel);
        }
    }
    return normalizeSet(Array.from(found));
}

// ── Refactor arms ───────────────────────────────────────────────────────────

/** Grep proposal set: call-pattern lines, minus definitions and import lines. */
function baselineProposeEdits(reader, files, projectRoot, symbolName) {
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(`\\b${escaped}\\s*\\(`);
    const defPattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
    const proposals = new Set();
    let outputChars = 0;
    for (const file of files) {
        const content = normalizeLineEnding(reader.read(file));
        const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!callPattern.test(line)) continue;
            if (defPattern.test(line)) continue;
            if (/\bimport\b/.test(line) || /\brequire\s*\(/.test(line)) continue;
            proposals.add(`${rel}:${i + 1}`);
            outputChars += line.length;
        }
    }
    return { proposals, outputChars };
}

/** Grep one specific file for call-pattern lines (contract-arm escalation). */
function grepFileForCalls(projectRoot, relFile, symbolName) {
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(`\\b${escaped}\\s*\\(`);
    const defPattern = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
    const out = [];
    let chars = 0;
    try {
        const lines = fs.readFileSync(path.join(projectRoot, relFile), 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!callPattern.test(lines[i])) continue;
            if (defPattern.test(lines[i])) continue;
            if (/\bimport\b/.test(lines[i]) || /\brequire\s*\(/.test(lines[i])) continue;
            out.push(`${relFile}:${i + 1}`);
            chars += lines[i].length;
        }
    } catch (e) { /* unreadable — nothing to escalate into */ }
    return { proposals: out, chars };
}

function scoreRefactorArm(task, proposals) {
    const required = new Set(task.requiredEdits);
    const hits = task.requiredEdits.filter(e => proposals.has(e));
    const missed = task.requiredEdits.filter(e => !proposals.has(e));
    const truePositives = [...proposals].filter(p => required.has(p)).length;
    return {
        proposed: [...proposals].sort(),
        requiredCount: task.requiredEdits.length,
        hitCount: hits.length,
        missed,
        falseNegativeRate: Number(((task.requiredEdits.length - hits.length) / task.requiredEdits.length).toFixed(4)),
        precision: proposals.size === 0 ? 0 : Number((truePositives / proposals.size).toFixed(4)),
        broken: missed.length > 0,
    };
}

function runRefactorBenchmark(projectRoot) {
    // One index for the ucn arms, with the legacy parse-failure injected so the
    // unparsed-escalation property is exercised under identical conditions.
    const index = new ProjectIndex(projectRoot);
    index.build(null, { quiet: true });
    for (const task of REFACTOR_TASKS) {
        if (!task.unparsedInject) continue;
        const abs = path.join(index.root, task.unparsedInject);
        if (index.files.has(abs)) {
            index.removeFileSymbols(abs);
            index.files.delete(abs);
            index.failedFiles.add(abs);
        }
    }

    const reader = new MeteredReader();
    const files = collectSourceFiles(projectRoot);
    const perTask = [];

    for (const task of REFACTOR_TASKS) {
        const ctx = index.context(task.target, task.resolveOpts);
        if (!ctx) {
            perTask.push({ id: task.id, error: `cannot resolve ${task.target}` });
            continue;
        }
        const { formatContext } = require('../core/output');
        const ucnText = formatContext(ctx).text;
        const account = ctx.meta && ctx.meta.account;

        // Arm 1: text-baseline
        const base = baselineProposeEdits(reader, files, index.root, task.target);
        const baseline = scoreRefactorArm(task, base.proposals);
        baseline.outputChars = base.outputChars;

        // Arm 2: ucn-current — confirmed tier only (the pre-contract answer)
        const confirmedSet = new Set(ctx.callers.map(c => `${c.relativePath}:${c.line}`));
        const current = scoreRefactorArm(task, confirmedSet);
        current.outputChars = ucnText.length;

        // Arm 3: ucn-contract — confirmed + unverified + accounting escalation
        const contractSet = new Set(confirmedSet);
        for (const u of (ctx.unverifiedCallers || [])) contractSet.add(`${u.relativePath}:${u.line}`);
        let escalationChars = 0;
        if (account && account.unparsed && account.unparsed.files.length > 0) {
            // The WARNING line tells the agent these files were NOT analyzed —
            // fall back to text search for exactly those files.
            for (const relFile of account.unparsed.files) {
                const esc = grepFileForCalls(index.root, relFile, task.target);
                for (const p of esc.proposals) contractSet.add(p);
                escalationChars += esc.chars;
            }
        }
        const contract = scoreRefactorArm(task, contractSet);
        contract.outputChars = ucnText.length + escalationChars;

        perTask.push({
            id: task.id,
            title: task.title,
            target: task.target,
            requiredEdits: task.requiredEdits,
            arms: { baseline, ucnCurrent: current, ucnContract: contract },
        });
    }

    const armSummary = (key) => {
        const rows = perTask.filter(t => !t.error).map(t => t.arms[key]);
        if (rows.length === 0) return null;
        return {
            falseNegativeRate: Number((rows.reduce((s, r) => s + r.falseNegativeRate, 0) / rows.length).toFixed(4)),
            brokenCallerRate: Number((rows.filter(r => r.broken).length / rows.length).toFixed(4)),
            precision: Number((rows.reduce((s, r) => s + r.precision, 0) / rows.length).toFixed(4)),
            avgOutputChars: Math.round(rows.reduce((s, r) => s + r.outputChars, 0) / rows.length),
        };
    };

    return {
        perTask,
        summary: {
            baseline: armSummary('baseline'),
            ucnCurrent: armSummary('ucnCurrent'),
            ucnContract: armSummary('ucnContract'),
        },
    };
}

function runUcnMode(projectRoot, tasks) {
    const build = timed(() => {
        const index = new ProjectIndex(projectRoot);
        index.build(null, { quiet: true });
        return index;
    });
    if (!build.ok) {
        return { ok: false, buildMs: build.ms, error: build.error };
    }
    const index = build.value;
    let outputBytes = 0;
    const taskResults = [];

    for (const task of tasks) {
        const measured = timed(() => {
            switch (task.kind) {
                case 'callers': {
                    const callers = index.findCallers(task.target, { includeMethods: true, includeUncertain: true });
                    return normalizeSet(callers.map(c => c.callerName).filter(Boolean));
                }
                case 'callees': {
                    const { def } = index.resolveSymbol(task.target);
                    if (!def) return [];
                    const callees = index.findCallees(def, { includeMethods: true, includeUncertain: true });
                    return normalizeSet(callees.map(c => c.name));
                }
                case 'verify': {
                    const result = index.verify(task.target, {});
                    return result ? result.mismatches : 0;
                }
                case 'tests': {
                    const result = index.tests(task.target, {});
                    return normalizeSet(result.map(r => r.file));
                }
                case 'deadcode': {
                    const result = index.deadcode({});
                    return normalizeSet(result.map(r => r.name));
                }
                default:
                    throw new Error(`Unsupported task kind: ${task.kind}`);
            }
        });

        const predicted = measured.ok ? measured.value : null;
        if (predicted != null) {
            outputBytes += Buffer.byteLength(JSON.stringify(predicted), 'utf-8');
        }

        const scoring = measured.ok ? scoreTask(task, predicted) : {
            score: 0,
            passed: false,
            details: { error: measured.error }
        };

        taskResults.push({
            id: task.id,
            title: task.title,
            kind: task.kind,
            ok: measured.ok,
            ms: measured.ms,
            predicted,
            expected: task.expected,
            score: scoring.score,
            passed: scoring.passed,
            details: scoring.details,
            ...(measured.ok ? {} : { error: measured.error })
        });
    }

    return {
        ok: true,
        buildMs: build.ms,
        outputBytes,
        taskResults
    };
}

function runBaselineMode(projectRoot, tasks) {
    const reader = new MeteredReader();
    const files = collectSourceFiles(projectRoot);
    const taskResults = [];

    for (const task of tasks) {
        const measured = timed(() => {
            switch (task.kind) {
                case 'callers':
                    return baselineFindCallers(reader, files, task.target);
                case 'callees':
                    return baselineFindCallees(reader, files, task.target);
                case 'verify':
                    return baselineVerifyArity(reader, files, task.target).mismatches;
                case 'tests':
                    return baselineTestsForSymbol(reader, files, task.target, projectRoot);
                case 'deadcode':
                    return baselineDeadcode(reader, files);
                default:
                    throw new Error(`Unsupported task kind: ${task.kind}`);
            }
        });

        const predicted = measured.ok ? measured.value : null;
        const scoring = measured.ok ? scoreTask(task, predicted) : {
            score: 0,
            passed: false,
            details: { error: measured.error }
        };

        taskResults.push({
            id: task.id,
            title: task.title,
            kind: task.kind,
            ok: measured.ok,
            ms: measured.ms,
            predicted,
            expected: task.expected,
            score: scoring.score,
            passed: scoring.passed,
            details: scoring.details,
            ...(measured.ok ? {} : { error: measured.error })
        });
    }

    return {
        ok: true,
        buildMs: 0,
        bytesRead: reader.bytesRead,
        readCount: reader.readCount,
        taskResults
    };
}

function summarizeRun(modeResult) {
    const tasks = modeResult.taskResults || [];
    const totalScore = tasks.reduce((sum, t) => sum + (typeof t.score === 'number' ? t.score : 0), 0);
    const passed = tasks.filter(t => t.passed).length;
    const totalTaskMs = tasks.reduce((sum, t) => sum + (t.ms || 0), 0);
    const avgTaskMs = tasks.length > 0 ? totalTaskMs / tasks.length : 0;
    return {
        taskCount: tasks.length,
        passCount: passed,
        passRate: Number((tasks.length > 0 ? passed / tasks.length : 0).toFixed(4)),
        avgScore: Number((tasks.length > 0 ? totalScore / tasks.length : 0).toFixed(4)),
        totalTaskMs: Number(totalTaskMs.toFixed(2)),
        avgTaskMs: Number(avgTaskMs.toFixed(2)),
        buildMs: Number((modeResult.buildMs || 0).toFixed(2))
    };
}

function aggregateStats(samples) {
    if (!samples || samples.length === 0) return null;
    const keys = Object.keys(samples[0]);
    const out = {};
    for (const key of keys) {
        if (typeof samples[0][key] !== 'number') continue;
        const sum = samples.reduce((acc, s) => acc + s[key], 0);
        out[key] = Number((sum / samples.length).toFixed(4));
    }
    return out;
}

function formatMarkdown(report) {
    const lines = [];
    lines.push('# Agent Understanding Benchmark');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Fixture: ${report.fixtureDir}`);
    lines.push(`Runs: ${report.runs}`);
    lines.push('');

    lines.push('## Average Summary');
    lines.push('');
    lines.push('| Mode | pass_rate | avg_score | build_ms | avg_task_ms | total_task_ms | size_proxy |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    lines.push(`| ucn | ${report.summary.ucn.passRate} | ${report.summary.ucn.avgScore} | ${report.summary.ucn.buildMs} | ${report.summary.ucn.avgTaskMs} | ${report.summary.ucn.totalTaskMs} | ${report.summary.ucn.outputBytes || 0} |`);
    lines.push(`| baseline | ${report.summary.baseline.passRate} | ${report.summary.baseline.avgScore} | ${report.summary.baseline.buildMs} | ${report.summary.baseline.avgTaskMs} | ${report.summary.baseline.totalTaskMs} | ${report.summary.baseline.bytesRead || 0} |`);
    lines.push('');

    lines.push('## Task Results (Last Run)');
    lines.push('');
    lines.push('| Task | UCN score | Baseline score | UCN ms | Baseline ms |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const task of report.lastRun.tasks) {
        lines.push(`| ${task.id} ${task.title} | ${task.ucn.score} | ${task.baseline.score} | ${task.ucn.ms} | ${task.baseline.ms} |`);
    }
    lines.push('');

    if (report.refactor) {
        lines.push('## Refactor Arms (broken-refactor benchmark)');
        lines.push('');
        lines.push('"Add a parameter to X — find every call site." `FN rate` = missed');
        lines.push('required edits (each one is a broken refactor shipped confidently).');
        lines.push('Arms: text grep baseline · ucn-current (confirmed tier only, the');
        lines.push('pre-contract answer) · ucn-contract (confirmed + unverified +');
        lines.push('unparsed-file escalation).');
        lines.push('');
        lines.push('| Arm | FN rate | broken-refactor rate | precision | avg output chars |');
        lines.push('|---|---:|---:|---:|---:|');
        for (const [arm, s] of Object.entries(report.refactor.summary)) {
            if (!s) continue;
            lines.push(`| ${arm} | ${s.falseNegativeRate} | ${s.brokenCallerRate} | ${s.precision} | ${s.avgOutputChars} |`);
        }
        lines.push('');
        for (const t of report.refactor.perTask) {
            if (t.error) { lines.push(`- ${t.id}: ERROR ${t.error}`); continue; }
            lines.push(`### ${t.id} ${t.title}`);
            lines.push('');
            for (const [arm, r] of Object.entries(t.arms)) {
                lines.push(`- **${arm}**: hit ${r.hitCount}/${r.requiredCount}, precision ${r.precision}` +
                    (r.missed.length ? `, missed: ${r.missed.join(', ')}` : ''));
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

function assertFixtureExists() {
    if (!fs.existsSync(FIXTURE_DIR)) {
        console.error(`Fixture not found: ${FIXTURE_DIR}`);
        process.exit(1);
    }
}

function main() {
    assertFixtureExists();

    const ucnSummaries = [];
    const baselineSummaries = [];
    const runDetails = [];

    for (let i = 0; i < runs; i++) {
        if (verbose) {
            console.error(`[run ${i + 1}/${runs}] executing UCN mode...`);
        }
        const ucn = runUcnMode(FIXTURE_DIR, TASKS);
        if (!ucn.ok) {
            console.error(`UCN mode failed: ${ucn.error?.message || 'unknown error'}`);
            process.exit(1);
        }

        if (verbose) {
            console.error(`[run ${i + 1}/${runs}] executing baseline mode...`);
        }
        const baseline = runBaselineMode(FIXTURE_DIR, TASKS);
        if (!baseline.ok) {
            console.error('Baseline mode failed');
            process.exit(1);
        }

        const ucnSummary = summarizeRun(ucn);
        ucnSummary.outputBytes = ucn.outputBytes || 0;
        const baselineSummary = summarizeRun(baseline);
        baselineSummary.bytesRead = baseline.bytesRead || 0;
        baselineSummary.readCount = baseline.readCount || 0;

        ucnSummaries.push(ucnSummary);
        baselineSummaries.push(baselineSummary);

        runDetails.push({
            run: i + 1,
            ucn,
            baseline
        });
    }

    const summary = {
        ucn: aggregateStats(ucnSummaries),
        baseline: aggregateStats(baselineSummaries)
    };

    // Refactor arms (deterministic — single run)
    const refactor = runRefactorBenchmark(FIXTURE_DIR);

    const last = runDetails[runDetails.length - 1];
    const lastTasks = TASKS.map(task => {
        const ucnTask = last.ucn.taskResults.find(t => t.id === task.id);
        const baseTask = last.baseline.taskResults.find(t => t.id === task.id);
        return {
            id: task.id,
            title: task.title,
            ucn: {
                score: ucnTask ? ucnTask.score : 0,
                ms: ucnTask ? ucnTask.ms : 0
            },
            baseline: {
                score: baseTask ? baseTask.score : 0,
                ms: baseTask ? baseTask.ms : 0
            }
        };
    });

    const report = {
        generatedAt: new Date().toISOString(),
        fixtureDir: FIXTURE_DIR,
        runs,
        tasks: TASKS,
        summary,
        refactor,
        runDetails,
        lastRun: {
            tasks: lastTasks
        }
    };

    fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    fs.writeFileSync(REPORT_MD, formatMarkdown(report));

    console.log(`Agent benchmark complete.`);
    console.log(`  JSON: ${REPORT_JSON}`);
    console.log(`  MD:   ${REPORT_MD}`);
    console.log(`  UCN avg_score=${summary.ucn.avgScore}, pass_rate=${summary.ucn.passRate}, avg_task_ms=${summary.ucn.avgTaskMs}`);
    console.log(`  Baseline avg_score=${summary.baseline.avgScore}, pass_rate=${summary.baseline.passRate}, avg_task_ms=${summary.baseline.avgTaskMs}`);
    console.log('  Refactor arms (falseNegativeRate / brokenCallerRate / precision / outputChars):');
    for (const [arm, s] of Object.entries(refactor.summary)) {
        if (!s) continue;
        console.log(`    ${arm}: FN=${s.falseNegativeRate} broken=${s.brokenCallerRate} precision=${s.precision} chars=${s.avgOutputChars}`);
    }
}

main();
