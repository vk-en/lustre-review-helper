'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { temporary, script } = require('./helpers');
const { listModels, readLimits } = require('../src/claude');

test('Claude catalog uses control initialization only and returns dynamic models/efforts', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'claude', `
    const assert = require('assert/strict');
    assert.ok(process.argv.includes('--strict-mcp-config'));
    assert.ok(process.argv.includes('{"disableAllHooks":true}'));
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      assert.equal(m.type, 'control_request');
      assert.equal(m.request.subtype, 'initialize');
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[
        {value:'default',displayName:'Default',supportedEffortLevels:['low','high','max']},
        {value:'future-claude',displayName:'Future',description:'From installed client'},
        {value:'future-claude'},{}
      ]}}}));
    });
  `);
  const models = await listModels(binary);
  assert.deepEqual(models.map(m => m.id), ['default', 'future-claude']);
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].efforts, ['low', 'high', 'max']);
  assert.deepEqual(models[1].efforts, []);
});

test('Claude account usage uses initialization and get_usage only, with hooks and MCP disabled', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'claude-usage', `
    const assert=require('assert/strict');
    assert.ok(process.argv.includes('--strict-mcp-config'));
    assert.ok(process.argv.includes('--no-session-persistence'));
    assert.ok(process.argv.includes('{"disableAllHooks":true}'));
    let initialized=false;
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); assert.equal(m.type,'control_request');
      if(m.request.subtype==='initialize') initialized=true;
      else { assert.equal(m.request.subtype,'get_usage'); assert.equal(m.request.skip_behaviors,true); assert.equal(initialized,true); }
      const response=m.request.subtype==='initialize'?{}:{rate_limits:{five_hour:{utilization:10,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:28,resets_at:null}}};
      console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response}}));
    });
  `);
  assert.deepEqual((await readLimits(binary)).windows, [
    { minutes:300, usedPercent:10, resetsAt:4070908800 }, { minutes:10080, usedPercent:28, resetsAt:null },
  ]);
  const unsupported = await script(directory, 'unsupported-usage', `
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'error',error:'Unsupported control request'}}));
    });
  `);
  await assert.rejects(readLimits(unsupported), /Unsupported/);
});

test('Claude discovery handles older clients, initialization errors, missing binaries, and timeouts', async t => {
  const directory = await temporary(t);
  for (const [name, response, expected] of [
    ['old', {subtype:'success',response:{}}, /Update/],
    ['empty', {subtype:'success',response:{models:[]}}, /no available models/],
    ['error', {subtype:'error',error:'Account unavailable'}, /Account unavailable/],
  ]) {
    const binary = await script(directory, name, `
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        console.log(JSON.stringify({type:'control_response',response:{request_id:JSON.parse(line).request_id,...${JSON.stringify(response)}}}));
      });
    `);
    await assert.rejects(listModels(binary), expected);
  }
  const stalled = await script(directory, 'stalled', 'setInterval(()=>{},1000);');
  await assert.rejects(listModels(stalled, {timeout:150}), /timed out/);
  await assert.rejects(listModels('/does/not/exist'), /ENOENT/);
});
