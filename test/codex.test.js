'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { temporary, script } = require('./helpers');
const { listModels, readLimits, createCodexLauncher } = require('../src/codex');

test('Codex launcher preserves sibling helpers and literal paths/arguments', async t => {
  const root = await temporary(t);
  const bundle = path.join(root, "Codex's bundle $(false)");
  await fs.mkdir(bundle);
  const binary = path.join(bundle, 'codex');
  await fs.writeFile(binary, '#!/bin/sh\nexec "$(dirname "$0")/codex-code-mode-host" "$@"\n', { mode: 0o700 });
  await script(bundle, 'codex-code-mode-host', 'console.log(JSON.stringify(process.argv.slice(2)));');
  const alias = path.join(root, 'configured-codex');
  await fs.symlink(binary, alias);
  const launcher = await createCodexLauncher(alias, path.join(root, 'run', 'bin'));
  const args = ['exec', 'an argument with spaces', "apostrophe's", '$(false)', '$HOME'];
  const { stdout } = await promisify(execFile)(launcher, args);
  assert.deepEqual(JSON.parse(stdout), args);
});

test('Codex handshake, catalog pagination, hidden models, and dynamic efforts', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'codex', `
    let initialized = false;
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      const reply = result => process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
      if(m.method === 'initialize') reply({});
      else if(m.method === 'initialized') initialized = true;
      else if(m.method === 'model/list') {
        if(!initialized) process.exit(7);
        if(m.params.cursor) reply({data:[{model:'future-model',displayName:'Future',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null});
        else reply({data:[{model:'hidden-model',hidden:true},{model:'first-model',supportedReasoningEfforts:[]}],nextCursor:'page2'});
      } else process.exit(8);
    });
  `);
  const models = await listModels(binary);
  assert.deepEqual(models.map(m => m.id), ['first-model', 'future-model']);
  assert.deepEqual(models[1].efforts, ['medium']);
  assert.equal(models[1].isDefault, true);
});

test('failed and stalled model discovery produce actionable errors', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'codex', 'setInterval(()=>{},1000);');
  await assert.rejects(listModels(binary, { timeout: 150 }), /timed out/);
  await assert.rejects(listModels('/does/not/exist'), /ENOENT/);
});

test('Codex account limits require no model turn and choose the Codex bucket', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'codex-limits', `
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialized') return;
      if(!['initialize','account/rateLimits/read'].includes(m.method)) process.exit(9);
      const result=m.method==='initialize'?{}:{rateLimits:{primary:{usedPercent:99,windowDurationMins:300}},
        rateLimitsByLimitId:{codex:{secondary:{usedPercent:59,windowDurationMins:10080,resetsAt:4070908800}}}};
      console.log(JSON.stringify({id:m.id,result}));
    });
  `);
  const result = await readLimits(binary);
  assert.deepEqual(result.windows, [{ minutes:10080, usedPercent:59, resetsAt:4070908800 }]);
  const stalled = await script(directory, 'stalled-limits', 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const pending = readLimits(stalled, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
