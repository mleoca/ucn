'use strict';

/**
 * Reference host for the throughput budgets.
 *
 * Throughput floors are stated in LOC/s, which is a property of the engine AND
 * the hardware. Without a host term, `minColdLocPerSec: 10000` silently means
 * "10000 LOC/s on whichever box happens to run this", so the same unregressed
 * engine fails on a slower runner. `eval/lib/host-calibration.js` measures this
 * host against the reference below with a frozen pure-JavaScript probe, and the
 * floors are compared against `measured x hostFactor` — the value the engine
 * would have produced on reference hardware. Budget VALUES never move; only
 * their units become "LOC/s on reference hardware".
 *
 * RE-PIN PROTOCOL. Run `node eval/lib/host-calibration.js --pin` on a quiet
 * reference machine and paste the result here when, and only when:
 *   - the reference machine changes;
 *   - the Node MAJOR version changes;
 *   - the frozen probe workload is edited (bump `calibrationVersion` too).
 * Never re-pin to make a red gate green: the probe cannot see UCN at all, so a
 * red gate is never the probe's fault.
 *
 * Three guards keep a stale reference loud instead of silent: a
 * `calibrationVersion` mismatch, a workload checksum mismatch, and a
 * non-positive wall time all invalidate the calibration, which drops the host
 * factor to 1 (the strictest reading) and fails release runs explicitly.
 */
const HOST_REFERENCE = Object.freeze({
    calibrationVersion: 'ucn-hostcal-1',
    checksum: 1545960154,
    nodes: 91061,
    names: 514,
    wallMs: 40.0,
    host: 'darwin/arm64, Apple M1 Pro, 10 cores, node v24.8.0, pinned 2026-08-11',
});

// Trusted band for the host factor, reference-relative.
//
// Above the cap the gate becomes STRICTER than the host deserves (a false
// alarm, which a human can read off the reported raw/normalized pair) rather
// than laxer. Below the floor a host is more than twice as fast as the
// reference, which is a re-pin event, so relief stops growing. Both edges warn.
//
// The cap is 3.0 because GitHub's 4-core ubuntu-latest runner derives to ~2.28
// against this reference (independently reproduced by cjson and fmt, agreeing
// to 0.1%). A cap of 2.5 would have left that real runner only 9% of headroom,
// and clamping a legitimately slow runner produces exactly the spurious red
// this normalization exists to remove.
const MIN_HOST_FACTOR = 0.5;
const MAX_HOST_FACTOR = 3.0;

// Fixed process and JSON costs dominate smaller projects, so throughput
// budgets apply only above this size. Shared with the runner so the pinned
// per-repo baselines cover exactly the set the floors gate.
const THROUGHPUT_MIN_LINES = 5000;

const DEFAULT_BUDGETS = Object.freeze({
    // Stated on REFERENCE hardware; the measured value is multiplied by the
    // host factor before comparison (see HOST_REFERENCE).
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
    // Per-repository regression guard. The absolute floors sit ~1.9x below
    // healthy throughput so that host variation cannot trip them, which also
    // means a real regression hides underneath: disabling the C-family
    // conditional-recovery size bound costs 24% of fmt's CPU throughput and
    // PASSED the whole gate (4275 LOC/CPU-s vs the 3000 floor, 16426 LOC/s vs
    // the 10000 floor, 1305MB vs the 1536MB budget, exit 0 -- measured). These
    // ratios compare host-normalized throughput against the pinned per-repo
    // baseline, where the same regression reads 0.71x. CPU is the tighter of
    // the two because parallelism hides CPU-work regressions in wall time.
    // Only repositories carrying `performanceBaseline` are gated.
    minCpuThroughputRatio: 0.87,
    minWallThroughputRatio: 0.80,
    requireThroughputBaselines: false,
    // Release runs must not silently fall back to the unnormalized floors.
    requireHostCalibration: false,
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
 * Turn a raw calibration reading into a gate-usable host factor.
 *
 * Returns `{ hostFactor, valid, error, rawHostFactor, clamped }`. An invalid
 * reading yields factor 1 rather than a guess: that is the strictest possible
 * reading, so a broken probe can only produce a false alarm, never a false
 * pass. `error` is non-null exactly when the reading could not be trusted;
 * `evaluatePerformanceBudgets` decides whether that is fatal.
 *
 * @param {object|null} calibration Output of eval/lib/host-calibration.js.
 */
function resolveHostFactor(calibration) {
    const invalid = error => ({
        hostFactor: 1, rawHostFactor: null, valid: false, clamped: false, error,
    });
    if (calibration == null) return invalid('no host calibration was collected');
    if (typeof calibration !== 'object') return invalid('host calibration is not an object');
    if (calibration.calibrationVersion !== HOST_REFERENCE.calibrationVersion) {
        return invalid(`host calibration version ${calibration.calibrationVersion} != ` +
            `reference ${HOST_REFERENCE.calibrationVersion}; re-pin HOST_REFERENCE`);
    }
    if (calibration.checksum !== HOST_REFERENCE.checksum ||
        calibration.nodes !== HOST_REFERENCE.nodes ||
        calibration.names !== HOST_REFERENCE.names) {
        return invalid(`host calibration workload changed (checksum ${calibration.checksum}/` +
            `${calibration.nodes}/${calibration.names} != reference ${HOST_REFERENCE.checksum}/` +
            `${HOST_REFERENCE.nodes}/${HOST_REFERENCE.names}); re-pin HOST_REFERENCE`);
    }
    const wallMs = Number(calibration.wallMs);
    if (!Number.isFinite(wallMs) || wallMs <= 0) {
        return invalid(`host calibration wall time ${calibration.wallMs} is not a positive number`);
    }
    const rawHostFactor = Number((wallMs / HOST_REFERENCE.wallMs).toFixed(4));
    const hostFactor = Math.min(MAX_HOST_FACTOR, Math.max(MIN_HOST_FACTOR, rawHostFactor));
    return {
        hostFactor: Number(hostFactor.toFixed(4)),
        rawHostFactor,
        valid: true,
        clamped: hostFactor !== rawHostFactor,
        error: null,
    };
}

function scaled(value, hostFactor) {
    return Number((value * hostFactor).toFixed(3));
}

/**
 * Evaluate one repository without confusing a slow shared runner with a UCN
 * regression. For a substantial cold build, startup fails only when BOTH the
 * fixed agent-latency ceiling and the host-normalized warm/cold ratio regress.
 * Small projects remain absolute-latency gated because fixed costs dominate
 * their ratios.
 *
 * Throughput is judged on reference hardware: `metrics.hostFactor` (1 when
 * absent, so an uncalibrated caller sees exactly the historical verdicts)
 * scales the measured values before every comparison.
 */
function evaluatePerformanceBudgets(metrics, budgets = DEFAULT_BUDGETS) {
    const failures = [];
    const warnings = [];

    const requested = metrics.hostFactor;
    const usable = Number.isFinite(requested) && requested > 0;
    const hostFactor = usable
        ? Math.min(MAX_HOST_FACTOR, Math.max(MIN_HOST_FACTOR, requested)) : 1;
    if (usable && hostFactor !== requested) {
        warnings.push(`host factor ${requested} clamped to ${hostFactor}; the gate is now ` +
            'stricter than this host warrants, so read the raw column before trusting a failure');
    }
    const calibrationProblem = metrics.hostCalibrationError ||
        (requested != null && !usable
            ? `host factor ${requested} is not a usable positive number` : null);
    if (calibrationProblem) {
        const message = `${calibrationProblem}; throughput judged at the unnormalized ` +
            'reference floors';
        if (budgets.requireHostCalibration) failures.push(message);
        else warnings.push(message);
    } else if (requested == null && budgets.requireHostCalibration) {
        failures.push('host calibration missing; throughput cannot be judged on reference ' +
            'hardware (run eval/lib/host-calibration.js)');
    }

    const substantialProject = metrics.lines >= THROUGHPUT_MIN_LINES;
    const normalizedColdLocPerSec = scaled(metrics.coldLocPerSec, hostFactor);
    const normalizedColdLocPerCpuSec = scaled(metrics.coldLocPerCpuSec, hostFactor);
    const note = hostFactor === 1 ? ''
        : ` (raw ${metrics.coldLocPerCpuSec} x host factor ${hostFactor})`;
    const wallNote = hostFactor === 1 ? ''
        : ` (raw ${metrics.coldLocPerSec} x host factor ${hostFactor})`;

    if (substantialProject && normalizedColdLocPerCpuSec < budgets.minColdLocPerCpuSec) {
        failures.push(`cold CPU throughput ${normalizedColdLocPerCpuSec} LOC/CPU-s${note} < ` +
            budgets.minColdLocPerCpuSec);
    }
    if (substantialProject && normalizedColdLocPerSec < budgets.minColdLocPerSec) {
        const message = `cold wall throughput ${normalizedColdLocPerSec} LOC/s${wallNote} < ` +
            `${budgets.minColdLocPerSec}`;
        if (budgets.requireColdWallThroughput) {
            failures.push(message);
        } else {
            warnings.push(`${message}; inspect runner contention and worker telemetry`);
        }
    }

    // Per-repository regression guard against the pinned reference-host
    // baseline. Same normalization as the floors, so the verdict is identical
    // on every host; the ratio is what makes a regression that stays above the
    // absolute floors visible.
    //
    // Estimator: the BEST isolated process sample, not the median the floors
    // use. Both the baseline and this reading are capability measurements, and
    // the noise between them is one-sided -- thermal throttling, a busy
    // neighbour and GC timing can only make a build slower. Measured on the
    // reference host, best-of-3 cut the healthy spread from 6.4% to 3.7% and
    // the regressed spread from 5.4% to 0.4%, which is the difference between
    // a coin-flip threshold and a real one. The floors keep the median so
    // their behaviour is untouched.
    const baselineCpu = metrics.baselineLocPerCpuSec;
    const baselineWall = metrics.baselineLocPerSec;
    const peakCpu = scaled(
        metrics.peakColdLocPerCpuSec ?? metrics.coldLocPerCpuSec, hostFactor);
    const peakWall = scaled(
        metrics.peakColdLocPerSec ?? metrics.coldLocPerSec, hostFactor);
    let cpuThroughputRatio = null;
    let wallThroughputRatio = null;
    const guard = (kind, value, extra, ratio, floor, baseline) => {
        const message = `cold ${kind} throughput ${value}${extra} is ${ratio}x the pinned ` +
            `${metrics.repo} baseline ${baseline} (floor ${floor}x)`;
        if (budgets.requireThroughputBaselines) failures.push(message);
        else warnings.push(`${message}; run with --require-wall-throughput to gate on it`);
    };
    if (substantialProject && Number.isFinite(baselineCpu) && baselineCpu > 0) {
        cpuThroughputRatio = Number((peakCpu / baselineCpu).toFixed(4));
        if (cpuThroughputRatio < budgets.minCpuThroughputRatio) {
            guard('CPU', peakCpu, note, cpuThroughputRatio,
                budgets.minCpuThroughputRatio, baselineCpu);
        }
    }
    if (substantialProject && Number.isFinite(baselineWall) && baselineWall > 0) {
        wallThroughputRatio = Number((peakWall / baselineWall).toFixed(4));
        if (wallThroughputRatio < budgets.minWallThroughputRatio) {
            guard('wall', peakWall, wallNote, wallThroughputRatio,
                budgets.minWallThroughputRatio, baselineWall);
        }
    }
    if (substantialProject && budgets.requireThroughputBaselines &&
        !(Number.isFinite(baselineCpu) && baselineCpu > 0)) {
        warnings.push(`no pinned throughput baseline for ${metrics.repo}; only the absolute ` +
            'floors gate this repository');
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
    // Deliberately NOT host-normalized: memory is set by data-structure size
    // and GC heap sizing, not by core speed, and the measured slower runner is
    // also the HEAVIER one (fmt build peak 1035.8MB on CI vs 770.7MB locally).
    // Scaling these by a slowness factor would manufacture headroom and hide
    // exactly the growth they exist to catch.
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

    return {
        failures,
        warnings,
        hostFactor,
        normalizedColdLocPerSec,
        normalizedColdLocPerCpuSec,
        peakNormalizedColdLocPerSec: peakWall,
        peakNormalizedColdLocPerCpuSec: peakCpu,
        cpuThroughputRatio,
        wallThroughputRatio,
    };
}

module.exports = {
    DEFAULT_BUDGETS,
    HOST_REFERENCE,
    MIN_HOST_FACTOR,
    MAX_HOST_FACTOR,
    THROUGHPUT_MIN_LINES,
    percentile,
    summarizeSamples,
    resolveHostFactor,
    evaluatePerformanceBudgets,
};
