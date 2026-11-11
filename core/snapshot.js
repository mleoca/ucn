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
 *   (a) no tracked path has an unstaged modification or deletion,
 *   (b) no untracked path exists that git does not ignore,
 *   (c) no ignored file exists that analysis reads as metadata
 *       (ANALYSIS_METADATA: the names every reader of a non-source file
 *       declares here), and the live index holds and searched no file git
 *       does not track.
 * When any of the three is false or cannot be established, the snapshot is
 * built: the git index is exported to a temporary directory and indexed
 * there, with the staged file list as the tracked inventory (a tracked file
 * that matches a .gitignore rule stays in). That index is never saved.
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
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
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

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
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
        try {
            git(root, ['diff', '--quiet', '--', '.']);
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

function unavailable(detail, cause) {
    const error = new UcnError(`staged-snapshot-unavailable: ${detail}`, cause ? { cause } : undefined);
    error.code = 'staged-snapshot-unavailable';
    return error;
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
        // Staged paths under the project, relative to it.
        listed = git(index.root, ['ls-files', '--cached', '-z', '--', '.']).split('\0').filter(Boolean);
    } catch (error) {
        throw unavailable('git could not list the staged files', error);
    }
    let exportRoot = null;
    try {
        exportRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-staged-')));
        git(gitRoot, ['checkout-index', '--all', '--force', `--prefix=${exportRoot}${path.sep}`]);
        const prefix = path.relative(fs.realpathSync(gitRoot), fs.realpathSync(index.root));
        const snapshotRoot = prefix ? path.join(exportRoot, prefix) : exportRoot;
        if (!fs.existsSync(snapshotRoot)) fs.mkdirSync(snapshotRoot, { recursive: true });
        const files = new Set(listed);
        const directories = new Set();
        for (const file of listed) {
            for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
                const parent = file.slice(0, slash);
                if (directories.has(parent)) break;
                directories.add(parent);
            }
        }
        const gitignores = listed
            .filter(file => file === '.gitignore' || file.endsWith('/.gitignore'))
            .map(file => path.join(snapshotRoot, file));
        const { ProjectIndex } = require('./project');
        const snapshot = new ProjectIndex(snapshotRoot, { exactRoot: true });
        // Git commands about this tree run in the repository it came from.
        snapshot.repoRoot = index.root;
        snapshot.build(null, { quiet: true, gitListing: { tracked: { files, directories }, gitignores } });
        const notes = [];
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
        throw unavailable(String(error && error.message ? error.message : error).split('\n')[0], error);
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
    resolveTarget, rebasePaths, worktreeMatchesIndex, isAnalysisMetadata,
    ANALYSIS_METADATA, ANALYSIS_METADATA_SUFFIXES,
};
