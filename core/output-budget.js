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

const CONTRACT_LINE_RE = /^\s*(?:ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT):/;
const MAX_PRESERVED_CONTRACT_LINES = 24;
const MAX_PRESERVED_CONTRACT_CHARS = 8000;

function preservedContractMetadata(fullText, visibleText) {
    const visible = new Set(visibleText.split('\n').map(line => line.trim()));
    const selected = [];
    let selectedChars = 0;
    let omitted = 0;

    for (const rawLine of fullText.split('\n')) {
        if (!CONTRACT_LINE_RE.test(rawLine)) continue;
        const line = rawLine.trim();
        if (!line || visible.has(line)) continue;
        if (selected.length >= MAX_PRESERVED_CONTRACT_LINES ||
            selectedChars + line.length + 1 > MAX_PRESERVED_CONTRACT_CHARS) {
            omitted++;
            continue;
        }
        selected.push(line);
        selectedChars += line.length + 1;
    }

    return { lines: selected, omitted, complete: omitted === 0 };
}

function narrowingHint(command, surface) {
    const cli = {
        repo: 'Use --sections, --in, or --exclude to narrow the view.',
        entrypoints: 'Use --framework or --exclude to narrow the result.',
        endpoints: 'Use --prefix, --method, --server-only, or --client-only.',
        impact: 'Use --file or --in to narrow the result.',
        tests: 'Use --file, --in, or --exclude to narrow the result.',
        deadcode: 'Use --file, --in, or --exclude to narrow the result.',
        usages: 'Use --file or --in to narrow the result.',
        deps: 'Use --depth=1 or --direction=imports|importers.',
    };
    const mcp = {
        repo: 'Use sections=, in=, or exclude= to narrow the view.',
        entrypoints: 'Use framework= or exclude= to narrow the result.',
        endpoints: 'Use prefix=, method=, server_only=true, or client_only=true.',
        impact: 'Use file= or in= to narrow the result.',
        tests: 'Use file=, in=, or exclude= to narrow the result.',
        deadcode: 'Use file=, in=, or exclude= to narrow the result.',
        usages: 'Use file= or in= to narrow the result.',
        deps: 'Use depth=1 or direction=imports|importers.',
    };
    const canonical = String(command).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (surface === 'mcp') {
        return mcp[command] || mcp[canonical] || 'Use file=, in=, or exclude= to narrow scope.';
    }
    return cli[canonical] || 'Use --file, --in, or --exclude to narrow scope.';
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
    const requested = all ? MAX_OUTPUT_CHARS : (maxChars || defaultLimit);
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

    const truncated = text.substring(0, limit);
    const lastNewline = truncated.lastIndexOf('\n');
    const cleanCut = lastNewline > limit * 0.8
        ? truncated.substring(0, lastNewline)
        : truncated;
    const contractMetadata = preservedContractMetadata(text, cleanCut);
    const canonical = resolveCommand(command, surface === 'mcp' ? 'mcp' : 'cli') ||
        command;
    const supportsAll = FLAG_APPLICABILITY[canonical]?.includes('all');
    const allHint = supportsAll
        ? (surface === 'mcp'
            ? 'Use all=true to lift formatter caps; the transport still has a 100K character ceiling.'
            : 'Use --all to lift formatter caps, or --max-chars=N up to the 100K character ceiling.')
        : (surface === 'mcp'
            ? 'Use max_chars=<n> up to the 100K character ceiling.'
            : 'Use --max-chars=N up to the 100K character ceiling.');
    let rendered = cleanCut +
        `\n\n... OUTPUT TRUNCATED: showing at most ${limit} of ${text.length} chars. ` +
        `Full output would be ~${Math.round(text.length / 4)} tokens. ` +
        `${narrowingHint(command, surface)} ${allHint}`;

    if (contractMetadata.lines.length > 0 || contractMetadata.omitted > 0) {
        rendered += '\n\nPRESERVED CONTRACT METADATA (from omitted output):';
        if (contractMetadata.lines.length > 0) {
            rendered += '\n' + contractMetadata.lines.join('\n');
        }
        if (contractMetadata.omitted > 0) {
            rendered += `\nWARNING: ${contractMetadata.omitted} additional contract line(s) ` +
                'could not fit the preservation budget; narrow scope before acting.';
        }
    }

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
