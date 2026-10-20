'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary, script } = require('./helpers');
const { GerritLinks, entryFrom, changeDetails, readPatchsetFiles, searchChanges, FRESH } = require('../src/gerrit-links');

const PROJECT = 'ex/lustre-release';
const id = digit => `I${digit.repeat(40)}`;
const sha = digit => digit.repeat(40);

test('a local commit links to its change: same commit, another version, merged, abandoned or none', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'global', 'gerrit-links.json');
  let clock = 1_000_000;
  const reads = [];
  const changes = {
    [`${PROJECT}~b_es6_0~${id('1')}`]: { change_number: 101, change_id: id('1'), project: PROJECT, branch: 'b_es6_0', status: 'NEW', current_patchset: 3, current_revision: sha('a'), mergeable: false },
    [id('2')]: { change_number: 102, change_id: id('2'), project: PROJECT, branch: 'master', status: 'NEW', current_patchset: 5, current_revision: sha('f') },
    [`${PROJECT}~b_es6_0~${id('3')}`]: { change_number: 103, change_id: id('3'), project: PROJECT, branch: 'b_es6_0', status: 'MERGED', current_patchset: 2, current_revision: sha('e'), mergeable: false },
    [`${PROJECT}~b_es6_0~${id('4')}`]: { change_number: 104, change_id: id('4'), project: PROJECT, status: 'ABANDONED', current_patchset: 1 },
    [`${PROJECT}~b_es6_0~${id('6')}`]: { change_number: 106, change_id: id('6'), project: 'other/project', status: 'NEW' },
  };
  let offline = false;
  const read = async (binary, key) => {
    reads.push(key);
    if (offline) throw new Error('Could not read the Gerrit change.');
    if (changes[key]) return changes[key];
    throw Object.assign(new Error('Could not read the Gerrit change.'), { missing: true });
  };
  const options = { file, findGerrit: async () => '/bin/gerrit', read, now: () => clock };
  const links = new GerritLinks(options);
  const commits = [
    { sha: sha('a'), changeId: id('1') }, { sha: sha('b'), changeId: id('2') }, { sha: sha('c'), changeId: id('3') },
    { sha: sha('d'), changeId: id('4') }, { sha: sha('5'), changeId: id('5') }, { sha: sha('6'), changeId: id('6') }, { sha: sha('7') },
  ];
  assert.deepEqual(links.view(undefined, commits[0]), { state: 'none', reason: 'project' });
  assert.deepEqual(links.view(PROJECT, commits[6]), { state: 'none', reason: 'changeId' });
  assert.deepEqual(links.view(PROJECT, commits[0]), { state: 'unknown' });
  const pending = links.check(PROJECT, 'b_es6_0', commits, root);
  assert.equal(links.view(PROJECT, commits[0]).state, 'checking');
  await pending;
  assert.deepEqual(commits.map(commit => links.view(PROJECT, commit).state), ['current', 'outdated', 'merged', 'abandoned', 'none', 'none', 'none']);
  assert.deepEqual(links.view(PROJECT, commits[1]), { state: 'outdated', number: 102, ps: 5, revision: sha('f'), branch: 'master' },
    'a change on another branch is found by its Change-Id alone');
  assert.equal(links.view(PROJECT, commits[5]).reason, 'missing', 'a change of another project does not count');
  assert.deepEqual(links.view(PROJECT, commits[0]), { state: 'current', number: 101, ps: 3, revision: sha('a'), branch: 'b_es6_0', conflict: true },
    'the same commit as on Gerrit, which Gerrit cannot merge');
  assert.equal(links.view(PROJECT, commits[2]).conflict, undefined, 'a merged change has no conflict');
  assert.equal(reads.length, 9, 'the base branch first, then the Change-Id alone when not found there');

  // Shared with other windows; merged changes are never read again, the rest after a while.
  const other = new GerritLinks(options);
  await other.load();
  assert.equal(other.view(PROJECT, commits[2]).number, 103);
  reads.length = 0;
  await links.check(PROJECT, 'b_es6_0', commits, root);
  assert.equal(reads.length, 0, 'fresh results are not read again');
  clock += FRESH;
  offline = true;
  await links.check(PROJECT, 'b_es6_0', commits, root);
  assert.ok(!reads.some(key => key.endsWith(id('3'))), 'a merged change is final');
  assert.equal(links.view(PROJECT, commits[0]).state, 'current', 'a failed lookup keeps the last known state');
  const unseen = { sha: sha('8'), changeId: id('8') };
  await links.check(PROJECT, 'b_es6_0', [unseen], root);
  assert.equal(links.view(PROJECT, unseen).state, 'unknown', 'a commit never found yet is unknown while Gerrit cannot be read');
  await other.reload();
  assert.equal(other.view(PROJECT, unseen).state, 'unknown', 'a failed lookup is not saved');
  offline = false; clock += FRESH; reads.length = 0;
  await links.check(PROJECT, 'b_es6_0', commits.slice(0, 1), root);
  assert.equal(links.view(PROJECT, commits[0]).state, 'current', 'it is retried later');

  // An open change saved by an older version, without the merge conflict
  // flag, is read again at once; the same entry from this version is not.
  const older = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const value of Object.values(older.changes)) delete value.format;
  await fs.writeFile(file, JSON.stringify(older));
  const upgraded = new GerritLinks(options);
  await upgraded.load();
  reads.length = 0;
  await upgraded.check(PROJECT, 'b_es6_0', commits.slice(0, 3), root);
  assert.deepEqual(reads, [`${PROJECT}~b_es6_0~${id('1')}`, `${PROJECT}~b_es6_0~${id('2')}`, id('2')], 'open changes only; merged ones are final');
  assert.equal(upgraded.view(PROJECT, commits[0]).conflict, true);
  reads.length = 0;
  await upgraded.check(PROJECT, 'b_es6_0', commits.slice(0, 3), root);
  assert.deepEqual(reads, [], 'entries of this version stay fresh');

  // A tampered file is checked on load.
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.changes[`../x\n${id('1')}`] = { number: 1, status: 'NEW', checkedAt: 1 };
  saved.changes[`${PROJECT}\nnot-an-id`] = { number: 1, status: 'NEW', checkedAt: 1 };
  saved.changes[`${PROJECT}\n${id('9')}`] = { number: -1, status: 'NEW', checkedAt: 1 };
  await fs.writeFile(file, JSON.stringify(saved));
  const tampered = new GerritLinks(options);
  await tampered.load();
  assert.equal(tampered.entries.size, 6);
  assert.equal(entryFrom({ change_number: 5, change_id: id('1'), project: 'other' }, id('1'), PROJECT), undefined);
});

test('report details come from gerrit info and the files a newer patchset changed from gerrit diff', async t => {
  const info = { change_number: '69476', current_patchset: '3', status: 'NEW', owner: 'Rajesh Ghanekar', current_revision: 'a'.repeat(40), mergeable: false,
    jenkins_build: { status: 'SUCCESS' }, ci: { status: 'enforced failures', maloo_vote: -1 },
    reviewers: [{ name: 'Chris Horn', approvals: { 'Code-Review': '+1' } }, { name: 'Maloo', approvals: { Verified: '-1', 'Code-Review': ' 0' } },
      { name: 'Rajesh Ghanekar', approvals: { 'Code-Review': '+1' } }, { name: 'Oleg X', approvals: { 'Code-Review': '-1' } }] };
  assert.deepEqual(changeDetails(info, 69476), { number: 69476, ps: 3, status: 'NEW', owner: 'Rajesh Ghanekar', build: 'passed', tests: 'failed',
    votes: [{ name: 'Chris Horn', value: 1 }, { name: 'Oleg X', value: -1 }], revision: 'a'.repeat(40), mergeable: false }, 'the owner and zero votes are left out');
  assert.equal(Object.hasOwn(changeDetails({ ...info, mergeable: undefined }, 69476), 'mergeable'), false, 'an older gerrit-cli says nothing');
  assert.deepEqual(['passed', 'running'], [changeDetails({ ...info, ci: { maloo_vote: 1 } }, 69476).tests, changeDetails({ ...info, ci: {} }, 69476).tests]);
  assert.equal(changeDetails({ ...info, jenkins_build: { status: 'FAILURE' } }, 69476).build, 'failed');
  assert.equal(changeDetails({ ...info, jenkins_build: undefined }, 69476).build, 'none');
  assert.equal(changeDetails(info, 1), undefined, 'another change is refused');

  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', `
    const args=process.argv.slice(2);
    if(args.join(' ')!=='diff https://review.whamcloud.com/69476 2 3'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
    console.log(JSON.stringify({change_number:69476,patchset_a:2,patchset_b:3,files:[{path:'lipe/src/lpurge.c',status:'M'},{path:'new.c',old_path:'old.c',status:'R'},{path:'/COMMIT_MSG',status:'M'}]}));
  `);
  assert.deepEqual(await readPatchsetFiles(cli, 69476, 2, 3, dir), ['lipe/src/lpurge.c', 'new.c', 'old.c', '/COMMIT_MSG']);
  await assert.rejects(readPatchsetFiles(cli, 69476, 1, 3, dir), /Could not compare/);
});

test('one Gerrit search gives the status of many changes, and those it no longer shows are missing', async t => {
  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', `
    const args=process.argv.slice(2);
    if(args.join(' ')!=='search --limit 3 change:1 OR change:2 OR change:3'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
    console.log(JSON.stringify({query:args[3],count:2,changes:[{number:1,status:'MERGED'},{number:2,status:'NEW'},{number:7,status:'ABANDONED'}]}));
  `);
  assert.deepEqual([...await searchChanges(cli, [1, 2, 3, 2], dir)], [[1, 'MERGED'], [2, 'NEW'], [3, 'MISSING']]);
  assert.deepEqual([...await searchChanges(cli, [], dir)], []);
  const failing = await script(dir, 'failing', `console.log('GERRIT_PASS=secret');process.exit(2);`);
  await assert.rejects(searchChanges(failing, [1], dir), error => { assert.equal(error.message, 'Could not search Gerrit.'); return true; });
  const garbled = await script(dir, 'garbled', `console.log('{"changes": 1}');`);
  await assert.rejects(searchChanges(garbled, [1], dir), /invalid search result/);
});
