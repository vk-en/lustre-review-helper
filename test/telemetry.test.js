'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LiveUsage, JsonlReader } = require('../src/telemetry');
const { temporary } = require('./helpers');
const line = event => JSON.stringify(event) + '\n';

test('JSONL reader preserves split Unicode records and does not count rereads', async t => {
  const root = await temporary(t), file = path.join(root, 'log');
  const events = [], reader = new JsonlReader(e => events.push(e));
  const data = Buffer.from(line({type:'test',text:'Проверка'}));
  const split = data.indexOf(Buffer.from('П')) + 1;
  await fs.writeFile(file, data.subarray(0, split));
  await reader.read(file); assert.equal(events.length, 0);
  await fs.appendFile(file, data.subarray(split));
  await reader.read(file); await reader.read(file);
  assert.deepEqual(events, [{type:'test',text:'Проверка'}]);
});

test('Claude live usage deduplicates messages and aggregates parallel workers with known cost only', async t => {
  const root = await temporary(t), dir = path.join(root, 'artifacts'); await fs.mkdir(dir);
  const usage = new LiveUsage({directory:root, agent:'claude', commits:['one','two'],startedAt:new Date().toISOString()});
  const event = output => ({type:'assistant',message:{id:'msg-1',usage:{input_tokens:10,cache_creation_input_tokens:5,cache_read_input_tokens:100,output_tokens:output}}});
  await fs.writeFile(path.join(dir,'one.log'), line(event(1)) + line(event(8)));
  let live = await usage.poll();
  assert.equal(live.tokens,123); assert.equal(live.tokensPartial,true); assert.equal(live.costUsd,null);
  assert.ok(live.lastActivityAt);
  await fs.writeFile(path.join(dir,'two.log'), line(event(8)));
  live=await usage.poll(); assert.equal(live.tokens,246); assert.equal(live.tokensPartial,false);
  await fs.appendFile(path.join(dir,'one.log'), line({type:'result',usage:{input_tokens:200,output_tokens:30},total_cost_usd:0.1}));
  live=await usage.poll(); assert.equal(live.tokens,353);assert.equal(live.costUsd,0.1);assert.equal(live.costPartial,true);
  await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify({a:{sha:'one',local:true,log:'one.log',tokens:250,cost_usd:0.12},
    b:{sha:'two',local:true,log:'two.log',tokens:150,cost_usd:0}}));
  live=await usage.poll(); assert.equal(live.tokens,400);assert.equal(live.costUsd,0.12);assert.equal(live.costPartial,false);assert.equal(live.completed,2);
  assert.equal(live.byCommit.one.tokens, 250);
  assert.equal(live.byCommit.two.tokens, 150);
  assert.equal(live.byCommit.one.costUsd, .12);
  assert.equal(live.byCommit.two.costUsd, 0);
  assert.equal((await usage.poll()).tokens,400);
});

test('Codex live usage reads only the matching thread and does not double count cached tokens', async t => {
  const root = await temporary(t), dir=path.join(root,'artifacts');await fs.mkdir(dir);
  const startedAt=new Date().toISOString(), thread='12345678-1234-1234-1234-123456789012';
  const home=path.join(root,'codex'), sessions=path.join(home,'sessions',startedAt.slice(0,10).replaceAll('-','/'));
  await fs.mkdir(sessions,{recursive:true});
  const event = (input, output) => ({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:input-10,output_tokens:output,reasoning_output_tokens:output}}}});
  const file=path.join(sessions,`rollout-today-${thread}.jsonl`);
  await fs.writeFile(file,line(event(100,20)));
  await fs.writeFile(path.join(sessions,'unrelated.jsonl'),line(event(10000,2000)));
  await fs.writeFile(path.join(dir,'worker.log'),line({type:'thread.started',thread_id:thread}));
  const usage=new LiveUsage({directory:root,agent:'codex',commits:['one'],startedAt},{codexHome:home});
  let live=await usage.poll();assert.equal(live.tokens,120);assert.equal(live.costUsd,null);
  await fs.appendFile(file,line(event(200,30)));live=await usage.poll();assert.equal(live.tokens,230);
  await fs.appendFile(path.join(dir,'worker.log'),line({type:'turn.completed',usage:{input_tokens:300,output_tokens:40}}));
  assert.equal((await usage.poll()).tokens,340);
});

test('Augment credits remain credits and absent usage remains unknown', async t => {
  const root=await temporary(t),dir=path.join(root,'artifacts');await fs.mkdir(dir);
  const usage=new LiveUsage({directory:root,agent:'auggie',commits:['one'],startedAt:new Date().toISOString()});
  assert.equal((await usage.poll()).tokens,null);
  await fs.writeFile(path.join(dir,'one.log'),line({type:'result',billing:{usage_unit:'credits',total_cost:12}}));
  const live=await usage.poll();assert.equal(live.tokens,null);assert.equal(live.credits,12);assert.equal(live.costUsd,null);
});

test('Augment follows only the worker session, updates before completion and keeps totals through compaction', async t => {
  const root = await temporary(t), dir = path.join(root, 'artifacts'), home = path.join(root, 'augment');
  await fs.mkdir(dir); await fs.mkdir(path.join(home, 'sessions'), {recursive:true});
  const id = '11111111-1111-1111-1111-111111111111';
  const file = path.join(home, 'sessions', id + '.json');
  const entry = (id, output, cost) => ({ exchange: {request_id:id,response_nodes:[
    {type:10,token_usage:{input_tokens:10,cache_read_input_tokens:80,cache_creation_input_tokens:5,output_tokens:output}},
    {type:9,billing_metadata:{transaction_id:id,usage_unit:2,cost_usd:String(cost)}}
  ]}});
  let savedAt = Date.now();
  const save = async (entries, extra = {}) => {
    await fs.writeFile(file, JSON.stringify({sessionId:id,chatHistory:entries, ...extra}));
    // Explicit distinct mtime also exercises the cheap unchanged-file check.
    const time = new Date(savedAt += 1000);
    await fs.utimes(file,time,time);
  };
  await save([entry('r1',5,.2)]);
  await fs.writeFile(path.join(home,'sessions','unrelated.json'),JSON.stringify({chatHistory:[entry('wrong',99999,100)]}));
  const usage = new LiveUsage({directory:root,agent:'auggie',commits:['one'],startedAt:new Date().toISOString()}, {augmentHome:home});
  await fs.writeFile(path.join(dir,'one.log'), "2026-10-15 23:13:38.329 [info] 'SessionManager': Session saved: " + id + '\n');
  let live = await usage.poll(); assert.equal(live.tokens,100); assert.equal(live.costUsd,.2);
  assert.equal((await usage.poll()).costUsd,.2);
  await save([entry('r1',5,.2),entry('r2',15,.3)]);
  live=await usage.poll();assert.equal(live.tokens,210);assert.equal(live.costUsd,.5);
  await save([entry('r2',15,.3)], {subAgentCostUsd:.1});
  live=await usage.poll();assert.equal(live.tokens,210);assert.equal(live.costUsd,.6);assert.equal(live.tokensPartial,true);
  await fs.appendFile(path.join(dir,'one.log'),line({type:'result',billing:{usage_unit:'usd',total_cost:.75}}));
  live=await usage.poll();assert.equal(live.costUsd,.75,'final client billing is authoritative');
});

test('limits are account snapshots, never summed across parallel Claude workers', async t => {
  const root = await temporary(t), dir = path.join(root,'artifacts');await fs.mkdir(dir);
  const usage = new LiveUsage({directory:root,agent:'claude',commits:['one','two'],startedAt:new Date().toISOString()});
  const event = percent => ({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{
    five_hour:{utilization:percent,resetsAt:2000000000},seven_day:{utilization:.4,resetsAt:2000010000}
  }}});
  await fs.writeFile(path.join(dir,'one.log'),line(event(.1)));
  await fs.writeFile(path.join(dir,'two.log'),line(event(.2)));
  await fs.utimes(path.join(dir,'two.log'),new Date(Date.now()+1000),new Date(Date.now()+1000));
  const live=await usage.poll();
  assert.deepEqual(live.limits.windows.map(w=>w.usedPercent),[20,40]);
});

test('Codex estimates per-request cost with caching and long context, ignoring duplicate snapshots', async t => {
  const root = await temporary(t), dir=path.join(root,'artifacts');await fs.mkdir(dir);
  const home=path.join(root,'codex'), startedAt=new Date().toISOString(), id='22222222-2222-2222-2222-222222222222';
  const sessions=path.join(home,'sessions',startedAt.slice(0,10).replaceAll('-','/'));await fs.mkdir(sessions,{recursive:true});
  const event=(input,cache,output,lastInput)=>({type:'event_msg',timestamp:startedAt,payload:{type:'token_count',
    info:{total_token_usage:{input_tokens:input,cached_input_tokens:cache,output_tokens:output},last_token_usage:{input_tokens:lastInput}},
    rate_limits:{primary:{used_percent:35,window_minutes:10080,resets_at:2000000000},secondary:null}}});
  const file=path.join(sessions,`rollout-${id}.jsonl`);
  await fs.writeFile(file,line(event(1000,800,100,1000)));
  await fs.writeFile(path.join(dir,'one.log'),line({type:'thread.started',thread_id:id}));
  const usage=new LiveUsage({directory:root,agent:'codex',model:'gpt-6.1-sol',commits:['one'],startedAt},{codexHome:home});
  let live=await usage.poll();assert.equal(live.costUsd,null);assert.equal(live.estimatedCostUsd,.00148);
  assert.equal(live.limits.windows[0].minutes,10080,'do not assume primary means five-hour');
  await fs.appendFile(file,line(event(1000,800,100,1000)) + line(event(301000,200800,1100,300000)));
  live=await usage.poll();assert.ok(Math.abs(live.estimatedCostUsd-.45648)<1e-8);
  assert.equal((await usage.poll()).estimatedCostUsd,live.estimatedCostUsd);
  await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify({one:{sha:'one',local:true,log:'one.log'}}));
  const final = await usage.poll();
  assert.equal(final.byCommit.one.estimatedCostUsd, final.estimatedCostUsd);
  assert.equal(final.byCommit.one.tokens, final.tokens);
});
