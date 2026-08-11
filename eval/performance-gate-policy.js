'use strict';

const DEFAULT_BUDGETS = Object.freeze({
    minColdLocPerSec: 10000,
    // CPU time is process-wide (including worker threads), so this floor is
    // stable across runner parallelism. Set from the measured post-fix native
    // board baseline with roughly 1.5x regression headroom.
    minColdLocPerCpuSec: 3000,
    // Exploratory one-sample runs keep wall time diagnostic. Publish and PR
    // scripts turn this on and aggregate three isolated processes, making
    // actual agent latency a release requirement without treating one noisy
    // process as a regression.
    requireColdWallThroughput: false,
    maxCacheLoadMs: 1500,
    maxFirstQueryMs: 500,
    maxWarmColdRatio: 0.65,
    maxQueryP50Ms: 75,
    maxQueryP95Ms: 250,
    maxBuildRssMb: 1536,
    maxBoardRssMb: 1536,
});

function percentile(values, fraction) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeSamples(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { count: 0, min: 0, median: 0, p95: 0, max: 0, spread: 0 };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const median = percentile(values, 0.5);
    return {
        count: values.length,
        min: Number(min.toFixed(3)),
        median: Number(median.toFixed(3)),
        p95: Number(percentile(values, 0.95).toFixed(3)),
        max: Number(max.toFixed(3)),
        spread: Number((max - min).toFixed(3)),
    };
}

/**
 * Evaluate one repository without confusing a slow shared runner with a UCN
 * regression. For a substantial cold build, startup fails only when BOTH the
 * fixed agent-latency ceiling and the host-normalized warm/cold ratio regress.
 * Small projects remain absolute-latency gated because fixed costs dominate
 * their ratios.
 */
function evaluatePerformanceBudgets(metrics, budgets = DEFAULT_BUDGETS) {
    const failures = [];
    const warnings = [];

    if (metrics.lines >= 5000 &&
        metrics.coldLocPerCpuSec < budgets.minColdLocPerCpuSec) {
        failures.push(`cold CPU throughput ${metrics.coldLocPerCpuSec} LOC/CPU-s < ` +
            budgets.minColdLocPerCpuSec);
    }
    if (metrics.lines >= 5000 && metrics.coldLocPerSec < budgets.minColdLocPerSec) {
        const message = `cold wall throughput ${metrics.coldLocPerSec} LOC/s < ` +
            `${budgets.minColdLocPerSec}`;
        if (budgets.requireColdWallThroughput) {
            failures.push(message);
        } else {
            warnings.push(`${message}; inspect runner contention and worker telemetry`);
        }
    }
    if (metrics.expectedFiles != null && metrics.files !== metrics.expectedFiles) {
        failures.push(`workload file count ${metrics.files} != pinned ${metrics.expectedFiles}`);
    }
    if (metrics.expectedLines != null && metrics.lines !== metrics.expectedLines) {
        failures.push(`workload LOC ${metrics.lines} != pinned ${metrics.expectedLines}`);
    }
    if (metrics.cacheLoadMs > budgets.maxCacheLoadMs) {
        failures.push(`cache load ${metrics.cacheLoadMs}ms > ${budgets.maxCacheLoadMs}ms`);
    }

    const absoluteStartupSlow = metrics.firstQueryMs > budgets.maxFirstQueryMs;
    const substantialProject = metrics.lines >= 5000;
    const ratioStartupSlow = substantialProject &&
        metrics.warmColdRatio > budgets.maxWarmColdRatio;
    if (!substantialProject) {
        if (absoluteStartupSlow) {
            failures.push(`first semantic query ${metrics.firstQueryMs}ms > ${budgets.maxFirstQueryMs}ms`);
        }
    } else if (absoluteStartupSlow && ratioStartupSlow) {
        failures.push(`semantic startup ${metrics.firstQueryMs}ms > ${budgets.maxFirstQueryMs}ms and ` +
            `warm/cold ratio ${metrics.warmColdRatio} > ${budgets.maxWarmColdRatio}`);
    } else if (absoluteStartupSlow) {
        warnings.push(`first semantic query exceeded ${budgets.maxFirstQueryMs}ms, but host-normalized ` +
            `ratio ${metrics.warmColdRatio} stayed within ${budgets.maxWarmColdRatio}`);
    } else if (ratioStartupSlow) {
        warnings.push(`warm/cold ratio exceeded ${budgets.maxWarmColdRatio}, but first semantic query ` +
            `stayed within ${budgets.maxFirstQueryMs}ms`);
    }

    if (metrics.queryP50Ms > budgets.maxQueryP50Ms) {
        failures.push(`query p50 ${metrics.queryP50Ms}ms > ${budgets.maxQueryP50Ms}ms`);
    }
    if (metrics.queryP95Ms > budgets.maxQueryP95Ms) {
        failures.push(`query p95 ${metrics.queryP95Ms}ms > ${budgets.maxQueryP95Ms}ms`);
    }
    if (metrics.buildPeakRssMb > budgets.maxBuildRssMb) {
        failures.push(`build peak RSS ${metrics.buildPeakRssMb}MB > ` +
            `${budgets.maxBuildRssMb}MB`);
    }
    if (metrics.boardPeakRssMb > budgets.maxBoardRssMb) {
        failures.push(`board peak RSS ${metrics.boardPeakRssMb}MB > ` +
            `${budgets.maxBoardRssMb}MB`);
    }
    if (metrics.workerPinMismatch) {
        failures.push(`worker pin requested ${metrics.requestedWorkerCount}, ` +
            `but build used ${metrics.actualWorkerCount}`);
    }
    if (metrics.queryErrors > 0) failures.push(`${metrics.queryErrors} semantic query error(s)`);

    return { failures, warnings };
}

module.exports = {
    DEFAULT_BUDGETS,
    percentile,
    summarizeSamples,
    evaluatePerformanceBudgets,
};
