'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupPlan } = require('../src/history-cleanup');

const sha = n => String(n).repeat(40);
const patch = (number, patchset) => ({ id: `gerrit:${number}:${patchset}`, number, patchset });
const plan = input => Object.fromEntries([...cleanupPlan(input)].map(([id, keys]) => [id, Object.fromEntries(keys)]));

test('Reports & History keeps only successful reviews of open work', () => {
  const runs = [
    // A batch: one review landed, one failed, one still open.
    { id: 'batch', commits: ['gerrit:1:2', 'gerrit:2:1', 'gerrit:3:4'], gerritPatches: [patch(1, 2), patch(2, 1), patch(3, 4)],
      results: [{ target: 'gerrit:1:2', status: 'findings' }, { target: 'gerrit:2:1', status: 'failed' }, { target: 'gerrit:3:4', status: 'clean' }] },
    // A cancelled run has no result at all.
    { id: 'cancelled', commits: [sha(4)], results: [] },
    // Local commits: one landed, one whose change was abandoned, one amended locally, one Gerrit has never seen.
    { id: 'local', commits: [sha(5), sha(6), sha(7), sha(8)], results: [5, 6, 7, 8].map(n => ({ sha: sha(n), status: 'findings' })) },
    { id: 'gone', commits: ['gerrit:9:1'], gerritPatches: [patch(9, 1)], results: [{ target: 'gerrit:9:1', status: 'clean' }] },
  ];
  assert.deepEqual(plan({ runs,
    statuses: new Map([[1, 'MERGED'], [3, 'NEW'], [9, 'MISSING']]),
    links: new Map([[sha(6), 'abandoned'], [sha(7), 'outdated'], [sha(8), 'none']]),
    landed: new Set([sha(5)]) }), {
    batch: { 'gerrit:1:2': 'landed', 'gerrit:2:1': 'did not finish' },
    cancelled: { [sha(4)]: 'did not finish' },
    local: { [sha(5)]: 'landed', [sha(6)]: 'abandoned' },
  }, 'a change a search did not return stays: nothing vanishes from Gerrit');
  assert.deepEqual(plan({ runs: [runs[0]] }), { batch: { 'gerrit:2:1': 'did not finish' } }, 'an unknown Gerrit status keeps the review');
  assert.deepEqual(plan({ runs: [], statuses: new Map([[1, 'MERGED']]) }), {});
});
