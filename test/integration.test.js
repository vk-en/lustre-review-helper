'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewService } = require('../src/service');
const { startBridge, bridgeRequest } = require('../src/bridge');
const { repository, script, until } = require('./helpers');

for (const agent of ['codex', 'claude', 'auggie']) test(`MCP → service → installed lreview → ${agent} worker → actual artifacts`, {
  skip: !process.env.LREVIEW_TEST_EXECUTABLE && 'Set LREVIEW_TEST_EXECUTABLE to an installed lreview; no model usage is consumed.',
}, async t => {
  const repo = await repository(t);
  const first = await repo.commit('first\n', 'LU-1: first');
  const second = await repo.commit('second\n', 'LU-2: second');
  await fs.writeFile(path.join(repo.directory, 'file.c'), 'keep my local changes\n');
  const prompts = path.join(repo.directory, 'prompts');
  await fs.mkdir(prompts);
  for (const name of ['review-core.md', 'gerrit-review.md']) await fs.writeFile(path.join(prompts, name), '# Test protocol\n');
  await script(repo.directory, 'codex-code-mode-host', 'console.log("helper ready");');
  const binary = await script(repo.directory, 'fake-agent', `
    const fs=require('fs'), cp=require('child_process'), path=require('path');
    const agent=${JSON.stringify(agent)};
    if(process.argv[2]!==(agent==='codex'?'exec':agent==='claude'?'-p':'--print') || process.env.LREVIEW_VSCODE_WORKER!=='1') process.exit(9);
    if(agent==='codex') {
      if(!process.argv.includes('mcp_servers.lreview_vscode={command="false",enabled=false}')) process.exit(10);
      cp.execFileSync(path.join(path.dirname(process.argv[1]), 'codex-code-mode-host'));
    } else if(agent==='claude' && !process.argv.includes('--disallowedTools=mcp__lreview_vscode__*')) process.exit(11);
    if(agent==='auggie' && (!process.argv.includes('--show-cost') || !process.argv.includes('--reasoning-effort'))) process.exit(12);
    const sha=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const subject=cp.execFileSync('git',['show','-s','--format=%s','HEAD'],{encoding:'utf8'}).trim();
    fs.writeFileSync('gerrit-review.json',JSON.stringify({message:'Verified '+sha,comments:{'file.c':[{line:1,message:'Test finding from real worktree'}]}}));
    fs.writeFileSync('review-metadata.json',JSON.stringify({author:'Test Author',sha,subject,'issues-found':1,'issue-severity-score':'low','issue-severity-explanation':'Test'}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
  `);
  const service = new ReviewService({ storage: path.join(repo.directory, 'runs'),
    settings: async () => ({ lreview: process.env.LREVIEW_TEST_EXECUTABLE, [agent]: binary, promptsDir: prompts, jobs: 2, timeout: 60, mode: 'full' }),
    discoverModels: async () => [{ id: agent === 'codex' ? 'gpt-6.1-sol' : 'opus', name: 'Test', isDefault: true, efforts: ['medium'] }] });
  await service.initialize();
  service.setRepositories([repo.directory]);
  const connection = path.join(repo.directory, 'connection.json');
  const bridge = await startBridge(service, connection);
  t.after(async () => { await bridge.dispose(); await service.dispose(); });
  const run = await bridgeRequest(connection, 'start_review', { commits: [first, second], agent, effort: 'medium' });
  const done = await until(async () => {
    const current = await bridgeRequest(connection, 'get_review', { id: run.id });
    return !['running', 'cancelling'].includes(current.status) && current;
  }, 30000);
  assert.equal(done.status, 'completed', done.log + '\n' + done.error);
  assert.deepEqual(done.results.map(r => r.sha), [first, second]);
  assert.ok(done.results.every(r => r.comments.length === 1 && r.message.includes(r.sha)));
  const reports = await service.reportFiles(run.id);
  assert.equal(reports.length, 2);
  const selected = await service.reportFiles(run.id, first);
  assert.equal(selected.length, 1);
  assert.match(await fs.readFile(selected[0], 'utf8'), new RegExp(first));
  await assert.rejects(service.reportFiles(run.id, 'bad-sha'), /Unknown review commit/);
  for (const report of reports) assert.match(await fs.readFile(report, 'utf8'), /Test finding from real worktree/);
  assert.equal(repo.git('rev-parse', 'HEAD'), second);
  assert.equal(await fs.readFile(path.join(repo.directory, 'file.c'), 'utf8'), 'keep my local changes\n');
  assert.equal(repo.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
  assert.equal((await bridgeRequest(connection, 'list_reviews', {}))[0].id, run.id);
});
