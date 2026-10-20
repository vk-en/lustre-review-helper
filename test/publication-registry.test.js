'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PublicationRegistry, fromRun, readyFromRun, merge, clean } = require('../src/publication-registry');
const { temporary } = require('./helpers');

const run = (id, { posted = true, patchset = 2, updatedAt = '2026-10-16T15:19:25.301Z' } = {}) => ({
  id, signature: '[Lustre Bot]', gerritPatches: [{ id: `gerrit:64086:${patchset}`, number: 64086, patchset, project: 'fs/lustre-release',
    subject: 'LU-1 llite: fix', owner: 'Gerrit Author', branch: 'master', revision: 'a'.repeat(40) }],
  publications: posted ? { [`gerrit:64086:${patchset}`]: { status: 'posted', updatedAt } } : { [`gerrit:64086:${patchset}`]: { status: 'error', updatedAt } },
});

test('registry entries keep one publication per project, change and patchset and refuse unsafe data', () => {
  assert.deepEqual(fromRun(run('11111111-1111-1111-1111-111111111111')), [{ project: 'fs/lustre-release', change: 64086, patchset: 2,
    revision: 'a'.repeat(40), subject: 'LU-1 llite: fix', owner: 'Gerrit Author', branch: 'master', signature: '[Lustre Bot]',
    run: '11111111-1111-1111-1111-111111111111', postedAt: '2026-10-16T15:19:25.301Z' }]);
  assert.deepEqual(fromRun(run('11111111-1111-1111-1111-111111111111', { posted: false })), [], 'only confirmed publications count');
  assert.deepEqual(fromRun({ id: 'x', commits: ['a'.repeat(40)] }), [], 'local reviews are never published');
  for (const bad of [{ project: '../x' }, { project: 'a/../b' }, { change: 0 }, { patchset: 1.5 }, { postedAt: 'soon' }, { project: 'x\ny' }]) {
    assert.equal(clean({ project: 'fs/lustre-release', change: 1, patchset: 1, postedAt: '2026-10-16T00:00:00Z', ...bad }), undefined);
  }
  assert.equal(clean({ project: 'p', change: 1, patchset: 1, postedAt: '2026-10-16T00:00:00Z', revision: 'nope', run: 'nope' }).revision, undefined);
  const older = { project: 'p', change: 1, patchset: 1, postedAt: '2026-10-16T00:00:00Z', signature: '[Old]' };
  const newer = { ...older, postedAt: '2026-10-17T00:00:00Z', signature: '[New]' };
  const other = { ...older, patchset: 2, postedAt: '2026-10-15T00:00:00Z' };
  assert.deepEqual(merge([], [older, newer, other]).map(entry => [entry.patchset, entry.signature]), [[1, '[New]'], [2, '[Old]']]);
  assert.deepEqual(merge(merge([], [newer]), [older]).map(entry => entry.signature), ['[New]'], 'an older copy never replaces a newer one');
});

test('every window shares the registry: history is backfilled from all workspaces and concurrent writes are kept', async t => {
  const root = await temporary(t);
  const storage = path.join(root, 'workspaceStorage'), file = path.join(root, 'global', 'publications.json');
  const extensionId = 'llm-code-and-review-tools.lustre-review';
  const write = async (workspace, value) => {
    const directory = path.join(storage, workspace, extensionId, 'runs', value.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(value));
  };
  await write('a'.repeat(32), run('11111111-1111-1111-1111-111111111111'));
  await write('b'.repeat(32), run('22222222-2222-2222-2222-222222222222', { patchset: 3, updatedAt: '2026-10-17T10:00:00.000Z' }));
  await write('c'.repeat(32), run('33333333-3333-3333-3333-333333333333', { posted: false, patchset: 4 }));
  await fs.mkdir(path.join(storage, 'c'.repeat(32), extensionId, 'runs', '44444444-4444-4444-4444-444444444444'), { recursive: true });
  await fs.writeFile(path.join(storage, 'c'.repeat(32), extensionId, 'runs', '44444444-4444-4444-4444-444444444444', 'run.json'), '{broken');

  const first = new PublicationRegistry({ file, workspaceStorage: storage, extensionId });
  await first.initialize();
  assert.deepEqual(first.forProject('fs/lustre-release').map(entry => entry.patchset), [3, 2], 'newest first, from every workspace');
  assert.equal(first.find('fs/lustre-release', 64086, 2).run, '11111111-1111-1111-1111-111111111111');
  assert.equal(first.find('fs/lustre-release', 64086, 4), undefined);
  assert.equal(first.find('other/project', 64086, 2), undefined, 'entries belong to their Gerrit project');

  const second = new PublicationRegistry({ file });
  assert.equal(await second.refresh(), true, 'another window reads the shared file');
  assert.equal(second.entries.length, 2);
  assert.equal(await second.refresh(), false, 'an unchanged file is not read again');

  const published = (id, patchset) => ({ ...run(id, { patchset, updatedAt: `2026-10-18T0${patchset}:00:00.000Z` }) });
  await Promise.all([first.record(published('55555555-5555-5555-5555-555555555555', 5)), second.record(published('66666666-6666-6666-6666-666666666666', 6))]);
  await first.refresh(); await second.refresh();
  assert.deepEqual(first.entries.map(entry => entry.patchset), [6, 5, 3, 2], 'simultaneous publications from two windows are both kept');
  assert.deepEqual(second.entries, first.entries);
  assert.ok(!(await fs.readdir(path.dirname(file))).some(name => name.endsWith('.lock') || name.endsWith('.tmp')), 'no lock or temporary file is left');

  await fs.writeFile(file, 'not json');
  const recovered = new PublicationRegistry({ file });
  await recovered.record(published('77777777-7777-7777-7777-777777777777', 7));
  assert.deepEqual(recovered.entries.map(entry => entry.patchset), [7], 'a damaged registry is rebuilt instead of blocking publication');
});

test('finished reviews waiting to be published are shared until published, forgotten or gone from disk', async t => {
  const root = await temporary(t);
  const storage = path.join(root, 'workspaceStorage'), file = path.join(root, 'global', 'publications.json');
  const extensionId = 'llm-code-and-review-tools.lustre-review';
  const finished = (id, { patchset = 2, status = 'findings', posted = false, folder = '/work/lustre' } = {}) => ({
    id, status: 'completed', repo: folder, startedAt: '2026-10-18T09:00:00.000Z', finishedAt: '2026-10-18T10:00:00.000Z',
    gerritPatches: [{ id: `gerrit:64086:${patchset}`, number: 64086, patchset, project: 'fs/lustre-release', subject: 'LU-1 llite: fix' }],
    results: [{ target: `gerrit:64086:${patchset}`, sha: 'b'.repeat(40), status }],
    publications: posted ? { [`gerrit:64086:${patchset}`]: { status: 'posted', updatedAt: '2026-10-18T11:00:00.000Z' } } : {},
  });
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
  assert.deepEqual(readyFromRun(finished(A)), [{ project: 'fs/lustre-release', change: 64086, patchset: 2, subject: 'LU-1 llite: fix',
    run: A, folder: '/work/lustre', completedAt: '2026-10-18T10:00:00.000Z' }]);
  assert.deepEqual(readyFromRun({ ...finished(A), status: 'running' }), [], 'a running review is not ready');
  assert.deepEqual(readyFromRun(finished(A, { status: 'failed' })), [], 'a failed review has nothing to publish');
  assert.deepEqual(readyFromRun(finished(A, { posted: true })), []);

  const first = new PublicationRegistry({ file }), second = new PublicationRegistry({ file });
  await first.record(finished(A));
  await first.record(finished(C, { patchset: 3, folder: 'relative/path' }));
  assert.equal(await second.refresh(), true);
  assert.deepEqual(second.ready('fs/lustre-release', 64086, 2).map(entry => [entry.run, entry.folder]), [[A, '/work/lustre']], 'another window sees it');
  assert.equal(second.ready('fs/lustre-release', 64086, 3)[0].folder, undefined, 'only absolute folders are kept');
  await second.record(finished(B, { posted: true }));
  await first.refresh();
  assert.deepEqual(first.ready('fs/lustre-release', 64086, 2), [], 'publishing the patchset anywhere ends its unpublished reviews');
  await first.forget([C]);
  assert.deepEqual(first.ready('fs/lustre-release', 64086, 3), [], 'clearing history forgets them');

  // On activation the unpublished reviews are rebuilt from the runs on disk.
  await first.record(finished(C, { patchset: 4 }));
  const directory = path.join(storage, 'a'.repeat(32), extensionId, 'runs', A);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(finished(A, { patchset: 5 })));
  const restarted = new PublicationRegistry({ file, workspaceStorage: storage, extensionId });
  await restarted.initialize();
  assert.deepEqual(restarted.reviews.map(entry => [entry.run, entry.patchset]), [[A, 5]]);
  assert.equal(restarted.find('fs/lustre-release', 64086, 2).run, B, 'publications are kept');
});
