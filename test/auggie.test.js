'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { temporary, script }=require('./helpers');
const { listModels }=require('../src/auggie');

test('Augment discovers the account catalog using the official CLI', async t => {
  const root=await temporary(t);
  const cli=await script(root,'auggie',`
    require('assert/strict').deepEqual(process.argv.slice(2),['models','list','--json']);
    console.log(JSON.stringify({defaultModelId:'available-model',models:[
      {id:'available-model',displayName:'Account Model',effortLevels:['low','high']},
      {id:'hidden',disabled:true},{id:'no-effort'}
    ]}));`);
  const models=await listModels(cli);
  assert.deepEqual(models.map(m=>m.id),['available-model','no-effort']);
  assert.equal(models[0].isDefault,true);assert.deepEqual(models[0].efforts,['low','high']);
});

test('Augment authentication errors explain how to sign in', async t => {
  const root=await temporary(t), cli=await script(root,'auggie',`console.error('Not logged in');process.exit(1);`);
  await assert.rejects(listModels(cli),/Auggie login.*Not logged in/);
});
