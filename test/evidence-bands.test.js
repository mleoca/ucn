/**
 * Evidence bands: how often an unverified reason was a real edge
 * on the release board. A generated table, read by the output layer only.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { formatPublicJson, formatPublicText } = require('../core/output/public');
const { evidenceBand, summarizeReasons, reasonSummaryLine } = require('../core/evidence-bands');
const { bandOf, bandTable, BAND_MINIMUM_SCORED, BAND_THRESHOLDS } = require('../eval/run-unverified-census');
const { RELEASE_REPO_NAMES } = require('../eval/lib/repos');

const ROOT = path.join(__dirname, '..');
const table = reasons => ({ schemaVersion: 1, reasons });

describe('evidence bands of the unverified tier', () => {
    it('a band needs a sample and is the share of scored candidates that were real', () => {
        assert.equal(bandOf(BAND_MINIMUM_SCORED - 1, BAND_MINIMUM_SCORED - 1), null);
        assert.equal(bandOf(0, 0), null);
        assert.equal(bandOf(100, 50), 'often');
        assert.equal(bandOf(100, 49), 'sometimes');
        assert.equal(bandOf(100, 15), 'sometimes');
        assert.equal(bandOf(100, 14), 'rarely');
        assert.equal(bandOf(100, 0), 'rarely');
    });

    it('the table is built from the whole release board and nothing else', () => {
        const names = ['a', 'b'].map(name => ({ name, commit: `pin-${name}`, oracle: 'judge' }));
        const repo = (name, reasons, date = '2026-01-02') => ({ repo: name, date,
            commit: `pin-${name}`, oracle: 'judge',
            qualification: { sampled: 1, evaluated: 1, symbols: 1, errors: 0, symbolErrors: 0, sourceErrors: 0, lookupErrors: 0, reasonsPresent: true },
            reasons: Object.entries(reasons).map(([reason, [hits, wrong, unscored = 0]]) =>
                ({ reason, candidates: hits + wrong + unscored, oracleTrueHits: hits, falseCandidates: wrong, unscored })) });
        const census = { repos: [
            repo('a', { 'possible-dispatch': [2, 40], 'method-ambiguous': [5, 5], rare: [1, 1] }),
            repo('b', { 'possible-dispatch': [1, 20, 9], 'method-ambiguous': [20, 10] }, '2026-01-03'),
            repo('elsewhere', { 'possible-dispatch': [500, 0], rare: [100, 0] }),
        ] };
        const built = bandTable(census, names);
        assert.deepEqual(built.reasons, {
            'method-ambiguous': { scored: 40, real: 25, band: 'often' },
            'possible-dispatch': { scored: 63, real: 3, band: 'rarely' },
        }, 'a repository outside the board and an under-sampled reason add nothing');
        assert.deepEqual(built.repositories, ['a', 'b']);
        assert.equal(built.boardDate, '2026-01-03');
        assert.equal(built.minimumScored, BAND_MINIMUM_SCORED);
        assert.deepEqual(built.thresholds, { ...BAND_THRESHOLDS });
        assert.equal(built.generatedAt, undefined, 'the tracked table changes only with its board');
        // A board with a repository missing never yields a table.
        assert.throws(() => bandTable({ repos: census.repos.slice(1) }, names), /no report for: a/);
        for (const change of [
            row => { row.commit = 'another-pin'; },
            row => { row.oracle = 'another-judge'; },
            row => { row.qualification.error = 'oracle failed'; },
            row => { row.qualification.errors = 1; },
            row => { row.qualification.evaluated = 0; },
            row => { row.qualification.symbols = 0; },
            row => { row.qualification.symbolErrors = 1; },
            row => { row.qualification.sourceErrors = 1; },
            row => { row.qualification.reasonsPresent = false; },
            row => { row.reasons[0].candidates++; },
        ]) {
            const copy = structuredClone(census);
            change(copy.repos[0]);
            assert.throws(() => bandTable(copy, names), /release board/);
        }
    });

    it('a failed, partial or off-pin release report never overwrites the table (fix #498)', () => {
        const { spawnSync } = require('child_process');
        const { RELEASE_REPOS } = require('../eval/lib/repos');
        const oracles = { javascript: 'ts-morph', typescript: 'ts-morph', python: 'pyright', go: 'gopls',
            rust: 'rust-analyzer', java: 'jdtls', csharp: 'roslyn', c: 'clangd', cpp: 'clangd' };
        const reports = RELEASE_REPOS.map(repo => ({ file: `oracle-eval-${repo.name}-${oracles[repo.language]}-2026-01-02.json`,
            value: { schemaVersion: 1, summary: { repo: repo.name, commit: repo.commit, oracle: oracles[repo.language],
                sampled: 1, evaluated: 1, errors: 0, unverifiedReasons: {
                    example: { candidates: 40, hits: 20, falseCandidates: 20, unscored: 0 },
                } }, perSymbol: [{ name: 'example' }] } }));
        const dir = tmp({});
        try {
            const destination = path.join(dir, 'bands.json');
            const run = extra => spawnSync(process.execPath, [path.join(ROOT, 'eval/run-unverified-census.js'),
                '--bands', '--out', destination, ...extra], { encoding: 'utf8',
                env: { ...process.env, UCN_EVAL_REPORTS_DIR: dir } });
            for (const report of reports) fs.writeFileSync(path.join(dir, report.file), JSON.stringify(report.value));
            assert.equal(run([]).status, 0);
            const accepted = fs.readFileSync(destination, 'utf8');
            assert.equal(JSON.parse(accepted).repositories.length, RELEASE_REPOS.length);
            for (const change of [
                value => { value.summary.error = 'compiler unavailable'; },
                value => { value.summary.evaluated = 0; value.summary.errors = 1; },
                value => { value.summary.commit = 'wrong'; },
                value => { value.summary.oracle = 'wrong'; },
                value => { value.perSymbol = []; },
                value => { delete value.summary.unverifiedReasons; },
                value => { value.perSymbol[0].error = 'lookup failed'; },
            ]) {
                const broken = structuredClone(reports[0].value);
                change(broken);
                fs.writeFileSync(path.join(dir, reports[0].file), JSON.stringify(broken));
                assert.equal(run([]).status, 1);
                assert.equal(fs.readFileSync(destination, 'utf8'), accepted);
            }
            fs.writeFileSync(path.join(dir, reports[0].file), JSON.stringify(reports[0].value));
            assert.equal(run(['--all']).status, 1);
            assert.equal(fs.readFileSync(destination, 'utf8'), accepted);
            fs.unlinkSync(path.join(dir, reports[0].file));
            assert.equal(run([]).status, 1);
            assert.equal(fs.readFileSync(destination, 'utf8'), accepted);
        } finally { rm(dir); }
    });

    it('the tracked table is the release board and agrees with its own rule', () => {
        const tracked = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/evidence-bands.json'), 'utf8'));
        assert.equal(tracked.schemaVersion, 1);
        assert.deepEqual(tracked.repositories, [...RELEASE_REPO_NAMES].sort());
        assert.match(tracked.boardDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(tracked.minimumScored, BAND_MINIMUM_SCORED);
        assert.deepEqual(tracked.thresholds, { ...BAND_THRESHOLDS });
        const reasons = Object.keys(tracked.reasons);
        assert.ok(reasons.length > 0);
        assert.deepEqual(reasons, [...reasons].sort(), 'reasons in one order');
        for (const [reason, row] of Object.entries(tracked.reasons)) {
            assert.deepEqual(Object.keys(row).sort(), ['band', 'real', 'scored'], reason);
            assert.ok(Number.isInteger(row.scored) && Number.isInteger(row.real) && row.real <= row.scored, reason);
            assert.equal(row.band, bandOf(row.scored, row.real), reason);
            assert.deepEqual(evidenceBand(reason), row);
        }
        assert.equal(evidenceBand('no-such-reason'), null);
    });

    it('the summary line orders reasons by band, then count, then name, and says what is not measured', () => {
        const bands = table({
            common: { scored: 100, real: 5, band: 'rarely' },
            likely: { scored: 100, real: 90, band: 'often' },
            mixed: { scored: 40, real: 10, band: 'sometimes' },
        });
        const entries = [
            ...Array(5).fill({ reason: 'common' }), { reason: 'likely' }, { reason: 'mixed' }, { reason: 'mixed' },
            { reason: 'zeta' }, { reason: 'alpha' }, {},
        ];
        assert.deepEqual(summarizeReasons(entries, bands).map(row => `${row.reason}:${row.count}:${row.band || '-'}`),
            ['likely:1:often', 'mixed:2:sometimes', 'common:5:rarely', 'alpha:1:-', 'unknown:1:-', 'zeta:1:-']);
        assert.equal(reasonSummaryLine(entries, bands),
            '  by reason, with how often each was a real call on the release board: likely 1 (often, 90/100); ' +
            'mixed 2 (sometimes, 10/40); common 5 (rarely, 5/100); alpha 1 (not measured); unknown 1 (not measured); ' +
            'zeta 1 (not measured)');
        // A map of counts reads as a list of entries does.
        assert.deepEqual(summarizeReasons({ common: 5, likely: 1, none: 0 }, bands).map(row => row.reason), ['likely', 'common']);
        // One reason nobody measured adds no line; one measured reason does.
        assert.equal(reasonSummaryLine([{ reason: 'zeta' }, { reason: 'zeta' }], bands), null);
        assert.equal(reasonSummaryLine([], bands), null);
        assert.match(reasonSummaryLine([{ reason: 'mixed' }], bands), /mixed 1 \(sometimes, 10\/40\)$/);
        // A row with a band the output does not know is not a measurement.
        assert.equal(evidenceBand('odd', table({ odd: { scored: 50, real: 1, band: 'certain' } })), null);
    });

    it('another table changes labels and the order of the summary, never tiers, entries, accounts or data', () => {
        const lines = ['class A:', '    def run(self): return 1', 'class B:', '    def run(self): return 2',
            'class C(A):', '    pass',
            'def typed(a: A):', '    a.run()',
            'def made():', '    A().run()'];
        for (let i = 0; i < 6; i++) lines.push(`def f${i}(x):`, '    x.run()');
        const dir = tmp({ 'a.py': lines.join('\n') + '\n' });
        try {
            const index = idx(dir);
            const one = table({ 'method-ambiguous': { scored: 100, real: 90, band: 'often' } });
            const other = table({ 'method-ambiguous': { scored: 400, real: 4, band: 'rarely' },
                'possible-dispatch': { scored: 50, real: 40, band: 'often' } });
            for (const [command, params] of [['impact', {}], ['show', { sections: 'callers' }]]) {
                const response = execute(index, command, { name: 'a.py:2:run', ...params });
                assert.ok(response.ok, JSON.stringify(response.error));
                const json = bands => JSON.parse(formatPublicJson(command, response.result, params,
                    { ...response, evidenceBands: bands }));
                const [first, second] = [json(one), json(other)];
                assert.deepEqual(first.data, second.data, `${command}: the data is the same`);
                const strip = meta => ({ ...meta,
                    unverifiedReasons: meta.unverifiedReasons.map(({ reason, count }) => ({ reason, count }))
                        .sort((a, b) => (a.reason < b.reason ? -1 : 1)) });
                assert.deepEqual(strip(first.meta), strip(second.meta), `${command}: only the labels differ`);
                assert.notDeepEqual(first.meta.unverifiedReasons, second.meta.unverifiedReasons);
                assert.equal(first.meta.unverifiedReasons.reduce((sum, row) => sum + row.count, 0),
                    (command === 'impact' ? first.data.unverifiedSites : first.data.context.unverifiedCallers).length);

                const text = bands => formatPublicText(command, response.result, params, { ...response, evidenceBands: bands });
                const without = value => value.split('\n').filter(line => !line.startsWith('  by reason,')).join('\n');
                assert.equal(without(text(one)), without(text(other)), `${command}: every other line is the same`);
                assert.match(text(one), /by reason,[^\n]*method-ambiguous \d+ \(often, 90\/100\)/);
                assert.match(text(other), /by reason,[^\n]*method-ambiguous \d+ \(rarely, 4\/400\)/);
            }
        } finally { rm(dir); }
    });

    it('only the output layer reads the table', () => {
        const allowed = new Set(['core/evidence-bands.js', 'core/output/analysis.js', 'core/output/public.js']);
        const offenders = [];
        const walk = directory => {
            for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
                const relative = `${directory}/${entry.name}`;
                if (entry.isDirectory()) { walk(relative); continue; }
                if (!entry.name.endsWith('.js') || allowed.has(relative)) continue;
                if (fs.readFileSync(path.join(ROOT, relative), 'utf8').includes('evidence-bands')) offenders.push(relative);
            }
        };
        for (const directory of ['core', 'languages', 'cli', 'mcp']) walk(directory);
        assert.deepEqual(offenders, []);
    });
});
