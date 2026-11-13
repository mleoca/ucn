'use strict';

// One parameter table (core/registry.js PARAMS) is what every surface says
// about a parameter and what the engine does with it. These tests hold the
// three together: the MCP schema and the CLI parser are the table, the
// engine takes exactly the table's values, and a stated default is the
// answer an omitted parameter gives.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const registry = require('../core/registry');
const {
    PARAMS, FLAG_APPLICABILITY, CANONICAL_COMMANDS, GLOBAL_PARAMS, BOOLEAN_PARAMS,
    paramValues, paramDefault, paramFact, paramRange, paramTableError, paramSchemaEnum,
    describeParam, mcpParamProperties, normalizeParams, cliSpellings, cliFlagsForParam,
    getCliValueFlags, getCliAcceptedFlags, generateCliParamReference, toSnakeCase, toMcpName,
    commandMode,
} = registry;
const { execute } = require('../core/execute');
const { formatPublicText, formatPublicJson } = require('../core/output');
const { buildPublicParams } = require('../core/public-command');
const { applyOutputBudget } = require('../core/output-budget');
const { projectDiscoveryOptions } = require('../core/discovery');
const { parseFlags, validateFlags, FlagValidationError } = require('../cli/flags');
const { validateToolArguments } = require('../mcp/stdio-server');
const { tmp, rm, idx, McpClient } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.js');
const MODES = ['lines', 'deep', 'entrypoints', 'structural'];
const params = Object.keys(PARAMS);
const numeric = params.filter(param => ['integer', 'number'].includes(PARAMS[param].type));
const commandsTaking = param => CANONICAL_COMMANDS.filter(command =>
    PARAMS[param].global || FLAG_APPLICABILITY[command].includes(param));

/** The params that put `command` into `mode`. */
function modeParams(command, mode) {
    if (!mode) return {};
    if (mode === 'lines') return { lines: true };
    if (mode === 'deep') return { deep: true };
    if (mode === 'entrypoints') return { direction: 'callers', to: 'entrypoints' };
    if (mode === 'structural') return { type: 'function' };
    throw new Error(`no params for mode ${mode}`);
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe('parameter table: shape', () => {
    it('declares every parameter a command accepts, and none that no command does', () => {
        for (const [command, accepted] of Object.entries(FLAG_APPLICABILITY)) {
            for (const param of accepted) assert.ok(PARAMS[param], `${command} accepts ${param}, which the table lacks`);
            for (const param of GLOBAL_PARAMS) {
                assert.ok(!accepted.includes(param), `${param} is global: ${command} need not list it`);
            }
        }
        for (const param of params) {
            assert.ok(commandsTaking(param).length > 0, `${param} is accepted by no command`);
        }
    });

    it('gives each parameter a type, each number its bounds, and keys that name a command or a mode', () => {
        const keyOk = key => {
            if (key === '*') return true;
            const [command, mode, extra] = key.split(':');
            return CANONICAL_COMMANDS.includes(command) && extra === undefined &&
                (mode === undefined || MODES.includes(mode));
        };
        for (const [param, spec] of Object.entries(PARAMS)) {
            assert.ok(['string', 'boolean', 'integer', 'number'].includes(spec.type), `${param} type`);
            assert.equal(typeof spec.text, 'string', `${param} text`);
            if (numeric.includes(param)) {
                assert.ok(Number.isFinite(spec.min) && Number.isFinite(spec.max) && spec.min <= spec.max, `${param} bounds`);
            } else {
                assert.ok(spec.min === undefined && spec.max === undefined, `${param} has bounds but is no number`);
            }
            if (spec.values && !Array.isArray(spec.values) && typeof spec.values !== 'function') {
                for (const key of Object.keys(spec.values)) {
                    assert.ok(keyOk(key), `${param} values key ${key}`);
                    const [command] = key.split(':');
                    assert.ok(key === '*' || commandsTaking(param).includes(command), `${param} values for ${command}, which does not take it`);
                }
            }
            for (const key of Object.keys(spec.defaults || {})) {
                assert.ok(keyOk(key), `${param} defaults key ${key}`);
                const [command] = key.split(':');
                assert.ok(key === '*' || commandsTaking(param).includes(command), `${param} default for ${command}, which does not take it`);
            }
            for (const example of spec.examples || []) {
                for (const command of commandsTaking(param)) {
                    const allowed = paramValues(param, command);
                    if (allowed) assert.ok(allowed.includes(example), `${param} example ${example} is not a ${command} value`);
                }
            }
        }
    });

    it('a default of a closed set is one of its values, and of a number within its bounds', () => {
        for (const [param, spec] of Object.entries(PARAMS)) {
            for (const [key, value] of Object.entries(spec.defaults || {})) {
                const [command, mode] = key.split(':');
                if (numeric.includes(param)) {
                    assert.ok(value >= spec.min && value <= spec.max, `${param} default ${value} for ${key}`);
                }
                const allowed = key === '*' ? null : paramValues(param, command, mode || null);
                if (!allowed) continue;
                for (const part of [].concat(value)) {
                    assert.ok(allowed.includes(part), `${param} default ${part} for ${key} is not one of its values`);
                }
            }
        }
    });

    it('a description states no number and no value of its own: the table fills them in', () => {
        for (const [param, spec] of Object.entries(PARAMS)) {
            // What the author typed, without quoted samples and placeholders.
            const typed = spec.text.replace(/"[^"]*"/g, '').replace(/\{[^}]*\}/g, '');
            assert.doesNotMatch(typed, /(?<![\w-])\d+(?![\w-])/, `${param}: a number typed into the description`);
            if (!spec.values) continue;
            const own = new Set();
            for (const command of ['*', ...commandsTaking(param)]) {
                for (const mode of [null, ...MODES]) {
                    for (const value of paramValues(param, command, mode) || []) own.add(value);
                }
            }
            for (const value of own) {
                const word = new RegExp(`(?<![\\w/-])${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\w/-])`);
                assert.doesNotMatch(typed, word, `${param}: the value ${value} typed into the description`);
            }
            const filled = describeParam(param);
            if (spec.examples) continue;
            for (const value of own) assert.ok(filled.includes(value), `${param}: the description omits ${value}`);
        }
        for (const [param, spec] of Object.entries(PARAMS)) {
            const filled = describeParam(param);
            assert.doesNotMatch(filled, /\{[a-zA-Z:]+\}|undefined|null/, `${param}: ${filled}`);
            for (const value of Object.values(spec.defaults || {})) {
                assert.ok(filled.includes([].concat(value).join(',')), `${param}: the description omits the default ${value}`);
            }
        }
    });

    it('enumerates all seventeen structural kinds for type, and every kind find takes is one of them', () => {
        const search = paramValues('type', 'search');
        assert.equal(search.length, 17);
        assert.equal(new Set(search).size, 17);
        for (const kind of paramValues('type', 'find')) assert.ok(search.includes(kind), kind);
        assert.ok(!paramValues('type', 'find').includes('call'), 'a call site is not a definition');
        const schemaEnum = mcpParamProperties().type.enum;
        for (const kind of search) assert.ok(schemaEnum.includes(kind), `the schema omits ${kind}`);
        for (const kind of paramValues('type', 'entrypoints')) assert.ok(schemaEnum.includes(kind), `the schema omits ${kind}`);
    });
});

// ---------------------------------------------------------------------------
// MCP schema and CLI parser are the table
// ---------------------------------------------------------------------------

describe('parameter table: the MCP schema is the table', () => {
    let client;
    let tool;
    before(async () => {
        client = new McpClient();
        await client.start();
        await client.initialize();
        tool = (await client.send('tools/list', {})).result.tools[0];
    });
    after(() => { if (client) client.stop(); });

    it('publishes exactly the generated properties beside its two transport fields', () => {
        const { command, project_dir: projectDir, ...published } = tool.inputSchema.properties;
        assert.ok(command && projectDir);
        assert.deepEqual(JSON.parse(JSON.stringify(published)), JSON.parse(JSON.stringify(mcpParamProperties())));
        assert.deepEqual(Object.keys(published), params.map(toSnakeCase));
    });

    it('states a type, bounds and an enumeration for each parameter as the table has them', () => {
        const published = tool.inputSchema.properties;
        for (const [param, spec] of Object.entries(PARAMS)) {
            const rule = published[toSnakeCase(param)];
            assert.equal(rule.type, spec.type, param);
            assert.equal(rule.description, describeParam(param), param);
            if (numeric.includes(param)) {
                const least = rule.exclusiveMinimum !== undefined ? rule.exclusiveMinimum + 1 : rule.minimum;
                assert.equal(least, spec.min, `${param} minimum`);
                assert.equal(rule.maximum, spec.max, `${param} maximum`);
            }
            assert.deepEqual(rule.enum || null, paramSchemaEnum(param), `${param} enum`);
        }
    });

    it('names the always-accepted parameters and the sections from the table in the tool description', () => {
        for (const param of GLOBAL_PARAMS) assert.ok(tool.description.includes(toSnakeCase(param)), param);
        assert.ok(tool.description.includes(`sections=${paramValues('sections', 'show').join(',')}`));
        assert.ok(tool.description.includes(`sections=${paramValues('sections', 'repo').join(',')}`));
    });

    it('refuses over the wire what the table refuses, with the table\'s own values', async () => {
        const dir = tmp({ 'package.json': '{}', 'a.js': 'function f() { return 1; }\nfunction g() { return f(); }\n' });
        try {
            const call = args => client.callTool({ project_dir: dir, ...args });
            const over = await call({ command: 'show', name: 'f', top: paramRange('top').max + 1 });
            assert.equal(over.isError, true);
            assert.match(over.text, new RegExp(`top must be less than or equal to ${paramRange('top').max}`));
            const kind = await call({ command: 'find', name: 'f', type: 'call' });
            assert.equal(kind.isError, true);
            assert.ok(kind.text.includes(`Invalid find type "call". Valid: ${paramValues('type', 'find').join(', ')}.`), kind.text);
            const unknown = await call({ command: 'search', type: 'bogus' });
            assert.equal(unknown.isError, true);
            assert.ok(unknown.text.includes(`type must be one of: ${paramSchemaEnum('type').join(', ')}.`), unknown.text);
            for (const kind of paramValues('type', 'search')) {
                const listed = await call({ command: 'search', type: kind });
                assert.equal(listed.isError, false, `${kind}: ${listed.text}`);
            }
        } finally { rm(dir); }
    });
});

describe('parameter table: the CLI parser is the table', () => {
    it('gives every parameter its flag spellings, and no flag to two parameters', () => {
        const owner = new Map();
        for (const param of params) {
            const spec = PARAMS[param];
            const spellings = cliSpellings(param);
            const flags = cliFlagsForParam(param);
            if (spec.type === 'boolean') {
                assert.ok(Array.isArray(spellings.on) && Array.isArray(spellings.off), param);
                assert.ok(flags.length > 0, `${param} cannot be set from the CLI`);
            } else {
                assert.ok(Array.isArray(spellings.value), param);
                // `name` and `term` are the positional argument.
                if (flags.length === 0) assert.ok(['name', 'term'].includes(param), `${param} cannot be set from the CLI`);
            }
            for (const flag of flags) {
                assert.match(flag, /^--[a-z][a-z-]*$/, flag);
                assert.equal(owner.get(flag), undefined, `${flag} sets both ${owner.get(flag)} and ${param}`);
                owner.set(flag, param);
            }
        }
        const accepted = getCliAcceptedFlags();
        for (const flag of owner.keys()) assert.ok(accepted.has(flag), `${flag} is not an accepted flag`);
        for (const flag of getCliValueFlags()) assert.ok(accepted.has(flag), `${flag} is not an accepted flag`);
    });

    it('reads a boolean from each spelling, with explicit true and false', () => {
        for (const param of BOOLEAN_PARAMS) {
            const { on, off } = cliSpellings(param);
            for (const flag of on) {
                assert.equal(parseFlags([flag])[param], true, flag);
                assert.equal(parseFlags([`${flag}=true`])[param], true, `${flag}=true`);
                assert.equal(parseFlags([`${flag}=false`])[param], false, `${flag}=false`);
                const bad = parseFlags([`${flag}=maybe`]);
                assert.equal(bad[param], undefined);
                assert.throws(() => validateFlags(bad), FlagValidationError, `${flag}=maybe`);
            }
            for (const flag of off) {
                assert.equal(parseFlags([flag])[param], false, flag);
                for (const yes of on) assert.equal(parseFlags([yes, flag])[param], false, `${yes} ${flag}`);
            }
            assert.equal(Object.hasOwn(parseFlags([]), param), false, `${param} appears when not written`);
        }
    });

    it('reads a value from --flag=value and --flag value, typed as the table says', () => {
        const sample = param => {
            const spec = PARAMS[param];
            if (spec.type === 'integer') return String(spec.min + 1);
            if (spec.type === 'number') return '0.5';
            return 'sample';
        };
        for (const param of params.filter(name => PARAMS[name].type !== 'boolean')) {
            const spec = PARAMS[param];
            for (const flag of cliSpellings(param).value) {
                for (const tokens of [[`${flag}=${sample(param)}`], [flag, sample(param)]]) {
                    const flags = parseFlags(tokens);
                    validateFlags(flags);
                    const expected = spec.repeat ? [sample(param)]
                        : numeric.includes(param) ? Number(sample(param)) : sample(param);
                    assert.deepEqual(flags[param], expected, tokens.join(' '));
                    assert.deepEqual(Object.keys(flags), [param], tokens.join(' '));
                }
                // Written without a value: refused, not ignored.
                const bare = parseFlags([flag]);
                assert.throws(() => validateFlags(bare), /requires a value/, flag);
            }
        }
        assert.deepEqual(parseFlags(['--exclude=a,b', '--not', 'c']).exclude, ['a', 'b', 'c']);
        assert.equal(parseFlags(['--default', 'x']).defaultValue, 'x');
        assert.deepEqual({ ...parseFlags([]) }, {});
    });

    it('takes the same flags as values in one-shot and interactive mode', () => {
        const source = fs.readFileSync(CLI, 'utf8');
        assert.match(source, /const VALUE_FLAGS = getCliValueFlags\(\);/);
        assert.match(source, /const valueFlagNames = VALUE_FLAGS;/);
        for (const param of params.filter(name => PARAMS[name].type !== 'boolean')) {
            for (const flag of cliSpellings(param).value) assert.ok(getCliValueFlags().has(flag), flag);
        }
        for (const param of BOOLEAN_PARAMS) {
            for (const flag of cliFlagsForParam(param)) assert.ok(!getCliValueFlags().has(flag), flag);
        }
    });

    it('prints the value lists, bounds and defaults of the table in --help', () => {
        const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
        assert.ok(help.includes(generateCliParamReference()), 'the generated reference is part of the help');
        for (const [param, spec] of Object.entries(PARAMS)) {
            if (spec.examples) continue;
            for (const command of ['*', ...commandsTaking(param)]) {
                for (const mode of [null, ...MODES]) {
                    for (const value of paramValues(param, command, mode) || []) {
                        assert.ok(help.includes(value), `--help omits the ${param} value ${value}`);
                    }
                }
            }
            for (const value of Object.values(spec.defaults || {})) {
                assert.ok(help.includes([].concat(value).join(',')), `--help omits the ${param} default ${value}`);
            }
            if (numeric.includes(param) && spec.max < Number.MAX_SAFE_INTEGER) {
                assert.ok(help.includes(`${spec.min} to ${spec.max}`), `--help omits the bounds of ${param}`);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// One request, three spellings
// ---------------------------------------------------------------------------

describe('parameter table: the CLI, MCP and the engine read one request alike', () => {
    // A sample for every free-form string; a parameter without one fails the test.
    const SAMPLES = {
        name: 'target', term: 'needle', file: 'src/a.js', in: 'src', exclude: 'vendor,dist',
        addParam: 'extra', removeParam: 'a', renameTo: 'renamed', defaultValue: '0',
        stack: 'at target (src/a.js:1:1)', range: '1-2', base: 'HEAD~1', className: 'Box',
        param: 'ctx', receiver: 'db', returns: 'Promise', decorator: 'Route', prefix: '/api',
        framework: 'express',
    };
    const samplesOf = (param, command) => {
        const spec = PARAMS[param];
        if (spec.type === 'boolean') return [true, false];
        if (spec.type === 'integer') return [spec.min, Math.min(spec.max, spec.min + 7)];
        if (spec.type === 'number') return [spec.min, 0.5, spec.max];
        const allowed = paramValues(param, command);
        if (allowed && !spec.examples) return spec.list ? [allowed[0], allowed.slice(0, 2).join(',')] : [...allowed];
        assert.ok(Object.hasOwn(SAMPLES, param), `${param} is a free-form string without a sample in this test`);
        return [SAMPLES[param]];
    };
    const cliTokens = (param, value) => {
        const spec = PARAMS[param];
        const spellings = cliSpellings(param);
        if (spec.type === 'boolean') {
            if (value) return spellings.on.length > 0 ? [spellings.on[0]] : null;
            return spellings.off.length > 0 ? [spellings.off[0]] : [`${spellings.on[0]}=false`];
        }
        return spellings.value.length > 0 ? [`${spellings.value[0]}=${value}`] : null;
    };

    it('builds the same engine parameters from flags and from MCP arguments, for every command and parameter', () => {
        let compared = 0;
        for (const command of CANONICAL_COMMANDS) {
            for (const param of FLAG_APPLICABILITY[command]) {
                for (const value of samplesOf(param, command)) {
                    const tokens = cliTokens(param, value);
                    const positional = tokens === null;
                    const flags = parseFlags(tokens || []);
                    validateFlags(flags);
                    const fromCli = buildPublicParams(command, positional ? String(value) : undefined, { ...flags });
                    const fromMcp = normalizeParams({ [toSnakeCase(param)]: value });
                    // exclude is a list on the CLI and one string over MCP.
                    if (Array.isArray(fromCli.exclude)) fromCli.exclude = fromCli.exclude.join(',');
                    // A positional argument is the subject of the command.
                    const subject = { search: 'term', deps: 'file', api: 'file', stacktrace: 'stack' }[command] || 'name';
                    if (positional) assert.equal(fromCli[subject], String(value), `${command} ${param}`);
                    assert.deepEqual(fromCli, fromMcp, `${command} ${param}=${value}`);
                    assert.equal(paramTableError(command, fromCli), paramTableError(command, fromMcp), `${command} ${param}=${value}`);
                    compared++;
                }
            }
        }
        assert.ok(compared > 300, `${compared} comparisons`);
    });

    it('draws the bounds of a number in one place for the CLI, the schema and the engine', () => {
        const schema = { type: 'object', properties: mcpParamProperties() };
        for (const param of numeric) {
            const spec = PARAMS[param];
            const command = commandsTaking(param)[0];
            const flag = cliSpellings(param).value[0];
            const cases = [[spec.min, true], [spec.max, true], [spec.max + 1, false]];
            if (spec.type === 'integer') cases.push([spec.min - 1, false]);
            else cases.push([spec.min - 0.5, false], [spec.max + 0.5, false]);
            for (const [value, accepted] of cases) {
                if (!Number.isSafeInteger(value) && spec.type === 'integer') continue;
                const label = `${param}=${value}`;
                // A negative number is spelled with `=`: `--top -1` is a flag.
                const cli = parseFlags([`${flag}=${value}`]);
                assert.equal(cli.problems.length === 0, accepted, `CLI ${label}: ${cli.problems.join(' ')}`);
                assert.equal(validateToolArguments({ [toSnakeCase(param)]: value }, schema) === null, accepted, `MCP ${label}`);
                assert.equal(paramTableError(command, { [param]: value }) === null, accepted, `engine ${label}`);
            }
            for (const junk of ['abc', '', '1e2', '0x10', '2.5x']) {
                assert.ok(parseFlags([`${flag}=${junk}`]).problems.length > 0, `CLI ${param}=${junk}`);
            }
            if (spec.type === 'integer') {
                assert.ok(parseFlags([`${flag}=2.5`]).problems.length > 0, `CLI ${param}=2.5`);
                assert.notEqual(validateToolArguments({ [toSnakeCase(param)]: 2.5 }, schema), null, `MCP ${param}=2.5`);
            }
        }
    });

    it('accepts each value of a closed set on every surface and refuses a stranger with the list', () => {
        const schema = { type: 'object', properties: mcpParamProperties() };
        for (const [param, spec] of Object.entries(PARAMS)) {
            if (!spec.values) continue;
            for (const command of commandsTaking(param)) {
                for (const mode of [null, ...MODES]) {
                    const allowed = paramValues(param, command, mode);
                    if (!allowed) continue;
                    const base = modeParams(command, mode);
                    if (mode && commandMode(command, base) !== mode) continue;
                    if (mode && !Object.keys(typeof spec.values === 'object' ? spec.values : {}).includes(`${command}:${mode}`)) continue;
                    for (const value of allowed) {
                        const written = spec.fold === 'upper' ? value.toLowerCase() : spec.fold === 'lower' ? value.toUpperCase() : value;
                        for (const spelling of spec.fold ? [value, written] : [value]) {
                            assert.equal(paramTableError(command, { ...base, [param]: spelling }), null, `${command} ${param}=${spelling}`);
                            assert.equal(validateToolArguments({ [toSnakeCase(param)]: spelling }, schema), null, `MCP ${param}=${spelling}`);
                        }
                    }
                    const refusal = paramTableError(command, { ...base, [param]: 'zz-stranger' });
                    assert.ok(refusal && refusal.includes('"zz-stranger"') && refusal.endsWith(`Valid: ${allowed.join(', ')}.`),
                        `${command} ${param}: ${refusal}`);
                    if (spec.list) {
                        assert.equal(paramTableError(command, { ...base, [param]: allowed.join(',') }), null, `${command} ${param} list`);
                        assert.match(paramTableError(command, { ...base, [param]: `${allowed[0]},zz-stranger` }), /"zz-stranger"/);
                        assert.match(paramTableError(command, { ...base, [param]: ' , ' }), /^No /);
                    }
                }
            }
        }
        // A value of another command's set is refused by the engine, with this command's list.
        assert.match(paramTableError('trace', { direction: 'imports' }), /Invalid trace direction "imports"\. Valid: callees, callers\./);
        assert.match(paramTableError('deps', { direction: 'callers' }), /Invalid deps direction "callers"\. Valid: imports, importers, both\./);
        assert.match(paramTableError('show', { lines: true, sections: 'source' }), /Invalid show lines sections "source"\. Valid: callers, callees\./);
        // A parameter the command does not take is not this check's matter.
        assert.equal(paramTableError('show', { direction: 'sideways' }), null);
    });
});

// ---------------------------------------------------------------------------
// The engine does what the table says
// ---------------------------------------------------------------------------

describe('parameter table: the engine takes the table\'s values and applies its defaults', () => {
    let dir;
    let index;
    const COUNT = 510;
    const pad = n => String(n).padStart(3, '0');

    before(() => {
        const files = {
            'package.json': JSON.stringify({ name: 'table', version: '1.0.0', dependencies: { express: '4', axios: '1' } }),
            // A call chain nine deep and an import chain six deep.
            'src/chain.js': Array.from({ length: 9 }, (_, i) =>
                `function c${i}() { ${i < 8 ? `return c${i + 1}();` : 'return 1;'} }`).join('\n') +
                `\nmodule.exports = { ${Array.from({ length: 9 }, (_, i) => `c${i}`).join(', ')} };\n`,
            'src/target.js': 'function target(a) { return a; }\nfunction wrapper() { return target(1); }\nmodule.exports = { target, wrapper };\n',
            'src/callers.js': "const { target } = require('./target');\n" +
                Array.from({ length: 25 }, (_, i) => `function caller${pad(i)}() { return target(${i}); }`).join('\n') +
                `\nmodule.exports = { ${Array.from({ length: 25 }, (_, i) => `caller${pad(i)}`).join(', ')} };\n`,
            // Fifteen calls no evidence ties to Box.spin: an unverified list longer than its default.
            'src/box.js': 'class Box { spin() { return 1; } }\nclass Wheel { spin() { return 2; } }\nmodule.exports = { Box, Wheel };\n',
            'src/spinners.js': Array.from({ length: 15 }, (_, i) => `function spin${pad(i)}(thing) { return thing.spin(); }`).join('\n') + '\n',
            'src/server.js': "const express = require('express');\nconst app = express();\napp.get('/api/users', (req, res) => res.json([]));\napp.post('/api/users', (req, res) => res.json({}));\nmodule.exports = app;\n",
            'src/client.js': "const axios = require('axios');\nasync function loadUsers() { return axios.get('/api/users'); }\nmodule.exports = { loadUsers };\n",
            'py/app.py': "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/py/items', methods=['GET'])\ndef items():\n    return []\n",
            'py/aio.py': "from aiohttp import web\nroutes = web.RouteTableDef()\n\n@routes.get('/aio/ping')\nasync def ping(request):\n    return web.Response(text='pong')\n\napp = web.Application()\napp.add_routes(routes)\n",
            'py/cli.py': 'import click\n\n@click.command()\ndef main():\n    pass\n',
            'src/shape.ts': 'export interface Shape { area(): number }\nexport enum Color { Red, Blue }\nexport class Square implements Shape { constructor(private s: number) {} area(): number { return this.s * this.s; } }\nexport type Id = string;\nexport namespace Geo { export const PI = 3; }\n',
            'test/target.test.js': "const { target, wrapper } = require('../src/target');\ntest('target', () => { expect(target(1)).toBe(1); });\ntest('wrapper', () => { expect(wrapper()).toBe(1); });\n",
        };
        for (let i = 0; i < 6; i++) {
            files[`src/dep${i}.js`] = `${i < 5 ? `const next = require('./dep${i + 1}');\n` : ''}function depFn${i}() { return ${i < 5 ? `next.depFn${i + 1}()` : '0'}; }\nmodule.exports = { depFn${i} };\n`;
        }
        // More files, definitions, exports, unused functions and matching lines than any default bound.
        for (let i = 0; i < COUNT; i++) {
            files[`many/m${pad(i)}.js`] = `// needle ${i}\nfunction bulk${pad(i)}() { return ${i}; }\nfunction idle${pad(i)}() { return ${i}; }\nmodule.exports = { bulk${pad(i)} };\n`;
        }
        dir = tmp(files);
        index = idx(dir);
    });
    after(() => { if (dir) rm(dir); });

    const answer = (command, p) => {
        const response = execute(index, command, { ...p });
        assert.equal(response.ok, true, `${command} ${JSON.stringify(p)}: ${response.error}`);
        return {
            text: formatPublicText(command, response.result, { ...p }, { ...response, surface: 'cli' }),
            json: formatPublicJson(command, response.result, { ...p }, { ...response, surface: 'cli' }),
        };
    };
    /**
     * Omitting `param` answers as its default does; `other` answers
     * differently. `textToo: false` where the text of an omitted parameter
     * has a display rule of its own.
     */
    const defaultIs = (command, base, param, value, other, { textToo = true } = {}) => {
        const label = `${command} ${JSON.stringify(base)} ${param}`;
        const omitted = answer(command, base);
        const explicit = answer(command, { ...base, [param]: value });
        if (textToo) assert.equal(explicit.text, omitted.text, `${label}: omitted is not ${JSON.stringify(value)}`);
        assert.equal(explicit.json, omitted.json, `${label}: omitted is not ${JSON.stringify(value)} (JSON)`);
        if (other !== undefined) {
            const different = answer(command, { ...base, [param]: other });
            assert.notEqual(textToo ? different.text : different.json, textToo ? omitted.text : omitted.json, `${label}: ${JSON.stringify(other)} answers as the default does, the fixture decides nothing`);
        }
    };

    // Every default the table states has a case here: a new default without one fails.
    const DEFAULT_CASES = {
        'depth trace': () => {
            defaultIs('trace', { name: 'c0' }, 'depth', paramDefault('depth', 'trace'), paramDefault('depth', 'trace') + 1);
            defaultIs('trace', { name: 'c8', direction: 'callers' }, 'depth', paramDefault('depth', 'trace'), paramDefault('depth', 'trace') + 1);
        },
        'depth trace:entrypoints': () => {
            const base = { name: 'c8', direction: 'callers', to: 'entrypoints' };
            defaultIs('trace', base, 'depth', paramDefault('depth', 'trace', 'entrypoints'), paramDefault('depth', 'trace', 'entrypoints') - 1);
            assert.notEqual(paramDefault('depth', 'trace', 'entrypoints'), paramDefault('depth', 'trace'));
        },
        'depth deps': () => defaultIs('deps', { file: 'src/dep0.js' }, 'depth', paramDefault('depth', 'deps'), paramDefault('depth', 'deps') + 1),
        'depth tests': () => defaultIs('tests', { name: 'target' }, 'depth', paramDefault('depth', 'tests'), paramDefault('depth', 'tests') + 1),
        // The result set is the default limit; the text details the first
        // few of it (the table's findDetail) until a limit is written.
        'limit find': () => {
            defaultIs('find', { name: 'bulk*' }, 'limit', paramDefault('limit', 'find'), paramDefault('limit', 'find') + 1, { textToo: false });
            const detailed = text => (text.match(/^many\/m\d+\.js:\d+:bulk\d+ /gm) || []).length;
            assert.equal(detailed(answer('find', { name: 'bulk*' }).text), paramFact('limit', 'findDetail'));
            assert.equal(detailed(answer('find', { name: 'bulk*', limit: 9 }).text), 9);
        },
        'limit search': () => defaultIs('search', { term: 'needle' }, 'limit', paramDefault('limit', 'search'), paramDefault('limit', 'search') + 1),
        'limit search:structural': () => defaultIs('search', { type: 'function' }, 'limit',
            paramDefault('limit', 'search', 'structural'), paramDefault('limit', 'search', 'structural') + 1),
        'limit api': () => defaultIs('api', {}, 'limit', paramDefault('limit', 'api'), paramDefault('limit', 'api') + 1),
        'limit repo': () => defaultIs('repo', { sections: 'files' }, 'limit', paramDefault('limit', 'repo'), paramDefault('limit', 'repo') + 1),
        'limit deadcode': () => defaultIs('deadcode', {}, 'limit', paramDefault('limit', 'deadcode'), paramDefault('limit', 'deadcode') + 1),
        'context *': () => {
            defaultIs('search', { term: 'needle 7' }, 'context', paramDefault('context'), paramDefault('context') + 1);
            defaultIs('usages', { name: 'target' }, 'context', paramDefault('context'), paramDefault('context') + 1);
        },
        'minConfidence *': () => defaultIs('show', { name: 'spin', className: 'Box' }, 'minConfidence', paramDefault('minConfidence')),
        'direction trace': () => defaultIs('trace', { name: 'c4' }, 'direction', paramDefault('direction', 'trace'), 'callers'),
        'direction deps': () => defaultIs('deps', { file: 'src/dep2.js' }, 'direction', paramDefault('direction', 'deps'), 'imports'),
        'sections show': () => defaultIs('show', { name: 'target' }, 'sections', paramDefault('sections', 'show').join(','), 'source'),
        'sections show:lines': () => defaultIs('show', { name: 'target', lines: true }, 'sections',
            paramDefault('sections', 'show', 'lines').join(','), 'callees'),
        'sections repo': () => defaultIs('repo', {}, 'sections', paramDefault('sections', 'repo').join(','), 'stats'),
        'sections repo:deep': () => defaultIs('repo', { deep: true }, 'sections', paramDefault('sections', 'repo', 'deep').join(','), 'summary'),
        'compact show': () => defaultIs('show', { name: 'target' }, 'compact', paramDefault('compact', 'show'), !paramDefault('compact', 'show')),
        'compact impact': () => defaultIs('impact', { name: 'target' }, 'compact', paramDefault('compact', 'impact')),
        'compact find': () => defaultIs('find', { name: 'target' }, 'compact', paramDefault('compact', 'find'), !paramDefault('compact', 'find')),
        'compact usages': () => defaultIs('usages', { name: 'target' }, 'compact', paramDefault('compact', 'usages'), !paramDefault('compact', 'usages')),
        'showConfidence *': () => defaultIs('show', { name: 'target' }, 'showConfidence', paramDefault('showConfidence'), !paramDefault('showConfidence')),
        'base *': () => {
            const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
                { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            git('init', '-q');
            git('add', '-A');
            git('commit', '-q', '-m', 'base');
            fs.appendFileSync(path.join(dir, 'src/target.js'), 'function added() { return target(2); }\n');
            const fresh = idx(dir);
            const diff = p => {
                const response = execute(fresh, 'impact', p);
                assert.equal(response.ok, true, response.error);
                return formatPublicText('impact', response.result, p, { ...response, surface: 'cli' });
            };
            assert.equal(diff({ base: paramDefault('base') }), diff({}));
            assert.ok(diff({}).includes(`(vs ${paramDefault('base')})`));
            fs.writeFileSync(path.join(dir, 'src/target.js'),
                fs.readFileSync(path.join(dir, 'src/target.js'), 'utf8').replace('function added() { return target(2); }\n', ''));
        },
        'maxFiles *': () => {
            assert.equal(projectDiscoveryOptions(dir, {}, {}).maxFiles, paramDefault('maxFiles'));
            assert.equal(projectDiscoveryOptions(dir, { maxFiles: 7 }, {}).maxFiles, 7);
            assert.ok(!index.truncated, 'the fixture is far below the default');
        },
        'maxChars *': () => {
            const long = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
            for (const command of CANONICAL_COMMANDS) {
                const budget = applyOutputBudget(long, { command, surface: 'cli' });
                assert.equal(budget.requestedLimit, paramDefault('maxChars', command), command);
                assert.ok(budget.text.length <= paramDefault('maxChars', command), command);
                assert.equal(applyOutputBudget(long, { command, surface: 'cli', maxChars: paramDefault('maxChars', command) }).text, budget.text, command);
                assert.equal(applyOutputBudget(long, { command, surface: 'cli', all: true }).requestedLimit, paramRange('maxChars').max, command);
            }
        },
        'followSymlinks *': () => {
            assert.equal(paramDefault('followSymlinks'), true);
            const flags = spawnSync(process.execPath, [CLI, dir, 'find', 'target'], { encoding: 'utf8' });
            const explicit = spawnSync(process.execPath, [CLI, dir, 'find', 'target', '--no-follow-symlinks'], { encoding: 'utf8' });
            assert.equal(flags.status, 0, flags.stderr);
            assert.equal(explicit.status, 0, explicit.stderr);
        },
    };

    it('has a case for every default the table states', () => {
        const stated = [];
        for (const [param, spec] of Object.entries(PARAMS)) {
            for (const key of Object.keys(spec.defaults || {})) {
                // The per-command output budgets are one case.
                stated.push(param === 'maxChars' ? 'maxChars *' : `${param} ${key}`);
            }
        }
        assert.deepEqual([...new Set(stated)].sort(), Object.keys(DEFAULT_CASES).sort());
    });

    for (const [name, check] of Object.entries(DEFAULT_CASES)) {
        it(`omitted is the stated default: ${name}`, check);
    }

    it('prints the stated number of rows where the description names one', () => {
        // Unverified rows of one list.
        const rows = text => text.split('\n').filter(line => /^\s+\[\d+\] src\/spinners\.js:/.test(line) || /^\s+src\/spinners\.js:\d+/.test(line)).length;
        const shown = answer('show', { name: 'spin', className: 'Box', sections: 'callers' }).text;
        assert.equal(rows(shown), paramFact('top', 'unverifiedRows'), shown);
        assert.equal(rows(answer('show', { name: 'spin', className: 'Box', sections: 'callers', top: 12 }).text), 12);
        assert.equal(rows(answer('show', { name: 'spin', className: 'Box', sections: 'callers', all: true }).text), 15);
        // Confirmed callers are complete without top.
        const callers = answer('show', { name: 'target', sections: 'callers' }).text;
        assert.equal(callers.split('\n').filter(line => /src\/callers\.js:\d+ \[caller\d+\]/.test(line)).length, 25);
        // Hot functions of repo stats.
        const hot = execute(index, 'repo', { sections: 'stats', hot: true });
        assert.equal(hot.ok, true, hot.error);
        assert.equal(hot.result.stats.hot.top, paramFact('top', 'hot'));
        assert.ok(hot.result.stats.hot.total > paramFact('top', 'hot'), 'the fixture has more hot functions than are listed');
        assert.equal(hot.result.stats.hot.items.length, paramFact('top', 'hot'));
    });

    it('accepts every kind and label it lists, in each command that takes it', () => {
        for (const kind of paramValues('type', 'search')) {
            const response = execute(index, 'search', { type: kind });
            assert.equal(response.ok, true, `search type=${kind}: ${response.error}`);
        }
        for (const kind of paramValues('type', 'find')) {
            const response = execute(index, 'find', { name: '*', type: kind });
            assert.equal(response.ok, true, `find type=${kind}: ${response.error}`);
        }
        for (const kind of paramValues('type', 'entrypoints')) {
            const response = execute(index, 'entrypoints', { type: kind });
            assert.equal(response.ok, true, `entrypoints type=${kind}: ${response.error}`);
        }
        for (const label of paramValues('framework', 'entrypoints')) {
            const response = execute(index, 'entrypoints', { framework: label });
            assert.equal(response.ok, true, `entrypoints framework=${label}: ${response.error}`);
        }
        for (const verb of paramValues('method', 'endpoints')) {
            for (const spelling of [verb, verb.toLowerCase()]) {
                const response = execute(index, 'endpoints', { method: spelling });
                assert.equal(response.ok, true, `endpoints method=${spelling}: ${response.error}`);
            }
        }
        // The kinds and labels are those of the entry-point patterns themselves.
        const { FRAMEWORK_PATTERNS } = require('../core/entrypoints');
        assert.deepEqual([...paramValues('type', 'entrypoints')], [...new Set(FRAMEWORK_PATTERNS.map(p => p.type))].sort());
        assert.deepEqual([...paramValues('framework', 'entrypoints')],
            [...new Set(FRAMEWORK_PATTERNS.map(p => p.framework.toLowerCase()))].sort());
    });

    it('filters endpoints by every label an answer prints, and refuses a stranger with the known ones', () => {
        const { ENDPOINT_FRAMEWORKS } = require('../core/bridge');
        const all = execute(index, 'endpoints', {});
        assert.equal(all.ok, true, all.error);
        const printed = [...new Set([...all.result.routes, ...all.result.requests].map(row => row.framework))].sort();
        assert.ok(printed.includes('aiohttp') && printed.includes('express') && printed.includes('axios'), printed.join(' '));
        for (const label of printed) {
            const filtered = execute(index, 'endpoints', { framework: label });
            assert.equal(filtered.ok, true, `endpoints framework=${label}: ${filtered.error}`);
            const rows = [...filtered.result.routes, ...filtered.result.requests];
            assert.ok(rows.length > 0 && rows.every(row => row.framework === label), label);
            assert.ok(ENDPOINT_FRAMEWORKS.includes(label), `${label} is printed but not declared`);
        }
        for (const label of ENDPOINT_FRAMEWORKS) {
            assert.equal(execute(index, 'endpoints', { framework: label }).ok, true, label);
        }
        const refused = execute(index, 'endpoints', { framework: 'zz-stranger' });
        assert.equal(refused.ok, false);
        assert.ok(refused.error.endsWith(`Valid: ${ENDPOINT_FRAMEWORKS.join(', ')}.`), refused.error);
        // The declared labels cover the detector tables they are built from.
        for (const label of ['express', 'koa', 'fastify', 'hono', 'gin', 'chi', 'axios', 'requests', 'django', 'starlette', 'supertest']) {
            assert.ok(ENDPOINT_FRAMEWORKS.includes(label), label);
        }
    });

    it('refuses the same out-of-table value on the CLI and over MCP, before any answer', async () => {
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const cases = [
                [['trace', 'c0', '--direction=sideways'], { command: 'trace', name: 'c0', direction: 'sideways' }, /direction/],
                [['endpoints', '--method=FETCH'], { command: 'endpoints', method: 'FETCH' }, /Invalid endpoints method "FETCH"\. Valid: GET/],
                [['show', 'target', '--sections=nope'], { command: 'show', name: 'target', sections: 'nope' }, /Invalid show sections "nope"\. Valid: summary/],
                [['entrypoints', '--type=nope'], { command: 'entrypoints', type: 'nope' }, /type/],
                [['trace', 'c0', `--depth=${paramRange('depth').max + 1}`], { command: 'trace', name: 'c0', depth: paramRange('depth').max + 1 }, /depth/],
                [['search', 'needle', `--context=${paramRange('context').max + 1}`], { command: 'search', term: 'needle', context: paramRange('context').max + 1 }, /context/],
                [['find', 'bulk*', `--limit=${paramRange('limit').max + 1}`], { command: 'find', name: 'bulk*', limit: paramRange('limit').max + 1 }, /limit/],
            ];
            for (const [argv, args, pattern] of cases) {
                const cli = spawnSync(process.execPath, [CLI, dir, ...argv], { encoding: 'utf8' });
                assert.equal(cli.status, 2, `${argv.join(' ')}: ${cli.stdout}`);
                assert.equal(cli.stdout, '', argv.join(' '));
                assert.match(cli.stderr, pattern, argv.join(' '));
                const mcp = await client.callTool({ project_dir: dir, ...args });
                assert.equal(mcp.isError, true, JSON.stringify(args));
                assert.match(mcp.text, pattern, JSON.stringify(args));
            }
        } finally { client.stop(); }
    });

    it('says the same about a parameter that changes nothing here, on both surfaces', async () => {
        const { noOpNotes } = require('../core/public-command');
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            for (const [command, name] of [['impact', 'target'], ['trace', 'c0'], ['tests', 'target'], ['check', 'target'], ['show', 'target']]) {
                const notes = noOpNotes(command, { includeMethods: true });
                assert.equal(notes.length, 1, command);
                assert.deepEqual(noOpNotes(command, {}), [], command);
                const cli = spawnSync(process.execPath, [CLI, dir, command, name, '--include-methods'], { encoding: 'utf8' });
                assert.ok(cli.stderr.includes(`Note: ${registry.formatSurfaceMessage(notes[0], 'cli')}`), `${command}: ${cli.stderr}`);
                const mcp = await client.callTool({ command, project_dir: dir, name, include_methods: true });
                assert.ok(mcp.text.includes(`Note: ${registry.formatSurfaceMessage(notes[0], 'mcp')}`), `${command}: ${mcp.text.slice(-400)}`);
                assert.match(registry.formatSurfaceMessage(notes[0], 'mcp'), /^include_methods=true /);
            }
            assert.deepEqual(noOpNotes('find', { includeMethods: true }), []);
        } finally { client.stop(); }
    });

    it('cuts a line listing between rows under the MCP budget and counts the rest', async () => {
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const full = await client.callTool({ command: 'search', project_dir: dir, term: 'needle', lines: true, max_chars: paramRange('maxChars').max });
            assert.equal(full.isError, false, full.text);
            const rows = full.text.split('\n').filter(line => line && !line.startsWith('# '));
            assert.equal(rows.length, COUNT);
            const cut = await client.callTool({ command: 'search', project_dir: dir, term: 'needle', lines: true, max_chars: 2000 });
            assert.equal(cut.isError, false, cut.text);
            assert.ok(cut.text.length <= 2000, `${cut.text.length} chars`);
            const kept = cut.text.split('\n').filter(line => line && !line.startsWith('# '));
            assert.ok(kept.length > 0 && kept.length < rows.length);
            assert.deepEqual(kept, rows.slice(0, kept.length));
            assert.ok(cut.text.endsWith(`# truncated: ${rows.length - kept.length} of ${rows.length} rows omitted; raise max_chars or narrow the query`), cut.text.slice(-200));
            assert.doesNotMatch(cut.text, /OUTPUT TRUNCATED/);
            // A budget no row fits in still answers as a listing.
            const none = await client.callTool({ command: 'search', project_dir: dir, term: 'needle', lines: true, max_chars: 120 });
            assert.equal(none.isError, false, none.text);
            assert.ok(none.text.length <= 120, `${none.text.length} chars`);
            assert.ok(none.text.split('\n').every(line => line.startsWith('# ')), none.text);
            assert.ok(none.text.endsWith(`# truncated: ${rows.length} of ${rows.length} rows omitted; raise max_chars or narrow the query`), none.text);
            // A note about a dropped parameter is a comment line, not a row.
            const noted = await client.callTool({ command: 'search', project_dir: dir, term: 'needle 7', lines: true, depth: 2 });
            assert.equal(noted.isError, false, noted.text);
            assert.match(noted.text, /^# Note: depth ignored \(not applicable to search\)\.$/m);
            assert.ok(noted.text.split('\n').filter(Boolean).every(line => line.startsWith('# ') || /^[^:]+:\d+:/.test(line)), noted.text);
        } finally { client.stop(); }
    });
});

describe('parameter table: the documentation states the table\'s values', () => {
    const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
    const reference = read('.claude/skills/ucn/references/commands.md');
    const skill = read('.claude/skills/ucn/SKILL.md');
    const readme = read('README.md');
    const row = (text, start) => {
        const line = text.split('\n').find(candidate => candidate.startsWith(start));
        assert.ok(line, `no row starting ${start}`);
        return line;
    };
    const thousands = n => `${n / 1000}K`;

    it('lists every kind and verb a closed set takes', () => {
        for (const kind of paramValues('type', 'search')) assert.ok(row(reference, '| `search [term]`').includes(`\`${kind}\``), kind);
        for (const kind of paramValues('type', 'entrypoints')) assert.ok(row(reference, '| `entrypoints`').includes(`\`${kind}\``), kind);
        for (const value of paramValues('sections', 'show')) assert.ok(row(reference, '| `show <handle>`').includes(value), value);
        for (const value of paramValues('sections', 'repo')) assert.ok(row(reference, '| `repo`').includes(value), value);
        for (const value of [...paramValues('direction', 'trace'), ...paramValues('direction', 'deps')]) {
            assert.ok(row(reference, '| `--direction=<value>`').includes(`\`${value}\``), value);
        }
        assert.ok(row(reference, '| `trace <handle>`').includes(`--to=${paramValues('to', 'trace')[0]}`));
    });

    it('states the defaults and bounds the table has', () => {
        const limit = row(reference, '| `--limit=N`');
        assert.ok(limit.includes(`maximum of ${paramDefault('limit', 'find')} results`), limit);
        assert.ok(limit.includes(`defaults to ${paramDefault('limit', 'search', 'structural')}`), limit);
        for (const command of ['find', 'search', 'deadcode', 'api', 'repo']) {
            assert.equal(paramDefault('limit', command), paramDefault('limit', 'find'), command);
            assert.ok(limit.includes(`\`${command}\``), command);
        }
        const depth = row(reference, '| `--depth=N`');
        assert.ok(depth.includes(`${paramRange('depth').min} to ${paramRange('depth').max}`), depth);
        assert.ok(depth.includes(`\`trace\` ${paramDefault('depth', 'trace')}`), depth);
        assert.ok(depth.includes(`\`trace --to=entrypoints\` ${paramDefault('depth', 'trace', 'entrypoints')}`), depth);
        assert.ok(depth.includes(`\`deps\` ${paramDefault('depth', 'deps')}`), depth);
        assert.ok(depth.includes(`\`tests\` ${paramDefault('depth', 'tests')}`), depth);
        const trace = row(reference, '| `trace <handle>`');
        assert.ok(trace.includes(`(depth ${paramDefault('depth', 'trace')})`), trace);
        assert.ok(trace.includes(`(depth ${paramDefault('depth', 'trace', 'entrypoints')})`), trace);
        const budget = row(reference, '| `--max-chars=N`');
        assert.ok(budget.includes(`${thousands(paramDefault('maxChars', 'show'))} targeted`), budget);
        assert.ok(budget.includes(`${thousands(paramDefault('maxChars', 'repo'))} broad`), budget);
        assert.ok(budget.includes(`${thousands(paramRange('maxChars').max)} ceiling`), budget);
        assert.ok(row(reference, '| `--top=N`').includes(`${paramFact('top', 'unverifiedRows')} by default`));
        const find = row(reference, '| `find <name>`');
        assert.ok(find.includes(`top ${paramFact('limit', 'findDetail')} in detail`), find);
        assert.ok(find.includes(`up to ${paramDefault('limit', 'find')}`), find);
        const compact = row(reference, '| `--compact` / `--no-compact`');
        assert.ok(compact.includes('`show`/`impact` default compact') && paramDefault('compact', 'show') && paramDefault('compact', 'impact'));
        assert.ok(compact.includes('`usages` full') && !paramDefault('compact', 'usages'));
    });

    it('the skill and the README agree with them', () => {
        assert.ok(skill.includes(`Each unverified list prints ${paramFact('top', 'unverifiedRows')} rows`));
        const broad = CANONICAL_COMMANDS.filter(command => registry.BROAD_COMMANDS.has(command));
        const sentence = skill.split('\n').find(line => line.startsWith('Text output has a character budget'));
        assert.ok(sentence, 'the budget sentence');
        assert.ok(sentence.includes(`${thousands(paramDefault('maxChars', 'repo'))} for broad sweeps`), sentence);
        assert.ok(sentence.includes(`${thousands(paramDefault('maxChars', 'show'))} for every other command`), sentence);
        assert.ok(sentence.includes(`${thousands(paramRange('maxChars').max)} ceiling`), sentence);
        const named = sentence.slice(sentence.indexOf('('), sentence.indexOf(')')).match(/`([a-z-]+)`/g).map(name => name.slice(1, -1));
        assert.deepEqual([...named].sort(), broad.map(registry.toCliName).sort());
        for (const command of broad) assert.equal(paramDefault('maxChars', command), paramDefault('maxChars', 'repo'), command);
        assert.ok(readme.includes(`default to a maximum of ${paramDefault('limit', 'find')} results`));
        assert.ok(readme.includes(`the top ${paramFact('limit', 'findDetail')} in detail`));
        assert.ok(readme.includes('[CHANGELOG.md](CHANGELOG.md)'));
    });
});

describe('parameter table: line listing budget', () => {
    const { budgetLineListing } = require('../core/output/lines');
    const listing = (rows, comments = ['# ACCOUNT: all of it']) =>
        [...Array.from({ length: rows }, (_, i) => `a.js:${i + 1}:row ${i + 1}`), ...comments].join('\n');

    it('keeps whole leading rows and every comment line, and counts what it left out', () => {
        const text = listing(30);
        for (let limit = 60; limit < text.length; limit += 7) {
            const cut = budgetLineListing(text, limit, 'cli');
            if (!cut) continue;
            assert.ok(cut.text.length <= limit, `${cut.text.length} > ${limit}`);
            const lines = cut.text.split('\n');
            const kept = lines.filter(line => !line.startsWith('# '));
            assert.deepEqual(kept, text.split('\n').slice(0, kept.length));
            assert.equal(lines.at(-2), '# ACCOUNT: all of it');
            assert.equal(lines.at(-1), `# truncated: ${30 - kept.length} of 30 rows omitted; raise --max-chars or omit it`);
            assert.equal(cut.omitted, 30 - kept.length);
            // One more row would not fit.
            const more = [...text.split('\n').slice(0, kept.length + 1), '# ACCOUNT: all of it',
                `# truncated: ${30 - kept.length - 1} of 30 rows omitted; raise --max-chars or omit it`].join('\n');
            assert.ok(kept.length + 1 === 30 || more.length > limit, `a row that fits was left out at ${limit}`);
        }
    });

    it('declines when no row can be dropped or when not one row fits', () => {
        assert.equal(budgetLineListing('# only\n# comments', 5, 'cli'), null);
        assert.equal(budgetLineListing(listing(3), 20, 'cli'), null);
        assert.equal(budgetLineListing(listing(1), 10, 'cli'), null);
        assert.match(budgetLineListing(listing(40), 400, 'mcp').text, /raise max_chars or narrow the query$/);
    });

    it('answers with no row where the surface always has a budget: the count, then the comment lines that fit', () => {
        const none = budgetLineListing(listing(3), 90, 'mcp', { allowNoRows: true });
        assert.equal(none.text, '# ACCOUNT: all of it\n# truncated: 3 of 3 rows omitted; raise max_chars or narrow the query');
        assert.equal(none.omitted, 3);
        const tight = budgetLineListing(listing(3), 70, 'mcp', { allowNoRows: true });
        assert.equal(tight.text, '# truncated: 3 of 3 rows omitted; raise max_chars or narrow the query');
        assert.equal(budgetLineListing(listing(3), 20, 'mcp', { allowNoRows: true }), null);
    });
});
