'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GlobalStatistics } = require('../src/global-statistics');
const { UsageStatistics } = require('../src/statistics');

const run = (id, changes = {}) => ({ id, agent: 'codex', model: 'gpt-test', commits: ['a'.repeat(40)], status: 'completed',
  startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
  results: [{ status: 'clean', tokens: 1000, costUsd: 0.12 }], ...changes });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lreview-global-statistics-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const options = {file:path.join(directory,'global','usage-statistics.json'),workspaceStorage:path.join(directory,'workspaceStorage'),extensionId:'lustre-review'};
  return { options, make:() => new GlobalStatistics(options), write:async (workspace, record) => {
    const folder = path.join(options.workspaceStorage,workspace.repeat(32),options.extensionId,'runs',record.id);
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'run.json'),JSON.stringify(record));
  }};
}

test('global migration imports Auggie from another workspace, normalizes early Codex and respects previous resets', async t => {
  const {options,make,write} = await fixture(t);
  const old = run('11111111-1111-4111-8111-111111111111', {agent:undefined, log:'private log stays out of statistics'});
  const augment = run('22222222-2222-4222-8222-222222222222', {agent:'auggie',model:'claude-opus',results:[{status:'clean',tokens:2000,costUsd:1.34}]});
  const excluded = run('33333333-3333-4333-8333-333333333333');
  await write('a',old);await write('b',augment);await write('a',excluded);
  const legacy = new UsageStatistics();legacy.record(excluded);legacy.reset([excluded]);legacy.record(old);
  const stats = make();await stats.initialize({legacy:legacy.snapshot(),runs:[old]});
  assert.equal(stats.rows().length,2);
  assert.equal(stats.rows().find(row=>row.agent==='codex').tokens,1000);
  assert.equal(stats.rows().find(row=>row.agent==='auggie').tokens,2000);
  assert.equal(stats.rows().find(row=>row.agent==='auggie').cost,1.34);
  const stored=await fs.readFile(options.file,'utf8');
  assert.doesNotMatch(stored,/private log/);
  const another=make();await another.initialize({runs:[old]});
  assert.deepEqual(another.rows(),stats.rows(), 'reimport is idempotent and exclusions survive');
});

test('simultaneous windows merge their changes and do not overwrite other projects', async t => {
  const {make} = await fixture(t);
  const a=make(),b=make();await Promise.all([a.initialize(),b.initialize()]);
  a.record(run('a'));b.record(run('b',{agent:'auggie'}));
  await Promise.all([a.sync(),b.sync()]);await Promise.all([a.sync(),b.sync()]);
  assert.deepEqual(a.rows(),b.rows());assert.equal(a.rows().length,2);
  assert.equal(a.rows().reduce((sum,row)=>sum+row.tokens,0),2000);
  a.record(run('a',{usage:{tokens:1500,tokensPartial:false,costUsd:.2,costPartial:false,sampledAt:'2026-01-01T00:02:00Z'}}));
  await Promise.all([a.sync(),b.sync()]);await b.sync();
  assert.equal(b.rows().find(row=>row.agent==='codex').tokens,1500);
  assert.equal(b.rows().find(row=>row.agent==='auggie').tokens,1000);
});

test('global reset propagates and rejects stale windows and previously unseen archive runs', async t => {
  const {make,write}=await fixture(t);
  const a=make(),b=make();await Promise.all([a.initialize(),b.initialize()]);
  a.record(run('a'));b.record(run('b'));await Promise.all([a.sync(),b.sync()]);
  b.record(run('b',{usage:{tokens:2000,costUsd:.2,sampledAt:new Date().toISOString()}}));
  await a.reset();await b.sync();
  assert.deepEqual(b.rows(),[], 'late snapshots from another window cannot undo reset');
  b.record(run('previously-unseen',{usage:{tokens:3000,sampledAt:new Date().toISOString()}}));
  await b.sync();assert.deepEqual(b.rows(),[], 'old start date is still before reset');
  await write('c',run('44444444-4444-4444-8444-444444444444'));
  const reopened=make();await reopened.initialize();assert.deepEqual(reopened.rows(),[]);
  const now=new Date().toISOString();
  b.record(run('new',{startedAt:now,finishedAt:now}));await b.sync();await a.sync();
  assert.equal(a.rows()[0].tokens,1000, 'a new launch of the same commit counts after reset');
});
