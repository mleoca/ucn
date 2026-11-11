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
 * with the reason. Nothing here executes anything.
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
// Runners in which a focused test (`.only`) keeps the other tests of its
// file from running. node:test honours the mark only under --test-only.
const FOCUS_RUNNERS = new Set(['jest', 'vitest', 'mocha']);
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
        return { id: fromFile, dir: dir || '', evidence: 'test-file-import', script };
    }
    if (!manifest) return { id: null, reason: 'no-runner-evidence' };
    const named = [...new Set(scriptRunners(script).filter(name => !name.startsWith('?')))];
    if (named.length === 1) {
        if (!MODELED_JS.has(named[0])) return { id: null, reason: 'runner-not-modeled', runner: named[0] };
        return { id: named[0], dir, evidence: 'package-script', script };
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
        return { id: only, dir, evidence: 'package-dependency', script };
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
            if (text != null && /(^|[^\w-])pytest($|[^\w])/m.test(text)) {
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

function titlePattern(unit) {
    return `^${regexLiteral([...unit.suite, unit.name].join(' '))}$`;
}

const SELECTORS = {
    'pytest'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
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
        // A bare path is a pattern jest tries on every test file's path.
        const words = ['npx', 'jest', '--runTestsByPath', shellWord(file)];
        if (unit) words.push('-t', shellWord(titlePattern(unit)));
        return command(runner, words);
    },
    'vitest'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        // vitest runs every file whose path contains the one given.
        if (model.pathsContaining(runner.dir, file) > 1) return withheld('path-not-unique');
        const words = ['npx', 'vitest', 'run', shellWord(file)];
        if (unit) words.push('-t', shellWord(titlePattern(unit)));
        return command(runner, words);
    },
    'mocha'(model, runner, fileEntry, unit) {
        const file = relativeTo(runner.dir, fileEntry.relativePath);
        if (file == null) return withheld('outside-runner-root');
        const words = ['npx', 'mocha', shellWord(file)];
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
        if (unit.conditional) return withheld('conditional-compilation');
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
        runners: new Map(),
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

    const helpersFor = (filePath, fileEntry) => {
        const symbols = fileEntry.symbols || [];
        let lines = null;
        return {
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
            isContainer: symbol => CONTAINER_KINDS.has(symbol.type),
            isCallable: symbol => CALLABLE_KINDS.has(symbol.type),
            /** Names of the types a class derives from, through the project. */
            ancestors(className) {
                const seen = new Set();
                const queue = [className];
                while (queue.length > 0 && seen.size < 64) {
                    const parents = index.extendsGraph?.get(queue.shift()) || [];
                    for (const parent of parents) {
                        const name = typeof parent === 'string' ? parent : parent?.name;
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
            collection: (model.runnerOf(filePath) || {}).collection || {},
            glob: globMatches,
        };
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

    const nodeKey = node => node.opaque ? `?${node.name}` : `${node.filePath}\0${node.cls.startLine}`;
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
        const key = `${filePath}\0${cls.startLine}`;
        if (linearMemo.has(key)) return linearMemo.get(key);
        const self = { filePath, cls };
        if (trail.has(key)) return [self];
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
        } else {
            // A class its runner refuses holds no test, whatever it declares.
            const refusedClasses = (found.classes || []).filter(cls => cls.runnable && refusal(filePath, cls).refused);
            // Whether the runner takes a class that derives from one the
            // project does not declare cannot be read here: its tests are
            // listed as collected only sometimes, with no command.
            const unsettled = (found.classes || []).filter(cls => cls.runnable && cls.refusedIfDeclares &&
                !refusedClasses.includes(cls) && refusal(filePath, cls).unknown);
            const within = (unit, cls) => unit.startLine >= cls.startLine && unit.endLine <= cls.endLine;
            // A focused test leaves the others of its file declared and
            // not executed, under the runners that honour the mark.
            const focus = !!found.focus && FOCUS_RUNNERS.has(model.runnerOf(filePath).id);
            const units = found.units.filter(unit => !refusedClasses.some(cls => within(unit, cls)))
                .map(unit => unit.kind === 'test' && unsettled.some(cls => within(unit, cls))
                    ? { ...unit, conditional: true, dynamic: unit.dynamic || 'base-not-resolved' } : unit)
                .map(unit => focus && unit.kind === 'test' && !unit.focused ? { ...unit, skipped: true } : unit);
            // `open`: the file binds its runner's declaring function and
            // no declaration was read.
            let inheriting = !!found.inheriting || !!found.open;
            for (const cls of found.classes || []) {
                if (!cls.runnable || cls.bases.length === 0 || refusedClasses.includes(cls)) continue;
                const inherited = inheritedBy(filePath, cls);
                const own = units.some(unit => unit.kind === 'test' && within(unit, cls));
                if (inherited.withheld || (inherited.open && !own && inherited.tests.length === 0)) inheriting = true;
                if (inherited.tests.length > 0 && !own) {
                    units.push({
                        kind: 'suite', name: cls.name, suite: cls.suite,
                        line: cls.line, startLine: cls.startLine, endLine: cls.endLine,
                    });
                }
                const sometimes = cls.unsettled || unsettled.includes(cls);
                for (const { test, base } of inherited.tests) {
                    units.push({
                        kind: 'test', name: test.name, suite: [...cls.suite, cls.name],
                        ...(cls.namespace && { namespace: cls.namespace }),
                        line: cls.line, startLine: cls.line, endLine: cls.line,
                        ...((test.skipped || cls.skipped) && { skipped: true }),
                        ...(sometimes && { conditional: true, dynamic: cls.unsettled ? 'collection-switch' : 'base-not-resolved' }),
                        inherited: {
                            file: index.files.get(base.filePath).relativePath,
                            filePath: base.filePath, owner: base.cls.name,
                            ownerLine: base.cls.startLine, line: test.line,
                            startLine: test.startLine, endLine: test.endLine,
                        },
                    });
                }
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
        if (template) {
            for (const file of [...descendantFiles(holder.name), filePath].sort(codeUnitCompare)) {
                for (const candidate of model.unitsOf(file).units) {
                    const from = candidate.inherited;
                    if (from && from.filePath === filePath && from.ownerLine === holder.startLine &&
                        candidate.name === template.name) out.push({ filePath: file, unit: candidate });
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
        const fileEntry = index.files.get(filePath);
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
                        ? withheld('conditional-tests') : model.selectorOf(filePath, null);
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
        if (!TAKES_MANY.has(runner.id) || cut < 0 || /['"\\]/.test(last)) {
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
    scriptRunners, nodeTestOptions, configWords, tableText,
};
