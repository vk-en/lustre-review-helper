'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchProgress, seconds } = require('../src/progress');

const local = 'a1b2c3d'.padEnd(40, '0');
const run = () => ({ commits: [local, 'gerrit:66891:10', 'gerrit:66893:12'],
  gerritPatches: [{ id: 'gerrit:66891:10', number: 66891, patchset: 10 }, { id: 'gerrit:66893:12', number: 66893, patchset: 12 }] });

test('each review of a batch follows the lreview log: started, running, findings, clean or failed', () => {
  let now = Date.parse('2026-10-19T19:06:13Z');
  const batch = run(), progress = new BatchProgress(batch, () => now);
  assert.equal(progress.feed('Reviewing 2 Gerrit patch(es)…\n[66891_ps10] review started: LU-19712 utils: Add only\n[668'), true);
  assert.equal(batch.progress.items['gerrit:66891:10'].state, 'running');
  assert.equal(batch.progress.items['gerrit:66891:10'].startedAt, '2026-10-19T19:06:13.000Z');
  now += 1000;
  progress.feed('93_ps12] review started: LU-19712 utils: Handle\r\nrunning: 66891_ps10 1m00s 78KB, 66893_ps12 0m59s 77KB | done 0/2\n');
  assert.equal(batch.progress.items['gerrit:66893:12'].state, 'running', 'a line split across chunks still counts');
  now += 498000;
  progress.feed('[66891_ps10] 2 finding(s), severity low (8m18s, $3.34) -> gerrit-review-66891_ps10.json\n');
  assert.deepEqual({ ...batch.progress.items['gerrit:66891:10'], startedAt: undefined }, { state: 'findings', startedAt: undefined, findings: 2, severity: 'low',
    duration: 498, costUsd: 3.34, finishedAt: new Date(now).toISOString() });
  assert.equal(progress.done, 1, 'counted as soon as lreview says so, long before its summary');
  progress.feed('[66893_ps12] FAILED (auggie exited 1), see /tmp/x.log\n');
  assert.equal(batch.progress.items['gerrit:66893:12'].state, 'failed');
  assert.equal(batch.progress.items['gerrit:66893:12'].duration, 498, 'a failure without stats is timed from its start');
  progress.feed('[12settings_a1b2c3d] review started: EX-1 lipe: local\n[12settings_a1b2c3d] clean — no findings (75m03s, 1.2M tok, $12.50)\n');
  assert.deepEqual([batch.progress.items[local].state, batch.progress.items[local].duration, batch.progress.items[local].costUsd], ['clean', 4503, 12.5]);
  assert.equal(progress.done, 3);
  assert.equal(progress.feed('[99999_ps1] review started: someone else\nnoise\n'), false, 'unknown reviews are ignored');
});

test('joining a running batch takes the start from the status line, and a retried review starts again', () => {
  let now = Date.parse('2026-10-19T19:20:00Z');
  const batch = run(), progress = new BatchProgress(batch, () => now);
  progress.feed('running: 66893_ps12 14m00s 110KB quiet 2m46s | done 1/2\n');
  assert.equal(batch.progress.items['gerrit:66893:12'].startedAt, '2026-10-19T19:06:00.000Z');
  now += 60000;
  progress.feed('[66893_ps12] review started: retry after a stall\n');
  assert.equal(batch.progress.items['gerrit:66893:12'].startedAt, '2026-10-19T19:21:00.000Z');
  assert.equal(seconds('8m18s'), 498);
  assert.equal(seconds('nope'), undefined);
});
