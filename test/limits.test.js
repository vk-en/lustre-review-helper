'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountLimits, codexLimits, claudeLimits } = require('../src/limits');

test('missing and invalid account limits are unknown, never invented as zero usage', () => {
  assert.equal(codexLimits({}), null);
  assert.equal(codexLimits({rateLimits:{primary:{usedPercent:null,windowDurationMins:300}}}), null);
  assert.equal(claudeLimits({rate_limits:{five_hour:{utilization:'50'}}}), null);
  assert.equal(claudeLimits({rate_limits:{five_hour:{utilization:0}}}).windows[0].usedPercent, 0);
});

test('limits are cached separately per agent, throttled, and preserve snapshots on failure', async () => {
  let now = 200000, calls = 0, fail = false;
  const snapshot = { windows:[{minutes:300,usedPercent:10,resetsAt:900000}],observedAt:new Date(now).toISOString() };
  const cache = new AccountLimits({claude:async()=>{ calls++; if(fail) throw new Error('offline'); return snapshot; }}, ()=>{}, {now:()=>now});
  await cache.refresh('claude'); await cache.refresh('claude');
  assert.equal(calls, 1);
  assert.equal(cache.get('codex').snapshot, undefined);
  assert.equal(cache.get('claude').source, 'account');
  cache.seed('claude', {...snapshot,observedAt:new Date(now-1000).toISOString()});
  assert.equal(cache.get('claude').source, 'account', 'older reviews do not overwrite fresh limits');
  now += 60000; fail = true; await cache.refresh('claude');
  assert.equal(cache.get('claude').error, true);
  assert.equal(cache.get('claude').snapshot, snapshot);
  cache.dispose();
});

test('invalidation aborts pending queries and discards their late results', async () => {
  let resolve, signal, changes = 0;
  const cache = new AccountLimits({codex: options => { signal=options.signal; return new Promise(r=>{resolve=r;}); }}, ()=>changes++);
  const pending = cache.refresh('codex');
  await cache.refresh('codex'); assert.equal(changes, 1, 'duplicate queries are coalesced');
  cache.invalidate(); assert.equal(signal.aborted, true);
  resolve({windows:[{minutes:10080,usedPercent:90}]}); await pending;
  assert.equal(cache.get('codex').snapshot, undefined);
  assert.equal(changes, 1);
  cache.dispose();
});
