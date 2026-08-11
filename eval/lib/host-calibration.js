#!/usr/bin/env node

/**
 * Frozen host-speed probe for the performance gate.
 *
 * The throughput budgets are stated in LOC/s, which is a property of the
 * ENGINE and the HARDWARE together. Running the same engine on a slower box
 * lowers the number without anything having regressed, so a fixed floor
 * silently means "10000 LOC/s on whatever machine this happens to be". This
 * probe supplies the missing term: how fast is this host relative to the
 * reference host the floors were calibrated on.
 *
 * Three properties make the number trustworthy as gate input:
 *
 *   1. It is PURE JAVASCRIPT and requires nothing from UCN. No engine change,
 *      grammar bump, or parser regression can move it — a calibration routed
 *      through the code under test would absorb exactly the regressions the
 *      gate exists to catch. (Native parse speed IS UCN's performance and must
 *      never be normalized away.)
 *   2. The workload is FROZEN. Its output is checked against a pinned checksum
 *      on every run; any edit to the work changes the checksum and hard-fails
 *      until `calibrationVersion` and the reference are re-pinned together.
 *   3. The estimator is MIN-OF-N wall time. Contention is one-sided — a noisy
 *      neighbour can only add time — so the minimum is the host's capability
 *      and is stable to about 1% even under heavy load. Measured on the
 *      reference host at load average 5.1: five independent processes agreed
 *      within 1.5% while individual samples inside one process spread 137%.
 *
 * Wall time, not CPU time: `process.cpuUsage()` is process-wide and includes
 * V8's concurrent-marking threads, whose pool size scales with core count.
 * That would fold host SHAPE back into a number meant to capture host SPEED.
 *
 * The shape of the work deliberately mirrors UCN's JavaScript-side profile —
 * character scanning, identifier slicing, Map churn, per-symbol record
 * allocation, sorted output, and scattered pointer chasing — rather than an
 * L1-resident arithmetic loop. It is still a proxy: one scalar cannot express
 * a machine that differs in core speed and memory bandwidth independently.
 * The gate absorbs that residual with margin (see performance-gate-policy.js)
 * and fails RED, never green, when the probe under-reports.
 *
 * Usage:
 *   node eval/lib/host-calibration.js --json   # one calibration, JSON to stdout
 *   node eval/lib/host-calibration.js --pin    # re-pin: min across fresh processes
 */

'use strict';

// Bump whenever ANY line of the timed work below changes. A stale reference
// paired with new work is a silent mis-calibration; the version + checksum
// pair turns that into a hard failure.
const CALIBRATION_VERSION = 'ucn-hostcal-1';

const SOURCE_BYTES = 1 << 20;   // ~1 MiB: past L2 on both host classes
const PASSES = 3;               // scans per timed sample
const WARMUP_SAMPLES = 2;       // past the JIT tiering observed at scan 3-4
// min-of-N falls monotonically with N because contention is one-sided. Nine
// samples took cross-process agreement from 5.0% to under 2% on the reference
// host, which is what the ratio guard's margin needs; the whole window still
// costs well under a second.
const TIMED_SAMPLES = 9;
const PIN_PROCESSES = 5;

function xorshift32(seed) {
    let x = seed >>> 0;
    return () => {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x;
    };
}

/**
 * Deterministic source-like text. Generated OUTSIDE the timed region so the
 * measurement covers scanning, not generation. Integer-only PRNG and
 * charCode arithmetic keep it byte-identical on every platform.
 */
function buildSource() {
    const rand = xorshift32(0x5eedca1b);
    const words = [];
    for (let i = 0; i < 512; i++) {
        const length = 4 + (rand() % 9);
        let word = '';
        for (let c = 0; c < length; c++) word += String.fromCharCode(97 + (rand() % 26));
        words.push(i % 7 === 0 ? `${word}_${i % 97}` : word);
    }
    const lines = [];
    let bytes = 0;
    let depth = 0;
    while (bytes < SOURCE_BYTES) {
        const shape = rand() % 6;
        const a = words[rand() % words.length];
        const b = words[rand() % words.length];
        const c = words[rand() % words.length];
        let line;
        if (shape === 0) line = `    ${a}.${b}(${c}, ${rand() % 1000});`;
        else if (shape === 1) { line = `function ${a}(${b}, ${c}) {`; depth++; }
        else if (shape === 2) line = `    // ${a} ${b} ${c}`;
        else if (shape === 3) line = `    const ${a} = "${b}/${c}";`;
        else if (shape === 4 && depth > 0) { line = '}'; depth--; }
        else line = `    ${a} = ${b}(${c});`;
        lines.push(line);
        bytes += line.length + 1;
    }
    return lines.join('\n');
}

function isIdentifierStart(code) {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
}

function isIdentifierPart(code) {
    return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

/**
 * One scan: char loop -> identifier slice -> Map count churn -> record
 * allocation -> sorted aggregation -> scattered pointer chase. Every stage
 * folds into the checksum, so nothing can be optimized away and any drift in
 * the work is detected rather than silently re-measured.
 */
function scan(source) {
    const names = new Map();
    const nodes = [];
    const length = source.length;
    let checksum = 0x811c9dc5 | 0;
    let i = 0;
    while (i < length) {
        const code = source.charCodeAt(i);
        if (!isIdentifierStart(code)) {
            checksum = Math.imul(checksum ^ code, 16777619) | 0;
            i++;
            continue;
        }
        let j = i + 1;
        while (j < length && isIdentifierPart(source.charCodeAt(j))) j++;
        const name = source.slice(i, j);
        const seen = names.get(name);
        const count = seen === undefined ? 1 : seen + 1;
        names.set(name, count);
        // Scattered parent index: the chase below then misses cache the way a
        // real symbol/caller graph walk does.
        const parent = nodes.length === 0
            ? -1 : (Math.imul(nodes.length, 2654435761) >>> 0) % nodes.length;
        nodes.push({ name, start: i, end: j, count, parent, kind: (j - i) & 7 });
        checksum = (Math.imul(checksum ^ (j - i), 16777619) + i) | 0;
        i = j;
    }

    const entries = [...names.entries()].sort((a, b) =>
        (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [name, count] of entries) {
        checksum = (Math.imul(checksum ^ count, 2246822519) + name.length) | 0;
    }

    let hops = 0;
    for (let k = nodes.length - 1; k >= 0; k -= 97) {
        let cursor = k;
        for (let step = 0; cursor >= 0 && step < 8; step++) {
            checksum = (checksum ^ nodes[cursor].kind) | 0;
            cursor = nodes[cursor].parent;
            hops++;
        }
    }
    checksum = Math.imul(checksum ^ hops, 16777619) | 0;
    return { checksum: checksum >>> 0, nodes: nodes.length, names: names.size };
}

function timedSample(source) {
    const started = process.hrtime.bigint();
    let result;
    for (let pass = 0; pass < PASSES; pass++) result = scan(source);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { wallMs, result };
}

/**
 * @returns {{calibrationVersion: string, checksum: number, nodes: number,
 *   names: number, wallMs: number, samplesMs: number[], spreadPct: number,
 *   nodeVersion: string, platform: string, arch: string}}
 */
function calibrate() {
    const source = buildSource();
    for (let i = 0; i < WARMUP_SAMPLES; i++) timedSample(source);
    const samplesMs = [];
    let result = null;
    for (let i = 0; i < TIMED_SAMPLES; i++) {
        const sample = timedSample(source);
        samplesMs.push(Number(sample.wallMs.toFixed(3)));
        if (result && (sample.result.checksum !== result.checksum ||
            sample.result.nodes !== result.nodes)) {
            throw new Error('host calibration is not deterministic within a process');
        }
        result = sample.result;
    }
    const min = Math.min(...samplesMs);
    const max = Math.max(...samplesMs);
    return {
        calibrationVersion: CALIBRATION_VERSION,
        checksum: result.checksum,
        nodes: result.nodes,
        names: result.names,
        wallMs: Number(min.toFixed(3)),
        samplesMs,
        spreadPct: Number((((max - min) / min) * 100).toFixed(2)),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
    };
}

function pin() {
    const { spawnSync } = require('child_process');
    const os = require('os');
    const runs = [];
    for (let i = 0; i < PIN_PROCESSES; i++) {
        const child = spawnSync(process.execPath, [__filename, '--json'], { encoding: 'utf8' });
        if (child.status !== 0) throw new Error(`calibration process failed: ${child.stderr}`);
        runs.push(JSON.parse(child.stdout));
    }
    const values = runs.map(run => run.wallMs);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
        ...runs[0],
        wallMs: Number(min.toFixed(3)),
        processWallMs: values,
        processSpreadPct: Number((((max - min) / min) * 100).toFixed(2)),
        host: `${process.platform}/${process.arch}, ${os.cpus()[0]?.model || 'unknown'}, ` +
            `${typeof os.availableParallelism === 'function'
                ? os.availableParallelism() : os.cpus().length} cores, node ${process.version}`,
    };
}

if (require.main === module) {
    if (process.argv.includes('--pin')) {
        const pinned = pin();
        process.stdout.write(`${JSON.stringify(pinned, null, 2)}\n`);
        process.stdout.write('\nPaste into HOST_REFERENCE in eval/performance-gate-policy.js:\n' +
            `    calibrationVersion: '${pinned.calibrationVersion}',\n` +
            `    checksum: ${pinned.checksum}, nodes: ${pinned.nodes}, names: ${pinned.names},\n` +
            `    wallMs: ${pinned.wallMs},\n` +
            `    host: '${pinned.host}',\n`);
    } else {
        process.stdout.write(`${JSON.stringify(calibrate())}\n`);
    }
}

module.exports = {
    CALIBRATION_VERSION,
    buildSource,
    scan,
    calibrate,
};
