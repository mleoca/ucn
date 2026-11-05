'use strict';

/**
 * Query-class performance board (fix #432).
 *
 * The steady-state board times one command (`context`) under absolute
 * budgets, so it passed while class, constructor, overloaded-method and
 * value-member queries regressed by up to two orders of magnitude (its own
 * fmt p95 7.7x, C++ class `find` 126x, Java overloaded `show` 23x). This
 * board measures those query classes on PINNED
 * handles and retains each class's comparison with the last release on the
 * same host class. Queries that gained a reference band or newly indexed declarations
 * also use the first working implementation, by pinned capability cohort:
 *
 *   orientation       `repo`
 *   class-find        `find <TypeName>`
 *   class-show        `show <type handle>`
 *   class-impact      `impact <type handle>`
 *   constructor-show  `show <constructor handle>`
 *   overload-show     `show <one member of a same-file overload family>`
 *   value-impact      `impact <field / constant / module value handle>`
 *
 * Handles are pinned rather than re-sampled per run: a sample drawn from each
 * engine's own index would compare different symbols whenever indexing
 * changes (5.5.1 does not index Python instance attributes, for example). The
 * pins are the selection `selectQueryHandles` makes on the pinned commit,
 * restricted to handles both engines index (`--select-query-board`).
 *
 * Baselines are the per-handle best of the isolated process samples, divided
 * by the host factor (the probe measures single-threaded JavaScript speed,
 * which is what a warm query spends), summarized as p50/p95 per class. They
 * are pinned per host class from the LAST RELEASE (`--engine-root <release
 * tree> --pin-query-baseline`), never from the tree under test, so the gate
 * reads "this tree against the release", not "this tree against itself".
 * The separate performance-capabilities.json records the historical capability
 * cohorts; it never replaces these raw release baselines. Existing impact
 * capabilities still use their original release measurements, and every
 * cohort keeps the same ratio and absolute-delta limits.
 * Re-pin only at a release boundary, from that release's tree; a red row is
 * never a reason to re-pin.
 */

const crypto = require('crypto');
const { CAPABILITY_PINS, CAPABILITIES, evaluateCapabilityCohorts } = require('./performance-capabilities');

// Plural keys: a group named `constructor` would read Object.prototype's.
const QUERY_GROUPS = Object.freeze(['types', 'constructors', 'overloads', 'values']);

const QUERY_CLASSES = Object.freeze([
    { id: 'orientation', group: null, command: 'repo' },
    { id: 'class-find', group: 'types', command: 'find' },
    { id: 'class-show', group: 'types', command: 'show' },
    { id: 'class-impact', group: 'types', command: 'impact' },
    { id: 'constructor-show', group: 'constructors', command: 'show' },
    { id: 'overload-show', group: 'overloads', command: 'show' },
    { id: 'value-impact', group: 'values', command: 'impact' },
].map(Object.freeze));

const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'record', 'union']);
const VALUE_KINDS = new Set(['field', 'private field', 'constant', 'state', 'variant', 'property']);
// Getter/setter pairs share a name and differ in parameters without being
// overloads.
const ACCESSOR_KINDS = new Set(['property', 'get', 'set', 'getter', 'setter']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function codeUnitCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Path, then line, then handle: the order every group is sampled in. */
function byLocation(a, b) {
    return codeUnitCompare(a.relativePath, b.relativePath) || a.startLine - b.startLine ||
        codeUnitCompare(a.handle, b.handle);
}

function handleOf(def) {
    return `${def.relativePath}:${def.startLine}:${def.name}`;
}

/** The trailing name of a `path:line:name` handle. */
function handleName(handle) {
    const at = handle.lastIndexOf(':');
    return at === -1 ? handle : handle.slice(at + 1);
}

/** Execute params for one query of a class (handle is null for orientation). */
function queryParams(queryClass, handle) {
    if (queryClass.group == null) return {};
    if (queryClass.command === 'find') return { name: handleName(handle) };
    return { name: handle };
}

function isConstructorDef(def) {
    return Boolean(def.isConstructor) || def.type === 'constructor' ||
        def.memberType === 'constructor';
}

/**
 * The query group a definition belongs to, or null. Overload families are
 * decided over the whole index (see `selectQueryHandles`), so a callable is
 * only a 'callable' candidate here.
 */
function definitionGroup(def) {
    if (!def || !def.name || !IDENTIFIER.test(def.name) || def.name.length < 2) return null;
    if (!def.relativePath || !Number.isInteger(def.startLine)) return null;
    if (isConstructorDef(def)) return 'constructors';
    if (TYPE_KINDS.has(def.type)) return 'types';
    if (def.params === undefined && (VALUE_KINDS.has(def.type) || VALUE_KINDS.has(def.memberType))) {
        return 'values';
    }
    if (def.params !== undefined && !ACCESSOR_KINDS.has(def.type) &&
        !ACCESSOR_KINDS.has(def.memberType)) {
        return 'callable';
    }
    return null;
}

function normalizedParams(def) {
    return String(def.params ?? '').replace(/\s+/g, '');
}

/**
 * Candidate handles per group from one index: production definitions only
 * (`isTestPath`), one representative per overload family. An overload family
 * is two or more callables (constructors excluded: they are their own class)
 * of one name and owner declared in ONE file with different parameter lists
 * (Java/C#/C++ overloads, TS overload signatures, Python `@overload` stubs);
 * same-file keeps namesakes of separate packages,
 * modules or namespaces apart, and identical parameter lists keep a C/C++
 * declaration beside its definition from counting as an overload.
 *
 * Returns { types, constructors, overloads, values }: arrays of
 * { handle, relativePath, startLine, activity } sorted by location (path,
 * line), `activity` being the number of files
 * calling the name (types: construction calls), 0 for values.
 */
function queryCandidates(index, { isTestPath = () => false } = {}) {
    const groups = { types: [], constructors: [], overloads: [], values: [] };
    const seen = new Set();
    const families = new Map();
    const activityOf = name => index.getCalleeFiles?.(name)?.size || 0;
    for (const [, defs] of index.symbols) {
        for (const def of defs) {
            const group = definitionGroup(def);
            if (!group || isTestPath(def.relativePath)) continue;
            const handle = handleOf(def);
            if (seen.has(`${group}\0${handle}`)) continue;
            seen.add(`${group}\0${handle}`);
            if (group === 'callable') {
                const key = `${def.relativePath}\0${def.className || ''}\0${def.name}`;
                let family = families.get(key);
                if (!family) families.set(key, family = []);
                family.push(def);
                continue;
            }
            groups[group].push({
                handle,
                relativePath: def.relativePath,
                startLine: def.startLine,
                activity: group === 'values' ? 0 : activityOf(def.name),
            });
        }
    }
    for (const family of families.values()) {
        if (new Set(family.map(normalizedParams)).size < 2) continue;
        const first = [...family].sort((a, b) =>
            a.startLine - b.startLine || codeUnitCompare(handleOf(a), handleOf(b)))[0];
        groups.overloads.push({
            handle: handleOf(first),
            relativePath: first.relativePath,
            startLine: first.startLine,
            activity: activityOf(first.name),
        });
    }
    for (const group of QUERY_GROUPS) groups[group].sort(byLocation);
    return groups;
}

/**
 * Deterministic pick from location-sorted candidates: the `topCount` most
 * active (calling-file count, then location), then evenly spaced picks from the rest
 * so one hot file cannot dominate. Values carry no activity and are spaced
 * only.
 */
function pickHandles(candidates, perGroup, topCount) {
    if (candidates.length <= perGroup) return candidates.map(c => c.handle);
    const top = candidates.filter(c => c.activity > 0)
        .sort((a, b) => b.activity - a.activity || byLocation(a, b))
        .slice(0, Math.min(topCount, perGroup));
    const taken = new Set(top.map(c => c.handle));
    const rest = candidates.filter(c => !taken.has(c.handle));
    const need = perGroup - top.length;
    const spaced = [];
    const step = rest.length / need;
    for (let i = 0; i < need; i++) spaced.push(rest[Math.floor(i * step)].handle);
    return [...top.map(c => c.handle), ...spaced];
}

/**
 * The pinned selection for one repository. `allowed`, when given, is the set
 * of handles the comparison engine also indexes in the same group
 * (`${group}\0${handle}` keys), so both engines answer the same symbols.
 */
function selectQueryHandles(candidates, { perGroup = 6, topCount = 2, allowed = null } = {}) {
    const selected = {};
    for (const group of QUERY_GROUPS) {
        const pool = (Object.hasOwn(candidates, group) ? candidates[group] : []).filter(c =>
            !allowed || allowed.has(`${group}\0${c.handle}`));
        const picked = pickHandles(pool, perGroup, group === 'values' ? 0 : topCount);
        if (picked.length) selected[group] = picked;
    }
    return selected;
}

/** Group-qualified keys of every candidate, for `selectQueryHandles({ allowed })`. */
function candidateKeys(candidates) {
    const keys = new Set();
    for (const group of QUERY_GROUPS) {
        for (const c of Object.hasOwn(candidates, group) ? candidates[group] : []) {
            keys.add(`${group}\0${c.handle}`);
        }
    }
    return keys;
}

/** Fingerprint of the handles a class was measured on. */
function boardKey(handles) {
    return crypto.createHash('sha1').update(handles.join('\n')).digest('hex').slice(0, 12);
}

/** The queries one process runs, in a fixed order, for a pinned board. */
function boardQueries(pins) {
    const queries = [];
    for (const queryClass of QUERY_CLASSES) {
        const pinned = pins.handles || {};
        const handles = queryClass.group == null ? [null]
            : (Object.hasOwn(pinned, queryClass.group) ? pinned[queryClass.group] : []);
        for (const handle of handles) {
            queries.push({ classId: queryClass.id, command: queryClass.command, handle,
                params: queryParams(queryClass, handle) });
        }
    }
    return queries;
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round3(value) { return Number(value.toFixed(3)); }

/**
 * Merge the per-process class timings of one repository: every handle keeps
 * its best (fastest) sample, the capability estimate the throughput guard
 * uses too (contention only ever slows a query down), and the class is
 * summarized over those bests. `hostFactor` scales to reference hardware.
 *
 * @param {Array<object>} runs each run's `queryClasses`:
 *   { [classId]: { handles: string[], samplesMs: number[], errors: number } }
 */
function summarizeQueryClasses(runs, hostFactor = 1) {
    const factor = Number.isFinite(hostFactor) && hostFactor > 0 ? hostFactor : 1;
    const merged = {};
    for (const queryClass of QUERY_CLASSES) {
        const perRun = runs.map(run => run?.[queryClass.id]).filter(Boolean);
        if (!perRun.length) continue;
        const handles = perRun[0].handles;
        const best = handles.map((_, i) => Math.min(...perRun.map(run => run.samplesMs[i])));
        const p50 = percentile(best, 0.5);
        const p95 = percentile(best, 0.95);
        merged[queryClass.id] = {
            handles,
            boardKey: boardKey(handles),
            processSamples: perRun.length,
            bestMs: best.map(round3),
            normalizedBestMs: best.map(value => round3(value / factor)),
            // Every process must supply the band, including a slower sample.
            capabilities: handles.map((_, i) => Object.fromEntries(CAPABILITIES.map(band =>
                [band, perRun.every(run => run.handles[i] === handles[i] && run.capabilities?.[i]?.[band] === true)]))),
            p50Ms: round3(p50),
            p95Ms: round3(p95),
            normalizedP50Ms: round3(p50 / factor),
            normalizedP95Ms: round3(p95 / factor),
            errors: perRun.reduce((sum, run) => sum + (run.errors || 0), 0),
            errorDetails: perRun.flatMap(run => run.errorDetails || []).slice(0, 5),
            slowest: handles
                .map((handle, i) => ({ handle, ms: round3(best[i]) }))
                .sort((a, b) => b.ms - a.ms || codeUnitCompare(String(a.handle), String(b.handle)))
                .slice(0, 3),
        };
    }
    return merged;
}

/**
 * Judge each measured class against the release baseline of this host class.
 * A class fails when its host-normalized p50 or p95 exceeds the release value
 * by more than `maxQueryClassRatio` AND by more than `minQueryClassDeltaMs`
 * (a 2 ms query reading 3 ms is timer noise, not a regression). Failures are
 * release-blocking when `requireQueryClassBaselines`, warnings otherwise.
 * Query errors always fail; a class measured on handles other than the
 * baseline's (`boardKey`) fails on gating runs, because the ratio would
 * compare different symbols.
 */
function evaluateQueryClasses(summary, baseline, budgets, { repo, hostClass, capabilities = true, capabilityPins = CAPABILITY_PINS } = {}) {
    const failures = [];
    const warnings = [];
    const rows = {};
    const gate = message => (budgets.requireQueryClassBaselines ? failures : warnings).push(message);
    if (summary && Object.keys(summary).length && !baseline) {
        warnings.push(`no pinned release query baseline for ${repo}` +
            `${hostClass ? ` on ${hostClass}` : ''}; query classes are reported, not gated`);
    }
    for (const [classId, measured] of Object.entries(summary || {})) {
        const row = { ...measured, baseline: null, p50Ratio: null, p95Ratio: null, failed: false };
        rows[classId] = row;
        if (measured.errors > 0) {
            failures.push(`${classId}: ${measured.errors} query error(s)` +
                `${measured.errorDetails?.length ? ` (${measured.errorDetails.join('; ')})` : ''}`);
            row.failed = true;
        }
        const base = baseline?.classes?.[classId];
        if (!baseline) continue;
        if (!base) {
            if (capabilities && capabilityPins.repos?.[repo]?.classes?.[classId]) {
                gate(`${classId}: missing release baseline for capability comparison`);
                row.failed = true;
            } else warnings.push(`${classId}: no release baseline for this class`);
            continue;
        }
        row.baseline = base;
        if (base.boardKey && base.boardKey !== measured.boardKey) {
            gate(`${classId}: measured handles (board ${measured.boardKey}) differ from the ` +
                `release baseline's (board ${base.boardKey}); re-pin both from one selection`);
            row.failed = true;
            continue;
        }
        row.p50Ratio = base.p50Ms > 0 ? round3(measured.normalizedP50Ms / base.p50Ms) : null;
        row.p95Ratio = base.p95Ms > 0 ? round3(measured.normalizedP95Ms / base.p95Ms) : null;
        const releaseFailures = [];
        for (const [label, ratio, value, reference] of [
            ['p50', row.p50Ratio, measured.normalizedP50Ms, base.p50Ms],
            ['p95', row.p95Ratio, measured.normalizedP95Ms, base.p95Ms],
        ]) {
            if (ratio == null || ratio <= budgets.maxQueryClassRatio) continue;
            if (value - reference <= budgets.minQueryClassDeltaMs) continue;
            releaseFailures.push(`${classId} ${label} ${value}ms is ${ratio}x the release ${baseline.engine || 'baseline'} ` +
                `${reference}ms (limit ${budgets.maxQueryClassRatio}x and +${budgets.minQueryClassDeltaMs}ms)`);
        }
        const cohorts = capabilities ? evaluateCapabilityCohorts(classId, measured, baseline, budgets,
            { repo, hostClass, pinnedCommit: QUERY_BOARD_PINS[repo]?.commit, capabilityPins }) : null;
        if (cohorts) {
            row.releaseComparison = { failed: releaseFailures.length > 0, failures: releaseFailures };
            row.capabilityCohorts = cohorts.rows;
            row.comparisonBasis = 'capability-cohorts';
        }
        for (const failure of cohorts ? cohorts.failures : releaseFailures) {
            gate(failure);
            row.failed = true;
        }
    }
    return { failures, warnings, rows };
}

/**
 * Pinned boards (performance-query-board.json), by repository: the commit the
 * handles were selected on, the handles per group, and the release baseline
 * per host class. Data only; regenerate with the two runner modes above.
 */
const QUERY_BOARD_PINS = Object.freeze(require('./performance-query-board.json'));

/** The pinned board for a repository at its pinned commit, or null. */
function pinnedQueryBoard(repo, pins = QUERY_BOARD_PINS) {
    const pin = pins[repo.name];
    if (!pin) return null;
    if (pin.commit !== repo.commit) {
        throw new Error(`query board for ${repo.name} was pinned at ${pin.commit}, ` +
            `but the repository is pinned at ${repo.commit}; re-select and re-pin it`);
    }
    return pin;
}

module.exports = {
    QUERY_GROUPS,
    QUERY_CLASSES,
    QUERY_BOARD_PINS,
    definitionGroup,
    queryCandidates,
    selectQueryHandles,
    candidateKeys,
    boardKey,
    boardQueries,
    queryParams,
    handleName,
    summarizeQueryClasses,
    evaluateQueryClasses,
    pinnedQueryBoard,
};
