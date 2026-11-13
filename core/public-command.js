'use strict';

const { CANONICAL_COMMANDS, GLOBAL_PARAMS } = require('./registry');

const NAME_COMMANDS = new Set(['show', 'find', 'usages', 'trace', 'tests', 'plan']);

function parseSourceTarget(arg, params) {
    const value = String(arg || '').trim();
    // `source <file> --range=N-M`: the positional is the file (fix #433). A
    // positional beside an explicit file stays a name, which the handler
    // refuses with the range.
    if (params.range) {
        if (!params.file && value) return { ...params, file: value, range: params.range };
        return { ...params, ...(value && { name: value }), range: params.range };
    }
    const twoPart = value.match(/^(.+?)\s+(\d+(?:-\d+)?)$/);
    if (twoPart) return { ...params, file: params.file || twoPart[1], range: twoPart[2] };
    // A single-colon file:range target is a line request. Stable symbol
    // handles with a name contain a second colon and stay symbol targets.
    const inline = value.match(/^([^:]+(?:\/[^:]*)?):(\d+(?:-\d+)?)$/);
    if (inline) return { ...params, file: params.file || inline[1], range: inline[2] };
    return { ...params, name: arg };
}

/** MCP and direct execute() params: with a range and no file, `name` is the
 * file (`source` with name=<file>, range="N-M"; fix #433). */
function sourceRangeTarget(params) {
    if (params.range == null || (params.file && String(params.file).trim()) ||
        typeof params.name !== 'string' || !params.name.trim()) return params;
    const { name, ...rest } = params;
    return { ...rest, file: name.trim() };
}

/** Build normalized execute() params from the shared CLI-style positional arg. */
function buildPublicParams(command, arg, params = {}) {
    const clean = { ...params };
    // Process flags and the build/transport parameters every command accepts
    // never belong in execute params: the surface applies them itself.
    for (const key of ['json', 'quiet', 'cache', 'clearCache', 'interactive', 'workers', '_fileFromFileMode',
        ...GLOBAL_PARAMS]) delete clean[key];

    return withoutUnset(subjectParams(command, arg, clean));
}

/** The params with the positional argument placed as the command's subject. */
function subjectParams(command, arg, clean) {
    if (NAME_COMMANDS.has(command)) return { ...clean, name: arg || clean.name };
    switch (command) {
        case 'search': return { ...clean, term: arg || clean.term };
        case 'source': return parseSourceTarget(arg || clean.name, clean);
        // fix #283: an EXPLICIT empty-string arg must reach the handler (which
        // rejects it) instead of silently selecting diff mode — `arg ? ...`
        // made `impact ""` indistinguishable from `impact`.
        case 'impact': return { ...clean, ...(arg != null ? { name: arg } : {}) };
        case 'deps': return { ...clean, file: arg || clean.file };
        case 'api': return { ...clean, file: arg || clean.file };
        case 'check': return { ...clean, ...(arg != null ? { name: arg } : {}) };
        case 'stacktrace': return { ...clean, stack: clean.stack || arg };
        default: return clean;
    }
}

/** A parameter that was not given has no key: the same object MCP arguments make. */
function withoutUnset(params) {
    for (const key of Object.keys(params)) {
        if (params[key] === undefined) delete params[key];
    }
    return params;
}

/**
 * What to say about a parameter a command accepts and that changes nothing,
 * or less than its name suggests, there. One text for every surface, in CLI
 * spelling: the surface renders it with formatSurfaceMessage.
 */
function noOpNotes(command, params = {}) {
    if (!params.includeMethods) return [];
    if (['impact', 'trace', 'tests', 'check'].includes(command)) {
        return [`--include-methods has no effect on '${command}' — method calls are always tiered by receiver evidence.`];
    }
    if (command === 'show') {
        return [`--include-methods on '${command}' affects only method-callee display for standalone-function targets — caller tiers are always evidence-based, and method targets analyze method calls by default.`];
    }
    return [];
}

function isPublicCommand(command) {
    return CANONICAL_COMMANDS.includes(command);
}

module.exports = { buildPublicParams, isPublicCommand, noOpNotes, parseSourceTarget, sourceRangeTarget };
