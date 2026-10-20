'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageStatistics } = require('../src/statistics');

const run = (id, changes = {}) => ({ id, agent: 'codex', model: 'gpt-test', modelName: 'GPT Test',
  commits: ['a', 'b'], status: 'completed', startedAt: '2026-10-16T12:00:00Z', finishedAt: '2026-10-16T12:01:00Z',
  results: [{ sha: 'a', status: 'clean', tokens: 1000, costUsd: 0.12 }, { sha: 'b', status: 'clean', tokens: 2000, costUsd: 0.23 }], ...changes });

test('all-time usage replaces each batch snapshot and groups by agent and model', () => {
  const stats = new UsageStatistics();
  const current = run('live', { status: 'running', usage: { tokens: 1500, costUsd: 0.1, tokensPartial: false, costPartial: false } });
  stats.record(current); stats.record(current);
  assert.equal(stats.rows()[0].tokens, 1500, 'batch results are not added to live usage');
  stats.record(run('live'));
  stats.record(run('second', { effort: 'high', mode: 'light' }));
  const row = stats.rows()[0];
  assert.equal(row.tokens, 6000);
  assert.equal(row.cost, 0.7);
  assert.equal(row.tokenPartial, false);
  assert.equal(row.costPartial, false);
  assert.equal(row.estimated, false);
  stats.record(run('other-model', { model: 'different' }));
  stats.record(run('other-agent', { agent: 'claude' }));
  assert.equal(stats.rows().length, 3);
  assert.equal(stats.rows().find(row => row.agent === 'claude').estimated, true);
});

test('backfill includes more than 30 runs and survives missing or hidden history', () => {
  const stats = new UsageStatistics();
  for (let i = 0; i < 50; i++) stats.record(run(String(i), { repository: i % 2 ? 'closed-repo' : 'open-repo' }));
  const restored = new UsageStatistics(JSON.parse(JSON.stringify(stats.snapshot())));
  restored.record(run('0'));
  assert.equal(restored.rows()[0].tokens, 150000, 'replaying a saved run does not double count it');
  assert.equal(restored.rows()[0].cost.toFixed(2), '17.50');
});

test('reset persists exclusions while new reviews of the same commit accrue normally', () => {
  const stats = new UsageStatistics();
  const old = run('old'); stats.record(old);
  stats.reset([old, run('other-old')]);
  const restored = new UsageStatistics(JSON.parse(JSON.stringify(stats.snapshot())));
  assert.equal(restored.record(old), false);
  assert.equal(restored.record(run('other-old')), false);
  assert.deepEqual(restored.rows(), []);
  restored.record(run('new'));
  assert.equal(restored.rows()[0].tokens, 3000);
  restored.reset([run('new')]);
  const again = new UsageStatistics(restored.snapshot());
  again.record(old); again.record(run('new'));
  assert.deepEqual(again.rows(), [], 'repeated resets keep previous exclusions');
  assert.equal(old.results.length, 2, 'reset does not modify reports');
});

test('missing data stays unknown and partial cancelled usage is retained', () => {
  const stats = new UsageStatistics();
  stats.record(run('missing', { results: [] }));
  assert.equal(stats.rows()[0].tokens, null);
  assert.equal(stats.rows()[0].cost, null);
  stats.record(run('cancelled', { status: 'cancelled', results: [], usage: {
    tokens: 12000, estimatedCostUsd: 0.4273, tokensPartial: true, costPartial: true } }));
  const row = stats.rows()[0];
  assert.equal(row.tokens, 12000);
  assert.equal(row.cost, 0.4273, 'round only for display');
  assert.equal(row.tokenPartial, true);
  assert.equal(row.costPartial, true);
  assert.equal(row.estimated, true);
  stats.record(run('zero', { model: 'free', results: [], usage: { tokens: 0, costUsd: 0, tokensPartial: false, costPartial: false } }));
  assert.equal(stats.rows().find(row => row.model === 'free').cost, 0);
});

test('Augment credits and USD are never converted or added together', () => {
  const stats = new UsageStatistics();
  stats.record(run('credits', { agent: 'auggie', results: [], usage: { tokens: 500, credits: 20, tokensPartial: false, costPartial: false } }));
  assert.equal(stats.rows()[0].cost, null);
  assert.equal(stats.rows()[0].credits, 20);
  assert.equal(stats.rows()[0].creditsPartial, false);
  stats.record(run('usd', { agent: 'auggie', usage: { tokens: 400, costUsd: 0.15, tokensPartial: false, costPartial: false } }));
  assert.equal(stats.rows()[0].cost, 0.15);
  assert.equal(stats.rows()[0].credits, 20);
  assert.equal(stats.rows()[0].costPartial, true);
  assert.equal(stats.rows()[0].creditsPartial, true);
});

test('early Codex runs and ledger entries share the named Codex group', () => {
  const stats = new UsageStatistics({entries:{old:{model:'gpt-test',tokens:400,cost:null}}});
  stats.record(run('early',{agent:undefined}));
  stats.record(run('new'));
  assert.equal(stats.rows().length,1);
  assert.equal(stats.rows()[0].agent,'codex');
  assert.equal(stats.rows()[0].tokens,6400);
});

test('reload does not overwrite saved live usage with older interrupted metadata', () => {
  const stats = new UsageStatistics();
  stats.record(run('live', { status: 'running', results: [], usage: {
    sampledAt: '2026-10-16T12:00:45Z', tokens: 5000, costUsd: 0.29, tokensPartial: true, costPartial: true } }));
  const restored = new UsageStatistics(JSON.parse(JSON.stringify(stats.snapshot())));
  restored.record(run('live', { status: 'interrupted', finishedAt: undefined, results: [] }));
  assert.equal(restored.rows()[0].tokens, 5000);
  assert.equal(restored.rows()[0].cost, 0.29);
  restored.record(run('live', { usage: { sampledAt: '2026-10-16T12:01:00Z', tokens: 6000, costUsd: 0.3, tokensPartial: false, costPartial: false } }));
  assert.equal(restored.rows()[0].tokens, 6000);
  assert.equal(restored.rows()[0].tokenPartial, false);
});
