'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentConnections, AGENTS, connectionStatus } = require('../src/auth');
const { temporary, script, until } = require('./helpers');

test('status distinguishes a signed-out account from unavailable status without exposing identity', () => {
  const result = (code, text) => ({ code, text, stdout: text });
  assert.equal(connectionStatus('codex', result(0, 'Logged in using API key: secret')), 'connected');
  assert.equal(connectionStatus('codex', result(1, 'Not logged in')), 'disconnected');
  assert.equal(connectionStatus('codex', result(1, 'Network failure')), 'unknown');
  assert.equal(connectionStatus('claude', result(0, JSON.stringify({loggedIn:true,email:'private@example.invalid'}))), 'connected');
  assert.equal(connectionStatus('claude', result(1, '{"loggedIn":false}')), 'disconnected');
  assert.equal(connectionStatus('claude', result(0, 'Old client: unknown command')), 'unknown');
  assert.equal(connectionStatus('auggie', result(1, 'You are not currently logged in to Augment.')), 'disconnected');
  assert.equal(connectionStatus('auggie', result(1, "The 'account status' command is not available for your current plan.")), 'connected');
  assert.equal(connectionStatus('auggie', result(1, 'Cannot retrieve account status: API server not available')), 'unknown');
});

test('probes and logout use official argument arrays and never return raw credentials', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'agent with spaces', `
    const fs = require('fs'), path = require('path');
    const state = path.join(__dirname, 'signed-out');
    const args = process.argv.slice(2);
    if(args.join(' ') === 'logout') { fs.writeFileSync(state, 'yes'); process.exit(0); }
    if(args.join(' ') !== 'login status') process.exit(2);
    if(fs.existsSync(state)) { console.error('Not logged in'); process.exit(1); }
    console.log('Logged in using API key: private-secret');
  `);
  const connections = new AgentConnections({ codex: async () => binary, claude: async () => { throw new Error('missing'); }, auggie: async () => binary }, () => {});
  t.after(() => connections.dispose());
  await connections.refresh('codex');
  assert.equal(connections.get('codex').status, 'connected');
  assert.doesNotMatch(JSON.stringify(connections.all()), /private-secret|stdout|stderr|API key/);
  await connections.refresh('claude');
  assert.equal(connections.get('claude').status, 'missing');
  assert.equal(connections.get('claude').installed, false);
  await connections.logout('codex');
  assert.equal(connections.get('codex').status, 'disconnected');
  assert.deepEqual(AGENTS.claude.logout, ['auth', 'logout']);
  assert.deepEqual(AGENTS.auggie.status, ['account', 'status', '--json']);
});

test('probes coalesce, late replies cannot overwrite new credentials, and failed logout is rechecked', async t => {
  let resolve, calls = 0, changes = 0;
  const connections = new AgentConnections({ codex: async () => '/fake' }, () => { changes++; }, {
    run: async () => { calls++; return new Promise(r => { resolve = r; }); },
  });
  t.after(() => connections.dispose());
  const first = connections.refresh('codex');
  await until(() => resolve);
  const coalesced = connections.refresh('codex', true);
  assert.equal(calls, 1);
  const oldReply = resolve;
  connections.invalidate('codex');
  const next = connections.refresh('codex');
  await until(() => calls === 2);
  resolve({code:0,text:'Logged in',stdout:'Logged in'}); await next;
  oldReply({code:1,text:'Not logged in'}); await Promise.all([first,coalesced]);
  assert.equal(connections.get('codex').status, 'connected');
  assert.equal(changes, 1);
  connections.run = async (_binary, args) => args[0] === 'logout' ? { code:1,text:'private-secret' } : {code:0,text:'Logged in'};
  await assert.rejects(connections.logout('codex'), /could not sign out/);
  assert.equal(connections.get('codex').status, 'connected', 'failed logout must not falsely disconnect the account');
});

test('disposing the connection checker aborts a stalled client without late updates', async t => {
  const directory = await temporary(t);
  const binary = await script(directory, 'stalled-agent', 'setInterval(() => {}, 1000);');
  let changes = 0;
  const connections = new AgentConnections({ codex: async () => binary }, () => { changes++; });
  t.after(() => connections.dispose());
  const pending = connections.refresh('codex');
  await new Promise(resolve => setTimeout(resolve, 50));
  connections.dispose();
  await pending;
  assert.equal(changes, 0);
  assert.equal(connections.get('codex').status, 'checking');
});
