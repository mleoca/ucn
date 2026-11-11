/**
 * core/test-units.js — what a test is, where it is, and how to run it.
 *
 * One identity for a test, shared by `tests`, the affected-test selection
 * and `check`: a UNIT is (file, suite chain, name, line), read from the
 * declaration the language's runner collects (the language module's
 * `testUnits`). A line of test code belongs to the innermost unit whose
 * source range holds it; code outside every unit belongs to the file.
 *
 * A RUNNER is named only on evidence: the test file imports the runner's
 * own module, or the nearest build manifest names it. A SELECTOR (the
 * command that runs one unit, or one file) is built only for a runner whose
 * selection syntax is modeled here and only when everything the command
 * depends on is known; otherwise the unit is reported without a command and
 * with the reason. The runner's own configuration is part of that: what
 * is data is read (pytest's options and naming rules, jest's roots and
 * path patterns, vitest's directory, the options a mocha or node script
 * passes), and a configuration that can change what a command selects and
 * is not read withholds the command. Nothing here executes anything.
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

// Configuration files of the JavaScript runners, and the keys in them
// that change which tests a command runs.
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
const JS_SELECTING_KEYS = {
    jest: new Set(['testMatch', 'testRegex', 'testPathIgnorePatterns', 'roots', 'rootDir', 'projects', 'preset',
        'modulePathIgnorePatterns', 'moduleFileExtensions', 'haste', 'runner', 'testRunner', 'injectGlobals']),
    vitest: new Set(['include', 'exclude', 'includeSource', 'dir', 'root', 'projects', 'workspace', 'extends',
        'testNamePattern', 'allowOnly', 'browser', 'shard', 'related', 'changed']),
    mocha: new Set(['spec', 'file', 'ignore', 'exclude', 'grep', 'fgrep', 'invert', 'extension', 'ui', 'dry-run',
        'dryRun', 'forbid-only', 'forbidOnly', 'config', 'package', 'opts']),
};
const CONFIG_WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression',
    'type_assertion', 'non_null_expression']);

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

/**
 * The keys a configuration file sets, each with a reader of its value as
 * strings (null when the value is not a string or a list of strings
 * written out). Null when the file's configuration object is not read.
 */
function configKeysOfJson(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = new Map();
    for (const [key, held] of Object.entries(value)) {
        keys.set(key, {
            strings: () => typeof held === 'string' ? [held]
                : Array.isArray(held) && held.every(item => typeof item === 'string') ? held : null,
            object: () => configKeysOfJson(held),
        });
    }
    return keys;
}

function configKeysOf(model, dir, name) {
    const text = model.manifests.read(dir, name);
    if (text == null) return null;
    const fromJson = configKeysOfJson;
    if (/\.(json|jsonc)$/.test(name)) {
        try {
            return fromJson(JSON.parse(text));
        } catch (e) {
            // Comments are allowed in these files.
            try {
                return fromJson(JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
            } catch (e2) {
                return null;
            }
        }
    }
    if (/\.(yaml|yml)$/.test(name)) {
        // The top-level keys of a mapping; their values are not read.
        const keys = new Map();
        for (const line of text.split('\n')) {
            const found = /^(['"]?)([A-Za-z][\w-]*)\1\s*:/.exec(line);
            if (found) keys.set(found[2], { strings: () => null, object: () => null });
        }
        return keys;
    }
    if (!/\.[cm]?[jt]s$/.test(name)) return null;
    const tree = safeParse(getParser(/\.[cm]?ts$/.test(name) ? 'typescript' : 'javascript'), text);
    if (!tree) return null;
    const root = tree.rootNode;
    const declared = identifier => {
        const found = [];
        for (const statement of root.namedChildren) {
            const declaration = statement.type === 'export_statement'
                ? statement.namedChildren.find(child => /_declaration$/.test(child.type)) : statement;
            if (!declaration || (declaration.type !== 'lexical_declaration' && declaration.type !== 'variable_declaration')) continue;
            for (const declarator of declaration.namedChildren) {
                const target = declarator.childForFieldName && declarator.childForFieldName('name');
                if (target && target.type === 'identifier' && target.text === identifier) found.push(declarator.childForFieldName('value'));
            }
        }
        return found.length === 1 ? found[0] : null;
    };
    const objectOf = (node, depth = 0) => {
        if (!node || depth > 6) return null;
        if (CONFIG_WRAPPERS.has(node.type)) return objectOf(node.namedChildren[0], depth + 1);
        if (node.type === 'object') return node;
        if (node.type === 'identifier') return objectOf(declared(node.text), depth + 1);
        if (node.type === 'call_expression') {
            // defineConfig({...}) hands its argument back.
            const callee = node.childForFieldName('function');
            const args = node.childForFieldName('arguments');
            if (callee && callee.type === 'identifier' && /^define(Config|Project)$/.test(callee.text) &&
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
            if (written == null) return null;
            keys.set(written, {
                strings: () => {
                    const one = stringLiteralValue(value);
                    if (one != null) return [one];
                    if (!value || value.type !== 'array') return null;
                    const all = value.namedChildren.filter(item => item.type !== 'comment').map(stringLiteralValue);
                    return all.every(item => item != null) ? all : null;
                },
                object: () => fromObject(value),
            });
        }
        return keys;
    };
    let exported = null;
    let count = 0;
    for (const statement of root.namedChildren) {
        if (statement.type === 'expression_statement') {
            const assignment = statement.namedChildren[0];
            if (assignment && assignment.type === 'assignment_expression' &&
                assignment.childForFieldName('left')?.text.replace(/\s+/g, '') === 'module.exports') {
                exported = assignment.childForFieldName('right');
                count++;
            }
        } else if (statement.type === 'export_statement' && statement.children.some(child => child.type === 'default')) {
            exported = statement.childForFieldName('value');
            count++;
        }
    }
    return count === 1 ? fromObject(exported) : null;
}

/**
 * What a JavaScript runner's configuration does to a command that names a
 * test file: `inert` (nothing the command depends on is set), `modeled`
 * (`accepts(file)` says whether the configuration leaves the file in;
 * `ownPattern`: it replaces the runner's default file pattern), or
 * `unread` (a key that selects files or tests is set and not modeled, the
 * configuration is code that is not written out as an object, or one
 * stands above the runner's directory).
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
        const sources = files.map(name => configKeysOf(model, here, name));
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
            // The runner's part of a vite configuration is its `test` key.
            const root = keys.get('root');
            const test = keys.get('test');
            if (root) return { state: 'unread' };
            if (!test) return { state: 'inert' };
            keys = test.object();
            if (!keys) return { state: 'unread' };
        }
        const selecting = [...keys.keys()].filter(key => JS_SELECTING_KEYS[runner.id].has(key));
        if (selecting.length === 0) return { state: 'inert', keys: new Set(keys.keys()) };
        const absolute = file => path.posix.join(String(model.root).replace(/\\/g, '/'), here, file);
        if (runner.id === 'jest' && selecting.every(key => ['roots', 'testRegex', 'testPathIgnorePatterns'].includes(key))) {
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
        if (runner.id === 'vitest' && selecting.length === 1 && selecting[0] === 'dir') {
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
function createTestModel(index) {
    const model = {
        manifests: createManifests(index),
        byFile: new Map(),
        rawByFile: new Map(),
        exports: new Map(),
        runners: new Map(),
        jsConfigs: new Map(),
        gates: new Map(),
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

    const nodeKey = node => node.opaque ? `?${node.name}` : `${node.filePath}\0${node.cls.startLine}\0${node.cls.name}`;
    const linearMemo = new Map();

    /**
     * The order in which a class's members are looked up: the class, then
     * the classes it derives from. `c3` is Python's method resolution
     * order; otherwise depth first in the order written (a superclass
     * before the interfaces). A base that is not a class the project
     * declares once stands in the order as an opaque entry, `safe` when the
     * language's reader knows it brings neither a test nor a constructor.
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
        const parents = cls.bases.map(written => {
            const base = baseClass(filePath, written);
            if (base) return base;
            const name = String(written).replace(/[<[(].*$/, '').split('.').pop().trim();
            return { opaque: true, name, safe: (cls.plainBases || []).includes(written) };
        });
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
     */
    const inheritedBy = (filePath, cls) => {
        const out = [];
        const hidden = new Set(cls.members);
        let behindUnknown = false;
        let withheldAny = false;
        for (const node of orderOf(filePath, cls).slice(1)) {
            if (node.opaque) {
                if (!node.safe) behindUnknown = true;
                continue;
            }
            for (const test of node.cls.tests) {
                if (hidden.has(test.name)) continue;
                hidden.add(test.name);
                if (behindUnknown) withheldAny = true;
                else out.push({ test, base: node });
            }
            for (const member of node.cls.members) hidden.add(member);
        }
        return { tests: out, open: behindUnknown, withheld: withheldAny };
    };

    /**
     * Does the runner refuse a class its own declarations would let in:
     * a class it derives from declares a member that rules a class out
     * (`refusedIfDeclares`), or the nearest explicit switch (`enabled`) in
     * lookup order says off. `unknown`: a base that is not read could.
     */
    const refusal = (filePath, cls) => {
        const rules = cls.refusedIfDeclares ? [].concat(cls.refusedIfDeclares) : [];
        let switchSeen = cls.enabled != null;
        let off = cls.enabled === false;
        let ruledOut = false;
        let unknown = false;
        for (const node of orderOf(filePath, cls).slice(1)) {
            if (node.opaque) {
                if (rules.length > 0 && !node.safe) unknown = true;
                continue;
            }
            if (rules.some(name => node.cls.members.includes(name))) ruledOut = true;
            if (!switchSeen && node.cls.enabled != null) {
                switchSeen = true;
                off = node.cls.enabled === false;
            }
        }
        return { refused: ruledOut || off, unknown: !(ruledOut || off) && unknown };
    };

    /**
     * Is there code beside a test file that the runner lets decide which
     * tests run (the language's `testGate`): a conftest.py above it whose
     * hooks can change what is collected or run, a TestMain in its Go
     * package that may not run the tests.
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
        if (runner.id === 'pytest') {
            return ancestorDirs(relativePath).some(dir => decides(path.join(index.root, dir, 'conftest.py')));
        }
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
        } else {
            // A class its runner refuses holds no test, whatever it declares.
            const relativePath = index.files.get(filePath).relativePath;
            const runner = model.runnerOf(filePath) || {};
            const naming = runner.collection || {};
            const named = (patterns, fallback, name) => (patterns && patterns.length > 0 ? patterns : fallback)
                .some(pattern => /[*?[]/.test(pattern) ? globMatches(pattern, name) : name.startsWith(pattern));
            // Names the module takes from other modules of the project:
            // a test class or function among them is collected here too.
            const taken = [];
            const classesHere = [...(found.classes || [])];
            for (const entry of found.imports || []) {
                const from = (index.files.get(filePath).moduleResolved || {})[entry.module];
                const target = from ? path.join(index.root, from) : null;
                const there = target && target !== filePath && index.files.has(target) ? model.declared(target) : null;
                if (!there) continue;
                const cls = (there.classes || []).find(other => other.name === entry.original && other.suite.length === 0);
                if (cls && (cls.unittest || named(naming.classes, ['Test'], entry.name))) {
                    classesHere.push({
                        name: entry.name, suite: [], bases: [], runnable: true, imported: { filePath: target, cls },
                        ...(cls.refusedIfDeclares && { refusedIfDeclares: cls.refusedIfDeclares }),
                        line: entry.line, startLine: entry.line, endLine: entry.line,
                        members: [], tests: [], marks: [], marksOpen: false,
                    });
                }
                const fn = (there.functions || []).find(other => other.name === entry.original);
                if (fn && named(naming.functions, ['test'], entry.name)) taken.push({ entry, fn, target });
            }
            const refusedClasses = classesHere.filter(cls => cls.runnable && refusal(filePath, cls).refused);
            // Whether the runner takes a class that derives from one the
            // project does not declare cannot be read here: its tests are
            // listed as collected only sometimes, with no command.
            const unsettled = classesHere.filter(cls => cls.runnable && cls.refusedIfDeclares &&
                !refusedClasses.includes(cls) && refusal(filePath, cls).unknown);
            const within = (unit, cls) => unit.startLine >= cls.startLine && unit.endLine <= cls.endLine;
            // A focus leaves other tests of the file declared and not
            // executed, by the rule of the runner that runs the file.
            const left = found.focus ? focusedOut(found.units, model.runnerOf(filePath).id) : new Set();
            let units = found.units.filter(unit => !refusedClasses.some(cls => !cls.imported && within(unit, cls)))
                .map(unit => {
                    let out = unit;
                    if (unit.kind === 'test' && unsettled.some(cls => !cls.imported && within(unit, cls))) {
                        out = { ...out, conditional: true, dynamic: unit.dynamic || 'base-not-resolved' };
                    }
                    if (left.has(unit)) out = { ...out, skipped: true };
                    return out;
                });
            // `open`: the file binds its runner's declaring function and
            // no declaration was read.
            let inheriting = !!found.inheriting || !!found.open;
            for (const cls of classesHere) {
                if (!cls.runnable || (cls.bases.length === 0 && !cls.imported) || refusedClasses.includes(cls)) continue;
                const inherited = inheritedBy(filePath, cls);
                const own = units.some(unit => unit.kind === 'test' && within(unit, cls));
                if (inherited.withheld || (inherited.open && !own && inherited.tests.length === 0)) inheriting = true;
                if (inherited.tests.length > 0 && !own) {
                    units.push({
                        kind: 'suite', name: cls.name, suite: cls.suite,
                        line: cls.line, startLine: cls.startLine, endLine: cls.endLine,
                    });
                }
                // Whether the class or the test exists at all is not
                // settled: no command names it. A condition on running
                // it leaves the command.
                const identity = cls.unsettled ? 'collection-switch'
                    : unsettled.includes(cls) ? 'base-not-resolved' : null;
                for (const { test, base } of inherited.tests) {
                    units.push({
                        kind: 'test', name: test.name, suite: [...cls.suite, cls.name],
                        ...(cls.namespace && { namespace: cls.namespace }),
                        line: cls.line, startLine: cls.line, endLine: cls.line,
                        ...((test.skipped || cls.skipped) && { skipped: true }),
                        ...((identity || cls.sometimes || test.conditional) && { conditional: true }),
                        ...((identity || test.dynamic) && { dynamic: identity || test.dynamic }),
                        ...(test.marks && { marks: test.marks, marksOpen: !!test.marksOpen }),
                        inherited: {
                            file: index.files.get(base.filePath).relativePath,
                            filePath: base.filePath, owner: base.cls.name,
                            ownerLine: base.cls.startLine, line: test.line,
                            startLine: test.startLine, endLine: test.endLine,
                        },
                    });
                }
            }
            for (const { entry, fn, target } of taken) {
                units.push({
                    kind: 'test', name: entry.name, suite: [],
                    line: entry.line, startLine: entry.line, endLine: entry.line,
                    ...(fn.skipped && { skipped: true }),
                    ...(fn.conditional && { conditional: true }),
                    ...(fn.dynamic && { dynamic: fn.dynamic }),
                    ...(fn.marks && { marks: fn.marks, marksOpen: !!fn.marksOpen }),
                    inherited: {
                        file: index.files.get(target).relativePath, filePath: target, owner: null, ownerLine: 0,
                        line: fn.line, startLine: fn.startLine, endLine: fn.endLine,
                    },
                });
            }
            // The runner's configured options: a mark expression and
            // tests left out by name apply to a test however it is named
            // on the command line (measured).
            const options = naming.options;
            if (options && (options.markExpr || options.deselect.length > 0)) {
                const file = relativeTo(runner.dir, relativePath);
                units = units.map(unit => {
                    if (unit.kind !== 'test' || unit.skipped) return unit;
                    const id = [file, ...unit.suite, unit.name].join('::');
                    let selected = file != null && options.deselect.some(prefix => id.startsWith(prefix)) ? false : true;
                    if (selected && options.markExpr) {
                        const marks = new Set([...(unit.marks || []), ...(found.marks || [])]);
                        let open = !!unit.marksOpen || !!found.marksOpen;
                        // Marks of the classes around the test, and of
                        // every class those derive from.
                        const around = unit.inherited
                            ? classesHere.filter(cls => cls.line === unit.line && cls.name === unit.suite[unit.suite.length - 1])
                            : classesHere.filter(cls => !cls.imported && within(unit, cls));
                        const holders = new Set(around);
                        for (const cls of around) {
                            for (const outer of classesHere) {
                                if (!outer.imported && outer !== cls && outer.startLine <= cls.startLine && outer.endLine >= cls.endLine) holders.add(outer);
                            }
                        }
                        for (const cls of holders) {
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
    model.runsAt = (filePath, line) => {
        const out = [];
        const unit = model.unitAt(filePath, line);
        if (unit && unit.kind === 'test') out.push({ filePath, unit });
        const holder = (model.declared(filePath)?.classes || [])
            .filter(cls => cls.startLine <= line && cls.endLine >= line)
            .sort((a, b) => b.startLine - a.startLine)[0];
        const template = holder && holder.tests.find(test => test.startLine <= line && test.endLine >= line);
        const importers = [...(index.exportGraph?.get(filePath) || [])];
        if (template) {
            for (const file of [...new Set([...descendantFiles(holder.name), ...importers, filePath])].sort(codeUnitCompare)) {
                for (const candidate of model.unitsOf(file).units) {
                    const from = candidate.inherited;
                    if (from && from.filePath === filePath && from.ownerLine === holder.startLine &&
                        candidate.name === template.name) out.push({ filePath: file, unit: candidate });
                }
            }
        }
        // A function another module imports under a test's name runs there.
        const fn = holder ? null : (model.declared(filePath)?.functions || [])
            .find(other => other.startLine <= line && other.endLine >= line);
        if (fn) {
            for (const file of importers.sort(codeUnitCompare)) {
                for (const candidate of model.unitsOf(file).units) {
                    const from = candidate.inherited;
                    if (from && from.filePath === filePath && from.owner == null && from.startLine === fn.startLine) {
                        out.push({ filePath: file, unit: candidate });
                    }
                }
            }
        }
        if (out.length === 0 && unit) out.push({ filePath, unit });
        return out;
    };

    /** The innermost unit holding a line: a test before a suite. */
    model.unitAt = (filePath, line) => {
        let best = null;
        for (const unit of model.unitsOf(filePath).units) {
            if (unit.startLine > line) break;
            if (unit.endLine < line || unit.inherited) continue;
            if (!best || (unit.kind === 'test' && best.kind !== 'test') ||
                (unit.kind === best.kind && unit.line >= best.line)) best = unit;
        }
        return best;
    };

    /** Tests a unit stands for: itself, or every test a suite holds. */
    model.testsWithin = (filePath, unit) => {
        const { units } = model.unitsOf(filePath);
        if (!unit) return units.filter(candidate => candidate.kind === 'test');
        if (unit.kind === 'test') return [unit];
        return units.filter(candidate => candidate.kind === 'test' &&
            candidate.startLine >= unit.startLine && candidate.endLine <= unit.endLine);
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
        const unit = model.unitAt(filePath, match.line);
        if (unit && unit.kind === 'test') add(unit);
    }
    if (options.titles !== false && term) {
        // A title is prose: the term counts where it stands as a word.
        const named = new RegExp('(^|[^\\w$])' + escapeRegExp(term) + '([^\\w$]|$)');
        for (const unit of model.unitsOf(filePath).units) {
            if (!unit.titled || unit.name == null || !named.test(unit.name)) continue;
            if (options.titleNeedsMatch &&
                !counted.some(match => match.line >= unit.startLine && match.line <= unit.endLine)) continue;
            add(unit);
        }
    }
    matches.push(...added);
}

/** One declaration: two tests of one name on two lines are two tests. */
function testKey(relativePath, unit) {
    return [relativePath, ...unit.suite, unit.name == null ? '' : unit.name, `@${unit.startLine}`].join('\0');
}

/**
 * What the lines of a test-path file that reach a symbol amount to: the
 * file's role and runner, the units of THIS file that execute those lines
 * (plus `extra`: units of this file that execute lines of another, handed
 * over by that file's answer), how many tests that is, and the command for
 * the file. `carried` (not enumerable) holds the units of OTHER files that
 * execute these lines: a test a class inherits runs where the class is.
 * @returns {{role: string, runner?: string, run?: object, runWithheld?: string,
 *   units: object[], tests: number, testKeys: string[], carried: Array<{filePath: string, unit: object}>}}
 */
function linkFile(model, index, filePath, lines, extra = []) {
    const facts = model.fileFacts(filePath);
    const relativePath = index.files.get(filePath).relativePath;
    const rows = new Map();
    const tests = new Set();
    const carried = [];
    const take = unit => {
        const key = `${unit.kind}\0${testKey(relativePath, unit)}`;
        if (!rows.has(key)) rows.set(key, model.describe(filePath, unit));
        for (const test of model.testsWithin(filePath, unit)) {
            if (!test.skipped) tests.add(testKey(relativePath, test));
        }
    };
    let fileLevel = false;
    for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
        const runs = model.runsAt(filePath, line);
        if (runs.length === 0) {
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
        for (const test of model.testsWithin(filePath, null)) {
            if (!test.skipped) tests.add(testKey(relativePath, test));
        }
    }
    const units = [...rows.values()].sort((a, b) => a.line - b.line || codeUnitCompare(a.name || '', b.name || ''));
    const out = {
        role: facts.role,
        ...(facts.runner && { runner: facts.runner }),
        ...(facts.run && { run: facts.run }),
        ...(facts.runWithheld && { runWithheld: facts.runWithheld }),
        units,
        tests: tests.size,
        testKeys: [...tests].sort(codeUnitCompare),
    };
    Object.defineProperty(out, 'carried', { value: carried, enumerable: false });
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
        const key = `${selector.cwd || ''}\0${head}`;
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

/** A unit's name as people write it: `suite > suite > name`. */
function unitLabel(unit) {
    return [...(unit.suite || []), unit.name == null ? '(computed name)' : unit.name].join(' > ');
}

module.exports = {
    createTestModel, selectorText, unitLabel, shellWord, globMatches,
    addTestCaseRows, linkFile, linkFiles, commandsFor,
    // Exposed for tests.
    scriptRunners, nodeTestOptions, configWords, tableText, namesRequirement, focusedOut,
    shellSplit, configArguments, pytestOptions, markSelects, pathGlob, nodeTestPaths, nodeRunsFile,
    mochaLoadingOptions, runnerScriptWords,
};
