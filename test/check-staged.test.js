'use strict';

/**
 * `check --staged` and `impact --staged` describe the git index, not the
 * worktree (core/snapshot.js). The staged snapshot is the git index and
 * nothing else: source, ignore rules, `.ucn.json` and manifests come from
 * it. The live index answers only when the worktree provably holds the
 * same thing; otherwise the index is exported and indexed on its own.
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { check } = require('../core/check');
const output = require('../core/output');
const {
    resolveTarget, worktreeMatchesIndex, isAnalysisMetadata, ANALYSIS_METADATA,
} = require('../core/snapshot');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(files) {
    const dir = fs.realpathSync(tmp(files));
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}

function write(dir, file, content) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

function staged(dir, params = {}) {
    const done = execute(idx(dir), 'check', { staged: true, ...params });
    assert.ok(done.ok, done.error);
    return done.result;
}

const verdicts = result => (result.changed || []).map(item =>
    `${item.name}:${item.kind}=${item.verdict}${item.reasons.length ? `(${item.reasons.join(',')})` : ''}`);

const LIB = 'def widened(a):\n    return a\n';
const USE = 'from lib import widened\n\n\ndef run():\n    return widened(1)\n';

describe('check --staged: the git index decides, the worktree does not', () => {
    it('a staged break with an unstaged repair is a break', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            // The worktree is fine again. What will be committed is not.
            write(dir, 'lib.py', LIB);
            const result = staged(dir);
            assert.deepStrictEqual([result.trust.status, verdicts(result)],
                ['BLOCKED', ['widened:modified=blocked(signature-mismatch,header)']]);
            assert.deepStrictEqual(result.changed[0].mismatches.map(site => `${site.file}:${site.line}`), ['use.py:5']);
        } finally { rm(dir); }
    });

    it('a staged repair with an unstaged break is not a break', () => {
        const dir = repo({ 'lib.py': 'def widened(a, b):\n    return a\n', 'use.py': USE.replace('widened(1)', 'widened(1, 2)') });
        try {
            // Staged: one parameter, and the call site passes one.
            write(dir, 'lib.py', LIB);
            write(dir, 'use.py', USE);
            git(dir, 'add', '-A');
            // Unstaged: the call site breaks again.
            write(dir, 'use.py', USE.replace('widened(1)', 'widened(1, 2, 3)'));
            const result = staged(dir);
            assert.notStrictEqual(result.trust.status, 'BLOCKED');
            assert.strictEqual(result.trust.signatureMismatches, 0);
        } finally { rm(dir); }
    });

    it('reads the staged text of a changed declaration, not the worktree\'s', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            // Staged: an inert edit. Unstaged: a new required parameter.
            write(dir, 'lib.py', 'def widened(a):\n    print("staged")\n    return a\n');
            git(dir, 'add', 'lib.py');
            write(dir, 'lib.py', 'def widened(a, b):\n    print("staged")\n    return a\n');
            assert.deepStrictEqual(verdicts(staged(dir)), ['widened:modified=ready']);
            // The worktree check sees the other change.
            const worktree = execute(idx(dir), 'check', {}).result;
            assert.strictEqual(worktree.trust.status, 'BLOCKED');
        } finally { rm(dir); }
    });

    it('configuration comes from the git index: a worktree-only .ucn.json is not applied', () => {
        const files = {
            'package.json': '{"name":"lib","main":"index.js"}',
            'index.js': 'function publicApi() { return 1; }\nfunction keep() { return 2; }\nmodule.exports = { publicApi, keep };\n',
        };
        for (const [label, hide] of [
            ['untracked', () => {}],
            ['ignored', dir => { fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.ucn.json\n'); }],
        ]) {
            const dir = repo(files);
            try {
                write(dir, 'index.js', 'function keep() { return 2; }\nmodule.exports = { keep };\n');
                git(dir, 'add', 'index.js');
                // Staged: a library (no configuration says otherwise). The
                // worktree alone declares an application.
                hide(dir);
                write(dir, '.ucn.json', '{"kind":"application"}\n');
                assert.strictEqual(worktreeMatchesIndex(dir).same, false, label);
                const result = staged(dir);
                assert.deepStrictEqual(verdicts(result), ['publicApi:deleted=review(downstream-exposure)'], label);
                assert.ok((result.notes || []).some(note => /\.ucn\.json in the worktree is not in the git index/.test(note)), label);
                assert.match(output.formatCheck(result),
                    /^Note: the \.ucn\.json in the worktree is not in the git index: the staged check does not apply it$/m, label);
                // Once the configuration is staged too, it applies.
                git(dir, 'add', '-f', '.ucn.json');
                assert.deepStrictEqual(verdicts(staged(dir)), ['publicApi:deleted=ready'], label);
            } finally { rm(dir); }
        }
    });

    it('a file git ignores by a rule the engine does not read is not part of the staged tree', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            write(dir, 'use.py', USE.replace('widened(1)', 'widened(1, 2)'));
            git(dir, 'add', '-A');
            // Ignored through the repository's own exclude file: git does
            // not list it as untracked, and the live index holds it.
            fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'local_only.py\n');
            write(dir, 'local_only.py', 'from lib import widened\n\nwidened(1)\n');
            const live = idx(dir);
            assert.ok([...live.files.keys()].some(file => file.endsWith('local_only.py')));
            assert.deepStrictEqual(worktreeMatchesIndex(dir, live),
                { same: false, why: 'local_only.py is indexed and not in the git index' });
            // Its stale call site is the worktree's business, not the commit's.
            const result = staged(dir);
            assert.strictEqual(result.trust.signatureMismatches, 0);
            assert.notStrictEqual(result.trust.status, 'BLOCKED');
        } finally { rm(dir); }
    });

    it('a tracked file that matches .gitignore is part of the staged analysis', () => {
        const dir = repo({ 'lib.py': LIB, 'keep.py': 'x = 1\n' });
        try {
            // Tracked on purpose, although a rule ignores it.
            write(dir, '.gitignore', 'generated/\n');
            write(dir, 'generated/use.py', USE);
            git(dir, 'add', '-f', '.gitignore', 'generated/use.py');
            git(dir, 'commit', '-q', '-m', 'tracked generated file');
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            write(dir, 'scratch.py', 'y = 2\n'); // untracked: the snapshot is built
            const result = staged(dir);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            assert.deepStrictEqual(result.changed[0].mismatches.map(site => site.file), ['generated/use.py']);
        } finally { rm(dir); }
    });

    it('on a clean, fully staged tree the snapshot and the live index answer byte for byte', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE, 'other.py': 'def spare():\n    return 0\n' });
        try {
            write(dir, 'lib.py', 'def widened(a, b=None):\n    return a\n');
            write(dir, 'other.py', 'def spare():\n    return 1\n\n\ndef fresh_name():\n    return 2\n');
            git(dir, 'add', '-A');
            assert.strictEqual(worktreeMatchesIndex(dir).same, true);
            const live = check(idx(dir), { staged: true });
            const exported = check(idx(dir), { staged: true, forceStagedSnapshot: true });
            assert.strictEqual(output.formatCheck(exported), output.formatCheck(live));
            assert.strictEqual(output.formatCheckJson(exported), output.formatCheckJson(live));
            assert.ok(live.changed.length >= 3);
        } finally { rm(dir); }
    });

    it('a snapshot that cannot be built is a check that did not pass, never one about the worktree', () => {
        const dir = fs.realpathSync(tmp({ 'lib.py': LIB }));
        try {
            const index = idx(dir);
            assert.throws(() => resolveTarget(index, { staged: true }),
                error => error.code === 'staged-snapshot-unavailable');
            // Through the command the missing repository is reported as such.
            const done = execute(index, 'check', { staged: true });
            assert.ok(done.ok);
            assert.strictEqual(done.result.ok, false);
        } finally { rm(dir); }
    });

    it('a project in a subdirectory of the repository is exported at its own root', () => {
        const dir = repo({
            'README.md': 'outer\n',
            'services/api/package.json': '{"name":"api"}',
            'services/api/lib.py': LIB,
            'services/api/use.py': USE,
            'services/other/lib.py': 'def widened(a, b, c):\n    return a\n',
        });
        try {
            const project = path.join(dir, 'services', 'api');
            write(dir, 'services/api/lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', '-A');
            write(dir, 'services/api/lib.py', LIB); // unstaged repair
            const done = execute(idx(project), 'check', { staged: true });
            assert.ok(done.ok, done.error);
            assert.deepStrictEqual([done.result.trust.status, verdicts(done.result)],
                ['BLOCKED', ['widened:modified=blocked(signature-mismatch,header)']]);
            // Paths are the project's own, as in a worktree check.
            assert.deepStrictEqual(done.result.changed[0].mismatches.map(site => site.file), ['use.py']);
            assert.strictEqual(done.result.changed[0].file, 'lib.py');
        } finally { rm(dir); }
    });

    it('says plainly when the staged tree could not be read', () => {
        const text = output.formatCheck({
            base: 'HEAD', staged: true, ok: false, status: 'staged-snapshot-unavailable',
            error: 'the staged tree could not be exported and indexed (unmerged paths); nothing was checked',
        });
        assert.match(text, /CHECK DID NOT RUN \[staged-snapshot-unavailable\]/);
        assert.match(text, /This is not a pass, and says nothing about the worktree\./);
    });

    it('a path git was told to skip or to assume unchanged is still part of the staged tree', () => {
        // skip-worktree: the caller is staged and absent from disk.
        let dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            git(dir, 'update-index', '--skip-worktree', 'use.py');
            fs.unlinkSync(path.join(dir, 'use.py'));
            const live = idx(dir);
            assert.deepStrictEqual(worktreeMatchesIndex(dir, live),
                { same: false, why: 'use.py is marked assume-unchanged or skip-worktree: git does not compare it' });
            const result = staged(dir);
            assert.deepStrictEqual([result.trust.status, result.changed[0].mismatches.map(site => site.file)],
                ['BLOCKED', ['use.py']]);
        } finally { rm(dir); }
        // assume-unchanged: an unstaged repair git does not report.
        dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            git(dir, 'update-index', '--assume-unchanged', 'use.py');
            write(dir, 'use.py', USE.replace('widened(1)', 'widened(1, 2)'));
            assert.strictEqual(worktreeMatchesIndex(dir, idx(dir)).same, false);
            assert.strictEqual(staged(dir).trust.status, 'BLOCKED');
            // The worktree check says which files git will not report.
            const worktree = execute(idx(dir), 'check', {}).result;
            assert.ok((worktree.notes || []).some(note =>
                /1 tracked path\(s\) are marked assume-unchanged or skip-worktree \(use\.py\)/.test(note)));
        } finally { rm(dir); }
    });

    it('a checked-out submodule is exported at the commit the index names', () => {
        const sub = repo({ 'use.py': USE });
        const dir = repo({ 'lib.py': LIB });
        try {
            git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor');
            git(dir, 'commit', '-q', '-m', 'submodule');
            // The submodule's worktree moves on; the index still names the
            // commit whose call site passes one argument.
            write(dir, 'vendor/use.py', USE.replace('widened(1)', 'widened(1, 2)'));
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            const target = resolveTarget(idx(dir), { staged: true });
            try {
                assert.strictEqual(target.ephemeral, true);
                assert.strictEqual(fs.readFileSync(path.join(target.index.root, 'vendor', 'use.py'), 'utf8'), USE);
            } finally { target.dispose(); }
        } finally { rm(dir); rm(sub); }
    });

    it('a submodule of a submodule is exported at the commit its parent names', () => {
        const leaf = repo({ 'use.py': USE });
        const middle = repo({ 'mid.py': 'MID = 1\n' });
        const dir = repo({ 'lib.py': LIB });
        try {
            git(middle, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leaf, 'inner');
            git(middle, 'commit', '-q', '-m', 'inner');
            git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', middle, 'vendor');
            git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
            git(dir, 'commit', '-q', '-m', 'vendor');
            // The innermost worktree moves on; the commits the index names do not.
            write(dir, 'vendor/inner/use.py', USE.replace('widened(1)', 'widened(1, 2)'));
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            const target = resolveTarget(idx(dir), { staged: true });
            try {
                assert.strictEqual(target.ephemeral, true);
                assert.strictEqual(fs.readFileSync(path.join(target.index.root, 'vendor', 'inner', 'use.py'), 'utf8'), USE);
                assert.strictEqual(fs.readFileSync(path.join(target.index.root, 'vendor', 'mid.py'), 'utf8'), 'MID = 1\n');
            } finally { target.dispose(); }
            // The staged call site, two submodules down, still passes one argument.
            const result = staged(dir);
            assert.deepStrictEqual([result.trust.status, result.changed[0].mismatches.map(site => site.file)],
                ['BLOCKED', ['vendor/inner/use.py']]);
        } finally { rm(dir); rm(middle); rm(leaf); }
    });

    it('a submodule the configuration says to ignore is still compared', () => {
        const sub = repo({ 'use.py': USE });
        const dir = repo({ 'lib.py': LIB });
        try {
            git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor');
            git(dir, 'commit', '-q', '-m', 'submodule');
            assert.strictEqual(worktreeMatchesIndex(dir).same, true);
            // The submodule moves to a commit the index does not name.
            write(dir, 'vendor/use.py', USE.replace('widened(1)', 'widened(1, 2)'));
            git(path.join(dir, 'vendor'), 'commit', '-q', '-am', 'moved on');
            git(dir, 'config', 'diff.ignoreSubmodules', 'all');
            git(dir, 'config', 'submodule.vendor.ignore', 'all');
            assert.strictEqual(worktreeMatchesIndex(dir).same, false);
        } finally { rm(dir); rm(sub); }
    });

    it('impact --staged declines when the staged tree cannot be exported', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE, '.gitattributes': '*.py filter=unavailable\n' });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            write(dir, 'lib.py', LIB); // unstaged repair
            git(dir, 'config', 'filter.unavailable.smudge', 'false');
            git(dir, 'config', 'filter.unavailable.required', 'true');
            const index = idx(dir);
            const impact = execute(index, 'impact', { staged: true });
            assert.strictEqual(impact.ok, false);
            assert.match(impact.error, /^The staged tree could not be exported and indexed \(staged-snapshot-unavailable: .*\); nothing was analyzed\.$/);
            assert.doesNotMatch(impact.error, /ucn-staged-/, 'no temporary path in the message');
            const checkedResult = execute(index, 'check', { staged: true }).result;
            assert.deepStrictEqual([checkedResult.ok, checkedResult.status], [false, 'staged-snapshot-unavailable']);
        } finally { rm(dir); }
    });

    it('the snapshot is never saved and leaves nothing behind', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            write(dir, 'scratch.py', 'y = 2\n');
            const target = resolveTarget(idx(dir), { staged: true });
            assert.strictEqual(target.ephemeral, true);
            assert.notStrictEqual(target.index.root, dir);
            assert.strictEqual(target.repoRoot, dir);
            assert.ok(fs.existsSync(path.join(target.index.root, 'lib.py')));
            assert.ok(!fs.existsSync(path.join(target.index.root, 'scratch.py')), 'untracked files are not exported');
            const exportedRoot = target.index.root;
            target.dispose();
            assert.ok(!fs.existsSync(exportedRoot));
        } finally { rm(dir); }
    });
});

describe('impact --staged resolves the same snapshot', () => {
    it('reports the staged declaration and its callers, not the worktree\'s', () => {
        const dir = repo({ 'lib.py': LIB, 'use.py': USE });
        try {
            write(dir, 'lib.py', 'def widened(a, b):\n    return a\n');
            git(dir, 'add', 'lib.py');
            write(dir, 'lib.py', 'def renamed_in_worktree(a):\n    return a\n');
            const done = execute(idx(dir), 'impact', { staged: true });
            assert.ok(done.ok, done.error);
            assert.deepStrictEqual(done.result.functions.map(fn => [fn.name, fn.signature]), [['widened', 'widened (a, b)']]);
            assert.deepStrictEqual(done.result.deletedFunctions, []);
        } finally { rm(dir); }
    });
});

describe('analysis metadata: every non-source file analysis reads is declared', () => {
    it('names the configuration, ignore and manifest files', () => {
        for (const name of ['.ucn.json', '.gitignore', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml',
            'tsconfig.json', 'compile_commands.json', 'src/app/app.csproj', 'nested/dir/package.json']) {
            assert.ok(isAnalysisMetadata(name), name);
        }
        for (const name of ['notes.json', 'src/data.toml', 'README.md']) {
            assert.ok(!isAnalysisMetadata(name), name);
        }
    });

    it('core and languages name no manifest that the registry does not list', () => {
        // A string literal that is a bare manifest-like file name. Cache
        // files UCN writes for itself are not analysis inputs.
        const OWN_FILES = new Set(['index.json', 'calls-cache.json', 'names.json', 'manifest.json',
            'usage-results.json', 'expandable.json', 'next.lock', 'build.lock']);
        const literal = /'((?:\.[a-z]+)?[A-Za-z_][A-Za-z0-9_.-]*\.(?:json|toml|mod|work|cfg|lock|props|targets|gradle|kts|xml|txt|exs|config)|Podfile|Cartfile|Gemfile|Makefile)'/g;
        const undeclared = new Set();
        for (const folder of ['core', 'languages']) {
            for (const file of fs.readdirSync(path.join(__dirname, '..', folder))) {
                if (!file.endsWith('.js')) continue;
                const text = fs.readFileSync(path.join(__dirname, '..', folder, file), 'utf8');
                for (const match of text.matchAll(literal)) {
                    const name = match[1];
                    if (OWN_FILES.has(name) || ANALYSIS_METADATA.includes(name)) continue;
                    undeclared.add(`${folder}/${file}: ${name}`);
                }
            }
        }
        assert.deepStrictEqual([...undeclared].sort(), []);
    });
});
