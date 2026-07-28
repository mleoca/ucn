'use strict';

/**
 * Public v5 presentation router.
 *
 * CLI and MCP both call this module after the shared execute() path.  The
 * engine's narrower internal results remain independently testable, while the
 * public surface has one formatter decision for each canonical command.
 */

const { COMMAND_CONTRACTS } = require('../command-contracts');
const { COMMAND_TRUST_MATRIX } = require('../trust-matrix');

const legacy = {
    ...require('./analysis'),
    ...require('./analysis-ext'),
    ...require('./brief'),
    ...require('./check'),
    ...require('./doctor'),
    ...require('./endpoints'),
    ...require('./extraction'),
    ...require('./find'),
    ...require('./graph'),
    ...require('./refactoring'),
    ...require('./reporting'),
    ...require('./search'),
    ...require('./tracing'),
};

function block(title, text) {
    if (!text) return '';
    return `${title}\n${'─'.repeat(Math.min(60, title.length || 1))}\n${text}`;
}

function appendNote(text, note) {
    return note ? `${text}\n\n${note}` : text;
}

function contractMeta(command) {
    const contract = COMMAND_CONTRACTS[command];
    const trust = COMMAND_TRUST_MATRIX[command];
    if (!contract || !trust) return undefined;
    return {
        question: contract.question,
        decisionSafety: trust.decisionSafety,
        truth: contract.truth,
        next: contract.next,
    };
}

function modeOf(command, result) {
    if (result && result._publicMode) return result._publicMode;
    if (command === 'impact') return result && Array.isArray(result.functions) ? 'diff' : 'symbol';
    if (command === 'trace') return result && result.direction === 'down' ? 'callees' : 'callers';
    if (command === 'tests') return result && result.root ? 'affected' : 'direct';
    if (command === 'check') return result && result.expectedArgs ? 'symbol' : 'diff';
    return undefined;
}

function formatSource(result) {
    const mode = modeOf('source', result);
    if (mode === 'lines' || (result && Array.isArray(result.lines))) {
        return legacy.formatLines(result);
    }
    if (mode === 'class') return legacy.formatClassResult(result);
    return legacy.formatFnResult(result);
}

function formatShow(result, params = {}) {
    const selected = new Set(result.sections || []);
    const parts = [];

    if (result.summary) parts.push(block('SUMMARY', legacy.formatBrief(result.summary)));
    if (result.context) {
        const context = { ...result.context };
        if (!selected.has('callers')) {
            context.callers = [];
            context.unverifiedCallers = [];
        }
        if (!selected.has('callees')) {
            context.callees = [];
            context.unverifiedCallees = [];
        }
        const formatted = legacy.formatContext(context, {
            showConfidence: params.showConfidence !== false,
            compact: params.compact !== false,
            expandHint: 'Use source <handle> to inspect a listed symbol.',
        });
        parts.push(block('RELATIONSHIPS', formatted.text));
    }
    if (result.source) parts.push(block('SOURCE', formatSource(result.source)));
    if (result.dependencies) parts.push(block('DEPENDENCIES', legacy.formatSmart(result.dependencies)));
    if (result.tests) parts.push(block('TESTS', formatTests(result.tests, { ...params, depth: 0 })));
    if (result.types) parts.push(block('TYPES', legacy.formatTypedef(result.types.types || [], result.target)));
    if (result.example) parts.push(block('EXAMPLE', legacy.formatExample(result.example, result.target)));
    if (result.related) parts.push(block('RELATED', legacy.formatRelated(result.related, { all: params.all, top: params.top })));

    return parts.join('\n\n');
}

function formatTrace(result, params = {}) {
    const mode = modeOf('trace', result);
    if (mode === 'entrypoints') return legacy.formatReverseTrace(result, { allHint: 'Increase depth for a wider path search.' });
    if (mode === 'callers') return legacy.formatBlast(result, { allHint: 'Increase depth for a wider caller tree.' });
    return legacy.formatTrace(result, { allHint: 'Increase depth for a wider callee tree.' });
}

function formatImpact(result, params = {}) {
    return modeOf('impact', result) === 'diff'
        ? legacy.formatDiffImpact(result, { all: params.all })
        : legacy.formatImpact(result, { compact: params.compact !== false });
}

function formatTests(result, params = {}) {
    return modeOf('tests', result) === 'affected'
        ? legacy.formatAffectedTests(result, { all: params.all })
        : legacy.formatTests(result, params.name);
}

function formatDeps(result, params = {}) {
    if (modeOf('deps', result) === 'cycles' || result.cycles) {
        return legacy.formatCircularDeps(result);
    }
    const parts = [legacy.formatGraph(result.graph, {
        showAll: params.all || params.depth !== undefined,
        maxDepth: params.depth ?? 2,
        file: result.file,
    })];
    if (result.imports) parts.push(block('IMPORT DECLARATIONS', legacy.formatImports(result.imports, result.file)));
    if (result.importers) parts.push(block('IMPORTERS', legacy.formatExporters(result.importers, result.file)));
    return parts.join('\n\n');
}

function formatRepo(result, params = {}) {
    const parts = [];
    if (result.summary) parts.push(legacy.formatOrient(result.summary));
    if (result.files) parts.push(block('FILES', legacy.formatToc(result.files)));
    if (result.stats) parts.push(block('STATISTICS', legacy.formatStats(result.stats, { top: params.top || 0 })));
    if (result.health) parts.push(block('HEALTH', legacy.formatDoctor(result.health)));
    return parts.join('\n\n');
}

function formatPublicText(command, result, params = {}, execution = {}) {
    let text;
    switch (command) {
        case 'show': text = formatShow(result, params); break;
        case 'find':
            text = modeOf('find', result) === 'type'
                ? legacy.formatTypedef(result, params.name)
                : legacy.formatFindDetailed(result, params.name, {
                    compact: params.compact,
                    withSource: params.withSource,
                    top: params.limit,
                    all: !!params.all,
                    limitHint: 'Use --limit=N to return and display more results.',
                });
            break;
        case 'usages': text = legacy.formatUsages(result, params.name, { compact: params.compact }); break;
        case 'search':
            text = execution.structural || result?.meta?.mode === 'structural'
                ? legacy.formatStructuralSearch(result)
                : legacy.formatSearch(result, params.term);
            break;
        case 'source': text = formatSource(result); break;
        case 'trace': text = formatTrace(result, params); break;
        case 'impact': text = formatImpact(result, params); break;
        case 'tests': text = formatTests(result, params); break;
        case 'deps': text = formatDeps(result, params); break;
        case 'api': text = legacy.formatApi(result, params.file || '.'); break;
        case 'check':
            text = modeOf('check', result) === 'symbol'
                ? legacy.formatVerify(result)
                : legacy.formatCheck(result);
            break;
        case 'plan': text = legacy.formatPlan(result); break;
        case 'repo': text = formatRepo(result, params); break;
        case 'deadcode': text = legacy.formatDeadcode(result, { top: params.top || 0 }); break;
        case 'entrypoints': text = legacy.formatEntrypoints(result); break;
        case 'endpoints': text = legacy.formatEndpoints(result, { bridge: result._bridge, unmatched: result._unmatched }); break;
        case 'stacktrace': text = legacy.formatStackTrace(result); break;
        case 'auditAsync': text = legacy.formatAuditAsync(result); break;
        default: throw new Error(`No public formatter for command: ${command}`);
    }
    return appendNote(text, execution.note);
}

function formatPublicJson(command, result, params = {}, execution = {}) {
    let commandMeta = {};
    let data = result;

    // Keep the stable public envelope while reusing the endpoint serializer's
    // trimmed records and aggregate metadata. This prevents private routing
    // fields from leaking and preserves the established machine contract.
    if (command === 'endpoints') {
        const formatted = JSON.parse(legacy.formatEndpointsJson(result, {
            bridge: result?._bridge,
            unmatched: result?._unmatched,
        }));
        commandMeta = formatted.meta || {};
        data = formatted.data;
    }

    const envelope = {
        meta: {
            command,
            ...(modeOf(command, result) && { mode: modeOf(command, result) }),
            contract: contractMeta(command),
            ...commandMeta,
            ...(execution.note && { note: execution.note }),
        },
        data,
    };
    return JSON.stringify(envelope, null, 2);
}

module.exports = {
    formatPublicText,
    formatPublicJson,
    contractMeta,
    modeOf,
};
