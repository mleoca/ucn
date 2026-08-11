'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmp, rm } = require('./helpers');
const { RELEASE_REPOS, RELEASE_REPO_NAMES } = require('../eval/lib/repos');

const {
    DEFAULT_BUDGETS,
    HOST_REFERENCE,
    MAX_HOST_FACTOR,
    summarizeSamples,
    resolveHostFactor,
    evaluatePerformanceBudgets,
} = require('../eval/performance-gate-policy');
const { buildSource, scan, CALIBRATION_VERSION } = require('../eval/lib/host-calibration');
const {
    aggregateRepoRuns,
    collectPerformanceRollup,
} = require('../eval/run-performance-gate');

function healthyMetrics(overrides = {}) {
    return {
        lines: 80000,
        coldMs: 3000,
        coldCpuMs: 9000,
        coldLocPerSec: 26666,
        coldLocPerCpuSec: 8888,
        cacheLoadMs: 25,
        firstQueryMs: 450,
        warmColdRatio: 0.158,
        queryP50Ms: 30,
        queryP95Ms: 200,
        buildPeakRssMb: 650,
        boardPeakRssMb: 700,
        requestedWorkerCount: 4,
        actualWorkerCount: 4,
        workerPinMismatch: false,
        queryErrors: 0,
        ...overrides,
    };
}

// Budgets as a release or PR gate builds them: wall throughput blocking, the
// per-repo baselines enforced, and a trustworthy host factor mandatory.
const GATING_BUDGETS = Object.freeze({
    ...DEFAULT_BUDGETS,
    requireColdWallThroughput: true,
    requireThroughputBaselines: true,
    requireHostCalibration: true,
});

// Measured, not invented. Laptop = reference host (10 cores, Apple M1 Pro);
// CI = GitHub Actions ubuntu-latest, 4 vCPUs on 2 physical cores.
//
// The first design derived a 2.28x host factor from engine throughput and
// assumed the probe would read it. The first real ubuntu runs (31510902344,
// 31510897360, 2026-08-11) refuted that: the probe read 1.1549 and 1.0757
// while the engine measured 2.0-2.7x below reference -- a single-threaded
// JavaScript scan cannot see 4-workers-on-2-cores hyperthread contention or
// native parse bandwidth. What the probe DID do is stabilize within the
// class: raw best samples across the two runner SKUs disagreed by 11%,
// normalized bests by 3.4%. Hence fix #279: each host class carries its own
// pinned baselines and the ratio guard gates everywhere, while the absolute
// floors stay a reference-class claim.
const BASELINES = {
    cjson: { locPerSec: 22063.733, locPerCpuSec: 6525.627 },
    fmt: { locPerSec: 19341.363, locPerCpuSec: 5918.444 },
};
const LINUX_BASELINES = {
    cjson: { locPerSec: 10352.722, locPerCpuSec: 3244.233 },
    fmt: { locPerSec: 9346.428, locPerCpuSec: 2908.951 },
};

function boardMetrics(repo, overrides = {}) {
    const shape = repo === 'fmt'
        ? { lines: 69630, files: 75 } : { lines: 22652, files: 101 };
    return {
        repo,
        ...shape,
        baselineLocPerSec: BASELINES[repo].locPerSec,
        baselineLocPerCpuSec: BASELINES[repo].locPerCpuSec,
        cacheLoadMs: 30,
        firstQueryMs: 40,
        warmColdRatio: 0.02,
        queryP50Ms: 12,
        queryP95Ms: 90,
        buildPeakRssMb: 1036,
        boardPeakRssMb: 1244,
        requestedWorkerCount: 4,
        actualWorkerCount: 4,
        workerPinMismatch: false,
        queryErrors: 0,
        ...overrides,
    };
}

function linuxBoard(repo, overrides = {}) {
    return boardMetrics(repo, {
        hostClass: 'linux-x64',
        baselineHostClass: 'linux-x64',
        baselineLocPerSec: LINUX_BASELINES[repo].locPerSec,
        baselineLocPerCpuSec: LINUX_BASELINES[repo].locPerCpuSec,
        ...overrides,
    });
}

describe('performance gate host normalization', () => {
    it('passes a healthy run on the reference host', () => {
        // Measured 2026-08-11, full release board on the reference laptop.
        const cjson = evaluatePerformanceBudgets(boardMetrics('cjson', {
            coldLocPerSec: 20650.172, coldLocPerCpuSec: 6167.948,
            peakColdLocPerSec: 21182.036, peakColdLocPerCpuSec: 6263.923,
            buildPeakRssMb: 432.3, boardPeakRssMb: 462, hostFactor: 1.0417,
        }), GATING_BUDGETS);
        const fmt = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 18329.743, coldLocPerCpuSec: 5624.677,
            peakColdLocPerSec: 18567.005, peakColdLocPerCpuSec: 5681.516,
            buildPeakRssMb: 840.5, boardPeakRssMb: 897.5, hostFactor: 1.0417,
        }), GATING_BUDGETS);
        assert.deepEqual(cjson.failures, []);
        assert.deepEqual(fmt.failures, []);
        assert.equal(fmt.cpuThroughputRatio, 1);
    });

    it('passes a healthy scoped re-run, which the pinned board must tolerate', () => {
        // Same engine, two-repo run minutes later: raw throughput differs by
        // 6% but normalization lands it back within 3% of the baseline.
        const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 18529.947, coldLocPerCpuSec: 5617.996,
            peakColdLocPerSec: 19249.19, peakColdLocPerCpuSec: 5700.898,
            hostFactor: 1.0122,
        }), GATING_BUDGETS);
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.cpuThroughputRatio > 0.95, verdict.cpuThroughputRatio);
    });

    it('passes the healthy GitHub runner numbers that used to fail the gate', () => {
        // The four real per-repo measurements from the two 2026-08-11 ubuntu
        // runs, two different runner SKUs (probe factors 1.1549 and 1.0757).
        // The engine is byte-identical to the green reference board; only the
        // hardware differs. The class pins carry the cross-class step the
        // probe cannot see, and the probe stabilizes the SKU spread.
        const runs = [
            ['cjson', { coldLocPerSec: 8619.673, coldLocPerCpuSec: 2799.324,
                peakColdLocPerSec: 8665.939, peakColdLocPerCpuSec: 2809.103,
                buildPeakRssMb: 415.2, boardPeakRssMb: 452.6, hostFactor: 1.1549 }],
            ['fmt', { coldLocPerSec: 8033.928, coldLocPerCpuSec: 2513.759,
                peakColdLocPerSec: 8092.933, peakColdLocPerCpuSec: 2518.79,
                buildPeakRssMb: 1057.1, boardPeakRssMb: 1265, hostFactor: 1.1549 }],
            ['cjson', { coldLocPerSec: 9287.721, coldLocPerCpuSec: 2926.126,
                peakColdLocPerSec: 9624.172, peakColdLocPerCpuSec: 2940.44,
                buildPeakRssMb: 416, boardPeakRssMb: 451.2, hostFactor: 1.0757 }],
            ['fmt', { coldLocPerSec: 8333.936, coldLocPerCpuSec: 2610.549,
                peakColdLocPerSec: 8483.311, peakColdLocPerCpuSec: 2613.632,
                buildPeakRssMb: 1036, boardPeakRssMb: 1250.7, hostFactor: 1.0757 }],
        ];
        for (const [repo, overrides] of runs) {
            const verdict = evaluatePerformanceBudgets(
                linuxBoard(repo, overrides), GATING_BUDGETS);
            assert.deepEqual(verdict.failures, [],
                `${repo} at probe factor ${overrides.hostFactor}`);
            assert.ok(verdict.cpuThroughputRatio >= 0.96,
                `${repo}: ${verdict.cpuThroughputRatio}`);
        }
        // The floors still report, as advisory, so a board reader sees the
        // reference claim is not met on this class.
        const fmt = evaluatePerformanceBudgets(linuxBoard('fmt', runs[1][1]), GATING_BUDGETS);
        assert.ok(fmt.warnings.some(w => /reference-hardware claim/.test(w)));
    });

    it('fails a 1.5x-degraded version of those same runner numbers', () => {
        // Engine regression on the runner: the host factor is unchanged, so
        // the loss shows up in full against the class pin.
        const fmt = evaluatePerformanceBudgets(linuxBoard('fmt', {
            coldLocPerSec: 8333.936 / 1.5, coldLocPerCpuSec: 2610.549 / 1.5,
            hostFactor: 1.0757,
        }), GATING_BUDGETS);
        assert.ok(fmt.failures.some(f => /the pinned fmt baseline/.test(f)));
        assert.ok(fmt.cpuThroughputRatio < 0.7, String(fmt.cpuThroughputRatio));
    });

    it('fails those same runner numbers when the host factor is unavailable', () => {
        // Fail-closed is fail-STRICT: no calibration means factor 1 (which
        // understates throughput, so ratios only get harder to pass) and a
        // gating run refuses to proceed silently.
        const verdict = evaluatePerformanceBudgets(linuxBoard('fmt', {
            coldLocPerSec: 8333.936, coldLocPerCpuSec: 2610.549,
            peakColdLocPerSec: 8483.311, peakColdLocPerCpuSec: 2613.632,
        }), GATING_BUDGETS);
        assert.ok(verdict.failures.some(f => /host calibration missing/.test(f)));
        assert.equal(verdict.hostFactor, 1);
    });

    it('keeps the floors hard off-class when no class baseline gates the repository', () => {
        // Fail-strict: an unpinned host class is judged at the reference
        // floors, which can only false-alarm, never false-pass.
        const verdict = evaluatePerformanceBudgets(linuxBoard('fmt', {
            coldLocPerSec: 8333.936, coldLocPerCpuSec: 2610.549, hostFactor: 1.0757,
            baselineLocPerSec: undefined, baselineLocPerCpuSec: undefined,
            baselineHostClass: null,
        }), GATING_BUDGETS);
        assert.ok(verdict.failures.some(f => /cold CPU throughput/.test(f)));
        assert.ok(verdict.failures.some(f => /cold wall throughput/.test(f)));
        assert.ok(verdict.warnings.some(w =>
            /no pinned throughput baseline for fmt on linux-x64/.test(w)));
    });

    it('keeps the R2-003 wall regression release-blocking on every host', () => {
        // Regression (a): fmt at 8075 LOC/s wall on reference hardware, which
        // is 0.4175x the pinned wall baseline. On the reference class the
        // absolute floor catches it; on the ubuntu class the same
        // proportional loss lands at ~0.41x the class pin and the ratio guard
        // catches it. Release-blocking on both, through different mechanisms.
        const onReference = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 8075, coldLocPerCpuSec: 4163, hostFactor: 1.0,
            hostClass: 'darwin-arm64',
        }), GATING_BUDGETS);
        const onRunner = evaluatePerformanceBudgets(linuxBoard('fmt', {
            coldLocPerSec: 3541.8, coldLocPerCpuSec: 2610.549,
            peakColdLocPerSec: 3541.8, peakColdLocPerCpuSec: 2613.632,
            hostFactor: 1.0757,
        }), GATING_BUDGETS);
        assert.ok(onReference.failures.some(f => /cold wall throughput/.test(f)));
        assert.ok(onRunner.failures.some(f =>
            /cold wall throughput .*the pinned fmt baseline/.test(f)));
    });

    it('fails the C-family recovery-bound regression that clears every absolute floor', () => {
        // Regression (b): disabling the conditional-recovery size bound. The
        // measured cost is CPU work that parallelism hides in wall time, so it
        // sails past 3000 LOC/CPU-s and 10000 LOC/s. Only the per-repo
        // baseline ratio can see it -- and it must see it on both hosts.
        // Measured 2026-08-11 with the bound disabled, best-of-3 samples.
        const measured = {
            coldLocPerSec: 16426.09, coldLocPerCpuSec: 4275.683,
            peakColdLocPerSec: 16879.06, peakColdLocPerCpuSec: 4293.428,
        };
        const onReference = evaluatePerformanceBudgets(
            boardMetrics('fmt', { ...measured, hostFactor: 1.0504 }), GATING_BUDGETS);
        assert.ok(onReference.normalizedColdLocPerCpuSec > DEFAULT_BUDGETS.minColdLocPerCpuSec,
            'the absolute CPU floor genuinely does not catch this');
        assert.ok(onReference.normalizedColdLocPerSec > DEFAULT_BUDGETS.minColdLocPerSec,
            'the absolute wall floor genuinely does not catch this');
        assert.ok(onReference.cpuThroughputRatio < 0.8, String(onReference.cpuThroughputRatio));
        assert.ok(onReference.failures.some(f => /the pinned fmt baseline/.test(f)));

        // On the ubuntu class the same regression shows as CPU work while
        // wall stays healthy (parallelism hides it there too): only the
        // class-pinned CPU ratio can see it.
        const onRunner = evaluatePerformanceBudgets(linuxBoard('fmt', {
            coldLocPerSec: 8333.936, coldLocPerCpuSec: 2610.549 * 0.76,
            peakColdLocPerSec: 8483.311, peakColdLocPerCpuSec: 2613.632 * 0.76,
            hostFactor: 1.0757,
        }), GATING_BUDGETS);
        assert.ok(onRunner.failures.some(f => /the pinned fmt baseline/.test(f)));
        assert.ok(onRunner.wallThroughputRatio >= DEFAULT_BUDGETS.minWallThroughputRatio,
            'wall must stay healthy so only the CPU ratio catches it');

        // The other measured run of the same regression, unnormalized.
        const secondRun = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 16098.689, coldLocPerCpuSec: 4055.346,
            peakColdLocPerSec: 17086.34, peakColdLocPerCpuSec: 4310.09,
            hostFactor: 1.0,
        }), GATING_BUDGETS);
        assert.ok(secondRun.failures.some(f => /the pinned fmt baseline/.test(f)));
    });

    it('separates healthy from regressed by a wide margin on both sides', () => {
        // The threshold is only trustworthy if it is not sitting inside either
        // distribution -- on BOTH host classes. Measured: every healthy sample
        // (reference re-runs plus all four real ubuntu measurements) lands
        // >= 0.96 and every regressed sample <= 0.77, with the 0.87 floor
        // roughly centred in the empty band between them.
        const refRatio = (peakCpu, hostFactor) => evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 18000, coldLocPerCpuSec: peakCpu,
            peakColdLocPerSec: 18000, peakColdLocPerCpuSec: peakCpu, hostFactor,
        }), GATING_BUDGETS).cpuThroughputRatio;
        const linuxRatio = (repo, peakCpu, hostFactor) => evaluatePerformanceBudgets(
            linuxBoard(repo, {
                coldLocPerSec: 9000, coldLocPerCpuSec: peakCpu,
                peakColdLocPerSec: 9000, peakColdLocPerCpuSec: peakCpu, hostFactor,
            }), GATING_BUDGETS).cpuThroughputRatio;
        const healthy = [refRatio(5681.516, 1.0417), refRatio(5700.898, 1.0122),
            linuxRatio('cjson', 2809.103, 1.1549), linuxRatio('fmt', 2518.79, 1.1549),
            linuxRatio('cjson', 2940.44, 1.0757), linuxRatio('fmt', 2613.632, 1.0757)];
        const regressed = [refRatio(4293.428, 1.0504), refRatio(4310.09, 1.0),
            linuxRatio('fmt', 2613.632 * 0.76, 1.0757)];
        assert.ok(Math.min(...healthy) > DEFAULT_BUDGETS.minCpuThroughputRatio + 0.09,
            `healthy floor margin too thin: ${Math.min(...healthy)}`);
        assert.ok(Math.max(...regressed) < DEFAULT_BUDGETS.minCpuThroughputRatio - 0.09,
            `regressed detection margin too thin: ${Math.max(...regressed)}`);
    });

    it('clamps an absurd host factor instead of granting unbounded relief', () => {
        const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 8297.705, coldLocPerCpuSec: 2597.271, hostFactor: 40,
        }), GATING_BUDGETS);
        assert.equal(verdict.hostFactor, MAX_HOST_FACTOR);
        assert.ok(verdict.warnings.some(w =>
            w.includes(`clamped to ${MAX_HOST_FACTOR}`)), 'a clamped factor must be loud');
    });

    it('treats a nonsense host factor as loudly missing rather than passing', () => {
        for (const hostFactor of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 'fast']) {
            const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
                coldLocPerSec: 8297.705, coldLocPerCpuSec: 2597.271, hostFactor,
            }), GATING_BUDGETS);
            assert.equal(verdict.hostFactor, 1, `${String(hostFactor)} must not scale anything`);
            assert.ok(verdict.failures.some(f => /not a usable positive number/.test(f)),
                `${String(hostFactor)} must fail loudly`);
            assert.ok(verdict.failures.some(f => /cold CPU throughput/.test(f)),
                `${String(hostFactor)} must leave the unnormalized floors in force`);
        }
    });

    it('never lets the host factor rescue a memory regression', () => {
        // Memory is set by data-structure size, not core speed, and the slower
        // runner is also the heavier one. Scaling RSS would manufacture GBs of
        // headroom.
        const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 8297.705, coldLocPerCpuSec: 2597.271,
            hostFactor: MAX_HOST_FACTOR,
            buildPeakRssMb: DEFAULT_BUDGETS.maxBuildRssMb + 1,
            boardPeakRssMb: DEFAULT_BUDGETS.maxBoardRssMb + 1,
        }), GATING_BUDGETS);
        assert.ok(verdict.failures.some(f => /build peak RSS/.test(f)));
        assert.ok(verdict.failures.some(f => /board peak RSS/.test(f)));
    });

    it('rejects a calibration that does not match the frozen reference', () => {
        const good = {
            calibrationVersion: HOST_REFERENCE.calibrationVersion,
            checksum: HOST_REFERENCE.checksum,
            nodes: HOST_REFERENCE.nodes,
            names: HOST_REFERENCE.names,
            wallMs: HOST_REFERENCE.wallMs * 1.9,
        };
        assert.equal(resolveHostFactor(good).hostFactor, 1.9);
        assert.equal(resolveHostFactor(good).valid, true);

        const cases = [
            [null, /no host calibration/],
            [{ ...good, calibrationVersion: 'ucn-hostcal-0' }, /version/],
            [{ ...good, checksum: good.checksum + 1 }, /workload changed/],
            [{ ...good, nodes: 1 }, /workload changed/],
            [{ ...good, wallMs: 0 }, /not a positive number/],
            [{ ...good, wallMs: 'quick' }, /not a positive number/],
        ];
        for (const [calibration, pattern] of cases) {
            const state = resolveHostFactor(calibration);
            assert.equal(state.valid, false);
            assert.equal(state.hostFactor, 1, 'an untrusted reading never grants relief');
            assert.match(state.error, pattern);
        }
    });

    it('bounds the trusted band in both directions', () => {
        const at = wallMs => resolveHostFactor({
            calibrationVersion: HOST_REFERENCE.calibrationVersion,
            checksum: HOST_REFERENCE.checksum,
            nodes: HOST_REFERENCE.nodes,
            names: HOST_REFERENCE.names,
            wallMs,
        });
        const slow = at(HOST_REFERENCE.wallMs * 9);
        assert.equal(slow.hostFactor, MAX_HOST_FACTOR);
        assert.equal(slow.clamped, true);
        const fast = at(HOST_REFERENCE.wallMs / 9);
        assert.equal(fast.hostFactor, 0.5);
        assert.equal(fast.clamped, true);
    });

    it('leaves every verdict unchanged when no calibration is involved', () => {
        // The migration is reviewable precisely because an uncalibrated caller
        // sees the historical behaviour: factor 1, no ratio guard, no noise.
        const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 17215.104, coldLocPerCpuSec: 5279.203,
            baselineLocPerSec: undefined, baselineLocPerCpuSec: undefined,
        }));
        assert.deepEqual(verdict.failures, []);
        assert.deepEqual(verdict.warnings, []);
        assert.equal(verdict.hostFactor, 1);
        assert.equal(verdict.cpuThroughputRatio, null);
    });

    it('says so when a gated repository has no pinned baseline', () => {
        const verdict = evaluatePerformanceBudgets(boardMetrics('fmt', {
            coldLocPerSec: 17215.104, coldLocPerCpuSec: 5279.203, hostFactor: 1,
            baselineLocPerSec: undefined, baselineLocPerCpuSec: undefined,
        }), GATING_BUDGETS);
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.warnings.some(w => /no pinned throughput baseline/.test(w)));
    });

    it('pins reference and linux-x64 throughput baselines for the gated smoke repositories', () => {
        for (const name of ['cjson', 'fmt']) {
            const repo = RELEASE_REPOS.find(candidate => candidate.name === name);
            // deepEqual against the test fixtures so the numbers these tests
            // replay can never drift from the pins the real gate uses.
            assert.deepEqual(repo.performanceBaseline, BASELINES[name], name);
            assert.deepEqual(repo.performanceBaselineByHost?.['linux-x64'],
                LINUX_BASELINES[name], `${name} linux-x64`);
        }
    });

    it('keeps the calibration probe frozen and deterministic', () => {
        // No timing assertion: the probe's TIMING is the measurement, its
        // OUTPUT is the contract. A changed workload must break here, not
        // silently re-scale every budget.
        const source = buildSource();
        const first = scan(source);
        const second = scan(source);
        assert.deepEqual(first, second);
        assert.equal(CALIBRATION_VERSION, HOST_REFERENCE.calibrationVersion);
        assert.equal(first.checksum, HOST_REFERENCE.checksum);
        assert.equal(first.nodes, HOST_REFERENCE.nodes);
        assert.equal(first.names, HOST_REFERENCE.names);
    });

    it('refuses a hand-set host factor on gating runs', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-performance-gate.js');
        const cheat = spawnSync(process.execPath,
            [script, '--require-wall-throughput', '--host-factor', '5'], { encoding: 'utf8' });
        assert.notEqual(cheat.status, 0);
        assert.match(cheat.stderr, /--host-factor is a debugging aid/);
    });
});

describe('performance gate policy', () => {
    it('uses the median so one noisy startup sample cannot fail a release', () => {
        const summary = summarizeSamples([438, 722, 456]);
        assert.equal(summary.median, 456);
        assert.equal(summary.max, 722);
        assert.equal(summary.spread, 284);
    });

    it('aggregates isolated cold processes by median but never averages away peak memory', () => {
        const run = (coldMs, coldCpuMs, buildPeakRssMb, boardPeakRssMb) => ({
            repo: 'fixture', language: 'cpp', commit: 'abc', files: 20,
            lines: 80000, coldMs, coldCpuMs, coldLocPerSec: 0,
            coldLocPerCpuSec: 0, cacheSaveMs: 10,
            cacheLoadMs: 20, cacheLoadSamplesMs: [20, 21, 22],
            firstQueryMs: 30, firstQuerySamplesMs: [29, 30, 31],
            firstQueryMaxMs: 31, firstQuerySpreadMs: 2,
            warmColdRatio: 0.01, queryCount: 40, queryP50Ms: 10,
            queryP95Ms: 20, queryMaxMs: 40, slowestQueries: [],
            queryErrors: 0, rssMb: 500, buildPeakRssMb, boardPeakRssMb,
            peakRssMb: boardPeakRssMb, availableParallelism: 8,
            requestedWorkerCount: 4, actualWorkerCount: 4,
            workerPinMismatch: false,
            failures: [], warnings: [],
        });
        const result = aggregateRepoRuns(
            { name: 'fixture', language: 'cpp' },
            [run(3000, 8000, 700, 750), run(9000, 10000, 800, 900),
                run(4000, 9000, 1600, 1700)],
        );
        assert.equal(result.coldMs, 4000);
        assert.equal(result.coldLocPerSec, 20000);
        assert.equal(result.coldCpuMs, 9000);
        assert.equal(result.coldLocPerCpuSec, 8888.889);
        assert.equal(result.buildPeakRssMb, 1600);
        assert.equal(result.boardPeakRssMb, 1700);
        assert.ok(result.failures.some(failure => failure.includes('build peak RSS')));
        assert.ok(result.failures.some(failure => failure.includes('board peak RSS')));
    });

    it('matches the failed GitHub runner case as a host-normalized warning', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            coldMs: 2919.787,
            firstQueryMs: 634.099,
            warmColdRatio: 0.226,
            queryP50Ms: 28.474,
            queryP95Ms: 206.936,
            peakRssMb: 800,
        }));
        assert.deepEqual(verdict.failures, []);
        assert.equal(verdict.warnings.length, 1);
        assert.match(verdict.warnings[0], /host-normalized/);
    });

    it('gates CPU throughput while wall throughput remains diagnostic', () => {
        const slowWall = evaluatePerformanceBudgets(healthyMetrics({
            coldLocPerSec: DEFAULT_BUDGETS.minColdLocPerSec - 1,
        }));
        assert.deepEqual(slowWall.failures, []);
        assert.ok(slowWall.warnings.some(warning => warning.includes('wall throughput')));

        const slowCpu = evaluatePerformanceBudgets(healthyMetrics({
            coldLocPerCpuSec: DEFAULT_BUDGETS.minColdLocPerCpuSec - 1,
        }));
        assert.ok(slowCpu.failures.some(failure => failure.includes('CPU throughput')));
    });

    it('makes the known fmt regression release-blocking through measured wall throughput', () => {
        const metrics = healthyMetrics({
            repo: 'fmt',
            files: 75,
            lines: 69630,
            coldLocPerSec: 8075,
            coldLocPerCpuSec: 4163,
        });
        const exploratory = evaluatePerformanceBudgets(metrics);
        assert.deepEqual(exploratory.failures, []);
        assert.ok(exploratory.warnings.some(warning => warning.includes('wall throughput')));

        const release = evaluatePerformanceBudgets(metrics, {
            ...DEFAULT_BUDGETS,
            requireColdWallThroughput: true,
        });
        assert.ok(release.failures.some(failure => failure.includes('wall throughput')));
    });

    it('fails when a pinned repository workload silently changes', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            files: 101,
            lines: 22652,
            expectedFiles: 101,
            expectedLines: 14199,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('workload LOC')));
    });

    it('fails a real startup regression when absolute and relative budgets both regress', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            coldMs: 1000,
            firstQueryMs: 720,
            warmColdRatio: 0.74,
        }));
        assert.equal(verdict.failures.length, 1);
        assert.match(verdict.failures[0], /semantic startup/);
    });

    it('keeps small repositories on the absolute startup ceiling', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            lines: 4000,
            coldMs: 300,
            firstQueryMs: 510,
            warmColdRatio: 1.8,
        }));
        assert.equal(verdict.failures.length, 1);
        assert.match(verdict.failures[0], /first semantic query/);
    });

    it('keys startup policy to project size rather than host-dependent cold time', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            lines: 6000,
            coldMs: 300,
            firstQueryMs: 700,
            warmColdRatio: 0.1,
        }));
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.warnings.some(warning => warning.includes('first semantic query')));
    });

    it('fails steady-state latency even when startup is healthy', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({ queryP95Ms: 251 }));
        assert.ok(verdict.failures.some(failure => failure.includes('query p95')));
    });

    it('fails query errors and isolated peak memory independently', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            buildPeakRssMb: DEFAULT_BUDGETS.maxBuildRssMb + 1,
            boardPeakRssMb: DEFAULT_BUDGETS.maxBoardRssMb + 1,
            queryErrors: 2,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('build peak RSS')));
        assert.ok(verdict.failures.some(failure => failure.includes('board peak RSS')));
        assert.ok(verdict.failures.some(failure => failure.includes('2 semantic query error')));
    });

    it('fails when the measured worker shape disagrees with the release pin', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            actualWorkerCount: 3,
            workerPinMismatch: true,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('worker pin')));
    });

    it('pins an exact file and LOC workload for every release repository', () => {
        assert.deepEqual(RELEASE_REPOS.map(repo => repo.name), RELEASE_REPO_NAMES);
        for (const repo of RELEASE_REPOS) {
            assert.ok(Number.isInteger(repo.performanceWorkload?.files), repo.name);
            assert.ok(Number.isInteger(repo.performanceWorkload?.lines), repo.name);
        }
        const cjson = RELEASE_REPOS.find(repo => repo.name === 'cjson');
        assert.deepEqual(cjson.performanceWorkload, { files: 101, lines: 22652 });
    });

    it('keeps a scoped smoke run from overwriting stronger full-board evidence', () => {
        const date = '2026-08-11';
        const result = (repo, coldLocPerCpuSec) => ({
            repo,
            coldLocPerCpuSec,
            coldLocPerSec: 12000,
            failures: [],
        });
        const release = {
            generatedAt: `${date}T10:00:00.000Z`,
            scope: 'release',
            release: true,
            processSamples: 3,
            results: RELEASE_REPO_NAMES.map(name => result(name, 5000)),
        };
        const scoped = {
            generatedAt: `${date}T11:00:00.000Z`,
            scope: 'scoped-cjson-fmt',
            release: false,
            processSamples: 3,
            results: [result('cjson', 1), result('fmt', 1)],
        };
        const dir = tmp({
            [`performance-gate-run-release-${date}.json`]: JSON.stringify(release),
            [`performance-gate-run-scoped-cjson-fmt-${date}.json`]: JSON.stringify(scoped),
        });
        try {
            const rollup = collectPerformanceRollup(dir, date);
            assert.equal(rollup.completeReleaseBoard, true);
            assert.equal(rollup.passed, true);
            assert.equal(rollup.results.length, RELEASE_REPO_NAMES.length);
            const cjson = rollup.results.find(row => row.repo === 'cjson');
            assert.equal(cjson.coldLocPerCpuSec, 5000);
            assert.equal(cjson.evidence.scope, 'release');
        } finally { rm(dir); }
    });

    it('never calls a collection of scoped reports a complete release board', () => {
        const date = '2026-08-11';
        const scoped = {
            generatedAt: `${date}T11:00:00.000Z`,
            scope: 'scoped-all',
            release: false,
            processSamples: 3,
            results: RELEASE_REPO_NAMES.map(repo => ({ repo, failures: [] })),
        };
        const rollup = collectPerformanceRollup('/does/not/exist', date, scoped);
        assert.equal(rollup.results.length, RELEASE_REPO_NAMES.length);
        assert.equal(rollup.completeReleaseBoard, false);
        assert.equal(rollup.passed, false);
    });

    it('rejects missing and fractional query-count values before repository setup', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-performance-gate.js');
        const missing = spawnSync(process.execPath, [script, '--queries'], { encoding: 'utf8' });
        const fractional = spawnSync(process.execPath, [script, '--queries', '1.5'], { encoding: 'utf8' });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /requires a value/);
        assert.notEqual(fractional.status, 0);
        assert.match(fractional.stderr, /positive integer/);
    });
});
