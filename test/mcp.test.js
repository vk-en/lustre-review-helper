'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { serve } = require('../src/mcp');
const { startBridge, bridgeRequest, callTool, TOOLS } = require('../src/bridge');
const { temporary, until } = require('./helpers');

test('MCP negotiates and exposes asynchronous tools with error results', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const responses = [];
  output.on('data', data => responses.push(JSON.parse(data.toString())));
  const server = serve(input, output, async (name, args) => {
    if (name === 'start_review') return { id: 'test-run', status: 'running', ...args };
    throw new Error('not available');
  });
  t.after(() => { server.close(); input.end(); output.end(); });
  const request = async (id, method, params) => {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return until(() => responses.find(r => r.id === id));
  };
  assert.equal((await request(1, 'tools/list')).error.code, -32002);
  assert.equal((await request(2, 'initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  const tools = (await request(3, 'tools/list')).result.tools;
  assert.ok(tools.some(t => t.name === 'get_review'));
  assert.equal(tools.find(t => t.name === 'start_review').annotations.readOnlyHint, false);
  const start = await request(4, 'tools/call', { name: 'start_review', arguments: { commits: ['HEAD'] } });
  assert.equal(JSON.parse(start.result.content[0].text).status, 'running');
  assert.equal((await request(5, 'tools/call', { name: 'list_models' })).result.isError, true);
  assert.equal((await request(6, 'unknown')).error.code, -32601);
});

test('local bridge requires its secret and validates arguments', async t => {
  const directory = await temporary(t);
  const connection = path.join(directory, 'connection.json');
  const bridge = await startBridge({ repositories: [{ id: 'repo', path: '/trusted' }] }, connection);
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridgeRequest(connection, 'list_repositories', {}), [{ id: 'repo', path: '/trusted' }]);
  await assert.rejects(bridgeRequest(connection, 'start_review', { post: true }), /Unknown argument/);
  const endpoint = JSON.parse(await fs.readFile(connection, 'utf8'));
  assert.equal((await fs.stat(connection)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(endpoint.socketPath)).mode & 0o777, 0o600);
  const status = await new Promise(resolve => {
    const req = http.request({ socketPath: endpoint.socketPath, path: '/tool', method: 'POST' }, res => { res.resume(); resolve(res.statusCode); });
    req.end('{}');
  });
  assert.equal(status, 403);
  await assert.rejects(callTool({}, 'get_review', {}), /Missing id/);
  await assert.rejects(callTool({}, 'list_commits', { limit: -1 }), /Invalid limit/);
});

test('agents get compact reviews, the selected review and a lookup of earlier reviews', async () => {
  const run = { id: 'r', status: 'completed', results: [{ sha: 'a'.repeat(40), status: 'findings', message: 'm', comments: [{ file: 'f.c', line: 1, message: 'x' }] }], log: 'x'.repeat(30000) + 'END' };
  const service = { get: () => structuredClone(run) };
  const compact = await callTool(service, 'get_review', { id: 'r' });
  assert.equal('log' in compact, false, 'the log is left out by default');
  assert.deepEqual(compact.results, run.results);
  const withLog = await callTool(service, 'get_review', { id: 'r', include_log: true });
  assert.equal(withLog.log.length, 20000);
  assert.ok(withLog.log.endsWith('END'), 'the newest part of the log is kept');
  await assert.rejects(callTool(service, 'get_review', { id: 'r', include_log: 'yes' }), /include_log must be true or false/);
  await assert.rejects(callTool({}, 'find_reviews', {}), /Review lookup is unavailable/);
  assert.equal(await callTool({}, 'get_selected_review', {}), null);
  const seen = [];
  const extras = { findReviews: async args => { seen.push(args); return { commits: [] }; }, selectedReview: async () => ({ review: 'r' }) };
  assert.deepEqual(await callTool({}, 'find_reviews', { commits: ['HEAD'], limit: 2 }, extras), { commits: [] });
  assert.deepEqual(seen, [{ commits: ['HEAD'], limit: 2 }]);
  await assert.rejects(callTool({}, 'find_reviews', { limit: 0 }, extras), /Invalid limit/);
  await assert.rejects(callTool({}, 'find_reviews', { since: 'x' }, extras), /Unknown argument/);
  assert.deepEqual(await callTool({}, 'get_selected_review', {}, extras), { review: 'r' });
  const names = TOOLS.map(tool => tool.name);
  assert.ok(['find_reviews', 'get_selected_review'].every(name => names.includes(name)));
  assert.ok(TOOLS.find(tool => tool.name === 'start_review').inputSchema.properties.since);
  assert.equal(TOOLS.find(tool => tool.name === 'find_reviews').annotations.readOnlyHint, true);
});

test('agents read Gerrit state through the bridge: the queue, commit links and report states', async () => {
  const sha='a'.repeat(40), changeId=`I${'1'.repeat(40)}`, calls=[];
  const service = { commits: async () => [{ sha, changeId }], get: () => ({ id: 'r', status: 'completed', results: [] }) };
  await assert.rejects(callTool(service, 'get_gerrit_queue', {}), /Gerrit queue is unavailable/);
  assert.deepEqual(await callTool(service, 'list_commits', {}), [{ sha, changeId }], 'without the extension host, commits come as they are');
  const extras = {
    gerritQueue: async args => { calls.push(['queue', args]); return { waiting_review: [], in_progress: [] }; },
    commitLinks: async (_repository, commits) => commits.map(commit => ({ ...commit, gerrit: { link: 'current', change: 64086 } })),
    reviewReports: async id => ({ reports: [{ commit: sha, review: id }] }),
    findReviews: async args => { calls.push(['find', args]); return { change: 66889, reviews: [] }; },
  };
  assert.deepEqual(await callTool(service, 'get_gerrit_queue', { refresh: true }, extras), { waiting_review: [], in_progress: [] });
  await assert.rejects(callTool(service, 'get_gerrit_queue', { refresh: 'yes' }, extras), /refresh must be true or false/);
  await assert.rejects(callTool(service, 'get_gerrit_queue', { project: 'x' }, extras), /Unknown argument/);
  assert.deepEqual((await callTool(service, 'list_commits', { limit: 5 }, extras))[0].gerrit, { link: 'current', change: 64086 });
  assert.deepEqual((await callTool(service, 'get_review', { id: 'r' }, extras)).reports, [{ commit: sha, review: 'r' }]);
  await callTool(service, 'find_reviews', { change: '66889' }, extras);
  assert.deepEqual(calls, [['queue', { refresh: true }], ['find', { change: '66889' }]]);
  const queueTool = TOOLS.find(tool => tool.name === 'get_gerrit_queue');
  assert.deepEqual([queueTool.annotations.readOnlyHint, queueTool.annotations.openWorldHint], [true, true]);
  assert.match(TOOLS.find(tool => tool.name === 'start_review').description, /Augment/);
});

test('the agent-side server reports the extension version from its connection file', async t => {
  const directory = await temporary(t), connection = path.join(directory, 'connection.json');
  const bridge = await startBridge({ repositories: [] }, connection, {}, { version: '0.2.58' });
  t.after(() => bridge.dispose());
  assert.equal(JSON.parse(await fs.readFile(connection, 'utf8')).version, '0.2.58');
  const env = { ...process.env }; delete env.LREVIEW_VSCODE_WORKER;
  const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js'), '--connection', connection], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  await until(() => text.includes('\n'));
  const reply = JSON.parse(text.split('\n')[0]).result;
  assert.deepEqual(reply.serverInfo, { name: 'lreview-vscode', version: '0.2.58' });
  assert.match(reply.instructions, /get_gerrit_queue/);
});
