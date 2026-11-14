/** Validate changed calls against the project declarations they can reach. */
'use strict';

const { getCachedCalls } = require('./callers');
const { verifyCallSites } = require('./verify');
const { langTraits } = require('../languages');
const { positivelyFits } = require('./call-fit');

/** One reader and result cache for a check, including all changed symbols. */
function outgoingChecker(index, judge, addedLinesByFile) {
    const files = new Map();
    const checked = new Map();
    const read = file => {
        if (!files.has(file)) files.set(file, {
            calls: getCachedCalls(index, file) || [], lines: index._getFileLines(file),
        });
        return files.get(file);
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
        for (const callee of callees) {
            if (callee.functionReference) continue;
            for (const site of callee.siteProvenance || []) {
                const record = byStart.get(site.start);
                if (!record) continue;
                const family = familyOf(callee, site);
                const key = JSON.stringify([definition.file, site.start, callee.file, callee.startLine,
                    callee.sourceSpan?.start, callee.sourceSpan?.end, callee.name, callee.className,
                    callee.type, callee.paramsStructured]);
                let result = checked.get(key);
                if (!result) {
                    result = verifyCallSites(index, callee, [{
                        ...record, file: definition.file, relativePath: relative,
                        content: data.lines[site.line - 1] || '', calledAs: record.name,
                        provenance: site.provenance,
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
                    const flexible = langTraits(index.files.get(definition.file)?.language)?.lenientCallArity === true;
                    if ((callee.decorators || []).length) uncertain(site, callee.name, 'decorated-call-interface');
                    else if (flexible) uncertain(site, callee.name, 'call-arity-not-enforced');
                    else issues.push({ family, site, callee, mismatch: {
                        ...mismatch, column: site.column, target: callee.name, ...(suppressed && { unchecked: true }),
                    } });
                }
                if (result.valid > 0 || result.uncertain > 0) possibleFamilies.add(family);
                for (const row of result.uncertainDetails || []) issues.push({ family, site, callee, reason: row.reason });
                if (result.valid > 0) {
                    const preserved = changedRanges?.some(range => range.stableInvocation &&
                        range.start <= site.start && range.end >= (record.callEnd ?? record.callSite?.end ?? site.start));
                    if (positivelyFits(index, callee, definition, record, result, preserved)) positiveFamilies.add(family);
                    else issues.push({ family, site, callee, reason: 'argument-compatibility-unverified' });
                }
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
        for (const entry of [...(callees.unverifiedCallees || []), ...(callees.initializerReviews || [])]) {
            // External packages are outside this fit check. A candidate
            // project declaration, however, cannot silently become READY.
            if (!(entry.ownerCount > 0 || entry.initializerOf || index.symbols.has(entry.name))) continue;
            for (const site of entry.siteProvenance || []) {
                if (byStart.has(site.start)) uncertain(site, entry.name, entry.reason || 'outgoing-target-unresolved');
            }
        }
        const unique = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()]
            .sort((a, b) => a.line - b.line || (a.column || 0) - (b.column || 0) || ((a.name || a.target || '') < (b.name || b.target || '') ? -1 : (a.name || a.target || '') > (b.name || b.target || '') ? 1 : 0));
        return { mismatches: unique(mismatches), unsettled: unique(unsettled) };
    };
}

module.exports = { outgoingChecker };
