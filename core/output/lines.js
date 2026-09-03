/**
 * core/output/lines.js - grep-shaped and raw output modes (fix #341).
 *
 * `--lines`: one `path:line:text` record per line — the `grep -n` shape — so
 * `ucn` composes with head/cut/xargs and reads like the tool agents already
 * reach for in a shell. Everything that is not a record (ACCOUNT/CONTRACT
 * lines, disambiguation, notes) follows the records as `# ` comment lines:
 * the CLI routes those to stderr, MCP keeps them in its single text block.
 * Records outside the confirmed tier carry a trailing `\t# tag`, so the
 * `path:line:` prefix stays parseable while the tier stays visible.
 *
 * `--raw` (source): the code text and nothing else — no header, no gutter —
 * so an agent can extract pristine text for an exact-string edit.
 */
'use strict';

const { CALLABLE_SYMBOL_KINDS } = require('../shared');
const { formatAccountLines, formatCalleeAccountLine } = require('./analysis');

const LINES_COMMANDS = new Set(['find', 'usages', 'search', 'show', 'impact']);

function record(pathLike, line, text, tag) {
    // One record per line is the contract: a multi-line signature or a
    // wrapped call expression folds onto one line, and the source line's
    // indentation is dropped (a locate result needs the text, `--raw` has
    // the layout).
    const body = String(text == null ? '' : text).replace(/\s*\n\s*/g, ' ').trim();
    return `${pathLike}:${line == null ? 0 : line}:${body}${tag ? `\t# ${tag}` : ''}`;
}

function signatureOf(symbol) {
    const owner = symbol.className ? `${symbol.className}.` : '';
    const callable = CALLABLE_SYMBOL_KINDS.has(symbol.type) || symbol.params != null;
    // A multi-line parameter list folds onto one line and drops the trailing
    // comma the source may carry before its closing paren.
    const params = String(symbol.params || '').replace(/\s*\n\s*/g, ' ').replace(/,\s*$/, '');
    return callable ? `${owner}${symbol.name}(${params})` : `${owner}${symbol.name}`;
}

function pathOf(entry) {
    return entry.relativePath || entry.file || '';
}

function unverifiedTag(entry) {
    const reason = entry.reason || 'unverified';
    const via = entry.dispatchVia ? ` via ${entry.dispatchVia}` : '';
    return `unverified: ${reason}${via}`;
}

function accountComments(account) {
    if (!account) return [];
    return [].concat(formatAccountLines(account) || [])
        .join('\n').split('\n').filter(Boolean).map(line => `# ${line}`);
}

function findRecords(result) {
    const out = [];
    if (Array.isArray(result)) {
        for (const symbol of result) out.push(record(pathOf(symbol), symbol.startLine, signatureOf(symbol), symbol.type));
    } else if (result && Array.isArray(result.types)) {
        for (const type of result.types) {
            out.push(record(pathOf(type), type.startLine ?? type.line, type.name, type.type || type.kind));
        }
    }
    return { records: out, notes: [] };
}

function usagesRecords(result) {
    const out = [];
    const notes = [];
    for (const usage of Array.isArray(result) ? result : []) {
        const kind = usage.isDefinition ? 'definition' : (usage.usageType || 'reference');
        out.push(record(pathOf(usage), usage.line, usage.content, kind === 'call' ? '' : kind));
    }
    const counts = result && result.summaryCounts;
    if (counts && counts.hiddenTestUsages > 0) {
        notes.push(`# ${counts.hiddenTestUsages} test-file usage(s) hidden by default (--include-tests)`);
    }
    return { records: out, notes };
}

function searchRecords(result) {
    const out = [];
    const notes = [];
    // Structural search (--type=...) returns { meta, results: [{file, line,
    // name, kind, receiver, params?}] }; text search returns file groups.
    if (result && !Array.isArray(result) && Array.isArray(result.results)) {
        for (const item of result.results) {
            const text = item.params != null ? `${item.name}(${item.params})` : item.name;
            out.push(record(item.file, item.line, text, item.kind || item.type));
        }
        const meta = result.meta;
        if (meta && meta.totalMatched > meta.shown) {
            notes.push(`# ${meta.totalMatched - meta.shown} more match(es) (--limit=N / --all)`);
        }
        return { records: out, notes };
    }
    for (const item of Array.isArray(result) ? result : []) {
        if (Array.isArray(item.matches)) {
            for (const match of item.matches) out.push(record(item.file, match.line, match.content));
        } else if (item.file != null && item.line != null) {
            const text = item.content != null ? item.content : signatureOf(item);
            out.push(record(pathOf(item), item.line, text, item.type || item.kind));
        }
    }
    const meta = result && result.meta;
    if (meta && meta.filesSkipped > 0) {
        notes.push(`# ${meta.filesSkipped} test file(s) hidden by default (--include-tests)`);
    }
    return { records: out, notes };
}

function callerRecords(context) {
    const out = [];
    for (const caller of context.callers || []) {
        const tag = caller.tier && caller.tier !== 'confirmed' ? unverifiedTag(caller) : '';
        out.push(record(pathOf(caller), caller.line, caller.content, tag));
    }
    for (const caller of context.unverifiedCallers || []) {
        out.push(record(pathOf(caller), caller.line, caller.content, unverifiedTag(caller)));
    }
    return out;
}

function showRecords(result, params = {}) {
    const out = [];
    const notes = [];
    const context = result && result.context;
    // Only an EXPLICIT --sections selects the band: the resolved defaults
    // (summary, callers, callees) would mix callee records into a caller
    // listing and skew `cut -d: -f1 | sort | uniq -c`.
    const explicit = String(params.sections || '').split(',').map(s => s.trim()).filter(Boolean);
    const selected = new Set(explicit.length > 0 ? explicit : ['callers']);
    if (context) {
        if (selected.has('callers')) out.push(...callerRecords(context));
        if (selected.has('callees')) {
            for (const callee of context.callees || []) {
                const count = callee.callCount > 1 ? ` x${callee.callCount}` : '';
                out.push(record(pathOf(callee), callee.startLine, signatureOf(callee), `callee${count}`));
            }
            for (const callee of context.unverifiedCallees || []) {
                for (const site of callee.sites || []) {
                    out.push(record(pathOf(context), site, callee.name, `callee ${unverifiedTag(callee)}`));
                }
            }
        }
        notes.push(...accountComments(context.meta && context.meta.account));
        if (context.meta && context.meta.calleeAccount && selected.has('callees')) {
            notes.push(`# ${formatCalleeAccountLine(context.meta.calleeAccount)}`);
        }
    }
    if (result && result.target && result.target.alternatives && result.target.alternatives.length > 0) {
        notes.push(`# ${result.target.alternatives.length + 1} definitions; using ${result.target.handle || result.target.file}. Pass a file:line:name handle to pin another.`);
    }
    return { records: out, notes };
}

function impactRecords(result) {
    const out = [];
    const notes = [];
    if (!result) return { records: out, notes };
    for (const group of result.byFile || []) {
        for (const site of group.sites || []) {
            const tag = site.tier && site.tier !== 'confirmed' ? unverifiedTag(site) : '';
            out.push(record(group.file, site.line, site.expression, tag));
        }
    }
    for (const site of result.unverifiedSites || []) {
        out.push(record(pathOf(site), site.line, site.content || site.expression, unverifiedTag(site)));
    }
    if (result.propertyAccesses) {
        for (const access of result.propertyAccesses.confirmed || []) {
            out.push(record(pathOf(access), access.line, access.content, 'property-access'));
        }
        for (const access of result.propertyAccesses.unverified || []) {
            out.push(record(pathOf(access), access.line, access.content, `property-access ${unverifiedTag(access)}`));
        }
    }
    notes.push(...accountComments(result.account));
    return { records: out, notes };
}

/**
 * Render a public command result as grep-shaped records followed by `# `
 * comment lines. Returns '' when the command has nothing to list.
 */
function formatPublicLines(command, result, params = {}, execution = {}) {
    let shaped;
    switch (command) {
        case 'find': shaped = findRecords(result); break;
        case 'usages': shaped = usagesRecords(result); break;
        case 'search': shaped = searchRecords(result); break;
        case 'show': shaped = showRecords(result, params); break;
        case 'impact': shaped = impactRecords(result); break;
        default: return null;
    }
    const lines = [...shaped.records, ...shaped.notes];
    if (execution.note) lines.push(`# ${execution.note}`);
    return lines.join('\n');
}

/**
 * Render a `source` result as the code text alone.
 */
function formatPublicRaw(result, execution = {}) {
    let code = '';
    if (result && Array.isArray(result.lines)) code = result.lines.join('\n');
    else if (result && Array.isArray(result.entries)) {
        code = result.entries.map(entry => entry.code == null ? '' : String(entry.code)).join('\n\n');
    } else if (result && typeof result.code === 'string') code = result.code;
    // A note (the same-name disambiguation, a hidden-section warning) must
    // not vanish in raw mode. Code lines are never reinterpreted, so it
    // cannot ride inside the text: the CLI prints `execution.note` to stderr
    // itself (see emitCliText); the single-block surfaces get it appended as
    // one trailing `# ` line after the code.
    if (execution.note && execution.surface !== 'cli') {
        return `${code.replace(/\n$/, '')}\n# ${execution.note}`;
    }
    return code;
}

module.exports = { LINES_COMMANDS, formatPublicLines, formatPublicRaw };
