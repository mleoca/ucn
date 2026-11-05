'use strict';

// A new reference band or newly indexed declaration changes the workload.
// Keep the release comparison beside the earliest working implementation
// of that capability. These references never follow the tree under test.
// More proof work or confidence changes alone do not create an exception.
const CAPABILITY_PINS = Object.freeze(require('./performance-capabilities.json'));
const BANDS = Object.freeze(['typeReferences', 'valueAccesses', 'propertyAccesses']);
const CAPABILITIES = Object.freeze([...BANDS, 'declarationInventory', 'constructorDeclarations']);
const count = value => Number.isInteger(value) && value >= 0;
const round = value => Number(value.toFixed(3));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

/** Read only after the command timer; never retain its potentially large answer. */
function impactCapabilities(result) {
    return Object.fromEntries(BANDS.map(name => {
        const band = result?.[name];
        let valid = !!band && count(band.confirmedCount) && count(band.unverifiedCount) &&
            band.totalCandidates === band.confirmedCount + band.unverifiedCount &&
            Array.isArray(band.byFile) && Array.isArray(band.unverifiedSites) &&
            band.unverifiedSites.length === band.unverifiedCount && count(band.excluded?.total);
        let confirmed = 0;
        if (valid) for (const group of band.byFile) {
            if (!Array.isArray(group.sites) || group.count !== group.sites.length) { valid = false; break; }
            confirmed += group.count;
        }
        if (valid && (confirmed !== band.confirmedCount || band.account && band.account.conserved !== true)) valid = false;
        return [name, valid];
    }));
}

// Source locations and declaration kinds form the capability inventory.
// Call confidence can change without removing a declaration from the answer.
function inventoryKey(row) {
    if (!row || typeof row.file !== 'string' || !row.file || !Number.isInteger(row.line) || row.line < 1 ||
        typeof row.name !== 'string' || !row.name || typeof row.kind !== 'string' || !row.kind ||
        typeof row.constructor !== 'boolean') return null;
    return JSON.stringify([row.file, row.line, row.name, row.kind, row.constructor]);
}

function inventoryKeys(inventory) {
    if (!Array.isArray(inventory) || !inventory.length) return null;
    const keys = inventory.map(inventoryKey);
    return keys.some(key => key === null) || new Set(keys).size !== keys.length ? null : new Set(keys);
}

/** Check after the timer, against the independently established source inventory. */
function declarationCapabilities(result, inventory) {
    const expected = inventoryKeys(inventory);
    let valid = !!expected && Array.isArray(result) && result.length === expected.size;
    const seen = new Set();
    if (valid) for (const row of result) {
        const key = inventoryKey({ file: row?.relativePath, line: row?.startLine,
            name: row?.name, kind: row?.type, constructor: row?.isConstructor === undefined ? false : row.isConstructor });
        const counts = row?.usageCounts;
        if (!key || !expected.has(key) || seen.has(key) ||
            counts?.countKind !== 'target-call-candidates-with-tier-breakdown-excludes-references' ||
            !['total', 'calls', 'definitions', 'imports', 'references', 'confirmedCalls',
                'unverifiedCalls', 'otherTargetCalls'].every(field => count(counts[field])) ||
            counts.confirmedCalls + counts.unverifiedCalls !== counts.calls ||
            counts.total !== counts.calls + counts.definitions + counts.imports + counts.references) {
            valid = false;
            break;
        }
        seen.add(key);
    }
    return { declarationInventory: valid,
        constructorDeclarations: valid && inventory.some(row => row.kind === 'constructor' && row.constructor) };
}

/** A null result means this class has no capability comparison. */
function evaluateCapabilityCohorts(classId, measured, release, budgets, {
    repo, hostClass, pinnedCommit, capabilityPins = CAPABILITY_PINS,
} = {}) {
    const pin = capabilityPins.repos?.[repo];
    const comparison = pin?.classes?.[classId];
    if (!comparison || !release) return null;
    const failures = [], rows = [];
    const fail = message => failures.push(`${classId}: ${message}`);
    if (!['class-impact', 'value-impact', 'class-find'].includes(classId) || capabilityPins.schemaVersion !== 1 ||
        release.engine !== capabilityPins.releaseEngine || pin.commit !== pinnedCommit ||
        comparison.boardKey !== measured.boardKey) {
        fail('capability reference does not match the release, repository or measured handles');
        return { failures, rows };
    }
    const cohorts = comparison.cohorts;
    if (!Array.isArray(cohorts) || !cohorts.length || cohorts.some(cohort => !Array.isArray(cohort.handles))) {
        fail('capability cohorts must list their measured handles');
        return { failures, rows };
    }
    const handles = cohorts.flatMap(cohort => cohort.handles);
    if (handles.length !== measured.handles.length ||
        new Set(handles).size !== handles.length || handles.some(handle => !measured.handles.includes(handle)) ||
        measured.normalizedBestMs?.length !== measured.handles.length ||
        measured.normalizedBestMs.some(value => !Number.isFinite(value) || value < 0)) {
        fail('capability cohorts must cover every measured handle exactly once');
        return { failures, rows };
    }
    if (classId === 'class-find' && (!comparison.inventory ||
        Object.keys(comparison.inventory).length !== measured.handles.length ||
        measured.handles.some(handle => !inventoryKeys(comparison.inventory[handle])))) {
        fail('declaration comparison must pin a complete, unique inventory for every handle');
        return { failures, rows };
    }
    const allowed = classId === 'class-impact' ? ['typeReferences'] : classId === 'value-impact'
        ? ['valueAccesses', 'propertyAccesses'] : ['declarationInventory', 'constructorDeclarations'];
    for (const cohort of cohorts) {
        const origin = capabilityPins.origins?.[cohort.origin];
        const reference = cohort.baselineByHost?.[hostClass];
        const indices = cohort.handles.map(handle => measured.handles.indexOf(handle));
        if (!origin || !/^[a-f0-9]{40}$/.test(origin.commit) ||
            !['release', 'first-capability', 'first-success'].includes(origin.kind) ||
            !allowed.includes(cohort.capability) ||
            (origin.kind !== 'release' && origin.capability !== cohort.capability) ||
            (classId === 'class-find' && (cohort.capability === 'declarationInventory'
                ? origin.kind !== 'release' || cohort.handles.some(handle =>
                    comparison.inventory[handle].some(row => row.constructor))
                : origin.kind !== 'first-capability' || cohort.handles.some(handle =>
                    !comparison.inventory[handle].some(row => row.kind === 'constructor' && row.constructor)))) ||
            !cohort.handles.length || !Array.isArray(reference) || reference.length !== indices.length ||
            reference.some(value => !Number.isFinite(value) || value < 0)) {
            fail(`missing or invalid ${cohort.origin} reference for ${hostClass}`);
            continue;
        }
        const values = indices.map(i => measured.normalizedBestMs[i]);
        const missing = indices.filter(i => measured.capabilities?.[i]?.[cohort.capability] !== true);
        const row = {
            origin: cohort.origin, engine: origin.commit, kind: origin.kind, capability: cohort.capability,
            handles: cohort.handles, p50Ms: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)),
            baselineP50Ms: round(percentile(reference, 0.5)), baselineP95Ms: round(percentile(reference, 0.95)),
            failed: missing.length > 0,
        };
        rows.push(row);
        if (missing.length) fail(`${cohort.capability} missing or inconsistent for ${missing.map(i => measured.handles[i]).join(', ')}`);
        for (const label of ['p50', 'p95']) {
            const value = row[`${label}Ms`], base = row[`baseline${label[0].toUpperCase()}${label.slice(1)}Ms`];
            const ratio = base > 0 ? round(value / base) : null;
            row[`${label}Ratio`] = ratio;
            if (value > base * budgets.maxQueryClassRatio && value - base > budgets.minQueryClassDeltaMs) {
                row.failed = true;
                fail(`${cohort.origin} ${label} ${value}ms exceeds ${origin.commit.slice(0, 12)} ` +
                    `${base}ms (limit ${budgets.maxQueryClassRatio}x and +${budgets.minQueryClassDeltaMs}ms)`);
            }
        }
    }
    return { failures, rows };
}

module.exports = { CAPABILITY_PINS, BANDS, CAPABILITIES, impactCapabilities, declarationCapabilities, evaluateCapabilityCohorts };
