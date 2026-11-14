/**
 * core/test-units.js — what a test is, where it is, and how to run it.
 *
 * One identity for a test, shared by `tests`, the affected-test selection
 * and `check`: a UNIT is (file, suite chain, name, source extent), read from the
 * declaration the language's runner collects (the language module's
 * `testUnits`). A site of test code belongs to the innermost unit whose
 * source range holds it; an ambiguous line alone does not select a sibling.
 *
 * A RUNNER is named only on evidence: the test file imports the runner's
 * own module, or the nearest build manifest names it. A SELECTOR (the
 * command that runs one unit, or one file) is built only for a runner whose
 * selection syntax is modeled here and only when everything the command
 * depends on is known; otherwise the unit is reported without a command and
 * with the reason. The runner's own configuration is part of that: what
 * is data is read (pytest's options and naming rules, jest's roots and
 * path patterns, vitest's directory, the options a mocha or node script
 * passes), a configuration written as code only where it is one object
 * written out that nothing else in the file can change, and a
 * configuration that can change what a command selects and is not read
 * withholds the command. Nothing here executes anything.
 *
 * A COUNT of tests is of the units listed and not skipped. It is exact
 * only where every test the runner would report is listed: a file that
 * holds tests the reader does not list, or a declaration that stands for
 * several of the runner's tests, makes it a lower bound (`moreTests`),
 * said wherever the count is printed.
 *
 * A test-path file is SUPPORT when it declares no unit, declares no class
 * that could inherit one, and is not named the way the runner names test
 * files: helpers, fixtures, shared setup. It is listed, never counted as a
 * test and never offered as something to run.
 *
 * State lives in the model object, created per operation: manifests can
 * change between two questions asked of one long-lived index.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { langTraits, getParser, safeParse, getLanguageAdapter } = require('../languages');
const { codeUnitCompare, escapeRegExp } = require('./shared');
const { createSignatures } = require('./member-signatures');
const { csharpUsings } = require('./type-denotation');

const CONTAINER_KINDS = new Set(['class', 'struct', 'module', 'namespace', 'interface', 'impl',
    'record', 'enum', 'trait', 'object']);
const CALLABLE_KINDS = new Set(['function', 'method', 'static', 'constructor', 'classmethod',
    'getter', 'setter', 'arrow', 'generator']);

/** A shell word: bare when it needs no quoting, single-quoted otherwise. */
function shellWord(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function regexLiteral(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function posixDir(relativePath) {
    const dir = path.posix.dirname(String(relativePath).replace(/\\/g, '/'));
    return dir === '.' ? '' : dir;
}

function relativeTo(dir, relativePath) {
    const rel = String(relativePath).replace(/\\/g, '/');
    if (!dir) return rel;
    return rel.startsWith(dir + '/') ? rel.slice(dir.length + 1) : null;
}

/** Directories from the file's own up to the project root, nearest first. */
function ancestorDirs(relativePath) {
    const out = [];
    let dir = posixDir(relativePath);
    for (;;) {
        out.push(dir);
        if (!dir) break;
        dir = posixDir(dir);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function createManifests(index) {
    const texts = new Map();
    const listings = new Map();
    const read = (dir, name) => {
        const key = `${dir}\0${name}`;
        if (texts.has(key)) return texts.get(key);
        let text;
        try {
            text = fs.readFileSync(path.join(index.root, dir, name), 'utf8');
        } catch (e) {
            text = null;
        }
        texts.set(key, text);
        return text;
    };
    const list = dir => {
        if (listings.has(dir)) return listings.get(dir);
        let names;
        try {
            names = fs.readdirSync(path.join(index.root, dir)).sort(codeUnitCompare);
        } catch (e) {
            names = [];
        }
        listings.set(dir, names);
        return names;
    };
    const json = (dir, name) => {
        const text = read(dir, name);
        if (text == null) return null;
        try {
            const value = JSON.parse(text);
            return value && typeof value === 'object' ? value : null;
        } catch (e) {
            return null;
        }
    };
    return { read, list, json };
}

/** The table `[name]` of a TOML or INI text, up to the next table header. */
function tableText(text, header) {
    const lines = String(text).split('\n');
    const out = [];
    let inside = false;
    for (const line of lines) {
        const head = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(line);
        if (head) {
            inside = head[1] === header;
            continue;
        }
        if (inside) out.push(line);
    }
    return inside || out.length > 0 ? out.join('\n') : null;
}

function hasTable(text, header) {
    if (text == null) return false;
    return String(text).split('\n').some(line => {
        const head = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(line);
        return !!head && head[1] === header;
    });
}

/**
 * The values of `key` in a pytest configuration table: a TOML array or
 * string, or INI words continued on indented lines. Null when not set.
 */
function configWords(table, key) {
    if (table == null) return null;
    const lines = table.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = new RegExp(`^${key}\\s*[=:]\\s*(.*)$`).exec(lines[i]);
        if (!match) continue;
        let value = match[1];
        if (value.trimStart().startsWith('[')) {
            // A TOML array, possibly over several lines.
            let j = i;
            while (!value.includes(']') && j + 1 < lines.length) value += '\n' + lines[++j];
        } else {
            for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) value += '\n' + lines[j];
        }
        const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] != null ? m[1] : m[2]);
        const words = quoted.length > 0
            ? quoted.flatMap(word => word.split(/\s+/))
            : value.replace(/[#;].*$/gm, '').split(/[\s,[\]]+/);
        return words.filter(Boolean);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

// Package and command names of JavaScript runners; `true` marks the ones
// whose selection syntax is modeled.
const JS_RUNNER_PACKAGES = new Map([
    ['jest', 'jest'], ['vitest', 'vitest'], ['mocha', 'mocha'],
    ['ava', 'ava'], ['tap', 'tap'], ['jasmine', 'jasmine'], ['karma', 'karma'], ['uvu', 'uvu'],
    ['@playwright/test', 'playwright'], ['playwright', 'playwright'], ['cypress', 'cypress'],
    ['@japa/runner', 'japa'], ['tape', 'tape'], ['qunit', 'qunit'], ['lab', 'lab'], ['@hapi/lab', 'lab'],
    ['bun', 'bun'], ['deno', 'deno'], ['wdio', 'wdio'], ['@web/test-runner', 'wtr'], ['wtr', 'wtr'],
    ['react-scripts', 'react-scripts'], ['ng', 'angular'], ['nx', 'nx'], ['turbo', 'turbo'], ['lerna', 'lerna'],
]);
const MODELED_JS = new Set(['node-test', 'jest', 'vitest', 'mocha']);
/**
 * The tests of a file that a focus (`.only`) keeps from running, by each
 * runner's own rule (read from the runners and measured). `units` are the
 * reader's, each with `parent` (the index of the suite it stands in, -1
 * for the file) and `only` as written.
 * - vitest: a test runs when it or a suite around it is marked.
 * - jest: a suite passes its mark down to suites inside it, and to its own
 *   tests unless one of those is marked itself.
 * - mocha: a suite with marked tests of its own runs those and nothing
 *   else of it; otherwise it runs its marked suites (narrowed further when
 *   they hold marks) and the unmarked ones that hold a mark.
 * node:test honours the mark only under --test-only: nothing is left out.
 * @returns {Set<object>} the units that do not run
 */
function focusedOut(units, runner) {
    if (!units.some(unit => unit.only) || !['jest', 'vitest', 'mocha'].includes(runner)) return new Set();
    const children = new Map();
    units.forEach((unit, i) => {
        const parent = unit.parent == null ? -1 : unit.parent;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(i);
    });
    const kids = i => children.get(i) || [];
    const isSuite = i => units[i].kind === 'suite';
    const runs = new Set();
    if (runner === 'vitest') {
        const visit = (parent, included) => {
            for (const i of kids(parent)) {
                const include = included || !!units[i].only;
                if (isSuite(i)) visit(i, include);
                else if (include) runs.add(i);
            }
        };
        visit(-1, false);
    } else if (runner === 'jest') {
        const modes = new Map();
        const modeOf = i => {
            if (i === -1) return null;
            if (!modes.has(i)) modes.set(i, units[i].only ? 'only' : modeOf(units[i].parent == null ? -1 : units[i].parent));
            return modes.get(i);
        };
        units.forEach((unit, i) => {
            if (unit.kind !== 'test') return;
            const parent = unit.parent == null ? -1 : unit.parent;
            const narrowed = modeOf(parent) === 'only' && kids(parent).some(k => !isSuite(k) && units[k].only);
            if (unit.only || (!narrowed && modeOf(parent) === 'only')) runs.add(i);
        });
        // No test ends up focused (an empty marked suite): nothing is left out.
        if (runs.size === 0) return new Set();
    } else {
        const holdsMark = i => kids(i).some(k => units[k].only || (isSuite(k) && holdsMark(k)));
        const all = i => {
            for (const k of kids(i)) {
                if (isSuite(k)) all(k);
                else runs.add(k);
            }
        };
        const narrow = i => {
            const own = kids(i).filter(k => !isSuite(k) && units[k].only);
            if (own.length > 0) {
                for (const k of own) runs.add(k);
                return;
            }
            for (const k of kids(i)) {
                if (!isSuite(k)) continue;
                if (units[k].only && !holdsMark(k)) all(k);
                else if (units[k].only || holdsMark(k)) narrow(k);
            }
        };
        narrow(-1);
    }
    return new Set(units.filter((unit, i) => unit.kind === 'test' && !runs.has(i)));
}
// Node options that take the next word as their value.
const NODE_VALUE_OPTIONS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader',
    '--conditions', '-C', '--env-file', '--test-reporter', '--test-reporter-destination',
    '--test-concurrency', '--test-timeout', '--test-shard', '--test-name-pattern', '--test-skip-pattern',
    '--test-coverage-include', '--test-coverage-exclude', '--watch-path', '--input-type', '--title']);
// Node options that decide how a test file loads; everything else the
// script passes (reporters, coverage, concurrency) is not needed to run one.
const NODE_LOADING_OPTIONS = /^(--import|--require|-r|--loader|--experimental-loader|--conditions|-C|--env-file|--experimental-[\w-]+|--no-experimental-[\w-]+|--enable-source-maps|--preserve-symlinks|--no-warnings)(=|$)/;

/**
 * Runner commands named by a package.json script: the first word of each
 * command of the script, and `--test` after `node`.
 */
function scriptRunners(script) {
    const runners = [];
    if (typeof script !== 'string') return runners;
    for (const command of script.split(/&&|\|\||;|\|/)) {
        const words = command.trim().split(/\s+/).filter(Boolean);
        // Leading environment assignments and wrappers name no runner.
        let i = 0;
        while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
            ['npx', 'cross-env', 'env', 'c8', 'nyc', 'dotenv', '--', 'exec', 'pnpm', 'yarn', 'npm', 'run', 'bunx', 'time'].includes(words[i]))) i++;
        const head = words[i];
        if (!head) continue;
        const base = head.split('/').pop();
        if ((base === 'node' || base === 'tsx' || base === 'ts-node') &&
            words.slice(i + 1).some(word => word === '--test' || word.startsWith('--test='))) {
            runners.push('node-test');
            continue;
        }
        if (base === 'bun' && words[i + 1] === 'test') { runners.push('bun'); continue; }
        if (base === 'deno' && words[i + 1] === 'test') { runners.push('deno'); continue; }
        if (JS_RUNNER_PACKAGES.has(base)) runners.push(JS_RUNNER_PACKAGES.get(base));
        else runners.push(`?${base}`);
    }
    return runners;
}

/**
 * The `node` options of a script that is one `node ... --test ...` command,
 * kept when they decide how a file loads. Null when the script is anything
 * else: then nothing says how the project's tests are loaded.
 */
function nodeTestOptions(script) {
    if (typeof script !== 'string' || /[&|;$`<>(){}*]/.test(script.replace(/\*/g, '')) && /[&|;$`<>(){}]/.test(script)) return null;
    const words = script.trim().split(/\s+/).filter(Boolean);
    if (words[0] !== 'node' || !words.includes('--test')) return null;
    const kept = [];
    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        if (!word.startsWith('-')) continue;
        const takesValue = NODE_VALUE_OPTIONS.has(word);
        if (NODE_LOADING_OPTIONS.test(word)) {
            kept.push(word);
            if (takesValue && i + 1 < words.length) kept.push(words[i + 1]);
        }
        if (takesValue) i++;
    }
    return kept;
}

function jsRunner(model, fileEntry) {
    // 1. The file's own imports.
    const modules = langTraits(fileEntry.language)?.testRunnerModules?.() || new Map();
    const imported = new Set();
    for (const mod of fileEntry.imports || []) {
        const runner = modules.get(mod);
        if (runner) imported.add(runner);
    }
    if (imported.size > 1) return { id: null, reason: 'ambiguous-runner' };
    let fromFile = imported.size === 1 ? [...imported][0] : null;
    if (fromFile && !MODELED_JS.has(fromFile)) return { id: null, reason: 'runner-not-modeled', runner: fromFile };

    // 2. The nearest package manifest.
    let dir = null;
    let manifest = null;
    for (const candidate of ancestorDirs(fileEntry.relativePath)) {
        manifest = model.manifests.json(candidate, 'package.json');
        if (manifest) { dir = candidate; break; }
    }
    const script = manifest && manifest.scripts && typeof manifest.scripts.test === 'string'
        ? manifest.scripts.test : null;
    if (fromFile) {
        return { id: fromFile, dir: dir || '', evidence: 'test-file-import', script, scripts: manifest ? manifest.scripts : null };
    }
    if (!manifest) return { id: null, reason: 'no-runner-evidence' };
    const named = [...new Set(scriptRunners(script).filter(name => !name.startsWith('?')))];
    if (named.length === 1) {
        if (!MODELED_JS.has(named[0])) return { id: null, reason: 'runner-not-modeled', runner: named[0] };
        return { id: named[0], dir, evidence: 'package-script', script, scripts: manifest.scripts };
    }
    if (named.length > 1) return { id: null, reason: 'ambiguous-runner' };
    const declared = new Set();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(manifest[field] || {})) {
            if (JS_RUNNER_PACKAGES.has(name)) declared.add(JS_RUNNER_PACKAGES.get(name));
        }
    }
    if (declared.size === 1) {
        const only = [...declared][0];
        if (!MODELED_JS.has(only)) return { id: null, reason: 'runner-not-modeled', runner: only };
        return { id: only, dir, evidence: 'package-dependency', script, scripts: manifest.scripts };
    }
    return { id: null, reason: declared.size > 1 ? 'ambiguous-runner' : 'no-runner-evidence' };
}

/** pytest's configuration file for a directory, by pytest's own order. */
function pytestConfigIn(model, dir) {
    const ini = model.manifests.read(dir, 'pytest.ini');
    if (ini != null) return { file: 'pytest.ini', table: tableText(ini, 'pytest') || '' };
    const project = model.manifests.read(dir, 'pyproject.toml');
    if (project != null) {
        for (const header of ['tool.pytest.ini_options', 'tool.pytest']) {
            if (hasTable(project, header)) return { file: 'pyproject.toml', table: tableText(project, header) || '' };
        }
    }
    const tox = model.manifests.read(dir, 'tox.ini');
    if (tox != null && hasTable(tox, 'pytest')) return { file: 'tox.ini', table: tableText(tox, 'pytest') || '' };
    const setup = model.manifests.read(dir, 'setup.cfg');
    if (setup != null && hasTable(setup, 'tool:pytest')) {
        return { file: 'setup.cfg', table: tableText(setup, 'tool:pytest') || '' };
    }
    return null;
}

/**
 * Does a requirements file or a manifest name a package as a requirement:
 * the name where a requirement starts (a line, a list item, a quoted
 * string, a key), up to a version or the end. A word in a comment or in
 * another package's name is not one.
 */
function namesRequirement(text, name) {
    const shape = new RegExp(`(^|["'\\s,\\[])${name}(\\[[^\\]]*\\])?\\s*([<>=!~;,"'\\]]|$)`);
    return String(text).split('\n').some(raw => shape.test(raw.replace(/(^|\s)[#;].*$/, '').trim()));
}

function pythonRunner(model, fileEntry) {
    const dirs = ancestorDirs(fileEntry.relativePath);
    for (const dir of dirs) {
        const config = pytestConfigIn(model, dir);
        if (config) {
            return {
                id: 'pytest', dir, evidence: config.file,
                collection: {
                    files: configWords(config.table, 'python_files'),
                    classes: configWords(config.table, 'python_classes'),
                    functions: configWords(config.table, 'python_functions'),
                    options: pytestOptions(configArguments(config, 'addopts')),
                    // Fixtures every test is given, and whether a test a
                    // module imports is collected there too.
                    usefixtures: configWords(config.table, 'usefixtures') || [],
                    importedTests: !/^(false|no|off|0)$/i.test((configWords(config.table, 'collect_imported_tests') || [])[0] || ''),
                },
            };
        }
    }
    if ((fileEntry.imports || []).some(mod => mod === 'pytest' || String(mod).startsWith('pytest.'))) {
        return { id: 'pytest', dir: '', evidence: 'test-file-import', collection: {} };
    }
    for (const dir of dirs) {
        const conftest = dir ? `${dir}/conftest.py` : 'conftest.py';
        if (model.hasFile(conftest)) return { id: 'pytest', dir: '', evidence: 'conftest.py', collection: {} };
    }
    for (const dir of dirs) {
        for (const name of ['pyproject.toml', 'requirements.txt', 'setup.cfg', 'tox.ini']) {
            const text = model.manifests.read(dir, name);
            if (text != null && namesRequirement(text, 'pytest')) {
                return { id: 'pytest', dir, evidence: name, collection: {} };
            }
        }
    }
    return { id: null, reason: 'no-runner-evidence' };
}

function goRunner(model, fileEntry) {
    for (const dir of ancestorDirs(fileEntry.relativePath)) {
        if (model.manifests.read(dir, 'go.mod') != null) return { id: 'go-test', dir, evidence: 'go.mod' };
    }
    return { id: null, reason: 'no-runner-evidence' };
}

function rustRunner(model, fileEntry) {
    for (const dir of ancestorDirs(fileEntry.relativePath)) {
        const text = model.manifests.read(dir, 'Cargo.toml');
        if (text == null) continue;
        if (!hasTable(text, 'package')) return { id: null, reason: 'no-package-manifest' };
        const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(tableText(text, 'package') || '');
        // Targets the manifest lays out itself are not where cargo's
        // conventions put them.
        const customTargets = ['lib', 'bin', 'test'].some(header => {
            const table = tableText(text, header);
            return table != null && /^\s*(path|name|harness)\s*=/m.test(table);
        });
        return {
            id: 'cargo-test', dir, evidence: 'Cargo.toml',
            packageName: name ? name[1] : null,
            customTargets,
        };
    }
    return { id: null, reason: 'no-runner-evidence' };
}

function javaRunner(model, fileEntry) {
    for (const dir of ancestorDirs(fileEntry.relativePath)) {
        if (model.manifests.read(dir, 'pom.xml') != null) return { id: 'maven', dir, evidence: 'pom.xml' };
        for (const name of ['build.gradle', 'build.gradle.kts']) {
            if (model.manifests.read(dir, name) != null) return { id: null, reason: 'runner-not-modeled', runner: 'gradle' };
        }
    }
    return { id: null, reason: 'no-runner-evidence' };
}

function dotnetRunner(model, fileEntry) {
    for (const dir of ancestorDirs(fileEntry.relativePath)) {
        const projects = model.manifests.list(dir).filter(name => name.endsWith('.csproj'));
        if (projects.length === 0) continue;
        if (projects.length > 1) return { id: null, reason: 'ambiguous-runner' };
        const text = model.manifests.read(dir, projects[0]) || '';
        if (!/Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i.test(text)) return { id: null, reason: 'no-runner-evidence' };
        return { id: 'dotnet-test', dir, evidence: projects[0] };
    }
    return { id: null, reason: 'no-runner-evidence' };
}

// ---------------------------------------------------------------------------
// What the runner's own configuration changes
// ---------------------------------------------------------------------------

/** Words of a shell-like option string: quotes group, a backslash escapes. */
function shellSplit(text) {
    const words = [];
    let current = null;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            if (current == null) current = '';
        } else if (/\s/.test(ch)) {
            if (current != null) words.push(current);
            current = null;
        } else if (ch === '\\' && i + 1 < text.length) {
            current = (current == null ? '' : current) + text[++i];
        } else {
            current = (current == null ? '' : current) + ch;
        }
    }
    if (current != null) words.push(current);
    return words;
}

/** A TOML line without its comment. */
function withoutTomlComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === '\\' && quote === '"') i++;
            else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '#') {
            return line.slice(0, i);
        }
    }
    return line;
}

/**
 * The arguments a pytest configuration gives for `key` (addopts): a TOML
 * array holds one argument per string; a string, and an INI value with its
 * continuation lines, is split the way a shell would. [] when the key is
 * not set, null when its value is not read.
 */
function configArguments(config, key) {
    if (!config || config.table == null) return [];
    const lines = config.table.split('\n');
    const toml = config.file === 'pyproject.toml';
    for (let i = 0; i < lines.length; i++) {
        const match = new RegExp(`^${key}\\s*[=:]\\s*(.*)$`).exec(lines[i]);
        if (!match) continue;
        if (!toml) {
            let value = match[1];
            for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) value += ' ' + lines[j].trim();
            return shellSplit(value);
        }
        let value = withoutTomlComment(match[1]);
        if (/"""|'''/.test(value)) return null;
        const strings = text => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)]
            .map(found => found[1] != null ? found[1].replace(/\\(.)/g, '$1') : found[2]);
        if (value.trimStart().startsWith('[')) {
            for (let j = i + 1; !/\]\s*$/.test(value) && j < lines.length; j++) value += '\n' + withoutTomlComment(lines[j]);
            return /\]\s*$/.test(value) ? strings(value) : null;
        }
        const whole = strings(value);
        return whole.length === 1 ? shellSplit(whole[0]) : null;
    }
    return [];
}

// pytest options that change neither what is collected nor what a command
// that names a test runs. --ignore leaves a path out of a whole run only:
// a path given to the command is still collected (measured).
const PYTEST_INERT_FLAGS = new Set(['-v', '-vv', '-vvv', '--verbose', '-q', '-qq', '--quiet', '-s', '-l',
    '--showlocals', '-x', '--exitfirst', '--strict-markers', '--strict-config', '--strict', '--no-header',
    '--no-summary', '--disable-warnings', '--disable-pytest-warnings', '--ff', '--failed-first', '--nf',
    '--new-first', '--cache-clear', '--full-trace', '--runxfail', '--no-cov-on-fail', '--cov-branch',
    '--cov-append', '--no-cov', '--cov']);
const PYTEST_INERT_VALUED = new Set(['--tb', '--color', '--durations', '--durations-min', '--maxfail',
    '--capture', '-W', '--pythonwarnings', '--cov', '--cov-report', '--cov-config', '--cov-fail-under',
    '--cov-context', '--junitxml', '--junit-xml', '--junit-prefix', '--log-level', '--log-cli-level',
    '--log-format', '--log-date-format', '--log-file', '--log-file-level', '--basetemp', '--import-mode',
    '--timeout', '--timeout-method', '-n', '--numprocesses', '--dist', '--maxprocesses', '--reruns',
    '--reruns-delay', '--show-capture', '--code-highlight', '--verbosity', '--asyncio-mode', '--ignore',
    '--ignore-glob', '-r']);
// pytest's own plugins that decide what is collected, selected or skipped:
// switching one of these off changes which tests run. Any other plugin
// switched off (-p no:name) changes none of that; one switched ON is code
// that is not read.
const PYTEST_SELECTING_PLUGINS = new Set(['python', 'unittest', 'mark', 'skipping', 'main', 'runner', 'fixtures',
    'stepwise', 'setuponly', 'setupplan', 'nose']);

/**
 * What pytest's configured options do to selection: `markExpr` (-m) and
 * `deselect` (--deselect) are applied to the units; `unread` says an
 * option is there that may select, add or leave out tests and is not
 * modeled (-k, a path, a plugin, an override): no command is exact then.
 */
function pytestOptions(words) {
    const out = { markExpr: null, deselect: [], unread: false };
    if (words == null) return { ...out, unread: true };
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const cut = word.startsWith('--') ? word.indexOf('=') : -1;
        const name = cut > 0 ? word.slice(0, cut) : word;
        const inline = cut > 0 ? word.slice(cut + 1) : null;
        const value = () => (inline != null ? inline : words[++i]);
        if (name === '-m') {
            const expression = value();
            if (expression == null) out.unread = true;
            else out.markExpr = expression;
        } else if (name === '--deselect') {
            const id = value();
            if (id) out.deselect.push(id);
            else out.unread = true;
        } else if (name === '-p') {
            const plugin = String(value() || '');
            if (!plugin.startsWith('no:') || PYTEST_SELECTING_PLUGINS.has(plugin.slice(3))) out.unread = true;
        } else if (/^-r[A-Za-z]+$/.test(word) || /^-W\S+$/.test(word) || /^-n\S+$/.test(word)) {
            // -ra, -Werror, -n4: the value is in the word.
        } else if (inline != null ? PYTEST_INERT_VALUED.has(name) : PYTEST_INERT_FLAGS.has(name) && !PYTEST_INERT_VALUED.has(name)) {
            // nothing
        } else if (inline == null && name === '--cov') {
            // --cov takes an optional value: a word after it that is no
            // option would be read as a path otherwise.
            if (i + 1 < words.length && !words[i + 1].startsWith('-')) i++;
        } else if (inline == null && PYTEST_INERT_VALUED.has(name)) {
            i++;
        } else {
            out.unread = true;
        }
    }
    return out;
}

/**
 * Does pytest's mark expression select a test with these marks: true,
 * false, or null when it cannot be said (`open`: the test may carry marks
 * that are not read; an expression in a form not modeled).
 */
function markSelects(expression, marks, open) {
    const tokens = String(expression).match(/\(|\)|[^\s()]+/g) || [];
    let at = 0;
    const not = value => (value == null ? null : !value);
    const primary = () => {
        const token = tokens[at++];
        if (token === 'not') return not(primary());
        if (token === '(') {
            const inner = either();
            if (tokens[at++] !== ')') throw new Error('unbalanced');
            return inner;
        }
        if (token == null || token === ')' || token === 'and' || token === 'or') throw new Error('unexpected');
        // name(arg=value): a mark with arguments, not modeled.
        if (tokens[at] === '(') throw new Error('arguments');
        return marks.has(token) ? true : open ? null : false;
    };
    const both = () => {
        let value = primary();
        while (tokens[at] === 'and') {
            at++;
            const next = primary();
            value = value === false || next === false ? false : value == null || next == null ? null : true;
        }
        return value;
    };
    const either = () => {
        let value = both();
        while (tokens[at] === 'or') {
            at++;
            const next = both();
            value = value === true || next === true ? true : value == null || next == null ? null : false;
        }
        return value;
    };
    try {
        const value = either();
        return at === tokens.length ? value : null;
    } catch (e) {
        return null;
    }
}

/** A path glob as a regular expression: `**`, `*`, `?`, `{a,b}`, `[...]`. */
function pathGlob(glob) {
    const text = String(glob).replace(/^\.\//, '');
    let source = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '*' && text[i + 1] === '*') {
            i++;
            if (text[i + 1] === '/') {
                i++;
                source += '(?:.*/)?';
            } else {
                source += '.*';
            }
        } else if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
        } else if (ch === '{' || ch === '[') {
            const end = text.indexOf(ch === '{' ? '}' : ']', i);
            if (end < 0) return null;
            source += ch === '[' ? text.slice(i, end + 1)
                : `(?:${text.slice(i + 1, end).split(',').map(part => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`;
            i = end;
        } else {
            source += ch.replace(/[.+^$()|\\]/, '\\$&');
        }
    }
    try {
        return new RegExp(`^${source}$`);
    } catch (e) {
        return null;
    }
}

// The files `node --test` runs when it is given none (node's own list).
const NODE_DEFAULT_TEST_FILES = [/(^|\/)[^/]*[._-]test\.[cm]?js$/, /(^|\/)test-[^/]*\.[cm]?js$/,
    /(^|\/)test\.[cm]?js$/, /(^|\/)test\/.*\.[cm]?js$/];

/**
 * The paths a script that is one `node ... --test ...` command names, as
 * written (a glob stays a glob). Null when the script is anything else.
 */
function nodeTestPaths(script) {
    if (nodeTestOptions(script) == null) return null;
    const words = script.trim().split(/\s+/).filter(Boolean);
    const paths = [];
    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        if (word.startsWith('-')) {
            if (NODE_VALUE_OPTIONS.has(word)) i++;
            continue;
        }
        paths.push(word.replace(/^(['"])(.*)\1$/, '$2'));
    }
    return paths;
}

/**
 * Does node run a file as a test under the project's own script: one of
 * the paths the script names, or, when it names none, one node looks for
 * by itself (every file under a `test` directory among them). node runs a
 * file that declares no test as one test. Null: the script does not say.
 */
function nodeRunsFile(runner, file) {
    const paths = nodeTestPaths(runner.script);
    if (paths == null || file == null) return null;
    if (paths.length === 0) return !/(^|\/)node_modules\//.test(file) && NODE_DEFAULT_TEST_FILES.some(pattern => pattern.test(file));
    return paths.some(written => {
        const target = written.replace(/^\.\//, '');
        if (target === file) return true;
        if (!/[*?{[]/.test(target)) return false;
        const pattern = pathGlob(target);
        return !!pattern && pattern.test(file);
    });
}

/**
 * The words a project's test script passes to a runner: those of the
 * `test` script and of the scripts it names, after the runner's own name.
 * [] when the script does not call the runner by name.
 */
function runnerScriptWords(runner, name) {
    const scripts = runner.scripts && typeof runner.scripts === 'object' ? runner.scripts : {};
    const texts = [];
    if (typeof runner.script === 'string') {
        texts.push(runner.script);
        for (const word of runner.script.split(/[\s"'&|;]+/)) {
            if (word !== 'test' && typeof scripts[word] === 'string') texts.push(scripts[word]);
        }
    }
    const out = [];
    for (const text of texts) {
        for (const segment of text.split(/&&|\|\||;|\|/)) {
            const words = segment.trim().split(/\s+/).filter(Boolean);
            const at = words.findIndex(word => word.split('/').pop() === name || word.split('/').pop() === `_${name}`);
            if (at >= 0) out.push(...words.slice(at + 1));
        }
    }
    return out;
}

// Options of a runner's command line that point it at another
// configuration or select files: a script that passes one runs something
// a command built here does not.
const SCRIPT_CONFIG_FLAGS = /^(--config|-c|--rootDir|--roots|--projects|--selectProjects|--project|--workspace|--root|--dir|--testMatch|--testRegex|--testPathPattern|--testPathPatterns|--package|--opts)(=|$)/;
// Options of a mocha command line that decide how a test file loads.
const MOCHA_LOADING_OPTIONS = new Set(['--require', '-r', '--loader', '--import', '--ui', '-u', '--file', '--node-option', '-n']);
const MOCHA_VALUE_OPTIONS = new Set([...MOCHA_LOADING_OPTIONS, '--reporter', '-R', '--reporter-option', '--reporter-options',
    '-O', '--timeout', '-t', '--timeouts', '--slow', '-s', '--retries', '--grep', '-g', '--fgrep', '-f', '--ignore',
    '--exclude', '--spec', '--jobs', '-j', '--watch-files', '--watch-ignore', '--extension', '--config', '--package']);

/**
 * The options of the project's mocha script that a command for one file
 * needs to load it the same way (--require, --ui, --loader, --file).
 */
function mochaLoadingOptions(runner) {
    const words = runnerScriptWords(runner, 'mocha');
    const kept = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i].replace(/^(['"])(.*)\1$/, '$2');
        const cut = word.startsWith('--') ? word.indexOf('=') : -1;
        const name = cut > 0 ? word.slice(0, cut) : word;
        if (MOCHA_LOADING_OPTIONS.has(name)) {
            kept.push(word);
            if (cut < 0 && i + 1 < words.length) kept.push(words[++i].replace(/^(['"])(.*)\1$/, '$2'));
        } else if (cut < 0 && MOCHA_VALUE_OPTIONS.has(name)) {
            i++;
        }
    }
    return kept;
}

// Configuration files of the JavaScript runners.
const JS_CONFIG_NAMES = {
    jest: new Set(['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts',
        'jest.config.mts', 'jest.config.json']),
    vitest: new Set(['vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs', 'vitest.config.ts',
        'vitest.config.cts', 'vitest.config.mts', 'vite.config.js', 'vite.config.cjs', 'vite.config.mjs',
        'vite.config.ts', 'vite.config.cts', 'vite.config.mts', 'vitest.workspace.js', 'vitest.workspace.mjs',
        'vitest.workspace.ts', 'vitest.workspace.mts', 'vitest.workspace.json', 'vitest.projects.js',
        'vitest.projects.ts', 'vitest.projects.json']),
    mocha: new Set(['.mocharc', '.mocharc.js', '.mocharc.cjs', '.mocharc.mjs', '.mocharc.json', '.mocharc.jsonc',
        '.mocharc.yaml', '.mocharc.yml']),
};
const JS_CONFIG_PACKAGE_KEY = { jest: 'jest', mocha: 'mocha' };
// The keys of a configuration that are known to leave alone which tests a
// command for one file runs. Every other key may select: it is evaluated
// where it is modeled (JS_MODELED_KEYS), and the configuration is not read
// otherwise. vitest's are the keys of `test`; mocha's are compared with
// dashes and case folded (it takes both spellings).
const JS_INERT_KEYS = {
    jest: new Set(['automock', 'bail', 'cache', 'cacheDirectory', 'ci', 'clearMocks', 'collectCoverage',
        'collectCoverageFrom', 'coverageDirectory', 'coveragePathIgnorePatterns', 'coverageProvider',
        'coverageReporters', 'coverageThreshold', 'detectLeaks', 'detectOpenHandles', 'displayName',
        'errorOnDeprecated', 'expand', 'extensionsToTreatAsEsm', 'fakeTimers', 'forceCoverageMatch', 'forceExit',
        'globalSetup', 'globalTeardown', 'globals', 'json', 'logHeapUsage', 'maxConcurrency', 'maxWorkers',
        'moduleDirectories', 'moduleNameMapper', 'modulePaths', 'noStackTrace', 'notify', 'notifyMode',
        'openHandlesTimeout', 'outputFile', 'passWithNoTests', 'prettierPath', 'randomize', 'reporters',
        'resetMocks', 'resetModules', 'resolver', 'restoreMocks', 'sandboxInjectedGlobals', 'setupFiles',
        'setupFilesAfterEnv', 'showSeed', 'silent', 'slowTestThreshold', 'snapshotFormat', 'snapshotResolver',
        'snapshotSerializers', 'testEnvironment', 'testEnvironmentOptions', 'testFailureExitCode',
        'testLocationInResults', 'testResultsProcessor', 'testTimeout', 'transform', 'transformIgnorePatterns',
        'unmockedModulePathPatterns', 'useStderr', 'verbose', 'watchPathIgnorePatterns', 'watchPlugins',
        'watchman', 'workerIdleMemoryLimit', 'workerThreads', 'dependencyExtractor', 'waitForUnhandledRejections',
        '//',
        // Names earlier versions of jest used for keys of this list.
        'testURL', 'timers', 'setupTestFrameworkScriptFile', 'mapCoverage', 'name', 'extraGlobals', 'browser']),
    vitest: new Set(['alias', 'api', 'attachmentsDir', 'bail', 'benchmark', 'cache', 'chaiConfig', 'clearMocks',
        'coverage', 'css', 'dangerouslyIgnoreUnhandledErrors', 'deps', 'diff', 'disableConsoleIntercept', 'env',
        'environment', 'environmentMatchGlobs', 'environmentOptions', 'expandSnapshotDiff', 'expect', 'fakeTimers',
        'fileParallelism', 'globals', 'globalSetup', 'hookTimeout', 'includeTaskLocation', 'isolate',
        'logHeapUsage', 'maxConcurrency', 'maxWorkers', 'minWorkers', 'mockReset', 'name', 'onConsoleLog',
        'onStackTrace', 'open', 'outputFile', 'passWithNoTests', 'pool', 'poolMatchGlobs', 'poolOptions',
        'printConsoleTrace', 'provide', 'reporters', 'resolveSnapshotPath', 'restoreMocks', 'retry', 'sequence',
        'server', 'setupFiles', 'silent', 'slowTestThreshold', 'snapshotFormat', 'snapshotSerializers',
        'teardownTimeout', 'testTimeout', 'ui', 'unstubEnvs', 'unstubGlobals', 'update', 'watch']),
    mocha: new Set(['allowuncaught', 'asynconly', 'bail', 'checkleaks', 'color', 'colors', 'diff',
        'enablesourcemaps', 'exit', 'failzero', 'fulltrace', 'global', 'globals', 'import', 'inlinediffs', 'jobs',
        'loader', 'nodeoption', 'nodeoptions', 'parallel', 'recursive', 'reporter', 'reporteroption',
        'reporteroptions', 'require', 'retries', 'slow', 'sort', 'timeout', 'timeouts', 'watch', 'watchfiles',
        'watchignore']),
};
const JS_MODELED_KEYS = {
    jest: new Set(['roots', 'testRegex', 'testPathIgnorePatterns']),
    vitest: new Set(['dir']),
    mocha: new Set(),
};
// The keys of a vite configuration, beside `test` and `plugins`, that
// leave vitest's file selection alone.
const VITE_INERT_KEYS = new Set(['appType', 'assetsInclude', 'base', 'build', 'cacheDir', 'clearScreen', 'css',
    'define', 'dev', 'envDir', 'envPrefix', 'environments', 'esbuild', 'experimental', 'future', 'html', 'json',
    'legacy', 'logLevel', 'mode', 'optimizeDeps', 'oxc', 'preview', 'publicDir', 'resolve', 'server', 'ssr',
    'worker']);
// The functions a runner's own package gives a configuration to pass
// through unchanged: the name alone proves nothing, the import does.
const CONFIG_IDENTITY = {
    jest: { modules: new Set(['jest']), names: new Set(['defineConfig']) },
    vitest: { modules: new Set(['vitest/config', 'vite', 'vitest']), names: new Set(['defineConfig', 'defineProject']) },
};
const CONFIG_WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression',
    'type_assertion', 'non_null_expression']);
// Modules whose functions act on the process or the disk, and the
// functions of them that only read.
const CONFIG_ACTING_MODULES = new Set(['fs', 'fs/promises', 'child_process', 'module', 'vm', 'worker_threads',
    'cluster', 'process', 'inspector', 'repl']);
const CONFIG_READING_CALLS = new Set(['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync',
    'realpathSync', 'createRequire']);
const CONFIG_GLOBAL_NAMESPACES = new Set(['JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean']);
const CONFIG_CONSTRUCTORS = new Set(['URL', 'RegExp', 'Set', 'Map', 'Date']);
const CONFIG_NAME_NODES = new Set(['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern']);

/** The value of a string literal node (no substitutions), or null. */
function stringLiteralValue(node) {
    if (!node || (node.type !== 'string' && node.type !== 'template_string')) return null;
    if (node.namedChildren.some(child => child.type === 'template_substitution')) return null;
    const escapes = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    return node.text.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (whole, escape) => {
        if (escape[0] === 'u' || escape[0] === 'x') {
            const code = parseInt(escape.replace(/^[ux]\{?|\}$/g, ''), 16);
            return Number.isNaN(code) ? whole : String.fromCodePoint(code);
        }
        return Object.prototype.hasOwnProperty.call(escapes, escape) ? escapes[escape] : escape;
    });
}

/** JSON text with its comments taken out; what a string holds is left as it is. */
function withoutJsonComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            let end = i + 1;
            while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
            out += text.slice(i, end + 1);
            i = end + 1;
        } else if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            out += ' ';
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

/**
 * The keys a configuration sets, each with readers of its value: as
 * strings (null when the value is not a string or a list of strings
 * written out), as an object of keys, and whether it is a list of calls
 * of functions that packages provide. Null when the value is no object.
 */
function configKeysOfJson(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = new Map();
    for (const [key, held] of Object.entries(value)) {
        keys.set(key, {
            strings: () => typeof held === 'string' ? [held]
                : Array.isArray(held) && held.every(item => typeof item === 'string') ? held : null,
            object: () => configKeysOfJson(held),
            packageCalls: () => Array.isArray(held) && held.length === 0,
        });
    }
    return keys;
}

/**
 * The top-level keys of a YAML mapping written as a block, one `key:` to
 * a line at the left margin; their values are not read. Null for every
 * other way of writing one (a flow mapping, indented keys, a merge key, a
 * key that is not a plain or quoted word): what such a file sets is not
 * read.
 */
function configKeysOfYaml(text) {
    const keys = new Map();
    let started = false;
    for (const line of String(text).split(/\r?\n/)) {
        if (/^\s*(#.*)?$/.test(line)) continue;
        if (!started && keys.size === 0 && /^---\s*(#.*)?$/.test(line)) {
            started = true;
            continue;
        }
        // The value of the key above: indented lines, or a list at the margin.
        if (/^[ \t]/.test(line) || /^-(\s|$)/.test(line)) {
            if (keys.size === 0) return null;
            continue;
        }
        const found = /^([A-Za-z][\w-]*|"[A-Za-z][\w-]*"|'[A-Za-z][\w-]*')\s*:(\s|$)/.exec(line);
        if (!found) return null;
        keys.set(found[1].replace(/^['"]|['"]$/g, ''), { strings: () => null, object: () => null, packageCalls: () => false });
    }
    return keys;
}

/**
 * The keys a configuration written as code sets, when the file is one
 * object written out and nothing else in it can change that object or act
 * on the run. The file may hold only: imports that bind names, variable
 * declarations whose values are built without running code of the file
 * (literals, names, operators, calls of functions that packages and the
 * language provide), type declarations, and ONE export (`module.exports =`
 * or `export default`) of an object literal: written in place, held by a
 * variable that is named nowhere else, or passed through the function the
 * runner's own package provides for that (proved by the import). A second
 * statement that writes the export, a name for the object that is used
 * again, a function of the file that is called, a write anywhere: the file
 * is code whose effect is not read (null).
 */
function configKeysOfCode(text, typed, runnerId) {
    const tree = safeParse(getParser(typed ? 'typescript' : 'javascript'), text);
    if (!tree || tree.rootNode.hasError) return null;
    const root = tree.rootNode;
    const bindings = new Map(); // local name -> { module, imported } (imported null: the module itself)
    const declared = new Map(); // local name -> value nodes of its declarators
    const packaged = name => {
        const binding = bindings.get(name);
        return !!binding && !/^\.{0,2}\//.test(binding.module) && !/^[A-Za-z]:[\\/]/.test(binding.module);
    };
    const moduleName = binding => binding.module.replace(/^node:/, '');
    const requiredModule = node => {
        if (!node || node.type !== 'call_expression') return null;
        const callee = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        if (!callee || callee.type !== 'identifier' || callee.text !== 'require' || !args || args.namedChildren.length !== 1) return null;
        return stringLiteralValue(args.namedChildren[0]);
    };
    /** Is a callee a function that a package or the language provides? */
    const calleeProvided = callee => {
        if (!callee) return false;
        if (CONFIG_WRAPPERS.has(callee.type)) return calleeProvided(callee.namedChildren[0]);
        if (callee.type === 'identifier') {
            const binding = bindings.get(callee.text);
            return packaged(callee.text) && !CONFIG_ACTING_MODULES.has(moduleName(binding)) ||
                (!!binding && packaged(callee.text) && CONFIG_READING_CALLS.has(binding.imported));
        }
        if (callee.type === 'call_expression') {
            // require('path').join, a function a package's function returns
            return requiredModule(callee) != null ? !CONFIG_ACTING_MODULES.has(requiredModule(callee).replace(/^node:/, ''))
                : calleeProvided(callee.childForFieldName('function')) && inert(callee.childForFieldName('arguments'));
        }
        if (callee.type !== 'member_expression') return false;
        const property = callee.childForFieldName('property');
        let base = callee;
        while (base && (base.type === 'member_expression' || CONFIG_WRAPPERS.has(base.type))) {
            base = base.type === 'member_expression' ? base.childForFieldName('object') : base.namedChildren[0];
        }
        if (!base || !property) return false;
        if (base.type === 'call_expression') {
            const required = requiredModule(base);
            if (required != null) {
                return !CONFIG_ACTING_MODULES.has(required.replace(/^node:/, '')) || CONFIG_READING_CALLS.has(property.text);
            }
            return calleeProvided(base.childForFieldName('function')) && inert(base.childForFieldName('arguments'));
        }
        if (base.type === 'meta_property') return true;
        if (base.type !== 'identifier') return false;
        if (base.text === 'process') {
            // process.cwd() and nothing else of the process is called.
            return sameNodeText(callee.childForFieldName('object'), 'process') && property.text === 'cwd';
        }
        if (CONFIG_GLOBAL_NAMESPACES.has(base.text) && !bindings.has(base.text) && !declared.has(base.text)) return true;
        const binding = bindings.get(base.text);
        if (!binding || !packaged(base.text)) return false;
        return !CONFIG_ACTING_MODULES.has(moduleName(binding)) || CONFIG_READING_CALLS.has(property.text);
    };
    const sameNodeText = (node, name) => !!node && node.type === 'identifier' && node.text === name;
    /** Does evaluating an expression run nothing of this file and write nothing? */
    function inert(node) {
        if (!node) return true;
        switch (node.type) {
            case 'string': case 'number': case 'true': case 'false': case 'null': case 'undefined': case 'regex':
            case 'identifier': case 'property_identifier': case 'shorthand_property_identifier':
            case 'private_property_identifier': case 'comment': case 'meta_property': case 'this':
            case 'string_fragment': case 'escape_sequence': case 'optional_chain':
                return true;
            // A function written here is not called here.
            case 'arrow_function': case 'function_expression': case 'function': case 'generator_function':
                return true;
            case 'template_string': case 'template_substitution': case 'parenthesized_expression': case 'array':
            case 'object': case 'pair': case 'spread_element': case 'binary_expression': case 'ternary_expression':
            case 'subscript_expression': case 'member_expression': case 'computed_property_name': case 'arguments':
            case 'as_expression': case 'satisfies_expression': case 'non_null_expression': case 'type_assertion':
                return node.namedChildren.every(child => /(^|_)type(s|_arguments|_annotation)?$|^type_|_type$/.test(child.type) || inert(child));
            case 'unary_expression':
                return node.children[0].type !== 'delete' && node.namedChildren.every(inert);
            case 'new_expression': {
                const made = node.childForFieldName('constructor');
                return !!made && made.type === 'identifier' && CONFIG_CONSTRUCTORS.has(made.text) &&
                    !bindings.has(made.text) && !declared.has(made.text) && inert(node.childForFieldName('arguments'));
            }
            case 'call_expression': {
                if (requiredModule(node) != null) return true;
                return calleeProvided(node.childForFieldName('function')) && inert(node.childForFieldName('arguments'));
            }
            default:
                return false;
        }
    }

    let exported = null;
    let exports = 0;
    let commonJs = false;
    const values = []; // every value a declaration evaluates
    for (const statement of root.namedChildren) {
        switch (statement.type) {
            case 'comment': case 'hash_bang_line': case 'empty_statement':
            case 'type_alias_declaration': case 'interface_declaration':
                break;
            case 'import_statement': {
                const clause = statement.namedChildren.find(child => child.type === 'import_clause');
                const source = stringLiteralValue(statement.childForFieldName('source'));
                // An import for its effect runs code that is not read.
                if (!clause || source == null) return null;
                for (const part of clause.namedChildren) {
                    if (part.type === 'identifier') bindings.set(part.text, { module: source, imported: 'default' });
                    else if (part.type === 'namespace_import') {
                        const name = part.namedChildren.find(child => child.type === 'identifier');
                        if (name) bindings.set(name.text, { module: source, imported: null });
                    } else if (part.type === 'named_imports') {
                        for (const specifier of part.namedChildren) {
                            if (specifier.type !== 'import_specifier') continue;
                            const name = specifier.childForFieldName('name');
                            const alias = specifier.childForFieldName('alias');
                            if (name) bindings.set((alias || name).text, { module: source, imported: name.text });
                        }
                    }
                }
                break;
            }
            case 'lexical_declaration': case 'variable_declaration': {
                for (const declarator of statement.namedChildren) {
                    if (declarator.type !== 'variable_declarator') return null;
                    const target = declarator.childForFieldName('name');
                    const value = declarator.childForFieldName('value');
                    const required = requiredModule(value);
                    if (target && target.type === 'identifier') {
                        if (required != null) bindings.set(target.text, { module: required, imported: null });
                        else {
                            if (!declared.has(target.text)) declared.set(target.text, []);
                            declared.get(target.text).push(value || null);
                            if (value) values.push(value);
                        }
                    } else if (target && target.type === 'object_pattern' && required != null) {
                        for (const part of target.namedChildren) {
                            if (part.type === 'shorthand_property_identifier_pattern') {
                                bindings.set(part.text, { module: required, imported: part.text });
                            } else if (part.type === 'pair_pattern') {
                                const key = part.childForFieldName('key');
                                const local = part.childForFieldName('value');
                                if (!key || !local || local.type !== 'identifier' || key.type !== 'property_identifier') return null;
                                bindings.set(local.text, { module: required, imported: key.text });
                            } else {
                                return null;
                            }
                        }
                    } else {
                        return null;
                    }
                }
                break;
            }
            case 'expression_statement': {
                const expression = statement.namedChildren[0];
                // A directive ("use strict").
                if (expression && expression.type === 'string') break;
                if (!expression || expression.type !== 'assignment_expression') return null;
                const left = expression.childForFieldName('left');
                if (!left || left.type !== 'member_expression' || !sameNodeText(left.childForFieldName('object'), 'module') ||
                    left.childForFieldName('property')?.text !== 'exports') return null;
                exported = expression.childForFieldName('right');
                commonJs = true;
                exports++;
                break;
            }
            case 'export_statement': {
                if (!statement.children.some(child => child.type === 'default')) return null;
                exported = statement.childForFieldName('value');
                exports++;
                break;
            }
            default:
                return null;
        }
    }
    if (exports !== 1 || !exported) return null;
    if (!values.every(inert)) return null;
    // The names that reach the exported object: each is used exactly as
    // often as reading it once needs.
    const uses = new Map();
    const count = node => {
        if (CONFIG_NAME_NODES.has(node.type)) uses.set(node.text, (uses.get(node.text) || 0) + 1);
        for (const child of node.namedChildren) count(child);
    };
    count(root);
    if ((uses.get('module') || 0) !== (commonJs ? 1 : 0) || uses.has('exports') || uses.has('eval') ||
        uses.has('globalThis') || uses.has('global')) return null;
    // `require` only as the call of one written-out module name.
    let requires = 0;
    const countRequires = node => {
        if (requiredModule(node) != null) requires++;
        for (const child of node.namedChildren) countRequires(child);
    };
    countRequires(root);
    if ((uses.get('require') || 0) !== requires) return null;
    const identity = CONFIG_IDENTITY[runnerId];
    const objectOf = (node, depth = 0) => {
        if (!node || depth > 6) return null;
        if (CONFIG_WRAPPERS.has(node.type)) return objectOf(node.namedChildren[0], depth + 1);
        if (node.type === 'object') return node;
        if (node.type === 'identifier') {
            // One declaration, and this the only other place it is named.
            const held = declared.get(node.text);
            if (!held || held.length !== 1 || bindings.has(node.text) || uses.get(node.text) !== 2) return null;
            return objectOf(held[0], depth + 1);
        }
        if (node.type === 'call_expression' && identity) {
            const callee = node.childForFieldName('function');
            const args = node.childForFieldName('arguments');
            const binding = callee && callee.type === 'identifier' && !declared.has(callee.text) ? bindings.get(callee.text) : null;
            if (binding && identity.modules.has(binding.module) && identity.names.has(binding.imported) &&
                args && args.namedChildren.length === 1) return objectOf(args.namedChildren[0], depth + 1);
        }
        return null;
    };
    const fromObject = node => {
        const object = objectOf(node);
        if (!object) return null;
        const keys = new Map();
        for (const member of object.namedChildren) {
            if (member.type === 'comment') continue;
            if (member.type !== 'pair') return null;
            const key = member.childForFieldName('key');
            const value = member.childForFieldName('value');
            const written = !key ? null : key.type === 'property_identifier' ? key.text : stringLiteralValue(key);
            if (written == null || written === '__proto__' || !inert(value)) return null;
            keys.set(written, {
                strings: () => {
                    const one = stringLiteralValue(value);
                    if (one != null) return [one];
                    if (!value || value.type !== 'array') return null;
                    const all = value.namedChildren.filter(item => item.type !== 'comment').map(stringLiteralValue);
                    return all.every(item => item != null) ? all : null;
                },
                object: () => fromObject(value),
                // A list of what functions of packages return (plugins).
                packageCalls: () => !!value && value.type === 'array' &&
                    value.namedChildren.every(item => item.type === 'comment' ||
                        (item.type === 'call_expression' && requiredModule(item) == null && inert(item))),
            });
        }
        return keys;
    };
    return fromObject(exported);
}

function configKeysOf(model, dir, name, runnerId) {
    const text = model.manifests.read(dir, name);
    if (text == null) return null;
    if (/\.(json|jsonc)$/.test(name)) {
        try {
            return configKeysOfJson(JSON.parse(withoutJsonComments(text)));
        } catch (e) {
            return null;
        }
    }
    if (/\.(yaml|yml)$/.test(name)) return configKeysOfYaml(text);
    if (!/\.[cm]?[jt]s$/.test(name)) return null;
    return configKeysOfCode(text, /\.[cm]?ts$/.test(name), runnerId);
}

/**
 * What a JavaScript runner's configuration does to a command that names a
 * test file: `inert` (every key it sets is known to leave the selection
 * alone), `modeled` (`accepts(file)` says whether the configuration
 * leaves the file in; `ownPattern`: it replaces the runner's default file
 * pattern), or `unread` (a key that may select is set and not modeled, the
 * configuration is code that is not one written-out object, or one stands
 * above the runner's directory).
 */
function jsRunnerConfig(model, runner) {
    const memoKey = `${runner.id}\0${runner.dir || ''}`;
    if (model.jsConfigs.has(memoKey)) return model.jsConfigs.get(memoKey);
    const answer = (() => {
        // The project's own script points the runner somewhere else.
        if (runnerScriptWords(runner, runner.id).some(word => SCRIPT_CONFIG_FLAGS.test(word))) return { state: 'unread' };
        const names = JS_CONFIG_NAMES[runner.id];
        const packageKey = JS_CONFIG_PACKAGE_KEY[runner.id];
        const here = runner.dir || '';
        for (const dir of ancestorDirs(here ? `${here}/x` : 'x').slice(1)) {
            if (model.manifests.list(dir).some(name => names.has(name))) return { state: 'unread' };
            const above = packageKey ? model.manifests.json(dir, 'package.json') : null;
            if (above && above[packageKey] != null) return { state: 'unread' };
        }
        let files = model.manifests.list(here).filter(name => names.has(name));
        if (runner.id === 'vitest') {
            if (files.some(name => /^vitest\.(workspace|projects)\./.test(name))) return { state: 'unread' };
            // vitest's own file is the one read when both are there.
            if (files.some(name => /^vitest\.config\./.test(name))) files = files.filter(name => /^vitest\.config\./.test(name));
        }
        const sources = files.map(name => configKeysOf(model, here, name, runner.id));
        const manifest = packageKey ? model.manifests.json(here, 'package.json') : null;
        if (manifest && manifest[packageKey] != null) {
            const held = manifest[packageKey];
            sources.push(configKeysOfJson(held));
        }
        if (sources.length === 0) return { state: 'inert' };
        if (sources.some(source => source == null) || (runner.id !== 'mocha' && sources.length > 1)) return { state: 'unread' };
        let keys = new Map();
        for (const source of sources) for (const [key, reader] of source) keys.set(key, reader);
        if (runner.id === 'vitest') {
            // The runner's part of a vite configuration is its `test` key;
            // a plugin can rewrite the configuration, so each one has to
            // be what a package's function returns.
            for (const [key, reader] of keys) {
                if (key === 'test' || VITE_INERT_KEYS.has(key)) continue;
                if (key === 'plugins' && reader.packageCalls()) continue;
                return { state: 'unread' };
            }
            const test = keys.get('test');
            if (!test) return { state: 'inert' };
            keys = test.object();
            if (!keys) return { state: 'unread' };
        }
        const fold = key => runner.id === 'mocha' ? key.replace(/-/g, '').toLowerCase() : key;
        const selecting = [...keys.keys()].filter(key => !JS_INERT_KEYS[runner.id].has(fold(key)));
        if (selecting.length === 0) return { state: 'inert', keys: new Set(keys.keys()) };
        if (!selecting.every(key => JS_MODELED_KEYS[runner.id].has(key))) return { state: 'unread' };
        const absolute = file => path.posix.join(String(model.root).replace(/\\/g, '/'), here, file);
        if (runner.id === 'jest') {
            const read = key => keys.has(key) ? keys.get(key).strings() : undefined;
            const roots = read('roots');
            const regex = read('testRegex');
            const ignored = read('testPathIgnorePatterns');
            if (roots === null || regex === null || ignored === null) return { state: 'unread' };
            let patterns;
            let ignores;
            const base = absolute('').replace(/\/$/, '');
            // jest puts the root directory where a pattern says <rootDir>.
            const pattern = source => new RegExp(source.replace(/<rootDir>/g, base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            try {
                patterns = regex ? regex.map(pattern) : null;
                ignores = (ignored || ['/node_modules/']).map(pattern);
            } catch (e) {
                return { state: 'unread' };
            }
            const rootDirs = roots ? roots.map(root => path.posix.join(base, root.replace(/^<rootDir>\/?/, ''))) : null;
            if (roots && roots.some(root => path.posix.isAbsolute(root.replace(/^<rootDir>/, '')) && !root.startsWith('<rootDir>'))) {
                return { state: 'unread' };
            }
            return {
                state: 'modeled', ownPattern: !!patterns,
                accepts: file => {
                    const full = absolute(file);
                    if (rootDirs && !rootDirs.some(dir => full.startsWith(dir.replace(/\/$/, '') + '/'))) return false;
                    if (ignores.some(pattern => pattern.test(full))) return false;
                    return !patterns || patterns.some(pattern => pattern.test(full));
                },
            };
        }
        if (runner.id === 'vitest') {
            const dir = keys.get('dir').strings();
            if (!dir || dir.length !== 1 || path.posix.isAbsolute(dir[0]) || dir[0].includes('..')) return { state: 'unread' };
            const under = dir[0].replace(/^\.\//, '').replace(/\/$/, '');
            return { state: 'modeled', ownPattern: false, accepts: file => !under || file.startsWith(`${under}/`) };
        }
        return { state: 'unread' };
    })();
    model.jsConfigs.set(memoKey, answer);
    return answer;
}

const RUNNER_OF_FAMILY = {
    javascript: jsRunner,
    python: pythonRunner,
    go: goRunner,
    rust: rustRunner,
    java: javaRunner,
    dotnet: dotnetRunner,
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function withheld(reason) {
    return { selector: null, reason };
}

function command(runner, words) {
    return {
        selector: {
            command: words.join(' '),
            ...(runner.dir && { cwd: runner.dir }),
        },
    };
}

// The files jest and vitest look for when the project configures nothing.
// Neither runs a file outside its pattern, even when given the path
// (measured): for such a file the command depends on a configuration that
// is not read here.
const DEFAULT_TEST_FILES = {
    jest: [/(^|\/)__tests__\/.*\.[jt]sx?$/, /(^|\/)([^/]*\.)?(spec|test)+\.[jt]sx?$/],
    vitest: [/\.(test|spec)\.[cm]?[jt]sx?$/],
};

function lookedFor(runnerId, relativePath) {
    return DEFAULT_TEST_FILES[runnerId].some(pattern => pattern.test(relativePath));
}

function titlePattern(unit) {
    return `^${regexLiteral([...unit.suite, unit.name].join(' '))}$`;
}

const SELECTORS = {
    'pytest'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        // An option of the project's that selects, adds or leaves out
        // tests and is not modeled: no command is known to be exact.
        const options = runner.collection && runner.collection.options;
        if (options && options.unread) return withheld('runner-options-not-read');
        if (unit && unit.deselected) return withheld('deselected-by-options');
        if (!unit) return command(runner, ['pytest', shellWord(file)]);
        return command(runner, ['pytest', shellWord([file, ...unit.suite, unit.name].join('::'))]);
    },
    'node-test'(model, runner, fileEntry, unit, filePath) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        const options = runner.evidence === 'package-script' || runner.script
            ? nodeTestOptions(runner.script) : [];
        const typed = langTraits(fileEntry.language)?.typeSystem === 'structural' &&
            /\.[cm]?tsx?$/.test(fileEntry.relativePath);
        // A typed file runs only with what the project's own command loads.
        if (typed && (!options || options.length === 0)) return withheld('loader-unknown');
        const words = ['node', '--test', ...(options || []).map(shellWord)];
        if (unit) {
            // node tries a pattern on a test's own name and on its full
            // path (ancestors joined by spaces), and a matching suite runs
            // all it holds: the full path selects one test unless another
            // name in the file reads the same.
            const full = [...unit.suite, unit.name].join(' ');
            const key = [...unit.suite, unit.name].join('\0');
            const clash = model.unitsOf(filePath).units.some(other => other !== unit && other.name != null &&
                (other.name === full || [...other.suite, other.name].join(' ') === full) &&
                [...other.suite, other.name].join('\0') !== key);
            if (clash) return withheld('name-not-unique');
            words.push(`--test-name-pattern=${shellWord(`^${regexLiteral(full)}$`)}`);
        }
        words.push(shellWord(file));
        return command(runner, words);
    },
    'jest'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        // jest holds a path it is given to its configuration: the file
        // pattern, the roots, the ignored paths (measured).
        const config = jsRunnerConfig(model, runner);
        if (config.state === 'unread') return withheld('runner-config-not-read');
        if (config.state === 'modeled' && !config.accepts(file)) return withheld('outside-runner-config');
        if (!(config.state === 'modeled' && config.ownPattern) && !lookedFor('jest', file)) {
            return withheld('runner-config-not-read');
        }
        // A bare path is a pattern jest tries on every test file's path.
        const words = ['npx', 'jest', '--runTestsByPath', shellWord(file)];
        if (unit) words.push('-t', shellWord(titlePattern(unit)));
        return command(runner, words);
    },
    'vitest'(model, runner, fileEntry, unit, filePath) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        const config = jsRunnerConfig(model, runner);
        if (config.state === 'unread') return withheld('runner-config-not-read');
        if (config.state === 'modeled' && !config.accepts(file)) return withheld('outside-runner-config');
        if (!lookedFor('vitest', file)) return withheld('runner-config-not-read');
        // vitest runs every file whose path contains the one given.
        if (model.pathsContaining(runner.dir, file) > 1) return withheld('path-not-unique');
        // vitest refuses a focused test where CI is set unless told to
        // allow it (measured).
        const focus = model.declared(filePath)?.focus ? ['--allowOnly'] : [];
        const words = ['npx', 'vitest', 'run', ...focus, shellWord(file)];
        if (unit) words.push('-t', shellWord(titlePattern(unit)));
        return command(runner, words);
    },
    'mocha'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        // mocha adds the files its configuration names to the one given,
        // and applies its grep and ignore to it (measured).
        const config = jsRunnerConfig(model, runner);
        if (config.state !== 'inert') return withheld('runner-config-not-read');
        const loading = mochaLoadingOptions(runner);
        // A typed file loads only with what the project's own command or
        // configuration registers.
        const registers = loading.length > 0 || ['require', 'loader', 'import', 'node-option'].some(key => config.keys && config.keys.has(key));
        if (/\.[cm]?tsx?$/.test(file) && !registers) return withheld('loader-unknown');
        const words = ['npx', 'mocha', ...loading.map(shellWord), shellWord(file)];
        if (unit) words.push('--grep', shellWord(titlePattern(unit)));
        return command(runner, words);
    },
    'go-test'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        if (fileEntry.buildConstraint || (unit && unit.notInEveryBuild)) return withheld('build-constraint');
        const dir = posixDir(file);
        const pkg = dir ? `./${dir}` : '.';
        if (!unit) return command(runner, ['go', 'test', shellWord(pkg)]);
        return command(runner, ['go', 'test', shellWord(pkg), '-run', shellWord(`^${regexLiteral(unit.name)}$`)]);
    },
    'cargo-test'(model, runner, fileEntry, unit) {
        if (runner.customTargets) return withheld('custom-targets');
        const located = model.rustTarget(runner, fileEntry, unit ? unit.line : 1);
        if (!located.target) return withheld(located.reason);
        const words = ['cargo', 'test', ...located.target];
        if (!unit) {
            if (located.segs.length > 0) words.push('--', shellWord(`${located.segs.join('::')}::`));
            return command(runner, words);
        }
        if (unit.notInEveryBuild) return withheld('conditional-compilation');
        words.push('--', shellWord([...located.segs, unit.name].join('::')), '--exact');
        if (unit.ignored) words.push('--include-ignored');
        return command(runner, words);
    },
    'maven'(model, runner, fileEntry, unit, filePath) {
        if (!unit) {
            const classes = topLevelTestClasses(model, filePath);
            if (classes.length === 0) return withheld('no-test-class');
            return command(runner, ['mvn', 'test', shellWord(`-Dtest=${classes.join(',')}`)]);
        }
        const owner = `${unit.namespace ? unit.namespace + '.' : ''}${unit.suite.join('$')}`;
        return command(runner, ['mvn', 'test', shellWord(`-Dtest=${owner}#${unit.name}`)]);
    },
    'dotnet-test'(model, runner, fileEntry, unit, filePath) {
        // The filter's own operators are escaped; '+' (a nested type) is not one.
        const quoted = text => String(text).replace(/[()&|=!~\\]/g, '\\$&');
        if (!unit) {
            const classes = topLevelTestClasses(model, filePath);
            if (classes.length === 0) return withheld('no-test-class');
            // A fixture built once for each set of arguments runs under
            // names that carry them: no filter by the class's name holds them.
            if ((model.declared(filePath)?.classes || []).some(cls => cls.dynamic === 'generated-cases')) {
                return withheld('generated-cases');
            }
            const terms = classes.flatMap(name => [`FullyQualifiedName~${quoted(name)}.`, `FullyQualifiedName~${quoted(name)}+`]);
            return command(runner, ['dotnet', 'test', '--filter', shellWord(terms.join('|'))]);
        }
        const owner = `${unit.namespace ? unit.namespace + '.' : ''}${unit.suite.join('+')}`;
        return command(runner, ['dotnet', 'test', '--filter', shellWord(`FullyQualifiedName=${quoted(`${owner}.${unit.name}`)}`)]);
    },
};

/** Qualified names of the outermost classes of a file that hold tests. */
function topLevelTestClasses(model, filePath) {
    const names = new Set();
    for (const unit of model.unitsOf(filePath).units) {
        if (unit.kind !== 'test' || unit.suite.length === 0) continue;
        names.add(`${unit.namespace ? unit.namespace + '.' : ''}${unit.suite[0]}`);
    }
    return [...names].sort(codeUnitCompare);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * @param {object} index - ProjectIndex
 * @returns {object} per-operation test model
 */
// Positions are query facts, never persisted test-reader state. Caller
// provenance identifies the physical token even when its displayed line
// holds several calls or tests.
function testSite(site) {
    if (typeof site === 'number') return { line: site };
    const point = site.provenance?.facts?.site || {};
    return {
        line: site.line,
        ...(Number.isInteger(site.column ?? point.column) && { column: site.column ?? point.column }),
        ...(Number.isInteger(site.callStart ?? point.start) && { callStart: site.callStart ?? point.start }),
        ...(Number.isInteger(site.callEnd ?? point.end) && { callEnd: site.callEnd ?? point.end }),
    };
}

function testSiteKey(site) {
    const point = testSite(site);
    return `${point.line}:${point.column ?? ''}:${point.callStart ?? ''}`;
}

function containsTestSite(row, site) {
    const point = testSite(site);
    if (row.startLine > point.line || row.endLine < point.line) return false;
    return require('./callable-scope').containsCall(row, point) !== false;
}

function containsTestUnit(outer, inner) {
    if (outer.sourceSpan && inner.sourceSpan) {
        return outer.sourceSpan.start <= inner.sourceSpan.start && outer.sourceSpan.end >= inner.sourceSpan.end;
    }
    return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function innermostTestRows(rows, site) {
    const candidates = rows.filter(row => containsTestSite(row, site));
    return candidates.filter(row => !candidates.some(other => other !== row &&
        containsTestUnit(row, other) && !containsTestUnit(other, row)));
}

function createTestModel(index, options = {}) {
    const model = {
        manifests: createManifests(index),
        byFile: new Map(),
        rawByFile: new Map(),
        exports: new Map(),
        runners: new Map(),
        jsConfigs: new Map(),
        gates: new Map(),
        plugins: new Map(),
        guards: new Map(),
        foreign: new Map(),
        ranges: new Map(),
        readerCaches: new Map(),
        root: index.root,
        relPaths: null,
    };

    model.hasFile = relativePath => {
        if (!model.relPaths) {
            model.relPaths = new Set();
            for (const [, entry] of index.files) model.relPaths.add(entry.relativePath);
        }
        return model.relPaths.has(relativePath);
    };

    /** How many indexed files under `dir` have a path that contains `part`. */
    model.pathsContaining = (dir, part) => {
        model.hasFile('');
        let count = 0;
        for (const relativePath of model.relPaths) {
            const inside = relativeTo(dir, relativePath);
            if (inside != null && inside.includes(part)) count++;
        }
        return count;
    };

    model.runnerOf = filePath => {
        if (model.runners.has(filePath)) return model.runners.get(filePath);
        const fileEntry = index.files.get(filePath);
        const family = fileEntry && langTraits(fileEntry.language)?.testRunnerFamily;
        const find = family && RUNNER_OF_FAMILY[family];
        const runner = find ? find(model, fileEntry) : { id: null, reason: 'runner-not-modeled' };
        model.runners.set(filePath, runner);
        return runner;
    };

    /**
     * The cargo target that compiles a file and the module path of a line
     * in it, from the module tree: `--lib`, `--bin NAME` or `--test NAME`.
     */
    model.rustTarget = (runner, fileEntry, line) => {
        const { rustModulePathAt } = require('./rust-modules');
        const filePath = path.join(index.root, fileEntry.relativePath);
        const located = rustModulePathAt(index, index.files.has(filePath) ? filePath : fileEntry.path || filePath, line);
        if (!located) return { target: null, reason: 'target-unknown' };
        const rootEntry = index.files.get(located.root);
        const rootRel = rootEntry && relativeTo(runner.dir, rootEntry.relativePath);
        if (rootRel == null) return { target: null, reason: 'target-unknown' };
        const segs = located.segs;
        if (rootRel === 'src/lib.rs') return { target: ['--lib'], segs };
        if (rootRel === 'src/main.rs') {
            return runner.packageName
                ? { target: ['--bin', shellWord(runner.packageName)], segs }
                : { target: null, reason: 'target-unknown' };
        }
        let match = /^src\/bin\/([^/]+)\.rs$/.exec(rootRel) || /^src\/bin\/([^/]+)\/main\.rs$/.exec(rootRel);
        if (match) return { target: ['--bin', shellWord(match[1])], segs };
        match = /^tests\/([^/]+)\.rs$/.exec(rootRel) || /^tests\/([^/]+)\/main\.rs$/.exec(rootRel);
        if (match) return { target: ['--test', shellWord(match[1])], segs };
        return { target: null, reason: 'target-unknown' };
    };

    const helpersFor = (filePath, fileEntry, depth = 0) => {
        const symbols = fileEntry.symbols || [];
        let lines = null;
        return {
            /**
             * What a module this file imports exports under a name, when
             * the module is a file of the project whose language reads
             * exports: followed a few modules deep, never around a cycle.
             */
            exported(moduleName, name) {
                if (depth >= 4) return null;
                const relativePath = (fileEntry.moduleResolved || {})[moduleName];
                if (!relativePath) return null;
                const target = path.join(index.root, relativePath);
                const targetEntry = index.files.get(target);
                const read = targetEntry && langTraits(targetEntry.language)?.testExport;
                if (typeof read !== 'function') return null;
                const key = `${target}\0${name}`;
                if (model.exports.has(key)) return model.exports.get(key);
                model.exports.set(key, null);
                let answer;
                try {
                    answer = read(targetEntry, helpersFor(target, targetEntry, depth + 1), name);
                } catch (e) {
                    answer = null;
                }
                model.exports.set(key, answer);
                return answer;
            },
            /** Symbols whose range holds this one, outermost first. */
            enclosing(symbol) {
                const out = [];
                for (const other of symbols) {
                    if (other === symbol) continue;
                    if (other.sourceSpan && symbol.sourceSpan) {
                        if (!containsTestUnit(other, symbol) || containsTestUnit(symbol, other)) continue;
                        if (CONTAINER_KINDS.has(other.type) || CALLABLE_KINDS.has(other.type)) out.push(other);
                        continue;
                    }
                    const end = other.endLine ?? other.startLine;
                    const ownEnd = symbol.endLine ?? symbol.startLine;
                    if (other.startLine > symbol.startLine || end < ownEnd) continue;
                    if (other.startLine === symbol.startLine && end === ownEnd) {
                        // Same lines: the holder is the one named as the owner.
                        if (!(CONTAINER_KINDS.has(other.type) && (symbol.className === other.name ||
                            symbol.enclosingType === other.name))) continue;
                    }
                    if (CONTAINER_KINDS.has(other.type) || CALLABLE_KINDS.has(other.type)) out.push(other);
                }
                return out.sort((a, b) => a.startLine - b.startLine ||
                    (b.endLine ?? b.startLine) - (a.endLine ?? a.startLine));
            },
            /**
             * The annotations a type of the project carries itself, when
             * one type of that name is declared: what an annotation of
             * the project stands for. Null otherwise.
             */
            metaAnnotations(name) {
                const defs = (index.symbols.get(String(name).split('.').pop()) || [])
                    .filter(def => CONTAINER_KINDS.has(def.type));
                if (defs.length !== 1) return null;
                return (defs[0].annotationsWithArgs || []).map(annotation => String(annotation.name).split('.').pop());
            },
            /** The types of this name the project declares: the namespace (package) and file of each. */
            typesNamed: name => (index.symbols.get(String(name).replace(/[<[(].*$/, '').split('.').pop().trim()) || [])
                .filter(def => CONTAINER_KINDS.has(def.type))
                .map(def => ({ namespace: def.namespace || '', file: index.files.get(def.file)?.relativePath || null })),
            /** Does the project declare a type of this name? */
            declaresType: name => (index.symbols.get(String(name).replace(/[<[(].*$/, '').split('.').pop().trim()) || [])
                .some(def => CONTAINER_KINDS.has(def.type)),
            isContainer: symbol => CONTAINER_KINDS.has(symbol.type),
            isCallable: symbol => CALLABLE_KINDS.has(symbol.type),
            /** Names of the types a class derives from, through the project. */
            ancestors(className) {
                const seen = new Set();
                const queue = [className];
                while (queue.length > 0 && seen.size < 64) {
                    const parents = index.extendsGraph?.get(queue.shift()) || [];
                    // One entry per declaration of the name, each with
                    // the bases it writes.
                    const names = parents.flatMap(parent => typeof parent === 'string' ? [parent]
                        : Array.isArray(parent?.parents) ? parent.parents : parent?.name ? [parent.name] : []);
                    for (const written of names) {
                        const name = String(written).replace(/[<[(].*$/, '').trim();
                        if (!name || seen.has(name)) continue;
                        seen.add(name);
                        queue.push(name);
                        // A written `pkg.Base` is also known by its last name.
                        const last = name.split('.').pop();
                        if (last !== name && !seen.has(last)) { seen.add(last); queue.push(last); }
                    }
                }
                return seen;
            },
            tree() {
                try {
                    const content = index._readFile(filePath);
                    return index._getParsedTree(filePath, content, fileEntry.language) ||
                        safeParse(getParser(fileEntry.language), content) || null;
                } catch (e) {
                    return null;
                }
            },
            lines() {
                if (!lines) {
                    try {
                        lines = index._readFile(filePath).split('\n');
                    } catch (e) {
                        lines = [];
                    }
                }
                return lines;
            },
            collection: collectionFor(filePath, fileEntry),
            glob: globMatches,
            // What a reader keeps between two questions about one file.
            cache: (() => {
                if (!model.readerCaches.has(filePath)) model.readerCaches.set(filePath, new Map());
                return model.readerCaches.get(filePath);
            })(),
        };
    };

    /**
     * What the runner's configuration says about collecting a file: its
     * naming rules, its options, and whether the runner collects a module
     * of this name at all (pytest: python_files, by the file's own name).
     */
    const collectionFor = (filePath, fileEntry) => {
        const runner = model.runnerOf(filePath) || {};
        const collection = runner.collection || {};
        if (runner.id !== 'pytest') return collection;
        const base = path.posix.basename(fileEntry.relativePath);
        const patterns = collection.files && collection.files.length > 0 ? collection.files : ['test_*.py', '*_test.py'];
        return { ...collection, collected: patterns.some(glob => globMatches(glob, base)) };
    };

    /** What the language's reader finds in a file; null when not modeled. */
    model.declared = filePath => {
        if (model.rawByFile.has(filePath)) return model.rawByFile.get(filePath);
        const fileEntry = index.files.get(filePath);
        const read = fileEntry && langTraits(fileEntry.language)?.testUnits;
        let found = null;
        if (typeof read === 'function') {
            try {
                found = read(fileEntry, helpersFor(filePath, fileEntry));
            } catch (e) {
                found = null;
            }
        }
        model.rawByFile.set(filePath, found);
        return found;
    };

    /**
     * The class a base name written in `filePath` denotes: one declared in
     * the same file, else the only one of that name in files of the same
     * runner family. Null when none or several.
     */
    const baseClass = (filePath, written) => {
        const name = String(written).replace(/<.*$/, '').split('.').pop().trim();
        if (!name) return null;
        const own = (model.declared(filePath)?.classes || []).filter(cls => cls.name === name);
        if (own.length === 1) return { filePath, cls: own[0] };
        if (own.length > 1) return null;
        const family = langTraits(index.files.get(filePath)?.language)?.testRunnerFamily;
        const hits = [];
        const seenFiles = new Set();
        for (const def of index.symbols.get(name) || []) {
            if (!CONTAINER_KINDS.has(def.type) || seenFiles.has(def.file)) continue;
            if (langTraits(index.files.get(def.file)?.language)?.testRunnerFamily !== family) continue;
            seenFiles.add(def.file);
            for (const cls of model.declared(def.file)?.classes || []) {
                if (cls.name === name) hits.push({ filePath: def.file, cls });
            }
        }
        return hits.length === 1 ? hits[0] : null;
    };

    // What a written type name denotes and whether two methods are one
    // member, by the language's lookup where it is modeled.
    const signatures = createSignatures(index, {
        classes: filePath => model.declared(filePath)?.classes || [],
        parents: (filePath, cls) => parentsOf(filePath, cls),
        aliasTerm: (filePath, line) => ((model.declared(filePath)?.aliases || []).find(alias => alias.line === line) || {}).term || null,
        // Files one runner's manifest builds are compiled together.
        unitOf: filePath => {
            const runner = model.runnerOf(filePath);
            return runner && runner.id && runner.dir != null ? `${runner.id}\0${runner.dir}` : null;
        },
    });
    const parentMemo = new Map();
    const resolving = new Set();
    /**
     * The class each base written on a class denotes, in the order
     * written. A language whose name lookup is modeled says which class
     * a name is at the place it is written (a class of the project that
     * shares the spelling of a type from outside is not it); otherwise the
     * one class of that name. A base that is no class the project declares
     * once stands as an opaque entry, `safe` when the language's reader
     * knows it brings neither a test nor a constructor.
     */
    const parentsOf = (filePath, cls) => {
        const key = `${filePath}\0${cls.startLine}\0${cls.name}`;
        if (parentMemo.has(key)) return parentMemo.get(key);
        const opaque = written => ({
            opaque: true, name: String(written).replace(/[<[(].*$/, '').split('.').pop().trim(),
            safe: (cls.plainBases || []).includes(written),
        });
        // A class whose bases are being resolved inside its own
        // resolution: the language rejects the cycle.
        if (resolving.has(key)) return cls.bases.map(written => ({ written, node: opaque(written) }));
        resolving.add(key);
        const out = cls.bases.map((written, i) => {
            const looked = signatures.baseOf(filePath, cls, (cls.baseTerms || [])[i]);
            const base = looked === undefined ? baseClass(filePath, written) : looked;
            return { written, node: base || opaque(written) };
        });
        resolving.delete(key);
        parentMemo.set(key, out);
        return out;
    };

    const nodeKey = node => node.opaque ? `?${node.name}` : `${node.filePath}\0${node.cls.startLine}\0${node.cls.name}`;
    const linearMemo = new Map();

    /**
     * The order in which a class's members are looked up: the class, then
     * the classes it derives from. `c3` is Python's method resolution
     * order; otherwise depth first in the order written (a superclass
     * before the interfaces). A base that is no class of the project
     * stands in the order as an opaque entry (`parentsOf`).
     */
    const linearize = (filePath, cls, mode, trail = new Set()) => {
        const key = `${filePath}\0${cls.startLine}\0${cls.name}`;
        if (linearMemo.has(key)) return linearMemo.get(key);
        const self = { filePath, cls };
        if (trail.has(key)) return [self];
        if (cls.imported) {
            // A class bound by an import is the class it names.
            const order = [self, ...linearize(cls.imported.filePath, cls.imported.cls, mode, trail)];
            linearMemo.set(key, order);
            return order;
        }
        trail.add(key);
        const parents = parentsOf(filePath, cls).map(parent => parent.node);
        const below = parent => parent.opaque ? [parent] : linearize(parent.filePath, parent.cls, mode, trail);
        let order = [self];
        if (mode === 'c3') {
            const sequences = [...parents.map(parent => below(parent).slice()), parents.slice()];
            while (sequences.some(sequence => sequence.length > 0)) {
                const head = sequences.filter(sequence => sequence.length > 0).map(sequence => sequence[0])
                    .find(candidate => !sequences.some(other =>
                        other.slice(1).some(node => nodeKey(node) === nodeKey(candidate))));
                if (!head) {
                    // No consistent order: the language rejects the class.
                    order = [self, { opaque: true, name: '', safe: false }];
                    break;
                }
                order.push(head);
                for (const sequence of sequences) {
                    if (sequence.length > 0 && nodeKey(sequence[0]) === nodeKey(head)) sequence.shift();
                }
            }
        } else {
            const seen = new Set([key]);
            for (const parent of parents) {
                for (const node of below(parent)) {
                    if (seen.has(nodeKey(node))) continue;
                    seen.add(nodeKey(node));
                    order.push(node);
                }
            }
        }
        trail.delete(key);
        linearMemo.set(key, order);
        return order;
    };
    const orderOf = (filePath, cls) => linearize(filePath, cls, model.declared(filePath)?.linearization || null);

    /**
     * Tests a runnable class runs without declaring them: for each
     * test-shaped name, the first class in lookup order that declares a
     * member of that name. A test found behind a base that is not read is
     * not attributed (`withheld`): that base may declare the name itself.
     *
     * Which member of a nearer class is "the same member" is the
     * language's and the runner's to say (`hiddenBy` on a test): by name
     * where a name is all a member has (Python; and MSTest, which takes
     * one method of each name), by signature where a language overloads
     * (a method of the same name with other parameters is another method
     * and hides nothing), or only a declared override of that signature
     * (NUnit: a method that hides by `new` leaves the inherited test
     * running).
     *
     * Two signatures are the same when their parameters have the same
     * types, and a type is what its name denotes where it is written
     * (`signatures.relate`): the answer can be that this is not known.
     * Then the test may be the class's or may not (`uncertain`): it is
     * listed as one that runs only sometimes, under no command, with
     * every body it may run (`maybe`).
     *
     * Where the runner takes a test from the nearest declaration that
     * carries its mark (`byDeclaration`: JUnit 4, TestNG, xUnit), a class
     * nearer that overrides the method without the mark does not hide it:
     * the test runs with that class's body (`body`).
     */
    const inheritedBy = (filePath, cls, select = null) => {
        const out = [];
        // What the classes nearer than the one looked at declare, nearest
        // first: every member by name, the methods with what they are
        // compared by, and the tests.
        const names = new Set();
        const testedNames = new Set();
        const members = [];
        const tested = [];
        const declare = (node, each) => {
            for (const member of each.members || []) names.add(member);
            // A method that is a test is compared as one: its row among
            // the members is the one that shares its parameter list (two
            // methods can start on one line).
            const lists = new Set((each.tests || []).map(test => test.params).filter(Boolean));
            const lines = new Set((each.tests || []).filter(test => !test.params).map(test => test.startLine));
            for (const row of each.memberRows || []) {
                if (!(row.params ? lists.has(row.params) : lines.has(row.startLine))) members.push({ row, at: node });
            }
        };
        const sideOf = ({ row, at }) => ({ filePath: at.filePath, cls: at.cls, row });
        /**
         * A declared override overrides one method: where the classes
         * above it are all read and declare one method of that name with
         * as many parameters, it is that one, however its types are
         * written.
         */
        const onlySlot = (member, test, node) => {
            const order = orderOf(member.at.filePath, member.at.cls).slice(1);
            if (order.some(above => above.opaque)) return false;
            const arity = (member.row.params || []).length;
            const universal = langTraits(index.files.get(member.at.filePath)?.language)?.universalSupertypeMembers || {};
            if (universal[member.row.name] === arity) return false;
            const slots = order.flatMap(above => (above.cls.memberRows || [])
                .filter(row => row.name === member.row.name && (row.params || []).length === arity)
                .map(row => ({ row, at: above })));
            return slots.length > 0 && slots.every(slot =>
                (slot.at.cls === node.cls && slot.row.startLine === test.startLine) ||
                signatures.relate(sideOf(slot), { filePath: node.filePath, cls: node.cls, row: test }) === 'same');
        };
        const start = { filePath, cls };
        declare(start, cls);
        for (const test of cls.tests || []) {
            names.add(test.name);
            testedNames.add(test.name);
            tested.push({ row: test, at: start });
        }
        let behindUnknown = false;
        let withheldAny = false;
        for (const node of orderOf(filePath, cls).slice(1)) {
            if (node.opaque) {
                if (!node.safe) behindUnknown = true;
                continue;
            }
            for (const test of node.cls.tests) {
                // A test its runner runs in the declaring class only.
                if (test.ownOnly) continue;
                const rule = test.hiddenBy || 'name';
                const mine = { filePath: node.filePath, cls: node.cls, row: test };
                let body = null;
                let uncertain = false;
                const maybe = [];
                let again = false;
                if (rule === 'name') {
                    // A nearer class declares the same test.
                    if (testedNames.has(test.name)) {
                        // A runner that takes one method of each name
                        // reports the inherited test too under a test
                        // that hides it without overriding it, and runs
                        // the nearer body for it (`againUnderHiding`:
                        // measured with one version of MSTest, so the
                        // test is listed as one that runs only sometimes).
                        const nearer = tested.find(other => other.row.name === test.name);
                        if (!test.againUnderHiding || !nearer || nearer.row.overrides || nearer.again) continue;
                        body = nearer;
                        again = true;
                        tested.push({ row: test, at: node, again: true });
                    } else {
                        testedNames.add(test.name);
                        tested.push({ row: test, at: node });
                        // A nearer class declares the same member without the mark.
                        if (names.has(test.name) && !test.byDeclaration) continue;
                    }
                } else {
                    // A runner that takes a method as replaced by one whose
                    // parameters could be passed to it: another signature
                    // is no proof the test is still the class's.
                    const relate = other => {
                        const relation = signatures.relate(mine, sideOf(other));
                        return relation === 'different' && test.replacedByAssignable &&
                            (other.row.params || []).length === (test.params || []).length ? 'unknown' : relation;
                    };
                    // A method the language does not let a class override
                    // (`sealed`: always; `sealedOutside`: from another
                    // package) is not replaced by an unmarked one of its
                    // signature: the two are two methods, and the test
                    // keeps its body. (A marked one is the class's test of
                    // that signature: measured.)
                    const overrides = other => !test.sealed &&
                        (test.sealedOutside == null || (other.at.cls.namespace || '') === test.sealedOutside);
                    // A nearer class declares the same test. (Where only a
                    // declared override takes a test away, a test that
                    // hides it by another declaration runs beside it.)
                    let hidden = false;
                    for (const other of tested) {
                        if (other.row.name !== test.name || (rule === 'override' && !other.row.overrides)) continue;
                        const relation = relate(other);
                        if (relation === 'same') {
                            hidden = true;
                            break;
                        }
                        if (relation === 'unknown') uncertain = true;
                    }
                    testedNames.add(test.name);
                    tested.push({ row: test, at: node });
                    if (hidden) continue;
                    // A nearer class declares the same member without the
                    // mark: the nearest that is it for certain, and the
                    // nearer ones that may be.
                    for (const other of members) {
                        if (other.row.name !== test.name || (rule === 'override' && !other.row.overrides) || !overrides(other)) continue;
                        let relation = relate(other);
                        if (relation === 'unknown' && other.row.overrides && onlySlot(other, test, node)) relation = 'same';
                        if (relation === 'same') {
                            body = other;
                            break;
                        }
                        if (relation === 'unknown') maybe.push(other);
                    }
                    if (body && !test.byDeclaration) continue;
                    // A class declares one method of a signature: beside
                    // the one that is it, another of that class is not.
                    const open = maybe.filter(other => !body || other.at.cls !== body.at.cls);
                    maybe.length = 0;
                    maybe.push(...open);
                    if (maybe.length > 0) uncertain = true;
                }
                // A member the runner does not take as a test still hides
                // the one of that name further up.
                if (select && !select(test)) continue;
                if (behindUnknown) withheldAny = true;
                else {
                    out.push({
                        test, base: node,
                        ...((test.byDeclaration || again) && body && { body }),
                        ...(uncertain && { uncertain: true, maybe }),
                        ...(again && { again: true }),
                    });
                }
            }
            declare(node, node.cls);
            for (const test of node.cls.tests) names.add(test.name);
        }
        return { tests: out, open: behindUnknown, withheld: withheldAny };
    };

    /**
     * Is there code beside a test file that the runner lets decide which
     * tests run (the language's `testGate`): a TestMain in its Go package
     * that may not run the tests. (pytest's conftest.py files are read
     * with the modules they stand above: see guardsOf.)
     */
    const gatedAtRunTime = (filePath, runner) => {
        const relativePath = index.files.get(filePath).relativePath;
        const decides = candidate => {
            if (!model.gates.has(candidate)) {
                const entry = index.files.get(candidate);
                const gate = entry && langTraits(entry.language)?.testGate;
                let answer = false;
                if (typeof gate === 'function') {
                    try {
                        answer = !!gate(entry, helpersFor(candidate, entry));
                    } catch (e) {
                        answer = true;
                    }
                }
                model.gates.set(candidate, answer);
            }
            return model.gates.get(candidate);
        };
        if (runner.id === 'go-test') {
            if (!model.goTestFiles) {
                model.goTestFiles = new Map();
                for (const [candidate, entry] of index.files) {
                    if (!/_test\.go$/.test(entry.relativePath)) continue;
                    const dir = posixDir(entry.relativePath);
                    if (!model.goTestFiles.has(dir)) model.goTestFiles.set(dir, []);
                    model.goTestFiles.get(dir).push(candidate);
                }
            }
            return (model.goTestFiles.get(posixDir(relativePath)) || []).some(decides);
        }
        return false;
    };

    // ---- a reader that gives facts per file (`derived`): pytest ----------

    /** The project file a module name written in a file resolves to, or null. */
    const moduleFile = (filePath, moduleName) => {
        const relative = (index.files.get(filePath)?.moduleResolved || {})[moduleName];
        const target = relative ? path.join(index.root, relative) : null;
        return target && index.files.has(target) ? target : null;
    };

    /** The project file a dotted module name stands for, from the runner's directory or the project's. */
    const moduleNamed = (filePath, dotted) => {
        const runner = model.runnerOf(filePath) || {};
        const relative = String(dotted).replace(/\./g, '/');
        for (const base of new Set([runner.dir || '', ''])) {
            for (const tail of [`${relative}.py`, `${relative}/__init__.py`]) {
                const candidate = base ? `${base}/${tail}` : tail;
                if (model.hasFile(candidate)) return path.join(index.root, candidate);
            }
        }
        return null;
    };

    /**
     * Does a module declare tests where one of its functions is called
     * (a declaration inside a function that is no suite's callback), itself
     * or through the modules whose functions it calls?
     */
    const declaresWhenCalled = (filePath, seen = new Set()) => {
        if (seen.has(filePath)) return false;
        seen.add(filePath);
        const found = model.declared(filePath);
        if (!found) return false;
        if ((found.units || []).some(unit => unit.kind === 'test' &&
            (unit.indirect || unit.dynamic === 'declared-indirectly'))) return true;
        return (found.calledWhenCalled || []).some(name => {
            const target = moduleFile(filePath, name);
            return !!target && declaresWhenCalled(target, seen);
        });
    };

    /**
     * What a name of a module is, as far as tests go: a class or a function
     * of its top, or what another name of the module or another module
     * gives it (an alias, an import, a star import), a few steps deep.
     */
    const resolveName = (filePath, name, depth = 0) => {
        if (!filePath || depth > 6) return null;
        const found = model.declared(filePath);
        if (!found) return null;
        const cls = (found.classes || []).find(other => other.name === name && other.suite.length === 0);
        if (cls) return { kind: 'class', filePath, cls };
        const fn = (found.functions || []).find(other => other.name === name);
        if (fn) return { kind: 'function', filePath, fn };
        for (const entry of found.imports || []) {
            if (entry.name !== name) continue;
            const from = entry.module == null ? filePath : moduleFile(filePath, entry.module);
            if (from === filePath && entry.original === name) continue;
            const hit = resolveName(from, entry.original, depth + 1);
            if (hit) return hit;
        }
        for (const star of found.stars || []) {
            const from = moduleFile(filePath, star.module);
            const there = from ? model.declared(from) : null;
            if (!there || there.exportsAll === 'unknown') continue;
            if (there.exportsAll ? !there.exportsAll.includes(name) : name.startsWith('_')) continue;
            const hit = resolveName(from, name, depth + 1);
            if (hit) return hit;
        }
        return null;
    };

    /**
     * Switches other modules write on the classes and functions of a
     * module, each on a name it took from it. The object is one: a module
     * the runner loads after the writer sees the write, so what such a
     * class or function is depends on the order of the run. Looked for
     * among the modules that import this one.
     */
    const switchedElsewhere = filePath => {
        if (model.foreign.has(filePath)) return model.foreign.get(filePath);
        const answer = { classes: new Map(), functions: new Map() };
        model.foreign.set(filePath, answer);
        const add = (map, key, write) => {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(write);
        };
        for (const importer of [...(index.exportGraph?.get(filePath) || [])].sort(codeUnitCompare)) {
            if (importer === filePath || !index.files.has(importer)) continue;
            let text;
            try {
                text = index._readFile(importer);
            } catch (e) {
                continue;
            }
            if (!text.includes('__test__')) continue;
            const there = model.declared(importer);
            const switches = there && there.derived && there.module ? there.module.switches || {} : {};
            for (const name of Object.keys(switches).sort(codeUnitCompare)) {
                const hit = resolveName(importer, name);
                if (!hit || hit.filePath !== filePath) continue;
                const write = { on: switches[name].on, forced: switches[name].forced, by: importer };
                if (hit.kind === 'class') add(answer.classes, hit.cls, write);
                else add(answer.functions, hit.fn.name, write);
            }
        }
        return answer;
    };

    /**
     * Does one of the functions a file calls in other modules of the
     * project stop a test when called (it skips, raises, or calls a
     * function of its own module that does)? One module deep.
     */
    const callStops = (filePath, calls) => (calls || []).some(call => {
        const target = moduleFile(filePath, call.module) || moduleNamed(filePath, call.module);
        const there = target ? model.declared(target) : null;
        return !!there && (there.stopping || []).includes(call.name);
    });
    /**
     * What a name of a module is as a row of a table of parameters
     * ('run', 'skip', 'sometimes'), read in the module that binds it and,
     * where that module took it from another, in that one: a few modules
     * deep. Null: the module does not bind it.
     */
    const readRow = (file, name, member, call, depth) => {
        const there = file ? model.declared(file) : null;
        if (!there || typeof there.rowNamed !== 'function') return null;
        const state = there.rowNamed(name, member, call);
        if (!state || typeof state !== 'object') return state;
        if (depth >= 4) return 'sometimes';
        if (state.via) return viaLookup(file, state.via, depth + 1) ?? 'sometimes';
        // A name a star import brings: read in the module that binds it.
        for (const module of state.stars || []) {
            const found = viaLookup(file, { module, name, ...(member && { member }), call }, depth + 1);
            if (found != null) return found;
        }
        return null;
    };
    const viaLookup = (filePath, via, depth) => {
        const direct = moduleFile(filePath, via.module) || moduleNamed(filePath, via.module);
        const state = readRow(direct, via.name, via.member || null, !!via.call, depth);
        if (state != null) return state;
        // Not a name of that module: a module of that package.
        let inner = null;
        if (direct && path.basename(direct) === '__init__.py') {
            for (const tail of [`${via.name}.py`, path.join(via.name, '__init__.py')]) {
                const candidate = path.join(path.dirname(direct), tail);
                if (!inner && index.files.has(candidate)) inner = candidate;
            }
        } else if (!direct && !String(via.module).startsWith('.')) {
            inner = moduleNamed(filePath, `${via.module}.${via.name}`);
        }
        if (!inner || !model.declared(inner)) return null;
        // The module itself is a plain row; calling it is not read.
        if (!via.member) return via.call ? 'sometimes' : 'run';
        return readRow(inner, via.member, null, !!via.call, depth);
    };
    /** The same for a name written in `filePath`: what is not found may be anything. */
    const viaState = (filePath, via) => viaLookup(filePath, via, 0) ?? 'sometimes';
    /**
     * What tables of parameters whose rows other modules name leave of a
     * test written in `filePath`: 'skip' (one of them has no row that runs
     * the body), 'sometimes' (one may have none), or null.
     */
    const tablesState = (filePath, tables) => {
        let answer = null;
        for (const table of tables || []) {
            const states = table.via.map(via => viaState(filePath, via));
            if (states.includes('run')) continue;
            if (table.rest === 'skip' && states.every(state => state === 'skip')) return 'skip';
            answer = 'sometimes';
        }
        return answer;
    };
    /** A file's fixtures, with what the functions they call and the rows they name elsewhere add. */
    const fixturesOf = (filePath, fixtures) => (fixtures || []).map(fixture =>
        !fixture.decides && (callStops(filePath, fixture.calls) || tablesState(filePath, fixture.tables))
            ? { ...fixture, decides: true } : fixture);

    /**
     * What a file does when the runner loads it as a plugin (a conftest.py,
     * a module another names as one), with the modules it loads in turn:
     * whether a hook can change what is collected or run, whether it has
     * the hook a test module may have too, and the fixtures it brings.
     */
    const pluginFacts = (filePath, seen = new Set()) => {
        const top = seen.size === 0;
        if (top && model.plugins.has(filePath)) return model.plugins.get(filePath);
        if (seen.has(filePath)) return { decides: false, everywhere: false, generates: false, fixtures: [] };
        seen.add(filePath);
        const found = model.declared(filePath);
        const runtime = found && found.runtime;
        // A plugin that is not read may do anything.
        const answer = {
            decides: !runtime || runtime.decides,
            // A hook pytest calls once for the whole run decides for
            // every test of it, wherever the file stands.
            everywhere: !runtime || !!runtime.everywhere,
            generates: !runtime || !!runtime.generates,
            fixtures: runtime ? fixturesOf(filePath, runtime.fixtures) : [],
        };
        // A hook that calls a function of another module of the project
        // that can stop a test decides as if it stopped it itself.
        for (const call of (runtime && runtime.hookCalls) || []) {
            if (!callStops(filePath, [call])) continue;
            answer.decides = true;
            if (call.everywhere) answer.everywhere = true;
            if (call.generates) answer.generates = true;
        }
        for (const plugin of runtime ? runtime.plugins : []) {
            const target = plugin.by === 'import' ? moduleFile(filePath, plugin.module) : moduleNamed(filePath, plugin.module);
            // A module outside the project is a plugin like any installed one.
            if (!target) continue;
            const inner = pluginFacts(target, seen);
            answer.decides = answer.decides || inner.decides;
            answer.generates = answer.generates || inner.generates;
            // A module named as a plugin is one for the whole run.
            if (inner.everywhere || (plugin.by === 'name' && inner.decides)) answer.everywhere = true;
            answer.fixtures.push(...inner.fixtures);
        }
        // Fixtures taken by name from other modules of the project.
        for (const entry of (found && found.imports) || []) {
            const target = entry.module == null ? null : moduleFile(filePath, entry.module);
            const there = target ? model.declared(target) : null;
            const fixture = there && there.runtime
                ? fixturesOf(target, there.runtime.fixtures).find(other => other.function === entry.original) : null;
            if (fixture) answer.fixtures.push(fixture.name === fixture.function ? { ...fixture, name: entry.name } : fixture);
        }
        if (top) model.plugins.set(filePath, answer);
        return answer;
    };

    /**
     * The fixture names that can stop a test: those that decide, and those
     * that ask for one that does. With `is`: the names that reach a
     * fixture of that kind instead.
     */
    const stoppingNames = (fixtures, is = fixture => fixture.decides) => {
        const names = new Set();
        for (const fixture of fixtures) if (is(fixture) && fixture.name != null) names.add(fixture.name);
        let grew = true;
        while (grew) {
            grew = false;
            for (const fixture of fixtures) {
                if (fixture.name == null || names.has(fixture.name) || !fixture.requests.some(name => names.has(name))) continue;
                names.add(fixture.name);
                grew = true;
            }
        }
        return names;
    };

    /** Does a fixture every test gets have a table of parameters, its own or one it asks for? */
    const everyTabled = (fixtures, tabled) => fixtures.some(fixture => (fixture.autouse || fixture.name == null) &&
        (!!fixture.params || fixture.requests.some(name => tabled.has(name))));

    /**
     * What the code beside a test module can do to its tests before their
     * bodies run: the conftest.py files above it, the plugins those and the
     * module name, the module's own fixtures. `gated`: every test of the
     * module runs only sometimes (a hook can change what is collected or
     * run, a fixture every test gets can stop it). `fixtures`: the ones a
     * test of the module can ask for.
     */
    const guardsOf = filePath => {
        if (model.guards.has(filePath)) return model.guards.get(filePath);
        const relativePath = index.files.get(filePath).relativePath;
        const fixtures = [];
        let gated = false;
        let generates = false;
        // The conftest.py files a run of this file alone loads whose hooks
        // decide for the whole run.
        const wholeRun = [];
        for (const dir of ancestorDirs(relativePath)) {
            const conftest = path.join(index.root, dir, 'conftest.py');
            if (conftest === filePath || !index.files.has(conftest)) continue;
            const facts = pluginFacts(conftest);
            if (facts.decides) gated = true;
            if (facts.generates) generates = true;
            if (facts.everywhere) wholeRun.push(index.files.get(conftest).relativePath);
            fixtures.push(...facts.fixtures);
        }
        // The module itself is no plugin: of its own hooks pytest calls
        // the one that generates tests; the modules it names are plugins.
        const own = pluginFacts(filePath);
        const runtime = model.declared(filePath)?.runtime;
        if (own.generates || (own.everywhere && !(runtime && runtime.everywhere))) gated = true;
        if (own.generates) generates = true;
        fixtures.push(...own.fixtures);
        // A conftest.py anywhere under the runner's directory whose hook
        // is called for the whole run: it is loaded with any run that
        // collects a file below it, and decides for every test of that run.
        const runner = model.runnerOf(filePath) || {};
        if (!gated) {
            if (!model.conftests) {
                model.hasFile('');
                model.conftests = [...model.relPaths].filter(other => path.posix.basename(other) === 'conftest.py')
                    .sort(codeUnitCompare);
            }
            for (const other of model.conftests) {
                if (relativeTo(runner.dir, other) == null) continue;
                const conftest = path.join(index.root, other);
                if (conftest !== filePath && pluginFacts(conftest).everywhere) {
                    gated = true;
                    break;
                }
            }
        }
        const stopping = stoppingNames(fixtures);
        if (fixtures.some(fixture => (fixture.autouse || fixture.name == null) &&
            (fixture.decides || fixture.requests.some(name => stopping.has(name))))) gated = true;
        const tabled = stoppingNames(fixtures, fixture => fixture.params);
        const answer = {
            gated, fixtures, stopping, tabled,
            // A fixture every test gets that has a table of parameters, or
            // asks for one that has: every test runs once for each row.
            everyTabled: everyTabled(fixtures, tabled),
            // A hook that makes tests from a test (pytest_generate_tests).
            generates,
            wholeRun: wholeRun.sort(codeUnitCompare),
        };
        model.guards.set(filePath, answer);
        return answer;
    };

    /**
     * The units of a file whose reader gives facts (pytest): the module's
     * own tests, the tests of every class the runner collects (its own and
     * the ones it inherits, in the language's lookup order), and the tests
     * the module holds under names it took from elsewhere or bound again.
     *
     * Whether a class is collected is settled over its lookup order: the
     * nearest `__test__` (false: no; not a literal: sometimes; the literal
     * True: yes whatever the class is called), a constructor anywhere in
     * it (pytest's classes only), abstract members nothing nearer
     * implements, a name the runner takes or a TestCase of unittest among
     * its bases, and the classes around it. Marks, setups and fixtures of
     * every class in that order reach its tests, as do the module's.
     */
    const derivedFacts = (filePath, found) => {
        // A module switched off holds no test.
        if (found.off) return { modeled: true, units: [], tests: 0, inheriting: false };
        const relativePath = index.files.get(filePath).relativePath;
        const relativeOf = other => index.files.get(other).relativePath;
        const runner = model.runnerOf(filePath) || {};
        const naming = runner.collection || {};
        const named = (patterns, fallback, name) => (patterns && patterns.length > 0 ? patterns : fallback)
            .some(pattern => /[*?[]/.test(pattern) ? globMatches(pattern, name) : name.startsWith(pattern));
        const declaredModule = found.module || {};
        // What the module does when it is imported and before its tests,
        // with what the functions it calls in other modules add.
        const moduleTable = tablesState(filePath, declaredModule.tables);
        const mod = {
            ...declaredModule,
            ...(!declaredModule.skip && callStops(filePath, declaredModule.skipCalls) && { skip: 'sometimes' }),
            ...(moduleTable && declaredModule.skip !== 'skip' && { skip: moduleTable }),
            ...(!declaredModule.guard && callStops(filePath, declaredModule.guardCalls) && { guard: true }),
        };
        const guards = guardsOf(filePath);
        let more = !!found.inheriting;

        // Names the module takes from other modules, and other names for
        // what it holds: a test class or function among them runs here too.
        const entries = [...(found.imports || [])];
        const own = new Set([...(found.functions || []).map(fn => fn.name),
            ...(found.classes || []).filter(cls => cls.suite.length === 0).map(cls => cls.name),
            ...entries.map(entry => entry.name)]);
        for (const star of naming.importedTests === false ? [] : found.stars || []) {
            const from = moduleFile(filePath, star.module);
            const there = from ? model.declared(from) : null;
            // What a module that is not read brings is not seen.
            if (!there || there.exportsAll === 'unknown') {
                more = true;
                continue;
            }
            if ((there.stars || []).length > 0) more = true;
            const names = there.exportsAll || [
                ...(there.functions || []).map(fn => fn.name),
                ...(there.classes || []).filter(cls => cls.suite.length === 0).map(cls => cls.name),
                ...(there.imports || []).map(entry => entry.name),
            ].filter(name => !name.startsWith('_'));
            for (const name of new Set(names)) {
                if (!own.has(name)) entries.push({ name, original: name, module: star.module, line: star.line });
            }
        }
        const classesHere = [...(found.classes || [])];
        const taken = [];
        const bound = new Set();
        // A switch this module writes on a class it took from another
        // module: the class is that object, so the switch holds for every
        // class here that derives from it.
        const switchedHere = new Map();
        // Classes taken from other modules whose constructor is written here.
        const constructorsOpen = new Set();
        for (const entry of entries) {
            if (bound.has(entry.name)) continue;
            const from = entry.module == null ? filePath : moduleFile(filePath, entry.module);
            if (!from || (from === filePath && entry.original === entry.name)) continue;
            const hit = resolveName(from, entry.original);
            if (!hit) continue;
            // collect_imported_tests = false: only what the module
            // defines itself is collected in it.
            if (naming.importedTests === false && hit.filePath !== filePath) continue;
            bound.add(entry.name);
            // A switch written here on the name.
            const written = (mod.switches || {})[entry.name];
            if (hit.kind === 'class' && written) switchedHere.set(hit.cls, written);
            if (hit.kind === 'class' && (mod.constructorWrites || []).includes(entry.name)) constructorsOpen.add(hit.cls);
            if (hit.kind === 'class') {
                classesHere.push({
                    name: entry.name, suite: [], bases: [], imported: { filePath: hit.filePath, cls: hit.cls },
                    named: named(naming.classes, ['Test'], entry.name),
                    ...(written && { enabled: written.on }),
                    ...(written && written.forced && { forced: written.forced }),
                    line: entry.line, startLine: entry.line, endLine: entry.line,
                    members: [], tests: [], marks: [], marksOpen: false,
                });
            } else {
                taken.push({ entry, fn: hit.fn, target: hit.filePath, written });
            }
        }

        // The classes around a class, outermost first.
        const outerOf = cls => cls.imported ? [] : classesHere.filter(outer => !outer.imported && outer !== cls &&
            outer.startLine <= cls.startLine && outer.endLine >= cls.endLine).sort((a, b) => a.startLine - b.startLine);
        const NO = Object.freeze({ collected: 'no' });
        const standings = new Map();
        const standingOf = cls => {
            if (standings.has(cls)) return standings.get(cls);
            standings.set(cls, NO);
            const answer = (() => {
                const order = orderOf(filePath, cls);
                const nodes = order.filter(node => !node.opaque);
                const real = nodes.map(node => node.cls);
                const unread = order.some(node => node.opaque && !node.safe);
                const unittest = real.some(each => each.unittestBase);
                let collected = 'yes';
                let why = null;
                const weaken = reason => {
                    if (collected === 'yes') {
                        collected = 'maybe';
                        why = reason;
                    }
                };
                // The nearest switch: one written here on a class taken
                // from another module comes before that class's own. One
                // another module writes on it holds where that module was
                // loaded first: which, is the order of the run.
                const switchOf = node => {
                    const each = node.cls;
                    if (switchedHere.has(each)) return { enabled: switchedHere.get(each).on, forced: switchedHere.get(each).forced };
                    const others = (switchedElsewhere(node.filePath).classes.get(each) || []).filter(write => write.by !== filePath);
                    if (others.length > 0) {
                        // Whether it is on is not settled; it is taken
                        // whatever it is called only where a write says so.
                        return { enabled: 'unknown', forced: others.some(write => write.forced) ? 'unknown' : each.forced };
                    }
                    return each.enabled !== undefined ? { enabled: each.enabled, forced: each.forced } : null;
                };
                const switched = nodes.map(switchOf).find(Boolean) || null;
                if (switched && switched.enabled === false) return NO;
                if (!unittest) {
                    // The runner refuses a class whose constructor is not
                    // the language's own. Which one a class has is what its
                    // lookup order binds first: a class that writes the
                    // builtin's back has it again, whatever stands behind.
                    let custom = false;
                    for (const name of found.constructors || []) {
                        for (const node of order) {
                            if (node.opaque) {
                                if (node.safe) continue;
                                // A base that is not read may bind one.
                                weaken('base-not-resolved');
                                break;
                            }
                            const kind = constructorsOpen.has(node.cls) ? 'unknown' : (node.cls.constructs || {})[name];
                            if (!kind) continue;
                            if (kind === 'custom') custom = true;
                            else if (kind === 'unknown') weaken('constructor-not-read');
                            break;
                        }
                    }
                    if (custom) return NO;
                }
                // Abstract members that nothing nearer implements: abc
                // makes the class abstract and pytest leaves it out.
                const implemented = new Set();
                let abstractLeft = false;
                for (const each of real) {
                    const abstract = each.abstract || [];
                    if (abstract.some(name => !implemented.has(name))) abstractLeft = true;
                    for (const member of each.members || []) if (!abstract.includes(member)) implemented.add(member);
                }
                if (abstractLeft) {
                    if (real.some(each => each.abc === true)) return NO;
                    if (real.some(each => each.abc === 'unknown') || unread) weaken('base-not-resolved');
                }
                if (!unittest && !cls.named) {
                    // Not the runner's by its name, nor one of unittest's
                    // (a base from outside the project is taken to be a
                    // TestCase where it is named like one, and not otherwise).
                    const forced = switched ? switched.forced : undefined;
                    if (forced === 'unknown') weaken('collection-switch');
                    else if (forced !== true) return NO;
                }
                if (switched && switched.enabled === 'unknown') weaken('collection-switch');
                if (real.some(each => each.unsettled)) weaken('defined-conditionally');
                for (const outer of outerOf(cls)) {
                    const around = standingOf(outer);
                    // pytest collects a class inside a class it collects;
                    // a class of unittest holds methods only.
                    if (around.collected === 'no' || around.regime === 'unittest') return NO;
                    if (around.collected === 'maybe') weaken(around.why);
                }
                // Each class's fixtures and setups, read in its own file.
                const fixtures = nodes.flatMap(node => fixturesOf(node.filePath, node.cls.fixtures));
                // Tables of parameters on the classes, their rows read where each is written.
                const tables = nodes.map(node => tablesState(node.filePath, node.cls.tables));
                return {
                    collected, why, regime: unittest ? 'unittest' : 'pytest',
                    // What reaches a class through its lookup order.
                    skip: real.some(each => each.skip === 'skip') || tables.includes('skip') ? 'skip'
                        : real.some(each => each.skip === 'sometimes') || tables.includes('sometimes') ? 'sometimes' : null,
                    guard: nodes.some(node => node.cls.guard || callStops(node.filePath, node.cls.guardCalls)),
                    // A class's own hook that makes tests from a test.
                    generates: real.some(each => each.generates),
                    fixtures,
                    usefixtures: real.flatMap(each => each.usefixtures || []),
                    usefixturesOpen: real.some(each => each.usefixturesOpen),
                    open: unread,
                };
            })();
            standings.set(cls, answer);
            return answer;
        };

        const classesOf = new Map(); // unit -> the classes around it, for the runner's mark expression
        let units = [];
        /** A unit with what reaches it: its own state, its classes', the module's, the code beside it. */
        const finish = (base, row, around, alsoOpen = null, rowFile = filePath) => {
            const states = around.map(standingOf);
            const dynamic = row.dynamic || alsoOpen || states.map(each => each.collected === 'maybe' ? each.why : null).find(Boolean) ||
                (mod.unsettled ? 'collection-switch' : null);
            const classFixtures = states.flatMap(each => each.fixtures);
            const scoped = classFixtures.length > 0 ? [...guards.fixtures, ...classFixtures] : guards.fixtures;
            const stopping = classFixtures.length > 0 ? stoppingNames(scoped) : guards.stopping;
            const requests = [...(row.requests || []), ...(mod.usefixtures || []), ...(naming.usefixtures || []),
                ...states.flatMap(each => each.usefixtures)];
            // The rows of the test's own table that other modules name,
            // read from the file the test is written in.
            const rowTable = tablesState(rowFile, row.tables);
            // One declaration the runner reports as several tests: a
            // table of parameters, its own, its classes', its module's, a
            // fixture's (one it asks for, or one every test gets), or a
            // hook that makes tests from it.
            const tabled = classFixtures.length > 0 ? stoppingNames(scoped, fixture => fixture.params) : guards.tabled;
            const byFixture = requests.some(name => tabled.has(name)) ||
                (classFixtures.length > 0 ? everyTabled(scoped, tabled) : guards.everyTabled);
            const several = (row.marks || []).includes('parametrize') || (found.marks || []).includes('parametrize') ||
                around.some(cls => orderOf(filePath, cls).some(node => !node.opaque && (node.cls.marks || []).includes('parametrize'))) ||
                byFixture || guards.generates || states.some(each => each.generates);
            const skipped = !!row.skipped || rowTable === 'skip' || mod.skip === 'skip' || states.some(each => each.skip === 'skip');
            const sometimes = !!row.conditional || !!dynamic || rowTable === 'sometimes' || mod.skip === 'sometimes' ||
                !!mod.guard || guards.gated ||
                states.some(each => each.skip === 'sometimes' || each.guard || each.usefixturesOpen || each.generates) ||
                !!row.requestsOpen || !!mod.usefixturesOpen || requests.some(name => stopping.has(name)) ||
                // A test of unittest takes no parameters: under a
                // fixture's table the runner reports an error for it.
                (byFixture && states.some(each => each.regime === 'unittest'));
            const unit = {
                ...base,
                ...(!base.inherited && rowFile === filePath && row.sourceSpan && { sourceSpan: row.sourceSpan }),
                ...(skipped && { skipped: true }),
                ...(sometimes && { conditional: true }),
                ...(dynamic && { dynamic }),
                ...(several && { several: true }),
                ...(row.marks && { marks: row.marks, marksOpen: !!row.marksOpen }),
            };
            classesOf.set(unit, around);
            units.push(unit);
        };
        // A function the runner takes only by a switch that is not settled.
        const byForce = row => !row.named && row.forced === 'unknown' ? 'collection-switch' : null;

        // Functions of this module whose switch another module writes.
        const switchedBy = switchedElsewhere(filePath).functions;
        for (const row of found.units) {
            if (row.kind !== 'test') continue;
            finish({ kind: 'test', name: row.name, suite: [], line: row.line, startLine: row.startLine, endLine: row.endLine },
                row, [], byForce(row) || (switchedBy.has(row.name) ? 'collection-switch' : null));
        }
        // One the module leaves switched off, or under a name the runner
        // does not take, that another module switches on.
        for (const fn of switchedBy.size > 0 ? found.functions || [] : []) {
            if (found.units.some(row => row.kind === 'test' && row.name === fn.name && row.line === fn.line)) continue;
            if (!switchedBy.get(fn.name)?.some(write => write.on !== false && (fn.named || write.forced))) continue;
            finish({ kind: 'test', name: fn.name, suite: [], line: fn.line, startLine: fn.startLine, endLine: fn.endLine },
                fn, [], 'collection-switch');
        }
        for (const cls of classesHere) {
            const standing = standingOf(cls);
            if (standing.collected === 'no') continue;
            // unittest takes the methods its loader names; pytest the
            // names its patterns take and the ones switched on.
            // A member its class switches off is none, unless a switch
            // this module writes in a way that is not read may have
            // turned it on again.
            const live = row => !row.off || !!found.switchesOpen;
            const select = standing.regime === 'unittest' ? row => live(row) && row.prefixed
                : row => live(row) && (row.named || !!row.forced);
            const reopened = row => row.off ? 'collection-switch' : null;
            const inherited = cls.bases.length > 0 || cls.imported
                ? inheritedBy(filePath, cls, select) : { tests: [], open: false, withheld: false };
            const rows = (cls.tests || []).filter(select);
            // unittest runs runTest when a class has no other test.
            if (standing.regime === 'unittest' && rows.length === 0 && inherited.tests.length === 0) {
                const fallback = (cls.tests || []).find(row => row.name === 'runTest');
                if (fallback) rows.push(fallback);
                // The nearest one in the lookup order, where the class has none.
                else if (cls.bases.length > 0 || cls.imported) {
                    const above = inheritedBy(filePath, cls, row => row.name === 'runTest');
                    inherited.tests.push(...above.tests);
                    if (above.withheld) inherited.withheld = true;
                }
            }
            // A base that is not read may bring tests of its own.
            if (inherited.withheld || standing.open) more = true;
            const around = [...outerOf(cls), cls];
            const suite = [...cls.suite, cls.name];
            const before = units.length;
            for (const row of rows) {
                const open = reopened(row) || (standing.regime === 'unittest' ? null : byForce(row));
                if (row.alias) {
                    // Another name for a test of the class: its body stands where that test is.
                    finish({
                        kind: 'test', name: row.name, suite, line: row.line, startLine: row.line, endLine: row.line,
                        inherited: {
                            file: relativePath, filePath, owner: cls.name, ownerLine: cls.startLine,
                            line: row.of, startLine: row.startLine, endLine: row.endLine,
                        },
                    }, row, around, open);
                } else {
                    finish({ kind: 'test', name: row.name, suite, line: row.line, startLine: row.startLine, endLine: row.endLine },
                        row, around, open);
                }
            }
            for (const { test, base } of inherited.tests) {
                finish({
                    kind: 'test', name: test.name, suite, line: cls.line, startLine: cls.line, endLine: cls.line,
                    inherited: {
                        file: relativeOf(base.filePath), filePath: base.filePath, owner: base.cls.name,
                        ownerLine: base.cls.startLine, line: test.alias ? test.of : test.line,
                        startLine: test.startLine, endLine: test.endLine, sourceSpan: test.sourceSpan,
                    },
                }, test, around, reopened(test) || (standing.regime === 'unittest' ? null : byForce(test)), base.filePath);
            }
            if (units.length > before) {
                units.push({
                    kind: 'suite', name: cls.name, suite: cls.suite,
                    line: cls.line, startLine: cls.startLine, endLine: cls.endLine, sourceSpan: cls.sourceSpan,
                });
            }
        }
        for (const { entry, fn, target, written } of taken) {
            // The switch is the function's own, whoever holds it: a write
            // made here comes after the ones of the module it is taken from.
            // Without one, a third module's write holds where that module
            // was loaded first.
            const others = written ? [] : (switchedElsewhere(target).functions.get(fn.name) || [])
                .filter(write => write.by !== filePath);
            // And where a switch this module writes is not read, one its
            // own module switched off may be on again, under any name.
            const reopened = !written && !!fn.off && !!found.switchesOpen;
            const on = written ? written.on : others.length > 0 || reopened ? 'unknown' : fn.off ? false : true;
            const row = {
                ...fn, named: named(naming.functions, ['test'], entry.name),
                forced: written ? written.forced : others.some(write => write.forced) || reopened ? 'unknown' : fn.forced,
            };
            if ((!row.named && !row.forced) || on === false) continue;
            finish({
                kind: 'test', name: entry.name, suite: [], line: entry.line, startLine: entry.line, endLine: entry.line,
                inherited: {
                    file: relativeOf(target), filePath: target, owner: null, ownerLine: 0,
                    line: fn.line, startLine: fn.startLine, endLine: fn.endLine, sourceSpan: fn.sourceSpan,
                },
            }, row, [], (on === 'unknown' ? 'collection-switch' : null) || byForce(row), target);
        }

        // The runner's configured options: a mark expression and tests
        // left out by name apply to a test however it is named on the
        // command line (measured).
        const options = naming.options;
        if (options && (options.markExpr || options.deselect.length > 0)) {
            const file = relativeTo(runner.dir, relativePath);
            units = units.map(unit => {
                if (unit.kind !== 'test' || unit.skipped) return unit;
                const id = [file, ...unit.suite, unit.name].join('::');
                let selected = !(file != null && options.deselect.some(prefix => id.startsWith(prefix)));
                if (selected && options.markExpr) {
                    const marks = new Set([...(unit.marks || []), ...(found.marks || [])]);
                    let open = !!unit.marksOpen || !!found.marksOpen;
                    // Marks of the classes around the test, and of every
                    // class those derive from.
                    for (const cls of classesOf.get(unit) || []) {
                        for (const node of orderOf(filePath, cls)) {
                            if (node.opaque) {
                                if (!node.safe) open = true;
                                continue;
                            }
                            for (const mark of node.cls.marks || []) marks.add(mark);
                            if (node.cls.marksOpen) open = true;
                        }
                    }
                    selected = markSelects(options.markExpr, marks, open);
                }
                if (selected === false) return { ...unit, skipped: true, deselected: true };
                return selected == null ? { ...unit, conditional: true } : unit;
            });
        }
        units.sort((a, b) => a.startLine - b.startLine || (b.endLine - a.endLine) ||
            codeUnitCompare(a.name || '', b.name || ''));
        return {
            modeled: true,
            units,
            // A test that is declared and not executed is not counted.
            tests: units.filter(unit => unit.kind === 'test' && !unit.skipped).length,
            inheriting: more,
        };
    };

    /**
     * A file's units: the tests and suites it declares, by line, and the
     * tests its runnable classes inherit (placed at the class). `modeled`
     * is false when the language's units are not read.
     */
    model.unitsOf = filePath => {
        if (model.byFile.has(filePath)) return model.byFile.get(filePath);
        const found = model.declared(filePath);
        let facts;
        if (!found) {
            facts = { modeled: false, units: [], tests: 0, inheriting: false };
        } else if (found.notCollected) {
            // A module its runner does not collect declares no test.
            facts = { modeled: true, units: [], tests: 0, inheriting: false };
        } else if (found.derived) {
            facts = derivedFacts(filePath, found);
        } else {
            const relativePath = index.files.get(filePath).relativePath;
            const runner = model.runnerOf(filePath) || {};
            const classesHere = [...(found.classes || [])];
            const within = (unit, cls) => containsTestUnit(cls, unit);
            // A setup that can stop a test, in a class the test's class
            // derives from: the test runs only sometimes.
            const guardedAbove = cls => cls.bases.length > 0 &&
                orderOf(filePath, cls).slice(1).some(node => !node.opaque && node.cls.guard);
            const guarded = classesHere.filter(cls => cls.runnable && guardedAbove(cls));
            // A class its runner refuses (one of its marked methods is one
            // the runner does not accept), or a class deriving from one:
            // none of its tests runs, its own or inherited.
            const refusalMemo = new Map();
            const refusalOf = cls => {
                if (!refusalMemo.has(cls)) {
                    const order = orderOf(filePath, cls);
                    const refused = order.some(node => !node.opaque && (node.cls.refused || node.cls.mayRefuse));
                    // @RunWith is inherited, including through an
                    // intermediate class that declares no tests. A runner
                    // anywhere in the ancestry, or an unread base that may
                    // name one, prevents a definite standard-runner refusal.
                    const custom = order.some(node => node.opaque ? !node.safe : node.cls.runner || node.cls.mayRefuse);
                    refusalMemo.set(cls, refused ? (custom ? 'conditional' : 'refused') : null);
                }
                return refusalMemo.get(cls);
            };
            const refusedHere = cls => refusalOf(cls) === 'refused';
            const maybeRefused = cls => refusalOf(cls) === 'conditional';
            const runsIn = unit => classesHere.filter(cls => within(unit, cls)).sort((a, b) => b.startLine - a.startLine)[0];
            // A focus leaves other tests of the file declared and not
            // executed, by the rule of the runner that runs the file.
            const left = found.focus ? focusedOut(found.units, model.runnerOf(filePath).id) : new Set();
            let units = found.units.map(unit => {
                let out = unit;
                if (unit.kind === 'test' && !unit.conditional && guarded.some(cls => within(unit, cls))) {
                    out = { ...out, conditional: true };
                }
                if (left.has(unit)) out = { ...out, skipped: true };
                if (unit.kind === 'test' && !out.skipped) {
                    const holder = runsIn(unit);
                    if (holder && refusedHere(holder)) out = { ...out, skipped: true };
                    else if (holder && maybeRefused(holder) && !out.conditional) out = { ...out, conditional: true };
                }
                return out;
            });
            // jest refuses a file that gives a table of cases no row
            // (measured): none of its tests runs.
            if (found.emptyTable && runner.id === 'jest') {
                units = units.map(unit => unit.kind === 'test' && !unit.skipped ? { ...unit, conditional: true } : unit);
            }
            // `open`: the file calls through a name that may be its
            // runner's declaring function, or hands that function on.
            let inheriting = !!found.inheriting || !!found.open;
            // A function of another module that declares tests when it is
            // called: the tests are this file's, and are not listed here.
            if ((found.calledModules || []).some(name => {
                const target = moduleFile(filePath, name);
                return !!target && target !== filePath && declaresWhenCalled(target);
            })) inheriting = true;
            // node runs a file that declares no test as one test.
            if (found.units.length === 0 && runner.id === 'node-test' &&
                nodeRunsFile(runner, relativeTo(runner.dir, relativePath))) inheriting = true;
            for (const cls of classesHere) {
                if (!cls.runnable || cls.bases.length === 0) continue;
                const inherited = inheritedBy(filePath, cls);
                const own = units.some(unit => unit.kind === 'test' && within(unit, cls));
                // A base that is not read may bring tests of its own.
                if (inherited.withheld || inherited.open) inheriting = true;
                if (inherited.tests.some(({ test }) => !test.needsClassMark || cls.marked) && !own) {
                    units.push({
                        kind: 'suite', name: cls.name, suite: cls.suite,
                        line: cls.line, startLine: cls.startLine, endLine: cls.endLine, sourceSpan: cls.sourceSpan,
                    });
                }
                for (const { test, base, body, uncertain, maybe, again } of inherited.tests) {
                    // A runner that wants the class that runs a test
                    // marked takes none through one that is not.
                    if (test.needsClassMark && !cls.marked) continue;
                    // No command names a test whose runner cannot be told
                    // which one it is under the class that inherits it, or
                    // one that a method of the class may have replaced
                    // (their parameter types are not resolved).
                    const unnamed = test.dynamic || cls.dynamic || test.inheritedDynamic ||
                        (uncertain && 'signature-not-resolved') || (again && 'reported-again');
                    const state = {
                        ...((test.skipped || cls.skipped || refusedHere(cls)) && { skipped: true }),
                        ...((cls.sometimes || test.conditional || cls.guard || guardedAbove(cls) || uncertain || again || maybeRefused(cls)) && { conditional: true }),
                        ...(unnamed && { dynamic: unnamed }),
                        ...((test.several || cls.several) && { several: true }),
                        // The bodies of the methods that may be the test's
                        // instead, where the runner gives a test the body
                        // of the method that replaces it: a change to one
                        // of them may reach it.
                        ...(uncertain && test.byDeclaration && maybe.length > 0 && {
                            alternatives: maybe.map(other => ({
                                file: index.files.get(other.at.filePath).relativePath,
                                filePath: other.at.filePath, ownerLine: other.at.cls.startLine,
                                startLine: other.row.startLine, endLine: other.row.endLine, sourceSpan: other.row.sourceSpan,
                            })),
                        }),
                    };
                    const suite = [...cls.suite, cls.name];
                    // The class redeclares the member without the mark:
                    // the test is the inherited one, its body the class's own.
                    if (body && body.at.cls === cls && !uncertain && !again) {
                        units.push({
                            kind: 'test', name: test.name, suite, ...(cls.namespace && { namespace: cls.namespace }),
                            line: body.row.line, startLine: body.row.startLine, endLine: body.row.endLine, sourceSpan: body.row.sourceSpan, ...state,
                        });
                        continue;
                    }
                    // Where the body stands: the declaration that makes the
                    // test, or the nearest class that redeclares the member.
                    const at = body ? body.at : base;
                    const where = body ? body.row : test;
                    units.push({
                        kind: 'test', name: test.name, suite, ...(cls.namespace && { namespace: cls.namespace }),
                        line: cls.line, startLine: cls.line, endLine: cls.line, ...state,
                        inherited: {
                            file: index.files.get(at.filePath).relativePath,
                            filePath: at.filePath, owner: at.cls.name,
                            ownerLine: at.cls.startLine, line: where.line,
                            startLine: where.startLine, endLine: where.endLine, sourceSpan: where.sourceSpan,
                        },
                    });
                }
                // A mark on a class that makes its methods tests holds for
                // the classes deriving from it (`classMark`): the methods
                // this class declares that such a mark takes (`candidate`).
                if (!cls.classMark && orderOf(filePath, cls).slice(1).some(node => !node.opaque && node.cls.classMark)) {
                    let added = false;
                    for (const row of cls.memberRows || []) {
                        if (!row.candidate || units.some(unit => unit.kind === 'test' && unit.name === row.name &&
                            unit.startLine === row.startLine)) continue;
                        added = true;
                        units.push({
                            kind: 'test', name: row.name, suite: [...cls.suite, cls.name],
                            ...(cls.namespace && { namespace: cls.namespace }),
                            line: row.line, startLine: row.startLine, endLine: row.endLine, sourceSpan: row.sourceSpan,
                            ...(cls.skipped && { skipped: true }),
                            ...((cls.sometimes || cls.guard || guardedAbove(cls)) && { conditional: true }),
                            dynamic: 'declared-in-a-base-class',
                        });
                    }
                    if (added && !own && inherited.tests.length === 0) {
                        units.push({
                            kind: 'suite', name: cls.name, suite: cls.suite,
                            line: cls.line, startLine: cls.startLine, endLine: cls.endLine, sourceSpan: cls.sourceSpan,
                        });
                    }
                }
            }
            // Code the runner hands the decision to: what it does is not
            // read, so a test under it runs only sometimes.
            if (gatedAtRunTime(filePath, runner)) {
                units = units.map(unit => unit.kind === 'test' && !unit.skipped ? { ...unit, conditional: true } : unit);
            }
            units.sort((a, b) => a.startLine - b.startLine || (b.endLine - a.endLine) ||
                codeUnitCompare(a.name || '', b.name || ''));
            facts = {
                modeled: true,
                units,
                // A test that is declared and not executed is not counted.
                tests: units.filter(unit => unit.kind === 'test' && !unit.skipped).length,
                inheriting,
            };
        }
        model.byFile.set(filePath, facts);
        return facts;
    };

    /**
     * What has to be the same for two files to share one command: a hook
     * that decides for a whole run is loaded with every file below its
     * conftest.py, so a file from elsewhere joined to one of those would
     * run under a hook its own command never loads; a module that
     * switches a class of another module on or off does it for every
     * module loaded after it.
     */
    model.joinKey = filePath => {
        const found = model.declared(filePath);
        if (!found || !found.derived || found.notCollected) return '';
        // A module that writes a switch on a name it took from another
        // module changes that object for every module loaded after it:
        // it is run by itself.
        const alone = Object.keys((found.module && found.module.switches) || {}).length > 0 ||
            ((found.module && found.module.constructorWrites) || []).length > 0
            ? `\0switches:${index.files.get(filePath).relativePath}` : '';
        return guardsOf(filePath).wholeRun.join('\0') + alone;
    };

    /** Classes that derive from the one named, through the project. */
    const descendantFiles = className => {
        const files = new Set();
        const seen = new Set([className]);
        const queue = [className];
        while (queue.length > 0 && seen.size < 512) {
            for (const child of index.extendedByGraph?.get(queue.shift()) || []) {
                const name = typeof child === 'string' ? child : child?.name;
                if (!name || seen.has(name)) continue;
                seen.add(name);
                queue.push(name);
                for (const def of index.symbols.get(name) || []) {
                    if (CONTAINER_KINDS.has(def.type)) files.add(def.file);
                }
            }
        }
        return files;
    };

    /**
     * The tests that execute a line of test code: the unit that holds it,
     * and every test a deriving class inherits from the method that holds
     * it. A line in a suite outside its tests answers with the suite. An
     * empty answer: the line belongs to no unit (file-level code).
     * @returns {Array<{filePath: string, unit: object}>}
     */
    model.runsAt = (filePath, site) => {
        const out = [];
        const point = testSite(site);
        // The units of a file that may run this code. A module its runner
        // does not collect by its name declares none: it is not read for
        // the answer.
        const unitsIn = file => {
            if (!model.byFile.has(file)) {
                const entry = index.files.get(file);
                if (entry && collectionFor(file, entry).collected === false) return [];
            }
            return model.unitsOf(file).units;
        };
        const unit = model.unitAt(filePath, point);
        if (unit && unit.kind === 'test') out.push({ filePath, unit });
        const holders = innermostTestRows(model.declared(filePath)?.classes || [], point);
        const holder = holders.length === 1 ? holders[0] : null;
        // The method that holds the line: a test's declaration, or a method
        // a deriving class's test takes its body from.
        const templates = holder ? innermostTestRows([...holder.tests, ...(holder.memberRows || [])], point) : [];
        // Test/member rows can describe the same body; distinct spans must
        // not be collapsed merely because their declaration lines match.
        const template = templates.length > 0 && templates.every(row => row.name === templates[0].name &&
            row.sourceSpan?.start === templates[0].sourceSpan?.start) ? templates[0] : null;
        const importers = [...(index.exportGraph?.get(filePath) || [])];
        if (template) {
            const held = from => !!from && from.filePath === filePath && from.ownerLine === holder.startLine &&
                from.startLine === template.startLine && from.endLine === template.endLine &&
                (!from.sourceSpan || !template.sourceSpan || from.sourceSpan.start === template.sourceSpan.start);
            for (const file of [...new Set([...descendantFiles(holder.name), ...importers, filePath])].sort(codeUnitCompare)) {
                for (const candidate of unitsIn(file)) {
                    // Every test whose body this is: the one a deriving
                    // class inherits, another name for it in its class;
                    // and every test whose body it may be.
                    if ((held(candidate.inherited) || (candidate.alternatives || []).some(held)) &&
                        !out.some(seen => seen.filePath === file && seen.unit === candidate)) {
                        out.push({ filePath: file, unit: candidate });
                    }
                }
            }
        }
        // A function another module imports under a test's name runs there.
        const functions = holder ? [] : innermostTestRows(model.declared(filePath)?.functions || [], point);
        const fn = functions.length === 1 ? functions[0] : null;
        if (fn) {
            for (const file of [...new Set([...importers, filePath])].sort(codeUnitCompare)) {
                for (const candidate of unitsIn(file)) {
                    const from = candidate.inherited;
                    if (from && from.filePath === filePath && from.owner == null && from.startLine === fn.startLine &&
                        (!from.sourceSpan || !fn.sourceSpan || from.sourceSpan.start === fn.sourceSpan.start)) {
                        out.push({ filePath: file, unit: candidate });
                    }
                }
            }
        }
        if (out.length === 0 && unit) out.push({ filePath, unit });
        return out;
    };

    /**
     * Can a file hold test code at all? Asked before a file is read for
     * the tests in it. A language says so from what the index keeps
     * (`testCodeGate`): whether a declaration of the file carries a mark
     * that can make a test, and which types its classes derive from. No
     * mark here and none in the file of a class of the project one of its
     * classes derives from: no test, and no body of one. A language
     * without the gate is read. (`options.ungated` reads every file: the
     * gate must never change an answer.)
     */
    const gates = new Map();
    const projectDeclaresType = name => (index.symbols.get(name) || []).some(def => CONTAINER_KINDS.has(def.type));
    model.mayHoldTests = (filePath, trail = new Set()) => {
        if (options.ungated) return true;
        if (gates.has(filePath)) return gates.get(filePath);
        const entry = index.files.get(filePath);
        const gate = entry && langTraits(entry.language)?.testCodeGate;
        if (typeof gate !== 'function') return true;
        if (trail.has(filePath)) return false;
        let answer;
        try {
            const facts = gate(entry, projectDeclaresType);
            answer = !!facts.marked;
            // A base written under a using alias is the type the alias
            // names (the file's own, a global one, a project file's).
            const aliases = !answer && langTraits(entry.language)?.typeNameScoping === 'namespace-usings'
                ? csharpUsings(index, filePath) : null;
            if (aliases && aliases.unreadable) answer = true;
            const next = new Set(trail).add(filePath);
            for (const base of answer ? [] : facts.bases || []) {
                const names = [base];
                if (aliases && aliases.aliases.has(base)) names.push(String(aliases.aliases.get(base)).split('.').pop());
                for (const def of names.flatMap(name => index.symbols.get(name) || [])) {
                    if (!CONTAINER_KINDS.has(def.type) || !def.file || def.file === filePath) continue;
                    if (model.mayHoldTests(def.file, next)) {
                        answer = true;
                        break;
                    }
                }
                if (answer) break;
            }
        } catch (e) {
            answer = true;
        }
        // An answer reached inside a cycle of classes is not kept: it may
        // be 'no' only because the walk came back to its start.
        if (answer || trail.size === 0) gates.set(filePath, answer);
        return answer;
    };

    /**
     * The lines of a file a test executes, as [start, end] ranges: its own
     * tests and suites, and the methods and functions a test another file
     * lists runs as its body (a base class's test a deriving class
     * inherits, a method that gives an inherited test its body, a function
     * another module imports under a test's name). This is what makes code
     * test code, whatever its file is called: a base class in a file whose
     * name is no test file's holds the bodies of the tests that inherit
     * from it. Empty for a file the model knows no test in.
     */
    model.testRangesOf = filePath => {
        if (model.ranges.has(filePath)) return model.ranges.get(filePath);
        model.ranges.set(filePath, []);
        const ranges = [];
        const found = model.mayHoldTests(filePath) ? model.declared(filePath) : null;
        if (found) {
            for (const unit of model.unitsOf(filePath).units) {
                if (!unit.inherited) ranges.push([unit.startLine, unit.endLine]);
            }
            const covered = row => ranges.some(([start, end]) => row.startLine >= start && row.endLine <= end);
            const rows = [...(found.functions || [])];
            for (const cls of found.classes || []) {
                rows.push(...(cls.tests || []));
                // A method that is no test gives one its body only in a
                // class that inherits a test of its name.
                if (cls.bases.length === 0 || (cls.memberRows || []).length === 0) continue;
                const inherited = new Set();
                for (const node of orderOf(filePath, cls).slice(1)) {
                    if (!node.opaque) for (const test of node.cls.tests || []) inherited.add(test.name);
                }
                if (inherited.size > 0) rows.push(...cls.memberRows.filter(row => inherited.has(row.name)));
            }
            rows.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
            for (const row of rows) {
                if (row.startLine == null || row.endLine == null || covered(row)) continue;
                if (model.runsAt(filePath, { line: row.startLine,
                    column: row.sourceSpan?.startColumn, callStart: row.sourceSpan?.start }).length > 0) {
                    ranges.push([row.startLine, row.endLine]);
                }
            }
        }
        model.ranges.set(filePath, ranges);
        return ranges;
    };

    /** Innermost units at a physical site. A line alone may be ambiguous. */
    model.unitsAt = (filePath, site) => {
        const candidates = model.unitsOf(filePath).units.filter(unit =>
            !unit.inherited && containsTestSite(unit, site));
        return candidates.filter(unit => !candidates.some(other => other !== unit &&
            containsTestUnit(unit, other) &&
            (!containsTestUnit(other, unit) || (other.kind === 'test' && unit.kind !== 'test'))));
    };
    model.unitAt = (filePath, site) => {
        const units = model.unitsAt(filePath, site);
        return units.length === 1 ? units[0] : null;
    };

    /** Tests a unit stands for: itself, or every test a suite holds. */
    model.testsWithin = (filePath, unit) => {
        const { units } = model.unitsOf(filePath);
        if (!unit) return units.filter(candidate => candidate.kind === 'test');
        if (unit.kind === 'test') return [unit];
        return units.filter(candidate => candidate.kind === 'test' &&
            containsTestUnit(unit, candidate));
    };

    /**
     * `tests`: declares a unit, or can hold tests the declarations do not
     * show. `support`: test-path code that is not a test. `unmodeled`: the
     * language's units are not read.
     */
    model.roleOf = filePath => {
        const facts = model.unitsOf(filePath);
        if (!facts.modeled) return 'unmodeled';
        if (facts.tests > 0 || facts.units.length > 0 || facts.inheriting) return 'tests';
        // A language whose tests are all declarations: none read, none there.
        if (model.declared(filePath)?.complete || model.declared(filePath)?.notCollected) return 'support';
        const fileEntry = index.files.get(filePath);
        // node runs every file it is told to, or looks for, as a test: a
        // script that declares none is one.
        const runner = model.runnerOf(filePath) || {};
        if (runner.id === 'node-test' && nodeRunsFile(runner, relativeTo(runner.dir, fileEntry.relativePath))) return 'tests';
        const named = langTraits(fileEntry.language)?.testFileNames || [];
        const base = path.posix.basename(fileEntry.relativePath);
        const collection = (model.runnerOf(filePath) || {}).collection || {};
        if (collection.files && collection.files.some(glob => globMatches(glob, base))) return 'tests';
        if (named.some(pattern => pattern.test(fileEntry.relativePath) || pattern.test(base))) return 'tests';
        return 'support';
    };

    /** The command that runs a unit (or the file when `unit` is null). */
    model.selectorOf = (filePath, unit) => {
        const fileEntry = index.files.get(filePath);
        const runner = model.runnerOf(filePath);
        if (!runner.id) return withheld(runner.reason || 'no-runner-evidence');
        const build = SELECTORS[runner.id];
        if (!build) return withheld('runner-not-modeled');
        if (unit && unit.kind !== 'test') return withheld('not-a-test');
        if (unit && unit.name == null) return withheld('name-not-literal');
        if (unit && unit.dynamic) return withheld(unit.dynamic);
        // Runners select by name: two declarations of one name in one
        // suite are one selection.
        if (unit && model.unitsOf(filePath).units.some(other => other !== unit && other.kind === 'test' &&
            other.name === unit.name && other.suite.length === unit.suite.length &&
            other.suite.every((name, i) => name === unit.suite[i]) &&
            !(other.inherited && unit.inherited && other.startLine !== unit.startLine))) {
            return withheld('name-not-unique');
        }
        try {
            return build(model, runner, fileEntry, unit || null, filePath);
        } catch (e) {
            return withheld('selector-failed');
        }
    };

    /** A unit as an answer row. */
    model.describe = (filePath, unit) => {
        const { selector, reason } = unit.kind === 'test' ? model.selectorOf(filePath, unit) : withheld('not-a-test');
        return {
            kind: unit.kind,
            name: unit.name,
            suite: unit.suite,
            line: unit.line,
            ...(unit.inherited && { inheritedFrom: `${unit.inherited.file}:${unit.inherited.line}` }),
            ...(unit.conditional && { conditional: true }),
            ...(unit.skipped && { skipped: true }),
            ...(unit.kind === 'test' && selector && { selector }),
            ...(unit.kind === 'test' && !selector && { selectorWithheld: reason }),
        };
    };

    /** What a file is to a runner: role, runner, the command for the file. */
    model.fileFacts = filePath => {
        const role = model.roleOf(filePath);
        const runner = model.runnerOf(filePath);
        const facts = model.unitsOf(filePath);
        const out = { role, tests: facts.tests };
        // The runner reports more tests than are counted: the file holds
        // some that are not listed, or a listed one stands for several.
        if (role === 'tests' && (facts.inheriting ||
            facts.units.some(unit => unit.kind === 'test' && !unit.skipped && standsForSeveral(unit)))) out.moreTests = true;
        if (runner.id) out.runner = runner.id;
        if (role === 'tests') {
            const tests = facts.units.filter(unit => unit.kind === 'test');
            // A module its runner is told not to collect has no command.
            // A file whose tests are all declared inside functions has
            // them only where something calls those functions; one whose
            // every test is left out of some builds has no command that
            // is known to run it.
            const { selector, reason } = model.declared(filePath)?.off
                ? withheld('collection-switched-off')
                : tests.length > 0 && tests.every(unit => unit.dynamic === 'declared-indirectly')
                    ? withheld('declared-indirectly')
                    : tests.length > 0 && tests.every(unit => unit.notInEveryBuild)
                        ? withheld('conditional-tests')
                        : tests.length > 0 && tests.every(unit => unit.deselected)
                            ? withheld('deselected-by-options') : model.selectorOf(filePath, null);
            if (selector) out.run = selector;
            else out.runWithheld = reason;
        }
        return out;
    };

    return model;
}

/**
 * Add a `test-case` row for every test that holds one of the matches that
 * count, and for every titled unit whose title names the term. The row
 * sits on the unit's first line; a line that already has a row keeps it.
 * @param {object[]} matches - rows of one file, extended in place
 * @param {{counts: function, titleNeedsMatch?: boolean, titles?: boolean, extra?: object}} options
 */
function addTestCaseRows(model, index, filePath, term, matches, options) {
    const taken = new Set(matches.map(match => match.line));
    const counted = matches.filter(options.counts);
    const added = [];
    const add = unit => {
        if (taken.has(unit.startLine)) return;
        taken.add(unit.startLine);
        added.push({
            line: unit.startLine,
            ...(unit.sourceSpan && { column: unit.sourceSpan.startColumn, callStart: unit.sourceSpan.start }),
            content: (index.getLineContent(filePath, unit.startLine) || '').trim(),
            matchType: 'test-case',
            ...(options.extra || {}),
        });
    };
    if (!model.unitsOf(filePath).modeled) {
        // A language whose tests are not read as units: the function the
        // harness invokes around a match stands for the test. No name,
        // suite or command is claimed for it.
        const fileEntry = index.files.get(filePath);
        let kindOf;
        try {
            kindOf = getLanguageAdapter(fileEntry.language)?.getEntryPointKind || null;
        } catch (e) {
            kindOf = null;
        }
        for (const symbol of (kindOf && fileEntry.symbols) || []) {
            if (kindOf(symbol) !== 'test') continue;
            const end = symbol.endLine ?? symbol.startLine;
            if (counted.some(match => match.line >= symbol.startLine && match.line <= end)) {
                add({ startLine: symbol.startLine });
            }
        }
        matches.push(...added);
        return;
    }
    for (const match of counted) {
        const unit = model.unitAt(filePath, match);
        if (unit && unit.kind === 'test') add(unit);
    }
    if (options.titles !== false && term) {
        // A title is prose: the term counts where it stands as a word.
        const named = new RegExp('(^|[^\\w$])' + escapeRegExp(term) + '([^\\w$]|$)');
        for (const unit of model.unitsOf(filePath).units) {
            if (!unit.titled || unit.name == null || !named.test(unit.name)) continue;
            if (options.titleNeedsMatch &&
                !counted.some(match => containsTestSite(unit, match))) continue;
            add(unit);
        }
    }
    matches.push(...added);
}

/**
 * One declaration: two tests of one name on two lines are two tests, and
 * so are two a class inherits under one name (two methods of that name
 * with other parameters), which stand on the class's line both.
 */
function testKey(relativePath, unit) {
    return [relativePath, ...unit.suite, unit.name == null ? '' : unit.name, `@${unit.startLine}`,
        ...(unit.sourceSpan ? [`#${unit.sourceSpan.start}`] : []),
        ...(unit.inherited ? [`<${unit.inherited.file}:${unit.inherited.startLine}:${unit.inherited.sourceSpan?.start ?? ''}`] : [])].join('\0');
}

/**
 * What the lines of a test-path file that reach a symbol amount to: the
 * file's role and runner, the units of THIS file that execute those lines
 * (plus `extra`: units of this file that execute lines of another, handed
 * over by that file's answer), how many tests that is, and the command for
 * the file. `moreTests`: `tests` is a lower bound (the file holds tests
 * the reader does not list, or a counted declaration stands for several
 * of the runner's tests). `conditionalTests`: how many of the counted
 * tests run only sometimes. `carried` (not enumerable) holds the units of
 * OTHER files that execute these lines: a test a class inherits runs where
 * the class is.
 * @returns {{role: string, runner?: string, run?: object, runWithheld?: string,
 *   units: object[], tests: number, moreTests?: boolean, conditionalTests?: number,
 *   testKeys: string[], carried: Array<{filePath: string, unit: object}>}}
 */
function linkFile(model, index, filePath, lines, extra = []) {
    const facts = model.fileFacts(filePath);
    const relativePath = index.files.get(filePath).relativePath;
    const rows = new Map();
    const tests = new Set();
    const sometimes = new Set();
    const carried = [];
    // Tests the file holds and does not list: which of them these lines
    // reach is not known.
    let more = facts.role === 'tests' && model.unitsOf(filePath).inheriting;
    const count = test => {
        if (test.skipped) return;
        tests.add(testKey(relativePath, test));
        if (test.conditional) sometimes.add(testKey(relativePath, test));
        if (standsForSeveral(test)) more = true;
    };
    const take = unit => {
        const key = `${unit.kind}\0${testKey(relativePath, unit)}`;
        if (!rows.has(key)) rows.set(key, model.describe(filePath, unit));
        for (const test of model.testsWithin(filePath, unit)) count(test);
    };
    let fileLevel = false;
    const sites = new Map(lines.map(site => [testSiteKey(site), {
        ...testSite(site), wholeLine: typeof site === 'number',
    }]));
    for (const site of [...sites.values()].sort((a, b) => a.line - b.line || (a.column || 0) - (b.column || 0))) {
        if (site.wholeLine) {
            // Legacy numeric inputs deliberately select the whole source
            // line (the matrix uses every line of a file). Precise callers
            // pass objects, so a missing position never implies this scope.
            const units = model.unitsAt(filePath, site);
            if (units.length > 1) {
                for (const unit of units) take(unit);
                continue;
            }
        }
        const runs = model.runsAt(filePath, site);
        if (runs.length === 0) {
            if (model.unitsAt(filePath, site).length > 1) {
                // A line without a physical position cannot select one of
                // several test bodies. Keep the file, withhold exact units.
                more = true;
                continue;
            }
            fileLevel = true;
            continue;
        }
        for (const run of runs) {
            if (run.filePath === filePath) take(run.unit);
            else carried.push(run);
        }
    }
    for (const unit of extra) take(unit);
    // Code outside every unit runs with the file: all its tests count.
    if (fileLevel && facts.role === 'tests') {
        for (const test of model.testsWithin(filePath, null)) count(test);
    }
    const units = [...rows.values()].sort((a, b) => a.line - b.line || codeUnitCompare(a.name || '', b.name || ''));
    const out = {
        role: facts.role,
        ...(facts.runner && { runner: facts.runner }),
        ...(facts.run && { run: facts.run }),
        ...(facts.runWithheld && { runWithheld: facts.runWithheld }),
        units,
        tests: tests.size,
        // The runner reports more tests than are counted here: the
        // count is a lower bound.
        ...(more && { moreTests: true }),
        // Tests counted that run only sometimes.
        ...(sometimes.size > 0 && { conditionalTests: sometimes.size }),
        testKeys: [...tests].sort(codeUnitCompare),
    };
    Object.defineProperty(out, 'carried', { value: carried, enumerable: false });
    Object.defineProperty(out, 'conditionalKeys', { value: [...sometimes].sort(codeUnitCompare), enumerable: false });
    return out;
}

/**
 * Link several files at once: each file's own lines, then the units that
 * other files' lines carried into it. A file that only receives carried
 * units (its class inherits a test whose body is elsewhere) gets a row of
 * its own.
 * @param {Map<string, number[]>} linesByFile - absolute path -> lines
 * @returns {Map<string, object>} absolute path -> linkFile answer, plus
 *   `from`: the relative paths whose lines its carried units execute
 */
function linkFiles(model, index, linesByFile) {
    const carriedInto = new Map(); // absolute path -> { units: Map, from: Set }
    for (const [filePath, lines] of linesByFile) {
        for (const run of linkFile(model, index, filePath, lines).carried) {
            let held = carriedInto.get(run.filePath);
            if (!held) {
                held = { units: new Map(), from: new Set() };
                carriedInto.set(run.filePath, held);
            }
            held.units.set(testKey('', run.unit), run.unit);
            held.from.add(index.files.get(filePath).relativePath);
        }
    }
    const out = new Map();
    const all = new Set([...linesByFile.keys(), ...carriedInto.keys()]);
    for (const filePath of [...all].sort(codeUnitCompare)) {
        const held = carriedInto.get(filePath);
        const linked = linkFile(model, index, filePath, linesByFile.get(filePath) || [],
            held ? [...held.units.values()] : []);
        if (held) linked.from = [...held.from].sort(codeUnitCompare);
        out.set(filePath, linked);
    }
    return out;
}

// Runners whose file command ends in the path and takes several of them.
const TAKES_MANY = new Set(['pytest', 'node-test', 'jest', 'vitest', 'mocha', 'go-test']);
// Runners in which a focus in one file holds for every file of the run:
// such a file is run by itself, or the others' tests would not run.
const FOCUS_SPANS_THE_RUN = new Set(['mocha']);

/**
 * The commands that run a set of test files, files of one runner and one
 * working directory joined where the runner takes several paths.
 * @returns {string[]}
 */
function commandsFor(model, filePaths) {
    const groups = new Map();
    const single = [];
    for (const filePath of filePaths) {
        // The file's own answer decides: a command it withholds is not
        // offered again here.
        const selector = model.fileFacts(filePath).run;
        if (!selector) continue;
        const runner = model.runnerOf(filePath);
        const cut = selector.command.lastIndexOf(' ');
        const last = selector.command.slice(cut + 1);
        if (!TAKES_MANY.has(runner.id) || cut < 0 || /['"\\]/.test(last) ||
            (FOCUS_SPANS_THE_RUN.has(runner.id) && model.declared(filePath)?.focus)) {
            if (!single.includes(selectorText(selector))) single.push(selectorText(selector));
            continue;
        }
        const head = selector.command.slice(0, cut);
        const key = `${selector.cwd || ''}\0${head}\0${model.joinKey(filePath)}`;
        if (!groups.has(key)) groups.set(key, { cwd: selector.cwd, head, paths: [] });
        const group = groups.get(key);
        if (!group.paths.includes(last)) group.paths.push(last);
    }
    const joined = [...groups.values()].map(group =>
        selectorText({ command: `${group.head} ${group.paths.join(' ')}`, ...(group.cwd && { cwd: group.cwd }) }));
    return [...joined, ...single];
}

/** fnmatch as pytest applies it to a name: `*`, `?`, and `[...]`. */
function globMatches(glob, name) {
    const source = String(glob).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try {
        return new RegExp(`^${source}$`).test(name);
    } catch (e) {
        return false;
    }
}

/** A selector as one shell line. */
function selectorText(selector) {
    if (!selector) return null;
    return selector.cwd ? `(cd ${shellWord(selector.cwd)} && ${selector.command})` : selector.command;
}

// Declarations whose names at run time are not the written one, or that
// exist once for every call of the function around them.
const SEVERAL_KINDS = new Set(['generated-cases', 'name-not-literal', 'suite-name-not-literal', 'declared-indirectly']);

/**
 * Does one declaration stand for several of the runner's tests: a table
 * of cases, a parametrized test, a title computed at run time, a
 * declaration inside a function that may be called more than once.
 */
function standsForSeveral(unit) {
    return !!unit.several || SEVERAL_KINDS.has(unit.dynamic);
}

/**
 * A count of tests as text: "3 tests", "at least 3 tests" when tests
 * that are not listed may add to it, "(1 conditional)" for the ones that
 * run only sometimes.
 */
function testCountText(count, more, conditional) {
    if (!count) return more ? 'tests not listed' : '';
    return `${more ? 'at least ' : ''}${count} test${count === 1 ? '' : 's'}${conditional ? ` (${conditional} conditional)` : ''}`;
}

/** A unit's name as people write it: `suite > suite > name`. */
function unitLabel(unit) {
    return [...(unit.suite || []), unit.name == null ? '(computed name)' : unit.name].join(' > ');
}

module.exports = {
    createTestModel, selectorText, unitLabel, shellWord, globMatches, testCountText, standsForSeveral,
    addTestCaseRows, linkFile, linkFiles, commandsFor, testSite, testSiteKey,
    // Exposed for tests.
    scriptRunners, nodeTestOptions, configWords, tableText, namesRequirement, focusedOut,
    shellSplit, configArguments, pytestOptions, markSelects, pathGlob, nodeTestPaths, nodeRunsFile,
    mochaLoadingOptions, runnerScriptWords,
};
