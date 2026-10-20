'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readComments, forPatchset } = require('../src/gerrit-comments');
const { temporary, script } = require('./helpers');

const comment = (patchset, file, line, message, name = 'Other Reviewer', unresolved = true) =>
  ({ patch_set: patchset, file_path: file, line, message, author: { name }, unresolved, updated: '2026-10-16 10:00:00.000000000' });

test('only unresolved discussions of the reviewed patchset are shown, without copies of our findings', () => {
  const data = { threads: [
    { root_comment: comment(3, 'lipe/src/lamigo.c', 918, 'How about a comment here?'), replies: [comment(3, 'lipe/src/lamigo.c', 918, 'Will do.', 'Owner')], is_resolved: false },
    { root_comment: comment(2, 'lipe/src/lamigo.c', 918, 'From an earlier patchset.'), replies: [] },
    { root_comment: comment(3, '/COMMIT_MSG', 20, '**[AI review - GPT-6.1 Sol - xhigh]**\n\n(minor) The parent prints none.', 'Vitaliy Kuznetsov'), replies: [] },
    { root_comment: comment(3, 'lipe/src/lamigo.c', 5, '[AI review]\n\n(nit) Plain signature copy.', 'Vitaliy Kuznetsov'), replies: [] },
    { root_comment: comment(3, 'lipe/src/lamigo.c', 10, 'Resolved by the last reply.'), replies: [comment(3, 'lipe/src/lamigo.c', 10, 'Done', 'Owner', false)] },
    { root_comment: comment(3, '/PATCHSET_LEVEL', null, 'Overall this needs a test.'), replies: [] },
    { root_comment: comment(3, '', 1, 'No file.'), replies: [] },
  ] };
  const findings = [{ file: '/COMMIT_MSG', line: 20, message: '(minor) The parent prints none.' }, { file: 'lipe/src/lamigo.c', line: 5, message: '(nit) Plain signature copy.' }];
  assert.deepEqual(forPatchset(data, 3, findings), [
    { file: 'lipe/src/lamigo.c', line: 918, patchsetLevel: false, comments: [
      { author: 'Other Reviewer', message: 'How about a comment here?', updated: '2026-10-16 10:00:00.000000000' },
      { author: 'Owner', message: 'Will do.', updated: '2026-10-16 10:00:00.000000000' }] },
    { file: '/PATCHSET_LEVEL', line: 1, patchsetLevel: true, comments: [
      { author: 'Other Reviewer', message: 'Overall this needs a test.', updated: '2026-10-16 10:00:00.000000000' }] },
  ]);
  assert.equal(forPatchset(data, 2).length, 1, 'each patchset gets its own discussions');
  assert.deepEqual(forPatchset({}, 3), []);
  assert.deepEqual(forPatchset(null, 3), []);
});

test('Gerrit comments are read with the pinned server and never leak raw CLI output', async t => {
  const directory = await temporary(t);
  const ok = await script(directory, 'gerrit-ok', `
    if(process.argv.slice(2).join(' ')!=='comments https://review.whamcloud.com/64086 --no-context'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
    console.log(JSON.stringify({threads:[]}));`);
  assert.deepEqual(await readComments(ok, 64086, directory), { threads: [] });
  const failing = await script(directory, 'gerrit-fail', "console.error('GERRIT_PASS=secret');process.exit(2)");
  await assert.rejects(readComments(failing, 64086, directory), error => /Could not read Gerrit comments/.test(error.message) && !error.message.includes('secret'));
  const broken = await script(directory, 'gerrit-broken', "console.log('not json')");
  await assert.rejects(readComments(broken, 64086, directory), /invalid comments/);
  const slow = await script(directory, 'gerrit-slow', 'setInterval(()=>{},1000)');
  await assert.rejects(readComments(slow, 64086, directory, { timeout: 100 }), /timed out/);
});
