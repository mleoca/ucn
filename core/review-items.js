/**
 * core/review-items.js - How much is there to look at?
 *
 * Unverified caller candidates are not all the same amount of work. A site
 * the engine could not bind is one thing to check. A dispatch family (an
 * interface call that may reach any implementation, a template the
 * compiler instantiates) is ONE boundary with a known reason, however many
 * sites it lists. A reader reviews the boundary, not each site.
 *
 * One counter, shared by the pre-commit check, the caller formatter and
 * the oracle evaluation, so the three cannot disagree about the burden.
 */

'use strict';

/**
 * Why a caller candidate is unverified, as one of three classes:
 * 'runtime-dispatch' (the implementation is selected at runtime through a
 * named boundary), 'compile-time-dispatch' (the compiler selects it),
 * 'actionable-ambiguity' (something a reader can settle). The class the
 * engine recorded wins; a possible-dispatch site with a named boundary is
 * runtime dispatch.
 */
function uncertaintyClassOf(site) {
    return site.uncertaintyClass ||
        (site.reason === 'possible-dispatch' && site.dispatchVia ? 'runtime-dispatch' : 'actionable-ambiguity');
}

/** Unverified entries by class: { actionable, runtime, compileTime }. */
function partitionUnverified(unverified) {
    const parts = { actionable: [], runtime: [], compileTime: [] };
    for (const site of Array.isArray(unverified) ? unverified : []) {
        const kind = uncertaintyClassOf(site);
        if (kind === 'runtime-dispatch') parts.runtime.push(site);
        else if (kind === 'compile-time-dispatch') parts.compileTime.push(site);
        else parts.actionable.push(site);
    }
    return parts;
}

/** Key of the family a runtime-dispatch site belongs to. */
function runtimeFamilyKey(site) {
    return `${site.dispatchVia || ''}\0${site.dispatchCandidates ?? ''}\0` +
        `${site.externalContract ? 'external' : 'project'}`;
}

/** Key of the family a compile-time-dispatch site belongs to. */
function compileTimeFamilyKey(site) {
    return `${site.dispatchFamily || ''}\0${site.dispatchCandidates ?? ''}`;
}

/**
 * @param {object[]} unverified - unverified caller entries
 * @returns {{actionable, runtimeDispatchSites, runtimeDispatchGroups,
 *   compileTimeDispatchSites, compileTimeDispatchGroups, items}}
 *   `items` = actionable sites + one per dispatch family.
 */
function reviewItemsOf(unverified) {
    const { actionable: open, runtime, compileTime } = partitionUnverified(unverified);
    const actionable = open.length;
    const runtimeDispatchGroups = new Set(runtime.map(runtimeFamilyKey)).size;
    const compileTimeDispatchGroups = new Set(compileTime.map(compileTimeFamilyKey)).size;
    return {
        actionable,
        runtimeDispatchSites: runtime.length,
        runtimeDispatchGroups,
        compileTimeDispatchSites: compileTime.length,
        compileTimeDispatchGroups,
        items: actionable + runtimeDispatchGroups + compileTimeDispatchGroups,
    };
}

module.exports = {
    reviewItemsOf, uncertaintyClassOf, partitionUnverified, runtimeFamilyKey, compileTimeFamilyKey,
};
