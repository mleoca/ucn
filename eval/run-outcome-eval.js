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
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    REPOS,
    FRESH_POOL,
    OUTCOME_POOL,
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
        default:
            return null;
    }
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
    const addSite = (file, line) => {
        if (!byFile.has(file)) byFile.set(file, new Set());
        byFile.get(file).add(line);
    };
    addSite(task.relativePath, task.nameLine); // the def rename is given
    for (const site of armSites) addSite(site.file, site.line);

    let noEffectEdits = 0;
    for (const [file, lineSet] of byFile) {
        const content = contentByFile.get(file);
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

function collectDeleteVerdicts(repoPath, contentByFile, task) {
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
    // The contract policy consults both: confirmed callers OR usage evidence
    // block the deletion.
    const contract = {
        safe: confirmed.safe && contractBase.safe,
        usageEvidence: contractBase.usageEvidence,
        confirmedCallers: confirmed.confirmedCallers,
    };

    return {
        handle,
        arms: {
            grep: {
                safe: grep.safe,
                evidence: grep.usageEvidence,
                cost: { outputChars: grep.outputChars, scannedBytes: grep.scannedBytes, toolCalls: 1, wallMs: 0 },
            },
            'ucn-confirmed': {
                safe: confirmed.safe,
                evidence: confirmed.confirmedCallers,
                cost: { outputChars: showText.stdout.length, toolCalls: 1, wallMs: showText.ms },
            },
            'ucn-contract': {
                safe: contract.safe,
                evidence: Math.max(contract.usageEvidence, contract.confirmedCallers),
                cost: {
                    outputChars: showText.stdout.length + usagesText.stdout.length,
                    toolCalls: 2,
                    wallMs: showText.ms + usagesText.ms,
                },
            },
        },
    };
}

// ── Per-repo run ────────────────────────────────────────────────────────────

function runRepo(repo, options) {
    const log = message => process.stdout.write(`[${repo.name}] ${message}\n`);
    const tuned = REPOS.some(pinned => pinned.name === repo.name);

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
    const candidates = candidateDefs(index, repo, contentByFile);

    // Rename targets: symbols with at least one occurrence outside the def
    // (a zero-reference rename discriminates nothing).
    const renameCandidates = candidates.filter(candidate =>
        occurrencesOutsideDef(contentByFile, candidate) >= 1);
    const renameTasksSampled = sampleWithout(renameCandidates, options.renameTasks, rand);

    // Delete targets: stratified low-usage symbols (0 vs 1-6 occurrences).
    const withOccurrences = candidates.map(candidate => ({
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
    const deleteRows = [];
    for (const task of deleteTasksSampled) {
        const verdicts = collectDeleteVerdicts(repoPath, contentByFile, task);
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
                `${arm}=${verdicts.arms[arm].safe ? 'safe' : 'unsafe'}`).join(' ');
            log(`  delete ${task.name}: ground=${row.groundBroken ? 'BREAKS' : 'clean'} ${armSummary}`);
        } catch (error) {
            judgeErrors++;
            log(`  delete ${task.name}: JUDGE ERROR ${error.message}`);
        } finally {
            restoreRepo(repoPath);
        }
    }

    const report = {
        schemaVersion: 1,
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
        judgeErrors,
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
        '| arm | tasks | said safe | false-safe (dangerous) | false-safe rate | false-unsafe (upper bound) | judge agreement | avg output chars |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const arm of ARMS) {
        const row = aggregate.perArm[arm];
        if (!row) { lines.push(`| ${arm} | 0 | - | - | - | - | - | - |`); continue; }
        lines.push(`| ${arm} | ${row.tasks} | ${row.saidSafe} | ${row.falseSafe} | ${row.falseSafeRate} | ` +
            `${row.falseUnsafeUpperBound} | ${row.agreementWithJudge} | ${row.avgOutputChars} |`);
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
    for (const pool of [OUTCOME_POOL, FRESH_POOL, REPOS]) {
        const found = pool.find(repo => repo.name === name);
        if (found) return { ...found };
    }
    return null;
}

function main() {
    const argv = process.argv.slice(2);
    const seedRaw = readArgValue(argv, '--seed');
    const seed = seedRaw == null ? 42 : Number.parseInt(seedRaw, seedRaw.startsWith('0x') ? 16 : 10);
    if (!Number.isFinite(seed)) throw new Error(`--seed must be a number (got ${seedRaw})`);
    const renameTasks = Number(readArgValue(argv, '--rename-tasks') || 10);
    const deleteTasks = Number(readArgValue(argv, '--delete-tasks') || 6);
    const repoFilterRaw = readArgValue(argv, '--repo');

    let repos;
    if (repoFilterRaw) {
        repos = repoFilterRaw.split(',').map(value => value.trim()).filter(Boolean)
            .map(name => {
                const repo = findRepo(name);
                if (!repo) throw new Error(`Unknown repo "${name}" (not in OUTCOME_POOL/FRESH_POOL/REPOS)`);
                return repo;
            });
    } else {
        repos = OUTCOME_POOL.map(repo => ({ ...repo }));
    }

    const options = { seed, renameTasks, deleteTasks };
    const reports = [];
    let failures = 0;
    for (const repo of repos) {
        try {
            const report = runRepo(repo, options);
            reports.push(report);
            const date = report.generatedAt.slice(0, 10);
            const jsonPath = path.join(REPORTS_DIR, `outcome-eval-${repo.name}-${date}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
            process.stdout.write(`[${repo.name}] JSON: ${jsonPath}\n`);
        } catch (error) {
            failures++;
            process.stderr.write(`[${repo.name}] FAILED: ${error.stack || error.message}\n`);
        }
    }

    if (reports.length > 0) {
        const date = reports[0].generatedAt.slice(0, 10);
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
        for (const report of reports) merged.set(report.repo, report);
        const all = [...merged.values()].sort((a, b) => codeUnitCompare(a.repo, b.repo));
        const mdPath = path.join(REPORTS_DIR, `outcome-eval-${date}.md`);
        fs.writeFileSync(mdPath, formatMarkdown(all));
        process.stdout.write(`Rollup MD: ${mdPath}\n`);
    }

    for (const report of reports) {
        const rename = report.rename.aggregate.perArm;
        process.stdout.write(`${report.repo}: rename broken-build ` +
            ARMS.map(arm => `${arm}=${rename[arm] ? rename[arm].brokenBuildRate : '-'}`).join(' ') + '\n');
    }
    if (failures > 0) process.exitCode = 1;
}

if (require.main === module) main();
