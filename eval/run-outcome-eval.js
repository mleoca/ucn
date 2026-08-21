#!/usr/bin/env node

/**
 * eval/run-outcome-eval.js - Task-outcome eval: paired, held-out,
 * toolchain-judged agent tasks.
 *
 * The oracle/conservation/deadcode evals measure ANSWER quality. This
 * instrument measures TASK outcomes: the same mechanical task executed by
 * fixed scripted policies ("arms") that differ only in the discovery tool
 * available, judged by the language toolchain — never by the engine's own
 * metrics and never by model judgment.
 *
 * Tasks (v1):
 *   rename       - "rename symbol S to S2 and update every reference."
 *                  Arms propose the reference sites; the harness applies the
 *                  definition rename plus each arm's proposed edits
 *                  mechanically, then the toolchain decides: any NEW error
 *                  vs the pristine baseline = a broken refactor shipped
 *                  confidently (generalizes brokenCallerRate to real repos).
 *   safe-delete  - "can S's definition be deleted?" Arms give a verdict; the
 *                  harness applies one standard deletion (def range + import
 *                  strips) and the toolchain outcome is ground truth.
 *                  falseSafe (said safe, build broke) is the dangerous
 *                  direction; falseUnsafe is only an upper bound because a
 *                  compile-clean deletion can still be runtime-unsafe.
 *
 * Arms:
 *   grep           - word-boundary text search over source files (what a
 *                    grep-only agent does; comments/strings included).
 *   ucn-confirmed  - `plan --rename-to` confirmed changes only / `show`
 *                    confirmed callers only (a tier-blind agent).
 *   ucn-contract   - + visible unverified sites + escalation into files the
 *                    account discloses as unparsed/unsupported (the
 *                    trust-contract-following agent).
 * UCN arms go through the PUBLIC CLI (command selection, transport and
 * output costs included); cost = text-mode output chars + tool calls +
 * warm wall ms. The grep arm pays scanned bytes + matched-line chars.
 *
 * Judges: go vet ./... | cargo check --workspace --all-targets | pyright.
 * Known blind spots (disclosed in the report): dynamic-dispatch sites the
 * type-checker cannot see (untyped Python receivers), string/comment damage,
 * and runtime-only breakage — verdicts are lower bounds on breakage.
 *
 * Holdout discipline: repos come from OUTCOME_POOL (unpinned, HEAD recorded;
 * never used to tune a fix). Pinned-board repos can be forced via --repo for
 * cross-checks; the report marks them tunedRepo:true.
 *
 * This is a measurement instrument, not a gate: exit 1 means infrastructure
 * failure (toolchain missing, judge crashed), never a metric level.
 *
 * Usage:
 *   node eval/run-outcome-eval.js                       # whole OUTCOME_POOL
 *   node eval/run-outcome-eval.js --repo websocket
 *   node eval/run-outcome-eval.js --repo flask --rename-tasks 8 --delete-tasks 4
 *   node eval/run-outcome-eval.js --seed 7
 *   node eval/run-outcome-eval.js --tuned               # pinned OUTCOME_TUNED set
 *   node eval/run-outcome-eval.js --gate                # tuned set + hard thresholds (exit 1)
 *   node eval/run-outcome-eval.js --oracle-targets      # LSP-enumerated candidate universe
 *   node eval/run-outcome-eval.js --seeds 42,7,101      # one board per seed
 *   node eval/run-outcome-eval.js --repo gson --targets gson/src/.../JsonArray.java:106:add
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    REPOS,
    FRESH_POOL,
    OUTCOME_POOL,
    OUTCOME_TUNED = [],
    cloneAtCommit,
    resolveFreshCommit,
    seededRandom,
} = require('./lib/repos');
const policy = require('./outcome-policy');
const { ProjectIndex } = require('..');
const { isTestPath } = require('../core/shared');

const CLI_PATH = path.join(__dirname, '..', 'cli', 'index.js');
const REPORTS_DIR = path.join(__dirname, 'reports');
const OUTCOME_TEMP_DIR = path.join(require('os').tmpdir(), 'ucn-outcome-repos');
const PYRIGHT_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'pyright');

const ARMS = ['grep', 'ucn-confirmed', 'ucn-contract'];
const RENAME_SUFFIX = '_ucnq';
const MAX_BUFFER = 64 * 1024 * 1024;

const LANG_EXTENSIONS = {
    go: ['.go'],
    python: ['.py'],
    rust: ['.rs'],
    java: ['.java'],
    typescript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ucn-cache', 'target',
    '__pycache__', '.venv', 'venv', 'dist', 'build']);

const { codeUnitCompare } = policy;

function readArgValue(argv, key) {
    const equals = argv.find(arg => arg.startsWith(`${key}=`));
    if (equals) return equals.slice(key.length + 1);
    const index = argv.indexOf(key);
    if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        return argv[index + 1];
    }
    return null;
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

// ── Repo file inventory ─────────────────────────────────────────────────────

function collectSourceFiles(repoPath, language) {
    const extensions = new Set(LANG_EXTENSIONS[language] || []);
    const contentByFile = new Map();
    const stack = [repoPath];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') && entry.name !== '.') continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) stack.push(absolute);
                continue;
            }
            if (!extensions.has(path.extname(entry.name))) continue;
            const relative = path.relative(repoPath, absolute).replace(/\\/g, '/');
            try {
                contentByFile.set(relative, fs.readFileSync(absolute, 'utf8'));
            } catch (_) { /* unreadable — outside every arm's universe */ }
        }
    }
    return contentByFile;
}

// ── Public-CLI invocation (the UCN arms' only engine access) ────────────────

function runCli(repoPath, args, { json } = {}) {
    const argv = [CLI_PATH, repoPath, ...args, ...(json ? ['--json'] : [])];
    const started = nowMs();
    const result = spawnSync(process.execPath, argv, {
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0 && !result.error,
        ms: Number((nowMs() - started).toFixed(1)),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? result.error.message : null,
    };
}

function cliJson(repoPath, args) {
    const run = runCli(repoPath, args, { json: true });
    if (!run.ok) return { ok: false, error: run.stderr || run.error, ms: run.ms };
    try {
        return { ok: true, doc: JSON.parse(run.stdout), ms: run.ms };
    } catch (error) {
        return { ok: false, error: `JSON parse: ${error.message}`, ms: run.ms };
    }
}

// ── Toolchain judges ────────────────────────────────────────────────────────

function spawnJudge(command, args, cwd) {
    const started = nowMs();
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        timeout: 900000,
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
        throw new Error(`judge ${command} ${args.join(' ')}: ${result.error.message}`);
    }
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        ms: Number((nowMs() - started).toFixed(0)),
    };
}

function makeJudge(repo, repoPath) {
    switch (repo.language) {
        case 'go':
            return {
                label: 'go vet ./...',
                run() {
                    const out = spawnJudge('go', ['vet', './...'], repoPath);
                    return { keys: policy.parseGoErrors(`${out.stdout}\n${out.stderr}`), ms: out.ms };
                },
            };
        case 'rust':
            return {
                label: 'cargo check --workspace --all-targets',
                run() {
                    const out = spawnJudge('cargo',
                        ['check', '--workspace', '--all-targets', '--message-format=short'],
                        repoPath);
                    return { keys: policy.parseCargoErrors(`${out.stdout}\n${out.stderr}`), ms: out.ms };
                },
            };
        case 'python':
            return {
                label: 'pyright --outputjson',
                run() {
                    const out = spawnJudge(PYRIGHT_BIN, ['--outputjson', '.'], repoPath);
                    let doc;
                    try {
                        doc = JSON.parse(out.stdout);
                    } catch (error) {
                        throw new Error(
                            `pyright output unparseable: ${error.message}`, { cause: error });
                    }
                    return { keys: policy.parsePyrightErrors(doc, fs.realpathSync(repoPath)), ms: out.ms };
                },
            };
        case 'java': {
            const javac = resolveJavac();
            const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ucn-javac-'));
            return {
                // Main source set only: test sources need external deps
                // (junit etc.) a bare javac cannot resolve, so breakage in
                // test files is INVISIBLE to this judge (disclosed). Missing
                // third-party imports in main sources produce stable errors
                // the baseline diff removes.
                label: 'javac (main source set — test sources not judged)',
                run() {
                    const sources = collectJavaSources(repoPath);
                    if (sources.length === 0) throw new Error('no java sources found');
                    const argFile = path.join(outDir, 'sources.txt');
                    // Repo-relative paths (cwd is repoPath): javac echoes
                    // them verbatim, so error keys come out relative.
                    fs.writeFileSync(argFile, sources.map(source =>
                        `"${path.relative(repoPath, source).replace(/\\/g, '/')}"`).join('\n'));
                    const out = spawnJudge(javac, ['-d', path.join(outDir, 'classes'),
                        '-proc:none', '-nowarn', '-Xmaxerrs', '10000',
                        `@${argFile}`], repoPath);
                    return {
                        keys: policy.parseJavacErrors(`${out.stdout}\n${out.stderr}`),
                        ms: out.ms,
                    };
                },
            };
        }
        default:
            return null;
    }
}

/** JDK 17+ javac, mirroring the jdtls oracle's resolution chain:
 *  $UCN_EVAL_JAVA (path to java — sibling javac), $JAVA_HOME, PATH, then
 *  Homebrew's keg-only openjdk. macOS ships a /usr/bin/javac STUB that
 *  errors "Unable to locate a Java Runtime" — the -version probe filters it. */
function resolveJavac() {
    const candidates = [
        process.env.UCN_EVAL_JAVA &&
            path.join(path.dirname(process.env.UCN_EVAL_JAVA), 'javac'),
        process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'javac'),
        'javac',
        '/opt/homebrew/opt/openjdk/bin/javac',
        '/usr/local/opt/openjdk/bin/javac',
    ].filter(Boolean);
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 30000 });
        if (probe.status === 0 && !probe.error) return candidate;
    }
    throw new Error('javac (JDK 17+) not found — set UCN_EVAL_JAVA or JAVA_HOME');
}

/** Main-source-set .java files (Maven `src/main/java` trees when present,
 *  else every non-test .java). Listed fresh per judge run — deletions and
 *  renames change the set. */
function collectJavaSources(repoPath) {
    const sources = [];
    const mainRoots = [];
    const stack = [repoPath];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
            const absolute = path.join(current, entry.name);
            if (!entry.isDirectory()) continue;
            if (entry.name === 'src' &&
                fs.existsSync(path.join(absolute, 'main', 'java'))) {
                mainRoots.push(path.join(absolute, 'main', 'java'));
            } else {
                stack.push(absolute);
            }
        }
    }
    const collect = (root, filter) => {
        const dirs = [root];
        while (dirs.length > 0) {
            const current = dirs.pop();
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
                const absolute = path.join(current, entry.name);
                if (entry.isDirectory()) { dirs.push(absolute); continue; }
                if (!entry.name.endsWith('.java')) continue;
                if (filter && !filter(absolute)) continue;
                sources.push(absolute);
            }
        }
    };
    if (mainRoots.length > 0) {
        for (const root of mainRoots.sort(codeUnitCompare)) collect(root);
    } else {
        collect(repoPath, absolute =>
            !isTestPath(path.relative(repoPath, absolute).replace(/\\/g, '/')));
    }
    return sources.sort(codeUnitCompare);
}

function restoreRepo(repoPath) {
    const result = spawnSync('git', ['checkout', '-q', '--', '.'], {
        cwd: repoPath, encoding: 'utf8', timeout: 120000,
    });
    if (result.status !== 0 || result.error) {
        throw new Error(`git restore failed in ${repoPath}: ` +
            `${result.stderr || (result.error && result.error.message)}`);
    }
}

// ── Task sampling ───────────────────────────────────────────────────────────

function defNameLine(contentByFile, relativePath, def, name) {
    const content = contentByFile.get(relativePath);
    if (!content) return null;
    const lines = content.split('\n');
    const pattern = policy.identifierRegex(name);
    const end = Math.min(lines.length, def.endLine || def.startLine);
    for (let lineNo = def.startLine; lineNo <= end; lineNo++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[lineNo - 1] || '')) return lineNo;
    }
    return null;
}

function candidateDefs(index, repo, contentByFile) {
    const extensions = new Set(LANG_EXTENSIONS[repo.language] || []);
    const skipNames = new Set(['main', 'init', '__init__']);
    const out = [];
    for (const [name, defs] of index.symbols) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        if (name.length < 3 || skipNames.has(name) || /^__.*__$/.test(name)) continue;
        for (const def of defs) {
            if (def.type !== 'function' && def.type !== 'method') continue;
            if (!extensions.has(path.extname(def.file))) continue;
            const relativePath = path.relative(index.root, def.file).replace(/\\/g, '/');
            if (isTestPath(relativePath)) continue;
            if (def.traitName || def.traitImpl) continue; // contract-bound member
            if (!contentByFile.has(relativePath)) continue;
            const nameLine = defNameLine(contentByFile, relativePath, def, name);
            if (nameLine == null) continue;
            out.push({
                name,
                relativePath,
                startLine: def.startLine,
                endLine: def.endLine || def.startLine,
                nameLine,
                type: def.type,
                className: def.className || null,
                sameNameDefs: defs.length,
            });
        }
    }
    return out.sort((a, b) => codeUnitCompare(a.relativePath, b.relativePath) ||
        a.startLine - b.startLine || codeUnitCompare(a.name, b.name));
}

// ── Oracle-enumerated targets (kills sampling self-selection) ───────────────
//
// Default sampling draws candidates from index.symbols, so a definition UCN
// fails to index can never become a task — the eval can't see its own
// blind spots. --oracle-targets enumerates the candidate universe from the
// language server's symbol list instead (the same oracles the caller eval
// trusts), matches each oracle def back to the index, and keeps the
// unmatched ones as rename-only tasks where the UCN arms take a measured
// penalty (empty proposals) instead of the task silently disappearing.
// Used for HOLDOUT measurement runs; the pinned --gate keeps index-based
// sampling (deterministic, no LSP dependence on the gating path).

const ORACLE_BY_LANGUAGE = {
    go: () => require('./oracles/gopls-oracle').goplsOracle,
    python: () => require('./oracles/pyright-oracle').pyrightOracle,
    rust: () => require('./oracles/rust-analyzer-oracle').rustAnalyzerOracle,
};

async function oracleCandidateDefs(repo, repoPath, index, contentByFile, log) {
    const loadOracle = ORACLE_BY_LANGUAGE[repo.language];
    if (!loadOracle) {
        throw new Error(`--oracle-targets: no symbol oracle for ${repo.language}`);
    }
    const oracle = loadOracle();
    let handle = null;
    try {
        handle = await oracle.prepare(repoPath);
        const symbols = await oracle.listSymbols(handle,
            { kinds: ['function', 'method'] });
        log(`oracle ${oracle.name} lists ${symbols.length} function/method symbols`);

        // Index defs by name+file for containment matching (oracle lines
        // follow UCN's start-line conventions per the oracle invariants;
        // containment absorbs decorator/attribute line deltas).
        const indexed = candidateDefs(index, repo, contentByFile);
        const byNameFile = new Map();
        for (const candidate of indexed) {
            const key = `${candidate.name}\0${candidate.relativePath}`;
            if (!byNameFile.has(key)) byNameFile.set(key, []);
            byNameFile.get(key).push(candidate);
        }

        const matched = [];
        const missing = [];
        const seen = new Set();
        for (const symbol of symbols) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol.name)) continue;
            if (symbol.name.length < 3 || /^__.*__$/.test(symbol.name)) continue;
            if (isTestPath(symbol.file)) continue;
            const dedupeKey = `${symbol.name}\0${symbol.file}\0${symbol.line}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const candidates = byNameFile.get(`${symbol.name}\0${symbol.file}`) || [];
            const hit = candidates.find(candidate =>
                symbol.line >= candidate.startLine && symbol.line <= candidate.endLine);
            if (hit) {
                if (!hit.oracleEnumerated) {
                    hit.oracleEnumerated = true;
                    matched.push(hit);
                }
                continue;
            }
            // Not in UCN's index — a rename-only task IF the name occurs on
            // the oracle's definition line (the harness needs a def line to
            // rename). No range → no delete task.
            const content = contentByFile.get(symbol.file);
            const lineText = content ? (content.split('\n')[symbol.line - 1] || '') : '';
            const pattern = policy.identifierRegex(symbol.name);
            pattern.lastIndex = 0;
            if (!pattern.test(lineText)) continue;
            missing.push({
                name: symbol.name,
                relativePath: symbol.file,
                startLine: symbol.line,
                endLine: symbol.line,
                nameLine: symbol.line,
                type: symbol.kind,
                className: null,
                sameNameDefs: (index.symbols.get(symbol.name) || []).length,
                indexMissing: true,
            });
        }
        missing.sort((a, b) => codeUnitCompare(a.relativePath, b.relativePath) ||
            a.startLine - b.startLine || codeUnitCompare(a.name, b.name));
        return {
            oracleName: oracle.name,
            oracleSymbols: seen.size,
            matched,
            missing,
            all: [...matched, ...missing].sort((a, b) =>
                codeUnitCompare(a.relativePath, b.relativePath) ||
                a.startLine - b.startLine || codeUnitCompare(a.name, b.name)),
        };
    } finally {
        if (handle && oracle.dispose) await oracle.dispose(handle);
    }
}

function sampleWithout(candidates, count, rand) {
    const pool = [...candidates];
    const picked = [];
    while (picked.length < count && pool.length > 0) {
        const index = Math.floor(rand() * pool.length);
        picked.push(pool.splice(index, 1)[0]);
    }
    return picked;
}

/** Count word-boundary occurrences outside the definition's own range. */
function occurrencesOutsideDef(contentByFile, candidate) {
    const pattern = policy.identifierRegex(candidate.name);
    let count = 0;
    for (const [file, content] of contentByFile) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            pattern.lastIndex = 0;
            if (!pattern.test(lines[i])) continue;
            if (file === candidate.relativePath &&
                i + 1 >= candidate.startLine && i + 1 <= candidate.endLine) continue;
            count++;
        }
    }
    return count;
}

// ── Rename task ─────────────────────────────────────────────────────────────

function collectRenameProposals(repoPath, contentByFile, task) {
    const handle = `${task.relativePath}:${task.startLine}:${task.name}`;
    const newName = task.name + RENAME_SUFFIX;
    const planJson = cliJson(repoPath,
        ['plan', handle, `--rename-to=${newName}`]);
    if (!planJson.ok && task.indexMissing) {
        // Oracle-enumerated def UCN never indexed: the UCN arms cannot plan
        // it. That is a measured outcome (empty proposals — the def rename
        // alone ships, and existing references break), never a dropped task.
        const grepStarted = nowMs();
        const grep = policy.grepProposal(contentByFile, task.name);
        const grepMs = Number((nowMs() - grepStarted).toFixed(1));
        const failedCost = {
            outputChars: (planJson.error || '').length,
            toolCalls: 1,
            wallMs: planJson.ms || 0,
        };
        return {
            newName,
            handle,
            planFailedIndexMissing: true,
            arms: {
                grep: {
                    sites: grep.sites,
                    cost: {
                        outputChars: grep.outputChars,
                        scannedBytes: grep.scannedBytes,
                        toolCalls: 1,
                        wallMs: grepMs,
                    },
                },
                'ucn-confirmed': { sites: [], planFailed: true, cost: failedCost },
                'ucn-contract': { sites: [], planFailed: true, cost: failedCost },
            },
        };
    }
    if (!planJson.ok) return { error: `plan failed: ${planJson.error}` };
    const planText = runCli(repoPath, ['plan', handle, `--rename-to=${newName}`]);
    const planData = planJson.doc.data || {};

    const confirmed = policy.armSitesFromPlan(planData, 'confirmed');
    const contract = policy.armSitesFromPlan(planData, 'contract');

    // Contract-arm escalation: the account names files the engine never
    // analyzed — the agent greps exactly those (each one a tool call).
    let escalationChars = 0;
    let escalationCalls = 0;
    for (const file of contract.escalationFiles) {
        const content = contentByFile.get(file);
        if (content == null) continue;
        escalationCalls++;
        const single = policy.grepProposal(new Map([[file, content]]), task.name);
        escalationChars += single.outputChars;
        for (const site of single.sites) contract.sites.push(site);
    }

    const grepStarted = nowMs();
    const grep = policy.grepProposal(contentByFile, task.name);
    const grepMs = Number((nowMs() - grepStarted).toFixed(1));

    return {
        newName,
        handle,
        arms: {
            grep: {
                sites: grep.sites,
                cost: {
                    outputChars: grep.outputChars,
                    scannedBytes: grep.scannedBytes,
                    toolCalls: 1,
                    wallMs: grepMs,
                },
            },
            'ucn-confirmed': {
                sites: confirmed.sites,
                cost: {
                    outputChars: planText.stdout.length,
                    toolCalls: 1,
                    wallMs: planText.ms,
                },
            },
            'ucn-contract': {
                sites: contract.sites,
                // External-attributed unverified sites the arm defers
                // (disclosure — the policy skipped them deliberately).
                deferredExternalSites: contract.deferredExternal.length,
                cost: {
                    outputChars: planText.stdout.length + escalationChars,
                    toolCalls: 1 + escalationCalls,
                    wallMs: planText.ms,
                },
            },
        },
    };
}

function applyRenameArm(repoPath, contentByFile, task, proposal, armSites) {
    const newName = proposal.newName;
    const byFile = new Map();
    const defByFile = new Map();
    const addSite = (map, file, line) => {
        if (!map.has(file)) map.set(file, new Set());
        map.get(file).add(line);
    };
    // Definition-kind sites (plan's own def/overload-group/slot-sibling
    // emissions) take FIRST-occurrence semantics like the pinned def line —
    // `func (r *Router) BuildVarsFunc(f BuildVarsFunc)` repeats the symbol
    // as a TYPE. Call/import/reference/text sites keep all-occurrence
    // (line granularity is the instrument's design); a line carrying both
    // kinds keeps site semantics.
    for (const site of armSites) {
        if (site.kind === 'definition') addSite(defByFile, site.file, site.line);
        else addSite(byFile, site.file, site.line);
    }
    for (const [file, lineSet] of defByFile) {
        for (const line of lineSet) {
            if (byFile.get(file)?.has(line)) continue;
            if (file === task.relativePath && line === task.nameLine) continue;
            const content = contentByFile.get(file);
            if (content == null) continue;
            const lines = fs.readFileSync(path.join(repoPath, file), 'utf8').split('\n');
            const index = line - 1;
            if (index >= 0 && index < lines.length) {
                lines[index] = policy.renameFirstOnLine(lines[index], task.name, newName);
                fs.writeFileSync(path.join(repoPath, file), lines.join('\n'));
            }
        }
    }

    // The def rename is given to every arm: first-occurrence-only on the
    // name line (a def line can repeat the symbol as a param/type — see
    // renameFirstOnLine). When an arm ALSO proposed the def line as a site
    // (one-line recursive functions), site semantics win via the loop.
    const defProposed = byFile.get(task.relativePath)?.has(task.nameLine);
    if (!defProposed && contentByFile.has(task.relativePath)) {
        // Read the WORKING TREE, never the pristine snapshot — the
        // definition-site pass above may already have renamed sibling
        // overload/slot defs in this same file (writing pristine content
        // back erased them: flask check/template_filter, gate4-measured).
        let defContent;
        try {
            defContent = fs.readFileSync(
                path.join(repoPath, task.relativePath), 'utf8');
        } catch (_) {
            defContent = contentByFile.get(task.relativePath);
        }
        const lines = defContent.split('\n');
        const index = task.nameLine - 1;
        if (index >= 0 && index < lines.length) {
            lines[index] = policy.renameFirstOnLine(lines[index], task.name, newName);
        }
        fs.writeFileSync(path.join(repoPath, task.relativePath), lines.join('\n'));
    }

    let noEffectEdits = 0;
    for (const [file, lineSet] of byFile) {
        // Read the working tree, not the pristine snapshot — the def rename
        // above may already have touched this file.
        let content;
        try {
            content = fs.readFileSync(path.join(repoPath, file), 'utf8');
        } catch (_) {
            content = contentByFile.get(file);
        }
        if (content == null) { noEffectEdits += lineSet.size; continue; }
        const result = policy.applyRenameToContent(
            content, [...lineSet], task.name, newName);
        noEffectEdits += result.noEffectLines.length;
        fs.writeFileSync(path.join(repoPath, file), result.content);
    }
    return { noEffectEdits };
}

// ── Safe-delete task ────────────────────────────────────────────────────────

const IMPORT_LIKE = /^\s*(?:from\s|import\s|use\s|const\s.*=\s*require\s*\()/;

/** One standard deletion for every arm: def range + import-line strips.
 *  Rust/Go definition startLines are attribute-exclusive — extend the range
 *  upward over contiguous `#[...]` attributes and `///` doc comments, or the
 *  deletion itself manufactures "expected item after attributes" breakage. */
function applyStandardDeletion(repoPath, contentByFile, task) {
    const pattern = policy.identifierRegex(task.name);
    for (const [file, content] of contentByFile) {
        let lines = content.split('\n');
        let changed = false;
        if (file === task.relativePath) {
            let from = task.startLine;
            while (from > 1 && /^\s*(?:#\[.*\]\s*$|\/\/\/)/.test(lines[from - 2])) {
                from--;
            }
            const next = policy.applyDeleteToContent(content, from, task.endLine);
            lines = next.split('\n');
            changed = true;
        }
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!IMPORT_LIKE.test(lines[i])) continue;
            pattern.lastIndex = 0;
            if (!pattern.test(lines[i])) continue;
            const stripped = policy.stripNameFromImportLine(lines[i], task.name);
            if (stripped === lines[i]) continue;
            if (stripped == null) lines.splice(i, 1);
            else lines[i] = stripped;
            changed = true;
        }
        if (changed) fs.writeFileSync(path.join(repoPath, file), lines.join('\n'));
    }
}

/** Go: deleting a symbol can orphan an import — the trivial cleanup any
 *  agent performs. Repair "imported and not used" and re-judge (bounded). */
function judgeWithGoImportRepair(judge, repoPath, baselineKeys, language) {
    let result = judge.run();
    let newKeys = policy.diffErrorKeys(baselineKeys, result.keys);
    let repairs = 0;
    while (language === 'go' && repairs < 3) {
        const orphaned = [];
        for (const key of newKeys) {
            const match = key.match(/^(.+?\.go)\|"[^"]+" imported and not used/);
            if (match) orphaned.push(match[1]);
        }
        if (orphaned.length === 0) break;
        // Error keys are line-independent — re-run once to get positions.
        const goErrors = spawnJudge('go', ['vet', './...'], repoPath);
        for (const raw of `${goErrors.stdout}\n${goErrors.stderr}`.split('\n')) {
            const match = raw.replace(/^vet:\s*/, '')
                .match(/^(.+?\.go):(\d+)(?::\d+)?:\s*"[^"]+" imported and not used/);
            if (!match) continue;
            const absolute = path.join(repoPath, match[1]);
            if (!fs.existsSync(absolute)) continue;
            const lines = fs.readFileSync(absolute, 'utf8').split('\n');
            lines.splice(Number(match[2]) - 1, 1);
            fs.writeFileSync(absolute, lines.join('\n'));
        }
        repairs++;
        result = judge.run();
        newKeys = policy.diffErrorKeys(baselineKeys, result.keys);
    }
    return { newKeys, ms: result.ms, repairs };
}

function collectDeleteVerdicts(repoPath, contentByFile, task, sharedAudit) {
    const handle = `${task.relativePath}:${task.startLine}:${task.name}`;
    const showJson = cliJson(repoPath,
        ['show', handle, '--sections=summary,callers']);
    if (!showJson.ok) return { error: `show failed: ${showJson.error}` };
    const showText = runCli(repoPath, ['show', handle, '--sections=summary,callers']);
    const usagesJson = cliJson(repoPath,
        ['usages', task.name, '--include-tests']);
    const usagesText = runCli(repoPath, ['usages', task.name, '--include-tests']);
    const usageRows = usagesJson.ok ? (usagesJson.doc.data || []) : null;

    const grep = policy.grepDeleteVerdict(
        contentByFile, task.name, task.relativePath, task.startLine, task.endLine);
    const confirmed = policy.deleteVerdictFromShow(showJson.doc.data || {});
    const contractBase = usageRows
        ? policy.deleteVerdictFromUsages(usageRows, {
            file: task.relativePath,
            startLine: task.startLine,
            endLine: task.endLine,
        })
        : { safe: false, usageEvidence: -1 };
    // Tri-state contract verdict: confirmed callers or usage evidence →
    // unsafe; zero evidence is 'safe' only when the engine's default
    // deadcode audit CLAIMS the symbol dead (every shield the audit encodes
    // — exported exclusion, external contracts, heritage closure — lands
    // here as 'review' instead of a blind 'safe').
    const audit = sharedAudit && sharedAudit.data
        ? policy.deadcodeClaimForTask(sharedAudit.data, task)
        : null;
    const tri = policy.deleteVerdictTriState({
        confirmedCallers: confirmed.confirmedCallers,
        usageEvidence: contractBase.usageEvidence,
        audit,
    });

    // The scripted contract agent runs the audit once per repo and reuses it
    // across delete triages — each verdict pays an amortized share.
    const auditShare = sharedAudit ? sharedAudit.share : { outputChars: 0, toolCalls: 0 };

    return {
        handle,
        arms: {
            grep: {
                verdict: grep.safe ? 'safe' : 'unsafe',
                safe: grep.safe,
                evidence: grep.usageEvidence,
                cost: { outputChars: grep.outputChars, scannedBytes: grep.scannedBytes, toolCalls: 1, wallMs: 0 },
            },
            'ucn-confirmed': {
                verdict: confirmed.safe ? 'safe' : 'unsafe',
                safe: confirmed.safe,
                evidence: confirmed.confirmedCallers,
                cost: { outputChars: showText.stdout.length, toolCalls: 1, wallMs: showText.ms },
            },
            'ucn-contract': {
                verdict: tri.verdict,
                verdictReason: tri.reason,
                safe: tri.verdict === 'safe',
                evidence: Math.max(contractBase.usageEvidence, confirmed.confirmedCallers),
                cost: {
                    outputChars: showText.stdout.length + usagesText.stdout.length +
                        auditShare.outputChars,
                    toolCalls: 2 + auditShare.toolCalls,
                    wallMs: showText.ms + usagesText.ms,
                },
            },
        },
    };
}

// ── Per-repo run ────────────────────────────────────────────────────────────

/** Resolve --targets handles (file:line:name) against the index. */
function resolveTargetHandles(index, contentByFile, handles) {
    return handles.map(handleText => {
        const match = handleText.match(/^(.+):(\d+):([A-Za-z_$][A-Za-z0-9_$]*)$/);
        if (!match) {
            throw new Error(`--targets: malformed handle "${handleText}" (want file:line:name)`);
        }
        const [, file, lineRaw, name] = match;
        const line = Number(lineRaw);
        const defs = (index.symbols.get(name) || []).filter(def =>
            path.relative(index.root, def.file).replace(/\\/g, '/') === file &&
            def.startLine === line);
        if (defs.length === 0) {
            throw new Error(`--targets: ${handleText} not found in the index`);
        }
        const def = defs[0];
        return {
            name,
            relativePath: file,
            startLine: def.startLine,
            endLine: def.endLine || def.startLine,
            nameLine: defNameLine(contentByFile, file, def, name) ?? def.startLine,
            type: def.type,
            className: def.className || null,
            sameNameDefs: (index.symbols.get(name) || []).length,
            directedTarget: true,
        };
    });
}

async function runRepo(repo, options) {
    const log = message => process.stdout.write(`[${repo.name}] ${message}\n`);
    const tuned = REPOS.some(pinned => pinned.name === repo.name) ||
        OUTCOME_TUNED.some(pinned => pinned.name === repo.name);

    if (!repo.commit) resolveFreshCommit(repo);
    log(`clone @ ${repo.commit.slice(0, 10)}`);
    const repoPath = cloneAtCommit(repo, OUTCOME_TEMP_DIR);
    restoreRepo(repoPath); // discard any leftovers from an aborted run

    const judge = makeJudge(repo, repoPath);
    if (!judge) throw new Error(`${repo.name}: no toolchain judge for ${repo.language}`);

    // Warm the UCN index once so per-command wall times are warm-cache.
    const warm = runCli(repoPath, ['repo', '--sections=summary']);
    const indexBuildMs = warm.ms;

    const contentByFile = collectSourceFiles(repoPath, repo.language);
    const index = new ProjectIndex(repoPath);
    index.build(null, { quiet: true });

    log(`baseline judge: ${judge.label}`);
    const baseline = judge.run();
    log(`baseline: ${baseline.keys.length} pre-existing error key(s), ${baseline.ms}ms`);

    const rand = seededRandom(options.seed);
    let candidates = candidateDefs(index, repo, contentByFile);
    let oracleTargetInfo = null;
    if (options.oracleTargets) {
        oracleTargetInfo = await oracleCandidateDefs(
            repo, repoPath, index, contentByFile, log);
        candidates = oracleTargetInfo.all;
        log(`oracle universe: ${oracleTargetInfo.oracleSymbols} symbols — ` +
            `${oracleTargetInfo.matched.length} matched in index, ` +
            `${oracleTargetInfo.missing.length} missing from index`);
    }

    // Rename targets: symbols with at least one occurrence outside the def
    // (a zero-reference rename discriminates nothing). --targets overrides
    // sampling with directed handles (e.g. overload-family pins).
    let renameTasksSampled;
    if (options.targets && options.targets.length > 0) {
        renameTasksSampled = resolveTargetHandles(index, contentByFile, options.targets);
    } else {
        const renameCandidates = candidates.filter(candidate =>
            occurrencesOutsideDef(contentByFile, candidate) >= 1);
        renameTasksSampled = sampleWithout(renameCandidates, options.renameTasks, rand);
    }

    // Delete targets: stratified low-usage symbols (0 vs 1-6 occurrences).
    // Index-backed candidates only — an oracle-only def has no known range,
    // and the standard deletion needs one.
    const withOccurrences = candidates.filter(candidate => !candidate.indexMissing)
        .map(candidate => ({
            candidate,
            occurrences: occurrencesOutsideDef(contentByFile, candidate),
        }));
    const zeroUse = withOccurrences.filter(row => row.occurrences === 0).map(row => row.candidate);
    const lowUse = withOccurrences.filter(row => row.occurrences >= 1 && row.occurrences <= 6)
        .map(row => row.candidate);
    const deleteTasksSampled = [
        ...sampleWithout(zeroUse, Math.ceil(options.deleteTasks / 2), rand),
        ...sampleWithout(lowUse, Math.floor(options.deleteTasks / 2), rand),
    ];

    log(`sampled ${renameTasksSampled.length} rename + ${deleteTasksSampled.length} delete tasks ` +
        `(from ${candidates.length} candidates)`);

    // Phase A: collect every proposal against the pristine repo.
    const renameRows = [];
    for (const task of renameTasksSampled) {
        const proposal = collectRenameProposals(repoPath, contentByFile, task);
        renameRows.push({ task, proposal });
        if (proposal.error) log(`  rename ${task.name}: ${proposal.error}`);
    }
    // One shared deadcode audit per repo for the contract arm's tri-state
    // delete verdicts; its cost is amortized over the delete tasks.
    let sharedAudit = null;
    if (deleteTasksSampled.length > 0) {
        const auditJson = cliJson(repoPath, ['deadcode']);
        const auditText = runCli(repoPath, ['deadcode']);
        if (auditJson.ok) {
            sharedAudit = {
                data: auditJson.doc || {},
                outputChars: auditText.stdout.length,
                wallMs: auditText.ms,
                share: {
                    outputChars: Math.round(
                        auditText.stdout.length / deleteTasksSampled.length),
                    toolCalls: Number(
                        (1 / deleteTasksSampled.length).toFixed(2)),
                },
            };
        } else {
            log(`  deadcode audit failed (contract delete verdicts route review): ${auditJson.error}`);
        }
    }
    const deleteRows = [];
    for (const task of deleteTasksSampled) {
        const verdicts = collectDeleteVerdicts(repoPath, contentByFile, task, sharedAudit);
        deleteRows.push({ task, verdicts });
        if (verdicts.error) log(`  delete ${task.name}: ${verdicts.error}`);
    }

    // Phase B: apply + judge + restore.
    const renameResults = [];
    let judgeErrors = 0;
    for (const { task, proposal } of renameRows) {
        if (proposal.error) continue;
        const row = {
            id: `${task.relativePath}:${task.startLine}:${task.name}`,
            name: task.name,
            kind: task.type,
            sameNameDefs: task.sameNameDefs,
            ...(task.indexMissing && { indexMissing: true }),
            ...(task.directedTarget && { directedTarget: true }),
            arms: {},
        };
        for (const arm of ARMS) {
            const armProposal = proposal.arms[arm];
            try {
                const applied = applyRenameArm(
                    repoPath, contentByFile, task, proposal, armProposal.sites);
                const result = judge.run();
                // Error keys embed messages, so a PRE-EXISTING diagnostic whose
                // message now carries the renamed name would read as "new".
                // Fold the new name back before diffing; genuinely new errors
                // (old name unresolved, new name unknown on other types) keep
                // distinct keys either way.
                const foldPattern = policy.identifierRegex(proposal.newName);
                const foldedKeys = result.keys.map(key =>
                    key.replace(foldPattern, task.name));
                const newKeys = policy.diffErrorKeys(baseline.keys, foldedKeys);
                row.arms[arm] = {
                    broken: newKeys.length > 0,
                    newErrorCount: newKeys.length,
                    newErrorSamples: newKeys.slice(0, 3),
                    proposedSites: armProposal.sites.length,
                    ...(armProposal.planFailed && { planFailed: true }),
                    ...(armProposal.deferredExternalSites > 0 &&
                        { deferredExternalSites: armProposal.deferredExternalSites }),
                    sites: armProposal.sites.slice(0, 50).map(policy.siteKey),
                    noEffectEdits: applied.noEffectEdits,
                    judgeMs: result.ms,
                    cost: armProposal.cost,
                };
            } catch (error) {
                judgeErrors++;
                row.arms[arm] = null;
                log(`  rename ${task.name} [${arm}]: JUDGE ERROR ${error.message}`);
            } finally {
                restoreRepo(repoPath);
            }
        }
        renameResults.push(row);
        const verdicts = ARMS.map(arm =>
            `${arm}=${row.arms[arm] ? (row.arms[arm].broken ? 'BROKEN' : 'clean') : 'err'}`);
        log(`  rename ${task.name}: ${verdicts.join(' ')}`);
    }

    const deleteResults = [];
    for (const { task, verdicts } of deleteRows) {
        if (verdicts.error) continue;
        try {
            applyStandardDeletion(repoPath, contentByFile, task);
            const judged = judgeWithGoImportRepair(
                judge, repoPath, baseline.keys, repo.language);
            const row = {
                id: `${task.relativePath}:${task.startLine}:${task.name}`,
                name: task.name,
                kind: task.type,
                groundBroken: judged.newKeys.length > 0,
                groundNewErrors: judged.newKeys.length,
                groundErrorSamples: judged.newKeys.slice(0, 3),
                importRepairs: judged.repairs,
                arms: verdicts.arms,
            };
            deleteResults.push(row);
            const armSummary = ARMS.map(arm =>
                `${arm}=${policy.armDeleteVerdict(verdicts.arms[arm])}`).join(' ');
            log(`  delete ${task.name}: ground=${row.groundBroken ? 'BREAKS' : 'clean'} ${armSummary}`);
        } catch (error) {
            judgeErrors++;
            log(`  delete ${task.name}: JUDGE ERROR ${error.message}`);
        } finally {
            restoreRepo(repoPath);
        }
    }

    const report = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        repo: repo.name,
        language: repo.language,
        commit: repo.commit,
        tunedRepo: tuned,
        seed: options.seed,
        judge: judge.label,
        indexBuildMs: Math.round(indexBuildMs),
        baseline: { errorKeys: baseline.keys.length, ms: baseline.ms },
        candidates: candidates.length,
        targetSource: (options.targets && options.targets.length > 0) ? 'directed'
            : options.oracleTargets ? 'oracle' : 'index',
        ...(oracleTargetInfo && {
            oracleTargets: {
                oracle: oracleTargetInfo.oracleName,
                symbols: oracleTargetInfo.oracleSymbols,
                matchedInIndex: oracleTargetInfo.matched.length,
                missingFromIndex: oracleTargetInfo.missing.length,
                missingSample: oracleTargetInfo.missing.slice(0, 10).map(candidate =>
                    `${candidate.relativePath}:${candidate.startLine}:${candidate.name}`),
            },
        }),
        judgeErrors,
        renameProposalErrors: renameRows.filter(row => row.proposal.error).length,
        deleteProposalErrors: deleteRows.filter(row => row.verdicts.error).length,
        ...(sharedAudit && {
            sharedAudit: {
                outputChars: sharedAudit.outputChars,
                wallMs: sharedAudit.wallMs,
                amortizedOver: deleteTasksSampled.length,
            },
        }),
        rename: {
            tasks: renameResults,
            aggregate: policy.aggregateRenameTasks(renameResults, ARMS),
        },
        delete: {
            tasks: deleteResults,
            aggregate: policy.aggregateDeleteTasks(deleteResults, ARMS),
        },
        disclosures: [
            'Judge verdicts are lower bounds on breakage: type-checkers cannot see dynamically dispatched call sites (untyped receivers), string/comment damage, or runtime-only failures.',
            'falseUnsafe counts are upper bounds: a compile-clean deletion can still be runtime-unsafe.',
            'Tasks where every arm broke carry no discriminating signal (allArmsBroke) — typically renames of interface/contract members every arm would need extra knowledge to complete.',
            "The contract arm's delete verdict is tri-state: 'review' means zero text evidence but not provably dead by the default deadcode audit (exported symbols, external contracts, entry points). falseSafe is computed over 'safe' verdicts only; review rows are reported with their ground outcomes.",
        ],
    };
    return report;
}

// ── Reporting ───────────────────────────────────────────────────────────────

function formatArmTable(aggregate) {
    const lines = [
        '| arm | tasks | broken-build rate | avg new errors | avg proposed sites | avg no-effect edits | avg output chars | avg tool calls |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const arm of ARMS) {
        const row = aggregate.perArm[arm];
        if (!row) { lines.push(`| ${arm} | 0 | - | - | - | - | - | - |`); continue; }
        lines.push(`| ${arm} | ${row.tasks} | ${row.brokenBuildRate} | ${row.avgNewErrors} | ` +
            `${row.avgProposedSites} | ${row.avgNoEffectEdits} | ${row.avgOutputChars} | ${row.avgToolCalls} |`);
    }
    return lines;
}

function formatDeleteTable(aggregate) {
    const lines = [
        '| arm | tasks | said safe | false-safe (dangerous) | false-safe rate | false-unsafe (upper bound) | review | review broke / clean | judge agreement (decisive) | avg output chars |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const arm of ARMS) {
        const row = aggregate.perArm[arm];
        if (!row) { lines.push(`| ${arm} | 0 | - | - | - | - | - | - | - | - |`); continue; }
        lines.push(`| ${arm} | ${row.tasks} | ${row.saidSafe} | ${row.falseSafe} | ${row.falseSafeRate} | ` +
            `${row.falseUnsafeUpperBound} | ${row.review} | ${row.reviewGroundBroken} / ${row.reviewGroundClean} | ` +
            `${row.agreementWithJudge} | ${row.avgOutputChars} |`);
    }
    return lines;
}

function formatMarkdown(reports) {
    const lines = [
        '# Task-outcome eval (paired, toolchain-judged)',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        'Same task, same scripted policy, different discovery tool. The toolchain',
        'is the only judge; verdicts are lower bounds on breakage (dynamic sites,',
        'strings, and runtime behavior are invisible to type-checkers).',
        '',
    ];
    for (const report of reports) {
        lines.push(`## ${report.repo} (${report.language}) @ ${report.commit.slice(0, 10)}` +
            `${report.tunedRepo ? ' — TUNED REPO (cross-check only)' : ''}`);
        lines.push('');
        lines.push(`Judge: \`${report.judge}\` — baseline ${report.baseline.errorKeys} ` +
            `pre-existing error key(s). Seed ${report.seed}. ` +
            `Index warm-up ${report.indexBuildMs}ms. Judge errors: ${report.judgeErrors}.`);
        lines.push('');
        lines.push(`### Rename (${report.rename.tasks.length} tasks)`);
        lines.push('');
        lines.push(...formatArmTable(report.rename.aggregate));
        lines.push('');
        const agg = report.rename.aggregate;
        lines.push(`All arms broke: ${agg.allArmsBroke} · all arms clean: ${agg.allArmsClean} · ` +
            'paired clean-vs-broken: ' + Object.entries(agg.pairedCleanVsBroken)
            .filter(([, count]) => count > 0)
            .map(([pair, count]) => `${pair.replace('>-<', ' clean where ')} broke: ${count}`)
            .join(' · '));
        lines.push('');
        lines.push(`### Safe-delete (${report.delete.tasks.length} tasks)`);
        lines.push('');
        lines.push(...formatDeleteTable(report.delete.aggregate));
        lines.push('');
        const brokenRows = report.rename.tasks.filter(row =>
            ARMS.some(arm => row.arms[arm] && row.arms[arm].broken));
        if (brokenRows.length > 0) {
            lines.push('### Broken rename detail');
            lines.push('');
            for (const row of brokenRows) {
                const parts = ARMS.map(arm => {
                    const armRow = row.arms[arm];
                    if (!armRow) return `${arm}: judge-error`;
                    return `${arm}: ${armRow.broken ? `BROKEN (${armRow.newErrorCount})` : 'clean'}`;
                });
                lines.push(`- \`${row.id}\` — ${parts.join(' · ')}`);
                for (const arm of ARMS) {
                    const armRow = row.arms[arm];
                    if (armRow && armRow.broken && armRow.newErrorSamples.length > 0) {
                        lines.push(`  - ${arm}: ${armRow.newErrorSamples[0]}`);
                    }
                }
            }
            lines.push('');
        }
    }
    lines.push('## Disclosures', '');
    for (const disclosure of reports[0] ? reports[0].disclosures : []) {
        lines.push(`- ${disclosure}`);
    }
    lines.push('');
    return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function findRepo(name) {
    for (const pool of [OUTCOME_TUNED, OUTCOME_POOL, FRESH_POOL, REPOS]) {
        const found = pool.find(repo => repo.name === name);
        if (found) return { ...found };
    }
    return null;
}

function parseSeed(raw) {
    const seed = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
    if (!Number.isFinite(seed)) throw new Error(`seed must be a number (got ${raw})`);
    return seed;
}

const DEFAULT_SEED = 42;

async function main() {
    const argv = process.argv.slice(2);
    const seedRaw = readArgValue(argv, '--seed');
    const seedsRaw = readArgValue(argv, '--seeds');
    // --seeds 42,7,101 runs the whole board once per seed. Non-default seeds
    // write their own report filenames (suffix AFTER the date, so the dated
    // rollup regex never merges them — the oracle-eval convention).
    const seeds = seedsRaw
        ? seedsRaw.split(',').map(value => parseSeed(value.trim()))
        : [seedRaw == null ? DEFAULT_SEED : parseSeed(seedRaw)];
    const renameTasks = Number(readArgValue(argv, '--rename-tasks') || 10);
    const deleteTasks = Number(readArgValue(argv, '--delete-tasks') || 6);
    const repoFilterRaw = readArgValue(argv, '--repo');
    const targetsRaw = readArgValue(argv, '--targets');
    const targets = targetsRaw
        ? targetsRaw.split(',').map(value => value.trim()).filter(Boolean)
        : null;
    const oracleTargets = argv.includes('--oracle-targets');
    // --gate: run the PINNED tuned regression set and fail on the explicit
    // thresholds in OUTCOME_GATE_THRESHOLDS (pinned commit + fixed seed →
    // deterministic tasks; unpinned holdouts never gate). --tuned runs the
    // same set without gating.
    const gateMode = argv.includes('--gate');
    const tunedMode = gateMode || argv.includes('--tuned');
    if (gateMode && (oracleTargets || targets || seeds.length > 1)) {
        throw new Error('--gate is the deterministic pinned board: ' +
            '--oracle-targets/--targets/--seeds are measurement-mode flags');
    }
    if (targets && !repoFilterRaw) {
        throw new Error('--targets needs --repo (handles are repo-relative)');
    }

    let repos;
    if (repoFilterRaw) {
        repos = repoFilterRaw.split(',').map(value => value.trim()).filter(Boolean)
            .map(name => {
                const repo = findRepo(name);
                if (!repo) throw new Error(`Unknown repo "${name}" (not in OUTCOME_TUNED/OUTCOME_POOL/FRESH_POOL/REPOS)`);
                return repo;
            });
    } else if (tunedMode) {
        if (OUTCOME_TUNED.length === 0) {
            throw new Error('--tuned/--gate need a non-empty OUTCOME_TUNED set in eval/lib/repos.js');
        }
        // gate: false rows are pinned measurement rows whose remaining
        // broken rows are classified engine gaps — they run under --tuned
        // but join the hard gate only once those families land (#292b: a
        // new gate row needs a green run on the enforcing environment).
        repos = OUTCOME_TUNED
            .filter(repo => !gateMode || repo.gate !== false)
            .map(repo => ({ ...repo }));
    } else {
        repos = OUTCOME_POOL.map(repo => ({ ...repo }));
    }

    const reports = [];
    let failures = 0;
    for (const seed of seeds) {
        const options = { seed, renameTasks, deleteTasks, targets, oracleTargets };
        for (const repo of repos) {
            try {
                const report = await runRepo(repo, options);
                reports.push(report);
                const date = report.generatedAt.slice(0, 10);
                const suffix = seed === DEFAULT_SEED ? '' : `-seed${seed}`;
                const jsonPath = path.join(REPORTS_DIR,
                    `outcome-eval-${repo.name}-${date}${suffix}.json`);
                fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
                process.stdout.write(`[${repo.name}] JSON: ${jsonPath}\n`);
            } catch (error) {
                failures++;
                process.stderr.write(`[${repo.name}] FAILED: ${error.stack || error.message}\n`);
            }
        }
    }

    // The dated rollup holds CANONICAL (default-seed) reports only; other
    // seeds keep their own suffixed JSONs.
    const canonical = reports.filter(report => report.seed === DEFAULT_SEED);
    if (canonical.length > 0) {
        const date = canonical[0].generatedAt.slice(0, 10);
        // Merge every same-dated per-repo JSON so partial runs never truncate
        // the dated rollup (the #271 report convention).
        const merged = new Map();
        for (const name of fs.readdirSync(REPORTS_DIR)) {
            const match = name.match(/^outcome-eval-(.+)-(\d{4}-\d{2}-\d{2})\.json$/);
            if (!match || match[2] !== date) continue;
            try {
                const doc = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, name), 'utf8'));
                merged.set(doc.repo, doc);
            } catch (_) { /* unreadable partial — skip */ }
        }
        for (const report of canonical) merged.set(report.repo, report);
        const all = [...merged.values()].sort((a, b) => codeUnitCompare(a.repo, b.repo));
        const mdPath = path.join(REPORTS_DIR, `outcome-eval-${date}.md`);
        fs.writeFileSync(mdPath, formatMarkdown(all));
        process.stdout.write(`Rollup MD: ${mdPath}\n`);
    }

    for (const report of reports) {
        const label = report.seed === DEFAULT_SEED
            ? report.repo : `${report.repo} (seed ${report.seed})`;
        const rename = report.rename.aggregate.perArm;
        process.stdout.write(`${label}: rename broken-build ` +
            ARMS.map(arm => `${arm}=${rename[arm] ? rename[arm].brokenBuildRate : '-'}`).join(' ') + '\n');
        // Delete arms are part of the headline, never an appendix.
        const del = report.delete.aggregate.perArm;
        process.stdout.write(`${label}: delete falseSafe ` +
            ARMS.map(arm => del[arm]
                ? `${arm}=${del[arm].falseSafe}/${del[arm].saidSafe}` +
                    (del[arm].review > 0 ? ` (review ${del[arm].review})` : '')
                : `${arm}=-`).join(' ') + '\n');
    }

    if (gateMode) {
        const gateFailures = policy.evaluateOutcomeGate(reports);
        if (reports.length < repos.length) {
            gateFailures.push(`only ${reports.length}/${repos.length} tuned repos produced reports`);
        }
        if (gateFailures.length > 0) {
            process.stdout.write('OUTCOME GATE: FAIL\n');
            for (const failure of gateFailures) process.stdout.write(`  - ${failure}\n`);
            process.exitCode = 1;
        } else {
            process.stdout.write('OUTCOME GATE: PASS ' +
                `(${reports.length} tuned repos; thresholds: judgeErrors 0, ` +
                'proposalErrors 0, contract delete falseSafe 0, ' +
                'contract rename <= grep baseline)\n');
        }
    }
    if (failures > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exit(1);
    });
}
