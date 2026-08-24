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
const { toCliName, toMcpName, formatSurfaceMessage } = require('../registry');

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

/** Canonicalize object keys so JSON bytes do not depend on index provenance. */
function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!value || typeof value !== 'object') return value;
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
        canonical[key] = canonicalJsonValue(value[key]);
    }
    return canonical;
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

function presentationHints(surface = 'cli') {
    if (surface === 'mcp') {
        return {
            surface: 'mcp',
            all: 'use all=true',
            limit: 'Use limit=<n> to return and display more results.',
            source: 'Run command=source with name=<handle> to inspect a listed symbol.',
            usages: name => `run command=usages with name=${name}`,
            detailed: 'Use detailed=true to list all functions and classes.',
            top: 'Use top=<n> or all=true to show more.',
            health: 'run command=repo with sections=health and deep=true for detail',
            expandUnverified: 'expand_unverified=true',
            includeMethods: 'Use include_methods=true to show them.',
            nextRepo: result => [
                ...(result.suggest ? [`command=show name=${result.suggest}`] : []),
                'command=repo sections=files detailed=true',
                'command=repo sections=stats hot=true top=20',
                'command=repo sections=health deep=true',
            ],
        };
    }
    return {
        surface: 'cli',
        all: 'use --all',
        limit: 'Use --limit=N to return and display more results.',
        source: 'Use source <handle> to inspect a listed symbol.',
        usages: name => `ucn usages ${name}`,
        detailed: 'Use --detailed to list all functions and classes.',
        top: 'Use --top=N or --all to show more.',
        health: 'ucn repo --sections=health --deep for detail',
        expandUnverified: '--expand-unverified',
        includeMethods: 'Use --include-methods to show them.',
        nextRepo: result => [
            ...(result.suggest ? [`ucn show ${result.suggest}`] : []),
            'ucn repo --sections=files --detailed',
            'ucn repo --sections=stats --hot --top=20',
            'ucn repo --sections=health --deep',
        ],
    };
}

function formatSource(result, hints = presentationHints()) {
    const extractionHints = hints.surface === 'mcp'
        ? {
            maxLinesHint: 'use max_lines=<n>, or omit it for the full function',
            classSourceHint: 'Use max_lines=<n> to see source, or run command=source with name=<method-handle> for an individual method.',
        }
        : {};
    const mode = modeOf('source', result);
    if (mode === 'lines' || (result && Array.isArray(result.lines))) {
        return legacy.formatLines(result);
    }
    if (mode === 'class') return legacy.formatClassResult(result, extractionHints);
    return legacy.formatFnResult(result, extractionHints);
}

function projectContextText(text, selected) {
    if (!text) return text;
    const keepCallers = selected.has('callers');
    const keepCallees = selected.has('callees');
    if (keepCallers && keepCallees) return text;
    const lines = text.split('\n');
    const projected = [];
    let band = null;
    const metadata = /^(?:NON-CALL OCCURRENCES|ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT):/;
    for (const line of lines) {
        if (/^CALLERS —/.test(line)) band = 'callers';
        else if (/^CALLEES(?: —| \()/.test(line)) band = 'callees';
        else if (metadata.test(line)) band = null;
        if ((band === 'callers' && !keepCallers) ||
            (band === 'callees' && !keepCallees)) continue;
        projected.push(line);
    }
    return projected.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function formatShow(result, params = {}, hints = presentationHints()) {
    const selected = new Set(result.sections || []);
    const parts = [];

    if (result.summary) parts.push(block('SUMMARY', legacy.formatBrief(result.summary)));
    if (result.context) {
        const context = { ...result.context };
        const formatted = legacy.formatContext(context, {
            showConfidence: params.showConfidence !== false,
            compact: params.compact !== false,
            expandHint: hints.source,
            allHint: hints.all,
            usagesHint: hints.usages(context.function || result.target),
        });
        parts.push(block('RELATIONSHIPS', projectContextText(formatted.text, selected)));
    }
    if (result.source) parts.push(block('SOURCE', formatSource(result.source, hints)));
    if (result.dependencies) parts.push(block('DEPENDENCIES', legacy.formatSmart(result.dependencies)));
    if (result.tests) {
        parts.push(block('TESTS', formatTests(
            result.tests,
            { ...params, depth: 0 },
            hints,
        )));
    }
    if (result.types) {
        const seen = new Set();
        const types = (result.types.types || []).map(type => ({
            ...type,
            relativePath: type.relativePath || type.file,
            startLine: type.startLine || type.line,
        })).filter(type => {
            const key = `${type.name}\0${type.type}\0${type.relativePath}\0${type.startLine}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        parts.push(block('TYPES', legacy.formatTypedef(types, result.target)));
    }
    if (result.example) parts.push(block('EXAMPLE', legacy.formatExample(result.example, result.target)));
    if (result.related) parts.push(block('RELATED', legacy.formatRelated(result.related, {
        all: params.all,
        top: params.top,
        allHint: hints.all,
    })));

    return parts.join('\n\n');
}

function formatTrace(result, params = {}, hints = presentationHints()) {
    const traceHints = {
        allHint: hints.all,
        expandUnverifiedHint: hints.expandUnverified,
        includeMethodsHint: hints.includeMethods,
    };
    const mode = modeOf('trace', result);
    if (mode === 'entrypoints') return legacy.formatReverseTrace(result, {
        ...traceHints,
        allHint: 'Increase depth for a wider path search.',
    });
    if (mode === 'callers') return legacy.formatBlast(result, {
        ...traceHints,
        allHint: hints.surface === 'mcp'
            ? 'Use all=true to lift the per-node child cap; depth controls hops only.'
            : 'Use --all to lift the per-node child cap; --depth controls hops only.',
    });
    return legacy.formatTrace(result, {
        ...traceHints,
        allHint: 'Increase depth for a wider callee tree.',
    });
}

function formatImpact(result, params = {}) {
    return modeOf('impact', result) === 'diff'
        ? legacy.formatDiffImpact(result, { all: params.all })
        : legacy.formatImpact(result, { compact: params.compact !== false });
}

function formatTests(result, params = {}, hints = presentationHints()) {
    return modeOf('tests', result) === 'affected'
        ? legacy.formatAffectedTests(result, { all: params.all, allHint: hints.all })
        : legacy.formatTests(result, params.name);
}

function formatDeps(result, params = {}, hints = presentationHints()) {
    if (modeOf('deps', result) === 'cycles' || result.cycles) {
        return legacy.formatCircularDeps(result);
    }
    const parts = [legacy.formatGraph(result.graph, {
        showAll: params.all || params.depth != null,
        maxDepth: params.depth ?? 2,
        file: result.file,
        depthHint: hints.surface === 'mcp'
            ? 'Use depth=<n> for a deeper graph.'
            : 'Use --depth=N for a deeper graph.',
        allHint: hints.all,
    })];
    if (result.imports) parts.push(block('IMPORT DECLARATIONS', legacy.formatImports(result.imports, result.file)));
    if (result.importers) parts.push(block('IMPORTERS', legacy.formatExporters(result.importers, result.file)));
    return parts.join('\n\n');
}

function formatRepo(result, params = {}, hints = presentationHints()) {
    const parts = [];
    if (result.summary) {
        parts.push(legacy.formatOrient(result.summary, {
            healthHint: hints.health,
            nextHints: hints.nextRepo,
        }));
    }
    if (result.files) {
        parts.push(block('FILES', legacy.formatToc(result.files, {
            detailedHint: hints.detailed,
            topHint: hints.top,
        })));
    }
    if (result.stats) parts.push(block('STATISTICS', legacy.formatStats(result.stats, {
        top: params.top || 0,
        topHint: hints.surface === 'mcp' ? 'use top=<n> to show more' : 'use --top=N to show more',
    })));
    if (result.health) {
        parts.push(block('HEALTH', legacy.formatDoctor(result.health, {
            deepHint: hints.surface === 'mcp' ? 'use deep=true' : 'use --deep',
        })));
    }
    return parts.join('\n\n');
}

function formatPublicText(command, result, params = {}, execution = {}) {
    const hints = presentationHints(execution.surface);
    if (result?.scopeWarning?.hint) {
        result.scopeWarning = {
            ...result.scopeWarning,
            hint: formatSurfaceMessage(result.scopeWarning.hint, execution.surface),
        };
    }
    let text;
    switch (command) {
        case 'show': text = formatShow(result, params, hints); break;
        case 'find':
            text = modeOf('find', result) === 'type'
                ? legacy.formatTypedef(result, params.name)
                : legacy.formatFindDetailed(result, params.name, {
                    compact: params.compact,
                    withSource: params.withSource,
                    top: params.limit,
                    all: !!params.all,
                    limitHint: hints.limit,
                });
            break;
        case 'usages': text = legacy.formatUsages(result, params.name, {
            compact: params.compact,
            all: params.all,
            allHint: hints.all,
        }); break;
        case 'search':
            text = execution.structural || result?.meta?.mode === 'structural'
                ? legacy.formatStructuralSearch(result, {
                    topHint: hints.surface === 'mcp'
                        ? 'Use top=<n> to see more.' : 'Use --top=N to see more.',
                    unusedFlag: hints.surface === 'mcp' ? 'unused=true' : '--unused',
                })
                : legacy.formatSearch(result, params.term, {
                    topHint: hints.surface === 'mcp'
                        ? 'Use top=<n> to see more.' : 'Use --top=N to see more.',
                    includeTestsHint: hints.surface === 'mcp'
                        ? 'use include_tests=true to include'
                        : 'use --include-tests to include',
                });
            break;
        case 'source': text = formatSource(result, hints); break;
        case 'trace': text = formatTrace(result, params, hints); break;
        case 'impact': text = formatImpact(result, params); break;
        case 'tests': text = formatTests(result, params, hints); break;
        case 'deps': text = formatDeps(result, params, hints); break;
        case 'api': text = legacy.formatApi(result, params.file || '.'); break;
        case 'check':
            text = modeOf('check', result) === 'symbol'
                ? legacy.formatVerify(result)
                : legacy.formatCheck(result);
            break;
        case 'plan': text = legacy.formatPlan(result, { surface: execution.surface }); break;
        case 'repo': text = formatRepo(result, params, hints); break;
        case 'deadcode': text = legacy.formatDeadcode(result, {
            top: params.top || 0,
            topHint: hints.top,
            ...(hints.surface === 'mcp' && {
                decoratedHint: `${result.excludedDecorated || 0} decorated/annotated symbol(s) hidden (framework-registered). Use include_decorated=true to include them.`,
                exportedHint: `${result.excludedExported || 0} exported symbol(s) excluded from the audit (public API may have external callers). Use include_exported=true to audit them.`,
                externalContractHint: `${result.excludedExternalContract || 0} symbol(s) hidden (override an out-of-tree base class — reachable via external contract, not dead). Use include_exported=true to include them.`,
            }),
        }); break;
        case 'entrypoints': text = legacy.formatEntrypoints(result); break;
        case 'endpoints': text = legacy.formatEndpoints(result, {
            bridge: result._bridge,
            unmatched: result._unmatched,
            serverOnly: result._serverOnly,
            clientOnly: result._clientOnly,
        }); break;
        case 'stacktrace': text = legacy.formatStackTrace(result); break;
        case 'auditAsync': text = legacy.formatAuditAsync(result); break;
        default: throw new Error(`No public formatter for command: ${command}`);
    }
    return appendNote(text, execution.note
        ? formatSurfaceMessage(execution.note, execution.surface)
        : execution.note);
}

function formatPublicJson(command, result, params = {}, execution = {}) {
    let commandMeta = {};
    let data = result;

    // Ambiguous bare-name resolution is a surface-level trust decision. Keep
    // it in the common envelope even for array results (notably `tests`, whose
    // auxiliary metadata is intentionally non-enumerable).
    if (result?.warnings?.length > 0) {
        commandMeta.warnings = result.warnings;
    }

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
    if (command === 'deadcode' && Array.isArray(result)) {
        commandMeta.deletionSafety = 'review-required';
        commandMeta.excludedExported = result.excludedExported || 0;
        commandMeta.excludedDecorated = result.excludedDecorated || 0;
        commandMeta.excludedExternalContract = result.excludedExternalContract || 0;
        commandMeta.excludedRuntimeContract = result.excludedRuntimeContract || 0;
        commandMeta.pythonImplicitExportFiles = result.pythonImplicitExportFiles || 0;
        commandMeta.excludedDynamicDispatch = result.excludedDynamicDispatch || 0;
        commandMeta.computedDispatch = result.computedDispatch || { count: 0, names: [] };
        commandMeta.reflection = result.reflection || {
            count: 0, literalCount: 0, dynamicCount: 0,
            fileCount: 0, files: [], names: [],
        };
        if (result.coverage) commandMeta.coverage = result.coverage;
        if (result.limitInfo) {
            commandMeta.total = result.limitInfo.total;
            commandMeta.truncated = true;
        }
    }
    if (command === 'search' && result?.meta) {
        commandMeta.searchMode = result.meta.mode;
        commandMeta.totalMatches = result.meta.totalMatches;
        commandMeta.shownMatches = result.meta.shownMatches;
        commandMeta.truncatedMatches = result.meta.truncatedMatches;
        commandMeta.limit = result.meta.limit;
        if (result.meta.truncatedMatches > 0) commandMeta.truncated = true;
        if (result.unsupportedMatches) commandMeta.unsupportedMatches = result.unsupportedMatches;
    }
    if (command === 'entrypoints' && result?.filterInfo) {
        commandMeta.hiddenTestEntrypoints = result.filterInfo.hiddenTests;
        commandMeta.testsIncluded = result.filterInfo.testsIncluded;
        if (result.limitInfo) {
            commandMeta.total = result.limitInfo.total;
            commandMeta.truncated = true;
        }
    }
    // Handles are the documented spine (`Pass the resulting handle to show/
    // impact/source`) — the JSON records must carry them, not make agents
    // concatenate relativePath:startLine:name themselves.
    if (command === 'find' && Array.isArray(result)) {
        const { formatSymbolHandle } = require('../shared');
        if (result.findInfo) {
            commandMeta.total = result.findInfo.total;
            commandMeta.shown = result.findInfo.shown;
            if (result.findInfo.shown < result.findInfo.total) commandMeta.truncated = true;
        }
        data = result.map(item => {
            const handle = formatSymbolHandle(item);
            return handle ? { handle, ...item } : item;
        });
    }
    // Mixed-language disclosure for commands whose result is not
    // account-shaped: the counts must be machine-readable, not note-only.
    if ((command === 'find' || command === 'usages' || command === 'tests') &&
        result?.unsupportedMatches) {
        commandMeta.unsupportedMatches = result.unsupportedMatches;
    }
    if (command === 'usages' && result?.analysisGaps) {
        commandMeta.analysisGaps = result.analysisGaps;
    }

    const surfaceCommand = execution.surface === 'mcp'
        ? toMcpName(command)
        : execution.surface === 'cli' ? toCliName(command) : command;

    const envelope = {
        meta: {
            command: surfaceCommand,
            ...(surfaceCommand !== command && { canonicalCommand: command }),
            // A result that self-reports it could not run (check with a bad
            // base ref / outside git) must be machine-distinguishable from a
            // successful empty result at the envelope level too.
            ...(data && data.ok === false && { ok: false }),
            ...(modeOf(command, result) && { mode: modeOf(command, result) }),
            contract: contractMeta(command),
            ...commandMeta,
            ...(execution.note && { note: execution.note }),
        },
        data,
    };
    return JSON.stringify(canonicalJsonValue(envelope), null, 2);
}

module.exports = {
    formatPublicText,
    formatPublicJson,
    contractMeta,
    modeOf,
};
