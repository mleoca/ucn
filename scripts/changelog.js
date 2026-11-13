'use strict';

// CHANGELOG.md, written from the commit subjects between version tags.
//
//   node scripts/changelog.js                  the section of package.json's version:
//                                              the commits since the previous version tag
//   node scripts/changelog.js --all [--from T] every section from tag T on (default: the first tag)
//   node scripts/changelog.js --notes VERSION  print one version's notes (the body of its section)
//
// The npm `version` hook runs the first form, so `npm version <bump>` commits
// the new section with the version. The publish workflow reads the notes of
// the tagged version for the GitHub release.
//
// A subject is filed by its prefix (`fix: ...`, `perf: ...`, also the older
// `fix #123: ...`); a subject without one goes under Other. A version commit
// (its subject is the version) is not an entry.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SECTIONS = [
    ['feat', 'Features'],
    ['fix', 'Fixes'],
    ['perf', 'Performance'],
    ['refactor', 'Refactoring'],
    ['docs', 'Documentation'],
    ['test', 'Tests'],
    ['eval', 'Evaluation'],
    ['maintenance', 'Maintenance'],
    ['other', 'Other'],
];
const MAINTENANCE = new Set(['build', 'ci', 'chore', 'revert', 'style']);
const KNOWN = new Set(SECTIONS.map(([type]) => type));

const HEADER = [
    '# Changelog',
    '',
    'One section per released version, written from the commit subjects by `scripts/changelog.js` when the version is cut.',
    '',
].join('\n');

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of a version or a version tag, or null. */
function versionParts(text) {
    const match = VERSION_RE.exec(String(text).trim());
    return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
    const x = versionParts(a);
    const y = versionParts(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * How a commit subject is filed: { type, text }, or null for a version
 * commit. The text is the subject without its prefix; a prefix may carry a
 * scope (`fix(cli): ...`) or references (`fix #123, #124: ...`).
 */
function classify(subject) {
    const line = String(subject).split('\n')[0].trim();
    if (line === '' || versionParts(line)) return null;
    const match = /^([A-Za-z]+)(?:\([^)]*\))?!?(?:\s+#[^:]*)?:\s+(.+)$/.exec(line);
    if (!match) return { type: 'other', text: line };
    const word = match[1].toLowerCase();
    const type = MAINTENANCE.has(word) ? 'maintenance' : KNOWN.has(word) ? word : null;
    // A colon after an ordinary first word ("Eval CI: ...") is not a prefix.
    if (!type || type === 'other') return { type: 'other', text: line };
    return { type, text: match[2].trim() };
}

/** `#123` would link to an unrelated issue where the notes are rendered. */
const escapeReferences = text => text.replace(/(^|[^\\\w])#(\d)/g, '$1\\#$2');

/**
 * One version's section: a heading, then its entries grouped by kind in a
 * fixed order, newest first inside a group.
 */
function renderSection(version, date, commits) {
    const groups = new Map(SECTIONS.map(([type]) => [type, []]));
    for (const commit of commits) {
        const filed = classify(commit.subject);
        if (!filed) continue;
        groups.get(filed.type).push(`- ${escapeReferences(filed.text)} (${commit.hash})`);
    }
    const lines = [`## ${version} - ${date}`, ''];
    let any = false;
    for (const [type, title] of SECTIONS) {
        const entries = groups.get(type);
        if (entries.length === 0) continue;
        any = true;
        lines.push(`### ${title}`, '', ...entries, '');
    }
    if (!any) lines.push('No recorded changes.', '');
    return lines.join('\n');
}

/** The sections of a changelog text, in file order: [{ version, text }]. */
function splitSections(changelog) {
    const sections = [];
    const starts = [...String(changelog).matchAll(/^## (\d+\.\d+\.\d+)\b.*$/gm)];
    starts.forEach((match, i) => {
        const end = i + 1 < starts.length ? starts[i + 1].index : changelog.length;
        sections.push({ version: match[1], text: changelog.slice(match.index, end).replace(/\n*$/, '\n') });
    });
    return sections;
}

/**
 * The changelog with `section` as the section of `version`: it replaces an
 * existing one, and sections stay ordered newest version first.
 */
function upsertSection(changelog, version, section) {
    const sections = splitSections(changelog || '').filter(entry => entry.version !== version);
    sections.push({ version, text: section.replace(/\n*$/, '\n') });
    sections.sort((a, b) => compareVersions(b.version, a.version));
    return `${HEADER}\n${sections.map(entry => entry.text).join('\n')}`;
}

/** The body of one version's section (without its heading), or null. */
function notesOf(changelog, version) {
    const entry = splitSections(changelog || '').find(section => section.version === version);
    if (!entry) return null;
    return entry.text.split('\n').slice(1).join('\n').trim() + '\n';
}

// ---------------------------------------------------------------- git

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOrNull(cwd, args) {
    try { return git(cwd, args); } catch (_) { return null; }
}

/** The version tags reachable from HEAD, oldest version first. */
function versionTags(cwd) {
    const listed = gitOrNull(cwd, ['tag', '--merged', 'HEAD', '--list', 'v*']);
    if (!listed) return [];
    return listed.split('\n').map(tag => tag.trim()).filter(tag => versionParts(tag)).sort(compareVersions);
}

/** The commits in (from, to], newest first; from the start of history when `from` is null. */
function commitsBetween(cwd, from, to) {
    const range = from ? `${from}..${to}` : to;
    const out = git(cwd, ['log', '--no-merges', '--format=%h%x09%s', range]);
    if (!out) return [];
    return out.split('\n').map(line => {
        const tab = line.indexOf('\t');
        return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/**
 * Whether the clone holds every commit in (previous, to]. A full clone does.
 * A shallow one does when the range starts at a tag it has and no commit of
 * the range is one whose parents were cut off.
 */
function historyIsComplete(cwd, previous, to) {
    const shallow = gitOrNull(cwd, ['rev-parse', '--is-shallow-repository']);
    if (shallow === 'false') return true;
    if (shallow !== 'true' || !previous) return false;
    const boundaryFile = gitOrNull(cwd, ['rev-parse', '--git-path', 'shallow']);
    const boundaryPath = boundaryFile && path.resolve(cwd, boundaryFile);
    if (!boundaryPath || !fs.existsSync(boundaryPath)) return false;
    const cut = new Set(fs.readFileSync(boundaryPath, 'utf8').split('\n').map(line => line.trim()).filter(Boolean));
    const range = gitOrNull(cwd, ['rev-list', `${previous}..${to}`]);
    if (range === null) return false;
    return !range.split('\n').some(commit => cut.has(commit.trim()));
}

/**
 * The section of `version` from the repository's history: the commits after
 * the previous version tag, up to the version's own tag when it exists and
 * to HEAD otherwise. Null when the clone does not hold that history.
 */
function sectionFromHistory(cwd, version, today) {
    const tags = versionTags(cwd);
    const own = tags.find(tag => compareVersions(tag, version) === 0) || null;
    const earlier = tags.filter(tag => compareVersions(tag, version) < 0);
    const previous = earlier.length > 0 ? earlier[earlier.length - 1] : null;
    const to = own || 'HEAD';
    if (!historyIsComplete(cwd, previous, to)) return null;
    const date = own ? git(cwd, ['log', '-1', '--format=%cs', own]) : today;
    return renderSection(version, date, commitsBetween(cwd, previous, to));
}

// ---------------------------------------------------------------- command line

function main(argv, cwd = path.join(__dirname, '..')) {
    const file = path.join(cwd, 'CHANGELOG.md');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const today = new Date().toISOString().slice(0, 10);

    const notesAt = argv.indexOf('--notes');
    if (notesAt !== -1) {
        const version = String(argv[notesAt + 1] || '').replace(/^v/, '');
        if (!versionParts(version)) throw new Error('--notes takes a version, such as 5.6.0');
        // The recorded section, else the history of a version that is tagged.
        const recorded = notesOf(existing, version);
        const tagged = recorded === null &&
            versionTags(cwd).some(tag => compareVersions(tag, version) === 0);
        const section = tagged ? sectionFromHistory(cwd, version, today) : null;
        const notes = recorded !== null ? recorded : section && notesOf(`${HEADER}\n${section}`, version);
        if (!notes) throw new Error(`no notes for ${version}: CHANGELOG.md has no section for it and its history is not in this clone`);
        process.stdout.write(notes);
        return;
    }

    if (argv.includes('--all')) {
        const fromAt = argv.indexOf('--from');
        const from = fromAt !== -1 ? argv[fromAt + 1] : null;
        const tags = versionTags(cwd);
        if (from && !tags.includes(from)) throw new Error(`--from ${from}: not a version tag reachable from HEAD`);
        let text = '';
        for (const tag of tags) {
            if (from && compareVersions(tag, from) < 0) continue;
            const version = tag.replace(/^v/, '');
            const section = sectionFromHistory(cwd, version, today);
            if (section === null) throw new Error(`the history of ${version} is not in this clone`);
            text = upsertSection(text, version, section);
        }
        fs.writeFileSync(file, text);
        console.log(`CHANGELOG.md: ${splitSections(text).length} sections`);
        return;
    }

    const version = require(path.join(cwd, 'package.json')).version;
    const section = sectionFromHistory(cwd, version, today);
    if (section === null) {
        // A shallow clone (the publish job sets the version from the tag):
        // the section was committed with the version, nothing to write.
        console.log(`CHANGELOG.md left as it is: the history needed for ${version} is not in this clone`);
        return;
    }
    fs.writeFileSync(file, upsertSection(existing, version, section));
    console.log(`CHANGELOG.md section -> ${version}`);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(`changelog: ${error.message}`);
        process.exit(1);
    }
}

module.exports = {
    classify, renderSection, splitSections, upsertSection, notesOf,
    versionTags, commitsBetween, sectionFromHistory, compareVersions, main,
};
