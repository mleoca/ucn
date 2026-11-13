'use strict';

const fs = require('fs');
const { REPOS } = require('./lib/repos');

// Separate runners keep compiler servers away from timing measurements.
// Language groups balance the pinned board while keeping every repository
// assigned automatically when the manifest grows.
const ORACLE_GROUPS = {
    'c-family': ['c', 'cpp'],
    rust: ['rust'],
    java: ['java'],
    mixed: ['javascript', 'typescript', 'python', 'go', 'csharp'],
};

function evaluationMatrix(event, full, repos = REPOS) {
    if (!['schedule', 'workflow_dispatch'].includes(event)) throw new Error(`Unsupported evaluation event: ${event}`);
    if (typeof full !== 'boolean') throw new Error('full must be a boolean');
    // The matrices are judged by compilers and test runners on projects they
    // write themselves, not on the pinned board: their own runner, on every
    // trigger, so their toolchains never share a job with a timing or an
    // oracle arm.
    const include = [
        { id: 'checks', kind: 'checks', repos: '' },
        { id: 'matrices', kind: 'matrices', repos: '' },
    ];
    if (event === 'schedule' || full) {
        const groups = new Map(Object.keys(ORACLE_GROUPS).map(group => [group, []]));
        const names = new Set();
        for (const repo of repos) {
            if (typeof repo.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(repo.name) || names.has(repo.name)) {
                throw new Error(`Invalid or duplicate evaluation repository: ${repo.name}`);
            }
            names.add(repo.name);
            const group = Object.keys(ORACLE_GROUPS).find(key => ORACLE_GROUPS[key].includes(repo.language));
            if (!group) throw new Error(`No oracle group for ${repo.name}: ${repo.language}`);
            groups.get(group).push(repo.name);
        }
        if (names.size === 0) throw new Error('The oracle board is empty');
        for (const [group, members] of groups) {
            if (members.length) include.push({ id: `oracle-${group}`, kind: 'oracle', repos: members.join(',') });
        }
    }
    if (event === 'workflow_dispatch') include.push({ id: 'release', kind: 'release', repos: '' });
    return { include };
}

if (require.main === module) {
    const full = process.env.UCN_EVAL_FULL || 'false';
    if (!['true', 'false'].includes(full)) throw new Error('UCN_EVAL_FULL must be true or false');
    const matrix = evaluationMatrix(process.env.GITHUB_EVENT_NAME, full === 'true');
    const json = JSON.stringify(matrix);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
    else process.stdout.write(`${json}\n`);
}

module.exports = { evaluationMatrix };
