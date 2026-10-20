'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { repository } = require('./helpers');
const { listCommits, currentBranch, resolveCommit, readFileAtCommit, safeGitPath, branchBase, mergedCommits, landedCommits } = require('../src/git');

test('recent commits are bounded, newest first, and preserve unusual subjects', async t => {
  const repo = await repository(t);
  assert.deepEqual(await listCommits(repo.directory), []);
  assert.equal(await currentBranch(repo.directory), repo.git('symbolic-ref', '--short', 'HEAD'), 'unborn branch is visible');
  const first = await repo.commit('old\n', 'LU-1: first');
  const second = await repo.commit('new\n', 'LU-2: <script> $(touch nope) "quotes"');
  const latest = await listCommits(repo.directory, 1);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].sha, second);
  assert.equal(latest[0].subject, 'LU-2: <script> $(touch nope) "quotes"');
  assert.deepEqual((await listCommits(repo.directory)).map(c => c.sha), [second, first]);
  await fs.writeFile(path.join(repo.directory, 'file.c'), 'uncommitted\n');
  assert.equal(await readFileAtCommit(repo.directory, first, 'file.c'), 'old\n');
  assert.equal(await resolveCommit(repo.directory, 'HEAD~1'), first);
  assert.match(await readFileAtCommit(repo.directory, first, '/COMMIT_MSG'), /LU-1/);
  await assert.rejects(resolveCommit(repo.directory, '--output=/tmp/file'));
  await assert.rejects(listCommits(repo.directory, 0));
  await assert.rejects(readFileAtCommit(repo.directory, first, '../secret'));
  assert.equal(safeGitPath('/etc/passwd'), false);
  assert.equal(safeGitPath('lustre/lod.c'), true);
  repo.git('switch', '-qc', 'review/selected-branch');
  assert.equal(await currentBranch(repo.directory), 'review/selected-branch');
  repo.git('checkout', '--detach', '-q', 'HEAD');
  assert.equal(await currentBranch(repo.directory), `Detached HEAD · ${repo.git('rev-parse', '--short', 'HEAD')}`);
});

test('merged commits are those on the base branch, by ancestry or by a landed Change-Id', async t => {
  const repo = await repository(t);
  const id = n => `I${String(n).repeat(40)}`;
  const first = await repo.commit('one\n', 'LU-1 first');
  const landed = await repo.commit('two\n', 'LU-2 landed');
  repo.git('update-ref', 'refs/remotes/other/old', first);
  const picked = await repo.commit('three\n', `LU-3 picked\n\nChange-Id: ${id(3)}`);
  const local = await repo.commit('four\n', `LU-4 local\n\nChange-Id: ${id(4)}`);
  // The remote landed LU-3 as a cherry-pick: a new commit with the same Change-Id.
  const tree = repo.git('rev-parse', `${picked}^{tree}`);
  const cherry = repo.git('commit-tree', tree, '-p', landed, '-m', `LU-3 picked\n\nChange-Id: ${id(3)}\nReviewed-on: https://review.whamcloud.com/3`);
  repo.git('update-ref', 'refs/remotes/origin/main', cherry);
  const commits = await listCommits(repo.directory, 10);
  assert.equal(await branchBase(repo.directory), 'origin/main', 'without an upstream, the closest remote branch is the base');
  const result = await mergedCommits(repo.directory, commits);
  assert.equal(result.base, 'origin/main');
  assert.deepEqual([...result.merged].sort(), [first, landed, picked].sort(), 'the cherry-picked change counts as landed');
  assert.ok(!result.merged.has(local));
  repo.git('remote', 'add', 'other', 'https://example.invalid/other.git');
  repo.git('branch', '--set-upstream-to=other/old');
  assert.equal(await branchBase(repo.directory), 'other/old', 'a configured upstream wins');
  assert.deepEqual([...(await mergedCommits(repo.directory, commits)).merged], [first]);
  repo.git('branch', '--unset-upstream');
  repo.git('update-ref', '-d', 'refs/remotes/origin/main'); repo.git('update-ref', '-d', 'refs/remotes/other/old');
  assert.deepEqual(await mergedCommits(repo.directory, commits), { base: undefined, merged: new Set() }, 'no remote branch, nothing to compare with');
});

test('listed commits carry their Change-Id trailer when they have one', async t => {
  const repo = await repository(t);
  await repo.commit('one\n', 'LU-1 llite: first\n\nBody.\n\nChange-Id: I0123456789abcdef0123456789abcdef01234567\nSigned-off-by: A <a@example.invalid>');
  await repo.commit('two\n', 'LU-2 llite: second, no trailer');
  const [second, first] = await listCommits(repo.directory, 5);
  assert.equal(first.changeId, 'I0123456789abcdef0123456789abcdef01234567');
  assert.equal(first.subject, 'LU-1 llite: first');
  assert.equal(Object.hasOwn(second, 'changeId'), false);
});

test('a reviewed commit landed when its own base branch has it or its Change-Id; an amended version or a backport has not', async t => {
  const repo = await repository(t);
  const id = n => `I${String(n).repeat(40)}`;
  const base = await repo.commit('one\n', 'LU-1 base');
  const landed = await repo.commit('two\n', `LU-2 landed\n\nChange-Id: ${id(2)}`);
  const picked = await repo.commit('three\n', `LU-3 picked\n\nChange-Id: ${id(3)}`);
  const firstTry = await repo.commit('four\n', `LU-4 work\n\nChange-Id: ${id(4)}`);
  repo.git('commit', '-q', '--amend', '-m', `LU-4 work, amended\n\nChange-Id: ${id(4)}`);
  // The remote has LU-2 itself and LU-3 as a cherry-pick with the same Change-Id.
  const tree = repo.git('rev-parse', `${picked}^{tree}`);
  const cherry = repo.git('commit-tree', tree, '-p', landed, '-m', `LU-3 picked\n\nChange-Id: ${id(3)}`);
  repo.git('update-ref', 'refs/remotes/origin/main', cherry);
  // Another remote branch, and a backport to it keeping LU-3's Change-Id.
  const stable = repo.git('commit-tree', repo.git('rev-parse', `${base}^{tree}`), '-p', base, '-m', 'LU-9 stable only');
  repo.git('update-ref', 'refs/remotes/origin/stable', stable);
  const backport = repo.git('commit-tree', tree, '-p', stable, '-m', `LU-3 picked, backport\n\nChange-Id: ${id(3)}`);
  const found = await landedCommits(repo.directory, [{ sha: base }, { sha: landed, changeId: id(2) }, { sha: picked, changeId: id(3) },
    { sha: firstTry, changeId: id(4) }, { sha: backport, changeId: id(3) }]);
  assert.deepEqual([...found.landed].sort(), [base, landed, picked].sort(),
    'the amended first try is off the current branch but has not landed, and the backport is checked against its own branch');
  assert.equal(found.bases.get(firstTry), 'origin/main');
  assert.equal(found.bases.get(backport), 'origin/stable');
  repo.git('update-ref', '-d', 'refs/remotes/origin/main'); repo.git('update-ref', '-d', 'refs/remotes/origin/stable');
  assert.deepEqual([...(await landedCommits(repo.directory, [{ sha: base }])).landed], [], 'no base branch, nothing landed');
});
