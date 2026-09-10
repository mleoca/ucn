'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function commandVersion(command, args) {
    try { return execFileSync(command, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { return null; }
}

function workingTreeIdentity(root) {
    const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
    const contents = files.map(file => {
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) return { file, state: 'deleted' };
        const stat = fs.lstatSync(absolute);
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
        return { file, mode: stat.mode & 0o777, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    });
    return {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sha256: crypto.createHash('sha256').update(JSON.stringify(contents)).digest('hex'),
        files: contents,
    };
}

function oracleVersions() {
    const packages = {};
    for (const name of ['ts-morph', 'typescript', 'pyright']) {
        try { packages[name] = require(`${name}/package.json`).version; }
        catch { packages[name] = null; }
    }
    return {
        node: process.version, platform: `${process.platform}/${process.arch}`,
        ...packages,
        gopls: commandVersion('gopls', ['version']) || commandVersion(path.join(os.homedir(), 'go/bin/gopls'), ['version']),
        rustAnalyzer: commandVersion('rust-analyzer', ['--version']),
        clangd: commandVersion('clangd', ['--version']),
        dotnet: commandVersion('dotnet', ['--version']),
        java: commandVersion('/opt/homebrew/opt/openjdk/bin/java', ['--version']),
        // jdtls has no --version flag: the package manager is a read-only probe.
        jdtls: commandVersion('brew', ['list', '--versions', 'jdtls']),
    };
}

function createRunManifest(root, repos, options) {
    return {
        schemaVersion: 2, createdAt: new Date().toISOString(),
        tree: workingTreeIdentity(root), environment: oracleVersions(),
        options, repos: repos.map(repo => ({ ...repo, sampledTargets: [] })),
    };
}

function population(result) {
    return result.perSymbol.map(s => ({ file: s.file, line: s.line, name: s.name, kind: s.kind,
        oracleCalls: s.oracleCalls, exactOracleCalls: s.exactOracleCalls,
        runtimeOracleCalls: s.runtimeOracleCalls, compileTimeOracleCalls: s.compileTimeOracleCalls,
        ...(s.error && { error: s.error }),
    }));
}

// Capture oracle facts before any engine-dependent deferred adjudication.
// Stable occurrence identities catch reference changes that equal counts miss.
function referencePopulation(references) {
    return references.map(r => [r.file, r.line, r.column ?? null,
        r.kind, r.oracleResolution ?? null, r.uncertaintyClass ?? null])
        .sort((a, b) => {
            const left = JSON.stringify(a), right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
        });
}

function deferredReferenceShown(reference, shownKeys, replay) {
    const key = `${reference.file}:${reference.line}`;
    // Replay freezes the baseline eligibility decision, not the post-change
    // answer. A newly hidden eligible edge must still be measured as hidden.
    return replay ? replay.deferredShown.includes(key) : shownKeys.has(key);
}

function saveManifest(destination, manifest) {
    if (!destination) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(manifest, null, 2) + '\n');
}

module.exports = { workingTreeIdentity, createRunManifest, population, saveManifest,
    referencePopulation, deferredReferenceShown };
