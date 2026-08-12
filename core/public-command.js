'use strict';

const { CANONICAL_COMMANDS } = require('./registry');

const NAME_COMMANDS = new Set(['show', 'find', 'usages', 'trace', 'tests', 'plan']);

function parseSourceTarget(arg, params) {
    if (params.range) return { ...params, file: params.file, range: params.range };
    const value = String(arg || '').trim();
    const twoPart = value.match(/^(.+?)\s+(\d+(?:-\d+)?)$/);
    if (twoPart) return { ...params, file: params.file || twoPart[1], range: twoPart[2] };
    // A single-colon file:range target is a line request. Stable symbol
    // handles with a name contain a second colon and stay symbol targets.
    const inline = value.match(/^([^:]+(?:\/[^:]*)?):(\d+(?:-\d+)?)$/);
    if (inline) return { ...params, file: params.file || inline[1], range: inline[2] };
    return { ...params, name: arg };
}

/** Build normalized execute() params from the shared CLI-style positional arg. */
function buildPublicParams(command, arg, params = {}) {
    const clean = { ...params };
    if (clean.top === 0 && params.topRaw == null) delete clean.top;
    if (clean.maxLines == null) delete clean.maxLines;
    // Surface-only values never belong in execute params.
    for (const key of ['json', 'quiet', 'cache', 'clearCache', 'followSymlinks', 'interactive',
        'topRaw', 'limitRaw', 'maxFilesRaw', 'maxLinesRaw', 'maxChars', 'maxCharsRaw',
        'depthRaw', 'contextRaw', 'workersRaw',
        '_fileFromFileMode']) delete clean[key];

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

function isPublicCommand(command) {
    return CANONICAL_COMMANDS.includes(command);
}

module.exports = { buildPublicParams, isPublicCommand, parseSourceTarget };
