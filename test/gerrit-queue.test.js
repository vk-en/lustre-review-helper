'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary } = require('./helpers');
const { GerritQueue, classify, finish, ownerReply, aiReviews, gerritTime, filters, DEFAULT_FILTERS, AUTO_REFRESH } = require('../src/gerrit-queue');

const ME = 930, OWNER = 1228, PROJECT = 'fs/lustre-release';
const vote = (account_id, value, name = `Reviewer ${account_id}`) => ({ account_id, value, name });
const record = (number, extra = {}) => ({
  number, subject: `LU-${number} llite: change ${number}`, project: PROJECT, branch: 'master', status: 'NEW', wip: false,
  ps: 3, ps_created: '2026-10-16 10:00:00.000000000', updated: '2026-10-17 10:00:00.000000000', owner: 'Patch Owner', owner_id: OWNER,
  ps_history: [{ ps: 1, date: '2026-10-01 10:00:00.000000000' }, { ps: 2, date: '2026-10-08 10:00:00.000000000' }, { ps: 3, date: '2026-10-16 10:00:00.000000000' }],
  build: { state: 'SUCCESS' }, test: { state: 'PASS', failed_tests: [] }, gate: 'OK',
  review: { humans: [], neg: false, my_vote: 0, prior_vote: null }, activity: { me: '', others: '' }, unresolved: 0, ...extra,
});
const review = (extra = {}) => ({ humans: [], neg: false, my_vote: 0, prior_vote: null, ...extra });
const snapshot = () => ({
  schema: 22, self: { account_id: ME, username: 'me', name: 'Me Reviewer' }, projects: [PROJECT],
  reviews: {
    requested: [
      record(101, { review: review({ humans: [vote(5, 1)] }) }),
      record(102, { review: review({ humans: [vote(5, 1), vote(6, 1)] }) }),
      record(103, { test: { state: 'FAIL', failed_tests: [{ name: 'sanity-hsm' }] }, gate: 'FAIL' }),
      record(104, { build: { state: 'BUILDING' }, test: { state: 'NONE' }, gate: 'PENDING' }),
      record(105, { test: { state: 'FAIL', all_failures_retesting: true, failed_tests: [{ name: 'conf-sanity' }] }, gate: 'PENDING' }),
      record(106, { review: review({ humans: [vote(5, 1), vote(6, 1), vote(7, -1)], neg: true }) }),
      record(107, { review: review({ humans: [vote(OWNER, 1, 'Patch Owner'), vote(5, 1)] }) }),
      record(301, { wip: true }), record(302, { status: 'MERGED' }), record(303, { project: 'other/project' }),
      record(304, { owner_id: ME }), record(-1),
    ],
    re_review: [
      record(201, { review: review({ prior_vote: { ps: 2, value: -1, date: '2026-10-09 10:00:00.000000000' } }),
        activity: { me: '2026-10-09 10:00:00.000000000' } }),
      record(101, {}),
    ],
    done: [
      record(202, { activity: { me: '2026-10-17 09:00:00.000000000' } }),
      record(203, { review: review({ my_vote: 1, humans: [vote(ME, 1, 'Me Reviewer'), vote(5, 1)] }), activity: { me: '2026-10-17 09:00:00.000000000' } }),
      record(204, { activity: { me: '2026-10-17 08:00:00.000000000' } }),
    ],
    later: [],
  },
});

test('changes split by whether I already reviewed them, with CI, votes and ready for landing', () => {
  const result = classify(snapshot(), PROJECT);
  assert.equal(result.account, 'Me Reviewer');
  assert.deepEqual(result.waiting.map(item => item.number), [101, 102, 103, 104, 105, 106, 107], 'WIP, merged, other projects and my own changes are left out');
  assert.deepEqual(result.progress.map(item => item.number), [201, 202, 203, 204]);
  const byNumber = Object.fromEntries([...result.waiting, ...result.progress].map(item => [item.number, finish(item)]));
  assert.deepEqual([byNumber[101].plusOther, byNumber[101].ready], [true, false], 'one +1 is not enough');
  assert.equal(byNumber[102].ready, true, 'two +1 from people other than the owner, CI passed');
  assert.deepEqual([byNumber[103].ci, byNumber[103].tests, byNumber[103].failedTests, byNumber[103].ciFailed], ['failed', 'failed', ['sanity-hsm'], true]);
  assert.deepEqual([byNumber[104].ci, byNumber[104].build, byNumber[104].ciRunning], ['running', 'running', true]);
  assert.deepEqual([byNumber[105].ci, byNumber[105].tests], ['running', 'running'], 'failures being retested count as running');
  assert.deepEqual([byNumber[106].negOther, byNumber[106].ready], [true, false], 'any −1 blocks landing');
  assert.deepEqual([byNumber[107].ready, byNumber[107].votes.map(entry => entry.value)], [false, [1]], 'the owner’s own vote does not count');
  assert.deepEqual([byNumber[201].kind, byNumber[201].myPs, byNumber[201].prior], ['newps', 2, { ps: 2, value: -1 }]);
  assert.deepEqual([byNumber[202].kind, byNumber[202].myPs, byNumber[202].noUpdates], ['author', 3, true]);
  assert.deepEqual([byNumber[203].kind, byNumber[203].mine, byNumber[203].ready], ['mine', true, true], 'my +1 counts toward the two votes');
  const replied = finish({ ...result.progress.find(item => item.number === 204), replyAt: '2026-10-18T09:00:00.000Z' });
  assert.deepEqual([replied.kind, replied.noUpdates], ['replied', false], 'an owner reply is an update');
  assert.throws(() => classify({ reviews: {} }, PROJECT), /unknown format/);
  assert.throws(() => classify({ ...snapshot(), projects: ['other/project'] }, PROJECT), /another project/);
});

test('owner replies are the owner’s comments after my last message', () => {
  const timeline = { timeline: [
    { author: 'Patch Owner', updated: '2026-10-17 07:00:00.000000000' },
    { author: 'Other Reviewer', updated: '2026-10-18 11:00:00.000000000' },
    { author: 'Patch Owner', updated: '2026-10-18 09:00:00.000000000' },
  ] };
  assert.equal(ownerReply(timeline, 'Patch Owner', '2026-10-17T08:00:00.000Z'), '2026-10-18T09:00:00.000Z');
  assert.equal(ownerReply(timeline, 'Patch Owner', '2026-10-18T10:00:00.000Z'), undefined);
  assert.equal(ownerReply(timeline, '', undefined), undefined);
  assert.equal(ownerReply({ timeline: 'nope' }, 'Patch Owner'), undefined);
  assert.equal(gerritTime('2026-10-18 09:00:00.000000000'), '2026-10-18T09:00:00.000Z');
  assert.equal(gerritTime('soon'), undefined);
});

test('AI reviews are signed comments or the AI bot’s, grouped per patchset, author and signature', () => {
  const at = time => `2026-10-17 ${time}:00.000000000`;
  const timeline = { timeline: [
    { patch_set: 3, author: 'Chris Horn', updated: at('18:30'), message: '**[AI review - opus]**\n\nThe approach is reasonable.' },
    { patch_set: 3, author: 'Chris Horn', updated: at('18:31'), message: '**[AI review - opus]**\n\n(defect) Check this.' },
    { patch_set: 3, author: 'Andreas', updated: at('19:00'), message: '\\[Lustre Bot - sonnet\\] (nit) Typo.' },
    { patch_set: 3, author: 'Reviewer', updated: at('19:10'), message: '[nit] typo here' },
    { patch_set: 3, author: 'Gerrit AI review for Lustre', updated: at('19:20'), message: 'Possible leak.' },
    { patch_set: 2, author: 'Chris Horn', updated: at('10:00'), message: '**[AI review - opus]** older patchset' },
    { patch_set: 3, author: 'Owner', updated: at('20:00'), message: 'Thanks, [AI review] was right.' },
  ] };
  assert.deepEqual(aiReviews(timeline, 3).map(review => [review.author, review.signature, review.count, review.at]), [
    ['Chris Horn', 'AI review - opus', 2, '2026-10-17T18:31:00.000Z'],
    ['Andreas', 'Lustre Bot - sonnet', 1, '2026-10-17T19:00:00.000Z'],
    ['Gerrit AI review for Lustre', 'Gerrit AI review for Lustre', 1, '2026-10-17T19:20:00.000Z'],
  ], 'a [nit] note and a signature quoted mid-sentence are not AI reviews');
  assert.deepEqual(aiReviews(timeline).map(review => review.patchset), [2, 3, 3, 3]);
  assert.deepEqual(aiReviews({ timeline: 'nope' }, 3), []);
});

test('filters keep known keys only and default to hiding unfinished CI and my +1', () => {
  assert.deepEqual(filters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(filters({ waiting: ['ready', 'bogus', 'ready'], progress: 'all' }), { waiting: ['ready'], progress: DEFAULT_FILTERS.progress });
  assert.deepEqual(DEFAULT_FILTERS, { waiting: ['ciFailed', 'ciRunning'], progress: ['mine', 'ciFailed', 'ciRunning'] });
});

test('a refresh is shared by windows, reads owner replies once per update and survives tampering', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'global', 'gerrit-reviews.json'), dataDir = path.join(root, 'global', 'gerrit-dashboard');
  let clock = Date.parse('2026-10-18T12:00:00.000Z'), data = snapshot();
  const refreshes = [], timelines = [];
  const options = {
    file, dataDir, findDashboard: async () => '/bin/gerrit-dashboard', findGerrit: async () => '/bin/gerrit', now: () => clock,
    refresh: async (binary, { dataDir: directory, project }) => {
      refreshes.push(project);
      await fs.mkdir(path.join(directory, 'users', 'me'), { recursive: true });
      await fs.writeFile(path.join(directory, 'users', 'me', 'snapshot.json'), JSON.stringify(data));
    },
    timeline: async (binary, number) => {
      timelines.push(number);
      return { timeline: number === 204 ? [{ author: 'Patch Owner', updated: '2026-10-18 09:00:00.000000000' }] :
        number === 201 ? [{ author: 'Patch Owner', updated: '2026-10-01 00:00:00.000000000' }] :
        number === 101 ? [{ author: 'Chris Horn', patch_set: 3, updated: '2026-10-17 18:30:58.000000000', message: '**[AI review - opus]**\n\nLooks fine.' },
          { author: 'Me Reviewer', patch_set: 3, updated: '2026-10-17 18:40:00.000000000', message: '**[Lustre Bot]** (defect) Mine.' }] : [] };
    },
  };
  let changes = 0;
  const queue = new GerritQueue({ ...options, changed: () => changes++ });
  await queue.load();
  assert.deepEqual(queue.get(PROJECT), { refreshing: false, error: undefined, loaded: false, refreshedAt: undefined, account: undefined, waiting: [], progress: [] });
  const pending = queue.refresh(PROJECT, root);
  assert.equal(queue.get(PROJECT).refreshing, true);
  assert.equal(queue.refresh(PROJECT, root), pending, 'one refresh at a time');
  await pending;
  let current = queue.get(PROJECT);
  assert.equal(current.error, undefined);
  assert.deepEqual(current.waiting.map(item => [item.number, item.ci]), [[101, 'passed'], [102, 'passed'], [106, 'passed'], [107, 'passed'], [104, 'running'], [105, 'running'], [103, 'failed']]);
  assert.deepEqual(current.progress.map(item => [item.number, item.kind]), [[201, 'newps'], [204, 'replied'], [202, 'author'], [203, 'mine']]);
  assert.equal(current.progress.find(item => item.number === 204).replyAt, '2026-10-18T09:00:00.000Z');
  assert.equal(current.progress.find(item => item.number === 201).replyAt, undefined, 'a reply before my review is not news');
  assert.deepEqual(timelines.sort(), [101, 102, 103, 104, 105, 106, 107, 201, 202, 203, 204], 'every change is read once');
  assert.deepEqual(current.waiting.find(item => item.number === 101).aiOthers,
    [{ author: 'Chris Horn', signature: 'AI review - opus', count: 1, at: '2026-10-17T18:30:58.000Z' }], 'my own AI review is left out');
  assert.equal(current.waiting.find(item => item.number === 102).aiOthers, undefined);
  assert.ok(changes >= 2);

  // Another window reads the saved refresh and does not repeat one made seconds ago.
  const other = new GerritQueue(options);
  await other.load();
  assert.deepEqual(other.get(PROJECT).progress, current.progress);
  clock += 5000;
  await other.refresh(PROJECT, root);
  assert.equal(refreshes.length, 1);

  // Later refreshes read comments only for changes updated since.
  clock += 60000; timelines.length = 0;
  data.reviews.done[1].updated = '2026-10-18 11:30:00.000000000';
  await queue.refresh(PROJECT, root);
  assert.deepEqual(timelines, [203]);
  assert.equal(queue.get(PROJECT).progress.find(item => item.number === 204).replyAt, '2026-10-18T09:00:00.000Z', 'cached reply kept');
  assert.equal(queue.get(PROJECT).waiting.find(item => item.number === 101).aiOthers[0].author, 'Chris Horn', 'cached AI reviews kept');
  assert.equal(await other.reload(), true);

  // Publishing moves a change to In progress at once.
  await queue.markReviewed(PROJECT, 102, 3);
  current = queue.get(PROJECT);
  assert.ok(!current.waiting.some(item => item.number === 102));
  assert.deepEqual(current.progress.filter(item => item.number === 102).map(item => [item.kind, item.myPs, item.ready]), [['author', 3, true]]);
  await queue.markReviewed(PROJECT, 101, 9);
  assert.ok(queue.get(PROJECT).waiting.some(item => item.number === 101), 'a stale patchset is not marked');

  // The shared file is checked again on load.
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.projects[PROJECT].waiting.push({ number: -5, ps: 1, kind: 'waiting', ci: 'passed' }, { number: 9, ps: 1, kind: 'evil', ci: 'passed' },
    { number: 10, ps: 1, kind: 'waiting', ci: 'passed', subject: 'x'.repeat(5000), votes: [{ name: 'A', value: 9 }] });
  saved.projects['../escape'] = saved.projects[PROJECT];
  await fs.writeFile(file, JSON.stringify(saved));
  await other.load();
  const restored = other.get(PROJECT).waiting.filter(item => item.number === 10);
  assert.deepEqual(restored.map(item => [item.subject.length, item.votes[0].value]), [[300, 2]]);
  assert.ok(!other.get(PROJECT).waiting.some(item => item.number === -5 || item.number === 9));
  assert.equal(other.get('../escape').loaded, false);

  // Failures keep the last refresh and say what to do.
  const missing = new GerritQueue({ ...options, findDashboard: async () => { throw new Error('nope'); } });
  await missing.load();
  await missing.refresh(PROJECT, root);
  assert.match(missing.get(PROJECT).error, /Install gerrit-dashboard/);
  assert.equal(missing.get(PROJECT).errorCode, 'dashboard', 'the view offers the matching fix');
  assert.equal(missing.get(PROJECT).loaded, true);
  clock += 60000; data = {};
  await queue.refresh(PROJECT, root);
  assert.match(queue.get(PROJECT).error, /unknown format/);
  assert.equal(queue.get(PROJECT).waiting.length > 0, true);
});

test('automatic refreshes run in one window: never while another refreshes, and once per interval', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'global', 'gerrit-reviews.json'), dataDir = path.join(root, 'global', 'gerrit-dashboard');
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const refreshes = [];
  let hold;
  const options = {
    file, dataDir, findDashboard: async () => '/bin/gerrit-dashboard', findGerrit: async () => undefined, now: () => clock,
    refresh: async (binary, { dataDir: directory }) => {
      refreshes.push(clock);
      if (hold) await hold;
      await fs.mkdir(path.join(directory, 'users', 'me'), { recursive: true });
      await fs.writeFile(path.join(directory, 'users', 'me', 'snapshot.json'), JSON.stringify(snapshot()));
    },
  };
  const first = new GerritQueue(options), second = new GerritQueue(options);
  await first.refresh(PROJECT, root);
  assert.equal(refreshes.length, 1);
  await second.load();
  clock += 60000;
  await second.refresh(PROJECT, root, { auto: true });
  assert.equal(refreshes.length, 1, 'refreshed a minute ago: nothing to do');
  clock += AUTO_REFRESH;
  let release; hold = new Promise(resolve => { release = resolve; });
  const running = first.refresh(PROJECT, root, { auto: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  await second.refresh(PROJECT, root, { auto: true });
  assert.equal(refreshes.length, 2, 'another window is refreshing: this one leaves it alone');
  assert.equal(second.get(PROJECT).error, undefined, 'and says nothing about it');
  release(); await running; hold = undefined;
  await second.reload();
  assert.equal(second.get(PROJECT).refreshedAt, new Date(clock).toISOString());
  clock += 5000;
  await second.refresh(PROJECT, root, { auto: true });
  assert.equal(refreshes.length, 2, 'the other window just refreshed');
});
