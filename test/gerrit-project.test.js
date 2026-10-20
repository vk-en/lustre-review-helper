'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repository } = require('./helpers');
const { remoteProject, repositoryProject, verifyPatchProjects } = require('../src/gerrit-project');

test('remote identity uses the exact host and full project path across Git transports', () => {
  for (const url of ['https://review.whamcloud.com/ex/lustre-release.git',
    'https://user:private@review.whamcloud.com/a/ex/lustre-release',
    'ssh://user@review.whamcloud.com:29418/ex/lustre-release/',
    'user@review.whamcloud.com:ex/lustre-release.git',
    'git://review.whamcloud.com/ex%2Flustre-release']) assert.equal(remoteProject(url),'ex/lustre-release');
  assert.equal(remoteProject('https://review.whamcloud.com/fs/lustre-release'),'fs/lustre-release');
  for(const url of ['https://review.whamcloud.com.evil.test/ex/lustre-release','https://review.whamcloud.com@evil.test/ex/lustre-release',
    '/repo/ex/lustre-release','file:///ex/lustre-release','https://github.com/ex/lustre-release',
    'https://review.whamcloud.com/ex/lustre-release?secret=yes','user@review.whamcloud.com:ex/../lustre-release',
    'user@review.whamcloud.com:ex/lustre-release\n']) assert.equal(remoteProject(url),undefined);
});

test('origin fixes project identity even with another Lustre project configured as upstream', async t => {
  const repo=await repository(t);
  repo.git('remote','add','origin','ssh://user@review.whamcloud.com:29418/ex/lustre-release');
  repo.git('remote','add','upstream','https://review.whamcloud.com/fs/lustre-release');
  const branch=repo.git('symbolic-ref','--short','HEAD');
  repo.git('config',`branch.${branch}.remote`,'upstream');
  assert.equal(await repositoryProject(repo.directory),'ex/lustre-release');
  await verifyPatchProjects(repo.directory,[{number:65424,project:'ex/lustre-release'}]);
  await assert.rejects(verifyPatchProjects(repo.directory,[{number:49373,project:'fs/lustre-release'}]),/49373.*"fs\/lustre-release".*"ex\/lustre-release"/);
  repo.git('remote','set-url','origin','https://review.whamcloud.com/fs/lustre-release');
  assert.equal(await repositoryProject(repo.directory),'fs/lustre-release','remote changes are checked without a cache');
});

test('fallbacks use the tracked remote or one unique project and refuse unknown or ambiguous mappings', async t => {
  const repo=await repository(t);
  await assert.rejects(repositoryProject(repo.directory),/Cannot identify/);
  repo.git('remote','add','origin','https://github.com/example/mirror');
  repo.git('remote','add','gerrit','https://review.whamcloud.com/ex/lustre-release');
  assert.equal(await repositoryProject(repo.directory),'ex/lustre-release');
  repo.git('remote','add','upstream','https://review.whamcloud.com/fs/lustre-release');
  await assert.rejects(repositoryProject(repo.directory),/conflicting Gerrit projects/);
  const branch=repo.git('symbolic-ref','--short','HEAD');
  repo.git('config',`branch.${branch}.remote`,'gerrit');
  assert.equal(await repositoryProject(repo.directory),'ex/lustre-release');
  repo.git('remote','set-url','origin','https://review.whamcloud.com/ex/lustre-release');
  repo.git('remote','set-url','--push','origin','https://user:secret@review.whamcloud.com/fs/lustre-release');
  await assert.rejects(repositoryProject(repo.directory),e=>/conflicting Gerrit projects/.test(e.message)&&!e.message.includes('secret'));
  await assert.rejects(repositoryProject(undefined),/Choose a local Git repository/);
});

test('Git insteadOf aliases are resolved before checking the project', async t => {
  const repo=await repository(t);
  repo.git('config','url.ssh://user@review.whamcloud.com:29418/.insteadOf','whamcloud:');
  repo.git('remote','add','origin','whamcloud:ex/lustre-release');
  assert.equal(await repositoryProject(repo.directory),'ex/lustre-release');
});
