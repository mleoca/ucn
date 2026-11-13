'use strict';

/**
 * CLI flag parsing, written from the registry's parameter table.
 *
 * Which flags set a parameter, which of them take a value, and the type and
 * bounds of a value are the table's. A parameter the table gains is parsed
 * here without a change to this file. Flags of the CLI process itself
 * (--json, --no-cache, --workers and the like) are not parameters of a
 * command and stay with the CLI entry point.
 */

const {
    PARAMS,
    cliSpellings,
    paramRangeError,
} = require('../core/registry');

/** A flag whose value the table refuses. Not a UCN error: reported before any index is built. */
class FlagValidationError extends Error {
    constructor(msg) { super(msg); this.name = 'FlagValidationError'; }
}

/**
 * The value written for a value flag, or undefined when the flag is absent:
 * `--flag=value` first, else `--flag value` when the next token is not a
 * flag. `{ missing: true }` when the flag is written with no value.
 */
function writtenValue(tokens, flag) {
    const prefix = `${flag}=`;
    const equals = tokens.find(token => token.startsWith(prefix));
    if (equals !== undefined) return equals.slice(prefix.length);
    const at = tokens.indexOf(flag);
    if (at === -1) return undefined;
    if (at + 1 < tokens.length && !tokens[at + 1].startsWith('-')) return tokens[at + 1];
    return { missing: true };
}

/** Every value of a repeatable flag, comma-separated values split: the `=` forms first, then the spaced ones. */
function repeatedValues(tokens, flags) {
    const values = [];
    for (const token of tokens) {
        for (const flag of flags) {
            if (token.startsWith(`${flag}=`)) values.push(...token.slice(flag.length + 1).split(','));
        }
    }
    for (const flag of flags) {
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === flag && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
                values.push(...tokens[i + 1].split(','));
            }
        }
    }
    return values;
}

/**
 * A boolean parameter as the tokens set it, or undefined. A negative
 * spelling wins over an affirmative one. An explicit value describes the
 * written spelling: `--no-flag=false` enables the parameter.
 */
function writtenBoolean(tokens, spellings, problems) {
    let value;
    for (const [flags, enabled] of [[spellings.on, true], [spellings.off, false]]) {
        for (const flag of flags) {
            if (tokens.includes(flag)) value = enabled;
            // Validate every occurrence, including a malformed repeat.
            for (const token of tokens.filter(token => token.startsWith(`${flag}=`))) {
                const written = token.slice(flag.length + 1);
                if (written === 'true') value = enabled;
                else if (written === 'false') value = !enabled;
                else problems.push(`Invalid ${flag} value: must be true or false (got "${written}")`);
            }
        }
    }
    return value;
}

/** CLI process controls use the same boolean syntax as command parameters. */
function parseProcessFlags(tokens) {
    const flags = {};
    const problems = [];
    const spellings = {
        help: { on: ['--help', '-h'], off: [] },
        version: { on: ['--version', '-v'], off: [] },
        mcp: { on: ['--mcp'], off: [] },
        json: { on: ['--json'], off: [] },
        quiet: { on: ['--quiet'], off: ['--verbose', '--no-quiet'] },
        cache: { on: [], off: ['--no-cache'] },
        clearCache: { on: ['--clear-cache'], off: [] },
        interactive: { on: ['--interactive', '-i'], off: [] },
    };
    for (const [name, names] of Object.entries(spellings)) {
        const value = writtenBoolean(tokens, names, problems);
        if (value !== undefined) flags[name] = value;
    }
    Object.defineProperty(flags, 'problems', { value: problems, enumerable: false });
    return flags;
}

/**
 * Parse the flags that set a parameter. The result holds one key per
 * parameter the tokens set, with a value of the table's type; a parameter
 * that is not written has no key. Values the table refuses are collected,
 * not thrown: `validateFlags` raises the first, after the caller has had
 * the chance to report an unknown flag.
 */
function parseFlags(tokens) {
    const flags = {};
    const problems = [];
    for (const [param, spec] of Object.entries(PARAMS)) {
        const spellings = cliSpellings(param);
        if (spec.type === 'boolean') {
            const value = writtenBoolean(tokens, spellings, problems);
            if (value !== undefined) flags[param] = value;
            continue;
        }
        if (spec.repeat) {
            const values = repeatedValues(tokens, spellings.value);
            if (values.length > 0) flags[param] = values;
            for (const flag of spellings.value) {
                const bare = tokens.some((token, i) => token === flag &&
                    !(i + 1 < tokens.length && !tokens[i + 1].startsWith('-')));
                if (bare) problems.push(`${flag} requires a value.`);
            }
            continue;
        }
        for (const flag of spellings.value) {
            const written = writtenValue(tokens, flag);
            if (written === undefined) continue;
            if (written.missing) {
                problems.push(`${flag} requires a value.`);
                break;
            }
            if (spec.type === 'integer' || spec.type === 'number') {
                const problem = numberProblem(param, spec, written, flag);
                if (problem) problems.push(problem);
                else flags[param] = Number(written.trim());
            } else {
                flags[param] = written;
            }
            break;
        }
    }
    Object.defineProperty(flags, 'problems', { value: problems, enumerable: false });
    return flags;
}

/**
 * Why a written number is not one the table takes, or null. Integers use the
 * canonical base-10 spelling: Number() also reads exponent, decimal and
 * hexadecimal forms (`1e1`, `2.5`, `0x10`), and a malformed line pin must
 * not select a real definition by accident.
 */
function numberProblem(param, spec, written, flag) {
    if (spec.type === 'integer' && !/^\d+$/.test(written.trim())) {
        const label = spec.min === 0 ? 'non-negative integer' : 'positive integer';
        return `Invalid ${flag} value: must be a ${label} (got "${written}")`;
    }
    return paramRangeError(param, spec.type === 'integer' ? Number(written.trim()) : written, flag);
}

/** Raise the first value the table refused. */
function validateFlags(flags) {
    if (flags.problems && flags.problems.length > 0) throw new FlagValidationError(flags.problems[0]);
}

/**
 * A non-negative integer of a process flag (`--workers`), or undefined when
 * the flag is absent.
 */
function processInteger(tokens, flag, { max = 10000000 } = {}) {
    const written = writtenValue(tokens, flag);
    if (written === undefined) return undefined;
    if (written.missing) throw new FlagValidationError(`${flag} requires a value.`);
    if (!/^\d+$/.test(written.trim())) {
        throw new FlagValidationError(`Invalid ${flag} value: must be a non-negative integer (got "${written}")`);
    }
    const n = Number(written.trim());
    if (n > max) throw new FlagValidationError(`Invalid ${flag} value: ${n} exceeds maximum (${max})`);
    return n;
}

module.exports = { FlagValidationError, parseFlags, parseProcessFlags, validateFlags, processInteger };
