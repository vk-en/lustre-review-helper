'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { findReviews, reviewDetails } = require('../src/review-lookup');
const { repository } = require('./helpers');

test('agents find the review of a commit, of its amended version and of the local series', async t => {
  const repo = await repository(t);
  const base = await repo.commit('base\n', 'LU-1 base: landed');
  repo.git('update-ref', 'refs/remotes/origin/main', base);
  await fs.writeFile(path.join(repo.directory, 'file.c'), 'first try\n');
  repo.git('commit', '-qam', `LU-2 llite: fix readahead\n\nChange-Id: I${'2'.repeat(40)}`);
  const reviewed = repo.git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo.directory, 'file.c'), 'fixed\n');
  repo.git('commit', '-q', '--amend', '-am', `LU-2 llite: fix readahead\n\nChange-Id: I${'2'.repeat(40)}`);
  const amended = repo.git('rev-parse', 'HEAD');
  const finding = { file: 'file.c', line: 1, message: '(defect) Check the window size.' };
  const runs = new Map([['11111111-1111-1111-1111-111111111111', { id: '11111111-1111-1111-1111-111111111111', repository: 'repo', status: 'completed',
    startedAt: '2026-10-16T10:00:00Z', agent: 'claude', model: 'opus', modelName: 'Opus', effort: 'high', mode: 'full', commits: [reviewed],
    results: [{ sha: reviewed, subject: 'LU-2 llite: fix readahead', status: 'findings', message: 'One defect.', comments: [finding] }] }]]);
  const service = { runs, repository: id => { if (id && id !== 'repo') throw new Error('Unknown repository.'); return { id: 'repo', path: repo.directory }; } };

  const series = await findReviews(service);
  assert.equal(series.base, 'origin/main');
  assert.deepEqual(series.commits.map(item => [item.commit, item.subject, item.change_id]), [[amended, 'LU-2 llite: fix readahead', `I${'2'.repeat(40)}`]],
    'without commits, the local patch on the branch is looked up');
  const [earlier] = series.commits[0].reviews;
  assert.equal(earlier.match, 'earlier version', 'the amended commit finds the review of its earlier version by Change-Id');
  assert.equal(earlier.reviewed_commit, reviewed);
  assert.deepEqual(earlier.findings, [finding]);
  assert.equal(earlier.assessment, 'One defect.');

  runs.set('22222222-2222-2222-2222-222222222222', { id: '22222222-2222-2222-2222-222222222222', repository: 'repo', status: 'completed',
    startedAt: '2026-10-17T10:00:00Z', agent: 'codex', model: 'gpt', effort: undefined, mode: 'full', commits: [amended], since: reviewed,
    results: [{ sha: amended, subject: 'LU-2 llite: fix readahead', status: 'clean', message: 'Fixed.', comments: [] }] });
  const both = (await findReviews(service, { commits: ['HEAD'] })).commits[0].reviews;
  assert.deepEqual(both.map(review => [review.match, review.status, 'findings' in review]), [['same commit', 'clean', true], ['earlier version', 'findings', false]],
    'newest first; only the newest carries its findings');
  assert.equal(both[0].since, reviewed);
  assert.equal((await findReviews(service, { commits: ['HEAD'], limit: 1 })).commits[0].reviews.length, 1);
  assert.deepEqual((await findReviews(service, { subject: 'READAHEAD' })).reviews.map(review => review.review),
    ['22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111']);
  assert.deepEqual((await findReviews(service, { commits: [base] })).commits[0].reviews, [], 'an unreviewed commit has no reviews');
  // A Gerrit change, by number or URL, also when an agent gives it as the subject.
  const patchRun = '33333333-3333-3333-3333-333333333333';
  runs.set(patchRun, { id: patchRun, repository: 'repo', status: 'completed', startedAt: '2026-10-18T10:00:00Z', agent: 'auggie', model: 'gpt', mode: 'full',
    commits: ['gerrit:66889:8'], gerritPatches: [{ id: 'gerrit:66889:8', number: 66889, patchset: 8, project: 'ex/lustre-release' }],
    results: [{ sha: 'c'.repeat(40), target: 'gerrit:66889:8', subject: 'LU-19712 utils: pin_info', status: 'findings', message: 'One.', comments: [finding] }] });
  for (const change of ['66889', 'https://review.whamcloud.com/c/ex/lustre-release/+/66889/8']) {
    const found = await findReviews(service, { change });
    assert.equal(found.change, 66889);
    assert.deepEqual(found.reviews.map(review => [review.review, review.match, review.gerrit.change, review.findings.length]), [[patchRun, 'change', 66889, 1]]);
  }
  assert.equal((await findReviews(service, { subject: '66889' })).change, 66889, 'a change number given as the subject finds the change');
  assert.deepEqual((await findReviews(service, { change: '12345' })).reviews, []);
  await assert.rejects(findReviews(service, { change: 'EX-1' }), /Gerrit change number/);
  await assert.rejects(findReviews(service, { commits: ['nosuchref'] }), error => {
    assert.match(error.message, /^Unknown commit: nosuchref\. /);
    assert.doesNotMatch(error.message, /fatal|rev-parse/, 'git\'s own message is not passed on');
    return true;
  });
  await assert.rejects(findReviews(service, { repository: 'other' }), /Unknown repository/);
  repo.git('update-ref', '-d', 'refs/remotes/origin/main');
  const plain = await findReviews(service);
  assert.equal(plain.base, undefined);
  assert.deepEqual(plain.commits.map(item => item.commit), [amended], 'without a remote base, HEAD alone');

  service.reportFiles = async (id, sha) => sha === amended ? ['/runs/report.md'] : [];
  const details = await reviewDetails(service, runs.get('22222222-2222-2222-2222-222222222222'),
    { id: '22222222-2222-2222-2222-222222222222', reportSha: amended, status: 'completed', results: runs.get('22222222-2222-2222-2222-222222222222').results }, { tab: 'local' });
  assert.deepEqual([details.match, details.reviewed_commit, details.report_files, details.tab, details.assessment], ['selected', amended, ['/runs/report.md'], 'local', 'Fixed.']);
});
