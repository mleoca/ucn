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

const CONTRACT_LINE_RE = /^\s*(?:(?:Summary|ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT|Note):|\d+ test-file usage\(s\) hidden\b|Found \d+ (?:definitions|fuzzy matches)\b)/;
// Trust lines: the accounting and contract lines that qualify a caller
// answer. A truncated answer carries every one of them or none of its body.
const TRUST_LINE_RE = /^(?:ACCOUNT|CONTRACT|WARNING|FILTERED|CALLEE ACCOUNT|TREE ACCOUNT):/;
const MAX_PRESERVED_CONTRACT_LINES = 24;
const MAX_PRESERVED_CONTRACT_CHARS = 8000;

/**
 * Contract metadata candidates of a text, in source order: trust lines
 * (priority 0), the hidden-test-scope sentence (1), and other disclosures
 * (2: Summary, Note, definition counts).
 */
function contractCandidates(fullText) {
    const candidates = [];
    for (const [sourceIndex, rawLine] of fullText.split('\n').entries()) {
        // Execution notes may concatenate several independent disclosures on
        // one physical line. Preserve the actionable test-scope contract as
        // its own sentence so a later parse-failure note cannot make the
        // whole metadata item too large for a small transport budget.
        const firstSentenceEnd = /^\s*(?:# )?\d+ test-file usage\(s\) hidden\b/.test(rawLine)
            ? rawLine.indexOf('. ')
            : -1;
        const contractLine = firstSentenceEnd >= 0
            ? rawLine.slice(0, firstSentenceEnd + 1)
            : rawLine;
        // Shell-shaped MCP/interactive results prefix disclosures with '# '.
        // Match their contents but retain the prefix in the preserved text.
        const evidenceLine = contractLine.replace(/^\s*# /, '').trim();
        if (!CONTRACT_LINE_RE.test(evidenceLine)) continue;
        const line = contractLine.trim();
        if (!line) continue;
        const priority = TRUST_LINE_RE.test(evidenceLine)
            ? 0
            : /^\d+ test-file usage\(s\) hidden\b/.test(evidenceLine) ? 1 : 2;
        candidates.push({ line, priority, sourceIndex });
    }
    return candidates;
}

function preservedContractMetadata(fullText, visibleText, options = {}) {
    const visible = new Set(visibleText.split('\n').map(line => line.trim()));
    const selected = [];
    let selectedChars = 0;
    let omitted = 0;
    const maxLines = options.maxLines ?? MAX_PRESERVED_CONTRACT_LINES;
    const maxChars = options.maxChars ?? MAX_PRESERVED_CONTRACT_CHARS;
    const candidates = contractCandidates(fullText).filter(candidate => !visible.has(candidate.line));
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
        find: 'Use --compact, --limit=N, --type, --file, --in, or --exclude to narrow the result.',
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
        find: 'Use compact=true, limit=<n>, type=, file=, in=, or exclude= to narrow the result.',
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
    const flags = full.match(/\b(?:sections|in|exclude|framework|prefix|method|server_only|client_only|file|limit|depth|direction|max_chars|compact|type)(?:=<n>|=true|=imports\|importers|=1|=)?/g) || [];
    return [...new Set(flags)].join('/');
}

// fix #367g: tier-section headers of the relationship answers
// (`CALLERS — CONFIRMED (12, ...)`, `CALLERS — RUNTIME DISPATCH (332 sites`,
// `UNVERIFIED CALL SITES (627) —`, `CALLEES (3):`, `BY FILE:`).
const SECTION_HEADER_RE = /^(?:[A-Z][A-Z-]*(?: [A-Z][A-Z-]*)*(?: — [A-Z][A-Z -]*)? \(\d[^)]*\)|[A-Z][A-Z ]+:$)/;
const SECTION_AWARE_COMMANDS = new Set(['show', 'impact']);

/**
 * Cut a relationship answer to `budget` chars keeping a representative head
 * of EVERY tier section instead of the first sections only: a long CONFIRMED
 * list must not push the UNVERIFIED band (or the excluded summary) out of
 * the answer. Section bodies are the indented lines under a header; lines
 * are handed out round-robin across sections, each cut section ends with a
 * `+N more` line, and the non-indented lines around sections (context,
 * ACCOUNT/CONTRACT/WARNING) stay in place. Returns null when the text has
 * no sections or its fixed parts alone do not fit (caller falls back to a
 * head cut).
 */
function sectionAwareCut(text, budget) {
    const lines = text.split('\n');
    const blocks = []; // { kind: 'fixed', line } | { kind: 'section', header, body }
    let current = null;
    let sawSection = false;
    for (const line of lines) {
        if (SECTION_HEADER_RE.test(line)) {
            current = { kind: 'section', header: line, body: [] };
            blocks.push(current);
            sawSection = true;
            continue;
        }
        if (current && /^\s/.test(line) && line.trim()) {
            current.body.push(line);
            continue;
        }
        current = null;
        blocks.push({ kind: 'fixed', line });
    }
    const sections = blocks.filter(block => block.kind === 'section');
    if (!sawSection || sections.every(section => section.body.length === 0)) return null;
    const moreLine = count => `  ... +${count} more`;
    const gapLine = '  ...';
    let used = 0;
    for (const block of blocks) {
        used += (block.kind === 'fixed' ? block.line.length : block.header.length) + 1;
    }
    // Reserve the worst-case `+N more` line and one gap marker per section.
    for (const section of sections) {
        used += moreLine(section.body.length).length + gapLine.length + 2;
    }
    if (used > budget) return null;
    // Selection order per section: the first numbered site entry and the
    // sub-headers above it come first, so a long preamble list (competing
    // definitions) cannot crowd every site out; then lines in source order.
    const indentOf = line => line.length - line.trimStart().length;
    const orders = new Map();
    for (const section of sections) {
        const first = section.body.findIndex(line => /^\s+\[\d+\]/.test(line));
        const order = [];
        if (first > 0) {
            const chain = [];
            let indent = indentOf(section.body[first]);
            for (let i = first - 1; i >= 0 && indent > 0; i--) {
                const lineIndent = indentOf(section.body[i]);
                if (lineIndent < indent) { chain.unshift(i); indent = lineIndent; }
            }
            order.push(...chain, first);
        }
        const seen = new Set(order);
        for (let i = 0; i < section.body.length; i++) if (!seen.has(i)) order.push(i);
        orders.set(section, { order, next: 0, taken: new Set() });
    }
    let progress = true;
    while (progress) {
        progress = false;
        for (const section of sections) {
            const state = orders.get(section);
            if (state.next >= state.order.length) continue;
            const index = state.order[state.next];
            const cost = section.body[index].length + 1;
            if (used + cost > budget) { state.next = state.order.length; continue; }
            used += cost;
            state.taken.add(index);
            state.next++;
            progress = true;
        }
    }
    const out = [];
    for (const block of blocks) {
        if (block.kind === 'fixed') { out.push(block.line); continue; }
        out.push(block.header);
        const { taken } = orders.get(block);
        let last = -1;
        for (let i = 0; i < block.body.length; i++) {
            if (!taken.has(i)) continue;
            if (i > last + 1 && last >= 0) out.push(gapLine);
            out.push(block.body[i]);
            last = i;
        }
        const omitted = block.body.length - taken.size;
        if (omitted > 0) out.push(moreLine(omitted));
    }
    return out.join('\n');
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
    trailingChars = 0,
} = {}) {
    const defaultLimit = BROAD_COMMANDS.has(command)
        ? BROAD_OUTPUT_CHARS
        : DEFAULT_OUTPUT_CHARS;
    const requested = maxChars || (all ? MAX_OUTPUT_CHARS : defaultLimit);
    const hardLimit = Math.min(requested, MAX_OUTPUT_CHARS);
    const limit = Math.max(0, hardLimit - trailingChars);
    if (!text) {
        return {
            text: '(no output)'.slice(0, limit),
            truncated: '(no output)'.length > limit,
            fullChars: 0,
            requestedLimit: hardLimit,
            contractMetadata: [],
            contractMetadataComplete: true,
        };
    }

    if (text.length <= limit) {
        return {
            text,
            truncated: false,
            fullChars: text.length,
            requestedLimit: hardLimit,
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
    const longNotice = `... OUTPUT TRUNCATED: ${text.length} chars total; hard limit ${hardLimit}. ` +
        `${narrowingHint(command, surface, params)} ${allHint}`;
    const compactNotice = `... OUTPUT TRUNCATED (${text.length}→${hardLimit}). ${compactGuidance}`;
    const shortNotice = `... OUTPUT TRUNCATED. Raise ${raiseHint}.`;

    // Trust lines (ACCOUNT/CONTRACT/WARNING/...) qualify the answer: room for
    // every one of them is reserved before any body text. Optional
    // disclosures (hidden test scope, notes, summaries) fill what is left.
    const candidates = contractCandidates(text);
    const trust = candidates.filter(candidate => candidate.priority === 0);
    const optional = candidates.filter(candidate => candidate.priority > 0)
        .sort((a, b) => a.priority - b.priority || a.sourceIndex - b.sourceIndex);
    const trustChars = trust.reduce((sum, candidate) => sum + candidate.line.length + 1, 0);
    const result = (rendered, appended, complete) => ({
        text: rendered,
        truncated: true,
        fullChars: text.length,
        requestedLimit: hardLimit,
        contractMetadata: appended,
        contractMetadataComplete: complete,
    });

    // Head cut of the body to `budget` chars; returns the kept text and the
    // number of complete source lines it holds.
    const headCut = (budget) => {
        if (budget <= 0) return { body: '', keptLines: 0 };
        const prefix = text.slice(0, budget);
        const lastNewline = prefix.lastIndexOf('\n');
        const body = lastNewline > budget * 0.8 ? prefix.slice(0, lastNewline) : prefix;
        const newlines = body.split('\n').length - 1;
        // The last line of the kept body is complete only when the cut fell
        // on a line boundary.
        const lastComplete = body.length === text.length || text[body.length] === '\n';
        return { body, keptLines: newlines + (body && lastComplete ? 1 : 0) };
    };

    // Render one layout: body, notice, then the metadata the body does not
    // show. Every trust line is reserved first; optional disclosures get up
    // to `optionalShare` chars (priority order) before the body; the body
    // takes the rest. Returns null when the notice and the trust lines alone
    // exceed the limit.
    const costOf = list => list.reduce((sum, candidate) => sum + candidate.line.length + 1, 0);
    const layout = (notice, heading, separator, optionalShare) => {
        const reserveFor = metadataChars => notice.length + (metadataChars > 0 ? heading.length + metadataChars : 0);
        if (reserveFor(trustChars) > limit) return null;
        const reservedOptional = [];
        let optionalChars = 0;
        const optionalRoom = Math.min(optionalShare, limit - reserveFor(trustChars) - (trustChars > 0 ? 0 : heading.length));
        for (const candidate of optional) {
            if (reservedOptional.length >= MAX_PRESERVED_CONTRACT_LINES) break;
            if (optionalChars + candidate.line.length + 1 > optionalRoom) continue;
            reservedOptional.push(candidate);
            optionalChars += candidate.line.length + 1;
        }
        const reserved = [...trust, ...reservedOptional];
        const pendingOf = cutState => reserved.filter(candidate => candidate.sourceIndex >= cutState.keptLines);
        let cut = headCut(limit - reserveFor(costOf(reserved)) - separator.length);
        // Reserved lines the kept body already shows need no room; spend it
        // on the body (one refinement pass; a wider cut only shows more).
        const firstPending = costOf(pendingOf(cut));
        if (firstPending < costOf(reserved)) {
            const wider = headCut(limit - reserveFor(firstPending) - separator.length);
            if (costOf(pendingOf(wider)) <= firstPending) cut = wider;
        }
        const metadata = pendingOf(cut);
        let rendered = cut.body ? `${cut.body}${separator}${notice}` : notice;
        let used = rendered.length + (metadata.length > 0 ? heading.length + costOf(metadata) : 0);
        let omitted = 0;
        const taken = new Set(reserved);
        for (const candidate of optional) {
            if (taken.has(candidate) || candidate.sourceIndex < cut.keptLines) continue;
            const cost = candidate.line.length + 1 + (metadata.length === 0 ? heading.length : 0);
            if (metadata.length >= trust.length + MAX_PRESERVED_CONTRACT_LINES || used + cost > limit) {
                omitted++;
                continue;
            }
            metadata.push(candidate);
            used += cost;
        }
        const appended = [];
        if (metadata.length > 0) {
            // Trust lines and optional disclosures keep their source order.
            metadata.sort((x, y) => x.sourceIndex - y.sourceIndex);
            rendered += heading;
            for (const candidate of metadata) {
                rendered += '\n' + candidate.line;
                appended.push(candidate.line);
            }
        }
        return result(rendered, appended, omitted === 0);
    };

    // The notice and the trust lines alone do not fit: the answer is
    // withheld rather than shown without its contract, and the notice says
    // so with the budget that would carry them.
    const withheld = () => {
        const flag = surface === 'mcp' ? 'max_chars' : '--max-chars';
        const noticeFor = (shown, needed) => `... OUTPUT TRUNCATED (${text.length}→${hardLimit}): answer withheld; ` +
            `${shown} of ${trust.length} trust line(s) shown. Raise ${flag} to at least ${needed}.`;
        // Smallest budget whose shortest layout carries every trust line.
        const needed = trailingChars + shortNotice.length + trustChars;
        let shown = 0;
        let used = noticeFor(trust.length, needed).length;
        const kept = [];
        for (const candidate of trust) {
            if (used + candidate.line.length + 1 > limit) break;
            kept.push(candidate.line);
            used += candidate.line.length + 1;
            shown++;
        }
        const notice = noticeFor(shown, needed);
        if (notice.length > limit) {
            // Shorter statements of the same fact; a budget number is never
            // cut mid-digit.
            const shorter = [
                `TRUNCATED: answer withheld; raise ${flag} to at least ${needed}.`,
                `Answer withheld; ${flag}>=${needed}`,
                `withheld; >=${needed}`,
            ].find(text => text.length <= limit);
            return result(shorter || '', [], false);
        }
        return result([notice, ...kept].join('\n'), kept, false);
    };

    // At tiny limits with no trust line to carry, the notice itself is the
    // answer: the flag that raises the budget.
    const bare = () => result((supportsAll
        ? (surface === 'mcp' ? 'all=true/max_chars=<n>' : '--all/--max-chars=N')
        : raiseHint).slice(0, limit), [], optional.length === 0);

    // First layout that carries every disclosure, else the one carrying the
    // most (a shorter notice can leave room for a scope warning).
    const pick = (...attempts) => {
        let best = null;
        for (const attempt of attempts) {
            const rendered = attempt();
            if (!rendered) continue;
            if (rendered.contractMetadataComplete) return rendered;
            if (!best || rendered.contractMetadata.length > best.contractMetadata.length) best = rendered;
        }
        return best;
    };

    if (compactBudget) {
        // Tiny transports: every disclosure outranks body detail.
        return pick(() => layout(compactNotice, '', '\n', limit), () => layout(shortNotice, '', '\n', limit)) ||
            (trust.length > 0 ? withheld() : bare());
    }

    if (SECTION_AWARE_COMMANDS.has(canonical)) {
        // Sections keep every non-indented line (trust lines included) in
        // place; trust lines inside a cut section body are appended, with
        // their room taken from the sections.
        let sectionBudget = limit - longNotice.length - 2;
        for (let attempt = 0; attempt < 2; attempt++) {
            const sectioned = sectionAwareCut(text, sectionBudget);
            if (sectioned === null) break;
            const visible = new Set(sectioned.split('\n').map(line => line.trim()));
            const missing = trust.filter(candidate => !visible.has(candidate.line));
            const missingChars = missing.reduce((sum, candidate) => sum + candidate.line.length + 1, 0);
            let rendered = `${sectioned}\n\n${longNotice}`;
            if (rendered.length + missingChars > limit) {
                sectionBudget -= missingChars;
                continue;
            }
            const appended = missing.map(candidate => candidate.line);
            let omitted = 0;
            let used = rendered.length + missingChars;
            for (const candidate of optional) {
                if (visible.has(candidate.line)) continue;
                if (used + candidate.line.length + 1 > limit) { omitted++; continue; }
                appended.push(candidate.line);
                used += candidate.line.length + 1;
            }
            if (appended.length > 0) rendered += '\n' + appended.join('\n');
            return result(rendered, appended, omitted === 0);
        }
    }

    const heading = '\n\nPRESERVED CONTRACT METADATA (from omitted output):';
    // Optional disclosures share at most half of the transport with the
    // trust lines, as the preservation budget always did.
    const optionalShare = Math.max(0, Math.min(MAX_PRESERVED_CONTRACT_CHARS, Math.floor(limit * 0.5)) - trustChars);
    return pick(() => layout(longNotice, heading, '\n\n', optionalShare),
        () => layout(compactNotice, '', '\n', optionalShare),
        () => layout(shortNotice, '', '\n', optionalShare)) ||
        (trust.length > 0 ? withheld() : bare());
}

module.exports = {
    DEFAULT_OUTPUT_CHARS,
    BROAD_OUTPUT_CHARS,
    MAX_OUTPUT_CHARS,
    applyOutputBudget,
    preservedContractMetadata,
    sectionAwareCut,
};
