'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startClaudeMetrics } = require('../src/claude-metrics');
const { LiveUsage } = require('../src/telemetry');
const { temporary } = require('./helpers');

test('Claude local metrics report live costs, replace cumulative samples and isolate sessions', async t => {
  const collector=await startClaudeMetrics();t.after(()=>collector.dispose());
  const endpoint=collector.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const id='33333333-3333-3333-3333-333333333333', other='44444444-4444-4444-4444-444444444444';
  const metric = (session,value,time='100',model='opus') => ({resourceMetrics:[{resource:{attributes:[]},scopeMetrics:[{metrics:[{
    name:'claude_code.cost.usage',sum:{aggregationTemporality:2,dataPoints:[{asDouble:value,timeUnixNano:time,startTimeUnixNano:'1',
      attributes:[{key:'session.id',value:{stringValue:session}},{key:'model',value:{stringValue:model}}]}]}
  }]}]}]});
  const send=async body=>{const result=await fetch(endpoint,{method:'POST',body:JSON.stringify(body)});assert.equal(result.status,200);await result.text();};
  assert.equal((await fetch(endpoint+'/wrong',{method:'POST',body:'{}'})).status,404);
  assert.equal((await fetch(endpoint,{method:'POST',body:'{}',headers:{Origin:'https://example.com'}})).status,404);
  await send(metric(id,.1));await send(metric(id,.1));await send(metric(other,12));
  assert.equal(collector.cost(id),.1);assert.equal(collector.cost('missing'),null);
  await send(metric(id,.3,'200'));await send(metric(id,.2,'150'));assert.equal(collector.cost(id),.3);
  await send(metric(id,.05,'200','haiku'));assert.equal(collector.cost(id),.35);
  const root=await temporary(t),dir=path.join(root,'artifacts');await fs.mkdir(dir);
  const log=path.join(dir,'one.log');await fs.writeFile(log,JSON.stringify({type:'system',subtype:'init',session_id:id})+'\n');
  const usage=new LiveUsage({directory:root,agent:'claude',commits:['one'],startedAt:new Date().toISOString()},{claudeMetrics:collector});
  assert.equal((await usage.poll()).costUsd,.35,'live cost available before the final result');
  await fs.appendFile(log,JSON.stringify({type:'result',total_cost_usd:.4})+'\n');
  assert.equal((await usage.poll()).costUsd,.4,'final result takes precedence');
});
