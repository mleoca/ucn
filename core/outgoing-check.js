/** Validate changed calls against the project declarations they can reach. */
'use strict';

const { getCachedCalls } = require('./callers');
const { verifyCallSites } = require('./verify');
const { langTraits } = require('../languages');
const { unsettledReason, plainOwner, calleeIdentifierAt } = require('./call-fit');

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One reader and result cache for a check, including all changed symbols. */
function outgoingChecker(index, judge, addedLinesByFile) {
    const files = new Map();
    const checked = new Map();
    const receivers = new Map();
    const read = file => {
        if (!files.has(file)) files.set(file, {
            calls: getCachedCalls(index, file) || [], lines: index._getFileLines(file),
        });
        return files.get(file);
    };
    /**
     * The members a call site reaches through its receiver's established
     * type. The callee reader leaves a receiver it cannot type itself (a
     * construction, a chained call) as a candidate; the caller reader
     * settles that same site, and its confirmed tier is what a signature
     * change of the member is checked against. Asked per member name and
     * file, for the declarations of that name only.
     */
    const reachedThroughReceiver = (file, name, start) => {
        const key = `${file}\0${name}`;
        if (!receivers.has(key)) {
            const bySite = new Map();
            const members = (index.symbols.get(name) || []).filter(candidate =>
                candidate.className && Array.isArray(candidate.paramsStructured));
            for (const member of members) {
                let callers;
                try {
                    callers = index.findCallers(name, {
                        includeMethods: true, collectAccount: true,
                        targetDefinitions: [member], candidateFiles: new Set([file]),
                    }) || [];
                } catch (_) { callers = []; }
                for (const caller of callers) {
                    const at = caller.provenance?.facts?.site?.start;
                    if (caller.tier === 'unverified' || at == null || caller.file !== file) continue;
                    if (!bySite.has(at)) bySite.set(at, []);
                    bySite.get(at).push({ callee: member, provenance: caller.provenance });
                }
            }
            receivers.set(key, bySite);
        }
        return receivers.get(key).get(start) || [];
    };
    return (definition, change, added) => {
        const mismatches = [];
        const unsettled = [];
        if (!definition) return { mismatches, unsettled };
        const data = read(definition.file);
        const changedRanges = !added ? change?.changedCalls : null;
        const lines = addedLinesByFile.get(definition.relativePath) || new Set();
        const records = data.calls.filter(call => !call.isFunctionReference &&
            call.line >= definition.startLine && call.line <= definition.endLine &&
            (changedRanges ? changedRanges.some(range =>
                range.start <= (call.callStart ?? call.callSite?.start) &&
                range.end >= (call.callEnd ?? call.callSite?.end ?? call.callStart ?? call.callSite?.start))
                : added || lines.has(call.line)));
        if (records.length === 0) return { mismatches, unsettled };
        const byStart = new Map(records.map(call => [call.callStart ?? call.callSite?.start, call]));
        const callees = index.findCallees(definition, {
            collectAccount: true, includeMethods: true, siteStarts: new Set(byStart.keys()),
        });
        const relative = definition.relativePath;
        const language = index.files.get(definition.file)?.language;
        const positiveFamilies = new Set();
        const possibleFamilies = new Set();
        const issues = [];
        const familyOf = (callee, site) => {
            // The class's public constructor overloads are the call
            // interface; an initializer edge also projects their body.
            const owner = callee.initializerOf || (callee.type === 'class' ? callee.name : null);
            return JSON.stringify([site.start, callee.file, owner || callee.name,
                owner ? null : callee.className, callee.namespace, callee.enclosingType]);
        };
        const uncertain = (site, name, reason) => unsettled.push({ file: relative, line: site.line, column: site.column, name, reason });
        // Every (declaration, site) the change's calls are checked against.
        const reached = [];
        const answered = new Set();
        for (const callee of callees) {
            if (callee.functionReference) continue;
            for (const site of callee.siteProvenance || []) {
                const record = byStart.get(site.start);
                if (!record) continue;
                answered.add(site.start);
                reached.push({ callee, site, record, provenance: site.provenance });
            }
        }
        for (const entry of [...(callees.unverifiedCallees || []), ...(callees.initializerReviews || [])]) {
            // External packages are outside this fit check. A candidate
            // project declaration, however, cannot silently become READY.
            if (!(entry.ownerCount > 0 || entry.initializerOf || index.symbols.has(entry.name))) continue;
            for (const site of entry.siteProvenance || []) {
                const record = byStart.get(site.start);
                if (!record) continue;
                answered.add(site.start);
                const members = entry.initializerOf ? [] : reachedThroughReceiver(definition.file, entry.name, site.start);
                // One owner: members of several types at one site are not
                // an overload set, and none of them is established.
                const owners = new Set(members.map(member => `${member.callee.file}\0${member.callee.className}`));
                if (owners.size === 1) {
                    for (const member of members) {
                        reached.push({ callee: member.callee, site, record, provenance: member.provenance, receiverProven: true });
                    }
                } else uncertain(site, entry.name, entry.reason || 'outgoing-target-unresolved');
            }
        }
        for (const { callee, site, record, provenance, receiverProven } of reached) {
            const family = familyOf(callee, site);
            const key = JSON.stringify([definition.file, site.start, callee.file, callee.startLine,
                callee.sourceSpan?.start, callee.sourceSpan?.end, callee.name, callee.className,
                callee.type, callee.paramsStructured]);
            let result = checked.get(key);
            if (!result) {
                result = verifyCallSites(index, callee, [{
                    ...record, file: definition.file, relativePath: relative,
                    content: data.lines[site.line - 1] || '', calledAs: record.name,
                    provenance,
                    callerFile: definition.file, callerStartLine: definition.startLine,
                }]);
                checked.set(key, result);
            }
            for (const mismatch of result.mismatchDetails || []) {
                const counts = String(mismatch.expected || '').match(/\d+/g);
                const suppressed = judge.suppressed(mismatch, {
                    kind: 'arity', name: callee.name,
                    most: counts ? Number(counts[counts.length - 1]) : undefined,
                    span: mismatch.span, problem: mismatch.problem, indirect: mismatch.indirect,
                });
                // JavaScript deliberately permits omitted and extra
                // arguments. A declared count is not runtime proof.
                const flexible = langTraits(language)?.lenientCallArity === true;
                // A receiver's type names the member, not the overloads a
                // supertype outside the project can add to it.
                const openFamily = receiverProven && langTraits(index.files.get(callee.file)?.language)?.hasArityOverloads &&
                    !plainOwner(index, callee);
                // A function that is not a member, written with a receiver
                // parameter by convention, is called with that argument:
                // the count verify reads leaves it out.
                const calleeTraits = langTraits(index.files.get(callee.file)?.language);
                const conventionalReceiver = !callee.className && calleeTraits?.receiverParameterByConvention &&
                    (calleeTraits.selfParam || []).includes(callee.paramsStructured?.[0]?.name);
                if ((callee.decorators || []).length) uncertain(site, callee.name, 'decorated-call-interface');
                else if (conventionalReceiver) uncertain(site, callee.name, 'call-interface-unverified');
                else if (flexible) uncertain(site, callee.name, 'call-arity-not-enforced');
                else if (openFamily) uncertain(site, callee.name, 'overload-compatibility-unverified');
                else issues.push({ family, site, callee, mismatch: {
                    ...mismatch, column: site.column, target: callee.name, ...(suppressed && { unchecked: true }),
                } });
            }
            if (result.valid > 0 || result.uncertain > 0) possibleFamilies.add(family);
            // What verify could not count, by the shape of the call.
            const shape = result.callShapes?.[0];
            for (const row of result.uncertainDetails || []) {
                issues.push({ family, site, callee, reason: shape?.hasSpread ? 'argument-count-not-static'
                    : shape?.indirectKind ? 'indirect-call-arguments' : row.reason });
            }
            if (result.valid > 0) {
                const stableInvocation = !!changedRanges?.some(range => range.stableInvocation &&
                    range.start <= site.start && range.end >= (record.callEnd ?? record.callSite?.end ?? site.start));
                const reason = unsettledReason(index, callee, definition, record, result, { stableInvocation, receiverProven });
                if (!reason) positiveFamilies.add(family);
                else issues.push({ family, site, callee, reason });
            }
        }
        // Overload declarations describe one call interface. A positively
        // fitting alternative settles it; a merely possible alternative
        // prevents a different signature's arity from claiming a break.
        for (const issue of issues) {
            if (positiveFamilies.has(issue.family)) continue;
            if (issue.mismatch && !possibleFamilies.has(issue.family)) mismatches.push(issue.mismatch);
            else uncertain(issue.site, issue.callee.name, issue.reason || 'overload-compatibility-unverified');
        }
        // A bare call nothing answers: where the language lets every name a
        // file uses be read from it (trait `unboundCallee`), a name with no
        // binding is one the toolchain cannot resolve either.
        const unbound = langTraits(language)?.unboundCallee;
        if (typeof unbound === 'function') {
            for (const [start, record] of byStart) {
                if (answered.has(start) || record.isMethod || record.isConstructor) continue;
                const identifier = calleeIdentifierAt(index, definition.file, record.callSite);
                let missing;
                try { missing = !!identifier && identifier.text === record.name && unbound(identifier, index) === true; } catch (_) { missing = false; }
                if (missing) {
                    uncertain({ line: record.line, column: record.callSite?.column }, record.name, 'unresolved-callee');
                }
            }
        }
        const unique = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()]
            .sort((a, b) => a.line - b.line || (a.column || 0) - (b.column || 0) ||
                order(a.name || a.target || '', b.name || b.target || '') || order(a.reason || '', b.reason || ''));
        return { mismatches: unique(mismatches), unsettled: unique(unsettled) };
    };
}

module.exports = { outgoingChecker };
