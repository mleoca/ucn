/**
 * core/snapshot.js - Which tree does a diff's NEW side live in?
 *
 * A diff against the worktree is answered by the worktree's index. A staged
 * diff (`--staged`) describes the git index, and the worktree may hold
 * something else: a staged break with an unstaged repair must still be a
 * break, a staged repair with an unstaged break must not be one.
 *
 * The staged snapshot is the git index and nothing else. Source files,
 * `.gitignore` rules, `.ucn.json` and every manifest come from it. A file
 * that exists only in the worktree, tracked or not, ignored or not, is not
 * part of it and is not applied.
 *
 * The live index answers for the staged snapshot only when the worktree
 * provably holds the same thing:
 *   (a) no tracked path has an unstaged modification or deletion, and none
 *       is marked assume-unchanged or skip-worktree (for those git reports
 *       no difference whatever the worktree holds),
 *   (b) no untracked path exists that git does not ignore,
 *   (c) no ignored file exists that analysis reads as metadata
 *       (ANALYSIS_METADATA: the names every reader of a non-source file
 *       declares here), and the live index holds and searched no file git
 *       does not track.
 * When any of the three is false or cannot be established, the snapshot is
 * built: the git index is exported to a temporary directory and indexed
 * there, with the staged file list as the tracked inventory (a tracked file
 * that matches a .gitignore rule stays in). Every staged file is exported,
 * skip-worktree paths included, and a checked-out submodule at the commit
 * the index names. That index is never saved.
 *
 * When the export cannot be built the answer is that the check could not
 * run (`staged-snapshot-unavailable`), never an answer about the worktree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { UcnError } = require('./errors');

// Files that are not source and that analysis reads: configuration, ignore
// rules, package and build manifests. A reader of a new one adds it here;
// test/check-staged.test.js fails when a file name of this kind appears in
// core/ or languages/ without being listed.
const ANALYSIS_METADATA = Object.freeze([
    '.ucn.json', '.gitignore',
    'package.json', 'tsconfig.json', 'jsconfig.json',
    'go.mod', 'go.work',
    'Cargo.toml',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pytest.ini', 'tox.ini',
    'pom.xml', 'build.gradle', 'build.gradle.kts',
    'compile_commands.json', 'CMakeLists.txt', 'Makefile',
    'composer.json', 'Gemfile', 'Podfile', 'Cartfile', 'mix.exs', 'rebar.config',
    'Directory.Build.props', 'Directory.Build.targets',
]);
// Project files named after the project.
const ANALYSIS_METADATA_SUFFIXES = Object.freeze(['.csproj', '.sln']);
const METADATA_NAMES = new Set(ANALYSIS_METADATA);

function isAnalysisMetadata(relativePath) {
    const base = String(relativePath).split('/').pop();
    return METADATA_NAMES.has(base) || ANALYSIS_METADATA_SUFFIXES.some(suffix => base.endsWith(suffix));
}

function git(cwd, args, env = null) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        ...(env && { env: { ...process.env, ...env } }),
    });
}

/**
 * Tracked paths under `root` that git has been told not to compare with
 * the worktree: assume-unchanged (`h`) and skip-worktree (`S`, `s`). For
 * these `git diff` reports nothing whatever the file holds, or whether it
 * exists, so a quiet diff says nothing about them.
 * @returns {{path: string, skipWorktree: boolean}[]}
 */
function flaggedPaths(root) {
    const flagged = [];
    for (const record of git(root, ['ls-files', '-v', '-z', '--', '.']).split('\0')) {
        if (record.length < 3 || record[0] === 'H') continue;
        flagged.push({ path: record.slice(2), skipWorktree: record[0] === 'S' || record[0] === 's' });
    }
    return flagged;
}

/**
 * Does the worktree under `root` hold what the git index holds, as far as
 * analysis can tell? { same: true } or { same: false, why }. With the live
 * `index`, every file it holds or searched must be one git tracks: a file
 * git ignores by a rule the engine does not read (a global or
 * repository-local exclude) is in the live index and not in the git index.
 */
function worktreeMatchesIndex(root, index = null) {
    try {
        // A path git was told not to compare is one a quiet diff cannot
        // vouch for: the worktree may hold anything there, or nothing.
        const flagged = flaggedPaths(root);
        if (flagged.length > 0) {
            return { same: false, why: `${flagged[0].path} is marked assume-unchanged or skip-worktree: git does not compare it` };
        }
        try {
            // Submodules are compared whatever the configuration says to
            // ignore: the snapshot exports them at the staged commit.
            git(root, ['diff', '--quiet', '--ignore-submodules=none', '--', '.']);
        } catch (error) {
            if (error.status === 1) return { same: false, why: 'tracked files have unstaged changes' };
            throw error;
        }
        const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
        if (untracked.length > 0) return { same: false, why: 'untracked files exist' };
        // Ignored files, with wholly ignored directories listed as one
        // entry: analysis does not walk into those either.
        const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard',
            '--directory', '-z', '--', '.']).split('\0').filter(Boolean);
        const metadata = ignored.find(entry => !entry.endsWith('/') && isAnalysisMetadata(entry));
        if (metadata) return { same: false, why: `${metadata} is not in the git index` };
        if (index) {
            const tracked = new Set(git(root, ['ls-files', '--cached', '-z', '--', '.']).split('\0').filter(Boolean));
            const relative = file => path.relative(index.root, file).split(path.sep).join('/');
            for (const file of index.files.keys()) {
                if (!tracked.has(relative(file))) return { same: false, why: `${relative(file)} is indexed and not in the git index` };
            }
            // Source the engine searches as text or could not read
            // (core/source-universe.js): part of every answer too.
            const { universe } = require('./source-universe');
            const scope = universe(index);
            for (const entry of [...(scope.textOnly || []), ...(scope.opaque || [])]) {
                if (!entry.relativePath || entry.kind === 'directory') continue;
                if (!tracked.has(entry.relativePath)) {
                    return { same: false, why: `${entry.relativePath} is searched and not in the git index` };
                }
            }
        }
        return { same: true };
    } catch (_) {
        return { same: false, why: 'the worktree could not be compared with the git index' };
    }
}

function unavailable(detail, cause, reason = null) {
    const error = new UcnError(`staged-snapshot-unavailable: ${detail}`, cause ? { cause } : undefined);
    error.code = 'staged-snapshot-unavailable';
    // 'not-a-repository': there is no git index to describe at all.
    if (reason) error.reason = reason;
    return error;
}

/**
 * Write every file of the git index under `exportRoot`, whatever the
 * worktree holds: a path marked skip-worktree is staged like any other.
 * Git older than the option that says so gets the same through a private
 * copy of the index with the marks cleared; the repository's index is
 * never written.
 */
function exportIndex(gitRoot, exportRoot) {
    const prefix = `--prefix=${exportRoot}${path.sep}`;
    try {
        git(gitRoot, ['checkout-index', '--all', '--force', '--ignore-skip-worktree-bits', prefix]);
        return;
    } catch (error) {
        if (!/unknown option|usage:/i.test(String(error.stderr || error.message))) throw error;
    }
    // The index git itself would read: a hook runs with its own.
    const indexFile = path.resolve(gitRoot, process.env.GIT_INDEX_FILE ||
        git(gitRoot, ['rev-parse', '--git-path', 'index']).trim());
    const privateIndex = path.join(exportRoot, '..', `${path.basename(exportRoot)}.index`);
    try {
        fs.copyFileSync(indexFile, privateIndex);
        const env = { GIT_INDEX_FILE: privateIndex };
        const skipped = git(gitRoot, ['ls-files', '-v', '-z'], env).split('\0')
            .filter(record => record[0] === 'S' || record[0] === 's').map(record => record.slice(2));
        if (skipped.length > 0) {
            execFileSync('git', ['update-index', '--no-skip-worktree', '-z', '--stdin'], {
                cwd: gitRoot, input: skipped.join('\0') + '\0', env: { ...process.env, ...env },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        git(gitRoot, ['checkout-index', '--all', '--force', prefix], env);
    } finally {
        fs.rmSync(privateIndex, { force: true });
    }
}

/**
 * Submodules of the staged tree: each is a commit the index names, not
 * files. One that is checked out here is exported at THAT commit (what
 * the commit being made will build against), and so are the submodules
 * that commit names, to any depth; one that is not checked out is absent
 * from the worktree's analysis too, and is named in a note.
 * @returns {{files: string[], notes: string[]}} files relative to the project
 */
function exportSubmodules(projectRoot, snapshotRoot) {
    const files = [];
    const notes = [];
    let archives = 0;
    // One submodule at the commit its parent names, then the submodules
    // that commit names in turn.
    const exportAt = (worktree, commit, relative) => {
        let checkedOut;
        try { checkedOut = fs.existsSync(path.join(worktree, '.git')); } catch (_) { checkedOut = false; }
        if (!checkedOut) {
            notes.push(`submodule ${relative} is not checked out: its code is not part of the staged analysis`);
            return;
        }
        const target = path.join(snapshotRoot, relative);
        const archive = path.join(snapshotRoot, '..', `${path.basename(snapshotRoot)}.${archives++}.tar`);
        const nested = [];
        try {
            fs.mkdirSync(target, { recursive: true });
            git(worktree, ['archive', '--format=tar', '-o', archive, commit]);
            execFileSync('tar', ['-xf', archive, '-C', target], { stdio: ['ignore', 'pipe', 'pipe'] });
            for (const record of git(worktree, ['ls-tree', '-r', '-z', commit]).split('\0')) {
                const entry = /^(\d+) \w+ ([0-9a-f]+)\t(.+)$/s.exec(record);
                if (!entry) continue;
                if (entry[1] === '160000') nested.push([entry[3], entry[2]]);
                else files.push(`${relative}/${entry[3]}`);
            }
        } catch (error) {
            throw unavailable(`submodule ${relative} could not be exported at ${commit.slice(0, 10)}`, error);
        } finally {
            fs.rmSync(archive, { force: true });
        }
        for (const [inner, innerCommit] of nested) exportAt(path.join(worktree, inner), innerCommit, `${relative}/${inner}`);
    };
    for (const record of git(projectRoot, ['ls-files', '-s', '-z', '--', '.']).split('\0')) {
        const match = /^160000 ([0-9a-f]+) \d+\t(.+)$/s.exec(record);
        if (match) exportAt(path.join(projectRoot, match[2]), match[1], match[2]);
    }
    return { files, notes };
}

/**
 * The index that represents the NEW side of a diff.
 *
 * @param {object} index - the live ProjectIndex of the worktree
 * @param {object} options - { staged, force: build the snapshot even
 *   when the worktree matches (tests compare the two) }
 * @returns {{index, repoRoot, ephemeral, notes: string[], dispose: Function}}
 *   `repoRoot` is where git commands run; `index.root` is where the
 *   snapshot's files are. They differ only for an ephemeral snapshot.
 * @throws UcnError (code `staged-snapshot-unavailable`) when a staged
 *   snapshot is needed and cannot be built.
 */
function resolveTarget(index, options = {}) {
    const live = { index, repoRoot: index.root, ephemeral: false, notes: [], dispose() {} };
    if (!options.staged) return live;
    if (!options.force && worktreeMatchesIndex(index.root, index).same) return live;

    let gitRoot;
    let listed;
    try {
        gitRoot = git(index.root, ['rev-parse', '--show-toplevel']).trim();
    } catch (error) {
        throw unavailable('not a git repository', error, 'not-a-repository');
    }
    try {
        // Staged paths under the project, relative to it.
        listed = git(index.root, ['ls-files', '--cached', '-z', '--', '.']).split('\0').filter(Boolean);
    } catch (error) {
        throw unavailable('git could not list the staged files', error);
    }
    let exportRoot = null;
    try {
        exportRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-staged-')));
        exportIndex(gitRoot, exportRoot);
        const prefix = path.relative(fs.realpathSync(gitRoot), fs.realpathSync(index.root));
        const snapshotRoot = prefix ? path.join(exportRoot, prefix) : exportRoot;
        if (!fs.existsSync(snapshotRoot)) fs.mkdirSync(snapshotRoot, { recursive: true });
        const submodules = exportSubmodules(index.root, snapshotRoot);
        const files = new Set([...listed, ...submodules.files]);
        const directories = new Set();
        for (const file of files) {
            for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
                const parent = file.slice(0, slash);
                if (directories.has(parent)) break;
                directories.add(parent);
            }
        }
        const gitignores = [...files]
            .filter(file => file === '.gitignore' || file.endsWith('/.gitignore'))
            .map(file => path.join(snapshotRoot, file));
        const { ProjectIndex } = require('./project');
        const snapshot = new ProjectIndex(snapshotRoot, { exactRoot: true });
        // Git commands about this tree run in the repository it came from.
        snapshot.repoRoot = index.root;
        snapshot.build(null, { quiet: true, gitListing: { tracked: { files, directories }, gitignores } });
        const notes = [...submodules.notes];
        if (!files.has('.ucn.json') && fs.existsSync(path.join(index.root, '.ucn.json'))) {
            notes.push('the .ucn.json in the worktree is not in the git index: the staged check does not apply it');
        }
        const root = exportRoot;
        return {
            index: snapshot,
            repoRoot: index.root,
            ephemeral: true,
            notes,
            dispose() { fs.rmSync(root, { recursive: true, force: true }); },
        };
    } catch (error) {
        if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
        if (error && error.code === 'staged-snapshot-unavailable') throw error;
        // What git said, not the command line (which names a temporary
        // directory nobody can act on).
        const said = String((error && error.stderr) || '').split('\n').map(line => line.trim()).find(Boolean) ||
            String(error && error.message ? error.message : error).split('\n')[0];
        throw unavailable(exportRoot ? said.split(exportRoot).join('<export>') : said, error);
    }
}

/**
 * Rewrite, in place, every string under `value` that is a path inside
 * `fromRoot` to the same path inside `toRoot`: a result computed on an
 * exported snapshot names files where the repository has them.
 */
function rebasePaths(value, fromRoot, toRoot, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    const prefix = fromRoot + path.sep;
    for (const key of Object.keys(value)) {
        const item = value[key];
        if (typeof item === 'string') {
            if (item === fromRoot) value[key] = toRoot;
            else if (item.startsWith(prefix)) value[key] = toRoot + path.sep + item.slice(prefix.length);
        } else if (item && typeof item === 'object' && !(item instanceof Map) && !(item instanceof Set)) {
            rebasePaths(item, fromRoot, toRoot, seen);
        }
    }
    return value;
}

module.exports = {
    resolveTarget, rebasePaths, worktreeMatchesIndex, flaggedPaths, isAnalysisMetadata,
    ANALYSIS_METADATA, ANALYSIS_METADATA_SUFFIXES,
};
