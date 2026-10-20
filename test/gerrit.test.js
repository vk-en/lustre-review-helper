'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary, script } = require('./helpers');
const { findGerrit, configFile, probe, GerritConnection, botName } = require('../src/gerrit');

test('Gerrit discovery uses lreview installation, explicit paths, and CLI config precedence', async t => {
  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', 'console.log("gerrit 0.2.24");');
  assert.equal(await findGerrit('', path.join(dir, 'lreview')), cli);
  await assert.rejects(findGerrit(path.join(dir, 'missing'), path.join(dir, 'lreview')), /unavailable/);
  const fallback = path.join(dir, '.config', 'gerrit-cli', '.env');
  await fs.mkdir(path.dirname(fallback), {recursive:true});
  await fs.writeFile(fallback, 'GERRIT_PASS=secret');
  await fs.writeFile(path.join(dir, '.env'), 'GERRIT_PASS=other-secret');
  assert.equal(await configFile(dir, {}, dir), fallback);
  assert.equal(await configFile(dir, {GERRIT_CLI_ENV_FILE:'missing.env'}, dir), path.join(dir, 'missing.env'));
});

test('Gerrit probes accept structured authentication failures and hide unsupported output and timeouts', async t => {
  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', `
    if(process.argv.slice(2).join(' ')!=='check')process.exit(9);
    console.log(JSON.stringify({code:'AUTH_FAILED',details:{status:'disconnected',message:'Authentication failed.',authenticated:false,config_file:__dirname+'/custom.env'}}));process.exit(2);
  `);
  assert.equal((await probe(cli, dir)).status, 'disconnected');
  const old = await script(dir, 'old', 'console.log("secret unsupported command");process.exit(4);');
  const result = await probe(old, dir);
  assert.equal(result.status, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /secret/);
  const stalled = await script(dir, 'stalled', 'setInterval(()=>{},1000);');
  assert.match((await probe(stalled, dir, {timeout:50})).message, /timed out/);
});

test('Gerrit connection checks are deduplicated, explicit, scoped to the checked repository and cancellable', async () => {
  let runs = 0, changed = 0, release;
  const connection = new GerritConnection(async () => '/bin/gerrit', () => changed++, {
    locate: async cwd => cwd+'/.env', version: async () => '0.2.24',
    run: async () => { runs++; await new Promise(resolve => { release = resolve; }); return {status:'connected',message:'Verified'}; },
  });
  const pending = connection.refresh('/repo');
  const same = connection.refresh('/repo');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs,1); release(); await Promise.all([pending,same]);
  assert.equal(connection.get('/repo').status,'connected');
  assert.equal(connection.get('/other').status,'unchecked');
  assert.equal(connection.get('/repo').version,'0.2.24');
  connection.get('/repo'); assert.equal(runs,1,'reading state never starts another check');
  connection.dispose(); await connection.refresh('/repo'); assert.equal(runs,1);
  assert.equal(changed,2);
});

test('bot labels reject multiline or markup-breaking signatures', () => {
  assert.equal(botName(' Lustre Bot '), 'Lustre Bot');
  assert.equal(botName(''), '');
  for (const value of ['line\nnext','[Bot]', '<Bot>', 'x'.repeat(81), null]) assert.throws(() => botName(value));
});
