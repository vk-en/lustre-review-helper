'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConflicts } = require('../src/gerrit-conflicts');
const { temporary, script } = require('./helpers');

test('a conflict check distinguishes a required rebase from clean trial merges', async t => {
  const repo = await temporary(t), patch = { number: 123, project: 'fs/lustre-release' };
  const response = { change: 123, project: patch.project, branch: 'master', patchset: 5, commit: 'a'.repeat(40), tip: 'b'.repeat(40),
    counts: { tried: 0, candidates: 7 }, status: 'needs-rebase', conflicts: null, silent_only: [], watch: [],
    on_branch: { status: 'conflict', files: ['code.c'] }, errors: [{ cn: 125, reason: 'trial merge failed' }] };
  const binary = await script(repo, 'gerrit', `console.log(JSON.stringify(${JSON.stringify(response)}));`);
  const { summary, hunks } = await readConflicts(binary, patch, repo);
  assert.equal(summary.needsRebase, true);
  assert.deepEqual(summary.files, ['code.c']);
  assert.deepEqual(summary.errors, [125]);
  assert.deepEqual([summary.tried,summary.candidates,hunks], [0,7,'']);
  await assert.rejects(readConflicts(binary, { ...patch, project: 'other/repo' }, repo), /Unexpected conflict report/);
  await assert.rejects(readConflicts(binary, patch, repo, { other: '--all' }), /Invalid Gerrit change/);
});

test('conflict checks support cancellation and keep CLI diagnostics private', async t => {
  const repo = await temporary(t), patch = { number: 123, project: 'fs/lustre-release' };
  const broken = await script(repo, 'bad', 'console.error("SECRET-VALUE");process.exit(1);');
  await assert.rejects(readConflicts(broken, patch, repo), e => /Conflict check failed/.test(e.message) && !e.message.includes('SECRET-VALUE'));
  const slow = await script(repo, 'waiting', 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const pending = readConflicts(slow, patch, repo, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
