'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lreviewVersion, cliVersion, gitVersion, gitStatus } = require('../src/prerequisites');
const { temporary, script } = require('./helpers');

test('lreview version probes run only --version and tolerate old, missing and stalled clients', async t => {
  const directory = await temporary(t);
  const cli = await script(directory, 'lreview with spaces', `
    if(process.argv.slice(2).join(' ')!=='--version') process.exit(9);
    console.log('lreview 0.2.7');
  `);
  assert.equal(await lreviewVersion(cli), '0.2.7');
  const old = await script(directory, 'old', 'console.log("unrecognized argument --version"); process.exit(2);');
  assert.equal(await lreviewVersion(old), undefined);
  assert.equal(await lreviewVersion(directory + '/missing'), undefined);
  const stalled = await script(directory, 'stalled', 'setInterval(()=>{},1000);');
  assert.equal(await lreviewVersion(stalled, {timeout:50}), undefined);
});

test('agent version probes return only versions, tolerate unsupported output and honor cancellation', async t => {
  const directory = await temporary(t);
  for (const [name, output, expected] of [
    ['codex', 'codex-cli 0.162.0-alpha.17.2', '0.162.0-alpha.17.2'],
    ['claude', '2.1.301 (Claude Code)', '2.1.301'],
    ['auggie', '0.36.0 (commit 7c61e5bb)', '0.36.0'],
    ['gerrit', 'gerrit 0.2.24', '0.2.24'],
    ['invalid', 'account secret 1.2.3', undefined],
  ]) {
    const binary = await script(directory, name, `if(process.argv[2]!=='--version')process.exit(1);console.log(${JSON.stringify(output)});`);
    assert.equal(await cliVersion(binary), expected);
  }
  const stalled = await script(directory, 'waiting-agent', 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const pending = cliVersion(stalled, {signal:controller.signal});
  controller.abort();
  assert.equal(await pending, undefined);
});

test('Git status reports the version, PATH location and the 2.24 minimum', async t => {
  const directory = await temporary(t);
  for (const [output, expected] of [['git version 2.39.5 (Apple Git-154)', '2.39.5'], ['git version 2.24', '2.24'], ['not git 1.2.3', undefined]]) {
    const binary = await script(directory, 'git-probe', `if(process.argv[2]!=='--version')process.exit(1);console.log(${JSON.stringify(output)});`);
    assert.equal(await gitVersion({ binary }), expected);
  }
  await script(directory, 'git', 'console.log("git version 2.20.1")');
  assert.deepEqual(await gitStatus({ version: async () => '2.20.1', pathEnv: directory }),
    { status: 'outdated', installed: false, version: '2.20.1', minimum: '2.24', path: `${directory}/git` });
  assert.equal((await gitStatus({ version: async () => '2.24.0', pathEnv: directory })).status, 'installed');
  assert.equal((await gitStatus({ version: async () => '3.0', pathEnv: directory })).installed, true);
  assert.deepEqual(await gitStatus({ version: async () => undefined, pathEnv: '' }), { status: 'missing', installed: false, minimum: '2.24', path: undefined });
});
