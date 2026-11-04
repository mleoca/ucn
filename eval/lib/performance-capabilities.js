'use strict';

// An impact command that gained a reference band has a different workload.
// Keep the release comparison, and judge each capability cohort against its
// earliest working implementation. These references never follow the tree
// under test. Ordinary find/show/constructor/overload costs keep the release
// baseline; a larger answer alone does not create an exception.
const CAPABILITY_PINS = Object.freeze(require('./performance-capabilities.json'));
const BANDS = Object.freeze(['typeReferences', 'valueAccesses', 'propertyAccesses']);
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

/** A null result means this class has no capability comparison. */
function evaluateCapabilityCohorts(classId, measured, release, budgets, {
    repo, hostClass, pinnedCommit, capabilityPins = CAPABILITY_PINS,
} = {}) {
    const pin = capabilityPins.repos?.[repo];
    const comparison = pin?.classes?.[classId];
    if (!comparison || !release) return null;
    const failures = [], rows = [];
    const fail = message => failures.push(`${classId}: ${message}`);
    if (!['class-impact', 'value-impact'].includes(classId) || capabilityPins.schemaVersion !== 1 ||
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
    for (const cohort of cohorts) {
        const origin = capabilityPins.origins?.[cohort.origin];
        const reference = cohort.baselineByHost?.[hostClass];
        const indices = cohort.handles.map(handle => measured.handles.indexOf(handle));
        if (!origin || !/^[a-f0-9]{40}$/.test(origin.commit) ||
            !['release', 'first-capability', 'first-success'].includes(origin.kind) ||
            !(classId === 'class-impact' ? ['typeReferences'] : ['valueAccesses', 'propertyAccesses']).includes(cohort.capability) ||
            (origin.kind !== 'release' && origin.capability !== cohort.capability) ||
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

module.exports = { CAPABILITY_PINS, BANDS, impactCapabilities, evaluateCapabilityCohorts };
