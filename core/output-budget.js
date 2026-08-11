'use strict';

const {
    BROAD_COMMANDS: BROAD_CANONICAL,
    FLAG_APPLICABILITY,
    resolveCommand,
    toMcpName,
} = require('./registry');

const DEFAULT_OUTPUT_CHARS = 10000;
const BROAD_OUTPUT_CHARS = 3000;
const MAX_OUTPUT_CHARS = 100000;
const BROAD_COMMANDS = new Set([
    ...BROAD_CANONICAL,
    ...[...BROAD_CANONICAL].map(toMcpName),
]);

const CONTRACT_LINE_RE = /^\s*(?:(?:Summary|ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT):|\d+ test-file usage\(s\) hidden\b|(?:Note:\s*)?Found \d+ (?:definitions|fuzzy matches)\b)/;
const MAX_PRESERVED_CONTRACT_LINES = 24;
const MAX_PRESERVED_CONTRACT_CHARS = 8000;

function preservedContractMetadata(fullText, visibleText, options = {}) {
    const visible = new Set(visibleText.split('\n').map(line => line.trim()));
    const candidates = [];
    const selected = [];
    let selectedChars = 0;
    let omitted = 0;
    const maxLines = options.maxLines ?? MAX_PRESERVED_CONTRACT_LINES;
    const maxChars = options.maxChars ?? MAX_PRESERVED_CONTRACT_CHARS;

    for (const [sourceIndex, rawLine] of fullText.split('\n').entries()) {
        // Execution notes may concatenate several independent disclosures on
        // one physical line. Preserve the actionable test-scope contract as
        // its own sentence so a later parse-failure note cannot make the
        // whole metadata item too large for a small transport budget.
        const firstSentenceEnd = /^\s*\d+ test-file usage\(s\) hidden\b/.test(rawLine)
            ? rawLine.indexOf('. ')
            : -1;
        const contractLine = firstSentenceEnd >= 0
            ? rawLine.slice(0, firstSentenceEnd + 1)
            : rawLine;
        if (!CONTRACT_LINE_RE.test(contractLine)) continue;
        const line = contractLine.trim();
        if (!line || visible.has(line)) continue;
        const priority = /^(?:ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT):/.test(line)
            ? 0
            : /^\d+ test-file usage\(s\) hidden\b/.test(line) ? 1 : 2;
        candidates.push({ line, priority, sourceIndex });
    }

    for (const { line } of candidates.sort((a, b) =>
        a.priority - b.priority || a.sourceIndex - b.sourceIndex)) {
        if (selected.length >= maxLines ||
            selectedChars + line.length + 1 > maxChars) {
            omitted++;
            continue;
        }
        selected.push(line);
        selectedChars += line.length + 1;
    }

    return { lines: selected, omitted, complete: omitted === 0 };
}

function narrowingHint(command, surface, params = {}) {
    const cli = {
        repo: 'Use --sections, --in, or --exclude to narrow the view.',
        entrypoints: 'Use --framework or --exclude to narrow the result.',
        endpoints: 'Use --prefix, --method, --server-only, or --client-only.',
        impact: 'Use --file or --limit=N to narrow the result.',
        tests: 'Use --file or --exclude to narrow the result.',
        deadcode: 'Use --file, --in, or --exclude to narrow the result.',
        usages: 'Use --file or --in to narrow the result.',
        deps: 'Use --depth=1 or --direction=imports|importers.',
        api: 'Use --limit=N to narrow the result.',
    };
    const mcp = {
        repo: 'Use sections=, in=, or exclude= to narrow the view.',
        entrypoints: 'Use framework= or exclude= to narrow the result.',
        endpoints: 'Use prefix=, method=, server_only=true, or client_only=true.',
        impact: 'Use file= or limit=<n> to narrow the result.',
        tests: 'Use file= or exclude= to narrow the result.',
        deadcode: 'Use file=, in=, or exclude= to narrow the result.',
        usages: 'Use file= or in= to narrow the result.',
        deps: 'Use depth=1 or direction=imports|importers.',
        api: 'Use limit=<n> to narrow the result.',
    };
    const canonical = String(command).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (canonical === 'deps' && params.cycles) {
        return surface === 'mcp'
            ? 'Use max_chars=<n> to raise the output budget for cycle results.'
            : 'Use --max-chars=N to raise the output budget for cycle results.';
    }
    if (surface === 'mcp' && (mcp[command] || mcp[canonical])) {
        return mcp[command] || mcp[canonical];
    }
    if (surface !== 'mcp' && (cli[canonical] || cli[command])) {
        return cli[canonical] || cli[command];
    }
    const applicable = new Set(FLAG_APPLICABILITY[canonical] || []);
    const candidates = ['file', 'in', 'exclude'].filter(flag => applicable.has(flag));
    if (candidates.length > 0) {
        return surface === 'mcp'
            ? `Use ${candidates.map(flag => `${flag}=`).join(', ')} to narrow scope.`
            : `Use ${candidates.map(flag => `--${flag}`).join(', ')} to narrow scope.`;
    }
    return surface === 'mcp'
        ? 'Use max_chars=<n> to raise the explicit output budget.'
        : 'Use --max-chars=N to raise the explicit output budget.';
}

function compactNarrowingHint(command, surface, params = {}) {
    const full = narrowingHint(command, surface, params);
    if (surface !== 'mcp') {
        const flags = full.match(/--[a-z-]+(?:=N)?/g) || [];
        return [...new Set(flags)].join('/');
    }
    const flags = full.match(/\b(?:sections|in|exclude|framework|prefix|method|server_only|client_only|file|limit|depth|direction|max_chars)(?:=<n>|=true|=imports\|importers|=1|=)?/g) || [];
    return [...new Set(flags)].join('/');
}

/**
 * Apply the same bounded-output contract to CLI and MCP text. JSON is not
 * passed here: structured consumers receive the complete stable envelope.
 */
function applyOutputBudget(text, {
    command,
    maxChars,
    all = false,
    surface = 'cli',
    params = {},
} = {}) {
    if (!text) {
        return {
            text: '(no output)',
            truncated: false,
            fullChars: 0,
            requestedLimit: maxChars || null,
            contractMetadata: [],
            contractMetadataComplete: true,
        };
    }

    const defaultLimit = BROAD_COMMANDS.has(command)
        ? BROAD_OUTPUT_CHARS
        : DEFAULT_OUTPUT_CHARS;
    const requested = maxChars || (all ? MAX_OUTPUT_CHARS : defaultLimit);
    const limit = Math.min(requested, MAX_OUTPUT_CHARS);
    if (text.length <= limit) {
        return {
            text,
            truncated: false,
            fullChars: text.length,
            requestedLimit: limit,
            contractMetadata: [],
            contractMetadataComplete: true,
        };
    }

    const canonical = resolveCommand(command, surface === 'mcp' ? 'mcp' : 'cli') ||
        command;
    const supportsAll = FLAG_APPLICABILITY[canonical]?.includes('all') &&
        !(canonical === 'deps' && params.cycles);
    const allHint = supportsAll
        ? (surface === 'mcp'
            ? 'Use all=true or max_chars=<n> (100K maximum).'
            : 'Use --all or --max-chars=N (100K maximum).')
        : (surface === 'mcp'
            ? 'Use max_chars=<n> (100K maximum).'
            : 'Use --max-chars=N (100K maximum).');
    const compactBudget = limit < 500;
    const raiseHint = surface === 'mcp' ? 'max_chars=<n>' : '--max-chars=N';
    const compactScope = compactNarrowingHint(command, surface, params);
    const compactGuidance = compactScope.includes(raiseHint)
        ? `Raise ${raiseHint}.`
        : `Narrow with ${compactScope || raiseHint}; raise ${raiseHint}.`;
    let notice = compactBudget
        ? `... OUTPUT TRUNCATED (${text.length}→${limit}). ${compactGuidance}`
        : `... OUTPUT TRUNCATED: ${text.length} chars total; hard limit ${limit}. ` +
            `${narrowingHint(command, surface, params)} ${allHint}`;
    if (compactBudget && notice.length > limit) {
        const emergency = supportsAll
            ? (surface === 'mcp'
                ? 'all=true/max_chars=<n>'
                : '--all/--max-chars=N')
            : raiseHint;
        notice = emergency.slice(0, limit);
    }

    // At very small explicit budgets, the verbose preservation heading alone
    // can consume most of the transport. Trust/account lines take precedence
    // over body detail and are appended directly after a compact notice.
    if (compactBudget) {
        const metadataCapacity = Math.max(0, limit - notice.length - 1);
        const candidate = preservedContractMetadata(text, '', {
            maxChars: metadataCapacity,
        });
        const candidateText = candidate.lines.join('\n');
        const separatorChars = candidateText ? 2 : 1;
        const bodyBudget = Math.max(0,
            limit - notice.length - candidateText.length - separatorChars);
        const prefix = text.slice(0, bodyBudget);
        const lastNewline = prefix.lastIndexOf('\n');
        const cleanCut = lastNewline > bodyBudget * 0.8
            ? prefix.slice(0, lastNewline)
            : prefix;
        const remainingForMetadata = Math.max(0,
            limit - cleanCut.length - notice.length -
            (cleanCut ? 1 : 0) - 1);
        const contractMetadata = preservedContractMetadata(text, cleanCut, {
            // preservedContractMetadata accounts a trailing newline per item;
            // the renderer joins the final item without one.
            maxChars: remainingForMetadata + 1,
        });
        const pieces = [];
        if (cleanCut) pieces.push(cleanCut);
        pieces.push(notice);
        if (contractMetadata.lines.length > 0) {
            pieces.push(contractMetadata.lines.join('\n'));
        }
        return {
            text: pieces.join('\n').slice(0, limit),
            truncated: true,
            fullChars: text.length,
            requestedLimit: limit,
            contractMetadata: contractMetadata.lines,
            contractMetadataComplete: contractMetadata.complete,
        };
    }

    // max_chars is a transport ceiling, not merely a body target. Reserve a
    // bounded share for omitted trust/account lines, then spend the remainder
    // on the original body and truncation notice. Tiny limits may be too small
    // for any metadata; the returned completeness bit records that fact.
    const metadataBudget = Math.min(
        MAX_PRESERVED_CONTRACT_CHARS,
        Math.max(0, Math.floor(limit * 0.50)),
    );
    const candidateMetadata = preservedContractMetadata(text, '', {
        maxChars: metadataBudget,
    });
    const provisionalMetadata = candidateMetadata.lines.length > 0
        ? '\n\nPRESERVED CONTRACT METADATA (from omitted output):\n' +
            candidateMetadata.lines.join('\n')
        : '';
    const bodyBudget = Math.max(0,
        limit - notice.length - provisionalMetadata.length - 2);
    const truncated = text.substring(0, bodyBudget);
    const lastNewline = truncated.lastIndexOf('\n');
    const cleanCut = lastNewline > bodyBudget * 0.8
        ? truncated.substring(0, lastNewline)
        : truncated;
    const metadataHeading = '\n\nPRESERVED CONTRACT METADATA (from omitted output):';
    const remainingForMetadata = Math.max(0,
        limit - cleanCut.length - notice.length - (cleanCut ? 2 : 0) -
        metadataHeading.length);
    const contractMetadata = preservedContractMetadata(text, cleanCut, {
        maxChars: Math.min(metadataBudget, remainingForMetadata),
    });
    let rendered = `${cleanCut}${cleanCut ? '\n\n' : ''}${notice}`;

    if (contractMetadata.lines.length > 0) {
        const heading = metadataHeading;
        if (rendered.length + heading.length <= limit) rendered += heading;
        for (const line of contractMetadata.lines) {
            if (rendered.length + line.length + 1 > limit) break;
            rendered += '\n' + line;
        }
    }
    if (contractMetadata.omitted > 0) {
        const warning = `\nWARNING: ${contractMetadata.omitted} additional contract line(s) ` +
            'could not fit the preservation budget; narrow scope before acting.';
        if (rendered.length + warning.length <= limit) rendered += warning;
    }

    // Defensive final ceiling for very small limits and future notice edits.
    rendered = rendered.slice(0, limit);

    return {
        text: rendered,
        truncated: true,
        fullChars: text.length,
        requestedLimit: limit,
        contractMetadata: contractMetadata.lines,
        contractMetadataComplete: contractMetadata.complete,
    };
}

module.exports = {
    DEFAULT_OUTPUT_CHARS,
    BROAD_OUTPUT_CHARS,
    MAX_OUTPUT_CHARS,
    applyOutputBudget,
    preservedContractMetadata,
};
