'use strict';

// The changelog is written from commit subjects when a version is cut, and
// the publish workflow reads one version's notes from it for the release.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'changelog.js');
const changelog = require('../scripts/changelog');

// A git that reads no configuration of the machine it runs on.
const emptyConfig = path.join(os.tmpdir(), `ucn-changelog-gitconfig-${process.pid}`);
fs.writeFileSync(emptyConfig, '');
process.on('exit', () => fs.rmSync(emptyConfig, { force: true }));
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
};
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();

/** A repository whose history is a list of commit subjects and tags (`@v1.0.0`). */
function repository(history, version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-changelog-'));
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version }));
    let n = 0;
    for (const entry of history) {
        if (entry.startsWith('@')) { git(dir, 'tag', entry.slice(1)); continue; }
        fs.writeFileSync(path.join(dir, 'file.txt'), `${++n}\n`);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '-m', entry);
    }
    return dir;
}
const rm = dir => fs.rmSync(dir, { recursive: true, force: true });
const run = (dir, ...args) => {
    const output = [];
    const write = process.stdout.write;
    const log = console.log;
    process.stdout.write = chunk => { output.push(String(chunk)); return true; };
    console.log = (...parts) => { output.push(parts.join(' ') + '\n'); };
    const env = { ...process.env };
    Object.assign(process.env, GIT_ENV);
    try { changelog.main(args, dir); } finally {
        process.stdout.write = write;
        console.log = log;
        for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
        Object.assign(process.env, env);
    }
    return output.join('');
};
const read = dir => fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');

describe('changelog: how a commit subject is filed', () => {
    it('files a subject by its prefix and keeps the rest as the entry', () => {
        assert.deepEqual(changelog.classify('fix: keep the tier'), { type: 'fix', text: 'keep the tier' });
        assert.deepEqual(changelog.classify('feat(cli): a flag'), { type: 'feat', text: 'a flag' });
        assert.deepEqual(changelog.classify('perf!: faster builds'), { type: 'perf', text: 'faster builds' });
        assert.deepEqual(changelog.classify('Fix: capitalized'), { type: 'fix', text: 'capitalized' });
        assert.deepEqual(changelog.classify('eval: a gate'), { type: 'eval', text: 'a gate' });
        // The older spelling carries references before the colon.
        assert.deepEqual(changelog.classify('fix #357: renames pair with their module'),
            { type: 'fix', text: 'renames pair with their module' });
        assert.deepEqual(changelog.classify('fix #348-#351: alias pairing'), { type: 'fix', text: 'alias pairing' });
        for (const word of ['ci', 'chore', 'build', 'revert']) {
            assert.equal(changelog.classify(`${word}: housekeeping`).type, 'maintenance', word);
        }
    });

    it('files a subject without a known prefix whole, under Other', () => {
        for (const subject of [
            'Fix audit regressions in query limits',
            'Eval CI: repin the language server',
            'usages keeps no default row cap: the listing shows every site',
            'unknownword: something',
        ]) {
            assert.deepEqual(changelog.classify(subject), { type: 'other', text: subject });
        }
    });

    it('a version commit is not an entry', () => {
        assert.equal(changelog.classify('5.5.3'), null);
        assert.equal(changelog.classify('v5.6.0'), null);
        assert.equal(changelog.classify(''), null);
        assert.notEqual(changelog.classify('5.5.3 batch'), null);
    });
});

describe('changelog: sections', () => {
    const commits = [
        { hash: 'ccc3333', subject: 'fix: third' },
        { hash: 'bbb2222', subject: 'feat: second' },
        { hash: 'aaa1111', subject: 'fix: first, see #12' },
        { hash: '0000000', subject: '1.0.0' },
    ];

    it('groups entries by kind in a fixed order, newest first inside a kind', () => {
        assert.equal(changelog.renderSection('1.1.0', '2026-01-02', commits), [
            '## 1.1.0 - 2026-01-02',
            '',
            '### Features',
            '',
            '- second (bbb2222)',
            '',
            '### Fixes',
            '',
            '- third (ccc3333)',
            '- first, see \\#12 (aaa1111)',
            '',
        ].join('\n'));
    });

    it('says so when a version has no entries', () => {
        assert.match(changelog.renderSection('1.0.1', '2026-01-03', [{ hash: 'x', subject: '1.0.1' }]),
            /^## 1\.0\.1 - 2026-01-03\n\nNo recorded changes\.\n$/);
    });

    it('adds a section newest first and replaces the section of a version written before', () => {
        const one = changelog.upsertSection('', '1.0.0', changelog.renderSection('1.0.0', '2026-01-01', [commits[2]]));
        const two = changelog.upsertSection(one, '1.1.0', changelog.renderSection('1.1.0', '2026-01-02', commits.slice(0, 2)));
        assert.deepEqual(changelog.splitSections(two).map(section => section.version), ['1.1.0', '1.0.0']);
        assert.ok(two.startsWith('# Changelog\n'));
        // Writing a version again is the same file; an older version lands in its place.
        assert.equal(changelog.upsertSection(two, '1.1.0', changelog.renderSection('1.1.0', '2026-01-02', commits.slice(0, 2))), two);
        const three = changelog.upsertSection(two, '1.0.5', changelog.renderSection('1.0.5', '2026-01-01', []));
        assert.deepEqual(changelog.splitSections(three).map(section => section.version), ['1.1.0', '1.0.5', '1.0.0']);
        assert.equal(changelog.splitSections(three)[2].text, changelog.splitSections(two)[1].text);
        // Versions order by number, not by text.
        const ten = changelog.upsertSection(three, '1.10.0', changelog.renderSection('1.10.0', '2026-02-01', []));
        assert.deepEqual(changelog.splitSections(ten).map(section => section.version), ['1.10.0', '1.1.0', '1.0.5', '1.0.0']);
    });

    it('reads the notes of one version: its section without the heading', () => {
        const text = changelog.upsertSection('', '1.1.0', changelog.renderSection('1.1.0', '2026-01-02', commits));
        assert.equal(changelog.notesOf(text, '1.1.0'),
            '### Features\n\n- second (bbb2222)\n\n### Fixes\n\n- third (ccc3333)\n- first, see \\#12 (aaa1111)\n');
        assert.equal(changelog.notesOf(text, '1.0.0'), null);
    });
});

describe('changelog: written from the history of a repository', () => {
    const history = [
        'feat: the beginning', 'fix: an early fix', '1.0.0', '@v1.0.0',
        'fix: after the first version', 'docs: a guide', 'Reworked the layout',
    ];

    it('the version being cut gets the commits since the previous version tag', () => {
        const dir = repository(history, '1.1.0');
        try {
            run(dir);
            const text = read(dir);
            assert.deepEqual(changelog.splitSections(text).map(section => section.version), ['1.1.0']);
            assert.match(text, /### Fixes\n\n- after the first version \([0-9a-f]{7,}\)\n/);
            assert.match(text, /### Documentation\n\n- a guide \(/);
            assert.match(text, /### Other\n\n- Reworked the layout \(/);
            assert.doesNotMatch(text, /the beginning|an early fix/);
            assert.match(text, new RegExp(`^## 1\\.1\\.0 - ${new Date().toISOString().slice(0, 10)}$`, 'm'));
            // Cutting the same version again writes the same file.
            run(dir);
            assert.equal(read(dir), text);
        } finally { rm(dir); }
    });

    it('rebuilds every section from the tags, each dated by its tag', () => {
        const dir = repository([...history, '1.1.0', '@v1.1.0', 'fix: not released yet'], '1.1.0');
        try {
            run(dir, '--all');
            const sections = changelog.splitSections(read(dir));
            assert.deepEqual(sections.map(section => section.version), ['1.1.0', '1.0.0']);
            assert.match(sections[1].text, /### Features\n\n- the beginning \(/);
            assert.match(sections[1].text, /- an early fix \(/);
            assert.match(sections[0].text, /- after the first version \(/);
            assert.doesNotMatch(read(dir), /not released yet/);
            assert.match(sections[0].text, new RegExp(`^## 1\\.1\\.0 - ${git(dir, 'log', '-1', '--format=%cs', 'v1.1.0')}\\n`));
            // From a later tag on: the earlier versions are left out.
            run(dir, '--all', '--from', 'v1.1.0');
            assert.deepEqual(changelog.splitSections(read(dir)).map(section => section.version), ['1.1.0']);
            assert.throws(() => run(dir, '--all', '--from', 'v9.9.9'), /not a version tag/);
        } finally { rm(dir); }
    });

    it('prints the notes of a version: recorded ones, else the history of its tag', () => {
        const dir = repository([...history, '1.1.0', '@v1.1.0'], '1.1.0');
        try {
            // No CHANGELOG.md: the notes come from the tag's history.
            const fromHistory = run(dir, '--notes', 'v1.1.0');
            assert.match(fromHistory, /^### Fixes\n\n- after the first version \(/);
            run(dir, '--all');
            assert.equal(run(dir, '--notes', '1.1.0'), fromHistory);
            // A version that is neither recorded nor tagged has no notes.
            assert.throws(() => run(dir, '--notes', '2.0.0'), /no notes for 2\.0\.0/);
            assert.throws(() => run(dir, '--notes', 'next'), /takes a version/);
        } finally { rm(dir); }
    });

    it('a clone without the history leaves the file alone and still serves recorded notes', () => {
        const origin = repository([...history], '1.1.0');
        let clone;
        try {
            run(origin);
            git(origin, 'add', '-A');
            git(origin, 'commit', '-q', '-m', '1.1.0');
            git(origin, 'tag', 'v1.1.0');
            const committed = read(origin);
            clone = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-changelog-clone-'));
            git(clone, 'clone', '-q', '--depth', '1', '--branch', 'v1.1.0', `file://${origin}`, 'work');
            const work = path.join(clone, 'work');
            assert.equal(git(work, 'rev-parse', '--is-shallow-repository'), 'true');
            // The publish job sets the version from the tag in such a clone.
            assert.match(run(work), /left as it is/);
            assert.equal(read(work), committed);
            assert.equal(run(work, '--notes', '1.1.0'), changelog.notesOf(committed, '1.1.0'));
            // Without the recorded section the clone cannot say.
            fs.rmSync(path.join(work, 'CHANGELOG.md'));
            assert.throws(() => run(work, '--notes', '1.1.0'), /not in this clone/);
            assert.match(run(work), /left as it is/);
            assert.equal(fs.existsSync(path.join(work, 'CHANGELOG.md')), false);
        } finally { rm(origin); if (clone) rm(clone); }
    });

    it('a shallow clone that holds the whole range is read like a full one', () => {
        const origin = repository([...history, 'fix: the newest'], '1.1.0');
        let clone;
        try {
            clone = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-changelog-clone-'));
            // Deep enough for the v1.0.0 commit and everything after it.
            git(clone, 'clone', '-q', '--depth', '6', `file://${origin}`, 'work');
            const work = path.join(clone, 'work');
            assert.equal(git(work, 'rev-parse', '--is-shallow-repository'), 'true');
            run(work);
            run(origin);
            assert.equal(read(work), read(origin));
            assert.match(read(work), /- the newest \(/);
        } finally { rm(origin); if (clone) rm(clone); }
    });
});

describe('changelog: the release flow', () => {
    it('npm version commits the new section with the version and tags it', () => {
        const dir = repository(['feat: the beginning', '1.0.0', '@v1.0.0', 'fix: one change', 'perf: another'], '1.0.0');
        try {
            fs.mkdirSync(path.join(dir, 'scripts'));
            fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'changelog.js'));
            // The hook of this package, without the server.json step.
            const hook = require('../package.json').scripts.version;
            assert.match(hook, /node scripts\/changelog\.js/);
            assert.match(hook, /git add [^&]*CHANGELOG\.md/);
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            manifest.scripts = { version: 'node scripts/changelog.js && git add CHANGELOG.md' };
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'chore: release tooling');
            const bumped = spawnSync('npm', ['version', 'minor'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
            assert.equal(bumped.status, 0, bumped.stderr);
            assert.equal(git(dir, 'tag', '--points-at', 'HEAD'), 'v1.1.0');
            assert.equal(git(dir, 'status', '--porcelain'), '');
            const files = git(dir, 'show', '--stat', '--format=', 'HEAD');
            assert.match(files, /CHANGELOG\.md/);
            assert.match(files, /package\.json/);
            const text = git(dir, 'show', 'HEAD:CHANGELOG.md');
            assert.deepEqual(changelog.splitSections(text).map(section => section.version), ['1.1.0']);
            assert.match(text, /### Fixes\n\n- one change \(/);
            assert.match(text, /### Performance\n\n- another \(/);
            assert.match(text, /### Maintenance\n\n- release tooling \(/);
            // The publish job repeats the version from the tag: nothing changes.
            const again = spawnSync('npm', ['version', '1.1.0', '--no-git-tag-version', '--allow-same-version'],
                { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
            assert.equal(again.status, 0, again.stderr);
            assert.equal(git(dir, 'status', '--porcelain'), '');
        } finally { rm(dir); }
    });

    it('the publish workflow creates the release of the tag from these notes', () => {
        const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
        const start = workflow.indexOf('\n  release:\n');
        assert.notEqual(start, -1, 'a release job');
        const next = workflow.indexOf('\n  publish-mcp:\n', start);
        const job = workflow.slice(start, next === -1 ? undefined : next);
        assert.match(job, /needs: publish-npm/);
        assert.match(job, /permissions:\n\s+contents: write/);
        assert.match(job, /fetch-depth: 0/);
        assert.match(job, /node scripts\/changelog\.js --notes "\$\{GITHUB_REF_NAME#v\}"/);
        assert.match(job, /gh release create "\$GITHUB_REF_NAME" --verify-tag/);
        assert.match(job, /gh release edit "\$GITHUB_REF_NAME"/);
        // Only that job may write to the repository.
        assert.equal((workflow.match(/contents: write/g) || []).length, 1);
    });

    it('the committed changelog records the version of this package', () => {
        const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
        const versions = changelog.splitSections(text).map(section => section.version);
        assert.ok(versions.includes(require('../package.json').version),
            'a version is cut with `npm version`, which writes its section');
        assert.deepEqual(versions, [...versions].sort((a, b) => changelog.compareVersions(b, a)));
        assert.equal(new Set(versions).size, versions.length);
        // Regenerating a recorded section changes nothing about the others.
        assert.equal(changelog.upsertSection(text, versions[0], changelog.splitSections(text)[0].text), text);
    });
});
